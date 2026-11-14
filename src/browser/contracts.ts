import type { ContractInterface } from '@orkestrel/contract'
import type { IndexDefinition, IndexedDBSchema, StoreDefinition } from './types.js'
import { createContract } from '@orkestrel/contract'
import {
	indexDefinitionShape,
	indexedDBDatabaseOptionsShape,
	indexedDBSchemaShape,
	storeDefinitionShape,
} from './shapers.js'

/**
 * Holds the compiled contract of an index definition, which `context.indexes.create` admits through.
 *
 * @example
 * ```ts
 * import { indexDefinitionContract } from '@orkestrel/indexeddb'
 *
 * indexDefinitionContract.audit({ name: 'byTitle', path: 'title', unique: 'no' }) // [{ reason: 'type', path: ['unique'], expected: 'boolean', received: '"no"' }]
 * ```
 */
export const indexDefinitionContract: ContractInterface<IndexDefinition> =
	createContract(indexDefinitionShape)

/**
 * Holds the compiled contract of a store definition, which `context.stores.create` admits through.
 *
 * @example
 * ```ts
 * import { storeDefinitionContract } from '@orkestrel/indexeddb'
 *
 * storeDefinitionContract.audit({ path: 'id', autoIncrement: true }) // [{ reason: 'extra', path: ['autoIncrement'] }]
 * ```
 */
export const storeDefinitionContract: ContractInterface<StoreDefinition> =
	createContract(storeDefinitionShape)

/**
 * Holds the compiled contract of a database's store schema, the `stores` member the options
 * contract checks.
 *
 * @example
 * ```ts
 * import { indexedDBSchemaContract } from '@orkestrel/indexeddb'
 *
 * indexedDBSchemaContract.is({ books: { path: 'id' } }) // true
 * ```
 */
export const indexedDBSchemaContract: ContractInterface<IndexedDBSchema> =
	createContract(indexedDBSchemaShape)

/**
 * Holds the compiled contract of the database options, which the database constructor admits
 * its whole options record through, with `upgrade` read as its preview, because
 * `@orkestrel/contract` has no shape or fault kind for a function, until contract gains a
 * function shape.
 *
 * @example
 * ```ts
 * import { indexedDBDatabaseOptionsContract } from '@orkestrel/indexeddb'
 *
 * indexedDBDatabaseOptionsContract.audit({ name: '', stores: {} }) // [{ reason: 'constraint', path: ['name'], expected: 'string', constraint: 'min', limit: 1, received: '""' }]
 * ```
 */
export const indexedDBDatabaseOptionsContract = createContract(indexedDBDatabaseOptionsShape)
