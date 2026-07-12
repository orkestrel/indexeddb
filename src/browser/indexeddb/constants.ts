import type { IndexedDBErrorCode } from './types.js'

/**
 * Native `DOMException.name` → our {@link IndexedDBErrorCode}.
 *
 * @remarks
 * The mapping the request boundary's `wrapError` reads to translate a raw
 * IndexedDB fault into a typed {@link IndexedDBError} code; an unmapped name
 * falls back to `UNKNOWN`. Frozen plain data (AGENTS §5).
 */
export const ERROR_CODES: Readonly<Record<string, IndexedDBErrorCode>> = Object.freeze({
	ConstraintError: 'CONSTRAINT',
	QuotaExceededError: 'QUOTA',
	AbortError: 'ABORTED',
	NotFoundError: 'NOT_FOUND',
	DataError: 'DATA',
	VersionError: 'UPGRADE',
})
