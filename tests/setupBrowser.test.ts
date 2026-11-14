import type { StoreDefinition } from '@src/browser'
import { createIndexedDBDatabase, ERROR_CODES, IndexedDBError } from '@src/browser'
import { isFunction } from '@orkestrel/contract'
import { createRecorder } from '@orkestrel/test'
import { describe, expect, it } from 'vitest'
import {
	createChangingOptions,
	createDatabaseCleanup,
	createShiftingOptions,
	createShiftingStores,
	drainCursor,
	errorCode,
	SEED_BOOK_STORES,
	SEED_STORE_STORES,
	SEED_USER_STORES,
	MESSAGE_NAMES,
	migrateNothing,
	mintDatabase,
	readFault,
	REFUSED_OPTIONS,
	readCounter,
	readIndexes,
	readStores,
} from './setupBrowser.js'

// The browser test setup module's proof (`tests/setupBrowser.ts`). Its subject is the exported
// test infrastructure the `src:browser` suites are driven over.
//
// The `setup` project runs in Node with the browser disabled, so this file proves the module's
// host-independent half only: `mintDatabase`, arithmetic over a module counter; `errorCode`, a
// narrowing through the package guard `isIndexedDBError`; `readFault`, the projection of a
// caught value to the fields JSON carries; `drainCursor`'s empty-source contract, the one
// branch it takes before any cursor exists; `createDatabaseCleanup`, which returns its cleanup
// without reaching storage; and the `SEED_USER_STORES` / `SEED_STORE_STORES` /
// `SEED_BOOK_STORES` schema tables, which are frozen plain data.
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
// - `readRecordClaim` by `tests/src/browser/integration.test.ts`, which asserts the guide's
//   invariant 7 over the reading it returns;
// - `seedNonRecord` by `tests/src/browser/IndexedDBStore.test.ts`,
//   `tests/src/browser/IndexedDBIndex.test.ts`, `tests/src/browser/IndexedDBCursor.test.ts`,
//   `tests/src/browser/IndexedDBTransactionStore.test.ts`, and
//   `tests/src/browser/helpers.test.ts`;
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

describe('mintDatabase', () => {
	it('returns a name no earlier call returned', () => {
		const names = [mintDatabase(), mintDatabase(), mintDatabase(), mintDatabase()]
		expect(new Set(names).size).toBe(names.length)
	})

	it('numbers every name from one shared counter, whatever the prefix', () => {
		const first = readCounter(mintDatabase())
		const prefixed = readCounter(mintDatabase('indexeddb-proof'))
		const last = readCounter(mintDatabase())
		expect(prefixed).toBe(first + 1)
		expect(last).toBe(prefixed + 1)
	})

	it('writes the caller prefix ahead of the counter, and defaults it to terrain-idb', () => {
		const defaulted = mintDatabase()
		expect(defaulted.slice(0, defaulted.lastIndexOf('-'))).toBe('terrain-idb')

		const named = mintDatabase('indexeddb-proof')
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

describe('MESSAGE_NAMES', () => {
	it('carries one name with both quote characters and one past the 64 characters a preview keeps', () => {
		const [quoted, long] = MESSAGE_NAMES
		expect(quoted?.name).toContain("'")
		expect(quoted?.name).toContain('"')
		expect(long?.name.length).toBeGreaterThan(64)
		expect(long?.shown.endsWith('…')).toBe(true)
	})
})

describe('migrateNothing', () => {
	it('returns undefined, bound or not', () => {
		expect(migrateNothing()).toBeUndefined()
		expect(migrateNothing.bind(undefined)()).toBeUndefined()
	})
})

describe('createShiftingOptions', () => {
	it('answers the next name at each read, records each read, and answers empty past the last', () => {
		const reads = createRecorder<[string]>()
		const options = createShiftingOptions(['catalogue', 'archive'], reads)
		expect([options.name, options.name, options.name]).toEqual(['catalogue', 'archive', ''])
		expect(reads.calls).toEqual([['name'], ['name'], ['name']])
	})
})

describe('createChangingOptions', () => {
	it('answers from the first answers once, then from the later answers, recording each read', () => {
		const reads = createRecorder<[string]>()
		const kept = createRecorder<[]>()
		const replaced = createRecorder<[]>()
		const first = { name: 'catalogue', version: 1, upgrade: kept.handler }
		const later = { name: 'archive', version: 3, upgrade: replaced.handler }
		const options = createChangingOptions(first, later, reads)
		expect([options.name, options.name]).toEqual(['catalogue', 'archive'])
		expect([options.version, options.version]).toEqual([1, 3])
		expect([options.upgrade, options.upgrade]).toEqual([first.upgrade, later.upgrade])
		expect(reads.calls).toEqual([
			['name'],
			['name'],
			['version'],
			['version'],
			['upgrade'],
			['upgrade'],
		])
	})
})

describe('createShiftingStores', () => {
	it('answers id for the books path and records each read', () => {
		const reads = createRecorder<[string]>()
		const stores = createShiftingStores(reads)
		expect(stores.books?.path).toBe('id')
		expect(reads.calls).toEqual([['path']])
	})
})

describe('REFUSED_OPTIONS', () => {
	it('labels each case once and gives each a message', () => {
		const labels = REFUSED_OPTIONS.map((refused) => refused.label)
		expect(new Set(labels).size).toBe(labels.length)
		expect(REFUSED_OPTIONS.filter((refused) => refused.message.length === 0)).toEqual([])
	})
})

describe('readFault', () => {
	it('reads the code, context, and message an IndexedDBError carries', () => {
		const error = new IndexedDBError('RECORD', 'Stored value is not a record', undefined, {
			store: 'books',
			key: 'b',
		})
		expect(readFault(error)).toEqual({
			code: 'RECORD',
			context: { store: 'books', key: 'b' },
			message: 'Stored value is not a record',
		})
	})

	it('reports no code for a value that is not an IndexedDBError, with its text as the message', () => {
		expect(readFault(undefined)).toEqual({
			code: undefined,
			context: undefined,
			message: 'undefined',
		})
		expect(readFault(new Error('plain'))).toEqual({
			code: undefined,
			context: undefined,
			message: 'Error: plain',
		})
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
		const name = mintDatabase('indexeddb-cleanup')
		const db = createIndexedDBDatabase({ name, stores: SEED_STORE_STORES })
		expect(isFunction(createDatabaseCleanup(db, name))).toBe(true)
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

describe('SEED_BOOK_STORES', () => {
	it('declares one out-of-line books store, so seedNonRecord passes each key itself', () => {
		expect(readStores(SEED_BOOK_STORES)).toEqual(['books'])
		const books: StoreDefinition = SEED_BOOK_STORES.books
		expect(books.path).toBeUndefined()
	})

	it('declares the non-unique byLength index the index and cursor suites read a string through', () => {
		// What `tests/src/browser/IndexedDBIndex.test.ts` reads off the live store: a string value
		// lands under its `length`, so `byLength` holds index key 3 for `'xyz'`.
		expect(readIndexes(SEED_BOOK_STORES.books)).toEqual({ byLength: ['length', false] })
	})
})
