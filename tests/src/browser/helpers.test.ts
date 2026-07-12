import { isIndexedDBSupported } from '@src/browser'
import { describe, expect, it } from 'vitest'

// The browser-root feature probe (`src/browser/helpers.ts`), exercised in real
// Chromium. `isIndexedDBSupported` is the layer-wide gate a consumer runs before
// entering the IndexedDB module; the module's own read primitives live in
// `tests/src/browser/indexeddb/helpers.test.ts`.

describe('src/browser environment', () => {
	it('runs in a real browser with a DOM and IndexedDB', () => {
		expect(typeof document).toBe('object')
		expect(typeof globalThis.indexedDB).toBe('object')
	})

	it('isIndexedDBSupported reports true in the browser', () => {
		expect(isIndexedDBSupported()).toBe(true)
	})
})
