// Errors for the IndexedDB wrapper. A single `IndexedDBError` carries a
// machine-readable `code` mapped from the native `DOMException.name` at the
// request boundary, so a `catch` branches on `error.code` rather than parsing a
// message. It is deliberately richer than the core `DatabaseError`'s four codes:
// the wrapper sits *below* the core, right on the raw IndexedDB surface, where
// constraint, quota, and abort faults are all distinct and worth naming
// (`.claude/rules/typescript.md` § Errors and outcomes).

import type { IndexedDBErrorCode } from './types.js'
import { holds, INTRINSICS, isFunction, isObject } from '@orkestrel/contract'

/**
 * Represents an error thrown by the IndexedDB wrapper, carrying a machine-readable
 * `code` and an optional `context` beside the native cause.
 *
 * @remarks
 * The `code` is an {@link IndexedDBErrorCode}, and the originating native error
 * rides as the standard `cause`. Construct it directly for wrapper-lifecycle
 * faults; the internal `wrapDOMException` maps a native `DOMException` to the right code
 * at the request boundary. Narrow a caught value with {@link isIndexedDBError},
 * this package's own guard.
 *
 * `context` carries the facts a caller branches on — the database, store, index,
 * key, or transaction scope the fault names — as machine-readable members beside
 * `code`, so a `catch` reads them instead of parsing the message that states the
 * same facts. It is `undefined` where the fault carries none, which is every
 * error `wrapDOMException` builds: a native `DOMException` already rides as `cause`.
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
		INTRINSICS.define(this, Symbol.for('@orkestrel/indexeddb.IndexedDBError'), { value: this })
		this.name = 'IndexedDBError'
		this.code = code
		this.context = context
	}
}

/**
 * Checks whether a value is an {@link IndexedDBError}.
 *
 * @remarks
 * Recognizes the identity brand, code, and context across package copies and
 * subclasses. Refuses transparent proxies and unbranded look-alikes.
 *
 * @param value - The value to test
 * @returns True if `value` is an `IndexedDBError`; false otherwise
 */
export function isIndexedDBError(value: unknown): value is IndexedDBError {
	return holds(() => {
		if (!(value instanceof Error) || INTRINSICS.prototype(value) === Error.prototype) return false
		if (
			INTRINSICS.describe(value, Symbol.for('@orkestrel/indexeddb.IndexedDBError'))?.value !== value
		)
			return false
		const code: unknown = INTRINSICS.reflect.read(value, 'code')
		if (
			![
				'NOT_OPEN',
				'CLOSED',
				'NOT_FOUND',
				'CONSTRAINT',
				'QUOTA',
				'ABORTED',
				'DATA',
				'OPEN',
				'UPGRADE',
				'INACTIVE',
				'READONLY',
				'INVALID',
				'UNKNOWN',
			].some((candidate) => candidate === code)
		)
			return false
		const context: unknown = INTRINSICS.reflect.read(value, 'context')
		return context === undefined || isObject(context) || isFunction(context)
	})
}
