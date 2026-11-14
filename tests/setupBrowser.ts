// Browser-test setup — DOM/IndexedDB-only helpers, loaded second after
// `setup.ts` for the `src:browser` project. Real DOM, real `indexedDB` — do
// not mock browser APIs. Centralize DOM fixture builders and event factories
// here once used in more than one test file.

import type {
	IndexedDBCursorInterface,
	IndexedDBDatabaseInterface,
	IndexedDBDatabaseOptions,
	IndexedDBSchema,
	IndexDefinition,
	StoreDefinition,
} from '@src/browser'
import type { RecorderInterface, TeardownInterface } from '@orkestrel/test'
import { createIndexedDBDatabase, isIndexedDBError, promisifyRequest } from '@src/browser'
import { captureError, createTeardown, waitForDelay } from '@orkestrel/test'

// ── IndexedDB test fixtures (real Chromium, real `indexedDB`) ────────────────
//
// The shared open-a-database boilerplate every `src/browser` test reuses
// (`.claude/rules/tests.md` § Shared test infrastructure): a unique database
// name per call, a connected handle over a
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

class DatabaseSequence {
	#count = 0

	next(): number {
		return ++this.#count
	}
}

const DATABASE_SEQUENCE = new DatabaseSequence()

/**
 * Builds a process-unique IndexedDB database name from a monotonic counter
 * under an optional prefix, so concurrent tests never collide on a shared store.
 *
 * @param prefix - A readable name segment (defaults to `terrain-idb`)
 * @returns A name no earlier call has returned
 */
export function mintDatabase(prefix = 'terrain-idb'): string {
	return `${prefix}-${DATABASE_SEQUENCE.next()}`
}

/** Represents a connected test database plus the boilerplate to identify and dispose it. */
export interface TestDatabaseInterface<Stores extends IndexedDBSchema> {
	/** The IndexedDB handle, already `connect`ed and ready to use. */
	readonly db: IndexedDBDatabaseInterface<Stores>
	/** The unique name the database was opened under (for reopen / drop tests). */
	readonly name: string
	/** Close the connection and delete the database. */
	cleanup(): Promise<void>
}

/**
 * Builds the cleanup that disposes a test database: it closes the connection,
 * then deletes the database under the name it was opened with.
 *
 * @param db - The handle to close
 * @param name - The database name to delete
 * @returns A cleanup closing `db` and deleting `name`
 *
 * @remarks
 * A module-scope factory rather than a closure assigned inside
 * {@link createTestDatabase}: `.claude/rules/architecture.md` § Functions and
 * orchestration permits an anonymous function returned directly as the result and
 * bans one assigned to a local binding. The returned cleanup carries the same
 * blocked-deletion contract {@link dropDatabase} states.
 */
export function createDatabaseCleanup<Stores extends IndexedDBSchema>(
	db: IndexedDBDatabaseInterface<Stores>,
	name: string,
): () => Promise<void> {
	return async () => {
		db.close()
		await dropDatabase(name)
	}
}

/**
 * Opens a fresh, connected IndexedDB database over a store schema, under a unique
 * name, returning the handle and a cleanup — the shared opener for every browser
 * test (`.claude/rules/tests.md` § Shared test infrastructure). The handle is
 * already connected, so a test can reach `db.store(...)` immediately; `cleanup`
 * closes and deletes it.
 *
 * @param stores - The store schema (file-specific store / index definitions)
 * @param options - `version` pins an explicit schema version (omit for
 *   auto-managed mode); `prefix` names the database for readable diagnostics
 * @returns The connected database, its name, and a cleanup
 */
export async function createTestDatabase<const Stores extends IndexedDBSchema>(
	stores: Stores,
	options?: { readonly version?: number; readonly prefix?: string },
): Promise<TestDatabaseInterface<Stores>> {
	const name = mintDatabase(options?.prefix)
	const db = createIndexedDBDatabase({
		name,
		...(options?.version === undefined ? {} : { version: options.version }),
		stores,
	})
	await db.connect()
	return { db, name, cleanup: createDatabaseCleanup(db, name) }
}

/**
 * Drives a cursor chain to its end, collecting every visited cursor — the
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
	const seen = [first]
	while (true) {
		const cursor = seen.at(-1)
		if (!cursor) break
		seen.push(await cursor.continue())
	}
	return seen.filter((cursor) => cursor !== null)
}

/**
 * Returns the `code` of a caught value when it is an {@link IndexedDBError},
 * else `undefined`, letting a test assert the machine-readable code without a
 * conditional `expect` around the `instanceof` narrowing.
 *
 * @param value - A caught value (the rejection / throw under test)
 * @returns The `IndexedDBError` code, or `undefined` for any other value
 */
export function errorCode(value: unknown): string | undefined {
	return isIndexedDBError(value) ? value.code : undefined
}

// ── IndexedDB seed fixtures (the common stores every wrapper test starts from) ─
//
// The near-duplicate seed-a-`users`-store openers the `src/browser` tests
// reuse (`.claude/rules/tests.md` § Shared test infrastructure): each opens a
// uniquely-named database through
// {@link createTestDatabase}, sets the rows, and adds its `cleanup` to the
// caller's `createTeardown()` list (which the file destroys from an `afterEach`).
// The seed returns the connected `db`.

/** Defines the store schema {@link seedUsers} opens — a `users` store with a non-unique
 *  `byAge` index and a unique `byEmail` index. */
export const SEED_USER_STORES = {
	users: {
		path: 'id',
		indexes: [
			{ name: 'byAge', path: 'age' },
			{ name: 'byEmail', path: 'email', unique: true },
		],
	},
} as const satisfies IndexedDBSchema

/** Defines the store schema {@link seedStore} opens — a plain `users` store keyed by `id`. */
export const SEED_STORE_STORES = {
	users: { path: 'id' },
} as const satisfies IndexedDBSchema

/**
 * Seeds a `users` store keyed by `id` with a non-unique `byAge` index and a unique
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
 * Seeds a plain `users` store keyed by `id` (no secondary index) with three numbered
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

/** Defines the store schema {@link seedNonRecord} opens — an out-of-line `books` store with a
 *  `byLength` index, whose `length` path also indexes a string or an array value. */
export const SEED_BOOK_STORES = {
	books: { indexes: [{ name: 'byLength', path: 'length' }] },
} as const satisfies IndexedDBSchema

/**
 * Seeds an out-of-line `books` store with two records and one value that is no record
 * between them, written through the raw `IDBObjectStore` because the wrapper's writes
 * take a record. Adds its cleanup to `teardown`.
 *
 * @param teardown - The teardown list that closes and deletes the database
 * @param value - The value stored at key `b`; a string or an array also lands in `byLength`
 * @returns The connected database, holding `a` and `c` as records and `value` at `b`
 */
export async function seedNonRecord(
	teardown: TeardownInterface,
	value: unknown,
): Promise<IndexedDBDatabaseInterface<typeof SEED_BOOK_STORES>> {
	const { db, cleanup } = await createTestDatabase(SEED_BOOK_STORES)
	teardown.add(cleanup)
	await db.write('books', async (transaction) => {
		const native = transaction.store('books').store
		await promisifyRequest(native.put({ title: 'Atlas', length: 412 }, 'a'))
		await promisifyRequest(native.put(value, 'b'))
		await promisifyRequest(native.put({ title: 'Codex', length: 96 }, 'c'))
	})
	return db
}

/** Represents a caller-supplied name and the text a refusal message shows for it. */
export interface MessageName {
	readonly name: string
	readonly shown: string
	readonly received: string
}

/**
 * Lists the caller-supplied names every message proof drives: one carrying both quote
 * characters, and one longer than the 64 characters a message preview keeps, each beside the
 * exact text the message must show for it, and the text a contract fault line shows for it
 * as a received value, where a long value is quoted and capped a second time.
 */
export const MESSAGE_NAMES: readonly MessageName[] = Object.freeze([
	{
		name: `catalogue 'x' "y"`,
		shown: '"catalogue \'x\' \\"y\\""',
		received: '"catalogue \'x\' \\"y\\""',
	},
	{
		name: 'library-catalogue-library-catalogue-library-catalogue-library-catalogue-',
		shown: '"library-catalogue-library-catalogue-library-catalogue-library-c…',
		received: '"\\"library-catalogue-library-catalogue-library-catalogue-library…',
	},
])

/**
 * Represents an index definition written as a class instance: it carries the declared members,
 * and the definition contracts still refuse it, because a definition is a plain record.
 */
export class IndexLike {
	readonly name = 'byTitle'
	readonly path = 'title'
}

/**
 * Represents a store definition written as a class instance: it carries a declared member, and
 * the definition contracts still refuse it, because a definition is a plain record.
 */
export class StoreLike {
	readonly path = 'id'
}

/**
 * Represents database options written as a class instance: it carries the declared members, and
 * the options contract still refuses it, because the options are a plain record.
 */
export class OptionsLike {
	readonly name = 'catalogue'
	readonly stores = {}
}

/**
 * Migrates nothing: the `upgrade` callback a construction proof binds, so a bound function
 * reaches the options contract.
 *
 * @returns Nothing
 */
export function migrateNothing(): undefined {
	return undefined
}

/**
 * Creates database options whose `name` is a getter: each read records `'name'` on `reads` and
 * answers the next of `names`, so a proof counts the reads and tells a first answer from a later one.
 *
 * @param names - The answers, one per read, in order; a read past the last answers `''`
 * @param reads - The recorder each read records on
 * @returns Options holding no store, with `name` as the counted getter
 */
export function createShiftingOptions(
	names: readonly string[],
	reads: RecorderInterface<[string]>,
): IndexedDBDatabaseOptions {
	const answers = names[Symbol.iterator]()
	return {
		get name(): string {
			reads.handler('name')
			const next = answers.next()
			return next.done === true ? '' : next.value
		},
		stores: {},
	}
}

/**
 * Creates a store schema whose `books` definition carries `path` as a getter that records
 * `'path'` on `reads` at each read and answers `'id'`.
 *
 * @param reads - The recorder each read records on
 * @returns The schema, with the counted getter on `books.path`
 */
export function createShiftingStores(reads: RecorderInterface<[string]>): IndexedDBSchema {
	return {
		books: {
			get path(): string {
				reads.handler('path')
				return 'id'
			},
		},
	}
}

/** Represents one answer for each of the getters {@link createChangingOptions} defines. */
export interface ChangingAnswers {
	readonly name: string
	readonly version: number
	readonly upgrade: () => void
}

/**
 * Creates database options whose `name`, `version`, and `upgrade` are getters that answer from
 * `first` on their first read and from `later` after it, recording each read on `reads`, so a
 * proof tells a value read once from one read again.
 *
 * @param first - The answers of each getter's first read
 * @param later - The answers of every later read
 * @param reads - The recorder each read records its member name on
 * @returns Options holding one `books` store keyed by `id`
 */
export function createChangingOptions(
	first: ChangingAnswers,
	later: ChangingAnswers,
	reads: RecorderInterface<[string]>,
): IndexedDBDatabaseOptions {
	const names = [first.name][Symbol.iterator]()
	const versions = [first.version][Symbol.iterator]()
	const upgrades = [first.upgrade][Symbol.iterator]()
	return {
		get name(): string {
			reads.handler('name')
			const next = names.next()
			return next.done === true ? later.name : next.value
		},
		get version(): number {
			reads.handler('version')
			const next = versions.next()
			return next.done === true ? later.version : next.value
		},
		get upgrade(): () => void {
			reads.handler('upgrade')
			const next = upgrades.next()
			return next.done === true ? later.upgrade : next.value
		},
		stores: { books: { path: 'id' } },
	}
}

/** Holds the first line of every refusal the database constructor raises for its options. */
export const OPTIONS_REFUSAL_HEADER = 'Database options must match IndexedDBDatabaseOptions:'

/** Holds the last line of every options refusal: the expected shape, as contract summarizes it. */
export const OPTIONS_REFUSAL_SUMMARY =
	'send {"name": string (minLength 1), "stores": object of {"path"?: string | array, "increment"?:…, "version"?: integer (minimum 1), "upgrade"?: "function"}'

/** Represents one options value the types forbid, with the refusal construction must raise. */
export interface RefusedOptions {
	readonly label: string
	readonly options: unknown
	readonly message: string
	readonly context: Readonly<Record<string, unknown>>
}

/**
 * Lists options values a JavaScript caller can pass past the types, each with the exact
 * message and `context` of the one `DATA` refusal the database constructor raises for it:
 * `{ faults }` when the options contract refused the value, and `{ clone }` when contract could
 * not clone it.
 */
export const REFUSED_OPTIONS: readonly RefusedOptions[] = Object.freeze([
	{
		label: 'an undefined name',
		options: { name: undefined, stores: {} },
		message: 'Database options are not plain JSON data: cloneJSONValue: property is not JSON data',
		context: { clone: 'cloneJSONValue: property is not JSON data' },
	},
	{
		label: 'a numeric name',
		options: { name: 7, stores: {} },
		message:
			'Database options must match IndexedDBDatabaseOptions:\nname: type; expected string; received 7\nsend {"name": string (minLength 1), "stores": object of {"path"?: string | array, "increment"?:…, "version"?: integer (minimum 1), "upgrade"?: "function"}',
		context: { faults: [{ reason: 'type', path: ['name'], expected: 'string', received: '7' }] },
	},
	{
		label: 'an empty name',
		options: { name: '', stores: {} },
		message:
			'Database options must match IndexedDBDatabaseOptions:\nname: constraint; expected string; received ""; constraint min; limit 1\nsend {"name": string (minLength 1), "stores": object of {"path"?: string | array, "increment"?:…, "version"?: integer (minimum 1), "upgrade"?: "function"}',
		context: {
			faults: [
				{
					reason: 'constraint',
					path: ['name'],
					expected: 'string',
					constraint: 'min',
					limit: 1,
					received: '""',
				},
			],
		},
	},
	{
		label: 'no stores',
		options: { name: 'catalogue' },
		message:
			'Database options must match IndexedDBDatabaseOptions:\nstores: missing; expected object\nsend {"name": string (minLength 1), "stores": object of {"path"?: string | array, "increment"?:…, "version"?: integer (minimum 1), "upgrade"?: "function"}',
		context: { faults: [{ reason: 'missing', path: ['stores'], expected: 'object' }] },
	},
	{
		label: 'a string for stores',
		options: { name: 'catalogue', stores: 'abc' },
		message:
			'Database options must match IndexedDBDatabaseOptions:\nstores: type; expected object; received "abc"\nsend {"name": string (minLength 1), "stores": object of {"path"?: string | array, "increment"?:…, "version"?: integer (minimum 1), "upgrade"?: "function"}',
		context: {
			faults: [{ reason: 'type', path: ['stores'], expected: 'object', received: '"abc"' }],
		},
	},
	{
		label: 'a string increment',
		options: { name: 'catalogue', stores: { books: { increment: 'yes' } } },
		message:
			'Database options must match IndexedDBDatabaseOptions:\nstores.books.increment: type; expected boolean; received "yes"\nsend {"name": string (minLength 1), "stores": object of {"path"?: string | array, "increment"?:…, "version"?: integer (minimum 1), "upgrade"?: "function"}',
		context: {
			faults: [
				{
					reason: 'type',
					path: ['stores', 'books', 'increment'],
					expected: 'boolean',
					received: '"yes"',
				},
			],
		},
	},
	{
		label: 'a numeric key path',
		options: { name: 'catalogue', stores: { books: { path: 5 } } },
		message:
			'Database options must match IndexedDBDatabaseOptions:\nstores.books.path: variant; the value matches none of the 2 declared forms; send it exactly as the schema declares, one of: string or array of string\nstores.books.path: type; expected string; received 5\nsend {"name": string (minLength 1), "stores": object of {"path"?: string | array, "increment"?:…, "version"?: integer (minimum 1), "upgrade"?: "function"}',
		context: {
			faults: [
				{ reason: 'variant', path: ['stores', 'books', 'path'], variants: 2 },
				{ reason: 'type', path: ['stores', 'books', 'path'], expected: 'string', received: '5' },
			],
		},
	},
	{
		label: 'a string unique flag on an index',
		options: {
			name: 'catalogue',
			stores: { books: { indexes: [{ name: 'byTitle', path: 'title', unique: 'no' }] } },
		},
		message:
			'Database options must match IndexedDBDatabaseOptions:\nstores.books.indexes.0.unique: type; expected boolean; received "no"\nsend {"name": string (minLength 1), "stores": object of {"path"?: string | array, "increment"?:…, "version"?: integer (minimum 1), "upgrade"?: "function"}',
		context: {
			faults: [
				{
					reason: 'type',
					path: ['stores', 'books', 'indexes', '0', 'unique'],
					expected: 'boolean',
					received: '"no"',
				},
			],
		},
	},
	{
		label: 'an undeclared definition member',
		options: { name: 'catalogue', stores: { books: { path: 'id', autoIncrement: true } } },
		message:
			'Database options must match IndexedDBDatabaseOptions:\nstores.books.autoIncrement: extra; this key is not declared, remove it or use a declared key: path, increment, indexes\nsend {"name": string (minLength 1), "stores": object of {"path"?: string | array, "increment"?:…, "version"?: integer (minimum 1), "upgrade"?: "function"}',
		context: { faults: [{ reason: 'extra', path: ['stores', 'books', 'autoIncrement'] }] },
	},
	{
		label: 'two malformed stores',
		options: {
			name: 'catalogue',
			stores: { books: { path: 'id', autoIncrement: true, increment: 'yes' }, notes: { path: 5 } },
		},
		message:
			'Database options must match IndexedDBDatabaseOptions:\nstores.books.increment: type; expected boolean; received "yes"\nstores.books.autoIncrement: extra; this key is not declared, remove it or use a declared key: path, increment, indexes\nstores.notes.path: variant; the value matches none of the 2 declared forms; send it exactly as the schema declares, one of: string or array of string\nstores.notes.path: type; expected string; received 5\nsend {"name": string (minLength 1), "stores": object of {"path"?: string | array, "increment"?:…, "version"?: integer (minimum 1), "upgrade"?: "function"}',
		context: {
			faults: [
				{
					reason: 'type',
					path: ['stores', 'books', 'increment'],
					expected: 'boolean',
					received: '"yes"',
				},
				{ reason: 'extra', path: ['stores', 'books', 'autoIncrement'] },
				{ reason: 'variant', path: ['stores', 'notes', 'path'], variants: 2 },
				{ reason: 'type', path: ['stores', 'notes', 'path'], expected: 'string', received: '5' },
			],
		},
	},
	{
		label: 'a class instance as an index definition',
		options: { name: 'catalogue', stores: { books: { indexes: [new IndexLike()] } } },
		message:
			'Database options are not plain JSON data: cloneJSONValue: object is not a plain record',
		context: { clone: 'cloneJSONValue: object is not a plain record' },
	},
	{
		label: 'an optional member present as undefined',
		options: {
			name: 'catalogue',
			stores: { books: { indexes: [{ name: 'byTitle', path: 'title', unique: undefined }] } },
		},
		message: 'Database options are not plain JSON data: cloneJSONValue: property is not JSON data',
		context: { clone: 'cloneJSONValue: property is not JSON data' },
	},
	{
		label: 'a class instance as a store definition',
		options: { name: 'catalogue', stores: { books: new StoreLike() } },
		message:
			'Database options are not plain JSON data: cloneJSONValue: object is not a plain record',
		context: { clone: 'cloneJSONValue: object is not a plain record' },
	},
	{
		label: 'a store increment present as undefined',
		options: { name: 'catalogue', stores: { books: { increment: undefined } } },
		message: 'Database options are not plain JSON data: cloneJSONValue: property is not JSON data',
		context: { clone: 'cloneJSONValue: property is not JSON data' },
	},
	{
		label: 'a store path present as undefined',
		options: { name: 'catalogue', stores: { books: { path: undefined } } },
		message: 'Database options are not plain JSON data: cloneJSONValue: property is not JSON data',
		context: { clone: 'cloneJSONValue: property is not JSON data' },
	},
	{
		label: 'a string version',
		options: { name: 'catalogue', version: '2', stores: {} },
		message:
			'Database options must match IndexedDBDatabaseOptions:\nversion: type; expected integer; received "2"\nsend {"name": string (minLength 1), "stores": object of {"path"?: string | array, "increment"?:…, "version"?: integer (minimum 1), "upgrade"?: "function"}',
		context: {
			faults: [{ reason: 'type', path: ['version'], expected: 'integer', received: '"2"' }],
		},
	},
	{
		label: 'a version of zero',
		options: { name: 'catalogue', version: 0, stores: {} },
		message:
			'Database options must match IndexedDBDatabaseOptions:\nversion: constraint; expected integer; received 0; constraint min; limit 1\nsend {"name": string (minLength 1), "stores": object of {"path"?: string | array, "increment"?:…, "version"?: integer (minimum 1), "upgrade"?: "function"}',
		context: {
			faults: [
				{
					reason: 'constraint',
					path: ['version'],
					expected: 'integer',
					constraint: 'min',
					limit: 1,
					received: '0',
				},
			],
		},
	},
	{
		label: 'an upgrade that is not a function',
		options: { name: 'catalogue', stores: {}, upgrade: 'migrate' },
		message:
			'Database options must match IndexedDBDatabaseOptions:\nupgrade: type; expected literal; received "\\"migrate\\""; send one of "function"\nsend {"name": string (minLength 1), "stores": object of {"path"?: string | array, "increment"?:…, "version"?: integer (minimum 1), "upgrade"?: "function"}',
		context: {
			faults: [
				{ reason: 'type', path: ['upgrade'], expected: 'literal', received: '"\\"migrate\\""' },
			],
		},
	},
	{
		label: 'an undeclared option',
		options: { name: 'catalogue', stores: {}, durability: 'strict' },
		message:
			'Database options must match IndexedDBDatabaseOptions:\ndurability: extra; this key is not declared, remove it or use a declared key: name, version, stores, upgrade\nsend {"name": string (minLength 1), "stores": object of {"path"?: string | array, "increment"?:…, "version"?: integer (minimum 1), "upgrade"?: "function"}',
		context: { faults: [{ reason: 'extra', path: ['durability'] }] },
	},
	{
		label: 'three malformed options',
		options: { name: '', stores: 'x', version: 1.5 },
		message:
			'Database options must match IndexedDBDatabaseOptions:\nname: constraint; expected string; received ""; constraint min; limit 1\nversion: constraint; expected integer; received 1.5; constraint integer\nstores: type; expected object; received "x"\nsend {"name": string (minLength 1), "stores": object of {"path"?: string | array, "increment"?:…, "version"?: integer (minimum 1), "upgrade"?: "function"}',
		context: {
			faults: [
				{
					reason: 'constraint',
					path: ['name'],
					expected: 'string',
					constraint: 'min',
					limit: 1,
					received: '""',
				},
				{
					reason: 'constraint',
					path: ['version'],
					expected: 'integer',
					constraint: 'integer',
					received: '1.5',
				},
				{ reason: 'type', path: ['stores'], expected: 'object', received: '"x"' },
			],
		},
	},
	{
		label: 'the string function as upgrade',
		options: { name: 'catalogue', stores: {}, upgrade: 'function' },
		message:
			'Database options must match IndexedDBDatabaseOptions:\nupgrade: type; expected literal; received "\\"function\\""; send one of "function"\nsend {"name": string (minLength 1), "stores": object of {"path"?: string | array, "increment"?:…, "version"?: integer (minimum 1), "upgrade"?: "function"}',
		context: {
			faults: [
				{ reason: 'type', path: ['upgrade'], expected: 'literal', received: '"\\"function\\""' },
			],
		},
	},
	{
		label: 'a null upgrade',
		options: { name: 'catalogue', stores: {}, upgrade: null },
		message:
			'Database options must match IndexedDBDatabaseOptions:\nupgrade: type; expected literal; received "null"; send one of "function"\nsend {"name": string (minLength 1), "stores": object of {"path"?: string | array, "increment"?:…, "version"?: integer (minimum 1), "upgrade"?: "function"}',
		context: {
			faults: [{ reason: 'type', path: ['upgrade'], expected: 'literal', received: '"null"' }],
		},
	},
	{
		label: 'a numeric upgrade',
		options: { name: 'catalogue', stores: {}, upgrade: 7 },
		message:
			'Database options must match IndexedDBDatabaseOptions:\nupgrade: type; expected literal; received "7"; send one of "function"\nsend {"name": string (minLength 1), "stores": object of {"path"?: string | array, "increment"?:…, "version"?: integer (minimum 1), "upgrade"?: "function"}',
		context: {
			faults: [{ reason: 'type', path: ['upgrade'], expected: 'literal', received: '"7"' }],
		},
	},
	{
		label: 'an object whose toString returns function as upgrade',
		options: { name: 'catalogue', stores: {}, upgrade: { toString: () => 'function' } },
		message:
			'Database options must match IndexedDBDatabaseOptions:\nupgrade: type; expected literal; received "object"; send one of "function"\nsend {"name": string (minLength 1), "stores": object of {"path"?: string | array, "increment"?:…, "version"?: integer (minimum 1), "upgrade"?: "function"}',
		context: {
			faults: [{ reason: 'type', path: ['upgrade'], expected: 'literal', received: '"object"' }],
		},
	},
	{
		label: 'a version present as undefined',
		options: { name: 'catalogue', stores: {}, version: undefined },
		message: 'Database options are not plain JSON data: cloneJSONValue: property is not JSON data',
		context: { clone: 'cloneJSONValue: property is not JSON data' },
	},
	{
		label: 'an upgrade present as undefined',
		options: { name: 'catalogue', stores: {}, upgrade: undefined },
		message: 'Database options are not plain JSON data: cloneJSONValue: property is not JSON data',
		context: { clone: 'cloneJSONValue: property is not JSON data' },
	},
	{
		label: 'a class instance as options',
		options: new OptionsLike(),
		message:
			'Database options are not plain JSON data: cloneJSONRecord: value is not a plain record',
		context: { clone: 'cloneJSONRecord: value is not a plain record' },
	},
	{
		label: 'a version that is not finite',
		options: { name: 'catalogue', stores: {}, version: Number.NaN },
		message: 'Database options are not plain JSON data: cloneJSONValue: number is not finite',
		context: { clone: 'cloneJSONValue: number is not finite' },
	},
])

/** Represents what one raising read reported, in a form JSON carries across a page boundary. */
export interface RecordClaimFault {
	readonly code: string | undefined
	readonly context: Readonly<Record<string, unknown>> | undefined
	readonly message: string
}

/**
 * Represents the reading of the guide's invariant 7 over a store holding one value that is
 * no record: what the key reads report and what each value read raises.
 */
export interface RecordClaimReading {
	readonly count: number
	readonly has: boolean
	readonly keys: readonly string[]
	readonly get: RecordClaimFault
	readonly resolve: RecordClaimFault
	readonly records: RecordClaimFault
	readonly value: RecordClaimFault
}

/**
 * Reads the code, context, and message of a caught value, so a reading crosses a page
 * boundary as JSON.
 *
 * @param value - The caught value, or the value a read returned in place of a raise
 * @returns The fault an `IndexedDBError` carries, or no code and the value's text otherwise
 */
export function readFault(value: unknown): RecordClaimFault {
	return isIndexedDBError(value)
		? { code: value.code, context: value.context, message: value.message }
		: { code: undefined, context: undefined, message: String(value) }
}

/**
 * Runs the guide's invariant 7 against real IndexedDB: a number written through the raw
 * store at key `b`, between two records, read through every key read and every value read.
 *
 * @returns The reading, after the database is closed and deleted
 *
 * @remarks
 * `tests/src/browser/integration.test.ts` asserts the reading, so the guide's claim is
 * executed rather than matched as text.
 */
export async function readRecordClaim(): Promise<RecordClaimReading> {
	const teardown = createTeardown()
	try {
		const books = (await seedNonRecord(teardown, 7310)).store('books')
		const first = await books.cursor()
		const stopped = first === null ? null : await first.continue()
		return {
			count: await books.count(),
			has: await books.has('b'),
			keys: (await books.keys()).map(String),
			get: readFault(await books.get('b').catch((error: unknown) => error)),
			resolve: readFault(await books.resolve('b').catch((error: unknown) => error)),
			records: readFault(await books.records().catch((error: unknown) => error)),
			value: readFault(captureError(() => stopped?.value)),
		}
	} finally {
		await teardown.destroy()
	}
}

/** Reads the trailing counter segment a `mintDatabase` result carries. */
export function readCounter(name: string): number {
	return Number(name.slice(name.lastIndexOf('-') + 1))
}

/** Flattens a store's declared indexes into `name → [path, unique]`, defaulting `unique` to `false`. */
export function readIndexes(
	definition: StoreDefinition,
): Record<string, readonly [unknown, boolean]> {
	const declared: readonly IndexDefinition[] = definition.indexes ?? []
	return Object.fromEntries(
		declared.map((index) => [index.name, [index.path, index.unique === true]]),
	)
}

/** Returns the sorted store names a schema table declares. */
export function readStores(stores: IndexedDBSchema): readonly string[] {
	return Object.keys(stores).sort()
}

/** Updates numbered cursor rows and removes the row keyed by b. */
export async function updateCursor(cursor: IndexedDBCursorInterface | null): Promise<void> {
	if (cursor === null) return
	const row = cursor.value
	if (row.id === 'b') await cursor.remove()
	else await cursor.update({ ...row, n: Number(row.n) * 10 })
	await updateCursor(await cursor.continue())
}

/** Removes inactive rows while traversing a cursor. */
export async function removeInactive(cursor: IndexedDBCursorInterface | null): Promise<void> {
	if (cursor === null) return
	if (cursor.value.active === false) await cursor.remove()
	await removeInactive(await cursor.continue())
}
