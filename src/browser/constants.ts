import type { IndexedDBErrorCode } from './types.js'

/**
 * Maps native `DOMException.name` → the wrapper's {@link IndexedDBErrorCode}.
 *
 * @remarks
 * The mapping the request boundary's `wrapError` reads to translate a raw
 * IndexedDB fault into a typed {@link IndexedDBError} code; an unmapped name
 * falls back to `UNKNOWN`. Frozen plain data
 * (`.claude/rules/architecture.md` § Kind purity).
 */
export const ERROR_CODES: Readonly<Record<string, IndexedDBErrorCode>> = Object.freeze({
	ConstraintError: 'CONSTRAINT',
	QuotaExceededError: 'QUOTA',
	AbortError: 'ABORTED',
	NotFoundError: 'NOT_FOUND',
	DataError: 'DATA',
	DataCloneError: 'DATA',
	VersionError: 'UPGRADE',
	TransactionInactiveError: 'INACTIVE',
	InvalidStateError: 'INVALID',
	ReadOnlyError: 'READONLY',
})
