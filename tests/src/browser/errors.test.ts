import { IndexedDBError, isIndexedDBError } from '@src/browser'
import { describe, expect, it } from 'vitest'

describe('isIndexedDBError', () => {
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
