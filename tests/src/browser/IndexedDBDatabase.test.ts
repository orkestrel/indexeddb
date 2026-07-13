import type { IndexedDBDatabaseInterface } from '@src/browser'
import {
	createIndexedDBDatabase,
	IndexedDBError,
	promisifyRequest,
	promisifyTransaction,
} from '@src/browser'
import { afterEach, describe, expect, it } from 'vitest'
import { captureError, waitForDelay } from '../../setup.js'
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

	it('settles when the scope ends on a trailing non-IDB await (auto-commit race)', async () => {
		// A scope whose last step is a non-IDB await lets the transaction
		// auto-commit before `#run` would otherwise attach its completion
		// listener — proving the listener is wired BEFORE the scope runs, not
		// after, so `write` resolves instead of hanging forever.
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		cleanups.push(cleanup)
		await db.write('users', async (tx) => {
			await tx.store('users').set({ id: 'u1', name: 'Ada' })
			await waitForDelay(10) // non-IDB await — the transaction auto-commits here
		})
		expect(await db.store('users').get('u1')).toEqual({ id: 'u1', name: 'Ada' })
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

describe('IndexedDBDatabase — upgrade hook', () => {
	it('drops a store while leaving others intact', async () => {
		const name = uniqueName()
		await deleteDatabase(name)
		const v1 = createIndexedDBDatabase({
			name,
			version: 1,
			stores: { users: { path: 'id' }, posts: { path: 'id' } },
		})
		await v1.connect()
		await v1.store('users').set({ id: 'u1', name: 'Ada' })
		await v1.store('posts').set({ id: 'p1' })
		v1.close()

		const v2 = createIndexedDBDatabase({
			name,
			version: 2,
			stores: { users: { path: 'id' }, posts: { path: 'id' } },
			upgrade: (context) => {
				context.drop('posts')
			},
		})
		cleanups.push(async () => {
			v2.close()
			await deleteDatabase(name)
		})
		await v2.connect()
		expect([...v2.database.objectStoreNames]).toEqual(['users'])
		expect(await v2.store('users').get('u1')).toEqual({ id: 'u1', name: 'Ada' })
	})

	it('adds an index to an existing store via context.index', async () => {
		const name = uniqueName()
		await deleteDatabase(name)
		const v1 = createIndexedDBDatabase({ name, version: 1, stores: { users: { path: 'id' } } })
		await v1.connect()
		await v1.store('users').set([
			{ id: 'u1', name: 'Ada' },
			{ id: 'u2', name: 'Bea' },
		])
		v1.close()

		const v2 = createIndexedDBDatabase({
			name,
			version: 2,
			stores: { users: { path: 'id', indexes: [{ name: 'byName', path: 'name' }] } },
			upgrade: (context) => {
				context.index('users', { name: 'byName', path: 'name' })
			},
		})
		cleanups.push(async () => {
			v2.close()
			await deleteDatabase(name)
		})
		await v2.connect()
		expect(await v2.store('users').index('byName').get('Bea')).toEqual({ id: 'u2', name: 'Bea' })
	})

	it('adds a unique index to a store created in the same upgrade via context.create', async () => {
		const name = uniqueName()
		await deleteDatabase(name)
		const v1 = createIndexedDBDatabase({ name, version: 1, stores: { users: { path: 'id' } } })
		await v1.connect()
		v1.close()

		const v2 = createIndexedDBDatabase({
			name,
			version: 2,
			stores: { users: { path: 'id' } },
			upgrade: (context) => {
				context.create('logs', { path: 'id' })
				context.index('logs', { name: 'byMessage', path: 'message', unique: true })
			},
		})
		cleanups.push(async () => {
			v2.close()
			await deleteDatabase(name)
		})
		await v2.connect()

		const write = v2.database.transaction(['logs'], 'readwrite')
		write.objectStore('logs').put({ id: 'l1', message: 'hi' })
		await promisifyTransaction(write)

		const read = v2.database.transaction(['logs'], 'readonly')
		const record = await promisifyRequest(read.objectStore('logs').index('byMessage').get('hi'))
		expect(record).toEqual({ id: 'l1', message: 'hi' })

		// The index is unique: a second record with the same indexed value faults
		// the put request itself with a native ConstraintError.
		const duplicate = v2.database.transaction(['logs'], 'readwrite')
		const caught = await promisifyRequest(
			duplicate.objectStore('logs').put({ id: 'l2', message: 'hi' }),
		).catch((error: unknown) => error)
		expect(caught).toBeInstanceOf(IndexedDBError)
		expect(errorCode(caught)).toBe('CONSTRAINT')
	})

	it('removes an index via context.deindex', async () => {
		const name = uniqueName()
		await deleteDatabase(name)
		const v1 = createIndexedDBDatabase({
			name,
			version: 1,
			stores: { users: { path: 'id', indexes: [{ name: 'byName', path: 'name' }] } },
		})
		await v1.connect()
		await v1.store('users').set({ id: 'u1', name: 'Ada' })
		v1.close()

		const v2 = createIndexedDBDatabase({
			name,
			version: 2,
			stores: { users: { path: 'id' } },
			upgrade: (context) => {
				context.deindex('users', 'byName')
			},
		})
		cleanups.push(async () => {
			v2.close()
			await deleteDatabase(name)
		})
		await v2.connect()
		const read = v2.database.transaction(['users'], 'readonly')
		expect(read.objectStore('users').indexNames.contains('byName')).toBe(false)
		await promisifyTransaction(read)
	})

	it('migrates data within the upgrade transaction via context.store', async () => {
		const name = uniqueName()
		await deleteDatabase(name)
		const v1 = createIndexedDBDatabase({ name, version: 1, stores: { users: { path: 'id' } } })
		await v1.connect()
		await v1.store('users').set([
			{ id: 'u1', name: 'ada' },
			{ id: 'u2', name: 'bea' },
		])
		v1.close()

		const v2 = createIndexedDBDatabase({
			name,
			version: 2,
			stores: { users: { path: 'id' } },
			upgrade: async (context) => {
				const store = context.store('users')
				const rows = await store.records()
				for (const row of rows) {
					const nameValue = typeof row.name === 'string' ? row.name.toUpperCase() : row.name
					await store.set({ ...row, name: nameValue })
				}
			},
		})
		cleanups.push(async () => {
			v2.close()
			await deleteDatabase(name)
		})
		await v2.connect()
		expect(await v2.store('users').get('u1')).toEqual({ id: 'u1', name: 'ADA' })
		expect(await v2.store('users').get('u2')).toEqual({ id: 'u2', name: 'BEA' })
	})

	it('rejects connect() cleanly when an async upgrade throws after an awaited request', async () => {
		const name = uniqueName()
		await deleteDatabase(name)
		const v1 = createIndexedDBDatabase({ name, version: 1, stores: { users: { path: 'id' } } })
		await v1.connect()
		await v1.store('users').set({ id: 'u1', name: 'ada' })
		v1.close()

		const v2 = createIndexedDBDatabase({
			name,
			version: 2,
			stores: { users: { path: 'id' } },
			upgrade: async (context) => {
				const store = context.store('users')
				// Await a real IDB request first, so the versionchange transaction is
				// still alive when the throw below happens.
				await store.records()
				throw new Error('migration boom')
			},
		})
		cleanups.push(async () => {
			v2.close()
			await deleteDatabase(name)
		})

		const caught = await v2.connect().catch((error: unknown) => error)
		expect(caught).toBeInstanceOf(IndexedDBError)
		expect(errorCode(caught)).toBe('UPGRADE')
		expect(v2.open).toBe(false)

		// The upgrade never half-applied: the database is still at version 1, and a
		// fresh connection without the throwing upgrade opens it cleanly and reads
		// the pre-upgrade data back untouched.
		const reopened = createIndexedDBDatabase({
			name,
			version: 1,
			stores: { users: { path: 'id' } },
		})
		cleanups.push(async () => {
			reopened.close()
			await deleteDatabase(name)
		})
		await reopened.connect()
		expect(reopened.version).toBe(1)
		expect(await reopened.store('users').get('u1')).toEqual({ id: 'u1', name: 'ada' })
	})

	it('creates a store via context.create, honouring its definition', async () => {
		const name = uniqueName()
		await deleteDatabase(name)
		const v1 = createIndexedDBDatabase({ name, version: 1, stores: { users: { path: 'id' } } })
		await v1.connect()
		v1.close()

		const v2 = createIndexedDBDatabase({
			name,
			version: 2,
			stores: { users: { path: 'id' } },
			upgrade: (context) => {
				context.create('logs', { path: 'id', increment: false })
			},
		})
		cleanups.push(async () => {
			v2.close()
			await deleteDatabase(name)
		})
		await v2.connect()
		expect(v2.database.objectStoreNames.contains('logs')).toBe(true)
		const raw = v2.database.transaction(['logs'], 'readwrite')
		raw.objectStore('logs').put({ id: 'l1', message: 'hi' })
		await promisifyTransaction(raw)
		const read = v2.database.transaction(['logs'], 'readonly')
		const record = await promisifyRequest(read.objectStore('logs').get('l1'))
		expect(record).toEqual({ id: 'l1', message: 'hi' })
	})

	it('surfaces a typed IndexedDBError when context.drop targets a missing store', async () => {
		const name = uniqueName()
		await deleteDatabase(name)
		const v1 = createIndexedDBDatabase({ name, version: 1, stores: { users: { path: 'id' } } })
		await v1.connect()
		v1.close()

		const v2 = createIndexedDBDatabase({
			name,
			version: 2,
			stores: { users: { path: 'id' } },
			upgrade: (context) => {
				context.drop('missing')
			},
		})
		cleanups.push(async () => {
			v2.close()
			await deleteDatabase(name)
		})
		const caught = await v2.connect().catch((error: unknown) => error)
		expect(caught).toBeInstanceOf(IndexedDBError)
		expect(errorCode(caught)).toBe('UPGRADE')
		expect(v2.open).toBe(false)
	})

	it('surfaces a typed IndexedDBError when context.deindex targets a missing index', async () => {
		const name = uniqueName()
		await deleteDatabase(name)
		const v1 = createIndexedDBDatabase({ name, version: 1, stores: { users: { path: 'id' } } })
		await v1.connect()
		v1.close()

		const v2 = createIndexedDBDatabase({
			name,
			version: 2,
			stores: { users: { path: 'id' } },
			upgrade: (context) => {
				context.deindex('users', 'missing')
			},
		})
		cleanups.push(async () => {
			v2.close()
			await deleteDatabase(name)
		})
		const caught = await v2.connect().catch((error: unknown) => error)
		expect(caught).toBeInstanceOf(IndexedDBError)
		expect(errorCode(caught)).toBe('UPGRADE')
		expect(v2.open).toBe(false)
	})

	it('exposes old / version / stores correctly on the context', async () => {
		const name = uniqueName()
		await deleteDatabase(name)
		const v1 = createIndexedDBDatabase({ name, version: 1, stores: { users: { path: 'id' } } })
		await v1.connect()
		v1.close()

		let seenOld: number | undefined
		let seenVersion: number | undefined
		let seenStores: readonly string[] | undefined
		const v2 = createIndexedDBDatabase({
			name,
			version: 3,
			stores: { users: { path: 'id' }, posts: { path: 'id' } },
			upgrade: (context) => {
				seenOld = context.old
				seenVersion = context.version
				seenStores = context.stores
			},
		})
		cleanups.push(async () => {
			v2.close()
			await deleteDatabase(name)
		})
		await v2.connect()
		expect(seenOld).toBe(1)
		expect(seenVersion).toBe(3)
		expect([...(seenStores ?? [])].sort()).toEqual(['posts', 'users'])
	})
})

describe('IndexedDBDatabase — versionchange yields a live connection', () => {
	it('closes the first connection so a second connection at a higher version can open', async () => {
		const name = uniqueName()
		await deleteDatabase(name)
		const first = createIndexedDBDatabase({ name, version: 1, stores: { users: { path: 'id' } } })
		await first.connect()
		expect(first.open).toBe(true)

		const second = createIndexedDBDatabase({
			name,
			version: 2,
			stores: { users: { path: 'id' }, posts: { path: 'id' } },
		})
		cleanups.push(async () => {
			second.close()
			await deleteDatabase(name)
		})
		// Without the onversionchange yield, this would hang indefinitely on
		// `onblocked` since `first` never releases its connection on its own — the
		// second `connect` completing at all (rather than timing out) is the proof.
		await second.connect()
		expect(second.open).toBe(true)
		expect(second.version).toBe(2)
	})

	it('lazily reconnects a yielded handle at the new version on the next operation', async () => {
		const name = uniqueName()
		await deleteDatabase(name)
		// Auto-managed (no pinned `version`): the lazy reconnect below re-opens
		// without a fixed version, so it naturally lands on whatever version is
		// current — a pinned-version handle would instead throw `VersionError`
		// reconnecting below a version another connection already bumped past.
		const first = createIndexedDBDatabase({ name, stores: { users: { path: 'id' } } })
		await first.connect()
		await first.store('users').set({ id: 'u1', name: 'Ada' })

		const second = createIndexedDBDatabase({
			name,
			version: 2,
			stores: { users: { path: 'id' }, posts: { path: 'id' } },
		})
		cleanups.push(async () => {
			first.close()
			second.close()
			await deleteDatabase(name)
		})
		await second.connect()

		// The yielded `first` handle reports closed — a self-initiated `close()`
		// inside `onversionchange`, which does not fire the native `close` event, so
		// the reconnect latches must be cleared explicitly.
		expect(first.open).toBe(false)

		// A subsequent operation on `first` lazily reconnects instead of throwing
		// NOT_OPEN forever, landing on the NEW version with the new store visible.
		const record = await first.store('users').get('u1')
		expect(record).toEqual({ id: 'u1', name: 'Ada' })
		expect(first.open).toBe(true)
		expect(first.version).toBe(2)
		expect([...first.stores].sort()).toEqual(['posts', 'users'])
	})
})

describe('IndexedDBDatabase — abnormal close recovery', () => {
	it('lazily reconnects after an external onclose fires, instead of staying invalid forever', async () => {
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		cleanups.push(cleanup)
		await db.store('users').set({ id: 'u1', name: 'Ada' })
		expect(db.open).toBe(true)

		// Simulate a browser-initiated close (crash, eviction) by invoking the
		// native `onclose` handler directly on the live connection — this is NOT
		// the self-initiated `close()` path (which never fires `onclose`).
		const native = db.database
		native.onclose?.(new Event('close'))
		expect(db.open).toBe(false)

		// The next operation must lazily reconnect rather than throwing NOT_OPEN
		// forever — proving `onclose` cleared BOTH latches, not just `#database`.
		const record = await db.store('users').get('u1')
		expect(record).toEqual({ id: 'u1', name: 'Ada' })
		expect(db.open).toBe(true)
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
