import type { GuardType } from '@orkestrel/contract'
import type { IndexedDBErrorCode } from '@src/browser'
import { ERROR_CODES, isIndexedDBErrorCode } from '@src/browser'
import { describe, expect, expectTypeOf, it } from 'vitest'

describe('isIndexedDBErrorCode', () => {
	it('guards exactly the declared IndexedDBErrorCode union', () => {
		expectTypeOf<GuardType<typeof isIndexedDBErrorCode>>().toEqualTypeOf<IndexedDBErrorCode>()
	})

	it.for([
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
	])('admits %s', (code) => {
		expect(isIndexedDBErrorCode(code)).toBe(true)
	})

	it('admits every code the native-name mapping produces', () => {
		expect(Object.values(ERROR_CODES).filter((code) => !isIndexedDBErrorCode(code))).toEqual([])
	})

	it.for(['record', 'DataError', 'NOT FOUND', ''])('refuses %j', (code) => {
		expect(isIndexedDBErrorCode(code)).toBe(false)
	})

	it('refuses every value that is not a string', () => {
		expect(isIndexedDBErrorCode(0)).toBe(false)
		expect(isIndexedDBErrorCode(undefined)).toBe(false)
		expect(isIndexedDBErrorCode(null)).toBe(false)
		expect(isIndexedDBErrorCode({ code: 'RECORD' })).toBe(false)
	})
})
