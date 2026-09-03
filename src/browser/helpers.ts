import type { IndexDefinition, Row } from './types.js'
import { isRecord } from '@orkestrel/contract'
import { ERROR_CODES } from './constants.js'
import { IndexedDBError } from './errors.js'

// The browser surface's cross-cutting helpers: the feature-detection probe a
// consumer runs *before* entering the rest of this module (`supportsIndexedDB`,
// to fall back to another storage strategy where storage is absent), and the
// wrapper's foundation — the two Promise bridges every class builds on
// (`IDBRequest` → value, `IDBTransaction` → completion), the key-range builders
// that name a boundary the native call states as a bare boolean, and the small
// read primitives the store / index / transaction-store classes share over a native
// `IDBObjectStore | IDBIndex`, each narrowing the structured clone to a `Row`
// with `isRecord` at the boundary (the same `as`-free bridge used throughout).

/**
 * Checks whether IndexedDB is available in this environment.
 *
 * @remarks
 * Gate IndexedDB code with this and fall back to another storage strategy where
 * it is absent (a non-browser runtime, a privacy mode that disables storage).
 * The entry probe, checked before reaching for the rest of this module.
 *
 * @returns True if `globalThis.indexedDB` exists; false otherwise
 */
export function supportsIndexedDB(): boolean {
	return typeof globalThis.indexedDB !== 'undefined'
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
				reject(wrapError(request.error))
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
		transaction.addEventListener('error', () => reject(wrapError(transaction.error)))
		transaction.addEventListener('abort', () => reject(wrapError(transaction.error)))
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
		if (error instanceof DOMException) throw wrapError(error)
		throw error
	}
}

/**
 * Reads one record by key from a store or index, narrowing it to a {@link Row}.
 *
 * @remarks
 * The shared point-read of every store-like class (`IndexedDBStore`,
 * `IndexedDBIndex`, `IndexedDBTransactionStore`): issue the native `get`, then
 * narrow the structured clone with `isRecord` — a non-record (or a miss) reads as
 * `undefined`, never an unchecked cast. On an index, `source.get` returns the
 * first record for the index key.
 *
 * @param source - The object store or index to read from
 * @param key - The key (a primary key for a store, an index key for an index)
 * @returns The record, or `undefined` on a miss
 */
export async function readRecord(
	source: IDBObjectStore | IDBIndex,
	key: IDBValidKey,
): Promise<Row | undefined> {
	const value = await promisifyRequest<unknown>(wrapCall(() => source.get(key)))
	return isRecord(value) ? value : undefined
}

/**
 * Reads many records from a store or index over an optional key range.
 *
 * @remarks
 * The shared bulk read of every store-like class: issue the native `getAll` over
 * an optional `query` (a key range or a single key) and `count` cap, then keep
 * only the records with `isRecord` — the same boundary narrowing as
 * {@link readRecord}, applied across the batch.
 *
 * @param source - The object store or index to read from
 * @param query - A key range or single key to restrict the read; omit it to read every record
 * @param count - The maximum number of records to read
 * @returns The matching records
 */
export async function readRecords(
	source: IDBObjectStore | IDBIndex,
	query?: IDBKeyRange | IDBValidKey,
	count?: number,
): Promise<readonly Row[]> {
	const all = await promisifyRequest<unknown[]>(wrapCall(() => source.getAll(query, count)))
	return all.filter(isRecord)
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
	const keyPath = typeof definition.path === 'string' ? definition.path : [...definition.path]
	store.createIndex(definition.name, keyPath, {
		unique: definition.unique ?? false,
		multiEntry: definition.multiple ?? false,
	})
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
 * Builds a key range starting at one key.
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
 * Builds a key range ending at one key.
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
 * @param value - The required string prefix
 * @returns A closed range spanning every matching string
 */
export function rangePrefix(value: string): IDBKeyRange {
	// U+FFFF sorts above any normal code unit, capping the range without excluding the prefix.
	return IDBKeyRange.bound(value, value + '￿', false, false)
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
export function wrapError(error: DOMException | null): IndexedDBError {
	if (error === null) return new IndexedDBError('UNKNOWN', 'Unknown IndexedDB error')
	const code = ERROR_CODES[error.name] ?? 'UNKNOWN'
	return new IndexedDBError(code, error.message || `IndexedDB error: ${error.name}`, error)
}
