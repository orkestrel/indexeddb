import type { Row } from '@src/core'
import { isArray } from '@src/core'
import type {
	CursorOptions,
	IndexedDBCursorInterface,
	IndexedDBIndexInterface,
	IndexedDBStoreInterface,
	KeyPath,
	StoreDefinition,
} from './types.js'
import { IndexedDBError } from './errors.js'
import {
	hasKey,
	promisifyRequest,
	promisifyTransaction,
	readRecord,
	readRecords,
} from './helpers.js'
import { IndexedDBCursor } from './IndexedDBCursor.js'
import { IndexedDBIndex } from './IndexedDBIndex.js'

/**
 * An object store — the full keyed CRUD surface plus index, count, and cursor
 * access.
 *
 * @remarks
 * Reached through `database.store(name)`. Each call runs in its own implicit
 * transaction (`readonly` for reads, `readwrite` for writes), awaiting completion
 * so writes are durable on return; for atomic multi-operation work use the
 * database's `read` / `write`. The keyed verbs batch by their array overload — and
 * those overloads are declared first, because an array is itself both a record and
 * a compound `IDBValidKey`, so the array signature must take precedence to read as
 * a batch (AGENTS §9.2). Pass `range.only([…])` to `records` / `count` to act on a
 * single compound key.
 */
export class IndexedDBStore implements IndexedDBStoreInterface {
	readonly #name: string
	readonly #definition: StoreDefinition
	readonly #connect: () => Promise<IDBDatabase>

	constructor(name: string, definition: StoreDefinition, connect: () => Promise<IDBDatabase>) {
		this.#name = name
		this.#definition = definition
		this.#connect = connect
	}

	get name(): string {
		return this.#name
	}

	get path(): KeyPath | null {
		return this.#definition.path ?? null
	}

	get indexes(): readonly string[] {
		return (this.#definition.indexes ?? []).map((index) => index.name)
	}

	get increment(): boolean {
		return this.#definition.increment ?? false
	}

	get(keys: readonly IDBValidKey[]): Promise<readonly (Row | undefined)[]>
	get(key: IDBValidKey): Promise<Row | undefined>
	async get(
		keyOrKeys: IDBValidKey | readonly IDBValidKey[],
	): Promise<Row | undefined | readonly (Row | undefined)[]> {
		const store = await this.#store('readonly')
		if (isArray<IDBValidKey>(keyOrKeys)) {
			return Promise.all(keyOrKeys.map((key) => readRecord(store, key)))
		}
		return readRecord(store, keyOrKeys)
	}

	resolve(keys: readonly IDBValidKey[]): Promise<readonly Row[]>
	resolve(key: IDBValidKey): Promise<Row>
	async resolve(keyOrKeys: IDBValidKey | readonly IDBValidKey[]): Promise<Row | readonly Row[]> {
		const store = await this.#store('readonly')
		if (isArray<IDBValidKey>(keyOrKeys)) {
			return Promise.all(keyOrKeys.map((key) => this.#resolve(store, key)))
		}
		return this.#resolve(store, keyOrKeys)
	}

	async records(query?: IDBKeyRange | IDBValidKey | null, count?: number): Promise<readonly Row[]> {
		const store = await this.#store('readonly')
		return readRecords(store, query, count)
	}

	async keys(
		query?: IDBKeyRange | IDBValidKey | null,
		count?: number,
	): Promise<readonly IDBValidKey[]> {
		const store = await this.#store('readonly')
		return promisifyRequest(store.getAllKeys(query ?? undefined, count))
	}

	has(keys: readonly IDBValidKey[]): Promise<readonly boolean[]>
	has(key: IDBValidKey): Promise<boolean>
	async has(
		keyOrKeys: IDBValidKey | readonly IDBValidKey[],
	): Promise<boolean | readonly boolean[]> {
		const store = await this.#store('readonly')
		if (isArray<IDBValidKey>(keyOrKeys)) {
			return Promise.all(keyOrKeys.map((key) => hasKey(store, key)))
		}
		return hasKey(store, keyOrKeys)
	}

	async count(query?: IDBKeyRange | IDBValidKey | null): Promise<number> {
		const store = await this.#store('readonly')
		return promisifyRequest(store.count(query ?? undefined))
	}

	set(values: readonly Row[]): Promise<readonly IDBValidKey[]>
	set(value: Row, key?: IDBValidKey): Promise<IDBValidKey>
	async set(
		valueOrValues: Row | readonly Row[],
		key?: IDBValidKey,
	): Promise<IDBValidKey | readonly IDBValidKey[]> {
		const store = await this.#store('readwrite')
		if (isArray<Row>(valueOrValues)) {
			const keys = await Promise.all(
				valueOrValues.map((value) => promisifyRequest(store.put(value))),
			)
			await promisifyTransaction(store.transaction)
			return keys
		}
		const written = await promisifyRequest(
			key === undefined ? store.put(valueOrValues) : store.put(valueOrValues, key),
		)
		await promisifyTransaction(store.transaction)
		return written
	}

	add(values: readonly Row[]): Promise<readonly IDBValidKey[]>
	add(value: Row, key?: IDBValidKey): Promise<IDBValidKey>
	async add(
		valueOrValues: Row | readonly Row[],
		key?: IDBValidKey,
	): Promise<IDBValidKey | readonly IDBValidKey[]> {
		const store = await this.#store('readwrite')
		if (isArray<Row>(valueOrValues)) {
			const keys = await Promise.all(
				valueOrValues.map((value) => promisifyRequest(store.add(value))),
			)
			await promisifyTransaction(store.transaction)
			return keys
		}
		const written = await promisifyRequest(
			key === undefined ? store.add(valueOrValues) : store.add(valueOrValues, key),
		)
		await promisifyTransaction(store.transaction)
		return written
	}

	remove(keys: readonly IDBValidKey[]): Promise<void>
	remove(key: IDBValidKey): Promise<void>
	async remove(keyOrKeys: IDBValidKey | readonly IDBValidKey[]): Promise<void> {
		const store = await this.#store('readwrite')
		if (isArray<IDBValidKey>(keyOrKeys)) {
			await Promise.all(keyOrKeys.map((key) => promisifyRequest(store.delete(key))))
		} else {
			await promisifyRequest(store.delete(keyOrKeys))
		}
		await promisifyTransaction(store.transaction)
	}

	async clear(): Promise<void> {
		const store = await this.#store('readwrite')
		await promisifyRequest(store.clear())
		await promisifyTransaction(store.transaction)
	}

	index(name: string): IndexedDBIndexInterface {
		const definition = (this.#definition.indexes ?? []).find((index) => index.name === name)
		if (definition === undefined) {
			throw new IndexedDBError(
				'NOT_FOUND',
				`Index '${name}' is not declared on store '${this.#name}'`,
			)
		}
		return new IndexedDBIndex(this.#name, name, definition, this.#connect)
	}

	async cursor(options?: CursorOptions): Promise<IndexedDBCursorInterface | null> {
		const store = await this.#store('readwrite')
		const request = store.openCursor(options?.query ?? null, options?.direction ?? 'next')
		const cursor = await promisifyRequest(request)
		return cursor ? new IndexedDBCursor(cursor, request) : null
	}

	// Open this object store in a fresh transaction of the given mode.
	async #store(mode: IDBTransactionMode): Promise<IDBObjectStore> {
		const database = await this.#connect()
		return database.transaction([this.#name], mode).objectStore(this.#name)
	}

	async #resolve(store: IDBObjectStore, key: IDBValidKey): Promise<Row> {
		const value = await readRecord(store, key)
		if (value === undefined) {
			throw new IndexedDBError(
				'NOT_FOUND',
				`No record in store '${this.#name}' for key ${String(key)}`,
			)
		}
		return value
	}
}
