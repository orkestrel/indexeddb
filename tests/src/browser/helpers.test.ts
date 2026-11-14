import type { StoreRecord } from '@src/browser'
import {
	createIndex,
	hasKey,
	IndexedDBError,
	isIndexedDBError,
	promisifyRequest,
	promisifyTransaction,
	rangeAboveKey,
	rangeBelowKey,
	rangeFromKey,
	rangePrefix,
	rangeToKey,
	readRecord,
	readRecords,
	scanIndex,
	supportsIndexedDB,
	wrapCall,
	wrapDOMException,
} from '@src/browser'
import { afterEach, describe, expect, it } from 'vitest'
import { INTRINSICS, isObject } from '@orkestrel/contract'
import { captureError, createTeardown } from '@orkestrel/test'
import {
	createTestDatabase,
	dropDatabase,
	errorCode,
	MESSAGE_NAMES,
	mintDatabase,
	seedNonRecord,
} from '../../setupBrowser.js'

// The browser surface's helpers (`src/browser/helpers.ts`), exercised in real
// Chromium: the feature probe `supportsIndexedDB` (the entry gate a consumer
// runs before entering the rest of this module), the key-range builders
// asserted on the `IDBKeyRange` bounds they return, the shared read primitives
// (`readRecord` / `readRecords` / `hasKey`) over a real `IDBObjectStore` /
// `IDBIndex` reached through a transaction scope — including the `RECORD` raise
// for a stored value that is no record — the two Promise bridges
// (`promisifyRequest` / `promisifyTransaction`) against real requests, both
// success and the `IndexedDBError`-wrapped rejection, `wrapCall` over each of
// the three paths it can take (a returned value, a thrown `DOMException`, and a
// throw of anything else), the `context` an `IndexedDBError` carries beside its
// `code`, and `wrapDOMException` mapping a real `DOMException` (and a `null`) to the
// right `IndexedDBError` code. Each store-backed test opens a uniquely-named
// database through the shared opener.

describe('src/browser environment', () => {
	it('runs in a real browser with a DOM and IndexedDB', () => {
		expect(isObject(document)).toBe(true)
		expect(isObject(globalThis.indexedDB)).toBe(true)
	})

	it('supportsIndexedDB reports true in the browser', () => {
		expect(supportsIndexedDB()).toBe(true)
	})

	it('supportsIndexedDB reports false while indexedDB reads null, and restores the global', () => {
		const own = INTRINSICS.describe(globalThis, 'indexedDB')
		INTRINSICS.define(globalThis, 'indexedDB', { value: null, configurable: true })
		try {
			expect(supportsIndexedDB()).toBe(false)
		} finally {
			if (own === undefined) Reflect.deleteProperty(globalThis, 'indexedDB')
			else INTRINSICS.define(globalThis, 'indexedDB', own)
		}
		expect(supportsIndexedDB()).toBe(true)
	})
})

const teardown = createTeardown()

afterEach(teardown.destroy)

describe('key-range builders', () => {
	it('above / from are lower bounds (exclusive / inclusive)', () => {
		const above = rangeAboveKey(10)
		expect(above.lower).toBe(10)
		expect(above.lowerOpen).toBe(true)
		expect(above.upper).toBeUndefined()
		expect(above.includes(10)).toBe(false)
		expect(above.includes(11)).toBe(true)

		const from = rangeFromKey(10)
		expect(from.lower).toBe(10)
		expect(from.lowerOpen).toBe(false)
		expect(from.includes(10)).toBe(true)
	})

	it('below / to are upper bounds (exclusive / inclusive)', () => {
		const below = rangeBelowKey(10)
		expect(below.upper).toBe(10)
		expect(below.upperOpen).toBe(true)
		expect(below.lower).toBeUndefined()
		expect(below.includes(10)).toBe(false)
		expect(below.includes(9)).toBe(true)

		const to = rangeToKey(10)
		expect(to.upper).toBe(10)
		expect(to.upperOpen).toBe(false)
		expect(to.includes(10)).toBe(true)
	})

	it('prefix closes at the successor of the prefix, exclusive', () => {
		const prefix = rangePrefix('user:')
		expect(prefix.lower).toBe('user:')
		expect(prefix.lowerOpen).toBe(false)
		expect(prefix.upper).toBe('user;')
		expect(prefix.upperOpen).toBe(true)
		expect(prefix.includes('user:')).toBe(true)
		expect(prefix.includes('user:1')).toBe(true)
		expect(prefix.includes('user:zzz')).toBe(true)
		expect(prefix.includes('user:\uFFFF')).toBe(true)
		expect(prefix.includes('user:\uFFFF\uFFFFmore')).toBe(true)
		expect(prefix.includes('user;')).toBe(false)
		expect(prefix.includes('uses')).toBe(false)
		expect(prefix.includes('user')).toBe(false)
	})

	it('prefix drops trailing U+FFFF code units before it increments', () => {
		const prefix = rangePrefix('a\uFFFF\uFFFF')
		expect(prefix.lower).toBe('a\uFFFF\uFFFF')
		expect(prefix.upper).toBe('b')
		expect(prefix.upperOpen).toBe(true)
		expect(prefix.includes('a\uFFFF\uFFFF')).toBe(true)
		expect(prefix.includes('a\uFFFF\uFFFFz')).toBe(true)
		expect(prefix.includes('a\uFFFF\uFFFE')).toBe(false)
		expect(prefix.includes('b')).toBe(false)
	})

	it('prefix with no successor closes below every binary key, so no array or binary key enters', () => {
		const empty = rangePrefix('')
		expect(empty.lower).toBe('')
		expect(empty.lowerOpen).toBe(false)
		expect(empty.upper).toBeInstanceOf(ArrayBuffer)
		expect(empty.upperOpen).toBe(true)
		expect(empty.includes('')).toBe(true)
		expect(empty.includes('\uFFFF\uFFFF')).toBe(true)
		expect(empty.includes(new ArrayBuffer(0))).toBe(false)
		expect(empty.includes([1])).toBe(false)
		expect(empty.includes(1)).toBe(false)

		const top = rangePrefix('\uFFFF')
		expect(top.lower).toBe('\uFFFF')
		expect(top.upper).toBeInstanceOf(ArrayBuffer)
		expect(top.upperOpen).toBe(true)
		expect(top.includes('\uFFFF')).toBe(true)
		expect(top.includes('\uFFFF\uFFFFmore')).toBe(true)
		expect(top.includes('\uFFFE')).toBe(false)
		expect(top.includes(new ArrayBuffer(1))).toBe(false)
		expect(top.includes(['x'])).toBe(false)
	})
})

describe('readRecord / readRecords / hasKey — over a real store', () => {
	it('readRecord returns a record, undefined on a miss, and raises RECORD for a non-record', async () => {
		const db = await seedNonRecord(teardown, 7310)
		await db.read('books', async (transaction) => {
			const native = transaction.store('books').store
			expect(await readRecord(native, 'a')).toEqual({ title: 'Atlas', length: 412 })
			expect(await readRecord(native, 'missing')).toBeUndefined()
			const caught = await readRecord(native, 'b').catch((error: unknown) => error)
			expect(caught).toBeInstanceOf(IndexedDBError)
			expect(errorCode(caught)).toBe('RECORD')
			expect(caught).toHaveProperty('context', { store: 'books', key: 'b' })
			expect(String(caught)).not.toContain('7310')
		})
	})

	it('readRecord reads back the StoreRecord a store wrote, as a structured clone', async () => {
		const record: StoreRecord = { id: 'r1', tags: ['admin'], profile: { age: 36 } }
		const { db, cleanup } = await createTestDatabase({ store: { path: 'id' } })
		teardown.add(cleanup)
		await db.store('store').set(record)
		await db.read('store', async (transaction) => {
			const read: StoreRecord | undefined = await readRecord(transaction.store('store').store, 'r1')
			expect(read).toEqual({ id: 'r1', tags: ['admin'], profile: { age: 36 } })
			expect(read).not.toBe(record)
		})
	})

	it('readRecords honours a key range and count, and raises RECORD naming the key the pair reads', async () => {
		const db = await seedNonRecord(teardown, 7310)
		await db.read('books', async (transaction) => {
			const native = transaction.store('books').store
			expect(await readRecords(native, undefined, 1)).toEqual([{ title: 'Atlas', length: 412 }])
			expect(await readRecords(native, rangeFromKey('c'))).toEqual([{ title: 'Codex', length: 96 }])
			const caught = await readRecords(native).catch((error: unknown) => error)
			expect(caught).toBeInstanceOf(IndexedDBError)
			expect(errorCode(caught)).toBe('RECORD')
			expect(caught).toHaveProperty('context', { store: 'books', key: 'b' })
			expect(String(caught)).not.toContain('7310')
		})
	})

	it('readRecord and readRecords raise RECORD naming the store, index, and primary key over an index', async () => {
		const db = await seedNonRecord(teardown, 'xyz')
		await db.read('books', async (transaction) => {
			const index = transaction.store('books').store.index('byLength')
			expect(await readRecord(index, 96)).toEqual({ title: 'Codex', length: 96 })
			const point = await readRecord(index, 3).catch((error: unknown) => error)
			expect(errorCode(point)).toBe('RECORD')
			expect(point).toHaveProperty('context', { store: 'books', index: 'byLength', key: 'b' })
			expect(String(point)).not.toContain('xyz')
			const bulk = await readRecords(index).catch((error: unknown) => error)
			expect(errorCode(bulk)).toBe('RECORD')
			expect(bulk).toHaveProperty('context', { store: 'books', index: 'byLength', key: 'b' })
			expect(String(bulk)).not.toContain('xyz')
		})
	})

	it('readRecord and readRecords work over an index', async () => {
		const { db, cleanup } = await createTestDatabase({
			users: { path: 'id', indexes: [{ name: 'byAge', path: 'age' }] },
		})
		teardown.add(cleanup)
		await db.store('users').set([
			{ id: 'a', age: 20 },
			{ id: 'b', age: 30 },
		])
		await db.read('users', async (transaction) => {
			const index = transaction.store('users').store.index('byAge')
			expect(await readRecord(index, 30)).toEqual({ id: 'b', age: 30 })
			expect((await readRecords(index)).map((record) => record.id)).toEqual(['a', 'b'])
		})
	})

	it('hasKey reports presence by a native count', async () => {
		const { db, cleanup } = await createTestDatabase({ store: {} })
		teardown.add(cleanup)
		await db.write('store', async (transaction) => {
			await promisifyRequest(transaction.store('store').store.put({ id: 'x' }, 'x'))
		})
		await db.read('store', async (transaction) => {
			const native = transaction.store('store').store
			expect(await hasKey(native, 'x')).toBe(true)
			expect(await hasKey(native, 'nope')).toBe(false)
		})
	})
})

describe('readRecord — the index point read pair beside the caller writes', () => {
	it('names the primary key the pair read when the caller removes that entry after a read queued behind', async () => {
		const db = await seedNonRecord(teardown, 'wxyz')
		const outcome = Promise.withResolvers<unknown>()
		await db.write('books', async (transaction) => {
			const native = transaction.store('books').store
			const read = readRecord(native.index('byLength'), 4).catch((error: unknown) => error)
			await readRecord(native, 'a')
			await promisifyRequest(native.delete('b'))
			outcome.resolve(await read)
		})
		const caught = await outcome.promise
		expect(errorCode(caught)).toBe('RECORD')
		expect(caught).toHaveProperty('context', { store: 'books', index: 'byLength', key: 'b' })
	})
})

describe('createIndex — index-DDL leaf', () => {
	it('translates an IndexDefinition into a native createIndex call, honouring unique / multiple', async () => {
		const name = mintDatabase()
		await dropDatabase(name)
		const opened = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = globalThis.indexedDB.open(name, 1)
			request.addEventListener('upgradeneeded', () => {
				const store = request.result.createObjectStore('tags', { keyPath: 'id' })
				createIndex(store, { name: 'byLabel', path: 'label', unique: true })
				createIndex(store, { name: 'byWord', path: 'words', multiple: true })
			})
			request.addEventListener('success', () => resolve(request.result))
			request.addEventListener('error', () => reject(request.error))
		})
		teardown.add(async () => {
			opened.close()
			await dropDatabase(name)
		})

		const readTx = opened.transaction(['tags'], 'readonly')
		const store = readTx.objectStore('tags')
		const byLabel = store.index('byLabel')
		expect(byLabel.unique).toBe(true)
		expect(byLabel.multiEntry).toBe(false)
		const byWord = store.index('byWord')
		expect(byWord.unique).toBe(false)
		expect(byWord.multiEntry).toBe(true)
		await promisifyTransaction(readTx)

		const write = opened.transaction(['tags'], 'readwrite')
		write.objectStore('tags').put({ id: 't1', label: 'x', words: ['a', 'b'] })
		await promisifyTransaction(write)

		const check = opened.transaction(['tags'], 'readonly')
		const tagsStore = check.objectStore('tags')
		expect(await promisifyRequest(tagsStore.index('byLabel').get('x'))).toEqual({
			id: 't1',
			label: 'x',
			words: ['a', 'b'],
		})
		expect(await promisifyRequest(tagsStore.index('byWord').get('a'))).toEqual({
			id: 't1',
			label: 'x',
			words: ['a', 'b'],
		})
		await promisifyTransaction(check)
	})
})

describe('scanIndex — a stored index against its declaration', () => {
	it('returns no difference for the index createIndex built, and names each differing member', async () => {
		const { db, cleanup } = await createTestDatabase({
			tags: {
				path: 'id',
				indexes: [
					{ name: 'byLabel', path: 'label', unique: true },
					{ name: 'byWord', path: 'words', multiple: true },
					{ name: 'byPair', path: ['make', 'model'] },
				],
			},
		})
		teardown.add(cleanup)
		await db.read('tags', (transaction) => {
			const store = transaction.store('tags').store
			const byLabel = store.index('byLabel')
			const byWord = store.index('byWord')
			const byPair = store.index('byPair')
			expect(scanIndex(byLabel, { name: 'byLabel', path: 'label', unique: true })).toEqual([])
			expect(scanIndex(byWord, { name: 'byWord', path: 'words', multiple: true })).toEqual([])
			expect(scanIndex(byPair, { name: 'byPair', path: ['make', 'model'] })).toEqual([])
			expect(scanIndex(byLabel, { name: 'byLabel', path: 'title' })).toEqual(['path', 'unique'])
			expect(scanIndex(byLabel, { name: 'byLabel', path: ['label'], unique: true })).toEqual([
				'path',
			])
			expect(scanIndex(byWord, { name: 'byWord', path: 'words' })).toEqual(['multiple'])
			expect(scanIndex(byPair, { name: 'byPair', path: ['model', 'make'] })).toEqual(['path'])
			expect(scanIndex(byPair, { name: 'byPair', path: ['make'] })).toEqual(['path'])
			expect(scanIndex(byPair, { name: 'byPair', path: 'make' })).toEqual(['path'])
		})
	})
})

describe('promisifyRequest — IDBRequest bridge', () => {
	it('resolves to the request result on success', async () => {
		const { db, cleanup } = await createTestDatabase({ store: { path: 'id' } })
		teardown.add(cleanup)
		await db.write('store', async (transaction) => {
			const native = transaction.store('store').store
			const key = await promisifyRequest(native.add({ id: 'u1' }))
			expect(key).toBe('u1')
			expect(await promisifyRequest(native.count())).toBe(1)
			const got = await promisifyRequest(native.get('u1'))
			expect(got).toEqual({ id: 'u1' })
		})
	})

	it('rejects with an IndexedDBError carrying the mapped code', async () => {
		const { db, cleanup } = await createTestDatabase({ store: { path: 'id' } })
		teardown.add(cleanup)
		await db.store('store').set({ id: 'u1' })
		const caught = Promise.withResolvers<unknown>()
		await db
			.write('store', async (transaction) => {
				// A duplicate `add` faults with a native ConstraintError, which the
				// bridge wraps as an IndexedDBError(code: 'CONSTRAINT').
				caught.resolve(
					await promisifyRequest(transaction.store('store').store.add({ id: 'u1' })).catch(
						(error: unknown) => error,
					),
				)
			})
			.catch(() => {})
		expect(await caught.promise).toBeInstanceOf(IndexedDBError)
		expect(errorCode(await caught.promise)).toBe('CONSTRAINT')
	})
})

describe('promisifyTransaction — IDBTransaction bridge', () => {
	it('resolves once the transaction commits, making writes durable', async () => {
		const { db, cleanup } = await createTestDatabase({ store: { path: 'id' } })
		teardown.add(cleanup)
		const native = db.database.transaction(['store'], 'readwrite')
		const store = native.objectStore('store')
		await promisifyRequest(store.add({ id: 'u1', name: 'Ada' }))
		await promisifyTransaction(native)
		// After the commit resolves, a fresh read sees the row.
		expect(await db.store('store').get('u1')).toEqual({ id: 'u1', name: 'Ada' })
	})

	it('rejects when the transaction aborts', async () => {
		const { db, cleanup } = await createTestDatabase({ store: { path: 'id' } })
		teardown.add(cleanup)
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

describe('wrapCall — synchronous native call boundary', () => {
	it('returns what the action returned when it does not throw', () => {
		expect(wrapCall(() => 'the native result')).toBe('the native result')
		expect(wrapCall(() => 0)).toBe(0)
	})

	it('wraps a thrown DOMException as the mapped IndexedDBError, keeping it as cause', () => {
		const native = new DOMException('the transaction is not active', 'TransactionInactiveError')
		const caught = captureError(() => {
			return wrapCall(() => {
				throw native
			})
		})
		expect(caught).toBeInstanceOf(IndexedDBError)
		expect(errorCode(caught)).toBe('INACTIVE')
		expect(isIndexedDBError(caught) ? caught.cause : undefined).toBe(native)
	})

	it('rethrows a throw that is not a DOMException by identity', () => {
		// The second path of the one decision the function makes: anything the
		// request boundary cannot map leaves unchanged, not wrapped in UNKNOWN.
		const raised = new TypeError('not a native IndexedDB fault')
		const caught = captureError(() => {
			return wrapCall(() => {
				throw raised
			})
		})
		expect(caught).toBe(raised)
		expect(caught).not.toBeInstanceOf(IndexedDBError)
	})
})

describe('wrapDOMException — DOMException → IndexedDBError', () => {
	it('maps a known DOMException.name to its code, keeping the message and cause', () => {
		const native = new DOMException('unique key already exists', 'ConstraintError')
		const wrapped = wrapDOMException(native)
		expect(wrapped).toBeInstanceOf(IndexedDBError)
		expect(wrapped.code).toBe('CONSTRAINT')
		expect(wrapped.message).toBe('unique key already exists')
		expect(wrapped.cause).toBe(native)
	})

	it('maps each other known name to its code', () => {
		expect(wrapDOMException(new DOMException('', 'QuotaExceededError')).code).toBe('QUOTA')
		expect(wrapDOMException(new DOMException('', 'AbortError')).code).toBe('ABORTED')
		expect(wrapDOMException(new DOMException('', 'NotFoundError')).code).toBe('NOT_FOUND')
		expect(wrapDOMException(new DOMException('', 'DataError')).code).toBe('DATA')
		expect(wrapDOMException(new DOMException('', 'VersionError')).code).toBe('UPGRADE')
		expect(wrapDOMException(new DOMException('', 'TransactionInactiveError')).code).toBe('INACTIVE')
		expect(wrapDOMException(new DOMException('', 'InvalidStateError')).code).toBe('INVALID')
	})

	it('falls back to UNKNOWN for an unmapped name, synthesizing a message', () => {
		const wrapped = wrapDOMException(new DOMException('', 'TypeMismatchError'))
		expect(wrapped.code).toBe('UNKNOWN')
		expect(wrapped.message).toBe('IndexedDB error: TypeMismatchError')
	})

	it('falls back to UNKNOWN with a generic message for a null error', () => {
		const wrapped = wrapDOMException(null)
		expect(wrapped).toBeInstanceOf(IndexedDBError)
		expect(wrapped.code).toBe('UNKNOWN')
		expect(wrapped.message).toBe('Unknown IndexedDB error')
		expect(wrapped.cause).toBeUndefined()
	})
})

describe('IndexedDBError — machine-readable context', () => {
	it('reports the context it was constructed with, beside the code', () => {
		const error = new IndexedDBError('NOT_FOUND', 'no record', undefined, {
			store: 'users',
			key: 'ghost',
		})
		expect(error.code).toBe('NOT_FOUND')
		expect(error.context).toEqual({ store: 'users', key: 'ghost' })
	})

	it('reports undefined for a fault carrying none, wrapDOMException results included', () => {
		expect(new IndexedDBError('CLOSED', 'the handle is closed').context).toBeUndefined()
		// A native fault already rides as `cause`, so `wrapDOMException` passes no context.
		expect(
			wrapDOMException(new DOMException('duplicate', 'ConstraintError')).context,
		).toBeUndefined()
		expect(wrapDOMException(null).context).toBeUndefined()
	})
})

describe('isIndexedDBError — type guard', () => {
	it('narrows a thrown IndexedDBError', () => {
		const error = new IndexedDBError('NOT_FOUND', 'missing')
		expect(isIndexedDBError(error)).toBe(true)
	})

	it('returns false for a plain Error and other values', () => {
		expect(isIndexedDBError(new Error('plain'))).toBe(false)
		expect(isIndexedDBError('IndexedDBError')).toBe(false)
		expect(isIndexedDBError(undefined)).toBe(false)
	})
})

describe('buildRecordError — the store and index names through preview', () => {
	it.for(MESSAGE_NAMES)(
		'names the store and the index a value was read from ($shown)',
		async ({ name, shown }) => {
			const { db, cleanup } = await createTestDatabase({
				[name]: { indexes: [{ name, path: 'length' }] },
			})
			teardown.add(cleanup)
			await db.write(name, async (transaction) => {
				await promisifyRequest(transaction.store(name).store.put('xyz', 'b'))
			})
			const point = await db
				.store(name)
				.index(name)
				.get(3)
				.catch((error: unknown) => error)
			expect(isIndexedDBError(point) ? point.message : undefined).toBe(
				`Stored value is not a record (store ${shown}, index ${shown}, key "b"); rewrite or remove the entry`,
			)
			const stored = await db
				.store(name)
				.get('b')
				.catch((error: unknown) => error)
			expect(isIndexedDBError(stored) ? stored.message : undefined).toBe(
				`Stored value is not a record (store ${shown}, key "b"); rewrite or remove the entry`,
			)
		},
	)
})
