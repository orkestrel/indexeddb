// Browser-test setup — DOM/IndexedDB-only helpers, loaded second after
// `setup.ts` for the `src:browser` project. Real DOM, real `indexedDB` — do
// not mock browser APIs. Centralize DOM fixture builders and event factories
// here once used in more than one test file.

import type {
	IndexedDBCursorInterface,
	IndexedDBDatabaseInterface,
	StoresShape,
} from '@src/browser'
import { createIndexedDBDatabase, IndexedDBError } from '@src/browser'
import type { TeardownInterface } from '@orkestrel/test'
import { waitForDelay } from '@orkestrel/test'

// ── IndexedDB test fixtures (real Chromium, real `indexedDB`) ────────────────
//
// The shared open-a-database boilerplate every `src/browser` test reuses
// (AGENTS §16.1): a unique database name per call, a connected handle over a
// caller-supplied store schema, and a cleanup that closes the connection and
// deletes the database — so the suite is order- and rerun-independent without a
// per-file local opener. Each test keeps only its file-specific store / index
// definitions, passed in as the schema.
//
// Deleting a database goes through {@link dropDatabase}, which drives the native
// delete request itself after the wait a close needs to land.

/**
 * Deletes an IndexedDB database after the connections closing it have finished
 * closing, so a test can start from a clean store.
 *
 * @param name - The database name to delete
 * @returns A promise resolving after the deletion completes
 * @throws Thrown when the request errors, and when a connection the caller left
 *   open blocks it
 *
 * @remarks
 * Close every connection to `name` before calling this. `IDBDatabase.close`
 * returns before the connection is gone, and a block is reported as a rejection
 * rather than waited out, so a delete requested in the same task as the close
 * rejects on a connection that is already closing. The host timer here gives that
 * close a turn to complete. Deleting a database that was never created succeeds,
 * so this is safe as the first line of a test.
 *
 * The native request is driven here rather than through `removeDatabase` from
 * `@orkestrel/test/browser`, which is the same contract: that module loads
 * `vitest/browser`, which throws on import outside Browser Mode, so importing it
 * puts this whole file out of reach of the Node-hosted `setup` project and leaves
 * `tests/setupBrowser.test.ts` unable to prove any of the module. The resolve and
 * reject conditions and their messages match that helper exactly.
 *
 * A block stays a rejection and is never absorbed. `blocked` fires while another
 * connection is open, so a suite that swallowed it would let the next test read
 * the previous test's records through a database reporting itself deleted.
 */
export async function dropDatabase(name: string): Promise<void> {
	await waitForDelay()
	await new Promise<void>((resolve, reject) => {
		const request = globalThis.indexedDB.deleteDatabase(name)
		request.addEventListener('success', () => resolve())
		request.addEventListener('error', () => {
			reject(new Error(`IndexedDB database "${name}" could not be deleted`))
		})
		request.addEventListener('blocked', () => {
			reject(new Error(`IndexedDB database "${name}" is blocked by an open connection`))
		})
	})
}

let databaseCounter = 0

/**
 * A process-unique IndexedDB database name — a monotonic counter under an
 * optional prefix, so concurrent tests never collide on a shared store.
 *
 * @param prefix - A readable name segment (defaults to `terrain-idb`)
 * @returns A name no earlier call has returned
 */
export function uniqueName(prefix = 'terrain-idb'): string {
	databaseCounter += 1
	return `${prefix}-${databaseCounter}`
}

/** A connected test database plus the boilerplate to identify and dispose it. */
export interface TestDatabaseInterface<Stores extends StoresShape> {
	/** The IndexedDB handle, already `connect`ed and ready to use. */
	readonly db: IndexedDBDatabaseInterface<Stores>
	/** The unique name the database was opened under (for reopen / drop tests). */
	readonly name: string
	/** Close the connection and delete the database. */
	cleanup(): Promise<void>
}

/**
 * Open a fresh, connected IndexedDB database over a store schema, under a unique
 * name, returning the handle and a cleanup — the shared opener for every browser test (AGENTS §16.1). The handle is already connected, so a test can
 * reach `db.store(...)` immediately; `cleanup` closes and deletes it.
 *
 * @param stores - The store schema (file-specific store / index definitions)
 * @param options - `version` pins an explicit schema version (omit for
 *   auto-managed mode); `prefix` names the database for readable diagnostics
 * @returns The connected database, its name, and a cleanup
 */
export async function createTestDatabase<const Stores extends StoresShape>(
	stores: Stores,
	options?: { readonly version?: number; readonly prefix?: string },
): Promise<TestDatabaseInterface<Stores>> {
	const name = uniqueName(options?.prefix)
	const db = createIndexedDBDatabase({
		name,
		...(options?.version === undefined ? {} : { version: options.version }),
		stores,
	})
	await db.connect()
	const cleanup = async (): Promise<void> => {
		db.close()
		await dropDatabase(name)
	}
	return { db, name, cleanup }
}

/**
 * Drive a cursor chain to its end, collecting every visited cursor — the
 * assertion-friendly counterpart to a manual `while (cursor)` walk. Each step
 * uses `continue()` with no key, so it visits records in the cursor's direction.
 *
 * @param first - The first cursor (from `store.cursor()` / `index.cursor()`), or
 *   `null` for an empty source
 * @returns The cursors visited, in traversal order
 */
export async function drainCursor(
	first: IndexedDBCursorInterface | null,
): Promise<readonly IndexedDBCursorInterface[]> {
	const seen: IndexedDBCursorInterface[] = []
	let cursor = first
	while (cursor) {
		seen.push(cursor)
		cursor = await cursor.continue()
	}
	return seen
}

/**
 * The `code` of a caught value when it is an {@link IndexedDBError}, else
 * `undefined` — lets a test assert the machine-readable code without a
 * conditional `expect` around the `instanceof` narrowing.
 *
 * @param value - A caught value (the rejection / throw under test)
 * @returns The `IndexedDBError` code, or `undefined` for any other value
 */
export function errorCode(value: unknown): string | undefined {
	return value instanceof IndexedDBError ? value.code : undefined
}

// ── IndexedDB seed fixtures (the common stores every wrapper test starts from) ─
//
// The near-duplicate seed-a-`users`-store openers the `src/browser` tests
// reuse (AGENTS §16.1): each opens a uniquely-named database via
// {@link createTestDatabase}, sets the rows, and adds its `cleanup` to the
// caller's `createTeardown()` list (which the file destroys from an `afterEach`).
// The seed returns just the connected `db`.

/** The store schema {@link seedUsers} opens — a `users` store with a non-unique
 *  `byAge` index and a unique `byEmail` index. */
export const SEED_USER_STORES = {
	users: {
		path: 'id',
		indexes: [
			{ name: 'byAge', path: 'age' },
			{ name: 'byEmail', path: 'email', unique: true },
		],
	},
} as const satisfies StoresShape

/** The store schema {@link seedStore} opens — a plain `users` store keyed by `id`. */
export const SEED_STORE_STORES = {
	users: { path: 'id' },
} as const satisfies StoresShape

/**
 * Seed a `users` store keyed by `id` with a non-unique `byAge` index and a unique
 * `byEmail` index, three rows spanning ages 20/30/40 — the richer index-bearing seed
 * most `IndexedDBIndex` reads need. Adds its cleanup to `teardown`.
 *
 * @param teardown - The teardown list that closes and deletes the database
 * @returns The connected database, already holding the three rows
 */
export async function seedUsers(
	teardown: TeardownInterface,
): Promise<IndexedDBDatabaseInterface<typeof SEED_USER_STORES>> {
	const { db, cleanup } = await createTestDatabase(SEED_USER_STORES)
	teardown.add(cleanup)
	await db.store('users').set([
		{ id: 'a', age: 20, email: 'a@x.io' },
		{ id: 'b', age: 30, email: 'b@x.io' },
		{ id: 'c', age: 40, email: 'c@x.io' },
	])
	return db
}

/**
 * Seed a plain `users` store keyed by `id` (no secondary index) with three numbered
 * rows `{ id, n }` (n = 1/2/3) — the minimal seed the `IndexedDBCursor` walks/mutates.
 * Adds its cleanup to `teardown`.
 *
 * @param teardown - The teardown list that closes and deletes the database
 * @returns The connected database, already holding the three rows
 */
export async function seedStore(
	teardown: TeardownInterface,
): Promise<IndexedDBDatabaseInterface<typeof SEED_STORE_STORES>> {
	const { db, cleanup } = await createTestDatabase(SEED_STORE_STORES)
	teardown.add(cleanup)
	await db.store('users').set([
		{ id: 'a', n: 1 },
		{ id: 'b', n: 2 },
		{ id: 'c', n: 3 },
	])
	return db
}
