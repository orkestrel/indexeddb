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
import { isArray, isInteger, isRecord, isString } from '@orkestrel/contract'
import { IndexedDBError } from './errors.js'
import { createIndex, promisifyTransaction, wrapCall } from './helpers.js'
import { IndexedDBStore } from './IndexedDBStore.js'
import { IndexedDBTransaction } from './IndexedDBTransaction.js'
import { IndexedDBTransactionStore } from './IndexedDBTransactionStore.js'

/**
 * Represents a browser-native IndexedDB database — a typed, Promise-based handle.
 *
 * @remarks
 * Connects lazily on first use (`connect`, also awaited internally by every store
 * operation), creating any missing stores from their definitions inside
 * `onupgradeneeded`. `store` reaches a typed store; `read` / `write` run an atomic
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
	readonly #stores: Stores
	readonly #upgrade: ((context: IndexedDBUpgradeContext) => void | Promise<void>) | undefined
	#database: IDBDatabase | undefined
	readonly #opens = new Set<Promise<IDBDatabase>>()
	#closed = false

	constructor(options: IndexedDBDatabaseOptions<Stores>) {
		if (options.name.length === 0) {
			throw new IndexedDBError('OPEN', 'Database name must be a non-empty string')
		}
		if (options.version !== undefined && (!isInteger(options.version) || options.version < 1)) {
			throw new IndexedDBError(
				'OPEN',
				`Database version must be a positive integer, got ${String(options.version)}`,
			)
		}
		this.#name = options.name
		this.#version = options.version
		this.#stores = options.stores
		this.#upgrade = options.upgrade
	}

	get database(): IDBDatabase {
		if (this.#database === undefined) {
			throw new IndexedDBError(
				'NOT_OPEN',
				`Database '${this.#name}' is not open — call connect() first`,
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
			throw new IndexedDBError('CLOSED', `Database '${this.#name}' has been closed`)
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
				`Store '${name}' is not declared on database '${this.#name}'`,
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
					new IndexedDBError('UNKNOWN', `Failed to delete database '${this.#name}'`, request.error),
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
			this.#version === undefined && this.#missing(initial).length > 0
				? await this.#replace(initial)
				: initial
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
			throw new IndexedDBError('CLOSED', `Database '${this.#name}' has been closed`)
		}
		return database
	}

	// One `indexedDB.open`, creating any missing declared store in `onupgradeneeded`.
	#request(version: number | undefined): Promise<IDBDatabase> {
		return new Promise((resolve, reject) => {
			// Presence is separate from the cause value because JavaScript permits
			// both `throw undefined` and `Promise.reject(undefined)`.
			const failure = new AbortController()
			const request =
				version === undefined
					? globalThis.indexedDB.open(this.#name)
					: globalThis.indexedDB.open(this.#name, version)
			request.addEventListener('upgradeneeded', (event) => {
				const database = request.result
				const transaction = request.transaction
				if (transaction === null) {
					failure.abort({
						cause: new IndexedDBError(
							'UPGRADE',
							`Upgrade of '${this.#name}' has no versionchange transaction`,
						),
					})
					return
				}

				// Built-in construction and the custom callback are one atomic
				// upgrade phase, so every synchronous schema fault reaches the same
				// typed boundary and prevents the custom phase from running.
				try {
					for (const [name, definition] of Object.entries(this.#stores)) {
						if (!database.objectStoreNames.contains(name)) {
							this.#createUpgradeStore(database, name, definition)
						}
					}
					if (this.#upgrade !== undefined) {
						const result = this.#upgrade(this.#context(database, transaction, event))
						if (result !== undefined) {
							result.catch((error: unknown) => {
								failure.abort({ cause: error })
								try {
									transaction.abort()
								} catch {
									// Custom code may already have settled or aborted the transaction
									// before its rejection reaches this continuation.
								}
							})
						}
					}
				} catch (error) {
					failure.abort({ cause: error })
					try {
						transaction.abort()
					} catch {
						// Custom code may already have aborted the transaction before
						// throwing; the failure recorded first remains authoritative.
					}
				}
			})
			request.addEventListener('success', () => {
				if (!failure.signal.aborted) {
					resolve(request.result)
					return
				}
				request.result.close()
				const reason: unknown = failure.signal.reason
				reject(
					new IndexedDBError(
						'UPGRADE',
						`Upgrade of '${this.#name}' failed`,
						isRecord(reason) ? reason.cause : undefined,
					),
				)
			})
			request.addEventListener('error', () => {
				const reason: unknown = failure.signal.reason
				reject(
					failure.signal.aborted
						? new IndexedDBError(
								'UPGRADE',
								`Upgrade of '${this.#name}' failed`,
								isRecord(reason) ? reason.cause : undefined,
							)
						: new IndexedDBError('OPEN', `Failed to open database '${this.#name}'`, request.error),
				)
			})
		})
	}

	// Declared stores the open database does not yet contain.
	#missing(database: IDBDatabase): readonly string[] {
		return Object.keys(this.#stores).filter((name) => !database.objectStoreNames.contains(name))
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
