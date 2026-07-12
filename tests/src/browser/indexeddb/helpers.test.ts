import {
	hasKey,
	IndexedDBError,
	promisifyRequest,
	promisifyTransaction,
	range,
	readRecord,
	readRecords,
	wrapError,
} from '@src/browser'
import { afterEach, describe, expect, it } from 'vitest'
import { createCleanups, createTestDatabase, errorCode } from '../../../setupBrowser.js'

// The wrapper's exported helpers (`src/browser/indexeddb/helpers.ts`) in real
// Chromium: the `range` key-range builders asserted on the `IDBKeyRange` bounds
// they return, the shared read primitives (`readRecord` / `readRecords` /
// `hasKey`) over a real `IDBObjectStore` / `IDBIndex` reached through a
// transaction scope — including the `isRecord` boundary that narrows a
// non-record clone away — the two Promise bridges (`promisifyRequest` /
// `promisifyTransaction`) against real requests, both success and the
// `IndexedDBError`-wrapped rejection, and `wrapError` mapping a real
// `DOMException` (and a `null`) to the right `IndexedDBError` code. Each
// store-backed test opens a uniquely-named database through the shared opener.

const cleanups = createCleanups()

afterEach(cleanups.run)

describe('range — key-range builders', () => {
	it('only is a single-value, fully-closed bound', () => {
		const only = range.only(5)
		expect(only.lower).toBe(5)
		expect(only.upper).toBe(5)
		expect(only.lowerOpen).toBe(false)
		expect(only.upperOpen).toBe(false)
		expect(only.includes(5)).toBe(true)
		expect(only.includes(6)).toBe(false)
	})

	it('above / from are lower bounds (exclusive / inclusive)', () => {
		const above = range.above(10)
		expect(above.lower).toBe(10)
		expect(above.lowerOpen).toBe(true)
		expect(above.upper).toBeUndefined()
		expect(above.includes(10)).toBe(false)
		expect(above.includes(11)).toBe(true)

		const from = range.from(10)
		expect(from.lower).toBe(10)
		expect(from.lowerOpen).toBe(false)
		expect(from.includes(10)).toBe(true)
	})

	it('below / to are upper bounds (exclusive / inclusive)', () => {
		const below = range.below(10)
		expect(below.upper).toBe(10)
		expect(below.upperOpen).toBe(true)
		expect(below.lower).toBeUndefined()
		expect(below.includes(10)).toBe(false)
		expect(below.includes(9)).toBe(true)

		const to = range.to(10)
		expect(to.upper).toBe(10)
		expect(to.upperOpen).toBe(false)
		expect(to.includes(10)).toBe(true)
	})

	it('between is a closed range by default, with optional open ends', () => {
		const closed = range.between(1, 5)
		expect(closed.lower).toBe(1)
		expect(closed.upper).toBe(5)
		expect(closed.lowerOpen).toBe(false)
		expect(closed.upperOpen).toBe(false)
		expect(closed.includes(1)).toBe(true)
		expect(closed.includes(5)).toBe(true)

		const open = range.between(1, 5, { lowerOpen: true, upperOpen: true })
		expect(open.lowerOpen).toBe(true)
		expect(open.upperOpen).toBe(true)
		expect(open.includes(1)).toBe(false)
		expect(open.includes(5)).toBe(false)
		expect(open.includes(3)).toBe(true)
	})

	it('prefix bounds every string with the prefix', () => {
		const prefix = range.prefix('user:')
		expect(prefix.lower).toBe('user:')
		expect(prefix.lowerOpen).toBe(false)
		expect(prefix.upperOpen).toBe(false)
		expect(prefix.includes('user:')).toBe(true)
		expect(prefix.includes('user:1')).toBe(true)
		expect(prefix.includes('user:zzz')).toBe(true)
		expect(prefix.includes('uses')).toBe(false)
		expect(prefix.includes('usep')).toBe(false)
	})
})

describe('readRecord / readRecords / hasKey — over a real store', () => {
	it('readRecord returns a record, and narrows a non-record clone to undefined', async () => {
		const { db, cleanup } = await createTestDatabase({ store: {} })
		cleanups.push(cleanup)
		await db.write('store', async (tx) => {
			const native = tx.store('store').store
			await promisifyRequest(native.put({ id: 'r1' }, 'r1'))
			await promisifyRequest(native.put(42, 'primitive')) // a non-record clone
		})
		await db.read('store', async (tx) => {
			const native = tx.store('store').store
			expect(await readRecord(native, 'r1')).toEqual({ id: 'r1' })
			expect(await readRecord(native, 'primitive')).toBeUndefined()
			expect(await readRecord(native, 'missing')).toBeUndefined()
		})
	})

	it('readRecords keeps only records and honours a key range and count', async () => {
		const { db, cleanup } = await createTestDatabase({ store: {} })
		cleanups.push(cleanup)
		await db.write('store', async (tx) => {
			const native = tx.store('store').store
			await promisifyRequest(native.put({ id: 'a' }, 'a'))
			await promisifyRequest(native.put(7, 'b')) // a non-record clone, dropped
			await promisifyRequest(native.put({ id: 'c' }, 'c'))
		})
		await db.read('store', async (tx) => {
			const native = tx.store('store').store
			expect(await readRecords(native)).toEqual([{ id: 'a' }, { id: 'c' }])
			expect(await readRecords(native, undefined, 1)).toEqual([{ id: 'a' }])
			expect(await readRecords(native, range.from('c'))).toEqual([{ id: 'c' }])
		})
	})

	it('readRecord and readRecords work over an index', async () => {
		const { db, cleanup } = await createTestDatabase({
			users: { path: 'id', indexes: [{ name: 'byAge', path: 'age' }] },
		})
		cleanups.push(cleanup)
		await db.store('users').set([
			{ id: 'a', age: 20 },
			{ id: 'b', age: 30 },
		])
		await db.read('users', async (tx) => {
			const index = tx.store('users').store.index('byAge')
			expect(await readRecord(index, 30)).toEqual({ id: 'b', age: 30 })
			expect((await readRecords(index)).map((row) => row.id)).toEqual(['a', 'b'])
		})
	})

	it('hasKey reports presence by a native count', async () => {
		const { db, cleanup } = await createTestDatabase({ store: {} })
		cleanups.push(cleanup)
		await db.write('store', async (tx) => {
			await promisifyRequest(tx.store('store').store.put({ id: 'x' }, 'x'))
		})
		await db.read('store', async (tx) => {
			const native = tx.store('store').store
			expect(await hasKey(native, 'x')).toBe(true)
			expect(await hasKey(native, 'nope')).toBe(false)
		})
	})
})

describe('promisifyRequest — IDBRequest bridge', () => {
	it('resolves to the request result on success', async () => {
		const { db, cleanup } = await createTestDatabase({ store: { path: 'id' } })
		cleanups.push(cleanup)
		await db.write('store', async (tx) => {
			const native = tx.store('store').store
			const key = await promisifyRequest(native.add({ id: 'u1' }))
			expect(key).toBe('u1')
			expect(await promisifyRequest(native.count())).toBe(1)
			const got = await promisifyRequest(native.get('u1'))
			expect(got).toEqual({ id: 'u1' })
		})
	})

	it('rejects with an IndexedDBError carrying the mapped code', async () => {
		const { db, cleanup } = await createTestDatabase({ store: { path: 'id' } })
		cleanups.push(cleanup)
		await db.store('store').set({ id: 'u1' })
		let caught: unknown
		await db
			.write('store', async (tx) => {
				// A duplicate `add` faults with a native ConstraintError, which the
				// bridge wraps as an IndexedDBError(code: 'CONSTRAINT').
				caught = await promisifyRequest(tx.store('store').store.add({ id: 'u1' })).catch(
					(error: unknown) => error,
				)
			})
			.catch(() => {})
		expect(caught).toBeInstanceOf(IndexedDBError)
		expect(errorCode(caught)).toBe('CONSTRAINT')
	})
})

describe('promisifyTransaction — IDBTransaction bridge', () => {
	it('resolves once the transaction commits, making writes durable', async () => {
		const { db, cleanup } = await createTestDatabase({ store: { path: 'id' } })
		cleanups.push(cleanup)
		const native = db.database.transaction(['store'], 'readwrite')
		const store = native.objectStore('store')
		await promisifyRequest(store.add({ id: 'u1', name: 'Ada' }))
		await promisifyTransaction(native)
		// After the commit resolves, a fresh read sees the row.
		expect(await db.store('store').get('u1')).toEqual({ id: 'u1', name: 'Ada' })
	})

	it('rejects when the transaction aborts', async () => {
		const { db, cleanup } = await createTestDatabase({ store: { path: 'id' } })
		cleanups.push(cleanup)
		const native = db.database.transaction(['store'], 'readwrite')
		const store = native.objectStore('store')
		await promisifyRequest(store.add({ id: 'u1' }))
		const pending = promisifyTransaction(native)
		native.abort()
		const caught = await pending.catch((error: unknown) => error)
		expect(caught).toBeInstanceOf(IndexedDBError)
		// The aborted write left nothing behind.
		expect(await db.store('store').get('u1')).toBeUndefined()
	})
})

describe('wrapError — DOMException → IndexedDBError', () => {
	it('maps a known DOMException.name to its code, keeping the message and cause', () => {
		const native = new DOMException('unique key already exists', 'ConstraintError')
		const wrapped = wrapError(native)
		expect(wrapped).toBeInstanceOf(IndexedDBError)
		expect(wrapped.code).toBe('CONSTRAINT')
		expect(wrapped.message).toBe('unique key already exists')
		expect(wrapped.cause).toBe(native)
	})

	it('maps each other known name to its code', () => {
		expect(wrapError(new DOMException('', 'QuotaExceededError')).code).toBe('QUOTA')
		expect(wrapError(new DOMException('', 'AbortError')).code).toBe('ABORTED')
		expect(wrapError(new DOMException('', 'NotFoundError')).code).toBe('NOT_FOUND')
		expect(wrapError(new DOMException('', 'DataError')).code).toBe('DATA')
		expect(wrapError(new DOMException('', 'VersionError')).code).toBe('UPGRADE')
	})

	it('falls back to UNKNOWN for an unmapped name, synthesizing a message', () => {
		const wrapped = wrapError(new DOMException('', 'TypeMismatchError'))
		expect(wrapped.code).toBe('UNKNOWN')
		expect(wrapped.message).toBe('IndexedDB error: TypeMismatchError')
	})

	it('falls back to UNKNOWN with a generic message for a null error', () => {
		const wrapped = wrapError(null)
		expect(wrapped).toBeInstanceOf(IndexedDBError)
		expect(wrapped.code).toBe('UNKNOWN')
		expect(wrapped.message).toBe('Unknown IndexedDB error')
		expect(wrapped.cause).toBeUndefined()
	})
})
