// The lean browser-native IndexedDB surface — a typed, Promise-based wrapper over
// the raw `IDBDatabase` / `IDBObjectStore` / `IDBIndex` / `IDBTransaction` API.
// There is no cross-environment database layer in this package — no query /
// filter / sort / aggregate builder here, only what raw IndexedDB offers
// natively: object stores, secondary indexes, native key ranges, cursors, and
// native multi-store transactions. Types are the source of truth
// (`AGENTS.md` § TTTDD).
//
// Values are this package's own `Row` (a record), narrowed from IndexedDB's
// structured clone with `isRecord` at the read boundary — an `as`-free bridge.
// Keys are the full native `IDBValidKey`, so the wrapper speaks IndexedDB's
// whole key space.

// === Row

/**
 * Represents a record stored in, and read from, an object store.
 *
 * @remarks
 * The value shape every store / index / transaction-store CRUD method reads and
 * writes. A structured-clone value narrowed with `isRecord` at the read
 * boundary (see `helpers.ts`), never an unchecked cast.
 */
export type Row = Record<string, unknown>

// === Errors

/**
 * Represents a machine-readable {@link IndexedDBError} code.
 *
 * @remarks
 * Each maps from a native `DOMException.name` or a wrapper-lifecycle fault:
 * `NOT_OPEN` (used before `connect`), `CLOSED` (used after `close`), `NOT_FOUND`
 * (a `resolve` miss), `CONSTRAINT` (a unique-key violation), `QUOTA` (storage
 * full), `ABORTED` (a transaction rolled back), `DATA` (an invalid key or an
 * un-clonable value — native `DataError` and `DataCloneError` both map here),
 * `OPEN` / `UPGRADE` (a failed open or schema upgrade), `INACTIVE` (the
 * transaction went inactive — IndexedDB's auto-commit fault, raised when an
 * operation runs after a non-IDB `await` deactivated its transaction — reachable through
 * `IndexedDBTransactionStoreInterface`, and when `IndexedDBTransactionInterface`'s
 * `abort` / `commit` are called on an already-finished transaction), `READONLY`
 * (native `ReadOnlyError` — a write attempted on a `readonly` transaction, e.g.
 * mutating through a cursor opened in a `read` scope), `INVALID` (native
 * `InvalidStateError` — a defensive mapping for a deleted store/index or
 * similarly invalid native handle; not cleanly reachable through this
 * wrapper's public API, which always opens a fresh transaction or routes
 * through the auto-commit-guarded {@link IndexedDBTransactionStoreInterface}),
 * and `UNKNOWN` (any
 * unmapped fault).
 */
export type IndexedDBErrorCode =
	| 'NOT_OPEN'
	| 'CLOSED'
	| 'NOT_FOUND'
	| 'CONSTRAINT'
	| 'QUOTA'
	| 'ABORTED'
	| 'DATA'
	| 'OPEN'
	| 'UPGRADE'
	| 'INACTIVE'
	| 'READONLY'
	| 'INVALID'
	| 'UNKNOWN'

// === Schema

/**
 * Represents a key path — one field, or several for a compound key.
 *
 * @remarks
 * A single string addresses one field; an array addresses a compound key over
 * several fields, in order.
 */
export type KeyPath = string | readonly string[]

/**
 * Represents a secondary index on a store.
 *
 * @remarks
 * `name` identifies the index for `store.index(name)`; `path` is the field(s) it
 * indexes; `unique` enforces one record per indexed value; `multiple` (IndexedDB's
 * `multiEntry`) indexes each element of an array value separately.
 */
export interface IndexDefinition {
	readonly name: string
	readonly path: KeyPath
	readonly unique?: boolean
	readonly multiple?: boolean
}

/**
 * Represents a store's schema.
 *
 * @remarks
 * `path` is the in-line key path (omit it for an **out-of-line** store, where the
 * key is passed explicitly to `set` / `add`); `increment` auto-generates numeric
 * keys; `indexes` declares secondary indexes.
 * Stores are created from these definitions inside `onupgradeneeded`.
 */
export interface StoreDefinition {
	readonly path?: KeyPath
	readonly increment?: boolean
	readonly indexes?: readonly IndexDefinition[]
}

/** Represents a database's schema — a map of store name to its {@link StoreDefinition}. */
export type IndexedDBSchema = Readonly<Record<string, StoreDefinition>>

/**
 * Represents the store manager of a version-change upgrade.
 *
 * @remarks
 * Reached as `context.stores` on {@link IndexedDBUpgradeContext}. `names` lists
 * the stores the database holds at that moment, so it already reflects any store
 * the built-in create-missing pass just created. `create` / `drop` add or remove
 * a whole store; `store` reaches a transaction-bound store for data migration.
 * Versionchange-only: every call must stay within the upgrade transaction — no
 * non-IDB `await`, or it auto-commits and the upgrade fails.
 *
 * @example
 * ```ts
 * upgrade: async (context) => {
 * 	context.stores.create('meta', { path: 'key' })
 * 	context.stores.drop('legacy')
 * 	await context.stores.store('users').set({ id: 'u1', migrated: true })
 * }
 * ```
 */
export interface IndexedDBUpgradeStoreManagerInterface {
	readonly names: readonly string[]
	create(name: string, definition: StoreDefinition): void
	drop(name: string): void
	store(name: string): IndexedDBTransactionStoreInterface
}

/**
 * Represents the secondary-index manager of a version-change upgrade.
 *
 * @remarks
 * Reached as `context.indexes` on {@link IndexedDBUpgradeContext}. `create` adds
 * a secondary index to a store — mirroring the index translation the built-in
 * schema pass applies to a store's declared `indexes` — and `drop` removes one
 * by name. Versionchange-only, and the named store must already exist within the
 * current upgrade transaction: declared in the schema, created earlier in the
 * same upgrade, or already present from a prior version.
 *
 * @example
 * ```ts
 * upgrade(context) {
 * 	context.indexes.create('books', { name: 'byAuthor', path: 'author' })
 * 	context.indexes.drop('books', 'byTitle')
 * }
 * ```
 */
export interface IndexedDBUpgradeIndexManagerInterface {
	create(store: string, definition: IndexDefinition): void
	drop(store: string, name: string): void
}

/**
 * Represents the escape hatch into a version-change upgrade, passed to
 * `IndexedDBDatabaseOptions.upgrade`.
 *
 * @remarks
 * Runs INSIDE `onupgradeneeded`, after the built-in create-missing-stores pass —
 * so `stores.names` already reflects any store just created from the declared
 * schema. `transaction` is the raw versionchange `IDBTransaction`, the escape hatch
 * for anything the raw API offers that this wrapper does not model directly; `old` /
 * `version` are the prior and target database versions (`old` is `0` on first
 * create); `stores` manages whole stores and `indexes` manages secondary indexes.
 * Everything invoked here must stay within the versionchange transaction — no
 * non-IDB `await`, or it auto-commits and the upgrade fails.
 */
export interface IndexedDBUpgradeContext {
	readonly transaction: IDBTransaction
	readonly old: number
	readonly version: number
	readonly stores: IndexedDBUpgradeStoreManagerInterface
	readonly indexes: IndexedDBUpgradeIndexManagerInterface
}

/**
 * Represents the options for `createIndexedDBDatabase`.
 *
 * @remarks
 * `name` is passed to `indexedDB.open`. `version` is optional: give it to pin an
 * explicit schema version (a higher number than the stored one triggers an upgrade
 * that creates any missing `stores`); omit it for **auto-managed** mode, where the
 * database opens at its current version and bumps once to create any declared store
 * the stored schema is missing — so adding a store never needs a manual version
 * bump. `upgrade` runs after the built-in create-missing-stores pass, inside the
 * same versionchange transaction — use it to drop a store with
 * `context.stores.drop`, add or remove an index on any store with
 * `context.indexes.create` / `context.indexes.drop`, or migrate data with
 * `context.stores.store(name)`. It may return `void` or a `Promise<void>` — an async
 * `upgrade` may `await` the IDB requests it issues through `context.stores.store(...)`
 * (see the auto-commit rule on {@link IndexedDBUpgradeContext}). The built-in
 * pass and custom callback share one failure boundary: a synchronous failure in
 * either phase, or a custom rejection captured while the versionchange
 * transaction remains active, aborts the transaction atomically and rejects
 * `connect()` with an `IndexedDBError` (code `UPGRADE`). Its `cause` is the
 * initiating value even when that value is `undefined`; a native schema fault
 * is nested through its typed wrapper (for example, `UPGRADE` → `CONSTRAINT` →
 * native `ConstraintError`). The same handle may retry after a failed open. If
 * auto-commit already occurred but the browser reports success after a failure
 * was recorded, that connection is closed before `connect()` rejects; the
 * committed schema cannot then be rolled back. A rejection that arrives only
 * after the open request already succeeded cannot be recovered retroactively.
 */
export interface IndexedDBDatabaseOptions<Stores extends IndexedDBSchema = IndexedDBSchema> {
	readonly name: string
	readonly version?: number
	readonly stores: Stores
	readonly upgrade?: (context: IndexedDBUpgradeContext) => void | Promise<void>
}

/**
 * Represents the options for opening a cursor.
 *
 * @remarks
 * `query` restricts iteration to a key range (or a single key), and omitting it
 * iterates every record; `direction` sets the traversal order (`next` / `prev` /
 * their `unique` variants).
 */
export interface IndexedDBCursorOptions {
	readonly query?: IDBKeyRange | IDBValidKey
	readonly direction?: IDBCursorDirection
}

// === Cursor

/**
 * Represents a promisified value cursor for streaming and in-place mutation.
 *
 * @remarks
 * Wraps `IDBCursorWithValue`. `key` / `primary` / `value` snapshot the current
 * position (IndexedDB reuses the live cursor object on advance, so they are read
 * eagerly). `value` is the record at that position narrowed with `isRecord`, and
 * `undefined` when the stored value is not a record — the same absence
 * `readRecord` reports for that boundary. `continue` / `seek` / `advance` resolve
 * to the next cursor or `null` at the end, and `seek` is valid only on a cursor
 * whose `source` is an index — on a store cursor it throws; `update` / `remove`
 * mutate the record at the current position. Every move returns the cursor at the
 * new position and leaves this one on its own snapshot, so rebind at each step
 * rather than reusing the wrapper you moved from. The owning transaction stays
 * alive only while you drive the cursor promptly — do no unrelated `await`
 * between steps, or it auto-commits.
 */
export interface IndexedDBCursorInterface {
	readonly cursor: IDBCursorWithValue
	readonly source: IDBObjectStore | IDBIndex
	readonly key: IDBValidKey
	readonly primary: IDBValidKey
	readonly value: Row | undefined
	readonly direction: IDBCursorDirection
	continue(key?: IDBValidKey): Promise<IndexedDBCursorInterface | null>
	/**
	 * Advances to a given index key and primary key.
	 *
	 * @remarks
	 * Valid only on a cursor whose `source` is an index. It drives the native
	 * `continuePrimaryKey`, which IndexedDB defines for an index cursor alone.
	 *
	 * @param key - The index key to advance to
	 * @param primary - The primary key to land on within that index key
	 * @returns The cursor at the new position, or `null` past the end
	 * @throws An {@link IndexedDBError} of code `UNKNOWN` when the cursor's source
	 *   is an object store: the native call raises `InvalidAccessError`, a name
	 *   `ERROR_CODES` does not map
	 */
	seek(key: IDBValidKey, primary: IDBValidKey): Promise<IndexedDBCursorInterface | null>
	advance(count: number): Promise<IndexedDBCursorInterface | null>
	update(value: Row): Promise<IDBValidKey>
	remove(): Promise<void>
}

// === Index

/**
 * Represents a secondary index — read access by an indexed key path.
 *
 * @remarks
 * Indexes are read-only views over a store. `get` / `resolve` fetch the first
 * record for an index key (`resolve` throws `NOT_FOUND` on a miss); `records` /
 * `keys` read many (the matching records, and their **primary** keys); `primary`
 * maps an index key to one primary key; `count` / `has` test presence; `cursor`
 * streams matches. A read of several keys is the array overload of the same verb
 * (`.claude/rules/patterns.md` § Managers § Batch operations).
 */
export interface IndexedDBIndexInterface {
	readonly name: string
	readonly path: KeyPath
	readonly unique: boolean
	readonly multiple: boolean
	get(keys: readonly IDBValidKey[]): Promise<ReadonlyArray<Row | undefined>>
	get(key: IDBValidKey): Promise<Row | undefined>
	resolve(keys: readonly IDBValidKey[]): Promise<readonly Row[]>
	resolve(key: IDBValidKey): Promise<Row>
	records(query?: IDBKeyRange | IDBValidKey, count?: number): Promise<readonly Row[]>
	keys(query?: IDBKeyRange | IDBValidKey, count?: number): Promise<readonly IDBValidKey[]>
	primary(key: IDBValidKey): Promise<IDBValidKey | undefined>
	has(keys: readonly IDBValidKey[]): Promise<readonly boolean[]>
	has(key: IDBValidKey): Promise<boolean>
	count(query?: IDBKeyRange | IDBValidKey): Promise<number>
	cursor(options?: IndexedDBCursorOptions): Promise<IndexedDBCursorInterface | null>
}

// === Record store

/**
 * Represents the keyed record surface of an object store, in or out of an explicit
 * transaction.
 *
 * @remarks
 * The member set {@link IndexedDBStoreInterface} and
 * {@link IndexedDBTransactionStoreInterface} share, declared once so neither can
 * drift from the other. `get` / `resolve` read by key (`resolve` throws
 * `NOT_FOUND`); `records` / `keys` read many over an optional key range; `has` /
 * `count` test presence; `set` upserts and `add` inserts (throwing `CONSTRAINT`
 * on a duplicate); `remove` deletes; `clear` empties the store; `cursor` streams.
 * The keyed verbs batch by their array overload — listed first, because an array is
 * itself a valid record and a compound `IDBValidKey`, so the array signature must
 * win (`.claude/rules/patterns.md` § Managers § Batch operations). To act on a
 * single **compound** key, pass
 * `IDBKeyRange.only([…])` to `records` / `count`.
 */
export interface IndexedDBRecordStoreInterface {
	get(keys: readonly IDBValidKey[]): Promise<ReadonlyArray<Row | undefined>>
	get(key: IDBValidKey): Promise<Row | undefined>
	resolve(keys: readonly IDBValidKey[]): Promise<readonly Row[]>
	resolve(key: IDBValidKey): Promise<Row>
	records(query?: IDBKeyRange | IDBValidKey, count?: number): Promise<readonly Row[]>
	keys(query?: IDBKeyRange | IDBValidKey, count?: number): Promise<readonly IDBValidKey[]>
	has(keys: readonly IDBValidKey[]): Promise<readonly boolean[]>
	has(key: IDBValidKey): Promise<boolean>
	count(query?: IDBKeyRange | IDBValidKey): Promise<number>
	set(values: readonly Row[]): Promise<readonly IDBValidKey[]>
	set(value: Row, key?: IDBValidKey): Promise<IDBValidKey>
	add(values: readonly Row[]): Promise<readonly IDBValidKey[]>
	add(value: Row, key?: IDBValidKey): Promise<IDBValidKey>
	remove(keys: readonly IDBValidKey[]): Promise<void>
	remove(key: IDBValidKey): Promise<void>
	clear(): Promise<void>
	cursor(options?: IndexedDBCursorOptions): Promise<IndexedDBCursorInterface | null>
}

// === Store

/**
 * Represents an object store — the keyed record surface plus the store's own schema
 * metadata and `index` accessor.
 *
 * @remarks
 * {@link IndexedDBRecordStoreInterface} plus the store's own schema metadata and
 * `index` accessor. Each call runs in its own implicit transaction; for atomic
 * multi-operation work use the database's `read` / `write`. `path` is the in-line
 * key path, and `undefined` for an out-of-line store, exactly as
 * {@link StoreDefinition} declares it.
 */
export interface IndexedDBStoreInterface extends IndexedDBRecordStoreInterface {
	readonly name: string
	readonly path: KeyPath | undefined
	readonly indexes: readonly string[]
	readonly increment: boolean
	index(name: string): IndexedDBIndexInterface
}

// === Transaction store

/**
 * Represents an object store bound to an explicit transaction.
 *
 * @remarks
 * The same {@link IndexedDBRecordStoreInterface} surface as
 * {@link IndexedDBStoreInterface}, but every call runs in the owning transaction
 * (opened by the database's `read` / `write`) rather than its own — so a sequence
 * of reads and writes is atomic. It drops `index` and the standalone
 * implicit-transaction conveniences; reach the live `store` for those.
 */
export interface IndexedDBTransactionStoreInterface extends IndexedDBRecordStoreInterface {
	readonly store: IDBObjectStore
}

// === Transaction

/**
 * Represents an explicit transaction over one or more stores.
 *
 * @remarks
 * Obtained through the `scope` callback of the database's `read` / `write`. `store`
 * reaches a typed, transaction-bound store; the transaction commits automatically
 * when the scope resolves, or rolls back if it throws or `abort` is called.
 * `active` and `finished` are complements over one settled fact, not two
 * independent ones: `active` is true while the transaction still accepts
 * operations, and `finished` is true after commit or abort.
 */
export interface IndexedDBTransactionInterface<Stores extends IndexedDBSchema = IndexedDBSchema> {
	readonly transaction: IDBTransaction
	readonly mode: IDBTransactionMode
	readonly stores: readonly string[]
	readonly active: boolean
	readonly finished: boolean
	readonly error: DOMException | null
	store<K extends keyof Stores & string>(name: K): IndexedDBTransactionStoreInterface
	abort(): void
	commit(): void
}

// === Database

/**
 * Represents a browser-native IndexedDB database.
 *
 * @remarks
 * A typed, Promise-based handle over `IDBDatabase`. It connects lazily on first
 * use (`connect`, also awaited by every store operation); `store` reaches a typed
 * store; `read` / `write` run an atomic scope over one or more stores; `close`
 * releases the connection and `drop` deletes the database. `stores` lists the
 * declared (or, after it opens, the live) store names; `open` reports whether a live
 * connection is held. Native blocked notifications are progress rather than
 * terminal faults: `connect` / `drop` stay pending until the blocking connection
 * closes and the native request succeeds or errors. `close` permanently retires
 * the handle; if an in-flight open later succeeds, its result is closed and that
 * pending `connect` rejects with `CLOSED`.
 */
export interface IndexedDBDatabaseInterface<Stores extends IndexedDBSchema = IndexedDBSchema> {
	readonly database: IDBDatabase
	readonly name: string
	readonly version: number
	readonly stores: readonly string[]
	readonly open: boolean
	connect(): Promise<IDBDatabase>
	store<K extends keyof Stores & string>(name: K): IndexedDBStoreInterface
	read(
		stores: (keyof Stores & string) | ReadonlyArray<keyof Stores & string>,
		scope: (transaction: IndexedDBTransactionInterface<Stores>) => void | Promise<void>,
	): Promise<void>
	write(
		stores: (keyof Stores & string) | ReadonlyArray<keyof Stores & string>,
		scope: (transaction: IndexedDBTransactionInterface<Stores>) => void | Promise<void>,
	): Promise<void>
	close(): void
	drop(): Promise<void>
}
