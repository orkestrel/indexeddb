import type { Infer } from '@orkestrel/contract'
import type {
	IndexDefinition,
	IndexedDBDatabaseOptions,
	IndexedDBSchema,
	KeyPath,
	StoreDefinition,
	indexDefinitionShape,
	indexedDBDatabaseOptionsShape,
	indexedDBSchemaShape,
	keyPathShape,
	storeDefinitionShape,
} from '@src/browser'
import {
	indexDefinitionContract,
	indexedDBDatabaseOptionsContract,
	indexedDBSchemaContract,
	storeDefinitionContract,
} from '@src/browser'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { IndexLike, StoreLike } from '../../setupBrowser.js'

describe('definition shapes', () => {
	it('infer exactly the declared types', () => {
		expectTypeOf<Infer<typeof keyPathShape>>().toEqualTypeOf<KeyPath>()
		expectTypeOf<Infer<typeof indexDefinitionShape>>().toEqualTypeOf<IndexDefinition>()
		expectTypeOf<Infer<typeof storeDefinitionShape>>().toEqualTypeOf<StoreDefinition>()
		expectTypeOf<Infer<typeof indexedDBSchemaShape>>().toEqualTypeOf<IndexedDBSchema>()
	})

	it('bind the options shape to IndexedDBDatabaseOptions, with upgrade read as its preview', () => {
		expectTypeOf<Omit<Infer<typeof indexedDBDatabaseOptionsShape>, 'upgrade'>>().toEqualTypeOf<
			Omit<IndexedDBDatabaseOptions, 'upgrade'>
		>()
		expectTypeOf<Infer<typeof indexedDBDatabaseOptionsShape>['upgrade']>().toEqualTypeOf<
			'function' | undefined
		>()
	})
})

describe('indexDefinitionContract', () => {
	it('admits a name and a key path with the optional flags', () => {
		expect(indexDefinitionContract.is({ name: 'byTitle', path: 'title' })).toBe(true)
		expect(
			indexDefinitionContract.is({
				name: 'byWord',
				path: ['words'],
				unique: false,
				multiple: true,
			}),
		).toBe(true)
	})

	it('refuses a flag that is not a boolean, a missing name, and an undeclared member', () => {
		expect(indexDefinitionContract.is({ name: 'byTitle', path: 'title', unique: 'no' })).toBe(false)
		expect(indexDefinitionContract.is({ path: 'title' })).toBe(false)
		expect(indexDefinitionContract.is({ name: 'byTitle', path: 'title', multiEntry: true })).toBe(
			false,
		)
	})

	it('refuses a class instance and an optional member present as undefined', () => {
		expect(indexDefinitionContract.is(new IndexLike())).toBe(false)
		expect(indexDefinitionContract.is({ name: 'byTitle', path: 'title', unique: undefined })).toBe(
			false,
		)
	})

	it('audits each offending member by its path', () => {
		expect(indexDefinitionContract.audit({ name: 'byTitle', path: 'title', unique: 'no' })).toEqual(
			[{ reason: 'type', path: ['unique'], expected: 'boolean', received: '"no"' }],
		)
	})
})

describe('storeDefinitionContract', () => {
	it('admits an empty definition and one with every member', () => {
		expect(storeDefinitionContract.is({})).toBe(true)
		expect(
			storeDefinitionContract.is({
				path: ['make', 'model'],
				increment: false,
				indexes: [{ name: 'byStock', path: 'stock' }],
			}),
		).toBe(true)
	})

	it('refuses a member of the wrong type, an index outside its type, and an undeclared member', () => {
		expect(storeDefinitionContract.is({ increment: 'yes' })).toBe(false)
		expect(storeDefinitionContract.is({ path: 5 })).toBe(false)
		expect(
			storeDefinitionContract.is({ indexes: [{ name: 'byTitle', path: 'title', unique: 'no' }] }),
		).toBe(false)
		expect(storeDefinitionContract.is({ path: 'id', autoIncrement: true })).toBe(false)
	})

	it('refuses a class instance and a store optional present as undefined', () => {
		expect(storeDefinitionContract.is(new StoreLike())).toBe(false)
		expect(storeDefinitionContract.is({ increment: undefined })).toBe(false)
		expect(storeDefinitionContract.is({ path: undefined })).toBe(false)
	})

	it('admits an empty list as a key path', () => {
		expect(storeDefinitionContract.is({ path: [] })).toBe(true)
		expect(indexDefinitionContract.is({ name: 'byNothing', path: [] })).toBe(true)
	})
})

describe('indexedDBSchemaContract', () => {
	it('admits an empty schema and a record of store definitions', () => {
		expect(indexedDBSchemaContract.is({})).toBe(true)
		expect(indexedDBSchemaContract.is({ books: { path: 'id' }, notes: {} })).toBe(true)
	})

	it('refuses a value that is not a record and a record holding a malformed definition', () => {
		expect(indexedDBSchemaContract.is('abc')).toBe(false)
		expect(indexedDBSchemaContract.is(undefined)).toBe(false)
		expect(indexedDBSchemaContract.is({ books: { increment: 'yes' } })).toBe(false)
	})
})

describe('indexedDBDatabaseOptionsContract', () => {
	it('admits a name and stores, with an optional version and an upgrade read as its preview', () => {
		expect(indexedDBDatabaseOptionsContract.is({ name: 'catalogue', stores: {} })).toBe(true)
		expect(
			indexedDBDatabaseOptionsContract.is({
				name: 'catalogue',
				version: 2,
				stores: { books: { path: 'id' } },
				upgrade: 'function',
			}),
		).toBe(true)
	})

	it('audits every malformed option in one pass', () => {
		expect(
			indexedDBDatabaseOptionsContract
				.audit({ name: '', stores: 'x', version: 1.5 })
				.map((fault) => fault.path),
		).toEqual([['name'], ['version'], ['stores']])
	})

	it('refuses an undeclared option and a version below 1', () => {
		expect(
			indexedDBDatabaseOptionsContract.is({ name: 'catalogue', stores: {}, durability: 'strict' }),
		).toBe(false)
		expect(indexedDBDatabaseOptionsContract.is({ name: 'catalogue', stores: {}, version: 0 })).toBe(
			false,
		)
	})
})
