import { IndexedDBError, range } from '@src/browser'
import { afterEach, describe, expect, it } from 'vitest'
import {
	createCleanups,
	createTestDatabase,
	drainCursor,
	errorCode,
	seedUsers,
} from '../../setupBrowser.js'

// `IndexedDBIndexInterface` in real Chromium, reached through
// `store.index(name)` over a store declaring a secondary index: the metadata
// getters (`name` / `path` / `unique` / `multiple`), the read surface
// (`get` / `resolve` / `records` / `keys` / `primary` / `has` / `count` /
// `cursor`) with its array-first batch overloads, the unique-index point lookup
// and constraint, the `multiple` (multiEntry) array index, and the `NOT_FOUND`
// fault. Each test opens a uniquely-named database through the shared opener.

const cleanups = createCleanups()

afterEach(cleanups.run)

// The `users` seed (non-unique `byAge` + unique `byEmail`, ages 20/30/40) lives in
// `setupBrowser.ts` (§16.1); each call registers its cleanup with this file's
// teardown via the `cleanups` registrar.
const seed = (): ReturnType<typeof seedUsers> => seedUsers(cleanups.push)

describe('IndexedDBIndex — metadata', () => {
	it('reports its declared name, path, and flags', async () => {
		const db = await seed()
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
		const db = await seed()
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
		const db = await seed()
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

	it('primary maps an index key to one primary key', async () => {
		const db = await seed()
		const byEmail = db.store('users').index('byEmail')
		expect(await byEmail.primary('c@x.io')).toBe('c')
		expect(await byEmail.primary('nope@x.io')).toBeUndefined()
	})

	it('batches get / has / resolve by the array overload', async () => {
		const db = await seed()
		const byAge = db.store('users').index('byAge')
		expect((await byAge.get([20, 99, 40])).map((row) => row?.id)).toEqual(['a', undefined, 'c'])
		expect(await byAge.has([20, 99])).toEqual([true, false])
		expect((await byAge.resolve([20, 40])).map((row) => row.id)).toEqual(['a', 'c'])
	})
})

describe('IndexedDBIndex — key ranges', () => {
	it('reads matching records over a key range, in index order', async () => {
		const db = await seed()
		const byAge = db.store('users').index('byAge')
		expect((await byAge.records(range.from(30))).map((row) => row.id)).toEqual(['b', 'c'])
		expect((await byAge.records(range.between(25, 45))).map((row) => row.id)).toEqual(['b', 'c'])
		expect(await byAge.count(range.above(20))).toBe(2)
		expect(await byAge.count()).toBe(3)
	})

	it('keys returns the matching records PRIMARY keys, not the index keys', async () => {
		const db = await seed()
		const byAge = db.store('users').index('byAge')
		// Index keys are ages; `keys` yields the primary keys of the matches in
		// index order — proving the index → primary mapping, not the index values.
		expect(await byAge.keys(range.from(30))).toEqual(['b', 'c'])
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
		cleanups.push(cleanup)
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
		cleanups.push(cleanup)
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
		const db = await seed()
		const byAge = db.store('users').index('byAge')
		const seen = await drainCursor(await byAge.cursor())
		// Cursor walks in index (age) order — here it matches id order, but the
		// `key` is the index value and `primary` the primary key.
		expect(seen.map((cursor) => cursor.value.id)).toEqual(['a', 'b', 'c'])
		expect(seen.map((cursor) => cursor.key)).toEqual([20, 30, 40])
		expect(seen.map((cursor) => cursor.primary)).toEqual(['a', 'b', 'c'])

		expect(await byAge.cursor({ query: range.above(40) })).toBeNull()
	})
})
