import type { Row } from '@src/core'

// The lean browser-native IndexedDB surface — a typed, Promise-based wrapper over
// the raw `IDBDatabase` / `IDBObjectStore` / `IDBIndex` / `IDBTransaction` API.
// It exposes the capabilities the core database layer CANNOT express over its
// portable `scan` — secondary indexes, native key ranges, cursors, and native
// multi-store transactions — and nothing it can: there is **no** query / filter /
// sort / aggregate builder here (that is the core engine, running over `scan`).
// The IndexedDB `DriverInterface` is built on this wrapper; standalone browser
// code can use it directly. Types are the source of truth (AGENTS §2).
//
// Values are the core `Row` (a record), narrowed from IndexedDB's structured
// clone with `isRecord` at the read boundary — the same `as`-free bridge the core
// driver uses. Keys are the full native `IDBValidKey` (a superset of the core
// `Key`), so the wrapper speaks IndexedDB's whole key space.

// === Errors

/**
 * A machine-readable {@link IndexedDBError} code.
 *
 * @remarks
 * Each maps from a native `DOMException.name` or a wrapper-lifecycle fault:
 * `NOT_OPEN` (used before `connect`), `CLOSED` (used after `close`), `NOT_FOUND`
 * (a `resolve` miss), `CONSTRAINT` (a unique-key violation), `QUOTA` (storage
 * full), `ABORTED` (a transaction rolled back), `BLOCKED` (an open held up by
 * another live connection), `DATA` (an invalid key or value), `OPEN` /
 * `UPGRADE` (a failed open or schema upgrade), and `UNKNOWN` (any unmapped fault).
 */
export type IndexedDBErrorCode =
	| 'NOT_OPEN'
	| 'CLOSED'
	| 'NOT_FOUND'
	| 'CONSTRAINT'
	| 'QUOTA'
	| 'ABORTED'
	| 'BLOCKED'
	| 'DATA'
	| 'OPEN'
	| 'UPGRADE'
	| 'UNKNOWN'

// === Schema

/**
 * A key path — one field, or several for a compound key.
 *
 * @remarks
 * A single string addresses one field; an array addresses a compound key over
 * several fields, in order.
 */
export type KeyPath = string | readonly string[]

/**
 * A secondary index on a store.
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
 * A store's schema.
 *
 * @remarks
 * `path` is the in-line key path (omit it for an **out-of-line** store, where the
 * key is passed explicitly to `set` / `add` — what the database driver uses);
 * `increment` auto-generates numeric keys; `indexes` declares secondary indexes.
 * Stores are created from these definitions inside `onupgradeneeded`.
 */
export interface StoreDefinition {
	readonly path?: KeyPath
	readonly increment?: boolean
	readonly indexes?: readonly IndexDefinition[]
}

/** A database's stores — a map of store name to its {@link StoreDefinition}. */
export type StoresShape = Readonly<Record<string, StoreDefinition>>

/**
 * Options for `createIndexedDBDatabase`.
 *
 * @remarks
 * `name` is passed to `indexedDB.open`. `version` is optional: give it to pin an
 * explicit schema version (a higher number than the stored one triggers an upgrade
 * that creates any missing `stores`); omit it for **auto-managed** mode, where the
 * database opens at its current version and bumps once to create any declared store
 * the stored schema is missing — so adding a store never needs a manual version
 * bump. Auto-managed mode is what the database `DriverInterface` uses.
 */
export interface IndexedDBDatabaseOptions<Stores extends StoresShape = StoresShape> {
	readonly name: string
	readonly version?: number
	readonly stores: Stores
}

/**
 * Options for opening a cursor.
 *
 * @remarks
 * `query` restricts iteration to a key range (or a single key); `direction` sets
 * the traversal order (`next` / `prev` / their `unique` variants).
 */
export interface CursorOptions {
	readonly query?: IDBKeyRange | IDBValidKey | null
	readonly direction?: IDBCursorDirection
}

// === Cursor

/**
 * A promisified value cursor for streaming and in-place mutation.
 *
 * @remarks
 * Wraps `IDBCursorWithValue`. `key` / `primary` / `value` snapshot the current
 * position (IndexedDB reuses the live cursor object on advance, so they are read
 * eagerly). `continue` / `seek` / `advance` resolve to the next cursor or `null`
 * at the end; `update` / `delete` mutate the record at the current position. The
 * owning transaction stays alive only while you drive the cursor promptly — do no
 * unrelated `await` between steps, or it auto-commits.
 */
export interface IndexedDBCursorInterface {
	readonly cursor: IDBCursorWithValue
	readonly source: IDBObjectStore | IDBIndex
	readonly key: IDBValidKey
	readonly primary: IDBValidKey
	readonly value: Row
	readonly direction: IDBCursorDirection
	continue(key?: IDBValidKey): Promise<IndexedDBCursorInterface | null>
	seek(key: IDBValidKey, primary: IDBValidKey): Promise<IndexedDBCursorInterface | null>
	advance(count: number): Promise<IndexedDBCursorInterface | null>
	update(value: Row): Promise<IDBValidKey>
	delete(): Promise<void>
}

// === Index

/**
 * A secondary index — read access by an indexed key path.
 *
 * @remarks
 * Indexes are read-only views over a store. `get` / `resolve` fetch the first
 * record for an index key (`resolve` throws `NOT_FOUND` on a miss); `records` /
 * `keys` read many (the matching records, and their **primary** keys); `primary`
 * maps an index key to one primary key; `count` / `has` test presence; `cursor`
 * streams matches. A read of several keys is the array overload of the same verb
 * (AGENTS §9.2).
 */
export interface IndexedDBIndexInterface {
	readonly name: string
	readonly path: KeyPath
	readonly unique: boolean
	readonly multiple: boolean
	get(keys: readonly IDBValidKey[]): Promise<readonly (Row | undefined)[]>
	get(key: IDBValidKey): Promise<Row | undefined>
	resolve(keys: readonly IDBValidKey[]): Promise<readonly Row[]>
	resolve(key: IDBValidKey): Promise<Row>
	records(query?: IDBKeyRange | IDBValidKey | null, count?: number): Promise<readonly Row[]>
	keys(query?: IDBKeyRange | IDBValidKey | null, count?: number): Promise<readonly IDBValidKey[]>
	primary(key: IDBValidKey): Promise<IDBValidKey | undefined>
	has(keys: readonly IDBValidKey[]): Promise<readonly boolean[]>
	has(key: IDBValidKey): Promise<boolean>
	count(query?: IDBKeyRange | IDBValidKey | null): Promise<number>
	cursor(options?: CursorOptions): Promise<IndexedDBCursorInterface | null>
}

// === Store

/**
 * An object store — the full keyed CRUD surface, plus index, count, and cursor
 * access.
 *
 * @remarks
 * Each call runs in its own implicit transaction; for atomic multi-operation work
 * use the database's `read` / `write`. `get` / `resolve` read by key (`resolve`
 * throws `NOT_FOUND`); `records` / `keys` read many over an optional key range;
 * `set` upserts and `add` inserts (throwing `CONSTRAINT` on a duplicate);
 * `remove` deletes; `clear` empties the store. The keyed verbs batch by their
 * array overload — listed first, since an array is itself a valid record and a
 * compound `IDBValidKey`, so the array signature must win (AGENTS §9.2). To act on
 * a single **compound** key, pass `range.only([…])` to `records` / `count`.
 */
export interface IndexedDBStoreInterface {
	readonly name: string
	readonly path: KeyPath | null
	readonly indexes: readonly string[]
	readonly increment: boolean
	get(keys: readonly IDBValidKey[]): Promise<readonly (Row | undefined)[]>
	get(key: IDBValidKey): Promise<Row | undefined>
	resolve(keys: readonly IDBValidKey[]): Promise<readonly Row[]>
	resolve(key: IDBValidKey): Promise<Row>
	records(query?: IDBKeyRange | IDBValidKey | null, count?: number): Promise<readonly Row[]>
	keys(query?: IDBKeyRange | IDBValidKey | null, count?: number): Promise<readonly IDBValidKey[]>
	has(keys: readonly IDBValidKey[]): Promise<readonly boolean[]>
	has(key: IDBValidKey): Promise<boolean>
	count(query?: IDBKeyRange | IDBValidKey | null): Promise<number>
	set(values: readonly Row[]): Promise<readonly IDBValidKey[]>
	set(value: Row, key?: IDBValidKey): Promise<IDBValidKey>
	add(values: readonly Row[]): Promise<readonly IDBValidKey[]>
	add(value: Row, key?: IDBValidKey): Promise<IDBValidKey>
	remove(keys: readonly IDBValidKey[]): Promise<void>
	remove(key: IDBValidKey): Promise<void>
	clear(): Promise<void>
	index(name: string): IndexedDBIndexInterface
	cursor(options?: CursorOptions): Promise<IndexedDBCursorInterface | null>
}

// === Transaction store

/**
 * An object store bound to an explicit transaction.
 *
 * @remarks
 * The same CRUD surface as {@link IndexedDBStoreInterface}, but every call runs in
 * the owning transaction (opened by the database's `read` / `write`) rather than
 * its own — so a sequence of reads and writes is atomic. It drops `index` and the
 * standalone implicit-transaction conveniences; reach the live `store` for those.
 */
export interface IndexedDBTransactionStoreInterface {
	readonly store: IDBObjectStore
	get(keys: readonly IDBValidKey[]): Promise<readonly (Row | undefined)[]>
	get(key: IDBValidKey): Promise<Row | undefined>
	resolve(keys: readonly IDBValidKey[]): Promise<readonly Row[]>
	resolve(key: IDBValidKey): Promise<Row>
	records(query?: IDBKeyRange | IDBValidKey | null, count?: number): Promise<readonly Row[]>
	keys(query?: IDBKeyRange | IDBValidKey | null, count?: number): Promise<readonly IDBValidKey[]>
	has(keys: readonly IDBValidKey[]): Promise<readonly boolean[]>
	has(key: IDBValidKey): Promise<boolean>
	count(query?: IDBKeyRange | IDBValidKey | null): Promise<number>
	set(values: readonly Row[]): Promise<readonly IDBValidKey[]>
	set(value: Row, key?: IDBValidKey): Promise<IDBValidKey>
	add(values: readonly Row[]): Promise<readonly IDBValidKey[]>
	add(value: Row, key?: IDBValidKey): Promise<IDBValidKey>
	remove(keys: readonly IDBValidKey[]): Promise<void>
	remove(key: IDBValidKey): Promise<void>
	clear(): Promise<void>
	cursor(options?: CursorOptions): Promise<IndexedDBCursorInterface | null>
}

// === Transaction

/**
 * An explicit transaction over one or more stores.
 *
 * @remarks
 * Obtained through the `scope` callback of the database's `read` / `write`. `store`
 * reaches a typed, transaction-bound store; the transaction commits automatically
 * when the scope resolves, or rolls back if it throws or `abort` is called.
 * `active` is true while it still accepts operations; `finished` is true after
 * commit or abort.
 */
export interface IndexedDBTransactionInterface<Stores extends StoresShape = StoresShape> {
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
 * A browser-native IndexedDB database.
 *
 * @remarks
 * A typed, Promise-based handle over `IDBDatabase`. It connects lazily on first
 * use (`connect`, also awaited by every store operation); `store` reaches a typed
 * store; `read` / `write` run an atomic scope over one or more stores; `close`
 * releases the connection and `drop` deletes the database. `stores` lists the
 * declared (or, once open, the live) store names; `open` reports whether a live
 * connection is held.
 */
export interface IndexedDBDatabaseInterface<Stores extends StoresShape = StoresShape> {
	readonly database: IDBDatabase
	readonly name: string
	readonly version: number
	readonly stores: readonly string[]
	readonly open: boolean
	connect(): Promise<IDBDatabase>
	store<K extends keyof Stores & string>(name: K): IndexedDBStoreInterface
	read(
		stores: (keyof Stores & string) | readonly (keyof Stores & string)[],
		scope: (tx: IndexedDBTransactionInterface<Stores>) => void | Promise<void>,
	): Promise<void>
	write(
		stores: (keyof Stores & string) | readonly (keyof Stores & string)[],
		scope: (tx: IndexedDBTransactionInterface<Stores>) => void | Promise<void>,
	): Promise<void>
	close(): void
	drop(): Promise<void>
}
