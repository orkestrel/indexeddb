import type { Row } from '@src/core'
import { isArray } from '@src/core'
import type {
	CursorOptions,
	IndexDefinition,
	IndexedDBCursorInterface,
	IndexedDBIndexInterface,
	KeyPath,
} from './types.js'
import { IndexedDBError } from './errors.js'
import { hasKey, promisifyRequest, readRecord, readRecords } from './helpers.js'
import { IndexedDBCursor } from './IndexedDBCursor.js'

/**
 * A secondary index on a store — a read-only view keyed by an indexed path.
 *
 * @remarks
 * Reached through `store.index(name)`. Each call opens its own `readonly`
 * transaction. `get` / `resolve` fetch the first record for an index key
 * (`resolve` throws `NOT_FOUND`); `records` reads the matching records and `keys`
 * their **primary** keys; `primary` maps an index key to one primary key; `count`
 * / `has` test presence; `cursor` streams matches. Reads batch by their array
 * overload (AGENTS §9.2).
 */
export class IndexedDBIndex implements IndexedDBIndexInterface {
	readonly #store: string
	readonly #name: string
	readonly #definition: IndexDefinition
	readonly #connect: () => Promise<IDBDatabase>

	constructor(
		store: string,
		name: string,
		definition: IndexDefinition,
		connect: () => Promise<IDBDatabase>,
	) {
		this.#store = store
		this.#name = name
		this.#definition = definition
		this.#connect = connect
	}

	get name(): string {
		return this.#name
	}

	get path(): KeyPath {
		return this.#definition.path
	}

	get unique(): boolean {
		return this.#definition.unique ?? false
	}

	get multiple(): boolean {
		return this.#definition.multiple ?? false
	}

	get(keys: readonly IDBValidKey[]): Promise<readonly (Row | undefined)[]>
	get(key: IDBValidKey): Promise<Row | undefined>
	async get(
		keyOrKeys: IDBValidKey | readonly IDBValidKey[],
	): Promise<Row | undefined | readonly (Row | undefined)[]> {
		const index = await this.#index()
		if (isArray<IDBValidKey>(keyOrKeys)) {
			return Promise.all(keyOrKeys.map((key) => readRecord(index, key)))
		}
		return readRecord(index, keyOrKeys)
	}

	resolve(keys: readonly IDBValidKey[]): Promise<readonly Row[]>
	resolve(key: IDBValidKey): Promise<Row>
	async resolve(keyOrKeys: IDBValidKey | readonly IDBValidKey[]): Promise<Row | readonly Row[]> {
		const index = await this.#index()
		if (isArray<IDBValidKey>(keyOrKeys)) {
			return Promise.all(keyOrKeys.map((key) => this.#resolve(index, key)))
		}
		return this.#resolve(index, keyOrKeys)
	}

	async records(query?: IDBKeyRange | IDBValidKey | null, count?: number): Promise<readonly Row[]> {
		const index = await this.#index()
		return readRecords(index, query, count)
	}

	async keys(
		query?: IDBKeyRange | IDBValidKey | null,
		count?: number,
	): Promise<readonly IDBValidKey[]> {
		const index = await this.#index()
		return promisifyRequest(index.getAllKeys(query ?? undefined, count))
	}

	async primary(key: IDBValidKey): Promise<IDBValidKey | undefined> {
		const index = await this.#index()
		return promisifyRequest(index.getKey(key))
	}

	has(keys: readonly IDBValidKey[]): Promise<readonly boolean[]>
	has(key: IDBValidKey): Promise<boolean>
	async has(
		keyOrKeys: IDBValidKey | readonly IDBValidKey[],
	): Promise<boolean | readonly boolean[]> {
		const index = await this.#index()
		if (isArray<IDBValidKey>(keyOrKeys)) {
			return Promise.all(keyOrKeys.map((key) => hasKey(index, key)))
		}
		return hasKey(index, keyOrKeys)
	}

	async count(query?: IDBKeyRange | IDBValidKey | null): Promise<number> {
		const index = await this.#index()
		return promisifyRequest(index.count(query ?? undefined))
	}

	async cursor(options?: CursorOptions): Promise<IndexedDBCursorInterface | null> {
		const index = await this.#index()
		const request = index.openCursor(options?.query ?? null, options?.direction ?? 'next')
		const cursor = await promisifyRequest(request)
		return cursor ? new IndexedDBCursor(cursor, request) : null
	}

	// Open this index in a fresh readonly transaction.
	async #index(): Promise<IDBIndex> {
		const database = await this.#connect()
		return database
			.transaction([this.#store], 'readonly')
			.objectStore(this.#store)
			.index(this.#name)
	}

	async #resolve(index: IDBIndex, key: IDBValidKey): Promise<Row> {
		const value = await readRecord(index, key)
		if (value === undefined) {
			throw new IndexedDBError(
				'NOT_FOUND',
				`No record in index '${this.#name}' of store '${this.#store}' for key ${String(key)}`,
			)
		}
		return value
	}
}
