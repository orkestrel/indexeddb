import type { IndexedDBDatabaseInterface } from '@src/browser'
import { createIndexedDBDatabase, IndexedDBError } from '@src/browser'
import { afterEach, describe, expect, it } from 'vitest'
import { captureError } from '../../setup.js'
import {
	createCleanups,
	createTestDatabase,
	deleteDatabase,
	errorCode,
	uniqueName,
} from '../../setupBrowser.js'

// The `IndexedDBDatabaseInterface` surface in real Chromium: lazy connect and
// state (`name` / `version` / `stores` / `open` / `database`), the `store`
// accessor, atomic `read` / `write` scopes, `close`, `drop`, and the
// auto-managed schema path. Each test opens a uniquely-named database through
// the shared `createTestDatabase` opener and disposes it afterwards, so the
// suite is order- and rerun-independent. Sub-entity behavior (store CRUD,
// indexes, cursors, transaction-bound stores) lives in the matching per-entity
// files; this file pins only the database handle's own contract.

const cleanups = createCleanups()

afterEach(cleanups.run)

describe('IndexedDBDatabase — connection and state', () => {
	it('connects lazily and reports its state', async () => {
		const name = uniqueName()
		const db = createIndexedDBDatabase({ name, version: 1, stores: { users: { path: 'id' } } })
		cleanups.push(async () => {
			db.close()
			await deleteDatabase(name)
		})
		// Before connect: declared values, no live handle.
		expect(db.name).toBe(name)
		expect(db.version).toBe(1)
		expect(db.open).toBe(false)
		expect(db.stores).toEqual(['users'])
		// Reaching the live handle before connect throws NOT_OPEN.
		const notOpen = captureError(() => db.database)
		expect(notOpen).toBeInstanceOf(IndexedDBError)
		expect(errorCode(notOpen)).toBe('NOT_OPEN')

		// After connect: live handle, idempotent re-connect.
		const handle = await db.connect()
		expect(handle).toBeInstanceOf(IDBDatabase)
		expect(await db.connect()).toBe(handle)
		expect(db.open).toBe(true)
		expect(db.database).toBe(handle)
		expect(db.stores).toEqual(['users'])
	})

	it('reports the live store names once open', async () => {
		const { db, cleanup } = await createTestDatabase({
			users: { path: 'id' },
			posts: { path: 'id' },
		})
		cleanups.push(cleanup)
		expect([...db.stores].sort()).toEqual(['posts', 'users'])
	})

	it('rejects an empty name and a non-positive version at construction', () => {
		const emptyName = captureError(() => createIndexedDBDatabase({ name: '', stores: {} }))
		expect(errorCode(emptyName)).toBe('OPEN')

		const badVersion = captureError(() =>
			createIndexedDBDatabase({ name: uniqueName(), version: 0, stores: {} }),
		)
		expect(errorCode(badVersion)).toBe('OPEN')
	})

	it('throws CLOSED on connect once closed', async () => {
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		cleanups.push(cleanup)
		db.close()
		expect(db.open).toBe(false)
		const caught = captureError(() => db.connect())
		expect(caught).toBeInstanceOf(IndexedDBError)
		expect(errorCode(caught)).toBe('CLOSED')
	})
})

describe('IndexedDBDatabase — store accessor', () => {
	it('reaches a declared store and throws NOT_FOUND for an undeclared one', async () => {
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		cleanups.push(cleanup)
		const users = db.store('users')
		expect(users.name).toBe('users')
		expect(users.path).toBe('id')

		// A widened handle (default `StoresShape`) lets `store` take any name, so the
		// runtime NOT_FOUND guard is reachable — the literal-keyed generic would
		// reject `'ghost'` at compile time before it ever runs.
		const widened: IndexedDBDatabaseInterface = db
		const caught = captureError(() => widened.store('ghost'))
		expect(caught).toBeInstanceOf(IndexedDBError)
		expect(errorCode(caught)).toBe('NOT_FOUND')
	})
})

describe('IndexedDBDatabase — read / write scopes', () => {
	it('commits a multi-store write scope atomically', async () => {
		const { db, cleanup } = await createTestDatabase({
			users: { path: 'id' },
			posts: { path: 'id' },
		})
		cleanups.push(cleanup)
		await db.write(['users', 'posts'], async (tx) => {
			await tx.store('users').set({ id: 'u1', name: 'Ada' })
			await tx.store('posts').set({ id: 'p1', author: 'u1' })
		})
		expect(await db.store('users').get('u1')).toEqual({ id: 'u1', name: 'Ada' })
		expect(await db.store('posts').get('p1')).toEqual({ id: 'p1', author: 'u1' })
	})

	it('rolls the whole scope back when it throws', async () => {
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		cleanups.push(cleanup)
		await db.store('users').set({ id: 'u1', n: 1 })
		const caught = await db
			.write('users', async (tx) => {
				await tx.store('users').set({ id: 'u1', n: 2 })
				await tx.store('users').set({ id: 'u2', n: 9 })
				throw new Error('boom')
			})
			.catch((error: unknown) => error)
		expect(caught).toBeInstanceOf(Error)
		// Aborted: neither write survived.
		expect(await db.store('users').get('u1')).toEqual({ id: 'u1', n: 1 })
		expect(await db.store('users').get('u2')).toBeUndefined()
	})

	it('reads within a readonly scope', async () => {
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		cleanups.push(cleanup)
		await db.store('users').set({ id: 'u1', name: 'Ada' })
		let found: unknown
		await db.read('users', async (tx) => {
			found = await tx.store('users').get('u1')
		})
		expect(found).toEqual({ id: 'u1', name: 'Ada' })
	})
})

describe('IndexedDBDatabase — auto-managed schema (no version)', () => {
	it('opens at the current version and bumps once to create a newly declared store', async () => {
		const name = uniqueName()
		await deleteDatabase(name)
		// First open, auto-managed: creates `users`, settling at version 1.
		const first = createIndexedDBDatabase({ name, stores: { users: { path: 'id' } } })
		await first.connect()
		expect(first.version).toBe(1)
		await first.store('users').set({ id: 'u1', name: 'Ada' })
		first.close()

		// Reopen auto-managed with an extra store: bumps once to create `posts`,
		// without a manual version, preserving the existing data.
		const second = createIndexedDBDatabase({
			name,
			stores: { users: { path: 'id' }, posts: { path: 'id' } },
		})
		cleanups.push(async () => {
			second.close()
			await deleteDatabase(name)
		})
		await second.connect()
		expect(second.version).toBe(2)
		expect([...second.stores].sort()).toEqual(['posts', 'users'])
		expect(await second.store('users').get('u1')).toEqual({ id: 'u1', name: 'Ada' })
		await second.store('posts').set({ id: 'p1' })
		expect(await second.store('posts').get('p1')).toEqual({ id: 'p1' })
	})

	it('creates new stores on an explicit version upgrade', async () => {
		const name = uniqueName()
		await deleteDatabase(name)
		const v1 = createIndexedDBDatabase({ name, version: 1, stores: { users: { path: 'id' } } })
		await v1.connect()
		v1.close()

		const v2 = createIndexedDBDatabase({
			name,
			version: 2,
			stores: { users: { path: 'id' }, posts: { path: 'id' } },
		})
		cleanups.push(async () => {
			v2.close()
			await deleteDatabase(name)
		})
		await v2.connect()
		expect(v2.version).toBe(2)
		expect(v2.stores).toContain('posts')
		await v2.store('posts').set({ id: 'p1' })
		expect(await v2.store('posts').get('p1')).toEqual({ id: 'p1' })
	})
})

describe('IndexedDBDatabase — persistence and drop', () => {
	it('persists across a close and reopen over the same name', async () => {
		// Open WITHOUT the shared cleanup: its cleanup deletes the database, but this
		// test must keep the bytes on disk across the reopen below.
		const name = uniqueName()
		await deleteDatabase(name)
		const db = createIndexedDBDatabase({ name, version: 1, stores: { users: { path: 'id' } } })
		await db.store('users').set({ id: 'u1', name: 'Ada' })
		db.close()

		// Re-create under the SAME name; the data must survive the reopen.
		const reopened = createIndexedDBDatabase({
			name,
			version: 1,
			stores: { users: { path: 'id' } },
		})
		cleanups.push(async () => {
			reopened.close()
			await deleteDatabase(name)
		})
		expect(await reopened.store('users').get('u1')).toEqual({ id: 'u1', name: 'Ada' })
	})

	it('drops the whole database', async () => {
		const { db, name } = await createTestDatabase({ users: { path: 'id' } })
		await db.store('users').set({ id: 'u1' })
		await db.drop()
		expect(db.open).toBe(false)

		// A fresh open over the same name starts empty.
		const fresh = createIndexedDBDatabase({ name, version: 1, stores: { users: { path: 'id' } } })
		cleanups.push(async () => {
			fresh.close()
			await deleteDatabase(name)
		})
		expect(await fresh.store('users').get('u1')).toBeUndefined()
	})
})
