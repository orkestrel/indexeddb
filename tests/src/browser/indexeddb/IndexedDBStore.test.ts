import { IndexedDBError, range } from '@src/browser'
import { afterEach, describe, expect, it } from 'vitest'
import { captureError } from '../../../setup.js'
import {
	createCleanups,
	createTestDatabase,
	drainCursor,
	errorCode,
} from '../../../setupBrowser.js'

// `IndexedDBStoreInterface` in real Chromium, reached through `db.store(name)`:
// the metadata getters (`name` / `path` / `indexes` / `increment`), the full
// keyed CRUD surface with its array-first batch overloads, key-range reads,
// `index` / `cursor` access, and the `NOT_FOUND` / `CONSTRAINT` faults. Each
// test opens a uniquely-named database through the shared opener and disposes it
// afterwards. (Index- and cursor-specific behavior is pinned in their own files;
// here we exercise the store as the access point.)

const cleanups = createCleanups()

afterEach(cleanups.run)

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
		cleanups.push(cleanup)
		const users = db.store('users')
		expect(users.name).toBe('users')
		expect(users.path).toBe('id')
		expect([...users.indexes].sort()).toEqual(['byAge', 'byEmail'])
		expect(users.increment).toBe(false)

		const events = db.store('events')
		expect(events.path).toBeNull()
		expect(events.indexes).toEqual([])
		expect(events.increment).toBe(true)
	})

	it('exposes a compound key path verbatim', async () => {
		const { db, cleanup } = await createTestDatabase({
			parts: { path: ['make', 'model'] },
		})
		cleanups.push(cleanup)
		expect(db.store('parts').path).toEqual(['make', 'model'])
	})
})

describe('IndexedDBStore — keyed CRUD', () => {
	it('round-trips a record; misses read as undefined / false / empty', async () => {
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		cleanups.push(cleanup)
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
		cleanups.push(cleanup)
		const users = db.store('users')
		await users.set({ id: 'u1' })
		expect(await users.resolve('u1')).toEqual({ id: 'u1' })
		const caught = await users.resolve('nope').catch((error: unknown) => error)
		expect(caught).toBeInstanceOf(IndexedDBError)
		expect(errorCode(caught)).toBe('NOT_FOUND')
	})

	it('set upserts (overwrites) while add rejects a duplicate with CONSTRAINT', async () => {
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		cleanups.push(cleanup)
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

	it('lists keys and records in key order, caps with count, and clears', async () => {
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		cleanups.push(cleanup)
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
		cleanups.push(cleanup)
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
		cleanups.push(cleanup)
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
		cleanups.push(cleanup)
		const events = db.store('events')
		expect(events.path).toBeNull()
		await events.set({ type: 'click' }, 'e1')
		expect(await events.get('e1')).toEqual({ type: 'click' })
	})

	it('auto-increments out-of-line keys when increment is set', async () => {
		const { db, cleanup } = await createTestDatabase({ log: { increment: true } })
		cleanups.push(cleanup)
		const log = db.store('log')
		const k1 = await log.set({ msg: 'first' })
		const k2 = await log.set({ msg: 'second' })
		expect(k1).toBe(1)
		expect(k2).toBe(2)
		expect(await log.get(1)).toEqual({ msg: 'first' })
		expect(await log.keys()).toEqual([1, 2])
	})

	it('reads a single compound key via range.only', async () => {
		const { db, cleanup } = await createTestDatabase({ parts: { path: ['make', 'model'] } })
		cleanups.push(cleanup)
		const parts = db.store('parts')
		await parts.set([
			{ make: 'acme', model: 'a', stock: 1 },
			{ make: 'acme', model: 'b', stock: 2 },
		])
		expect(await parts.records(range.only(['acme', 'b']))).toEqual([
			{ make: 'acme', model: 'b', stock: 2 },
		])
		expect(await parts.count(range.only(['acme', 'b']))).toBe(1)
	})
})

describe('IndexedDBStore — key-range reads', () => {
	it('reads and counts over a primary-key range', async () => {
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		cleanups.push(cleanup)
		const users = db.store('users')
		await users.set([{ id: 'user:1' }, { id: 'user:2' }, { id: 'zzz' }])
		expect((await users.records(range.prefix('user:'))).map((row) => row.id)).toEqual([
			'user:1',
			'user:2',
		])
		expect(await users.count(range.prefix('user:'))).toBe(2)
		expect(await users.keys(range.from('user:2'))).toEqual(['user:2', 'zzz'])
	})
})

describe('IndexedDBStore — index and cursor access', () => {
	it('reaches a declared index and throws NOT_FOUND for an undeclared one', async () => {
		const { db, cleanup } = await createTestDatabase({
			users: { path: 'id', indexes: [{ name: 'byAge', path: 'age' }] },
		})
		cleanups.push(cleanup)
		const users = db.store('users')
		await users.set({ id: 'u1', age: 30 })
		expect(await users.index('byAge').get(30)).toEqual({ id: 'u1', age: 30 })

		const caught = captureError(() => users.index('byNothing'))
		expect(caught).toBeInstanceOf(IndexedDBError)
		expect(errorCode(caught)).toBe('NOT_FOUND')
	})

	it('opens a cursor over the store, and null over an empty store', async () => {
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		cleanups.push(cleanup)
		const users = db.store('users')
		expect(await users.cursor()).toBeNull()
		await users.set([{ id: 'a' }, { id: 'b' }])
		const seen = await drainCursor(await users.cursor())
		expect(seen.map((cursor) => cursor.value.id)).toEqual(['a', 'b'])
	})
})
