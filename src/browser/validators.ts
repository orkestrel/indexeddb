import { literalOf } from '@orkestrel/contract'

/**
 * Checks whether a value is a code an {@link IndexedDBError} carries.
 *
 * @remarks
 * Built once through `literalOf` over every member of {@link IndexedDBErrorCode}; its test binds
 * the guarded type to that union at compile time, so a member added to one side alone fails the
 * type check.
 *
 * @example
 * ```ts
 * import { isIndexedDBErrorCode } from '@orkestrel/indexeddb'
 *
 * isIndexedDBErrorCode('RECORD') // true
 * isIndexedDBErrorCode('DataError') // false
 * ```
 */
export const isIndexedDBErrorCode = literalOf(
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
	'RECORD',
	'UNKNOWN',
)
