import {
	IndexedDBError,
	isIndexedDBError,
	promisifyRequest,
	rangeFromKey,
	rangePrefix,
} from '@src/browser'
import { afterEach, describe, expect, it } from 'vitest'
import { captureError, createRecorder, createTeardown } from '@orkestrel/test'
import {
	createTestDatabase,
	drainCursor,
	errorCode,
	SEED_BOOK_STORES,
	seedNonRecord,
} from '../../setupBrowser.js'

// `IndexedDBStoreInterface` in real Chromium, reached through `db.store(name)`:
// the metadata getters (`name` / `path` / `indexes` / `increment`), the full
// keyed CRUD surface with its array-first batch overloads, key-range reads,
// `index` / `cursor` access, and the `NOT_FOUND` / `CONSTRAINT` / `DATA` / `RECORD` faults. Each
// test opens a uniquely-named database through the shared opener and disposes it
// afterwards. (Index- and cursor-specific behavior is pinned in their own files;
// here we exercise the store as the access point.)

const teardown = createTeardown()

afterEach(teardown.destroy)

describe('IndexedDBStore — metadata', () => {
	it('reports its declared schema', async () => {
		const { db, cleanup } = await createTestDatabase({
			users: {
				path: 'id',
				indexes: [
					{ name: 'byAge', path: 'age' },
					{ name: 'byEmail', path: 'email', unique: true },
				],
			},
			events: { increment: true },
		})
		teardown.add(cleanup)
		const users = db.store('users')
		expect(users.name).toBe('users')
		expect(users.path).toBe('id')
		expect([...users.indexes].sort()).toEqual(['byAge', 'byEmail'])
		expect(users.increment).toBe(false)

		const events = db.store('events')
		expect(events.path).toBeUndefined()
		expect(events.indexes).toEqual([])
		expect(events.increment).toBe(true)
	})

	it('exposes a compound key path verbatim', async () => {
		const { db, cleanup } = await createTestDatabase({
			parts: { path: ['make', 'model'] },
		})
		teardown.add(cleanup)
		expect(db.store('parts').path).toEqual(['make', 'model'])
	})
})

describe('IndexedDBStore — keyed CRUD', () => {
	it('round-trips a record; misses read as undefined / false / empty', async () => {
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		teardown.add(cleanup)
		const users = db.store('users')
		await users.set({ id: 'u1', name: 'Ada', age: 36 })
		expect(await users.get('u1')).toEqual({ id: 'u1', name: 'Ada', age: 36 })
		expect(await users.get('nope')).toBeUndefined()
		expect(await users.has('u1')).toBe(true)
		expect(await users.has('nope')).toBe(false)
		expect(await users.count()).toBe(1)

		await users.remove('u1')
		expect(await users.get('u1')).toBeUndefined()
		expect(await users.count()).toBe(0)
	})

	it('resolve returns the record, or throws NOT_FOUND on a miss', async () => {
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		teardown.add(cleanup)
		const users = db.store('users')
		await users.set({ id: 'u1' })
		expect(await users.resolve('u1')).toEqual({ id: 'u1' })
		const caught = await users.resolve('nope').catch((error: unknown) => error)
		expect(caught).toBeInstanceOf(IndexedDBError)
		expect(errorCode(caught)).toBe('NOT_FOUND')
	})

	it('reports the store and key of a resolve miss as machine-readable context', async () => {
		// The message states the same two facts; `context` is what a caller branches
		// on without parsing it.
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		teardown.add(cleanup)
		const caught = await db
			.store('users')
			.resolve('ghost')
			.catch((error: unknown) => error)
		expect(isIndexedDBError(caught)).toBe(true)
		expect(isIndexedDBError(caught) ? caught.context : undefined).toEqual({
			store: 'users',
			key: 'ghost',
		})
	})

	it('set upserts (overwrites) while add rejects a duplicate with CONSTRAINT', async () => {
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		teardown.add(cleanup)
		const users = db.store('users')
		await users.set({ id: 'u1', name: 'Ada' })
		await users.set({ id: 'u1', name: 'Grace' }) // upsert overwrites
		expect(await users.get('u1')).toEqual({ id: 'u1', name: 'Grace' })

		await users.add({ id: 'u2', name: 'Ada' })
		const caught = await users.add({ id: 'u2', name: 'Hopper' }).catch((error: unknown) => error)
		expect(caught).toBeInstanceOf(IndexedDBError)
		expect(errorCode(caught)).toBe('CONSTRAINT')
		expect(await users.get('u2')).toEqual({ id: 'u2', name: 'Ada' }) // unchanged
	})

	it('rejects a non-cloneable value with DATA', async () => {
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		teardown.add(cleanup)
		const users = db.store('users')
		// A function is not structured-clonable — the native put throws
		// DataCloneError, mapped to our DATA code.
		const caught = await users.set({ id: 'u1', fn: () => 'nope' }).catch((error: unknown) => error)
		expect(caught).toBeInstanceOf(IndexedDBError)
		expect(errorCode(caught)).toBe('DATA')
	})

	it('lists keys and records in key order, caps with count, and clears', async () => {
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		teardown.add(cleanup)
		const users = db.store('users')
		await users.set([
			{ id: 'a', n: 1 },
			{ id: 'b', n: 2 },
			{ id: 'c', n: 3 },
		])
		expect(await users.keys()).toEqual(['a', 'b', 'c'])
		expect((await users.records()).map((row) => row.id)).toEqual(['a', 'b', 'c'])
		expect((await users.records(undefined, 2)).length).toBe(2)
		expect(await users.keys(undefined, 1)).toEqual(['a'])
		await users.clear()
		expect(await users.keys()).toEqual([])
		expect(await users.count()).toBe(0)
	})
})

describe('IndexedDBStore — array-first batch overloads', () => {
	it('set / get / has / remove batch by the array overload', async () => {
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		teardown.add(cleanup)
		const users = db.store('users')
		const keys = await users.set([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
		expect(keys).toEqual(['a', 'b', 'c'])
		expect(await users.get(['a', 'missing', 'c'])).toEqual([{ id: 'a' }, undefined, { id: 'c' }])
		expect(await users.has(['a', 'missing'])).toEqual([true, false])
		await users.remove(['a', 'b'])
		expect(await users.keys()).toEqual(['c'])
	})

	it('add batches and resolve batches, throwing NOT_FOUND if any key misses', async () => {
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		teardown.add(cleanup)
		const users = db.store('users')
		await users.add([{ id: 'a' }, { id: 'b' }])
		expect(await users.resolve(['a', 'b'])).toEqual([{ id: 'a' }, { id: 'b' }])
		const caught = await users.resolve(['a', 'missing']).catch((error: unknown) => error)
		expect(errorCode(caught)).toBe('NOT_FOUND')
	})
})

describe('IndexedDBStore — key strategies', () => {
	it('supports out-of-line keys with an explicit key argument', async () => {
		const { db, cleanup } = await createTestDatabase({ events: {} })
		teardown.add(cleanup)
		const events = db.store('events')
		expect(events.path).toBeUndefined()
		await events.set({ type: 'click' }, 'e1')
		expect(await events.get('e1')).toEqual({ type: 'click' })
	})

	it('auto-increments out-of-line keys when increment is set', async () => {
		const { db, cleanup } = await createTestDatabase({ log: { increment: true } })
		teardown.add(cleanup)
		const log = db.store('log')
		const k1 = await log.set({ msg: 'first' })
		const k2 = await log.set({ msg: 'second' })
		expect(k1).toBe(1)
		expect(k2).toBe(2)
		expect(await log.get(1)).toEqual({ msg: 'first' })
		expect(await log.keys()).toEqual([1, 2])
	})

	it('reads a single compound key through a native only range', async () => {
		const { db, cleanup } = await createTestDatabase({ parts: { path: ['make', 'model'] } })
		teardown.add(cleanup)
		const parts = db.store('parts')
		await parts.set([
			{ make: 'acme', model: 'a', stock: 1 },
			{ make: 'acme', model: 'b', stock: 2 },
		])
		expect(await parts.records(IDBKeyRange.only(['acme', 'b']))).toEqual([
			{ make: 'acme', model: 'b', stock: 2 },
		])
		expect(await parts.count(IDBKeyRange.only(['acme', 'b']))).toBe(1)
	})
})

describe('IndexedDBStore — key-range reads', () => {
	it('reads and counts over a primary-key range', async () => {
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		teardown.add(cleanup)
		const users = db.store('users')
		await users.set([{ id: 'user:1' }, { id: 'user:2' }, { id: 'zzz' }])
		expect((await users.records(rangePrefix('user:'))).map((row) => row.id)).toEqual([
			'user:1',
			'user:2',
		])
		expect(await users.count(rangePrefix('user:'))).toBe(2)
		expect(await users.keys(rangeFromKey('user:2'))).toEqual(['user:2', 'zzz'])
	})

	it('reads a key that continues past U+FFFF after the prefix, and stops before its successor', async () => {
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		teardown.add(cleanup)
		const users = db.store('users')
		await users.set([{ id: 'user:1' }, { id: 'user:\uFFFFmore' }, { id: 'user;' }])
		expect((await users.records(rangePrefix('user:'))).map((row) => row.id)).toEqual([
			'user:1',
			'user:\uFFFFmore',
		])
		expect(await users.count(rangePrefix('user:'))).toBe(2)
	})

	it('reads only the strings for a prefix with no successor, beside an array key and a binary key', async () => {
		const { db, cleanup } = await createTestDatabase({ notes: {} })
		teardown.add(cleanup)
		const notes = db.store('notes')
		await notes.set({ label: 'empty' }, '')
		await notes.set({ label: 'plain' }, 'memo')
		await notes.set({ label: 'top' }, '\uFFFF')
		await notes.set({ label: 'past' }, '\uFFFFmore')
		await notes.set({ label: 'binary' }, new ArrayBuffer(1))
		await notes.set({ label: 'array' }, ['memo'])
		expect((await notes.records(rangePrefix(''))).map((row) => row.label)).toEqual([
			'empty',
			'plain',
			'top',
			'past',
		])
		expect(await notes.count(rangePrefix(''))).toBe(4)
		expect((await notes.records(rangePrefix('\uFFFF'))).map((row) => row.label)).toEqual([
			'top',
			'past',
		])
		expect(await notes.count(rangePrefix('\uFFFF'))).toBe(2)
	})
})

describe('IndexedDBStore — a stored value that is no record', () => {
	it('raises RECORD from get and resolve, naming the store and the key', async () => {
		const books = (await seedNonRecord(teardown, 7310)).store('books')
		expect(await books.get('a')).toEqual({ title: 'Atlas', length: 412 })
		expect(await books.get('missing')).toBeUndefined()
		const got = await books.get('b').catch((error: unknown) => error)
		expect(got).toBeInstanceOf(IndexedDBError)
		expect(errorCode(got)).toBe('RECORD')
		expect(got).toHaveProperty('context', { store: 'books', key: 'b' })
		expect(String(got)).not.toContain('7310')
		const resolved = await books.resolve('b').catch((error: unknown) => error)
		expect(errorCode(resolved)).toBe('RECORD')
		expect(resolved).toHaveProperty('context', { store: 'books', key: 'b' })
		const batch = await books.get(['a', 'b']).catch((error: unknown) => error)
		expect(errorCode(batch)).toBe('RECORD')
		expect(batch).toHaveProperty('context', { store: 'books', key: 'b' })
	})

	it('raises RECORD from records, naming the key the pair reads', async () => {
		const books = (await seedNonRecord(teardown, 7310)).store('books')
		const caught = await books.records().catch((error: unknown) => error)
		expect(errorCode(caught)).toBe('RECORD')
		expect(caught).toHaveProperty('context', { store: 'books', key: 'b' })
		expect(String(caught)).not.toContain('7310')
		expect(await books.records(rangeFromKey('c'))).toEqual([{ title: 'Codex', length: 96 }])
	})

	it('reads the entry through count, has, and keys', async () => {
		const books = (await seedNonRecord(teardown, 7310)).store('books')
		expect(await books.count()).toBe(3)
		expect(await books.has('b')).toBe(true)
		expect(await books.keys()).toEqual(['a', 'b', 'c'])
	})

	it('encodes the key in the message through a capped preview, and keeps the raw key in the context', async () => {
		const { db, cleanup } = await createTestDatabase(SEED_BOOK_STORES)
		teardown.add(cleanup)
		const long = 'k'.repeat(1_000_000)
		const forged = "x); store 'y'"
		await db.write('books', async (transaction) => {
			const native = transaction.store('books').store
			await promisifyRequest(native.put(7310, long))
			await promisifyRequest(native.put(7310, forged))
		})
		const books = db.store('books')
		const lengthy = await books.get(long).catch((error: unknown) => error)
		expect(errorCode(lengthy)).toBe('RECORD')
		expect(isIndexedDBError(lengthy) ? lengthy.message.length : Number.NaN).toBeLessThan(200)
		expect(isIndexedDBError(lengthy) ? lengthy.context : undefined).toEqual({
			store: 'books',
			key: long,
		})
		const quoted = await books.get(forged).catch((error: unknown) => error)
		expect(isIndexedDBError(quoted) ? quoted.message : undefined).toBe(
			`Stored value is not a record (store "books", key "x); store 'y'"); rewrite or remove the entry`,
		)
		expect(quoted).toHaveProperty('context', { store: 'books', key: forged })
	})

	it('still raises DATA for an invalid key', async () => {
		const books = (await seedNonRecord(teardown, 7310)).store('books')
		const caught = await books.get(Number.NaN).catch((error: unknown) => error)
		expect(errorCode(caught)).toBe('DATA')
	})
})

describe('IndexedDBStore — index and cursor access', () => {
	it('reaches a declared index and throws NOT_FOUND for an undeclared one', async () => {
		const { db, cleanup } = await createTestDatabase({
			users: { path: 'id', indexes: [{ name: 'byAge', path: 'age' }] },
		})
		teardown.add(cleanup)
		const users = db.store('users')
		await users.set({ id: 'u1', age: 30 })
		expect(await users.index('byAge').get(30)).toEqual({ id: 'u1', age: 30 })

		const caught = captureError(() => users.index('byNothing'))
		expect(caught).toBeInstanceOf(IndexedDBError)
		expect(errorCode(caught)).toBe('NOT_FOUND')
		expect(isIndexedDBError(caught) ? caught.message : undefined).toBe(
			'Index "byNothing" is not declared on store "users"',
		)
	})

	it('opens a cursor over the store, and null over an empty store', async () => {
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		teardown.add(cleanup)
		const users = db.store('users')
		expect(await users.cursor()).toBeNull()
		await users.set([{ id: 'a' }, { id: 'b' }])
		const seen = await drainCursor(await users.cursor())
		expect(seen.map((cursor) => cursor.value.id)).toEqual(['a', 'b'])
	})
})

describe('IndexedDBStore — requests a bulk read issues', () => {
	it('issues one request for a clean read, and the failing read pairs two more', async () => {
		const db = await seedNonRecord(teardown, 7310)
		const successes = createRecorder<[Event]>()
		const listening = new AbortController()
		db.database.addEventListener('success', successes.handler, {
			capture: true,
			signal: listening.signal,
		})
		const books = db.store('books')
		await books.records(rangeFromKey('c'))
		expect(successes.calls).toHaveLength(1)
		await books.records().catch((error: unknown) => error)
		expect(successes.calls).toHaveLength(4)
		listening.abort()
	})

	it('issues one request for a clean point read, on a store and on an index', async () => {
		const db = await seedNonRecord(teardown, 7310)
		const successes = createRecorder<[Event]>()
		const listening = new AbortController()
		db.database.addEventListener('success', successes.handler, {
			capture: true,
			signal: listening.signal,
		})
		expect(await db.store('books').get('a')).toEqual({ title: 'Atlas', length: 412 })
		expect(successes.calls).toHaveLength(1)
		expect(await db.store('books').index('byLength').get(96)).toEqual({
			title: 'Codex',
			length: 96,
		})
		expect(successes.calls).toHaveLength(2)
		listening.abort()
	})
})
