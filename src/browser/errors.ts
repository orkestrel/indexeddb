// Errors for the IndexedDB wrapper. A single `IndexedDBError` carries a
// machine-readable `code` mapped from the native `DOMException.name` at the
// request boundary, so a `catch` branches on `error.code` rather than parsing a
// message. It is deliberately richer than the core `DatabaseError`'s four codes:
// the wrapper sits *below* the core, right on the raw IndexedDB surface, where
// constraint, quota, and abort faults are all distinct and worth naming
// (AGENTS §12).

import type { IndexedDBErrorCode } from './types.js'

/**
 * An error thrown by the IndexedDB wrapper.
 *
 * @remarks
 * Carries an {@link IndexedDBErrorCode} and the originating native error as the
 * standard `cause`. Construct it directly for wrapper-lifecycle faults; the
 * internal `wrapError` maps a native `DOMException` to the right code at the
 * request boundary. Narrow a caught value with `instanceof IndexedDBError`.
 *
 * @example
 * ```ts
 * try {
 * 	await store.add(row)
 * } catch (error) {
 * 	if (error instanceof IndexedDBError && error.code === 'CONSTRAINT') await store.set(row)
 * }
 * ```
 */
export class IndexedDBError extends Error {
	readonly code: IndexedDBErrorCode

	constructor(code: IndexedDBErrorCode, message: string, cause?: unknown) {
		super(message, { cause })
		this.name = 'IndexedDBError'
		this.code = code
	}
}

/**
 * Whether a value is an {@link IndexedDBError}.
 *
 * @param value - The value to test
 * @returns `true` when `value` is an `IndexedDBError`
 */
export function isIndexedDBError(value: unknown): value is IndexedDBError {
	return value instanceof IndexedDBError
}
