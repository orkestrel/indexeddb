import type { Row } from '@src/core'
import { isRecord } from '@src/core'
import type { IndexedDBCursorInterface } from './types.js'
import { promisifyRequest } from './helpers.js'

/**
 * A promisified value cursor over an object store or index.
 *
 * @remarks
 * Wraps `IDBCursorWithValue` and the request that drives it. The position
 * (`key` / `primary` / `value`) is snapshot at construction because IndexedDB
 * mutates the live cursor object in place on each advance. `continue` / `seek` /
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
	#value: Row
	readonly #direction: IDBCursorDirection

	constructor(cursor: IDBCursorWithValue, request: IDBRequest<IDBCursorWithValue | null>) {
		this.#cursor = cursor
		this.#request = request
		this.#key = cursor.key
		this.#primary = cursor.primaryKey
		this.#value = isRecord(cursor.value) ? cursor.value : {}
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

	get value(): Row {
		return this.#value
	}

	get direction(): IDBCursorDirection {
		return this.#direction
	}

	async continue(key?: IDBValidKey): Promise<IndexedDBCursorInterface | null> {
		if (key === undefined) this.#cursor.continue()
		else this.#cursor.continue(key)
		return this.#advance()
	}

	async seek(key: IDBValidKey, primary: IDBValidKey): Promise<IndexedDBCursorInterface | null> {
		this.#cursor.continuePrimaryKey(key, primary)
		return this.#advance()
	}

	async advance(count: number): Promise<IndexedDBCursorInterface | null> {
		this.#cursor.advance(count)
		return this.#advance()
	}

	async update(value: Row): Promise<IDBValidKey> {
		const key = await promisifyRequest(this.#cursor.update(value))
		this.#value = value
		return key
	}

	async delete(): Promise<void> {
		await promisifyRequest(this.#cursor.delete())
	}

	// Await the shared request after a move, wrapping the next position (or null).
	async #advance(): Promise<IndexedDBCursorInterface | null> {
		const next = await promisifyRequest(this.#request)
		return next ? new IndexedDBCursor(next, this.#request) : null
	}
}
