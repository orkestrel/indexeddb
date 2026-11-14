import { IndexedDBError, isIndexedDBError } from '@src/browser'
import { describe, expect, it } from 'vitest'

describe('isIndexedDBError', () => {
	it('admits the RECORD code a read raises for a stored value that is no record', () => {
		const error = new IndexedDBError('RECORD', 'not a record', undefined, { store: 'books' })
		expect(isIndexedDBError(error)).toBe(true)
	})

	// The guard reads the global `Error` captured at load, so a later replacement of the
	// global changes neither the instance check nor the `Error.prototype` comparison.
	it('reads the global Error captured at load for the instance check', () => {
		const error = new IndexedDBError('RECORD', 'not a record')
		const lookalike = Object.assign(new Error('not a record'), { code: 'RECORD' })
		const original = globalThis.Error
		Reflect.set(globalThis, 'Error', RangeError)
		try {
			expect(isIndexedDBError(error)).toBe(true)
			expect(isIndexedDBError(lookalike)).toBe(false)
		} finally {
			Reflect.set(globalThis, 'Error', original)
		}
	})

	it('reads the global Error captured at load for the prototype comparison', () => {
		const error = new IndexedDBError('RECORD', 'not a record')
		const lookalike = Object.assign(new Error('not a record'), { code: 'RECORD' })
		const original = globalThis.Error
		Reflect.set(globalThis, 'Error', IndexedDBError)
		try {
			expect(isIndexedDBError(error)).toBe(true)
			expect(isIndexedDBError(lookalike)).toBe(false)
		} finally {
			Reflect.set(globalThis, 'Error', original)
		}
	})

	it('refuses a branded error whose code the union does not declare', () => {
		const error = new IndexedDBError('RECORD', 'not a record')
		Object.defineProperty(error, 'code', { value: 'MALFORMED' })
		expect(isIndexedDBError(error)).toBe(false)
	})

	it('accepts a class-instance context', () => {
		class Context {
			readonly [key: string]: unknown
			readonly database = 'sample'
		}

		const context: Readonly<Record<string, unknown>> = new Context()
		const error = new IndexedDBError('OPEN', 'open failed', undefined, context)
		expect(isIndexedDBError(error)).toBe(true)
	})

	it('accepts a callable context', () => {
		const members: Readonly<Record<string, unknown>> = { database: 'sample' }
		const context = Object.assign(() => undefined, members)
		const error = new IndexedDBError('OPEN', 'open failed', undefined, context)
		expect(isIndexedDBError(error)).toBe(true)
	})
})
