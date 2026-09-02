import { isRecord } from '@orkestrel/contract'
import type { IndexedDBCursorInterface, Row } from './types.js'
import { guardSync, promisifyRequest } from './helpers.js'

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
 * `IndexedDBCursor`) or `null` at the end. `update` / `delete` act on the current
 * record — they require the cursor's transaction to be `readwrite` (a `store`
 * cursor), so they reject on an `index` cursor's read-only transaction.
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
		guardSync(() => {
			if (key === undefined) this.#cursor.continue()
			else this.#cursor.continue(key)
		})
		return this.#next()
	}

	async seek(key: IDBValidKey, primary: IDBValidKey): Promise<IndexedDBCursorInterface | null> {
		guardSync(() => this.#cursor.continuePrimaryKey(key, primary))
		return this.#next()
	}

	async advance(count: number): Promise<IndexedDBCursorInterface | null> {
		guardSync(() => this.#cursor.advance(count))
		return this.#next()
	}

	async update(value: Row): Promise<IDBValidKey> {
		const key = await promisifyRequest(guardSync(() => this.#cursor.update(value)))
		this.#value = value
		return key
	}

	async delete(): Promise<void> {
		await promisifyRequest(guardSync(() => this.#cursor.delete()))
	}

	// Await the shared request after a move, wrapping the next position (or null).
	async #next(): Promise<IndexedDBCursorInterface | null> {
		const next = await promisifyRequest(this.#request)
		return next ? new IndexedDBCursor(next, this.#request) : null
	}
}
