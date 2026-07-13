import { IndexedDBError, range } from '@src/browser'
import { afterEach, describe, expect, it } from 'vitest'
import {
	createCleanups,
	createTestDatabase,
	drainCursor,
	errorCode,
	seedStore,
} from '../../setupBrowser.js'

// `IndexedDBCursorInterface` in real Chromium, obtained from a store or index
// cursor: the position snapshot (`cursor` / `source` / `key` / `primary` /
// `value` / `direction`), the moves (`continue` / `seek` / `advance`), and the
// in-place `update` / `delete`. The position is read eagerly at construction
// because IndexedDB reuses the live cursor object on advance, so we assert it
// against the recorded `IndexedDBCursor`, not a re-read. Each test opens a
// uniquely-named database through the shared opener.

const cleanups = createCleanups()

afterEach(cleanups.run)

// The plain `users` seed (primary key `id`, three numbered rows) lives in
// `setupBrowser.ts` (§16.1); each call registers its cleanup with this file's
// teardown via the `cleanups` registrar.
const seed = (): ReturnType<typeof seedStore> => seedStore(cleanups.push)

describe('IndexedDBCursor — position snapshot', () => {
	it('snapshots key / primary / value / direction / source at the current record', async () => {
		const db = await seed()
		const cursor = await db.store('users').cursor()
		expect(cursor).not.toBeNull()
		if (!cursor) return
		expect(cursor.key).toBe('a')
		expect(cursor.primary).toBe('a')
		expect(cursor.value).toEqual({ id: 'a', n: 1 })
		expect(cursor.direction).toBe('next')
		expect(cursor.source).toBeInstanceOf(IDBObjectStore)
		expect(cursor.cursor).toBeInstanceOf(IDBCursorWithValue)
	})

	it('opens in reverse with the prev direction', async () => {
		const db = await seed()
		const cursor = await db.store('users').cursor({ direction: 'prev' })
		expect(cursor).not.toBeNull()
		if (!cursor) return
		expect(cursor.direction).toBe('prev')
		const seen = await drainCursor(cursor)
		expect(seen.map((step) => step.value.id)).toEqual(['c', 'b', 'a'])
	})
})

describe('IndexedDBCursor — moves', () => {
	it('continue advances one record at a time, then null at the end', async () => {
		const db = await seed()
		let cursor = await db.store('users').cursor()
		const visited: string[] = []
		while (cursor) {
			visited.push(String(cursor.value.id))
			cursor = await cursor.continue()
		}
		expect(visited).toEqual(['a', 'b', 'c'])
	})

	it('continue(key) skips ahead to a given key', async () => {
		const db = await seed()
		const first = await db.store('users').cursor()
		expect(first).not.toBeNull()
		if (!first) return
		const jumped = await first.continue('c')
		expect(jumped?.value).toEqual({ id: 'c', n: 3 })
		expect(await jumped?.continue()).toBeNull()
	})

	it('advance(count) skips forward by count records', async () => {
		const db = await seed()
		const first = await db.store('users').cursor()
		expect(first).not.toBeNull()
		if (!first) return
		const skipped = await first.advance(2)
		expect(skipped?.value).toEqual({ id: 'c', n: 3 })
	})

	it('seek advances to a given index key and primary key', async () => {
		// Several rows share the index key 30, so `seek(30, primary)` lands on a
		// specific one — exactly what `continuePrimaryKey` is for.
		const { db, cleanup } = await createTestDatabase({
			users: { path: 'id', indexes: [{ name: 'byAge', path: 'age' }] },
		})
		cleanups.push(cleanup)
		await db.store('users').set([
			{ id: 'a', age: 30 },
			{ id: 'b', age: 30 },
			{ id: 'c', age: 30 },
		])
		const cursor = await db.store('users').index('byAge').cursor()
		expect(cursor).not.toBeNull()
		if (!cursor) return
		expect(cursor.primary).toBe('a')
		const sought = await cursor.seek(30, 'c')
		expect(sought?.primary).toBe('c')
		expect(sought?.value).toEqual({ id: 'c', age: 30 })
	})
})

describe('IndexedDBCursor — in-place mutation', () => {
	it('updates and deletes the record at the current position', async () => {
		const db = await seed()
		let cursor = await db.store('users').cursor()
		while (cursor) {
			if (cursor.value.id === 'b') await cursor.delete()
			else
				await cursor.update({
					...cursor.value,
					n: Number(cursor.value.n) * 10,
				})
			cursor = await cursor.continue()
		}
		const users = db.store('users')
		expect(await users.get('a')).toEqual({ id: 'a', n: 10 })
		expect(await users.get('b')).toBeUndefined()
		expect(await users.get('c')).toEqual({ id: 'c', n: 30 })
	})

	it('update returns the key and refreshes the cursor value', async () => {
		const db = await seed()
		const cursor = await db.store('users').cursor()
		expect(cursor).not.toBeNull()
		if (!cursor) return
		const key = await cursor.update({ id: 'a', n: 99 })
		expect(key).toBe('a')
		expect(cursor.value).toEqual({ id: 'a', n: 99 })
	})

	it('rejects update on an index cursor with READONLY (its transaction is readonly)', async () => {
		const { db, cleanup } = await createTestDatabase({
			users: { path: 'id', indexes: [{ name: 'byAge', path: 'age' }] },
		})
		cleanups.push(cleanup)
		await db.store('users').set({ id: 'a', age: 20 })
		const cursor = await db.store('users').index('byAge').cursor()
		expect(cursor).not.toBeNull()
		if (!cursor) return
		const onUpdate = await cursor.update({ id: 'a', age: 21 }).catch((error: unknown) => error)
		expect(onUpdate).toBeInstanceOf(IndexedDBError)
		expect(errorCode(onUpdate)).toBe('READONLY')
		// The store still holds the original row — the readonly cursor could not write.
		expect(await db.store('users').get('a')).toEqual({ id: 'a', age: 20 })
	})

	it('rejects delete on an index cursor with READONLY (its transaction is readonly)', async () => {
		const { db, cleanup } = await createTestDatabase({
			users: { path: 'id', indexes: [{ name: 'byAge', path: 'age' }] },
		})
		cleanups.push(cleanup)
		await db.store('users').set({ id: 'a', age: 20 })
		// A fresh cursor for `delete` — a failed `update` above can invalidate its
		// own cursor/request, so `delete` is asserted on an independent cursor
		// rather than chained after a failed `update` on the same one.
		const cursor = await db.store('users').index('byAge').cursor()
		expect(cursor).not.toBeNull()
		if (!cursor) return
		const onDelete = await cursor.delete().catch((error: unknown) => error)
		expect(onDelete).toBeInstanceOf(IndexedDBError)
		expect(errorCode(onDelete)).toBe('READONLY')
		expect(await db.store('users').get('a')).toEqual({ id: 'a', age: 20 })
	})
})

describe('IndexedDBCursor — ranges', () => {
	it('honours the cursor query range', async () => {
		const db = await seed()
		const seen = await drainCursor(await db.store('users').cursor({ query: range.from('b') }))
		expect(seen.map((step) => step.value.id)).toEqual(['b', 'c'])
	})
})
