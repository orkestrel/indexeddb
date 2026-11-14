import {
	IndexedDBError,
	isIndexedDBError,
	promisifyRequest,
	rangeAboveKey,
	rangeFromKey,
} from '@src/browser'
import { afterEach, describe, expect, it } from 'vitest'
import { createTeardown } from '@orkestrel/test'
import {
	createTestDatabase,
	drainCursor,
	errorCode,
	SEED_BOOK_STORES,
	seedNonRecord,
	seedUsers,
} from '../../setupBrowser.js'

// `IndexedDBIndexInterface` in real Chromium, reached through
// `store.index(name)` over a store declaring a secondary index: the metadata
// getters (`name` / `path` / `unique` / `multiple`), the read surface
// (`get` / `resolve` / `records` / `keys` / `primary` / `has` / `count` /
// `cursor`) with its array-first batch overloads, the unique-index point lookup
// and constraint, the `multiple` (multiEntry) array index, and the `NOT_FOUND` / `RECORD`
// faults. Each test opens a uniquely-named database through the shared opener.

const teardown = createTeardown()

afterEach(teardown.destroy)

// The `users` seed (non-unique `byAge` + unique `byEmail`, ages 20/30/40) lives in
// `setupBrowser.ts` (`.claude/rules/tests.md` § Shared test infrastructure);
// each call adds its cleanup to this file's
// `teardown` list.
describe('IndexedDBIndex — metadata', () => {
	it('reports its declared name, path, and flags', async () => {
		const db = await seedUsers(teardown)
		const byAge = db.store('users').index('byAge')
		expect(byAge.name).toBe('byAge')
		expect(byAge.path).toBe('age')
		expect(byAge.unique).toBe(false)
		expect(byAge.multiple).toBe(false)

		const byEmail = db.store('users').index('byEmail')
		expect(byEmail.unique).toBe(true)
	})
})

describe('IndexedDBIndex — reads by index key', () => {
	it('get returns the first record for an index key; a miss is undefined', async () => {
		const db = await seedUsers(teardown)
		const byAge = db.store('users').index('byAge')
		expect(await byAge.get(30)).toEqual({
			id: 'b',
			age: 30,
			email: 'b@x.io',
		})
		expect(await byAge.get(99)).toBeUndefined()
		expect(await byAge.has(30)).toBe(true)
		expect(await byAge.has(99)).toBe(false)
	})

	it('resolve throws NOT_FOUND on a miss', async () => {
		const db = await seedUsers(teardown)
		const byAge = db.store('users').index('byAge')
		expect(await byAge.resolve(40)).toEqual({
			id: 'c',
			age: 40,
			email: 'c@x.io',
		})
		const caught = await byAge.resolve(99).catch((error: unknown) => error)
		expect(caught).toBeInstanceOf(IndexedDBError)
		expect(errorCode(caught)).toBe('NOT_FOUND')
	})

	it('resolve writes a missing key through a capped preview, and keeps the raw key in the context', async () => {
		const db = await seedUsers(teardown)
		const byEmail = db.store('users').index('byEmail')
		const long = 'k'.repeat(1_000_000)
		const lengthy = await byEmail.resolve(long).catch((error: unknown) => error)
		expect(errorCode(lengthy)).toBe('NOT_FOUND')
		expect(isIndexedDBError(lengthy) ? lengthy.message.length : Number.NaN).toBeLessThan(200)
		expect(isIndexedDBError(lengthy) ? lengthy.context : undefined).toEqual({
			store: 'users',
			index: 'byEmail',
			key: long,
		})
		const forged = await byEmail.resolve("x); store 'y'").catch((error: unknown) => error)
		expect(isIndexedDBError(forged) ? forged.message : undefined).toBe(
			`No record in index "byEmail" of store "users" for key "x); store 'y'"`,
		)
		expect(forged).toHaveProperty('context', {
			store: 'users',
			index: 'byEmail',
			key: "x); store 'y'",
		})
	})

	it('primary maps an index key to one primary key', async () => {
		const db = await seedUsers(teardown)
		const byEmail = db.store('users').index('byEmail')
		expect(await byEmail.primary('c@x.io')).toBe('c')
		expect(await byEmail.primary('nope@x.io')).toBeUndefined()
	})

	it('batches get / has / resolve by the array overload', async () => {
		const db = await seedUsers(teardown)
		const byAge = db.store('users').index('byAge')
		expect((await byAge.get([20, 99, 40])).map((row) => row?.id)).toEqual(['a', undefined, 'c'])
		expect(await byAge.has([20, 99])).toEqual([true, false])
		expect((await byAge.resolve([20, 40])).map((row) => row.id)).toEqual(['a', 'c'])
	})
})

describe('IndexedDBIndex — key ranges', () => {
	it('reads matching records over a key range, in index order', async () => {
		const db = await seedUsers(teardown)
		const byAge = db.store('users').index('byAge')
		expect((await byAge.records(rangeFromKey(30))).map((row) => row.id)).toEqual(['b', 'c'])
		expect((await byAge.records(IDBKeyRange.bound(25, 45))).map((row) => row.id)).toEqual([
			'b',
			'c',
		])
		expect(await byAge.count(rangeAboveKey(20))).toBe(2)
		expect(await byAge.count()).toBe(3)
	})

	it('keys returns the matching records PRIMARY keys, not the index keys', async () => {
		const db = await seedUsers(teardown)
		const byAge = db.store('users').index('byAge')
		// Index keys are ages; `keys` yields the primary keys of the matches in
		// index order — proving the index → primary mapping, not the index values.
		expect(await byAge.keys(rangeFromKey(30))).toEqual(['b', 'c'])
		expect(await byAge.keys()).toEqual(['a', 'b', 'c'])
	})
})

describe('IndexedDBIndex — unique constraint', () => {
	it('rejects a duplicate value on a unique index with CONSTRAINT', async () => {
		const { db, cleanup } = await createTestDatabase({
			users: {
				path: 'id',
				indexes: [{ name: 'byEmail', path: 'email', unique: true }],
			},
		})
		teardown.add(cleanup)
		const users = db.store('users')
		await users.set({ id: 'a', email: 'dup@x.io' })
		const caught = await users.set({ id: 'b', email: 'dup@x.io' }).catch((error: unknown) => error)
		expect(caught).toBeInstanceOf(IndexedDBError)
		expect(errorCode(caught)).toBe('CONSTRAINT')
	})
})

describe('IndexedDBIndex — multiEntry (multiple)', () => {
	it('indexes each element of an array value separately', async () => {
		const { db, cleanup } = await createTestDatabase({
			posts: {
				path: 'id',
				indexes: [{ name: 'byTag', path: 'tags', multiple: true }],
			},
		})
		teardown.add(cleanup)
		const posts = db.store('posts')
		const byTag = posts.index('byTag')
		expect(byTag.multiple).toBe(true)
		await posts.set([
			{ id: 'p1', tags: ['ts', 'idb'] },
			{ id: 'p2', tags: ['idb', 'browser'] },
			{ id: 'p3', tags: ['ts'] },
		])
		// Each array element is its own index entry, so a single-tag lookup spans
		// every post carrying it.
		expect((await byTag.records('ts')).map((row) => row.id)).toEqual(['p1', 'p3'])
		expect((await byTag.records('idb')).map((row) => row.id)).toEqual(['p1', 'p2'])
		expect(await byTag.count('idb')).toBe(2)
	})
})

describe('IndexedDBIndex — cursor', () => {
	it('streams matches in index order, and null over no matches', async () => {
		const db = await seedUsers(teardown)
		const byAge = db.store('users').index('byAge')
		const seen = await drainCursor(await byAge.cursor())
		// Cursor walks in index (age) order — here it matches id order, but the
		// `key` is the index value and `primary` the primary key.
		expect(seen.map((cursor) => cursor.value.id)).toEqual(['a', 'b', 'c'])
		expect(seen.map((cursor) => cursor.key)).toEqual([20, 30, 40])
		expect(seen.map((cursor) => cursor.primary)).toEqual(['a', 'b', 'c'])

		expect(await byAge.cursor({ query: rangeAboveKey(40) })).toBeNull()
	})
})

describe('IndexedDBIndex — a stored value that is no record', () => {
	it('raises RECORD from get, resolve, and records, naming the store, the index, and the primary key the pair reads', async () => {
		const byLength = (await seedNonRecord(teardown, 'xyz')).store('books').index('byLength')
		expect(await byLength.get(96)).toEqual({ title: 'Codex', length: 96 })
		const got = await byLength.get(3).catch((error: unknown) => error)
		expect(got).toBeInstanceOf(IndexedDBError)
		expect(errorCode(got)).toBe('RECORD')
		expect(got).toHaveProperty('context', { store: 'books', index: 'byLength', key: 'b' })
		expect(String(got)).not.toContain('xyz')
		const resolved = await byLength.resolve(3).catch((error: unknown) => error)
		expect(errorCode(resolved)).toBe('RECORD')
		expect(resolved).toHaveProperty('context', { store: 'books', index: 'byLength', key: 'b' })
		const bulk = await byLength.records().catch((error: unknown) => error)
		expect(errorCode(bulk)).toBe('RECORD')
		expect(bulk).toHaveProperty('context', { store: 'books', index: 'byLength', key: 'b' })
		expect(await byLength.records(rangeAboveKey(3))).toEqual([
			{ title: 'Codex', length: 96 },
			{ title: 'Atlas', length: 412 },
		])
	})

	it('reads the entry through count, has, keys, and primary', async () => {
		const byLength = (await seedNonRecord(teardown, 'xyz')).store('books').index('byLength')
		expect(await byLength.count()).toBe(3)
		expect(await byLength.has(3)).toBe(true)
		expect(await byLength.keys()).toEqual(['b', 'c', 'a'])
		expect(await byLength.primary(3)).toBe('b')
	})
})

describe('IndexedDBIndex — the primary key a failing read names under repeated index keys', () => {
	it('names the primary key that holds the value, among rows sharing its index key', async () => {
		const { db, cleanup } = await createTestDatabase(SEED_BOOK_STORES)
		teardown.add(cleanup)
		await db.write('books', async (transaction) => {
			const native = transaction.store('books').store
			await promisifyRequest(native.put({ title: 'Ode', length: 3 }, 'a'))
			await promisifyRequest(native.put('xyz', 'b'))
			await promisifyRequest(native.put({ title: 'Saga', length: 3 }, 'c'))
			await promisifyRequest(native.put('wxyz', 'd'))
		})
		const byLength = db.store('books').index('byLength')
		const bulk = await byLength.records(3).catch((error: unknown) => error)
		expect(errorCode(bulk)).toBe('RECORD')
		expect(bulk).toHaveProperty('context', { store: 'books', index: 'byLength', key: 'b' })
		expect(await byLength.get(3)).toEqual({ title: 'Ode', length: 3 })
		const point = await byLength.get(4).catch((error: unknown) => error)
		expect(errorCode(point)).toBe('RECORD')
		expect(point).toHaveProperty('context', { store: 'books', index: 'byLength', key: 'd' })
		expect(String(point)).not.toContain('wxyz')
	})
})
