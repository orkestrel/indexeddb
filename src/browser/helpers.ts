import type { IndexDefinition, StoreRecord } from './types.js'
import {
	isEmptyString,
	isInstance,
	isObject,
	isRecord,
	isString,
	isUndefined,
	preview,
} from '@orkestrel/contract'
import { ERROR_CODES } from './constants.js'
import { IndexedDBError } from './errors.js'

// The browser surface's cross-cutting helpers: the feature-detection probe a
// consumer runs *before* entering the rest of this module (`supportsIndexedDB`,
// to fall back to another storage strategy where storage is absent), and the
// wrapper's foundation — the two Promise bridges every class builds on
// (`IDBRequest` → value, `IDBTransaction` → completion), the key-range builders
// that name a boundary the native call states as a bare boolean, and the small
// read primitives the store / index / transaction-store classes share over a native
// `IDBObjectStore | IDBIndex`, each checking the structured clone with `isRecord` at the
// boundary and raising `RECORD` for a value that is no record (the same `as`-free bridge
// used throughout).

/**
 * Checks whether IndexedDB is available in this environment.
 *
 * @remarks
 * Gate IndexedDB code with this and fall back to another storage strategy where
 * it is absent (a non-browser runtime, a privacy mode that disables storage).
 * The entry probe, checked before reaching for the rest of this module.
 *
 * @returns True if `globalThis.indexedDB` is an object; false otherwise
 */
export function supportsIndexedDB(): boolean {
	return isObject(globalThis.indexedDB)
}

/**
 * Resolves an `IDBRequest` to its result, rejecting with an {@link IndexedDBError}.
 *
 * @remarks
 * The single bridge from IndexedDB's event-based requests to Promises. Issue the
 * request, then `await` this — within an implicit transaction, issue every request
 * for that transaction before the first `await`, so they share it.
 *
 * @param request - The pending request
 * @returns Its `result` on success
 */
export function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		// One `AbortController` over both listeners, aborted by whichever settles the
		// promise: `IndexedDBCursor` re-arms ONE shared `IDBRequest` for a whole walk,
		// so listeners that outlive their own settlement accumulate on that request
		// for the owning transaction's life and still run on every later firing.
		// `{ once: true }` does not close this — it removes only the listener that
		// fired and leaves its sibling attached, so the growth stays linear.
		const settled = new AbortController()
		request.addEventListener(
			'success',
			() => {
				settled.abort()
				resolve(request.result)
			},
			{ signal: settled.signal },
		)
		request.addEventListener(
			'error',
			() => {
				settled.abort()
				reject(wrapDOMException(request.error))
			},
			{ signal: settled.signal },
		)
	})
}

/**
 * Resolves after an `IDBTransaction` commits, rejecting if it errors or aborts.
 *
 * @remarks
 * Await this after issuing the writes of a `readwrite` transaction to guarantee
 * they are durable before continuing.
 *
 * @param transaction - The transaction to await
 */
export function promisifyTransaction(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		// `addEventListener` rather than the `on*` slots: a caller may already have
		// its own `on*` handlers on this transaction (`IndexedDBTransaction`'s
		// constructor tracks `active` / `finished` the same way) — assigning would
		// clobber whichever handler ran second to set up.
		transaction.addEventListener('complete', () => resolve())
		transaction.addEventListener('error', () => reject(wrapDOMException(transaction.error)))
		transaction.addEventListener('abort', () => reject(wrapDOMException(transaction.error)))
	})
}

/**
 * Runs a synchronous native IndexedDB call, wrapping a thrown `DOMException`
 * into a typed {@link IndexedDBError}.
 *
 * @remarks
 * Native IndexedDB throws SYNCHRONOUSLY (not through a request's `onerror`)
 * from calls like `database.transaction(...)` or an inactive/closed store's
 * `get` / `put` / `openCursor` — `TransactionInactiveError` /
 * `InvalidStateError` never reach {@link promisifyRequest}'s `onerror`
 * bridge. Every request-issuing call site wraps its native invocation in this
 * so those faults surface as the same typed `IndexedDBError` as an
 * asynchronous one.
 *
 * @param action - The synchronous native call to run
 * @returns Its return value
 */
export function wrapCall<T>(action: () => T): T {
	try {
		return action()
	} catch (error) {
		if (isInstance(error, DOMException)) throw wrapDOMException(error)
		throw error
	}
}

/**
 * Reads one record by key from a store or index, narrowing it to a {@link StoreRecord}.
 *
 * @remarks
 * The shared point-read of every store-like class (`IndexedDBStore`,
 * `IndexedDBIndex`, `IndexedDBTransactionStore`): issue the native `get`, then
 * check the structured clone with `isRecord`. A miss reads as `undefined`, and so
 * does a stored `undefined`, which the native `get` cannot tell apart from a miss.
 * On an index, `source.get` returns the first record for the index key.
 *
 * A clean read issues one request. On a store, a refusal names the key argument,
 * which is the primary key. On an index, a refusal issues `get` and `getKey` back
 * to back, with no `await` between them, so no request the caller queued after the
 * failing read runs between the two; it names the primary key `getKey` reads when
 * that pair still holds a value that is no record, and no key otherwise.
 *
 * @param source - The object store or index to read from
 * @param key - The key (a primary key for a store, an index key for an index)
 * @returns The record, or `undefined` on a miss
 * @throws An {@link IndexedDBError} of code `RECORD` when the stored value is no
 *   record; its `context` names the store, the index on an index, and the primary
 *   `key` where the read names one
 */
export async function readRecord(
	source: IDBObjectStore | IDBIndex,
	key: IDBValidKey,
): Promise<StoreRecord | undefined> {
	const value = await promisifyRequest<unknown>(wrapCall(() => source.get(key)))
	if (isUndefined(value) || isRecord(value)) return value
	if (!('objectStore' in source)) throw buildRecordError(source, key)
	const [again, primary] = await Promise.all([
		promisifyRequest<unknown>(wrapCall(() => source.get(key))),
		promisifyRequest(wrapCall(() => source.getKey(key))),
	])
	throw buildRecordError(source, isUndefined(again) || isRecord(again) ? undefined : primary)
}

/**
 * Reads many records from a store or index over an optional key range, narrowing each
 * to a `StoreRecord`.
 *
 * @remarks
 * The shared bulk read of every store-like class: issue the native `getAll` over
 * an optional `query` (a key range or a single key) and `count` cap, then check
 * every value with `isRecord`, the same boundary as {@link readRecord}. A clean
 * read returns the native array and issues no further request.
 *
 * A refusal issues `getAll` and `getAllKeys` over the same `query` and `count` back
 * to back, with no `await` between them, so no request the caller queued after the
 * failing read runs between the two. It names the primary key at the position of
 * the first value in that pair that is no record. Both requests read one snapshot of the
 * transaction, so the two lists align. It names no key when the pair holds none: the
 * value left before its key was read.
 *
 * @param source - The object store or index to read from
 * @param query - A key range or single key to restrict the read; omit it to read every record
 * @param count - The maximum number of records to read
 * @returns The matching records
 * @throws An {@link IndexedDBError} of code `RECORD` when any value read is no
 *   record; its `context` names the store, the index on an index, and the primary
 *   `key` where the pair names one
 */
export async function readRecords(
	source: IDBObjectStore | IDBIndex,
	query?: IDBKeyRange | IDBValidKey,
	count?: number,
): Promise<readonly StoreRecord[]> {
	const all = await promisifyRequest<unknown[]>(wrapCall(() => source.getAll(query, count)))
	if (all.every(isRecord)) return all
	const [again, keys] = await Promise.all([
		promisifyRequest<unknown[]>(wrapCall(() => source.getAll(query, count))),
		promisifyRequest(wrapCall(() => source.getAllKeys(query, count))),
	])
	const position = again.findIndex((value) => !isRecord(value))
	throw buildRecordError(source, position < 0 ? undefined : keys[position])
}

/**
 * Builds the `RECORD` error a read raises for a stored value that is no record.
 *
 * @remarks
 * The one refusal {@link readRecord}, {@link readRecords}, and a cursor's `value`
 * share. The `context` holds `store`, `index` when `source` is an index, and `key`
 * when the caller passes one; the message names the same facts, encoding the key through
 * `preview` from `@orkestrel/contract`, JSON-encoded and length-capped. With no `key`, the
 * message states that the value left before its key was read. Neither carries the
 * stored value, which can hold data the caller must not log.
 *
 * @param source - The object store or index the value was read from
 * @param key - The primary key of the entry, when the read knows it
 * @returns The typed error, for the caller to throw
 *
 * @example
 * ```ts
 * import { buildRecordError } from '@orkestrel/indexeddb'
 *
 * const books = database.transaction(['books'], 'readonly').objectStore('books')
 * buildRecordError(books, 'b').context // { store: 'books', key: 'b' }
 * ```
 */
export function buildRecordError(
	source: IDBObjectStore | IDBIndex,
	key?: IDBValidKey,
): IndexedDBError {
	const store = 'objectStore' in source ? source.objectStore.name : source.name
	const index = 'objectStore' in source ? source.name : undefined
	const named = [
		`store ${preview(store)}`,
		...(index === undefined ? [] : [`index ${preview(index)}`]),
		...(key === undefined ? [] : [`key ${preview(key)}`]),
	]
	const remedy =
		key === undefined
			? 'the value left before its key was read, so read again to find the entry'
			: 'rewrite or remove the entry'
	return new IndexedDBError(
		'RECORD',
		`Stored value is not a record (${named.join(', ')}); ${remedy}`,
		undefined,
		{ store, ...(index === undefined ? {} : { index }), ...(key === undefined ? {} : { key }) },
	)
}

/**
 * Checks whether a key is present in a store or index.
 *
 * @remarks
 * The shared presence test of every store-like class: a native `count` of the
 * key, true when at least one record matches — cheaper than reading the record
 * when only existence matters.
 *
 * @param source - The object store or index to test
 * @param key - The key to look for
 * @returns True if at least one record has the key; false otherwise
 */
export async function hasKey(
	source: IDBObjectStore | IDBIndex,
	key: IDBValidKey,
): Promise<boolean> {
	return (await promisifyRequest(wrapCall(() => source.count(key)))) > 0
}

/**
 * Creates a secondary index on a store from its {@link IndexDefinition}.
 *
 * @remarks
 * The shared index-DDL leaf used both by the built-in create-missing-stores pass
 * (`IndexedDBDatabase`'s internal store creation) and by an upgrade's
 * `context.indexes.create`: translate the definition's `path` to a native key path
 * and `unique` / `multiple` to `unique` / `multiEntry`, then issue `createIndex`.
 * Versionchange-only — `store` must be inside an active upgrade transaction.
 *
 * @param store - The object store to add the index to
 * @param definition - The index to create
 */
export function createIndex(store: IDBObjectStore, definition: IndexDefinition): void {
	const keyPath = isString(definition.path) ? definition.path : [...definition.path]
	store.createIndex(definition.name, keyPath, {
		unique: definition.unique ?? false,
		multiEntry: definition.multiple ?? false,
	})
}

/**
 * Scans a stored index against its declaration and returns the members that differ.
 *
 * @remarks
 * Compares the key path, `unique`, and `multiple` (the native `multiEntry`), each
 * read the way {@link createIndex} writes it, so an index `createIndex` built from
 * `definition` returns no difference. The database's built-in index pass and its
 * auto-managed open both read this.
 *
 * @param index - The stored native index
 * @param definition - The declared index of the same name
 * @returns The differing members among `path`, `unique`, and `multiple`, empty on a match
 *
 * @example
 * ```ts
 * import { scanIndex } from '@orkestrel/indexeddb'
 *
 * const byName = database.transaction(['users']).objectStore('users').index('byName')
 * scanIndex(byName, { name: 'byName', path: 'name', unique: true }) // ['unique'] on a non-unique index
 * ```
 */
export function scanIndex(index: IDBIndex, definition: IndexDefinition): readonly string[] {
	const stored = index.keyPath
	const declared = definition.path
	const path = isString(declared)
		? stored === declared
		: !isString(stored) &&
			stored.length === declared.length &&
			declared.every((part, position) => stored[position] === part)
	return [
		...(path ? [] : ['path']),
		...(index.unique === (definition.unique ?? false) ? [] : ['unique']),
		...(index.multiEntry === (definition.multiple ?? false) ? [] : ['multiple']),
	]
}

/**
 * Builds a key range strictly above one key.
 *
 * @param value - The excluded lower boundary
 * @returns A range containing keys greater than `value`
 */
export function rangeAboveKey(value: IDBValidKey): IDBKeyRange {
	return IDBKeyRange.lowerBound(value, true)
}

/**
 * Builds a key range starting at and including one key.
 *
 * @param value - The included lower boundary
 * @returns A range containing keys greater than or equal to `value`
 */
export function rangeFromKey(value: IDBValidKey): IDBKeyRange {
	return IDBKeyRange.lowerBound(value, false)
}

/**
 * Builds a key range strictly below one key.
 *
 * @param value - The excluded upper boundary
 * @returns A range containing keys less than `value`
 */
export function rangeBelowKey(value: IDBValidKey): IDBKeyRange {
	return IDBKeyRange.upperBound(value, true)
}

/**
 * Builds a key range ending at and including one key.
 *
 * @param value - The included upper boundary
 * @returns A range containing keys less than or equal to `value`
 */
export function rangeToKey(value: IDBValidKey): IDBKeyRange {
	return IDBKeyRange.upperBound(value, false)
}

/**
 * Builds a key range containing every string with one prefix.
 *
 * @remarks
 * The upper bound is the prefix's successor, excluded: the prefix with its trailing
 * U+FFFF code units dropped and its final code unit incremented. A prefix with no
 * successor, the empty string or one of U+FFFF alone, closes at an empty binary key,
 * excluded: IndexedDB orders every string below every binary and array key, so no
 * key that is not a string enters the range.
 *
 * @param value - The required string prefix
 * @returns A range from `value` up to, and excluding, its successor
 */
export function rangePrefix(value: string): IDBKeyRange {
	const stem = value.replace(/\uFFFF+$/u, '')
	if (isEmptyString(stem)) return IDBKeyRange.bound(value, new ArrayBuffer(0), false, true)
	const successor = stem.slice(0, -1) + String.fromCharCode(stem.charCodeAt(stem.length - 1) + 1)
	return IDBKeyRange.bound(value, successor, false, true)
}

/**
 * Maps a native IndexedDB `DOMException` to a typed {@link IndexedDBError}.
 *
 * @remarks
 * The boundary the two Promise bridges ({@link promisifyRequest} /
 * {@link promisifyTransaction}) share: it reads {@link ERROR_CODES} to pick the
 * machine-readable code for the native `name`, falling back to `UNKNOWN` for an
 * unmapped name or a `null` error.
 *
 * @param error - The native error, or `null` when none is attached
 * @returns The wrapped, typed error
 */
export function wrapDOMException(error: DOMException | null): IndexedDBError {
	if (error === null) return new IndexedDBError('UNKNOWN', 'Unknown IndexedDB error')
	const code = ERROR_CODES[error.name] ?? 'UNKNOWN'
	return new IndexedDBError(code, error.message || `IndexedDB error: ${error.name}`, error)
}
