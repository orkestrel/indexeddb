import { isArray } from '@orkestrel/contract'
import type {
	CursorOptions,
	IndexedDBCursorInterface,
	IndexedDBTransactionStoreInterface,
	Row,
} from './types.js'
import { IndexedDBError } from './errors.js'
import { guardSync, hasKey, promisifyRequest, readRecord, readRecords } from './helpers.js'
import { IndexedDBCursor } from './IndexedDBCursor.js'

/**
 * An object store bound to an explicit transaction.
 *
 * @remarks
 * The same CRUD surface as a standalone store, but every call runs in the owning
 * transaction (opened by the database's `read` / `write`) rather than its own — so
 * a sequence of reads and writes commits atomically when the scope resolves. It
 * does not await transaction completion per call (the scope does that once) and
 * omits `index`; keep your awaited operations on IndexedDB requests only, so the
 * transaction stays active across them.
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

	get(keys: readonly IDBValidKey[]): Promise<readonly (Row | undefined)[]>
	get(key: IDBValidKey): Promise<Row | undefined>
	async get(
		keyOrKeys: IDBValidKey | readonly IDBValidKey[],
	): Promise<Row | undefined | readonly (Row | undefined)[]> {
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

	async records(query?: IDBKeyRange | IDBValidKey | null, count?: number): Promise<readonly Row[]> {
		return readRecords(this.#store, query, count)
	}

	async keys(
		query?: IDBKeyRange | IDBValidKey | null,
		count?: number,
	): Promise<readonly IDBValidKey[]> {
		return promisifyRequest(guardSync(() => this.#store.getAllKeys(query ?? undefined, count)))
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

	async count(query?: IDBKeyRange | IDBValidKey | null): Promise<number> {
		return promisifyRequest(guardSync(() => this.#store.count(query ?? undefined)))
	}

	set(values: readonly Row[]): Promise<readonly IDBValidKey[]>
	set(value: Row, key?: IDBValidKey): Promise<IDBValidKey>
	async set(
		valueOrValues: Row | readonly Row[],
		key?: IDBValidKey,
	): Promise<IDBValidKey | readonly IDBValidKey[]> {
		if (isArray<Row>(valueOrValues)) {
			return Promise.all(
				valueOrValues.map((value) => promisifyRequest(guardSync(() => this.#store.put(value)))),
			)
		}
		return promisifyRequest(
			guardSync(() =>
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
				valueOrValues.map((value) => promisifyRequest(guardSync(() => this.#store.add(value)))),
			)
		}
		return promisifyRequest(
			guardSync(() =>
				key === undefined ? this.#store.add(valueOrValues) : this.#store.add(valueOrValues, key),
			),
		)
	}

	remove(keys: readonly IDBValidKey[]): Promise<void>
	remove(key: IDBValidKey): Promise<void>
	async remove(keyOrKeys: IDBValidKey | readonly IDBValidKey[]): Promise<void> {
		if (isArray<IDBValidKey>(keyOrKeys)) {
			await Promise.all(
				keyOrKeys.map((key) => promisifyRequest(guardSync(() => this.#store.delete(key)))),
			)
			return
		}
		await promisifyRequest(guardSync(() => this.#store.delete(keyOrKeys)))
	}

	async clear(): Promise<void> {
		await promisifyRequest(guardSync(() => this.#store.clear()))
	}

	async cursor(options?: CursorOptions): Promise<IndexedDBCursorInterface | null> {
		const request = guardSync(() =>
			this.#store.openCursor(options?.query ?? null, options?.direction ?? 'next'),
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
			)
		}
		return value
	}
}
