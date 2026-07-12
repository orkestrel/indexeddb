import type { IndexedDBDatabaseInterface, IndexedDBDatabaseOptions, StoresShape } from './types.js'
import { IndexedDBDatabase } from './IndexedDBDatabase.js'

/**
 * Create a browser-native IndexedDB database over a store schema.
 *
 * @remarks
 * The `const` type parameter captures the literal store names, so `db.store(name)`
 * and `db.read` / `db.write` are checked against the declared stores. Stores are
 * created from their definitions the first time the database opens at a new
 * `version`. For the cross-environment database API (typed rows, queries,
 * relations), pass an IndexedDB driver to `createDatabase` from `@src/core`
 * instead — this is the lower-level native handle that driver is built on.
 *
 * @param options - The database `name`, `version`, and `stores` schema
 * @returns A typed {@link IndexedDBDatabaseInterface}
 *
 * @example
 * ```ts
 * import { createIndexedDBDatabase, range } from '@src/browser'
 *
 * const db = createIndexedDBDatabase({
 * 	name: 'app',
 * 	version: 1,
 * 	stores: {
 * 		users: { path: 'id', indexes: [{ name: 'byAge', path: 'age' }] },
 * 	},
 * })
 * await db.store('users').set({ id: 'u1', name: 'Ada', age: 36 })
 * await db.store('users').index('byAge').records(range.from(18)) // adults, index-backed
 * ```
 */
export function createIndexedDBDatabase<const Stores extends StoresShape>(
	options: IndexedDBDatabaseOptions<Stores>,
): IndexedDBDatabaseInterface<Stores> {
	return new IndexedDBDatabase(options)
}
