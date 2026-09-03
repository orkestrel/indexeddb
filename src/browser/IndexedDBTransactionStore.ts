import type {
	IndexedDBCursorInterface,
	IndexedDBCursorOptions,
	IndexedDBTransactionStoreInterface,
	Row,
} from './types.js'
import { isArray } from '@orkestrel/contract'
import { IndexedDBError } from './errors.js'
import { hasKey, promisifyRequest, readRecord, readRecords, wrapCall } from './helpers.js'
import { IndexedDBCursor } from './IndexedDBCursor.js'

/**
 * Represents an object store bound to an explicit transaction.
 *
 * @remarks
 * The same CRUD surface as a standalone store, but every call runs in the owning
 * transaction (opened by the database's `read` / `write`) rather than its own — so
 * a sequence of reads and writes commits atomically when the scope resolves. It
 * does not await transaction completion per call (the scope does that once) and
 * omits `index`; keep your awaited operations on IndexedDB requests only, so the
 * transaction stays active across them.
 *
 * @example
 * ```ts
 * import { IndexedDBTransactionStore } from '@orkestrel/indexeddb'
 *
 * // A raw object store from a live `IDBDatabase` a consumer holds — the value
 * // `transaction.store(name)` wraps.
 * const native = database.transaction(['users'], 'readwrite').objectStore('users')
 * const users = new IndexedDBTransactionStore(native)
 * await users.set({ id: 'u1', name: 'Ada' })
 * await users.get('u1') // { id: 'u1', name: 'Ada' }
 * ```
 */
export class IndexedDBTransactionStore implements IndexedDBTransactionStoreInterface {
	readonly #store: IDBObjectStore
	readonly #name: string

	constructor(store: IDBObjectStore) {
		this.#store = store
		this.#name = store.name
	}

	get store(): IDBObjectStore {
		return this.#store
	}

	get(keys: readonly IDBValidKey[]): Promise<ReadonlyArray<Row | undefined>>
	get(key: IDBValidKey): Promise<Row | undefined>
	async get(
		keyOrKeys: IDBValidKey | readonly IDBValidKey[],
	): Promise<Row | undefined | ReadonlyArray<Row | undefined>> {
		if (isArray<IDBValidKey>(keyOrKeys)) {
			return Promise.all(keyOrKeys.map((key) => readRecord(this.#store, key)))
		}
		return readRecord(this.#store, keyOrKeys)
	}

	resolve(keys: readonly IDBValidKey[]): Promise<readonly Row[]>
	resolve(key: IDBValidKey): Promise<Row>
	async resolve(keyOrKeys: IDBValidKey | readonly IDBValidKey[]): Promise<Row | readonly Row[]> {
		if (isArray<IDBValidKey>(keyOrKeys)) {
			return Promise.all(keyOrKeys.map((key) => this.#resolve(key)))
		}
		return this.#resolve(keyOrKeys)
	}

	async records(query?: IDBKeyRange | IDBValidKey, count?: number): Promise<readonly Row[]> {
		return readRecords(this.#store, query, count)
	}

	async keys(query?: IDBKeyRange | IDBValidKey, count?: number): Promise<readonly IDBValidKey[]> {
		return promisifyRequest(wrapCall(() => this.#store.getAllKeys(query, count)))
	}

	has(keys: readonly IDBValidKey[]): Promise<readonly boolean[]>
	has(key: IDBValidKey): Promise<boolean>
	async has(
		keyOrKeys: IDBValidKey | readonly IDBValidKey[],
	): Promise<boolean | readonly boolean[]> {
		if (isArray<IDBValidKey>(keyOrKeys)) {
			return Promise.all(keyOrKeys.map((key) => hasKey(this.#store, key)))
		}
		return hasKey(this.#store, keyOrKeys)
	}

	async count(query?: IDBKeyRange | IDBValidKey): Promise<number> {
		return promisifyRequest(wrapCall(() => this.#store.count(query)))
	}

	set(values: readonly Row[]): Promise<readonly IDBValidKey[]>
	set(value: Row, key?: IDBValidKey): Promise<IDBValidKey>
	async set(
		valueOrValues: Row | readonly Row[],
		key?: IDBValidKey,
	): Promise<IDBValidKey | readonly IDBValidKey[]> {
		if (isArray<Row>(valueOrValues)) {
			return Promise.all(
				valueOrValues.map((value) => promisifyRequest(wrapCall(() => this.#store.put(value)))),
			)
		}
		return promisifyRequest(
			wrapCall(() =>
				key === undefined ? this.#store.put(valueOrValues) : this.#store.put(valueOrValues, key),
			),
		)
	}

	add(values: readonly Row[]): Promise<readonly IDBValidKey[]>
	add(value: Row, key?: IDBValidKey): Promise<IDBValidKey>
	async add(
		valueOrValues: Row | readonly Row[],
		key?: IDBValidKey,
	): Promise<IDBValidKey | readonly IDBValidKey[]> {
		if (isArray<Row>(valueOrValues)) {
			return Promise.all(
				valueOrValues.map((value) => promisifyRequest(wrapCall(() => this.#store.add(value)))),
			)
		}
		return promisifyRequest(
			wrapCall(() =>
				key === undefined ? this.#store.add(valueOrValues) : this.#store.add(valueOrValues, key),
			),
		)
	}

	remove(keys: readonly IDBValidKey[]): Promise<void>
	remove(key: IDBValidKey): Promise<void>
	async remove(keyOrKeys: IDBValidKey | readonly IDBValidKey[]): Promise<void> {
		if (isArray<IDBValidKey>(keyOrKeys)) {
			await Promise.all(
				keyOrKeys.map((key) => promisifyRequest(wrapCall(() => this.#store.delete(key)))),
			)
			return
		}
		await promisifyRequest(wrapCall(() => this.#store.delete(keyOrKeys)))
	}

	async clear(): Promise<void> {
		await promisifyRequest(wrapCall(() => this.#store.clear()))
	}

	async cursor(options?: IndexedDBCursorOptions): Promise<IndexedDBCursorInterface | null> {
		const request = wrapCall(() =>
			this.#store.openCursor(options?.query, options?.direction ?? 'next'),
		)
		const cursor = await promisifyRequest(request)
		return cursor ? new IndexedDBCursor(cursor, request) : null
	}

	async #resolve(key: IDBValidKey): Promise<Row> {
		const value = await readRecord(this.#store, key)
		if (value === undefined) {
			throw new IndexedDBError(
				'NOT_FOUND',
				`No record in store '${this.#name}' for key ${String(key)}`,
				undefined,
				{ store: this.#name, key },
			)
		}
		return value
	}
}
