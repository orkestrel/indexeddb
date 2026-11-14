import type {
	IndexedDBDatabaseInterface,
	IndexedDBDatabaseOptions,
	IndexedDBSchema,
	IndexedDBStoreInterface,
	IndexedDBTransactionInterface,
	IndexedDBUpgradeContext,
	IndexDefinition,
	StoreDefinition,
} from './types.js'
import {
	attempt,
	cloneJSONRecord,
	describeFaults,
	isArray,
	isEmptyArray,
	isError,
	isRecord,
	isString,
	isUndefined,
	preview,
} from '@orkestrel/contract'
import { IndexedDBError, isIndexedDBError } from './errors.js'
import {
	indexDefinitionContract,
	indexedDBDatabaseOptionsContract,
	storeDefinitionContract,
} from './contracts.js'
import {
	createIndex,
	promisifyTransaction,
	scanIndex,
	wrapCall,
	wrapDOMException,
} from './helpers.js'
import { IndexedDBStore } from './IndexedDBStore.js'
import { IndexedDBTransaction } from './IndexedDBTransaction.js'
import { IndexedDBTransactionStore } from './IndexedDBTransactionStore.js'

/**
 * Represents a browser-native IndexedDB database — a typed, Promise-based handle.
 *
 * @remarks
 * Connects lazily on first use (`connect`, also awaited internally by every store
 * operation), creating any missing stores from their definitions inside
 * `onupgradeneeded`, and, after the custom `upgrade` callback, each declared index
 * an existing store lacks, refusing a declared index whose stored definition differs. `store` reaches a typed store; `read` / `write` run an atomic
 * scope over one or more stores, committing on resolve and rolling back on a throw;
 * `close` releases the connection and `drop` deletes the database. The built-in
 * schema pass and custom `upgrade` callback share one failure boundary: a fault
 * captured while the versionchange transaction remains active rolls it back and
 * rejects `connect()` with `UPGRADE`, retaining its initiating cause. A failure
 * recorded after auto-commit closes a terminal success connection but cannot
 * undo the committed schema. Native blocked notifications leave open/delete
 * requests pending, and `close` permanently rejects any in-flight open after
 * closing its eventual native result.
 *
 * @example
 * ```ts
 * import { createIndexedDBDatabase, IndexedDBDatabase } from '@orkestrel/indexeddb'
 *
 * const options = { name: 'app', version: 1, stores: { users: { path: 'id' } } }
 * const db = new IndexedDBDatabase(options)
 * // `createIndexedDBDatabase(options)` builds the same handle and, through its
 * // `const` type parameter, narrows `store(name)` to the declared store names.
 * const typed = createIndexedDBDatabase(options)
 * await db.store('users').set({ id: 'u1', name: 'Ada' })
 * await typed.connect()
 * ```
 */
export class IndexedDBDatabase<
	Stores extends IndexedDBSchema = IndexedDBSchema,
> implements IndexedDBDatabaseInterface<Stores> {
	readonly #name: string
	readonly #version: number | undefined
	readonly #stores: IndexedDBSchema
	readonly #upgrade: ((context: IndexedDBUpgradeContext) => void | Promise<void>) | undefined
	#database: IDBDatabase | undefined
	readonly #opens = new Set<Promise<IDBDatabase>>()
	#closed = false

	constructor(options: IndexedDBDatabaseOptions<Stores>) {
		// The options are read once, through one copy taken only of a plain record, so a class
		// instance or a non-record is audited as it arrived. Contract has no function shape, so
		// `upgrade` is audited as its preview: a function reads 'function'.
		const read = isRecord(options) ? { ...options } : options
		const checked =
			isRecord(read) && !isUndefined(read.upgrade)
				? { ...read, upgrade: preview(read.upgrade) }
				: read
		// The admitted value is an owned, frozen deep copy, so no later change to the caller's
		// objects reaches what this handle creates; only it is read afterwards.
		const owned = attempt(() => cloneJSONRecord(checked))
		if (!owned.success) {
			// A value contract cannot clone, such as one that is not JSON data or that passes its
			// node limit, is refused with that cause; no caller object is read again.
			const clone = isError(owned.error) ? owned.error.message : String(owned.error)
			throw new IndexedDBError(
				'DATA',
				`Database options are not plain JSON data: ${clone}`,
				owned.error,
				{ clone },
			)
		}
		if (!indexedDBDatabaseOptionsContract.is(owned.value)) {
			// The audit reads the same owned clone the check refused, so the faults are that
			// value's, and the audit runs only after the strict check refused.
			const faults = indexedDBDatabaseOptionsContract.audit(owned.value)
			throw new IndexedDBError(
				'DATA',
				`Database options must match IndexedDBDatabaseOptions:\n${describeFaults(faults, indexedDBDatabaseOptionsContract.schema)}`,
				undefined,
				{ faults },
			)
		}
		this.#name = owned.value.name
		this.#version = owned.value.version
		this.#stores = owned.value.stores
		this.#upgrade = read.upgrade
	}

	get database(): IDBDatabase {
		if (this.#database === undefined) {
			throw new IndexedDBError(
				'NOT_OPEN',
				`Database ${preview(this.#name)} is not open — call connect() first`,
			)
		}
		return this.#database
	}

	get name(): string {
		return this.#name
	}

	get version(): number {
		return this.#database?.version ?? this.#version ?? 0
	}

	get stores(): readonly string[] {
		if (this.#database !== undefined) return Array.from(this.#database.objectStoreNames)
		return Object.keys(this.#stores)
	}

	get open(): boolean {
		return this.#database !== undefined && !this.#closed
	}

	connect(): Promise<IDBDatabase> {
		if (this.#closed) {
			throw new IndexedDBError('CLOSED', `Database ${preview(this.#name)} has been closed`)
		}
		if (this.#database !== undefined) return Promise.resolve(this.#database)
		const [opening] = this.#opens
		if (opening !== undefined) return opening
		const pending = this.#open()
		this.#opens.add(pending)
		void pending.then(
			() => this.#opens.delete(pending),
			() => this.#opens.delete(pending),
		)
		return pending
	}

	store<K extends keyof Stores & string>(name: K): IndexedDBStoreInterface {
		const definition = this.#stores[name]
		if (definition === undefined) {
			throw new IndexedDBError(
				'NOT_FOUND',
				`Store ${preview(name)} is not declared on database ${preview(this.#name)}`,
				undefined,
				{ database: this.#name, store: name },
			)
		}
		return new IndexedDBStore(name, definition, () => this.connect())
	}

	read(
		stores: (keyof Stores & string) | ReadonlyArray<keyof Stores & string>,
		scope: (transaction: IndexedDBTransactionInterface<Stores>) => void | Promise<void>,
	): Promise<void> {
		return this.#run('readonly', stores, scope)
	}

	write(
		stores: (keyof Stores & string) | ReadonlyArray<keyof Stores & string>,
		scope: (transaction: IndexedDBTransactionInterface<Stores>) => void | Promise<void>,
	): Promise<void> {
		return this.#run('readwrite', stores, scope)
	}

	close(): void {
		this.#database?.close()
		this.#database = undefined
		this.#opens.clear()
		this.#closed = true
	}

	async drop(): Promise<void> {
		this.close()
		return new Promise((resolve, reject) => {
			const request = globalThis.indexedDB.deleteDatabase(this.#name)
			request.addEventListener('success', () => resolve())
			request.addEventListener('error', () =>
				reject(
					new IndexedDBError(
						'UNKNOWN',
						`Failed to delete database ${preview(this.#name)}`,
						request.error,
					),
				),
			)
		})
	}

	// Open a scoped transaction, run the scope, then commit (or roll back on throw).
	async #run(
		mode: IDBTransactionMode,
		stores: (keyof Stores & string) | ReadonlyArray<keyof Stores & string>,
		scope: (transaction: IndexedDBTransactionInterface<Stores>) => void | Promise<void>,
	): Promise<void> {
		const database = await this.connect()
		const names = isArray<string>(stores) ? [...stores] : [stores]
		const native = wrapCall(() => database.transaction(names, mode))
		const wrapper = new IndexedDBTransaction<Stores>(native)
		// Attach the completion listeners BEFORE invoking `scope` — a scope that
		// ends on a trailing non-IDB `await` lets the transaction auto-commit, and
		// `complete` can fire before a listener attached only after `scope` returns
		// would ever be wired, hanging this call forever.
		const settled = promisifyTransaction(native)
		try {
			await scope(wrapper)
			await settled
		} catch (error) {
			if (wrapper.active) {
				try {
					wrapper.abort()
				} catch {
					// Already settled by the native transaction — nothing to roll back.
				}
			}
			// `settled` may still reject (the abort this catch performed, or the
			// native transaction having already aborted/errored) after `scope` already
			// threw — that rejection is redundant with the `error` this catch rethrows
			// and must not surface as an unhandled rejection.
			settled.catch(() => {})
			throw error
		}
	}

	// Open the connection: at the configured version, or — in auto-managed mode (no
	// version) — at the database's current version, bumping once to create any
	// declared store the stored schema is missing.
	async #open(): Promise<IDBDatabase> {
		const initial = this.#accept(await this.#request(this.#version))
		const database =
			this.#version === undefined && this.#stale(initial) ? await this.#replace(initial) : initial
		// Browser-initiated closure retires the stored connection so a later call reconnects.
		database.onclose = this.#clearConnection.bind(this, database)
		// Self-initiated closure emits no close event, so versionchange also retires the connection.
		database.onversionchange = this.#yieldConnection.bind(this, database)
		this.#database = database
		return database
	}

	async #replace(database: IDBDatabase): Promise<IDBDatabase> {
		const next = database.version + 1
		database.close()
		return this.#accept(await this.#request(next))
	}

	#accept(database: IDBDatabase): IDBDatabase {
		if (this.#closed) {
			database.close()
			throw new IndexedDBError('CLOSED', `Database ${preview(this.#name)} has been closed`)
		}
		return database
	}

	// One `indexedDB.open`, creating any missing declared store in `onupgradeneeded`.
	#request(version: number | undefined): Promise<IDBDatabase> {
		return new Promise((resolve, reject) => {
			// Presence is separate from the cause value because JavaScript permits
			// both `throw undefined` and `Promise.reject(undefined)`.
			const failure = new AbortController()
			// Aborted when `upgradeneeded` fires, so an open that errors afterwards reads as a
			// failed upgrade rather than a failed open.
			const upgrading = new AbortController()
			const request =
				version === undefined
					? globalThis.indexedDB.open(this.#name)
					: globalThis.indexedDB.open(this.#name, version)
			request.addEventListener('upgradeneeded', (event) => {
				upgrading.abort()
				const database = request.result
				const transaction = request.transaction
				const target = database.version
				if (transaction === null) {
					failure.abort({
						cause: new IndexedDBError(
							'UPGRADE',
							`Upgrade of ${preview(this.#name)} has no versionchange transaction`,
						),
					})
					return
				}

				// Built-in construction, the custom callback, and the built-in index pass
				// are one atomic upgrade phase, so every schema fault reaches the same
				// typed boundary. The index pass runs after the callback, so it finds a
				// declared index the callback created rather than colliding with it.
				try {
					for (const [name, definition] of Object.entries(this.#stores)) {
						if (!database.objectStoreNames.contains(name)) {
							this.#createUpgradeStore(database, name, definition)
						}
					}
					const result = this.#upgrade?.(this.#context(database, transaction, event))
					if (result === undefined) this.#reconcile(database, transaction, target)
					else {
						result
							.then(() => this.#reconcile(database, transaction, target))
							.catch((error: unknown) => this.#fail(failure, transaction, error))
					}
				} catch (error) {
					this.#fail(failure, transaction, error)
				}
			})
			request.addEventListener('success', () => {
				if (!failure.signal.aborted) {
					resolve(request.result)
					return
				}
				request.result.close()
				reject(this.#upgradeError(failure.signal.reason))
			})
			request.addEventListener('error', () => {
				if (failure.signal.aborted) reject(this.#upgradeError(failure.signal.reason))
				else if (upgrading.signal.aborted) {
					reject(this.#upgradeError({ cause: wrapDOMException(request.error) }))
				} else {
					reject(
						new IndexedDBError(
							'OPEN',
							`Failed to open database ${preview(this.#name)}`,
							request.error,
						),
					)
				}
			})
		})
	}

	// Whether the open database lacks a declared store or a declared index, or holds a
	// declared index whose definition differs, read through one readonly transaction.
	#stale(database: IDBDatabase): boolean {
		const names = Object.keys(this.#stores)
		if (names.some((name) => !database.objectStoreNames.contains(name))) return true
		const indexed = names.filter((name) => !isEmptyArray(this.#stores[name]?.indexes ?? []))
		if (isEmptyArray(indexed)) return false
		const transaction = wrapCall(() => database.transaction(indexed, 'readonly'))
		return indexed.some((name) => {
			const store = transaction.objectStore(name)
			return (this.#stores[name]?.indexes ?? []).some(
				(index) =>
					!store.indexNames.contains(index.name) ||
					!isEmptyArray(scanIndex(store.index(index.name), index)),
			)
		})
	}

	// After the custom callback: create each declared index an existing declared store
	// lacks, and refuse one whose stored definition differs. A store the callback dropped
	// is left absent, and no index is dropped. A callback that aborted the transaction
	// reverted the connection to its prior version, so the pass then has nothing to do.
	#reconcile(database: IDBDatabase, transaction: IDBTransaction, target: number): void {
		if (database.version !== target) return
		for (const [name, definition] of Object.entries(this.#stores)) {
			if (!database.objectStoreNames.contains(name)) continue
			const store = wrapCall(() => transaction.objectStore(name))
			for (const index of definition.indexes ?? []) {
				if (!store.indexNames.contains(index.name)) {
					wrapCall(() => createIndex(store, index))
					continue
				}
				const differs = scanIndex(store.index(index.name), index)
				if (!isEmptyArray(differs)) {
					throw new IndexedDBError(
						'UPGRADE',
						`Index ${preview(index.name)} on store ${preview(name)} differs from its declaration in ${differs.join(', ')}; drop it in an upgrade callback or match the declaration to it`,
						undefined,
						{ store: name, index: index.name },
					)
				}
			}
		}
	}

	// The UPGRADE rejection for a recorded failure: its cause is the initiating value, and
	// a typed cause's context is copied up so a caller reads it without walking the chain.
	#upgradeError(reason: unknown): IndexedDBError {
		const cause: unknown = isRecord(reason) ? reason.cause : undefined
		return new IndexedDBError(
			'UPGRADE',
			`Upgrade of ${preview(this.#name)} failed`,
			cause,
			isIndexedDBError(cause) ? cause.context : undefined,
		)
	}

	// Record the first failure of an upgrade and roll its transaction back.
	#fail(failure: AbortController, transaction: IDBTransaction, error: unknown): void {
		failure.abort({ cause: error })
		try {
			transaction.abort()
		} catch {
			// Custom code may already have settled or aborted the transaction; the
			// failure recorded first remains authoritative.
		}
	}

	// Build the upgrade context passed to `options.upgrade`, after the built-in
	// create-missing-stores pass so `stores.names` reflects any store already created.
	#context(
		database: IDBDatabase,
		transaction: IDBTransaction,
		event: IDBVersionChangeEvent,
	): IndexedDBUpgradeContext {
		return {
			transaction,
			old: event.oldVersion,
			version: event.newVersion ?? database.version,
			stores: {
				names: Array.from(database.objectStoreNames),
				create: this.#createUpgradeStore.bind(this, database),
				drop: this.#dropUpgradeStore.bind(this, database),
				store: this.#upgradeStore.bind(this, transaction),
			},
			indexes: {
				create: this.#createUpgradeIndex.bind(this, transaction),
				drop: this.#dropUpgradeIndex.bind(this, transaction),
			},
		}
	}

	#clearConnection(database: IDBDatabase): void {
		if (this.#database !== database) return
		this.#database = undefined
	}

	#yieldConnection(database: IDBDatabase): void {
		database.close()
		this.#clearConnection(database)
	}

	#createUpgradeStore(database: IDBDatabase, name: string, definition: StoreDefinition): void {
		if (!storeDefinitionContract.is(definition)) {
			const faults = storeDefinitionContract.audit(definition)
			throw new IndexedDBError(
				'DATA',
				`Store ${preview(name)} is not a StoreDefinition:\n${describeFaults(faults, storeDefinitionContract.schema)}`,
				undefined,
				{ store: name, faults },
			)
		}
		wrapCall(() => this.#createStore(database, name, definition))
	}

	#dropUpgradeStore(database: IDBDatabase, name: string): void {
		wrapCall(() => database.deleteObjectStore(name))
	}

	#upgradeStore(transaction: IDBTransaction, name: string): IndexedDBTransactionStore {
		return new IndexedDBTransactionStore(wrapCall(() => transaction.objectStore(name)))
	}

	#createUpgradeIndex(
		transaction: IDBTransaction,
		store: string,
		definition: IndexDefinition,
	): void {
		if (!indexDefinitionContract.is(definition)) {
			const faults = indexDefinitionContract.audit(definition)
			throw new IndexedDBError(
				'DATA',
				`Index definition for store ${preview(store)} is not an IndexDefinition:\n${describeFaults(faults, indexDefinitionContract.schema)}`,
				undefined,
				{ store, faults },
			)
		}
		wrapCall(() => createIndex(transaction.objectStore(store), definition))
	}

	#dropUpgradeIndex(transaction: IDBTransaction, store: string, name: string): void {
		wrapCall(() => transaction.objectStore(store).deleteIndex(name))
	}

	#createStore(database: IDBDatabase, name: string, definition: StoreDefinition): void {
		const options: IDBObjectStoreParameters = { autoIncrement: definition.increment ?? false }
		if (definition.path !== undefined) {
			options.keyPath = isString(definition.path) ? definition.path : [...definition.path]
		}
		const store = database.createObjectStore(name, options)
		for (const index of definition.indexes ?? []) {
			createIndex(store, index)
		}
	}
}
