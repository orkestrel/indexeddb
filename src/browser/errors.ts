// Errors for the IndexedDB wrapper. A single `IndexedDBError` carries a
// machine-readable `code` mapped from the native `DOMException.name` at the
// request boundary, so a `catch` branches on `error.code` rather than parsing a
// message. It is deliberately richer than the core `DatabaseError`'s four codes:
// the wrapper sits *below* the core, right on the raw IndexedDB surface, where
// constraint, quota, and abort faults are all distinct and worth naming
// (`.claude/rules/typescript.md` § Errors and outcomes).

import type { IndexedDBErrorCode } from './types.js'

/**
 * Represents an error thrown by the IndexedDB wrapper.
 *
 * @remarks
 * Carries an {@link IndexedDBErrorCode} and the originating native error as the
 * standard `cause`. Construct it directly for wrapper-lifecycle faults; the
 * internal `wrapError` maps a native `DOMException` to the right code at the
 * request boundary. Narrow a caught value with {@link isIndexedDBError}, this
 * package's own guard.
 *
 * `context` carries the facts a caller branches on — the database, store, index,
 * key, or transaction scope the fault names — as machine-readable members beside
 * `code`, so a `catch` reads them instead of parsing the message that states the
 * same facts. It is `undefined` where the fault carries none, which is every
 * error `wrapError` builds: a native `DOMException` already rides as `cause`.
 *
 * @example
 * ```ts
 * try {
 * 	await store.add(row)
 * } catch (error) {
 * 	if (isIndexedDBError(error) && error.code === 'CONSTRAINT') await store.set(row)
 * }
 * ```
 */
export class IndexedDBError extends Error {
	readonly code: IndexedDBErrorCode
	readonly context: Readonly<Record<string, unknown>> | undefined

	constructor(
		code: IndexedDBErrorCode,
		message: string,
		cause?: unknown,
		context?: Readonly<Record<string, unknown>>,
	) {
		super(message, { cause })
		this.name = 'IndexedDBError'
		this.code = code
		this.context = context
	}
}

/**
 * Checks whether a value is an {@link IndexedDBError}.
 *
 * @param value - The value to test
 * @returns True if `value` is an `IndexedDBError`; false otherwise
 */
export function isIndexedDBError(value: unknown): value is IndexedDBError {
	return value instanceof IndexedDBError
}
