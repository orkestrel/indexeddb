import {
	arrayShape,
	booleanShape,
	integerShape,
	literalShape,
	objectShape,
	optionalShape,
	recordShape,
	stringShape,
	unionShape,
} from '@orkestrel/contract'

/**
 * Declares a {@link KeyPath} as a contract shape: one field name, or a list of field names.
 *
 * @example
 * ```ts
 * import { createContract } from '@orkestrel/contract'
 * import { keyPathShape } from '@orkestrel/indexeddb'
 *
 * createContract(keyPathShape).is(['make', 'model']) // true
 * ```
 */
export const keyPathShape = unionShape(stringShape(), arrayShape(stringShape()))

/**
 * Declares an {@link IndexDefinition} as a closed contract shape.
 *
 * @remarks
 * `name` is a string and `path` a key path; `unique` and `multiple` are optional booleans. The
 * object is closed and plain: an undeclared member, an optional member present as `undefined`,
 * and a class instance are each refused.
 *
 * @example
 * ```ts
 * import { createContract } from '@orkestrel/contract'
 * import { indexDefinitionShape } from '@orkestrel/indexeddb'
 *
 * createContract(indexDefinitionShape).is({ name: 'byTitle', path: 'title', unique: 'no' }) // false
 * ```
 */
export const indexDefinitionShape = objectShape({
	name: stringShape(),
	path: keyPathShape,
	unique: optionalShape(booleanShape()),
	multiple: optionalShape(booleanShape()),
})

/**
 * Declares a {@link StoreDefinition} as a closed contract shape.
 *
 * @remarks
 * `path` is an optional key path, `increment` an optional boolean, and `indexes` an optional list
 * of index definitions. The object is closed and plain, as {@link indexDefinitionShape} is.
 *
 * @example
 * ```ts
 * import { createContract } from '@orkestrel/contract'
 * import { storeDefinitionShape } from '@orkestrel/indexeddb'
 *
 * createContract(storeDefinitionShape).is({ path: 'id', autoIncrement: true }) // false
 * ```
 */
export const storeDefinitionShape = objectShape({
	path: optionalShape(keyPathShape),
	increment: optionalShape(booleanShape()),
	indexes: optionalShape(arrayShape(indexDefinitionShape)),
})

/**
 * Declares an {@link IndexedDBSchema} as a contract shape: a record of store name to store
 * definition.
 *
 * @example
 * ```ts
 * import { createContract } from '@orkestrel/contract'
 * import { indexedDBSchemaShape } from '@orkestrel/indexeddb'
 *
 * createContract(indexedDBSchemaShape).is({ books: { path: 'id' } }) // true
 * ```
 */
export const indexedDBSchemaShape = recordShape(storeDefinitionShape)

/**
 * Declares the options of `createIndexedDBDatabase` as a closed contract shape, audited with
 * `upgrade` read as its preview, because `@orkestrel/contract` has no shape or fault kind for a
 * function, until contract gains a function shape.
 *
 * @remarks
 * `name` is a non-empty string, `version` an optional integer of at least 1, and `stores` an
 * {@link IndexedDBSchema}. This is a stated limit: `@orkestrel/contract` has no shape or fault
 * kind for a function, so the database constructor audits a copy in which `upgrade` is replaced
 * by its `preview`: a function reads `'function'`, which the `upgrade` literal admits, and every
 * other value reads as its own quoted or bare preview, which it refuses. Once contract gains a
 * function shape, which the campaign's contract unit owns, this shape reads `upgrade` as its
 * declared function type. The object is closed, so an undeclared option is refused.
 *
 * @example
 * ```ts
 * import { createContract } from '@orkestrel/contract'
 * import { indexedDBDatabaseOptionsShape } from '@orkestrel/indexeddb'
 *
 * createContract(indexedDBDatabaseOptionsShape).is({ name: '', stores: {} }) // false
 * ```
 */
export const indexedDBDatabaseOptionsShape = objectShape({
	name: stringShape({ min: 1 }),
	version: optionalShape(integerShape({ min: 1 })),
	stores: indexedDBSchemaShape,
	upgrade: optionalShape(literalShape(['function'])),
})
