// Browser-test setup — DOM/Vue-only helpers, loaded second after `setup.ts`
// for the `src:browser` / `app:browser` projects. Loads the app's REAL
// cascade — Halfmoon plus its modern core, exactly what main.scss ships —
// so component tests assert resolved styles against what production renders.
// Real DOM, real events, real layout — do not mock browser APIs. Centralize
// DOM fixture builders and event factories here once used in more than one
// test file.

import type {
	IndexedDBCursorInterface,
	IndexedDBDatabaseInterface,
	StoresShape,
} from '@src/browser'
import type { DatabaseInterface } from '@src/core'
import { createIndexedDBDatabase, createIndexedDBDriver, IndexedDBError } from '@src/browser'
import { createDatabase } from '@src/core'
import { INTEGRATION_TABLES } from './setup.js'
import 'halfmoon/css/halfmoon.css'
import 'halfmoon/css/cores/halfmoon.modern.css'
import { afterEach } from 'vitest'

// The app's index.html activates the modern core on <html>; tests mirror it
// or every [data-bs-core=modern] rule in the loaded cascade stays inert.
document.documentElement.setAttribute('data-bs-core', 'modern')

// Per-test teardown registry — every helper that mounts a node registers its
// cleanup here so the DOM never leaks between tests. Sync disposers only —
// `afterEach` below drains it synchronously; async cleanup (closing/deleting
// a database, awaiting a disposer) goes through {@link createCleanups}
// instead, whose `run()` awaits each disposer in order.
export const TEARDOWNS: Array<() => void> = []

afterEach(() => {
	while (TEARDOWNS.length > 0) TEARDOWNS.pop()?.()
	document.body.replaceChildren()
})

// Append an element to `document.body` (so the cascade applies) and register
// automatic cleanup. Returns the element for chaining.
export function mount<T extends Element>(element: T): T {
	document.body.append(element)
	TEARDOWNS.push(() => element.remove())
	return element
}

// ── Browser event factories (AGENTS §16.2) ────────────────────────────────

/**
 * Set an input's `value` and dispatch a real bubbling `input` event — the
 * no-blur / draft-typing path a component's `input` listener observes.
 *
 * @param input - The input element to type into
 * @param value - The value to set before dispatching
 */
export function typeInput(input: HTMLInputElement, value: string): void {
	input.value = value
	input.dispatchEvent(new Event('input', { bubbles: true }))
}

/**
 * Type `value` via {@link typeInput}, then dispatch a real bubbling `change`
 * event — the blur-time commit path a component's `change` listener observes.
 *
 * @param input - The input element to type into and commit
 * @param value - The value to set before dispatching
 */
export function commitInput(input: HTMLInputElement, value: string): void {
	typeInput(input, value)
	input.dispatchEvent(new Event('change', { bubbles: true }))
}

// ── IndexedDB test fixtures (real Chromium, real `indexedDB`) ────────────────
//
// The shared open-a-database boilerplate every `src/browser/indexeddb` (and
// `src/browser/databases`) test reuses (AGENTS §16.1): a unique database name
// per call, a connected handle over a caller-supplied store schema, and a
// cleanup that closes the connection and deletes the database — so the suite is
// order- and rerun-independent without a per-file local opener. Each test keeps
// only its file-specific store / index definitions, passed in as the schema.

/**
 * Delete an IndexedDB database, resolving once the request settles, so a test
 * can start from a clean store. Resolves even when the delete is blocked by an
 * open connection (the caller closes its databases first).
 *
 * @param name - The database name to delete
 */
export function deleteDatabase(name: string): Promise<void> {
	return new Promise((resolve) => {
		const request = globalThis.indexedDB.deleteDatabase(name)
		request.onsuccess = () => resolve()
		request.onerror = () => resolve()
		request.onblocked = () => resolve()
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
 * name, returning the handle and a cleanup — the shared opener for every browser
 * `indexeddb` test (AGENTS §16.1). The handle is already connected, so a test can
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
		version: options?.version,
		stores,
	})
	await db.connect()
	const cleanup = async (): Promise<void> => {
		db.close()
		await deleteDatabase(name)
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
// The near-duplicate seed-a-`users`-store openers the `src/browser/indexeddb` tests
// reuse (AGENTS §16.1): each opens a uniquely-named database via
// {@link createTestDatabase}, sets the rows, and registers its `cleanup` through the
// caller's teardown registrar (so the file keeps its own `cleanups` array + the
// deferred async-thunk `afterEach`). The seed returns just the connected `db`.

/** Register a database cleanup with the caller's teardown — the per-file `cleanups`
 *  push, decoupled from the array so a seed helper need not know its shape. */
export type CleanupRegistrar = (cleanup: () => Promise<void>) => void

/** A teardown registrar: push disposers as a test sets them up, `run` them all in
 *  registration order. Its `push` IS a {@link CleanupRegistrar}, so a seed helper
 *  (`seedUsers` / `seedStore`) composes with `register: registrar.push`. */
export interface CleanupRegistrarInterface {
	/** Register a disposer (sync or async) to run at teardown. */
	push(disposer: () => void | Promise<void>): void
	/** Run every registered disposer once, in registration order, then forget them. */
	run(): Promise<void>
}

/**
 * Build a teardown registrar replacing the hand-rolled per-file `cleanups[]` +
 * `afterEach` loop every `indexeddb` / cross-driver `databases` test repeats
 * (AGENTS §16.1). Push disposers as a test opens resources; wire `registrar.run`
 * into an `afterEach`. Disposers run in REGISTRATION order — the order an
 * IndexedDB connection/transaction close can depend on — and are forgotten after,
 * so the registrar is reused across cases. `push` is a {@link CleanupRegistrar},
 * so `seedUsers(registrar.push)` / `seedStore(registrar.push)` compose directly.
 *
 * @returns A registrar with `push(disposer)` and `run()`
 */
export function createCleanups(): CleanupRegistrarInterface {
	const disposers: Array<() => void | Promise<void>> = []
	return {
		push(disposer) {
			disposers.push(disposer)
		},
		async run() {
			for (const disposer of disposers.splice(0)) await disposer()
		},
	}
}

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
 * most `IndexedDBIndex` reads need. Registers its cleanup through `register`.
 *
 * @param register - Receives the database cleanup to run at teardown
 * @returns The connected database, already holding the three rows
 */
export async function seedUsers(
	register: CleanupRegistrar,
): Promise<IndexedDBDatabaseInterface<typeof SEED_USER_STORES>> {
	const { db, cleanup } = await createTestDatabase(SEED_USER_STORES)
	register(cleanup)
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
 * Registers its cleanup through `register`.
 *
 * @param register - Receives the database cleanup to run at teardown
 * @returns The connected database, already holding the three rows
 */
export async function seedStore(
	register: CleanupRegistrar,
): Promise<IndexedDBDatabaseInterface<typeof SEED_STORE_STORES>> {
	const { db, cleanup } = await createTestDatabase(SEED_STORE_STORES)
	register(cleanup)
	await db.store('users').set([
		{ id: 'a', n: 1 },
		{ id: 'b', n: 2 },
		{ id: 'c', n: 3 },
	])
	return db
}

// ── Cross-driver integration fixture (core database over the IndexedDB driver) ─
//
// The fresh-name + open-over-`INTEGRATION_TABLES` + cleanup opener the cross-driver
// integration test reuses (AGENTS §16.1): binding `createIndexedDBDriver` to the core
// `createDatabase` over the shared `INTEGRATION_TABLES` (tests/setup.ts), returning
// the handle, its name (for a reopen test), and a cleanup that closes the connection
// and deletes the database.

/** A core `Database` over the IndexedDB driver plus the boilerplate to name and
 *  dispose it — the cross-driver integration fixture. */
export interface IntegrationDatabaseInterface {
	/** The core `Database`, opened over `INTEGRATION_TABLES` via the IndexedDB driver. */
	readonly db: DatabaseInterface<typeof INTEGRATION_TABLES>
	/** The unique IndexedDB name the database was opened under (for reopen tests). */
	readonly name: string
	/** Close the connection and delete the underlying IndexedDB database. */
	cleanup(): Promise<void>
}

/**
 * Open the core database + relations stack over the IndexedDB driver, under a unique
 * name, returning the handle, its name, and a cleanup — the shared opener for the
 * cross-driver integration test, over the shared `INTEGRATION_TABLES` fixture
 * (tests/setup.ts), so a second backend's integration test can prove
 * driver-parity over identical tables.
 *
 * @returns The connected database, its IndexedDB name, and a cleanup
 */
export function createIntegrationDatabase(): IntegrationDatabaseInterface {
	const name = uniqueName('terrain-idb-int')
	const db = createDatabase({
		driver: createIndexedDBDriver(name),
		tables: INTEGRATION_TABLES,
	})
	const cleanup = async (): Promise<void> => {
		await db.close()
		await deleteDatabase(name)
	}
	return { db, name, cleanup }
}
