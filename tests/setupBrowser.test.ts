import type { IndexDefinition, IndexedDBSchema, StoreDefinition } from '@src/browser'
import { createIndexedDBDatabase, ERROR_CODES, IndexedDBError } from '@src/browser'
import { describe, expect, it } from 'vitest'
import {
	createDatabaseCleanup,
	drainCursor,
	errorCode,
	SEED_STORE_STORES,
	SEED_USER_STORES,
	uniqueName,
} from './setupBrowser.js'

// The browser test setup module's proof (`tests/setupBrowser.ts`). Its subject is the exported
// test infrastructure the `src:browser` suites are driven over.
//
// The `setup` project runs in Node with the browser disabled, so this file proves the module's
// host-independent half only: `uniqueName`, arithmetic over a module counter; `errorCode`, an
// `instanceof` narrowing over a caught value; `drainCursor`'s empty-source contract, the one
// branch it takes before any cursor exists; `createDatabaseCleanup`, which returns its cleanup
// without reaching storage; and the `SEED_USER_STORES` / `SEED_STORE_STORES` schema tables,
// which are frozen plain data.
//
// The DOM-driving half reads `globalThis.indexedDB` and a live `IDBDatabase` that no Node
// project has, and each export in it is proven by the consuming browser suites that drive it
// against real Chromium storage on every case they set up and tear down:
//
// - `dropDatabase` by `tests/src/browser/IndexedDBDatabase.test.ts`,
//   `tests/src/browser/factories.test.ts`, and `tests/src/browser/helpers.test.ts`;
// - `createTestDatabase`, and with it the cleanup `createDatabaseCleanup` returns, by
//   `tests/src/browser/IndexedDBDatabase.test.ts`,
//   `tests/src/browser/IndexedDBStore.test.ts`, `tests/src/browser/IndexedDBIndex.test.ts`,
//   `tests/src/browser/IndexedDBCursor.test.ts`,
//   `tests/src/browser/IndexedDBTransaction.test.ts`,
//   `tests/src/browser/IndexedDBTransactionStore.test.ts`, and
//   `tests/src/browser/helpers.test.ts`;
// - `seedUsers` by `tests/src/browser/IndexedDBIndex.test.ts`;
// - `seedStore` by `tests/src/browser/IndexedDBCursor.test.ts`;
// - `drainCursor`'s traversal branch by `tests/src/browser/IndexedDBCursor.test.ts`,
//   `tests/src/browser/IndexedDBIndex.test.ts`, `tests/src/browser/IndexedDBStore.test.ts`, and
//   `tests/src/browser/IndexedDBTransactionStore.test.ts`.
//
// Each expectation arrives by a route `tests/setupBrowser.ts` does not share. Uniqueness is read
// as set membership across a batch rather than as a counter value. The codes `errorCode` reports
// are drawn from `ERROR_CODES`, the wrapper's own native-name mapping, which the helper never
// reads. The seed tables are flattened into an index map and compared against what the
// `IndexedDBIndex` suite reads back off a live store, so the table cannot satisfy the assertion
// by restating itself.

/** Read the trailing counter segment a `uniqueName` result carries. */
function readCounter(name: string): number {
	return Number(name.slice(name.lastIndexOf('-') + 1))
}

/** Flatten a store's declared indexes into `name → [path, unique]`, defaulting `unique` to `false`. */
function readIndexes(definition: StoreDefinition): Record<string, readonly [unknown, boolean]> {
	const declared: readonly IndexDefinition[] = definition.indexes ?? []
	return Object.fromEntries(
		declared.map((index) => [index.name, [index.path, index.unique === true]]),
	)
}

/** The store names a schema table declares, sorted. */
function readStores(stores: IndexedDBSchema): readonly string[] {
	return Object.keys(stores).sort()
}

describe('uniqueName', () => {
	it('returns a name no earlier call returned', () => {
		const names = [uniqueName(), uniqueName(), uniqueName(), uniqueName()]
		expect(new Set(names).size).toBe(names.length)
	})

	it('numbers every name from one shared counter, whatever the prefix', () => {
		const first = readCounter(uniqueName())
		const prefixed = readCounter(uniqueName('indexeddb-proof'))
		const last = readCounter(uniqueName())
		expect(prefixed).toBe(first + 1)
		expect(last).toBe(prefixed + 1)
	})

	it('writes the caller prefix ahead of the counter, and defaults it to terrain-idb', () => {
		const defaulted = uniqueName()
		expect(defaulted.slice(0, defaulted.lastIndexOf('-'))).toBe('terrain-idb')

		const named = uniqueName('indexeddb-proof')
		expect(named.slice(0, named.lastIndexOf('-'))).toBe('indexeddb-proof')
	})
})

describe('errorCode', () => {
	it('reports the code of an IndexedDBError, for every code the wrapper maps', () => {
		for (const code of Object.values(ERROR_CODES)) {
			expect(errorCode(new IndexedDBError(code, 'raised for the proof'))).toBe(code)
		}
	})

	it('reports undefined for a value that is not an IndexedDBError', () => {
		expect(errorCode(new Error('plain'))).toBeUndefined()
		expect(errorCode(new TypeError('sibling error class'))).toBeUndefined()
		expect(errorCode({ name: 'IndexedDBError', code: 'CONSTRAINT' })).toBeUndefined()
		expect(errorCode('CONSTRAINT')).toBeUndefined()
		expect(errorCode(undefined)).toBeUndefined()
		expect(errorCode(null)).toBeUndefined()
	})
})

describe('drainCursor', () => {
	it('collects nothing from an empty source, rather than throwing on the null cursor', async () => {
		expect(await drainCursor(null)).toEqual([])
	})
})

describe('createDatabaseCleanup', () => {
	it('returns its cleanup without reaching storage', () => {
		// `createIndexedDBDatabase` connects lazily and touches `globalThis.indexedDB` only
		// inside `connect()`, so the handle this builds exists under a Node project with no
		// storage at all. What the cleanup then does is proven by every browser suite that
		// opens a database through `createTestDatabase` and tears it down.
		const name = uniqueName('indexeddb-cleanup')
		const db = createIndexedDBDatabase({ name, stores: SEED_STORE_STORES })
		expect(typeof createDatabaseCleanup(db, name)).toBe('function')
	})
})

describe('SEED_USER_STORES', () => {
	it('declares one users store keyed by id', () => {
		expect(readStores(SEED_USER_STORES)).toEqual(['users'])
		expect(SEED_USER_STORES.users.path).toBe('id')
	})

	it('declares the byAge and byEmail indexes the IndexedDBIndex suite reads back', () => {
		// What `tests/src/browser/IndexedDBIndex.test.ts` asserts off the live store: `byAge`
		// indexes `age` and is not unique, `byEmail` indexes `email` and is unique.
		expect(readIndexes(SEED_USER_STORES.users)).toEqual({
			byAge: ['age', false],
			byEmail: ['email', true],
		})
	})
})

describe('SEED_STORE_STORES', () => {
	it('declares one users store keyed by id', () => {
		expect(readStores(SEED_STORE_STORES)).toEqual(['users'])
		expect(SEED_STORE_STORES.users.path).toBe('id')
	})

	it('declares no secondary index, so the cursor suite walks the primary key alone', () => {
		expect(readIndexes(SEED_STORE_STORES.users)).toEqual({})
	})
})
