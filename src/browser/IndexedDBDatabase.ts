import { isArray } from '@orkestrel/contract'
import type {
	IndexedDBDatabaseInterface,
	IndexedDBDatabaseOptions,
	IndexedDBStoreInterface,
	IndexedDBTransactionInterface,
	IndexedDBUpgradeContext,
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
 * `close` releases the connection and `drop` deletes the database. Schema changes
 * beyond creating new stores (dropping stores, altering indexes) are deferred.
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
		stores: (keyof Stores & string) | readonly (keyof Stores & string)[],
		scope: (tx: IndexedDBTransactionInterface<Stores>) => void | Promise<void>,
	): Promise<void> {
		return this.#run('readonly', stores, scope)
	}

	write(
		stores: (keyof Stores & string) | readonly (keyof Stores & string)[],
		scope: (tx: IndexedDBTransactionInterface<Stores>) => void | Promise<void>,
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
			request.onsuccess = () => resolve()
			request.onerror = () =>
				reject(
					new IndexedDBError('UNKNOWN', `Failed to delete database '${this.#name}'`, request.error),
				)
			request.onblocked = () =>
				reject(
					new IndexedDBError(
						'BLOCKED',
						`Deletion of '${this.#name}' is blocked by another connection`,
					),
				)
		})
	}

	// Open a scoped transaction, run the scope, then commit (or roll back on throw).
	async #run(
		mode: IDBTransactionMode,
		stores: (keyof Stores & string) | readonly (keyof Stores & string)[],
		scope: (tx: IndexedDBTransactionInterface<Stores>) => void | Promise<void>,
	): Promise<void> {
		const database = await this.connect()
		const names = isArray<string>(stores) ? [...stores] : [stores]
		const native = guardSync(() => database.transaction(names, mode))
		const tx = new IndexedDBTransaction<Stores>(native)
		try {
			await scope(tx)
			await promisifyTransaction(native)
		} catch (error) {
			if (tx.active) {
				try {
					tx.abort()
				} catch {
					// Already settled by the native transaction — nothing to roll back.
				}
			}
			throw error
		}
	}

	// Open the connection: at the configured version, or — in auto-managed mode (no
	// version) — at the database's current version, bumping once to create any
	// declared store the stored schema is missing.
	async #open(): Promise<IDBDatabase> {
		let database = await this.#request(this.#version)
		if (this.#version === undefined) {
			const missing = this.#missing(database)
			if (missing.length > 0) {
				const next = database.version + 1
				database.close()
				database = await this.#request(next)
			}
		}
		database.onclose = () => {
			this.#database = undefined
		}
		// Yield to another context's version-change upgrade instead of blocking it
		// indefinitely — without this, two tabs over the same database hang: the
		// second tab's `open` sits in `onblocked` forever because this connection
		// never closes on its own. `close()` here is self-initiated, so `onclose`
		// does NOT fire (the browser only fires it when the connection closes for a
		// reason other than `close()` itself) — clear the same latches `onclose`
		// clears so a later operation on this handle lazily reconnects instead of
		// forever holding a closed `#database`.
		database.onversionchange = () => {
			database.close()
			this.#database = undefined
			this.#opening = undefined
		}
		this.#database = database
		return database
	}

	// One `indexedDB.open`, creating any missing declared store in `onupgradeneeded`.
	#request(version: number | undefined): Promise<IDBDatabase> {
		return new Promise((resolve, reject) => {
			// Set when `options.upgrade` returns a Promise that rejects — captured
			// here rather than left as a dangling, unhandled rejection, and routed
			// into `onerror` below: the failed upgrade aborts its versionchange
			// transaction, which fails this very open request.
			let upgradeError: unknown
			const request =
				version === undefined
					? globalThis.indexedDB.open(this.#name)
					: globalThis.indexedDB.open(this.#name, version)
			request.onupgradeneeded = (event) => {
				const database = request.result
				for (const [name, definition] of Object.entries(this.#stores)) {
					if (!database.objectStoreNames.contains(name)) {
						this.#createStore(database, name, definition)
					}
				}
				if (this.#upgrade !== undefined) {
					const transaction = request.transaction
					if (transaction !== null) {
						const result = this.#upgrade(this.#context(database, transaction, event))
						if (result !== undefined) {
							result.catch((error: unknown) => {
								upgradeError = error
								try {
									transaction.abort()
								} catch {
									// Already settled — the versionchange transaction committed or
									// aborted before the rejection arrived; nothing to roll back.
								}
							})
						}
					}
				}
			}
			request.onsuccess = () => resolve(request.result)
			request.onerror = () =>
				reject(
					upgradeError !== undefined
						? new IndexedDBError('UPGRADE', `Upgrade of '${this.#name}' failed`, upgradeError)
						: new IndexedDBError('OPEN', `Failed to open database '${this.#name}'`, request.error),
				)
			request.onblocked = () =>
				reject(
					new IndexedDBError('BLOCKED', `Open of '${this.#name}' is blocked by another connection`),
				)
		})
	}

	// Declared stores the open database does not yet contain.
	#missing(database: IDBDatabase): readonly string[] {
		return Object.keys(this.#stores).filter((name) => !database.objectStoreNames.contains(name))
	}

	// Build the upgrade context passed to `options.upgrade`, after the built-in
	// create-missing-stores pass so `stores` reflects any store just created.
	#context(
		database: IDBDatabase,
		transaction: IDBTransaction,
		event: IDBVersionChangeEvent,
	): IndexedDBUpgradeContext {
		return {
			transaction,
			old: event.oldVersion,
			version: event.newVersion ?? database.version,
			stores: Array.from(database.objectStoreNames),
			create: (name, definition) => {
				this.#createStore(database, name, definition)
			},
			drop: (name) => {
				database.deleteObjectStore(name)
			},
			store: (name) => new IndexedDBTransactionStore(transaction.objectStore(name)),
			index: (store, definition) => {
				createIndex(transaction.objectStore(store), definition)
			},
			deindex: (store, name) => {
				transaction.objectStore(store).deleteIndex(name)
			},
		}
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
