import type {
	IndexDefinition,
	IndexedDBDatabaseInterface,
	IndexedDBSchema,
	StoreDefinition,
} from '@src/browser'
import {
	createIndexedDBDatabase,
	IndexedDBDatabase,
	IndexedDBError,
	isIndexedDBError,
	promisifyRequest,
	promisifyTransaction,
} from '@src/browser'
import { afterEach, describe, expect, it } from 'vitest'
import { isString } from '@orkestrel/contract'
import {
	captureError,
	createRecorder,
	createTeardown,
	invokeUnchecked,
	waitForDelay,
} from '@orkestrel/test'
import {
	createTestDatabase,
	dropDatabase,
	createChangingOptions,
	createShiftingOptions,
	createShiftingStores,
	errorCode,
	IndexLike,
	StoreLike,
	MESSAGE_NAMES,
	migrateNothing,
	OPTIONS_REFUSAL_HEADER,
	OPTIONS_REFUSAL_SUMMARY,
	mintDatabase,
	REFUSED_OPTIONS,
} from '../../setupBrowser.js'

// The `IndexedDBDatabaseInterface` surface in real Chromium: lazy connect and
// state (`name` / `version` / `stores` / `open` / `database`), the `store`
// accessor, atomic `read` / `write` scopes, `close`, `drop`, and the
// auto-managed schema path. Each test opens a uniquely-named database through
// the shared `createTestDatabase` opener and disposes it afterwards, so the
// suite is order- and rerun-independent. Sub-entity behavior (store CRUD,
// indexes, cursors, transaction-bound stores) lives in the matching per-entity
// files; this file pins only the database handle's own contract.

const teardown = createTeardown()

afterEach(teardown.destroy)

describe('IndexedDBDatabase — connection and state', () => {
	it('connects lazily and reports its state', async () => {
		const name = mintDatabase()
		const db = createIndexedDBDatabase({ name, version: 1, stores: { users: { path: 'id' } } })
		teardown.add(async () => {
			db.close()
			await dropDatabase(name)
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
		teardown.add(cleanup)
		expect([...db.stores].sort()).toEqual(['posts', 'users'])
	})

	it('rejects an empty name and a non-positive version at construction', () => {
		const emptyName = captureError(() => createIndexedDBDatabase({ name: '', stores: {} }))
		expect(errorCode(emptyName)).toBe('DATA')

		const badVersion = captureError(() =>
			createIndexedDBDatabase({ name: mintDatabase(), version: 0, stores: {} }),
		)
		expect(errorCode(badVersion)).toBe('DATA')
	})

	it('throws CLOSED on connect once closed', async () => {
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		teardown.add(cleanup)
		db.close()
		expect(db.open).toBe(false)
		const caught = captureError(() => db.connect())
		expect(caught).toBeInstanceOf(IndexedDBError)
		expect(errorCode(caught)).toBe('CLOSED')
	})
})

describe('IndexedDBDatabase — blocked lifecycle', () => {
	it('keeps one versioned open pending until its raw blocker closes', async () => {
		const name = mintDatabase()
		await dropDatabase(name)
		const request = globalThis.indexedDB.open(name, 1)
		request.addEventListener('upgradeneeded', () => {
			request.result.createObjectStore('users', { keyPath: 'id' })
		})
		const blocker = await promisifyRequest(request)
		const requested = new Promise<void>((resolve) => {
			blocker.addEventListener('versionchange', () => resolve(), { once: true })
		})
		const upgrades = createRecorder<[]>()
		const db = createIndexedDBDatabase({
			name,
			version: 2,
			stores: { users: { path: 'id' }, posts: { path: 'id' } },
			upgrade: () => upgrades.handler(),
		})
		teardown.add(async () => {
			blocker.close()
			db.close()
			await dropDatabase(name)
		})

		const settled = new AbortController()
		const first = db.connect()
		first.then(
			() => {
				settled.abort()
			},
			() => {
				settled.abort()
			},
		)
		const second = db.connect()
		expect(second).toBe(first)
		await requested
		await waitForDelay()
		expect(settled.signal.aborted).toBe(false)

		blocker.close()
		const database = await first
		expect(await second).toBe(database)
		expect(upgrades.calls).toEqual([[]])
		expect(db.open).toBe(true)
		expect(db.database).toBe(database)

		await db.drop()
		expect((await globalThis.indexedDB.databases()).some((entry) => entry.name === name)).toBe(
			false,
		)
	})

	it('keeps deletion pending and the database present until its raw blocker closes', async () => {
		const name = mintDatabase()
		await dropDatabase(name)
		const request = globalThis.indexedDB.open(name, 1)
		const blocker = await promisifyRequest(request)
		const requested = new Promise<void>((resolve) => {
			blocker.addEventListener('versionchange', () => resolve(), { once: true })
		})
		const db = createIndexedDBDatabase({ name, stores: {} })
		teardown.add(async () => {
			blocker.close()
			db.close()
			await dropDatabase(name)
		})

		const settled = new AbortController()
		const dropping = db.drop()
		dropping.then(
			() => {
				settled.abort()
			},
			() => {
				settled.abort()
			},
		)
		await requested
		expect(settled.signal.aborted).toBe(false)
		expect(
			(await globalThis.indexedDB.databases()).some((database) => database.name === name),
		).toBe(true)
		expect(settled.signal.aborted).toBe(false)

		blocker.close()
		await dropping
		expect(
			(await globalThis.indexedDB.databases()).some((database) => database.name === name),
		).toBe(false)
	})

	it('retires an explicit-version open closed while blocked without orphaning its result', async () => {
		const name = mintDatabase()
		await dropDatabase(name)
		const request = globalThis.indexedDB.open(name, 1)
		request.addEventListener('upgradeneeded', () => {
			request.result.createObjectStore('users', { keyPath: 'id' })
		})
		const blocker = await promisifyRequest(request)
		const requested = new Promise<void>((resolve) => {
			blocker.addEventListener('versionchange', () => resolve(), { once: true })
		})
		const db = createIndexedDBDatabase({
			name,
			version: 2,
			stores: { users: { path: 'id' }, posts: { path: 'id' } },
		})
		teardown.add(async () => {
			blocker.close()
			db.close()
			await dropDatabase(name)
		})

		const settled = new AbortController()
		const opening = db.connect()
		opening.then(
			() => {
				settled.abort()
			},
			() => {
				settled.abort()
			},
		)
		await requested
		await waitForDelay()
		expect(settled.signal.aborted).toBe(false)
		db.close()
		expect(settled.signal.aborted).toBe(false)
		blocker.close()

		const caught = await opening.catch((error: unknown) => error)
		expect(caught).toBeInstanceOf(IndexedDBError)
		expect(errorCode(caught)).toBe('CLOSED')
		expect(db.open).toBe(false)
		await db.drop()
		expect(
			(await globalThis.indexedDB.databases()).some((database) => database.name === name),
		).toBe(false)
	})

	it('retires an auto-managed second open closed while blocked without orphaning its result', async () => {
		const name = mintDatabase()
		await dropDatabase(name)
		const request = globalThis.indexedDB.open(name, 1)
		request.addEventListener('upgradeneeded', () => {
			request.result.createObjectStore('users', { keyPath: 'id' })
		})
		const blocker = await promisifyRequest(request)
		const requested = new Promise<void>((resolve) => {
			blocker.addEventListener('versionchange', () => resolve(), { once: true })
		})
		const db = createIndexedDBDatabase({
			name,
			stores: { users: { path: 'id' }, posts: { path: 'id' } },
		})
		teardown.add(async () => {
			blocker.close()
			db.close()
			await dropDatabase(name)
		})

		const settled = new AbortController()
		const opening = db.connect()
		opening.then(
			() => {
				settled.abort()
			},
			() => {
				settled.abort()
			},
		)
		await requested
		await waitForDelay()
		expect(settled.signal.aborted).toBe(false)
		db.close()
		expect(settled.signal.aborted).toBe(false)
		blocker.close()

		const caught = await opening.catch((error: unknown) => error)
		expect(caught).toBeInstanceOf(IndexedDBError)
		expect(errorCode(caught)).toBe('CLOSED')
		expect(db.open).toBe(false)
		await db.drop()
		expect(
			(await globalThis.indexedDB.databases()).some((database) => database.name === name),
		).toBe(false)
	})

	it('retires a blocked open when drop is requested without orphaning its result', async () => {
		const name = mintDatabase()
		await dropDatabase(name)
		const request = globalThis.indexedDB.open(name, 1)
		request.addEventListener('upgradeneeded', () => {
			request.result.createObjectStore('users', { keyPath: 'id' })
		})
		const blocker = await promisifyRequest(request)
		const requested = new Promise<void>((resolve) => {
			blocker.addEventListener('versionchange', () => resolve(), { once: true })
		})
		const db = createIndexedDBDatabase({
			name,
			version: 2,
			stores: { users: { path: 'id' }, posts: { path: 'id' } },
		})
		teardown.add(async () => {
			blocker.close()
			db.close()
			await dropDatabase(name)
		})

		const settled = new AbortController()
		const opening = db.connect()
		opening.then(
			() => {
				settled.abort()
			},
			() => {
				settled.abort()
			},
		)
		await requested
		await waitForDelay()
		expect(settled.signal.aborted).toBe(false)

		const dropped = new AbortController()
		const dropping = db.drop()
		dropping.then(
			() => {
				dropped.abort()
			},
			() => {
				dropped.abort()
			},
		)
		const reconnect = captureError(() => db.connect())
		expect(reconnect).toBeInstanceOf(IndexedDBError)
		expect(errorCode(reconnect)).toBe('CLOSED')
		await waitForDelay()
		expect(db.open).toBe(false)
		expect(settled.signal.aborted).toBe(false)
		expect(dropped.signal.aborted).toBe(false)
		blocker.close()

		const caught = await opening.catch((error: unknown) => error)
		expect(caught).toBeInstanceOf(IndexedDBError)
		expect(errorCode(caught)).toBe('CLOSED')
		await dropping
		expect(dropped.signal.aborted).toBe(true)
		expect(db.open).toBe(false)
		expect(
			(await globalThis.indexedDB.databases()).some((database) => database.name === name),
		).toBe(false)
	})
})

describe('IndexedDBDatabase — store accessor', () => {
	it('reaches a declared store and throws NOT_FOUND for an undeclared one', async () => {
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		teardown.add(cleanup)
		const users = db.store('users')
		expect(users.name).toBe('users')
		expect(users.path).toBe('id')

		// A widened handle (default `IndexedDBSchema`) lets `store` take any name, so the
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
		teardown.add(cleanup)
		await db.write(['users', 'posts'], async (transaction) => {
			await transaction.store('users').set({ id: 'u1', name: 'Ada' })
			await transaction.store('posts').set({ id: 'p1', author: 'u1' })
		})
		expect(await db.store('users').get('u1')).toEqual({ id: 'u1', name: 'Ada' })
		expect(await db.store('posts').get('p1')).toEqual({ id: 'p1', author: 'u1' })
	})

	it('rolls the whole scope back when it throws', async () => {
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		teardown.add(cleanup)
		await db.store('users').set({ id: 'u1', n: 1 })
		const caught = await db
			.write('users', async (transaction) => {
				await transaction.store('users').set({ id: 'u1', n: 2 })
				await transaction.store('users').set({ id: 'u2', n: 9 })
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
		teardown.add(cleanup)
		await db.write('users', async (transaction) => {
			await transaction.store('users').set({ id: 'u1', name: 'Ada' })
			await waitForDelay(10) // non-IDB await — the transaction auto-commits here
		})
		expect(await db.store('users').get('u1')).toEqual({ id: 'u1', name: 'Ada' })
	})

	it('reads within a readonly scope', async () => {
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		teardown.add(cleanup)
		await db.store('users').set({ id: 'u1', name: 'Ada' })
		const found = Promise.withResolvers<unknown>()
		await db.read('users', async (transaction) => {
			found.resolve(await transaction.store('users').get('u1'))
		})
		expect(await found.promise).toEqual({ id: 'u1', name: 'Ada' })
	})
})

describe('IndexedDBDatabase — auto-managed schema (no version)', () => {
	it('opens at the current version and bumps once to create a newly declared store', async () => {
		const name = mintDatabase()
		await dropDatabase(name)
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
		teardown.add(async () => {
			second.close()
			await dropDatabase(name)
		})
		await second.connect()
		expect(second.version).toBe(2)
		expect([...second.stores].sort()).toEqual(['posts', 'users'])
		expect(await second.store('users').get('u1')).toEqual({ id: 'u1', name: 'Ada' })
		await second.store('posts').set({ id: 'p1' })
		expect(await second.store('posts').get('p1')).toEqual({ id: 'p1' })
	})

	it('creates new stores on an explicit version upgrade', async () => {
		const name = mintDatabase()
		await dropDatabase(name)
		const v1 = createIndexedDBDatabase({ name, version: 1, stores: { users: { path: 'id' } } })
		await v1.connect()
		v1.close()

		const v2 = createIndexedDBDatabase({
			name,
			version: 2,
			stores: { users: { path: 'id' }, posts: { path: 'id' } },
		})
		teardown.add(async () => {
			v2.close()
			await dropDatabase(name)
		})
		await v2.connect()
		expect(v2.version).toBe(2)
		expect(v2.stores).toContain('posts')
		await v2.store('posts').set({ id: 'p1' })
		expect(await v2.store('posts').get('p1')).toEqual({ id: 'p1' })
	})

	it('contains built-in schema faults across retries without partial state or orphan connections', async () => {
		const name = mintDatabase()
		await dropDatabase(name)
		const seed = createIndexedDBDatabase({
			name,
			version: 1,
			stores: { users: { path: 'id' } },
		})
		teardown.add(async () => {
			seed.close()
			await dropDatabase(name)
		})
		await seed.connect()
		await seed.store('users').set({ id: 'sentinel', value: 'preserved' })
		seed.close()

		const callbacks = createRecorder<[]>()
		const failed = createIndexedDBDatabase({
			name,
			stores: {
				users: { path: 'id' },
				posts: {
					path: 'id',
					indexes: [
						{ name: 'bySlug', path: 'slug' },
						{ name: 'bySlug', path: 'title' },
					],
				},
			},
			upgrade: () => callbacks.handler(),
		})
		teardown.add(async () => {
			failed.close()
			await dropDatabase(name)
		})

		const first = failed.connect()
		const firstCaught = await first.catch((error: unknown) => error)
		expect(failed.open).toBe(false)
		const second = failed.connect()
		expect(second).not.toBe(first)
		const secondCaught = await second.catch((error: unknown) => error)

		for (const caught of [firstCaught, secondCaught]) {
			expect(caught).toBeInstanceOf(IndexedDBError)
			expect(errorCode(caught)).toBe('UPGRADE')
			const schemaCause = isIndexedDBError(caught) ? caught.cause : undefined
			expect(schemaCause).toBeInstanceOf(IndexedDBError)
			expect(errorCode(schemaCause)).toBe('CONSTRAINT')
			const nativeCause = isIndexedDBError(schemaCause) ? schemaCause.cause : undefined
			expect(nativeCause).toBeInstanceOf(DOMException)
			expect(nativeCause).toHaveProperty('name', 'ConstraintError')
		}
		expect(callbacks.calls).toEqual([])
		expect(failed.open).toBe(false)

		const valid = createIndexedDBDatabase({
			name,
			version: 1,
			stores: { users: { path: 'id' } },
		})
		teardown.add(async () => {
			valid.close()
			await dropDatabase(name)
		})
		await valid.connect()
		expect(valid.version).toBe(1)
		expect(await valid.store('users').get('sentinel')).toEqual({
			id: 'sentinel',
			value: 'preserved',
		})
		expect(valid.database.objectStoreNames.contains('posts')).toBe(false)

		valid.close()
		await failed.drop()
		expect(
			(await globalThis.indexedDB.databases()).some((database) => database.name === name),
		).toBe(false)
	})
})

describe('IndexedDBDatabase — upgrade hook', () => {
	it('drops a store while leaving others intact', async () => {
		const name = mintDatabase()
		await dropDatabase(name)
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
				context.stores.drop('posts')
			},
		})
		teardown.add(async () => {
			v2.close()
			await dropDatabase(name)
		})
		await v2.connect()
		expect([...v2.database.objectStoreNames]).toEqual(['users'])
		expect(await v2.store('users').get('u1')).toEqual({ id: 'u1', name: 'Ada' })
	})

	it('adds an index to an existing store through context.indexes.create', async () => {
		const name = mintDatabase()
		await dropDatabase(name)
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
				context.indexes.create('users', { name: 'byName', path: 'name' })
			},
		})
		teardown.add(async () => {
			v2.close()
			await dropDatabase(name)
		})
		await v2.connect()
		expect(await v2.store('users').index('byName').get('Bea')).toEqual({ id: 'u2', name: 'Bea' })
	})

	it('adds a unique index to a store created in the same upgrade through context.stores.create', async () => {
		const name = mintDatabase()
		await dropDatabase(name)
		const v1 = createIndexedDBDatabase({ name, version: 1, stores: { users: { path: 'id' } } })
		await v1.connect()
		v1.close()

		const v2 = createIndexedDBDatabase({
			name,
			version: 2,
			stores: { users: { path: 'id' } },
			upgrade: (context) => {
				context.stores.create('logs', { path: 'id' })
				context.indexes.create('logs', { name: 'byMessage', path: 'message', unique: true })
			},
		})
		teardown.add(async () => {
			v2.close()
			await dropDatabase(name)
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

	it('removes an index through context.indexes.drop', async () => {
		const name = mintDatabase()
		await dropDatabase(name)
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
				context.indexes.drop('users', 'byName')
			},
		})
		teardown.add(async () => {
			v2.close()
			await dropDatabase(name)
		})
		await v2.connect()
		const read = v2.database.transaction(['users'], 'readonly')
		expect(read.objectStore('users').indexNames.contains('byName')).toBe(false)
		await promisifyTransaction(read)
	})

	it('migrates data within the upgrade transaction through context.stores.store', async () => {
		const name = mintDatabase()
		await dropDatabase(name)
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
				const store = context.stores.store('users')
				const rows = await store.records()
				for (const row of rows) {
					const nameValue = isString(row.name) ? row.name.toUpperCase() : row.name
					await store.set({ ...row, name: nameValue })
				}
			},
		})
		teardown.add(async () => {
			v2.close()
			await dropDatabase(name)
		})
		await v2.connect()
		expect(await v2.store('users').get('u1')).toEqual({ id: 'u1', name: 'ADA' })
		expect(await v2.store('users').get('u2')).toEqual({ id: 'u2', name: 'BEA' })
	})

	it('rejects connect() cleanly when an async upgrade throws after an awaited request', async () => {
		const name = mintDatabase()
		await dropDatabase(name)
		const failure = new Error('migration boom')
		const v1 = createIndexedDBDatabase({ name, version: 1, stores: { users: { path: 'id' } } })
		await v1.connect()
		await v1.store('users').set({ id: 'u1', name: 'ada' })
		v1.close()

		const v2 = createIndexedDBDatabase({
			name,
			version: 2,
			stores: { users: { path: 'id' } },
			upgrade: async (context) => {
				const store = context.stores.store('users')
				// Await a real IDB request first, so the versionchange transaction is
				// still alive when the throw below happens.
				await store.records()
				throw failure
			},
		})
		teardown.add(async () => {
			v2.close()
			await dropDatabase(name)
		})

		const caught = await v2.connect().catch((error: unknown) => error)
		expect(caught).toBeInstanceOf(IndexedDBError)
		expect(errorCode(caught)).toBe('UPGRADE')
		expect(isIndexedDBError(caught) ? caught.cause : undefined).toBe(failure)
		expect(v2.open).toBe(false)

		// The upgrade never half-applied: the database is still at version 1, and a
		// fresh connection without the throwing upgrade opens it cleanly and reads
		// the pre-upgrade data back untouched.
		const reopened = createIndexedDBDatabase({
			name,
			version: 1,
			stores: { users: { path: 'id' } },
		})
		teardown.add(async () => {
			reopened.close()
			await dropDatabase(name)
		})
		await reopened.connect()
		expect(reopened.version).toBe(1)
		expect(await reopened.store('users').get('u1')).toEqual({ id: 'u1', name: 'ada' })
	})

	it('preserves a synchronous undefined upgrade failure as a present cause', async () => {
		const name = mintDatabase()
		const failure: unknown = undefined
		await dropDatabase(name)
		const v1 = createIndexedDBDatabase({ name, version: 1, stores: { users: { path: 'id' } } })
		await v1.connect()
		v1.close()

		const v2 = createIndexedDBDatabase({
			name,
			version: 2,
			stores: { users: { path: 'id' } },
			upgrade: () => {
				throw failure
			},
		})
		teardown.add(async () => {
			v2.close()
			await dropDatabase(name)
		})
		const caught = await v2.connect().catch((error: unknown) => error)
		const upgrade = isIndexedDBError(caught) ? caught : undefined
		expect(caught).toBeInstanceOf(IndexedDBError)
		expect(errorCode(caught)).toBe('UPGRADE')
		expect(Object.hasOwn(upgrade ?? {}, 'cause')).toBe(true)
		expect(upgrade?.cause).toBeUndefined()
		expect(v2.open).toBe(false)
	})

	it('preserves an asynchronously rejected undefined upgrade failure as a present cause', async () => {
		const name = mintDatabase()
		const failure: unknown = undefined
		await dropDatabase(name)
		const v1 = createIndexedDBDatabase({ name, version: 1, stores: { users: { path: 'id' } } })
		await v1.connect()
		v1.close()

		const v2 = createIndexedDBDatabase({
			name,
			version: 2,
			stores: { users: { path: 'id' } },
			upgrade: () => Promise.reject(failure),
		})
		teardown.add(async () => {
			v2.close()
			await dropDatabase(name)
		})
		const caught = await v2.connect().catch((error: unknown) => error)
		const upgrade = isIndexedDBError(caught) ? caught : undefined
		expect(caught).toBeInstanceOf(IndexedDBError)
		expect(errorCode(caught)).toBe('UPGRADE')
		expect(Object.hasOwn(upgrade ?? {}, 'cause')).toBe(true)
		expect(upgrade?.cause).toBeUndefined()
		expect(v2.open).toBe(false)
	})

	it('creates a store through context.stores.create, honouring its definition', async () => {
		const name = mintDatabase()
		await dropDatabase(name)
		const v1 = createIndexedDBDatabase({ name, version: 1, stores: { users: { path: 'id' } } })
		await v1.connect()
		v1.close()

		const v2 = createIndexedDBDatabase({
			name,
			version: 2,
			stores: { users: { path: 'id' } },
			upgrade: (context) => {
				context.stores.create('logs', { path: 'id', increment: false })
			},
		})
		teardown.add(async () => {
			v2.close()
			await dropDatabase(name)
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

	it('surfaces a typed IndexedDBError when context.stores.drop targets a missing store', async () => {
		const name = mintDatabase()
		await dropDatabase(name)
		const v1 = createIndexedDBDatabase({ name, version: 1, stores: { users: { path: 'id' } } })
		await v1.connect()
		v1.close()

		const v2 = createIndexedDBDatabase({
			name,
			version: 2,
			stores: { users: { path: 'id' } },
			upgrade: (context) => {
				context.stores.drop('missing')
			},
		})
		teardown.add(async () => {
			v2.close()
			await dropDatabase(name)
		})
		const caught = await v2.connect().catch((error: unknown) => error)
		expect(caught).toBeInstanceOf(IndexedDBError)
		expect(errorCode(caught)).toBe('UPGRADE')
		expect(v2.open).toBe(false)
	})

	it('surfaces a typed IndexedDBError when context.indexes.drop targets a missing index', async () => {
		const name = mintDatabase()
		await dropDatabase(name)
		const v1 = createIndexedDBDatabase({ name, version: 1, stores: { users: { path: 'id' } } })
		await v1.connect()
		v1.close()

		const v2 = createIndexedDBDatabase({
			name,
			version: 2,
			stores: { users: { path: 'id' } },
			upgrade: (context) => {
				context.indexes.drop('users', 'missing')
			},
		})
		teardown.add(async () => {
			v2.close()
			await dropDatabase(name)
		})
		const caught = await v2.connect().catch((error: unknown) => error)
		expect(caught).toBeInstanceOf(IndexedDBError)
		expect(errorCode(caught)).toBe('UPGRADE')
		expect(v2.open).toBe(false)
	})

	it('exposes old / version / stores.names correctly on the context', async () => {
		const name = mintDatabase()
		await dropDatabase(name)
		const v1 = createIndexedDBDatabase({ name, version: 1, stores: { users: { path: 'id' } } })
		await v1.connect()
		v1.close()

		const seenOld = Promise.withResolvers<number>()
		const seenVersion = Promise.withResolvers<number>()
		const seenStores = Promise.withResolvers<readonly string[]>()
		const v2 = createIndexedDBDatabase({
			name,
			version: 3,
			stores: { users: { path: 'id' }, posts: { path: 'id' } },
			upgrade: (context) => {
				seenOld.resolve(context.old)
				seenVersion.resolve(context.version)
				seenStores.resolve(context.stores.names)
			},
		})
		teardown.add(async () => {
			v2.close()
			await dropDatabase(name)
		})
		await v2.connect()
		expect(await seenOld.promise).toBe(1)
		expect(await seenVersion.promise).toBe(3)
		expect([...(await seenStores.promise)].sort()).toEqual(['posts', 'users'])
	})
})

describe('IndexedDBDatabase — versionchange yields a live connection', () => {
	it('closes the first connection so a second connection at a higher version can open', async () => {
		const name = mintDatabase()
		await dropDatabase(name)
		const first = createIndexedDBDatabase({ name, version: 1, stores: { users: { path: 'id' } } })
		await first.connect()
		expect(first.open).toBe(true)

		const second = createIndexedDBDatabase({
			name,
			version: 2,
			stores: { users: { path: 'id' }, posts: { path: 'id' } },
		})
		teardown.add(async () => {
			second.close()
			await dropDatabase(name)
		})
		// Without the onversionchange yield, this would hang indefinitely on
		// `onblocked` since `first` never releases its connection on its own — the
		// second `connect` completing at all (rather than timing out) is the proof.
		await second.connect()
		expect(second.open).toBe(true)
		expect(second.version).toBe(2)
	})

	it('lazily reconnects a yielded handle at the new version on the next operation', async () => {
		const name = mintDatabase()
		await dropDatabase(name)
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
		teardown.add(async () => {
			first.close()
			second.close()
			await dropDatabase(name)
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
		teardown.add(cleanup)
		await db.store('users').set({ id: 'u1', name: 'Ada' })
		expect(db.open).toBe(true)

		// Simulate a browser-initiated close (crash, eviction) by invoking the
		// native `onclose` handler directly on the live connection — this is NOT
		// the self-initiated `close()` path (which never fires `onclose`).
		const native = db.database
		native.onclose?.(new Event('close'))
		expect(db.open).toBe(false)

		// The next operation must lazily reconnect rather than throwing NOT_OPEN
		// forever — proving `onclose` cleared BOTH latches, not only `#database`.
		const record = await db.store('users').get('u1')
		expect(record).toEqual({ id: 'u1', name: 'Ada' })
		expect(db.open).toBe(true)
	})
})

describe('IndexedDBDatabase — persistence and drop', () => {
	it('persists across a close and reopen over the same name', async () => {
		// Open WITHOUT the shared cleanup: its cleanup deletes the database, but this
		// test must keep the bytes on disk across the reopen below.
		const name = mintDatabase()
		await dropDatabase(name)
		const db = createIndexedDBDatabase({ name, version: 1, stores: { users: { path: 'id' } } })
		await db.store('users').set({ id: 'u1', name: 'Ada' })
		db.close()

		// Re-create under the SAME name; the data must survive the reopen.
		const reopened = createIndexedDBDatabase({
			name,
			version: 1,
			stores: { users: { path: 'id' } },
		})
		teardown.add(async () => {
			reopened.close()
			await dropDatabase(name)
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
		teardown.add(async () => {
			fresh.close()
			await dropDatabase(name)
		})
		expect(await fresh.store('users').get('u1')).toBeUndefined()
	})
})

describe('IndexedDBDatabase — declared index reconcile', () => {
	it('creates a declared index an auto-managed reopen adds, keeps the rows, and moves no version on an identical reopen', async () => {
		const name = mintDatabase()
		await dropDatabase(name)
		teardown.add(async () => dropDatabase(name))
		const first = createIndexedDBDatabase({ name, stores: { users: { path: 'id' } } })
		await first.connect()
		await first.store('users').set([
			{ id: 'u1', name: 'Ada' },
			{ id: 'u2', name: 'Bea' },
		])
		first.close()

		const declared = { users: { path: 'id', indexes: [{ name: 'byName', path: 'name' }] } }
		const second = createIndexedDBDatabase({ name, stores: declared })
		await second.connect()
		expect(second.version).toBe(2)
		expect(
			Array.from(second.database.transaction(['users']).objectStore('users').indexNames),
		).toEqual(['byName'])
		expect(await second.store('users').index('byName').get('Bea')).toEqual({
			id: 'u2',
			name: 'Bea',
		})
		expect(await second.store('users').records()).toEqual([
			{ id: 'u1', name: 'Ada' },
			{ id: 'u2', name: 'Bea' },
		])
		second.close()

		const third = createIndexedDBDatabase({ name, stores: declared })
		await third.connect()
		expect(third.version).toBe(2)
		third.close()
	})

	it('creates a declared index an existing store lacks on a pinned bump with no callback', async () => {
		const name = mintDatabase()
		await dropDatabase(name)
		teardown.add(async () => dropDatabase(name))
		const v1 = createIndexedDBDatabase({ name, version: 1, stores: { users: { path: 'id' } } })
		await v1.connect()
		await v1.store('users').set({ id: 'u1', name: 'Ada' })
		v1.close()

		const v2 = createIndexedDBDatabase({
			name,
			version: 2,
			stores: { users: { path: 'id', indexes: [{ name: 'byName', path: 'name', unique: true }] } },
		})
		await v2.connect()
		const index = v2.database.transaction(['users']).objectStore('users').index('byName')
		expect([index.keyPath, index.unique, index.multiEntry]).toEqual(['name', true, false])
		expect(await v2.store('users').index('byName').get('Ada')).toEqual({ id: 'u1', name: 'Ada' })
		v2.close()
	})

	it('rejects connect() with UPGRADE naming the store and index when a stored index differs', async () => {
		const name = mintDatabase()
		await dropDatabase(name)
		teardown.add(async () => dropDatabase(name))
		const v1 = createIndexedDBDatabase({
			name,
			version: 1,
			stores: { users: { path: 'id', indexes: [{ name: 'byName', path: 'name' }] } },
		})
		await v1.connect()
		v1.close()

		const pinned = createIndexedDBDatabase({
			name,
			version: 2,
			stores: { users: { path: 'id', indexes: [{ name: 'byName', path: 'title' }] } },
		})
		const auto = createIndexedDBDatabase({
			name,
			stores: { users: { path: 'id', indexes: [{ name: 'byName', path: 'name', unique: true }] } },
		})
		for (const handle of [pinned, auto]) {
			const caught = await handle.connect().catch((error: unknown) => error)
			expect(errorCode(caught)).toBe('UPGRADE')
			expect(caught).toHaveProperty('context', { store: 'users', index: 'byName' })
			const cause = isIndexedDBError(caught) ? caught.cause : undefined
			expect(errorCode(cause)).toBe('UPGRADE')
			expect(cause).toHaveProperty('context', { store: 'users', index: 'byName' })
			expect(handle.open).toBe(false)
		}
		const stored = await globalThis.indexedDB.databases()
		expect(stored.find((database) => database.name === name)?.version).toBe(1)
	})

	it('neither bumps nor creates a missing declared index on a pinned open at the stored version', async () => {
		const name = mintDatabase()
		await dropDatabase(name)
		teardown.add(async () => dropDatabase(name))
		const v1 = createIndexedDBDatabase({ name, version: 1, stores: { users: { path: 'id' } } })
		await v1.connect()
		v1.close()

		const pinned = createIndexedDBDatabase({
			name,
			version: 1,
			stores: { users: { path: 'id', indexes: [{ name: 'byName', path: 'name' }] } },
		})
		await pinned.connect()
		expect(pinned.version).toBe(1)
		expect(
			Array.from(pinned.database.transaction(['users']).objectStore('users').indexNames),
		).toEqual([])
		pinned.close()
	})

	it('keeps an undeclared index a callback created across a later bump', async () => {
		const name = mintDatabase()
		await dropDatabase(name)
		teardown.add(async () => dropDatabase(name))
		const v1 = createIndexedDBDatabase({
			name,
			version: 1,
			stores: { users: { path: 'id' } },
			upgrade: (context) => {
				context.indexes.create('users', { name: 'bySlug', path: 'slug' })
			},
		})
		await v1.connect()
		v1.close()

		const later = createIndexedDBDatabase({
			name,
			stores: { users: { path: 'id' }, posts: { path: 'id' } },
		})
		await later.connect()
		expect(later.version).toBe(2)
		expect(
			Array.from(later.database.transaction(['users']).objectStore('users').indexNames),
		).toEqual(['bySlug'])
		later.close()
	})
})

describe('IndexedDBDatabase — a callback that aborts the versionchange transaction', () => {
	it('rejects connect() with UPGRADE over ABORTED over the native AbortError when the callback aborts synchronously, and keeps the version', async () => {
		const name = mintDatabase()
		await dropDatabase(name)
		teardown.add(async () => dropDatabase(name))
		const v1 = createIndexedDBDatabase({ name, version: 1, stores: { users: { path: 'id' } } })
		await v1.connect()
		v1.close()

		const v2 = createIndexedDBDatabase({
			name,
			version: 2,
			stores: { users: { path: 'id' } },
			upgrade: (context) => {
				context.transaction.abort()
			},
		})
		const caught = await v2.connect().catch((error: unknown) => error)
		expect(errorCode(caught)).toBe('UPGRADE')
		const cause = isIndexedDBError(caught) ? caught.cause : undefined
		expect(errorCode(cause)).toBe('ABORTED')
		expect(isIndexedDBError(cause) ? cause.cause : undefined).toHaveProperty('name', 'AbortError')
		expect(v2.open).toBe(false)
		const stored = await globalThis.indexedDB.databases()
		expect(stored.find((database) => database.name === name)?.version).toBe(1)
	})

	it('rejects connect() the same way when the callback awaits a request and then aborts', async () => {
		const name = mintDatabase()
		await dropDatabase(name)
		teardown.add(async () => dropDatabase(name))
		const v1 = createIndexedDBDatabase({ name, version: 1, stores: { users: { path: 'id' } } })
		await v1.connect()
		v1.close()

		const v2 = createIndexedDBDatabase({
			name,
			version: 2,
			stores: { users: { path: 'id', indexes: [{ name: 'byName', path: 'name' }] } },
			upgrade: async (context) => {
				await context.stores.store('users').count()
				context.transaction.abort()
			},
		})
		const caught = await v2.connect().catch((error: unknown) => error)
		expect(errorCode(caught)).toBe('UPGRADE')
		const cause = isIndexedDBError(caught) ? caught.cause : undefined
		expect(errorCode(cause)).toBe('ABORTED')
		expect(isIndexedDBError(cause) ? cause.cause : undefined).toHaveProperty('name', 'AbortError')
		const stored = await globalThis.indexedDB.databases()
		expect(stored.find((database) => database.name === name)?.version).toBe(1)
	})
})

describe('IndexedDBDatabase — construction refuses options the types forbid', () => {
	it('admits a bound function and an async function as upgrade', () => {
		const bound = createIndexedDBDatabase({
			name: 'catalogue',
			stores: {},
			upgrade: migrateNothing.bind(undefined),
		})
		const asynchronous = createIndexedDBDatabase({
			name: 'catalogue',
			stores: {},
			upgrade: async () => undefined,
		})
		expect([bound.name, asynchronous.name]).toEqual(['catalogue', 'catalogue'])
	})

	it.for(REFUSED_OPTIONS)('refuses $label with DATA', ({ options, message, context }) => {
		const caught = captureError(() =>
			invokeUnchecked(undefined, createIndexedDBDatabase, [options]),
		)
		expect(errorCode(caught)).toBe('DATA')
		expect(isIndexedDBError(caught) ? caught.message : undefined).toBe(message)
		expect(caught).toHaveProperty('context', context)
	})
})

describe('IndexedDBDatabase — an open that fails before its upgrade', () => {
	it.for(MESSAGE_NAMES)(
		'rejects connect() with OPEN over the native VersionError for a lower pinned version, naming $shown',
		async ({ name, shown }) => {
			await dropDatabase(name)
			teardown.add(async () => dropDatabase(name))
			const v2 = createIndexedDBDatabase({ name, version: 2, stores: {} })
			await v2.connect()
			v2.close()

			const v1 = createIndexedDBDatabase({ name, version: 1, stores: {} })
			const caught = await v1.connect().catch((error: unknown) => error)
			expect(errorCode(caught)).toBe('OPEN')
			expect(isIndexedDBError(caught) ? caught.message : undefined).toBe(
				`Failed to open database ${shown}`,
			)
			const cause = isIndexedDBError(caught) ? caught.cause : undefined
			expect(isIndexedDBError(cause)).toBe(false)
			expect(cause).toHaveProperty('name', 'VersionError')
		},
	)
})

describe('IndexedDBDatabase — messages write caller values through preview', () => {
	it.for(MESSAGE_NAMES)('names a version the types forbid ($shown)', ({ name, received }) => {
		const caught = captureError(() =>
			invokeUnchecked(undefined, createIndexedDBDatabase, [
				{ name: 'catalogue', version: name, stores: {} },
			]),
		)
		expect(isIndexedDBError(caught) ? caught.message : undefined).toBe(
			`${OPTIONS_REFUSAL_HEADER}\nversion: type; expected integer; received ${received}\n${OPTIONS_REFUSAL_SUMMARY}`,
		)
	})

	it.for(MESSAGE_NAMES)('names the database read before connect ($shown)', ({ name, shown }) => {
		const db = createIndexedDBDatabase({ name, stores: {} })
		const caught = captureError(() => db.database)
		expect(isIndexedDBError(caught) ? caught.message : undefined).toBe(
			`Database ${shown} is not open — call connect() first`,
		)
	})

	it.for(MESSAGE_NAMES)(
		'names the database connect refuses after close ($shown)',
		({ name, shown }) => {
			const db = createIndexedDBDatabase({ name, stores: {} })
			db.close()
			const caught = captureError(() => db.connect())
			expect(isIndexedDBError(caught) ? caught.message : undefined).toBe(
				`Database ${shown} has been closed`,
			)
		},
	)

	it.for(MESSAGE_NAMES)(
		'names the database whose pending open a close retires ($shown)',
		async ({ name, shown }) => {
			await dropDatabase(name)
			teardown.add(async () => dropDatabase(name))
			const db = createIndexedDBDatabase({ name, stores: {} })
			const pending = db.connect()
			db.close()
			const caught = await pending.catch((error: unknown) => error)
			expect(isIndexedDBError(caught) ? caught.message : undefined).toBe(
				`Database ${shown} has been closed`,
			)
		},
	)

	it.for(MESSAGE_NAMES)('names an undeclared store ($shown)', ({ name, shown }) => {
		const db = new IndexedDBDatabase<IndexedDBSchema>({ name: 'catalogue', stores: {} })
		const caught = captureError(() => db.store(name))
		expect(isIndexedDBError(caught) ? caught.message : undefined).toBe(
			`Store ${shown} is not declared on database "catalogue"`,
		)
	})

	it.for(MESSAGE_NAMES)(
		'names the database whose upgrade failed ($shown)',
		async ({ name, shown }) => {
			await dropDatabase(name)
			teardown.add(async () => dropDatabase(name))
			const db = createIndexedDBDatabase({
				name,
				stores: {},
				upgrade: () => {
					throw new Error('migration refused')
				},
			})
			const caught = await db.connect().catch((error: unknown) => error)
			expect(isIndexedDBError(caught) ? caught.message : undefined).toBe(
				`Upgrade of ${shown} failed`,
			)
		},
	)

	it.for(MESSAGE_NAMES)(
		'names the store and index whose stored definition differs ($shown)',
		async ({ name, shown }) => {
			const database = mintDatabase()
			await dropDatabase(database)
			teardown.add(async () => dropDatabase(database))
			const v1 = createIndexedDBDatabase({
				name: database,
				version: 1,
				stores: { [name]: { indexes: [{ name, path: 'title' }] } },
			})
			await v1.connect()
			v1.close()
			const v2 = createIndexedDBDatabase({
				name: database,
				version: 2,
				stores: { [name]: { indexes: [{ name, path: 'heading' }] } },
			})
			const caught = await v2.connect().catch((error: unknown) => error)
			const cause = isIndexedDBError(caught) ? caught.cause : undefined
			expect(isIndexedDBError(cause) ? cause.message : undefined).toBe(
				`Index ${shown} on store ${shown} differs from its declaration in path; drop it in an upgrade callback or match the declaration to it`,
			)
		},
	)
})

describe('IndexedDBDatabase — construction names every malformed store', () => {
	it('carries the audit faults of every malformed store in the refusal context', () => {
		const caught = captureError(() =>
			invokeUnchecked(undefined, createIndexedDBDatabase, [
				{
					name: 'catalogue',
					stores: {
						books: { path: 'id', autoIncrement: true, increment: 'yes' },
						notes: { path: 5 },
					},
				},
			]),
		)
		expect(errorCode(caught)).toBe('DATA')
		expect(isIndexedDBError(caught) ? caught.context : undefined).toEqual({
			faults: [
				{
					reason: 'type',
					path: ['stores', 'books', 'increment'],
					expected: 'boolean',
					received: '"yes"',
				},
				{ reason: 'extra', path: ['stores', 'books', 'autoIncrement'] },
				{ reason: 'variant', path: ['stores', 'notes', 'path'], variants: 2 },
				{ reason: 'type', path: ['stores', 'notes', 'path'], expected: 'string', received: '5' },
			],
		})
	})
})

describe('IndexedDBDatabase — upgrade verbs refuse definitions the types forbid', () => {
	it('refuses an index definition with a string unique flag as DATA before any native call', async () => {
		const name = mintDatabase()
		await dropDatabase(name)
		teardown.add(async () => dropDatabase(name))
		const v1 = createIndexedDBDatabase({ name, version: 1, stores: { users: { path: 'id' } } })
		await v1.connect()
		v1.close()

		const v2 = createIndexedDBDatabase({
			name,
			version: 2,
			stores: { users: { path: 'id' } },
			upgrade: (context) => {
				invokeUnchecked(context.indexes, context.indexes.create, [
					'users',
					{ name: 'byTitle', path: 'title', unique: 'no' },
				])
			},
		})
		const caught = await v2.connect().catch((error: unknown) => error)
		expect(errorCode(caught)).toBe('UPGRADE')
		const cause = isIndexedDBError(caught) ? caught.cause : undefined
		expect(errorCode(cause)).toBe('DATA')
		expect(isIndexedDBError(cause) ? cause.message : undefined).toBe(
			'Index definition for store "users" is not an IndexDefinition:\n' +
				'unique: type; expected boolean; received "no"\nsend {"name": string, "path": string | array of string, "unique"?: boolean, "multiple"?: boolean}',
		)
		expect(caught).toHaveProperty('context', {
			store: 'users',
			faults: [{ reason: 'type', path: ['unique'], expected: 'boolean', received: '"no"' }],
		})
		const stored = await globalThis.indexedDB.databases()
		expect(stored.find((database) => database.name === name)?.version).toBe(1)
	})

	it('refuses a store definition with a numeric key path as DATA before any native call', async () => {
		const name = mintDatabase()
		await dropDatabase(name)
		teardown.add(async () => dropDatabase(name))
		const v1 = createIndexedDBDatabase({ name, version: 1, stores: { users: { path: 'id' } } })
		await v1.connect()
		v1.close()

		const v2 = createIndexedDBDatabase({
			name,
			version: 2,
			stores: { users: { path: 'id' } },
			upgrade: (context) => {
				invokeUnchecked(context.stores, context.stores.create, ['logs', { path: 5 }])
			},
		})
		const caught = await v2.connect().catch((error: unknown) => error)
		expect(errorCode(caught)).toBe('UPGRADE')
		const cause = isIndexedDBError(caught) ? caught.cause : undefined
		expect(errorCode(cause)).toBe('DATA')
		expect(isIndexedDBError(cause) ? cause.message : undefined).toBe(
			'Store "logs" is not a StoreDefinition:\n' +
				'path: variant; the value matches none of the 2 declared forms; send it exactly as the schema declares, one of: string or array of string\npath: type; expected string; received 5\nsend {"path"?: string | array of string, "increment"?: boolean, "indexes"?: array of {"name": string, "path": string | array…}',
		)
		expect(caught).toHaveProperty('context', {
			store: 'logs',
			faults: [
				{ reason: 'variant', path: ['path'], variants: 2 },
				{ reason: 'type', path: ['path'], expected: 'string', received: '5' },
			],
		})
		const stored = await globalThis.indexedDB.databases()
		expect(stored.find((database) => database.name === name)?.version).toBe(1)
	})

	it.for([
		['a class instance', new IndexLike()],
		[
			'an optional member present as undefined',
			{ name: 'byTitle', path: 'title', unique: undefined },
		],
	] as const)('refuses %s as an index definition with DATA', async ([, definition]) => {
		const name = mintDatabase()
		await dropDatabase(name)
		teardown.add(async () => dropDatabase(name))
		const v1 = createIndexedDBDatabase({ name, version: 1, stores: { users: { path: 'id' } } })
		await v1.connect()
		v1.close()

		const v2 = createIndexedDBDatabase({
			name,
			version: 2,
			stores: { users: { path: 'id' } },
			upgrade: (context) => {
				invokeUnchecked(context.indexes, context.indexes.create, ['users', definition])
			},
		})
		const caught = await v2.connect().catch((error: unknown) => error)
		expect(errorCode(caught)).toBe('UPGRADE')
		expect(errorCode(isIndexedDBError(caught) ? caught.cause : undefined)).toBe('DATA')
	})
})

describe('IndexedDBDatabase — the store verb refuses the store-level boundaries', () => {
	it.for([
		[
			'a class instance',
			new StoreLike(),
			'value: type; expected object; received object\nsend {"path"?: string | array of string, "increment"?: boolean, "indexes"?: array of {"name": string, "path": string | array…}',
			[{ reason: 'type', path: [], expected: 'object', received: 'object' }],
		],
		[
			'an increment present as undefined',
			{ increment: undefined },
			'increment: type; expected boolean; received undefined\nsend {"path"?: string | array of string, "increment"?: boolean, "indexes"?: array of {"name": string, "path": string | array…}',
			[{ reason: 'type', path: ['increment'], expected: 'boolean', received: 'undefined' }],
		],
		[
			'a path present as undefined',
			{ path: undefined },
			'path: variant; the value matches none of the 2 declared forms; send it exactly as the schema declares, one of: string or array of string\npath: type; expected string; received undefined\nsend {"path"?: string | array of string, "increment"?: boolean, "indexes"?: array of {"name": string, "path": string | array…}',
			[
				{ reason: 'variant', path: ['path'], variants: 2 },
				{ reason: 'type', path: ['path'], expected: 'string', received: 'undefined' },
			],
		],
	] as const)(
		'refuses %s as a store definition with DATA',
		async ([, definition, text, faults]) => {
			const name = mintDatabase()
			await dropDatabase(name)
			teardown.add(async () => dropDatabase(name))
			const v1 = createIndexedDBDatabase({ name, version: 1, stores: { users: { path: 'id' } } })
			await v1.connect()
			v1.close()

			const v2 = createIndexedDBDatabase({
				name,
				version: 2,
				stores: { users: { path: 'id' } },
				upgrade: (context) => {
					invokeUnchecked(context.stores, context.stores.create, ['logs', definition])
				},
			})
			const caught = await v2.connect().catch((error: unknown) => error)
			expect(errorCode(caught)).toBe('UPGRADE')
			const cause = isIndexedDBError(caught) ? caught.cause : undefined
			expect(errorCode(cause)).toBe('DATA')
			expect(isIndexedDBError(cause) ? cause.message : undefined).toBe(
				'Store "logs" is not a StoreDefinition:\n' + text,
			)
			expect(caught).toHaveProperty('context', { store: 'logs', faults })
			const stored = await globalThis.indexedDB.databases()
			expect(stored.find((database) => database.name === name)?.version).toBe(1)
		},
	)
})

describe('IndexedDBDatabase — construction holds the options it admitted', () => {
	it('creates only the stores and indexes the options held at construction, whatever the caller changes later', async () => {
		const name = mintDatabase()
		await dropDatabase(name)
		teardown.add(async () => dropDatabase(name))
		const indexes: IndexDefinition[] = [{ name: 'byTitle', path: 'title' }]
		const stores: Record<string, StoreDefinition> = { books: { path: 'id', indexes } }
		const db = createIndexedDBDatabase({ name, stores })
		indexes.push({ name: 'byInjected', path: 'injected', unique: true })
		stores.injected = { path: 'id' }
		await db.connect()
		expect([...db.stores]).toEqual(['books'])
		expect(Array.from(db.database.transaction(['books']).objectStore('books').indexNames)).toEqual([
			'byTitle',
		])
		db.close()
	})
})

describe('IndexedDBDatabase — construction reads the options once', () => {
	it('reads an options getter once on admission', () => {
		const reads = createRecorder<[string]>()
		const db = createIndexedDBDatabase(createShiftingOptions(['catalogue'], reads))
		expect(db.name).toBe('catalogue')
		expect(reads.calls).toEqual([['name']])
	})

	it('reads an options getter once on refusal, and names the fault of that one read', () => {
		const reads = createRecorder<[string]>()
		const caught = captureError(() =>
			createIndexedDBDatabase(createShiftingOptions(['', 'catalogue'], reads)),
		)
		expect(errorCode(caught)).toBe('DATA')
		expect(caught).toHaveProperty('context', {
			faults: [
				{
					reason: 'constraint',
					path: ['name'],
					expected: 'string',
					constraint: 'min',
					limit: 1,
					received: '""',
				},
			],
		})
		expect(reads.calls).toEqual([['name']])
	})

	it('refuses a store definition getter at the clone, naming that cause, without reading it', () => {
		const reads = createRecorder<[string]>()
		const caught = captureError(() =>
			createIndexedDBDatabase({ name: 'catalogue', stores: createShiftingStores(reads) }),
		)
		expect(errorCode(caught)).toBe('DATA')
		expect(isIndexedDBError(caught) ? caught.message : undefined).toBe(
			'Database options are not plain JSON data: cloneJSONValue: record property is not enumerable data',
		)
		expect(caught).toHaveProperty('context', {
			clone: 'cloneJSONValue: record property is not enumerable data',
		})
		expect(isIndexedDBError(caught) ? caught.cause : undefined).toHaveProperty('code', 'clone')
		expect(reads.calls).toEqual([])
	})

	it('keeps the name, version, and upgrade it admitted, whatever the caller changes later', async () => {
		const name = mintDatabase()
		await dropDatabase(name)
		teardown.add(async () => dropDatabase(name))
		const kept = createRecorder<[]>()
		const replaced = createRecorder<[]>()
		const options: { name: string; version: number; stores: IndexedDBSchema; upgrade: () => void } =
			{ name, version: 1, stores: { books: { path: 'id' } }, upgrade: kept.handler }
		const db = createIndexedDBDatabase(options)
		options.name = mintDatabase()
		options.version = 3
		options.upgrade = replaced.handler
		await db.connect()
		expect(db.name).toBe(name)
		expect(db.version).toBe(1)
		expect(kept.calls).toHaveLength(1)
		expect(replaced.calls).toEqual([])
		db.close()
	})

	it('uses the name, version, and upgrade of the one read, though a later read would answer otherwise', async () => {
		const name = mintDatabase()
		await dropDatabase(name)
		teardown.add(async () => dropDatabase(name))
		const kept = createRecorder<[]>()
		const replaced = createRecorder<[]>()
		const reads = createRecorder<[string]>()
		const db = createIndexedDBDatabase(
			createChangingOptions(
				{ name, version: 1, upgrade: kept.handler },
				{ name: mintDatabase(), version: 3, upgrade: replaced.handler },
				reads,
			),
		)
		await db.connect()
		expect(db.name).toBe(name)
		expect(db.version).toBe(1)
		expect(kept.calls).toHaveLength(1)
		expect(replaced.calls).toEqual([])
		expect(reads.calls).toEqual([['name'], ['version'], ['upgrade']])
		db.close()
	})

	it('admits an empty key path and an empty index list', () => {
		expect(
			captureError(() =>
				createIndexedDBDatabase({
					name: 'catalogue',
					stores: { books: { path: [], indexes: [] } },
				}),
			),
		).toBeUndefined()
	})

	it('refuses a schema past the clone node limit, naming that cause', () => {
		const stores = Object.fromEntries(
			Array.from({ length: 140_000 }, (_, position) => [`store${position}`, { path: 'id' }]),
		)
		const caught = captureError(() => createIndexedDBDatabase({ name: 'catalogue', stores }))
		expect(errorCode(caught)).toBe('DATA')
		expect(isIndexedDBError(caught) ? caught.message : undefined).toBe(
			'Database options are not plain JSON data: cloneJSONValue: snapshot exceeds the node limit 262144',
		)
		expect(caught).toHaveProperty('context', {
			clone: 'cloneJSONValue: snapshot exceeds the node limit 262144',
		})
	})
})
