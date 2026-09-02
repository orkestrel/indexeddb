import { isArray } from '@orkestrel/contract'
import type {
	IndexedDBDatabaseInterface,
	IndexedDBDatabaseOptions,
	IndexedDBStoreInterface,
	IndexedDBTransactionInterface,
	IndexedDBUpgradeContext,
	IndexDefinition,
	StoreDefinition,
	StoresShape,
} from './types.js'
import { IndexedDBError } from './errors.js'
import { createIndex, guardSync, promisifyTransaction } from './helpers.js'
import { IndexedDBStore } from './IndexedDBStore.js'
import { IndexedDBTransaction } from './IndexedDBTransaction.js'
import { IndexedDBTransactionStore } from './IndexedDBTransactionStore.js'

/**
 * A browser-native IndexedDB database — a typed, Promise-based handle.
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
 */
export class IndexedDBDatabase<
	Stores extends StoresShape = StoresShape,
> implements IndexedDBDatabaseInterface<Stores> {
	readonly #name: string
	readonly #version: number | undefined
	readonly #stores: Stores
	readonly #upgrade: ((context: IndexedDBUpgradeContext) => void | Promise<void>) | undefined
	#database: IDBDatabase | undefined
	#opening: Promise<IDBDatabase> | undefined
	#closed = false

	constructor(options: IndexedDBDatabaseOptions<Stores>) {
		if (options.name.length === 0) {
			throw new IndexedDBError('OPEN', 'Database name must be a non-empty string')
		}
		if (
			options.version !== undefined &&
			(!Number.isInteger(options.version) || options.version < 1)
		) {
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
		if (this.#opening !== undefined) return this.#opening
		// Clear the latch on failure so a later call can retry the open.
		this.#opening = this.#open().catch((error: unknown) => {
			this.#opening = undefined
			throw error
		})
		return this.#opening
	}

	store<K extends keyof Stores & string>(name: K): IndexedDBStoreInterface {
		const definition = this.#stores[name]
		if (definition === undefined) {
			throw new IndexedDBError(
				'NOT_FOUND',
				`Store '${name}' is not declared on database '${this.#name}'`,
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
		this.#opening = undefined
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
		const native = guardSync(() => database.transaction(names, mode))
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
			// `settled` may still reject (the abort above, or the native transaction
			// having already aborted/errored) after `scope` already threw — that
			// rejection is redundant with `error` below and must not surface as an
			// unhandled rejection.
			settled.catch(() => {})
			throw error
		}
	}

	// Open the connection: at the configured version, or — in auto-managed mode (no
	// version) — at the database's current version, bumping once to create any
	// declared store the stored schema is missing.
	async #open(): Promise<IDBDatabase> {
		let database = this.#accept(await this.#request(this.#version))
		if (this.#version === undefined) {
			const missing = this.#missing(database)
			if (missing.length > 0) {
				const next = database.version + 1
				database.close()
				database = this.#accept(await this.#request(next))
			}
		}
		// An abnormal, browser-initiated close (a crashed extension, storage
		// eviction) fires this event — clear BOTH latches, mirroring
		// `onversionchange` below, so a later operation lazily reconnects instead
		// of finding a stale resolved `#opening` for a connection that is now dead.
		database.onclose = this.#clearConnection.bind(this, database)
		// Yield to another context's version-change upgrade instead of blocking it
		// indefinitely — without this, two tabs over the same database hang: the
		// second tab's `open` sits in `onblocked` forever because this connection
		// never closes on its own. `close()` here is self-initiated, so `onclose`
		// does NOT fire (the browser only fires it when the connection closes for a
		// reason other than `close()` itself) — clear the same latches `onclose`
		// clears so a later operation on this handle lazily reconnects instead of
		// forever holding a closed `#database`.
		database.onversionchange = this.#yieldConnection.bind(this, database)
		this.#database = database
		return database
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
			let upgradeFailure: { readonly cause: unknown } | undefined
			const request =
				version === undefined
					? globalThis.indexedDB.open(this.#name)
					: globalThis.indexedDB.open(this.#name, version)
			request.addEventListener('upgradeneeded', (event) => {
				const database = request.result
				const transaction = request.transaction
				if (transaction === null) {
					upgradeFailure = {
						cause: new IndexedDBError(
							'UPGRADE',
							`Upgrade of '${this.#name}' has no versionchange transaction`,
						),
					}
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
								if (upgradeFailure === undefined) upgradeFailure = { cause: error }
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
					if (upgradeFailure === undefined) upgradeFailure = { cause: error }
					try {
						transaction.abort()
					} catch {
						// Custom code may already have aborted the transaction before
						// throwing; the initiating failure above remains authoritative.
					}
				}
			})
			request.addEventListener('success', () => {
				if (upgradeFailure === undefined) {
					resolve(request.result)
					return
				}
				request.result.close()
				reject(
					new IndexedDBError('UPGRADE', `Upgrade of '${this.#name}' failed`, upgradeFailure.cause),
				)
			})
			request.addEventListener('error', () =>
				reject(
					upgradeFailure !== undefined
						? new IndexedDBError(
								'UPGRADE',
								`Upgrade of '${this.#name}' failed`,
								upgradeFailure.cause,
							)
						: new IndexedDBError('OPEN', `Failed to open database '${this.#name}'`, request.error),
				),
			)
		})
	}

	// Declared stores the open database does not yet contain.
	#missing(database: IDBDatabase): readonly string[] {
		return Object.keys(this.#stores).filter((name) => !database.objectStoreNames.contains(name))
	}

	// Build the upgrade context passed to `options.upgrade`, after the built-in
	// create-missing-stores pass so `stores.names` reflects any store just created.
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
				open: this.#openUpgradeStore.bind(this, transaction),
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
		this.#opening = undefined
	}

	#yieldConnection(database: IDBDatabase): void {
		database.close()
		this.#clearConnection(database)
	}

	#createUpgradeStore(database: IDBDatabase, name: string, definition: StoreDefinition): void {
		guardSync(() => this.#createStore(database, name, definition))
	}

	#dropUpgradeStore(database: IDBDatabase, name: string): void {
		guardSync(() => database.deleteObjectStore(name))
	}

	#openUpgradeStore(transaction: IDBTransaction, name: string): IndexedDBTransactionStore {
		return new IndexedDBTransactionStore(guardSync(() => transaction.objectStore(name)))
	}

	#createUpgradeIndex(
		transaction: IDBTransaction,
		store: string,
		definition: IndexDefinition,
	): void {
		guardSync(() => createIndex(transaction.objectStore(store), definition))
	}

	#dropUpgradeIndex(transaction: IDBTransaction, store: string, name: string): void {
		guardSync(() => transaction.objectStore(store).deleteIndex(name))
	}

	#createStore(database: IDBDatabase, name: string, definition: StoreDefinition): void {
		const options: IDBObjectStoreParameters = { autoIncrement: definition.increment ?? false }
		if (definition.path !== undefined) {
			options.keyPath = typeof definition.path === 'string' ? definition.path : [...definition.path]
		}
		const store = database.createObjectStore(name, options)
		for (const index of definition.indexes ?? []) {
			createIndex(store, index)
		}
	}
}
