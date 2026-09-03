import {
	createIndexedDBDatabase,
	hasKey,
	IndexedDBError,
	isIndexedDBError,
	promisifyRequest,
	promisifyTransaction,
	rangeAboveKey,
	rangeBelowKey,
	rangeFromKey,
	rangePrefix,
	rangeToKey,
	readRecord,
	readRecords,
	wrapCall,
	wrapError,
} from '@src/browser'
import { afterEach, describe, expect, it } from 'vitest'
import { createTeardown } from '@orkestrel/test'
import { createDatabaseCleanup, createTestDatabase } from '../../setupBrowser.js'

// The EXECUTED half of guides parity for `guides/indexeddb.md`. `tests/guides.test.ts` reads
// names — from the guide's tables, from the barrel, from each fence's imports — and a name that
// resolves says nothing about the sentence beside it, so a fence whose comment claims a value the
// code contradicts passes every one of those checks. Each case here transcribes one flagship fence
// and asserts the value its comments claim, against real Chromium storage over a uniquely-named
// database from `createTestDatabase`. Change a fence, change the transcription beside it.
//
// The guide's literal database name (`app`) is the one line each transcription does not copy: the
// suite is order- and rerun-independent, so every case opens its own name. `tests/guides.test.ts`
// carries the presence guard that proves the transcribed lines are still the documented ones.

const teardown = createTeardown()

afterEach(teardown.destroy)

describe('guides/indexeddb.md — the Surface fence', () => {
	it('reads back the row it wrote, batches an array in to keys out, and reads adults off the index', async () => {
		const { db, cleanup } = await createTestDatabase(
			{ users: { path: 'id', indexes: [{ name: 'byAge', path: 'age' }] } },
			{ version: 1 },
		)
		teardown.add(cleanup)

		const users = db.store('users') // lazily connects on first use — no explicit open
		await users.set({ id: 'u1', name: 'Ada', age: 36 })
		const keys = await users.set([
			{ id: 'u2', name: 'Bea', age: 17 },
			{ id: 'u3', name: 'Cy', age: 51 },
		]) // array in → array of keys out (array-first batch)
		expect(keys).toEqual(['u2', 'u3'])

		// point read by primary key → the row, or undefined
		expect(await users.get('u1')).toEqual({ id: 'u1', name: 'Ada', age: 36 })
		expect(await users.get('ghost')).toBeUndefined()

		// adults, index-backed — Bea at 17 is below the boundary and Ada and Cy are above it
		const adults = await users.index('byAge').records(rangeFromKey(18))
		expect(adults.map((row) => row.id)).toEqual(['u1', 'u3'])
	})
})

describe('guides/indexeddb.md — Index-backed reads with key ranges', () => {
	it('returns exactly the keys each range builder names', async () => {
		const { db, cleanup } = await createTestDatabase({
			users: {
				path: 'id',
				indexes: [
					{ name: 'byAge', path: 'age' },
					{ name: 'byEmail', path: 'email', unique: true },
				],
			},
		})
		teardown.add(cleanup)
		const users = db.store('users')
		await users.set([
			{ id: 'user:1', age: 36, email: 'ada@x.io' },
			{ id: 'user:5', age: 17, email: 'bea@x.io' },
			{ id: 'user:9', age: 70, email: 'cy@x.io' },
			{ id: 'zzz', age: 40, email: 'dee@x.io' },
		])

		// exactly one primary key
		expect((await users.records(IDBKeyRange.only('user:1'))).map((row) => row.id)).toEqual([
			'user:1',
		])
		// keys greater than user:1
		expect((await users.records(rangeAboveKey('user:1'))).map((row) => row.id)).toEqual([
			'user:5',
			'user:9',
			'zzz',
		])
		// keys less than user:9
		expect((await users.records(rangeBelowKey('user:9'))).map((row) => row.id)).toEqual([
			'user:1',
			'user:5',
		])
		// keys less than or equal to user:9
		expect((await users.records(rangeToKey('user:9'))).map((row) => row.id)).toEqual([
			'user:1',
			'user:5',
			'user:9',
		])
		// working-age — 36 and 40 fall inside the bound, 17 and 70 outside it
		const working = await users.index('byAge').records(IDBKeyRange.bound(18, 65))
		expect(working.map((row) => row.id)).toEqual(['user:1', 'zzz'])
		// how many adults
		expect(await users.index('byAge').count(rangeFromKey(18))).toBe(3)
		// unique-index point lookup
		expect(await users.index('byEmail').get('ada@x.io')).toEqual({
			id: 'user:1',
			age: 36,
			email: 'ada@x.io',
		})
		// primary-key prefix scan — `zzz` sorts outside the prefix
		expect((await users.records(rangePrefix('user:'))).map((row) => row.id)).toEqual([
			'user:1',
			'user:5',
			'user:9',
		])
	})
})

describe('guides/indexeddb.md — Cursor streaming and in-place mutation', () => {
	it('removes the records the walk finds inactive and leaves the rest', async () => {
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		teardown.add(cleanup)
		await db.store('users').set([
			{ id: 'a', active: true },
			{ id: 'b', active: false },
			{ id: 'c', active: true },
		])

		let cursor = await db.store('users').cursor()
		while (cursor) {
			if (cursor.value?.active === false) await cursor.remove()
			cursor = await cursor.continue()
		}

		expect(await db.store('users').keys()).toEqual(['a', 'c'])
	})
})

describe('guides/indexeddb.md — Seeking an index cursor to one primary key', () => {
	it('lands on the primary key given, among the rows sharing one index key', async () => {
		const { db, cleanup } = await createTestDatabase({
			users: { path: 'id', indexes: [{ name: 'byAge', path: 'age' }] },
		})
		teardown.add(cleanup)
		await db.store('users').set([
			{ id: 'a', age: 30 },
			{ id: 'b', age: 30 },
			{ id: 'c', age: 30 },
		])

		let cursor = await db.store('users').index('byAge').cursor()
		expect(cursor?.primary).toBe('a')
		if (cursor) cursor = await cursor.seek(30, 'c')
		expect(cursor?.primary).toBe('c')
	})
})

describe('guides/indexeddb.md — Explicit transaction control and cursor movement', () => {
	it('updates the record one advance forward, not the one the walk started on', async () => {
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		teardown.add(cleanup)
		await db.store('users').set([{ id: 'a' }, { id: 'b' }, { id: 'c' }])

		await db.write('users', async (transaction) => {
			let cursor = await transaction.store('users').cursor()
			if (cursor) cursor = await cursor.advance(1) // skip forward one record
			if (cursor?.value) await cursor.update({ ...cursor.value, seen: true })
			transaction.commit() // flush early instead of waiting for the scope to resolve
		})

		// The rebind is what makes `update` write the advanced position: `b`, not `a`.
		expect(await db.store('users').get('a')).toEqual({ id: 'a' })
		expect(await db.store('users').get('b')).toEqual({ id: 'b', seen: true })
		expect(await db.store('users').get('c')).toEqual({ id: 'c' })
	})
})

describe('guides/indexeddb.md — The request-boundary helpers directly', () => {
	it('drives each helper over the raw store the transaction exposes', async () => {
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		teardown.add(cleanup)
		await db.store('users').set([
			{ id: 'u1', name: 'Ada' },
			{ id: 'u2', name: 'Bea' },
		])

		await db.read('users', async (transaction) => {
			const native = transaction.store('users').store
			// sync throw → IndexedDBError too
			expect(await promisifyRequest(wrapCall(() => native.get('u1')))).toEqual({
				id: 'u1',
				name: 'Ada',
			})
			// narrowed to Row (or undefined) with isRecord
			expect(await readRecord(native, 'u1')).toEqual({ id: 'u1', name: 'Ada' })
			// every record, narrowed the same way
			expect((await readRecords(native)).map((row) => row.id)).toEqual(['u1', 'u2'])
			// a native count() > 0
			expect(await hasKey(native, 'u1')).toBe(true)
			expect(await hasKey(native, 'ghost')).toBe(false)
			// resolves after the transaction commits
			await promisifyTransaction(native.transaction)
		})

		// the same DOMException → IndexedDBError mapping every bridge uses
		const unknown = wrapError(null)
		expect(unknown).toBeInstanceOf(IndexedDBError)
		expect(unknown.code).toBe('UNKNOWN')
	})
})

describe('guides/indexeddb.md — Branching on a typed fault', () => {
	it('falls back to an upsert on the CONSTRAINT a duplicate add raises', async () => {
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		teardown.add(cleanup)
		await db.store('users').add({ id: 'u1', name: 'Bea' })

		let branch = 'no fault'
		try {
			await db.store('users').add({ id: 'u1', name: 'Ada' })
		} catch (error) {
			if (error instanceof IndexedDBError && error.code === 'CONSTRAINT') {
				branch = 'CONSTRAINT'
				await db.store('users').set({ id: 'u1', name: 'Ada' })
			} else throw error
		}

		expect(branch).toBe('CONSTRAINT')
		expect(await db.store('users').get('u1')).toEqual({ id: 'u1', name: 'Ada' })
	})
})

describe('guides/indexeddb.md — Narrowing a caught value with isIndexedDBError', () => {
	it('narrows the NOT_FOUND a resolve miss rejects with', async () => {
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		teardown.add(cleanup)

		let branch = 'no fault'
		try {
			await db.store('users').resolve('ghost')
		} catch (error) {
			if (isIndexedDBError(error) && error.code === 'NOT_FOUND') {
				branch = 'NOT_FOUND'
			} else throw error
		}

		expect(branch).toBe('NOT_FOUND')
	})
})

describe('guides/indexeddb.md — Versioned upgrades', () => {
	it('drops, creates, indexes, and migrates inside one versionchange transaction', async () => {
		// The prior version the fence upgrades FROM: a retired `legacy` store, and a `users`
		// store carrying the `byRetired` index the upgrade removes.
		const { db: first, name } = await createTestDatabase(
			{
				legacy: { path: 'id' },
				users: { path: 'id', indexes: [{ name: 'byRetired', path: 'retired' }] },
			},
			{ version: 1 },
		)
		await first.store('users').set([
			{ id: 'u1', name: 'Ada' },
			{ id: 'u2', name: 'Bea' },
		])
		first.close()

		const db = createIndexedDBDatabase({
			name,
			version: 2,
			stores: { users: { path: 'id', indexes: [{ name: 'byName', path: 'name' }] } },
			upgrade: async (context) => {
				// Drop a retired store.
				context.stores.drop('legacy')
				// Create a store the built-in create-missing pass doesn't cover because it
				// isn't declared in `stores` — app-internal bookkeeping, for example.
				context.stores.create('meta', { path: 'key' })
				// The built-in pass only creates missing stores, so an index on an
				// already-existing store goes through the index manager; `drop` is its
				// inverse, over an index a prior version left behind.
				context.indexes.create('users', { name: 'byName', path: 'name' })
				context.indexes.drop('users', 'byRetired')
				// Migrate data in place, awaiting only the IDB requests `store()` issues.
				const store = context.stores.store('users')
				for (const row of await store.records()) {
					await store.set({ ...row, migrated: true })
				}
			},
		})
		teardown.add(createDatabaseCleanup(db, name))
		await db.connect()

		expect(db.version).toBe(2)
		// `legacy` is gone, `meta` was created, and `context.stores.names` reported the live set.
		expect([...db.stores].sort()).toEqual(['meta', 'users'])
		// Every row carries the migration the upgrade wrote.
		expect(await db.store('users').records()).toEqual([
			{ id: 'u1', name: 'Ada', migrated: true },
			{ id: 'u2', name: 'Bea', migrated: true },
		])
		// `byName` was created on the already-existing store, and `byRetired` was dropped.
		expect(await db.store('users').index('byName').get('Ada')).toEqual({
			id: 'u1',
			name: 'Ada',
			migrated: true,
		})
		expect(Array.from(db.database.transaction(['users']).objectStore('users').indexNames)).toEqual([
			'byName',
		])
	})
})
