import { isArray } from '@orkestrel/contract'
import type {
	CursorOptions,
	IndexedDBCursorInterface,
	IndexedDBIndexInterface,
	IndexedDBStoreInterface,
	KeyPath,
	Row,
	StoreDefinition,
} from './types.js'
import { IndexedDBError } from './errors.js'
import { guardSync, promisifyTransaction } from './helpers.js'
import { IndexedDBIndex } from './IndexedDBIndex.js'
import { IndexedDBTransactionStore } from './IndexedDBTransactionStore.js'

/**
 * An object store — the full keyed CRUD surface plus index, count, and cursor
 * access.
 *
 * @remarks
 * Reached through `database.store(name)`. Each call runs in its own implicit
 * transaction (`readonly` for reads, `readwrite` for writes), awaiting completion
 * so writes are durable on return; for atomic multi-operation work use the
 * database's `read` / `write`. The CRUD verbs themselves are the shared
 * {@link IndexedDBTransactionStore} engine — this class opens the implicit
 * transaction, delegates the verb to a transaction-bound store over it, and awaits
 * the transaction on a write. The keyed verbs batch by their array overload — and
 * those overloads are declared first, because an array is itself both a record and
 * a compound `IDBValidKey`, so the array signature must take precedence to read as
 * a batch (AGENTS §9.2). Pass `rangeExactKey([…])` to `records` / `count` to act on a
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

	get(keys: readonly IDBValidKey[]): Promise<ReadonlyArray<Row | undefined>>
	get(key: IDBValidKey): Promise<Row | undefined>
	async get(
		keyOrKeys: IDBValidKey | readonly IDBValidKey[],
	): Promise<Row | undefined | ReadonlyArray<Row | undefined>> {
		const engine = await this.#engine('readonly')
		if (isArray<IDBValidKey>(keyOrKeys)) return engine.get(keyOrKeys)
		return engine.get(keyOrKeys)
	}

	resolve(keys: readonly IDBValidKey[]): Promise<readonly Row[]>
	resolve(key: IDBValidKey): Promise<Row>
	async resolve(keyOrKeys: IDBValidKey | readonly IDBValidKey[]): Promise<Row | readonly Row[]> {
		const engine = await this.#engine('readonly')
		if (isArray<IDBValidKey>(keyOrKeys)) return engine.resolve(keyOrKeys)
		return engine.resolve(keyOrKeys)
	}

	async records(query?: IDBKeyRange | IDBValidKey | null, count?: number): Promise<readonly Row[]> {
		const engine = await this.#engine('readonly')
		return engine.records(query, count)
	}

	async keys(
		query?: IDBKeyRange | IDBValidKey | null,
		count?: number,
	): Promise<readonly IDBValidKey[]> {
		const engine = await this.#engine('readonly')
		return engine.keys(query, count)
	}

	has(keys: readonly IDBValidKey[]): Promise<readonly boolean[]>
	has(key: IDBValidKey): Promise<boolean>
	async has(
		keyOrKeys: IDBValidKey | readonly IDBValidKey[],
	): Promise<boolean | readonly boolean[]> {
		const engine = await this.#engine('readonly')
		if (isArray<IDBValidKey>(keyOrKeys)) return engine.has(keyOrKeys)
		return engine.has(keyOrKeys)
	}

	async count(query?: IDBKeyRange | IDBValidKey | null): Promise<number> {
		const engine = await this.#engine('readonly')
		return engine.count(query)
	}

	set(values: readonly Row[]): Promise<readonly IDBValidKey[]>
	set(value: Row, key?: IDBValidKey): Promise<IDBValidKey>
	async set(
		valueOrValues: Row | readonly Row[],
		key?: IDBValidKey,
	): Promise<IDBValidKey | readonly IDBValidKey[]> {
		const engine = await this.#engine('readwrite')
		const written = isArray<Row>(valueOrValues)
			? await engine.set(valueOrValues)
			: await engine.set(valueOrValues, key)
		await promisifyTransaction(engine.store.transaction)
		return written
	}

	add(values: readonly Row[]): Promise<readonly IDBValidKey[]>
	add(value: Row, key?: IDBValidKey): Promise<IDBValidKey>
	async add(
		valueOrValues: Row | readonly Row[],
		key?: IDBValidKey,
	): Promise<IDBValidKey | readonly IDBValidKey[]> {
		const engine = await this.#engine('readwrite')
		const written = isArray<Row>(valueOrValues)
			? await engine.add(valueOrValues)
			: await engine.add(valueOrValues, key)
		await promisifyTransaction(engine.store.transaction)
		return written
	}

	remove(keys: readonly IDBValidKey[]): Promise<void>
	remove(key: IDBValidKey): Promise<void>
	async remove(keyOrKeys: IDBValidKey | readonly IDBValidKey[]): Promise<void> {
		const engine = await this.#engine('readwrite')
		if (isArray<IDBValidKey>(keyOrKeys)) await engine.remove(keyOrKeys)
		else await engine.remove(keyOrKeys)
		await promisifyTransaction(engine.store.transaction)
	}

	async clear(): Promise<void> {
		const engine = await this.#engine('readwrite')
		await engine.clear()
		await promisifyTransaction(engine.store.transaction)
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
		const engine = await this.#engine('readwrite')
		return engine.cursor(options)
	}

	// Open this object store in a fresh transaction of the given mode, bound to the
	// shared transaction-store engine every verb above delegates to.
	async #engine(mode: IDBTransactionMode): Promise<IndexedDBTransactionStore> {
		const database = await this.#connect()
		return new IndexedDBTransactionStore(
			guardSync(() => database.transaction([this.#name], mode).objectStore(this.#name)),
		)
	}
}
