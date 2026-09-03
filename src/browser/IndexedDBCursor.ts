import type { IndexedDBCursorInterface, Row } from './types.js'
import { isRecord } from '@orkestrel/contract'
import { promisifyRequest, wrapCall } from './helpers.js'

/**
 * Represents a promisified value cursor over an object store or index.
 *
 * @remarks
 * Wraps `IDBCursorWithValue` and the request that drives it. The position
 * (`key` / `primary` / `value`) is snapshot at construction because IndexedDB
 * mutates the live cursor object in place on each advance. `value` narrows the
 * stored value with `isRecord` and is `undefined` when that value is not a
 * record, the same absence `readRecord` reports. `continue` / `seek` /
 * `advance` re-arm the shared request and resolve to the next position (a fresh
 * `IndexedDBCursor`) or `null` at the end. `update` / `remove` act on the current
 * record — they require the cursor's transaction to be `readwrite` (a `store`
 * cursor), so they reject on an `index` cursor's read-only transaction.
 *
 * @example
 * ```ts
 * import { IndexedDBCursor, promisifyRequest } from '@orkestrel/indexeddb'
 *
 * // The open request and its first result — the pair `store.cursor()` builds
 * // internally, over a live `IDBDatabase` a consumer already holds.
 * const request = database.transaction(['users'], 'readwrite').objectStore('users').openCursor()
 * const native = await promisifyRequest(request)
 * const cursor = native === null ? null : new IndexedDBCursor(native, request)
 * if (cursor?.value) await cursor.update({ ...cursor.value, seen: true })
 * ```
 */
export class IndexedDBCursor implements IndexedDBCursorInterface {
	readonly #cursor: IDBCursorWithValue
	readonly #request: IDBRequest<IDBCursorWithValue | null>
	readonly #key: IDBValidKey
	readonly #primary: IDBValidKey
	#value: Row | undefined
	readonly #direction: IDBCursorDirection

	constructor(cursor: IDBCursorWithValue, request: IDBRequest<IDBCursorWithValue | null>) {
		this.#cursor = cursor
		this.#request = request
		this.#key = cursor.key
		this.#primary = cursor.primaryKey
		this.#value = isRecord(cursor.value) ? cursor.value : undefined
		this.#direction = cursor.direction
	}

	get cursor(): IDBCursorWithValue {
		return this.#cursor
	}

	get source(): IDBObjectStore | IDBIndex {
		return this.#cursor.source
	}

	get key(): IDBValidKey {
		return this.#key
	}

	get primary(): IDBValidKey {
		return this.#primary
	}

	get value(): Row | undefined {
		return this.#value
	}

	get direction(): IDBCursorDirection {
		return this.#direction
	}

	async continue(key?: IDBValidKey): Promise<IndexedDBCursorInterface | null> {
		wrapCall(() => {
			if (key === undefined) this.#cursor.continue()
			else this.#cursor.continue(key)
		})
		return this.#next()
	}

	async seek(key: IDBValidKey, primary: IDBValidKey): Promise<IndexedDBCursorInterface | null> {
		wrapCall(() => this.#cursor.continuePrimaryKey(key, primary))
		return this.#next()
	}

	async advance(count: number): Promise<IndexedDBCursorInterface | null> {
		wrapCall(() => this.#cursor.advance(count))
		return this.#next()
	}

	async update(value: Row): Promise<IDBValidKey> {
		const key = await promisifyRequest(wrapCall(() => this.#cursor.update(value)))
		this.#value = value
		return key
	}

	async remove(): Promise<void> {
		await promisifyRequest(wrapCall(() => this.#cursor.delete()))
	}

	// Await the shared request after a move, wrapping the next position (or null).
	async #next(): Promise<IndexedDBCursorInterface | null> {
		const next = await promisifyRequest(this.#request)
		return next ? new IndexedDBCursor(next, this.#request) : null
	}
}
