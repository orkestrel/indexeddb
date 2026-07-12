import { IndexedDBError, range } from '@src/browser'
import { afterEach, describe, expect, it } from 'vitest'
import {
	createCleanups,
	createTestDatabase,
	drainCursor,
	errorCode,
} from '../../../setupBrowser.js'

// `IndexedDBTransactionStoreInterface` in real Chromium, reached through
// `tx.store(name)` inside a `db.read` / `db.write` scope: the live `store`
// getter, the same keyed CRUD surface as a standalone store (with array-first
// batch overloads, key ranges, and a `cursor`) but bound to the owning
// transaction — so a sequence of reads and writes is atomic — and WITHOUT
// `index`. Each test opens a uniquely-named database through the shared opener.

const cleanups = createCleanups()

afterEach(cleanups.run)

describe('IndexedDBTransactionStore — store handle', () => {
	it('exposes the live native object store', async () => {
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		cleanups.push(cleanup)
		await db.read('users', (tx) => {
			const bound = tx.store('users')
			expect(bound.store).toBeInstanceOf(IDBObjectStore)
			expect(bound.store.name).toBe('users')
		})
	})
})

describe('IndexedDBTransactionStore — CRUD within a scope', () => {
	it('reads back its own uncommitted writes inside one scope', async () => {
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		cleanups.push(cleanup)
		let seen: unknown
		let present = false
		let total = 0
		await db.write('users', async (tx) => {
			const users = tx.store('users')
			await users.set({ id: 'u1', name: 'Ada' })
			// Same transaction — the write is visible before the scope commits.
			seen = await users.get('u1')
			present = await users.has('u1')
			total = await users.count()
		})
		expect(seen).toEqual({ id: 'u1', name: 'Ada' })
		expect(present).toBe(true)
		expect(total).toBe(1)
		// And it committed with the scope.
		expect(await db.store('users').get('u1')).toEqual({ id: 'u1', name: 'Ada' })
	})

	it('resolve throws NOT_FOUND on a miss within the scope', async () => {
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		cleanups.push(cleanup)
		let caught: unknown
		await db.read('users', async (tx) => {
			caught = await tx
				.store('users')
				.resolve('nope')
				.catch((error: unknown) => error)
		})
		expect(caught).toBeInstanceOf(IndexedDBError)
		expect(errorCode(caught)).toBe('NOT_FOUND')
	})

	it('add throws CONSTRAINT on a duplicate within the scope', async () => {
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		cleanups.push(cleanup)
		await db.store('users').set({ id: 'u1' })
		let caught: unknown
		await db
			.write('users', async (tx) => {
				caught = await tx
					.store('users')
					.add({ id: 'u1' })
					.catch((error: unknown) => error)
			})
			.catch(() => {})
		expect(caught).toBeInstanceOf(IndexedDBError)
		expect(errorCode(caught)).toBe('CONSTRAINT')
	})

	it('lists keys / records over a range and clears within the scope', async () => {
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		cleanups.push(cleanup)
		await db.write('users', async (tx) => {
			const users = tx.store('users')
			await users.set([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
			expect(await users.keys()).toEqual(['a', 'b', 'c'])
			expect((await users.records(range.from('b'))).map((row) => row.id)).toEqual(['b', 'c'])
			expect((await users.records(undefined, 2)).length).toBe(2)
		})
		await db.write('users', async (tx) => {
			await tx.store('users').clear()
		})
		expect(await db.store('users').count()).toBe(0)
	})
})

describe('IndexedDBTransactionStore — array-first batch overloads', () => {
	it('batches set / get / has / remove inside the scope', async () => {
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		cleanups.push(cleanup)
		let gotten: unknown
		let presence: readonly boolean[] = []
		await db.write('users', async (tx) => {
			const users = tx.store('users')
			const keys = await users.set([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
			expect(keys).toEqual(['a', 'b', 'c'])
			gotten = await users.get(['a', 'missing', 'c'])
			presence = await users.has(['a', 'missing'])
			await users.remove(['a', 'b'])
		})
		expect(gotten).toEqual([{ id: 'a' }, undefined, { id: 'c' }])
		expect(presence).toEqual([true, false])
		expect(await db.store('users').keys()).toEqual(['c'])
	})
})

describe('IndexedDBTransactionStore — out-of-line keys and cursor', () => {
	it('writes out-of-line keys with an explicit key argument', async () => {
		const { db, cleanup } = await createTestDatabase({ events: {} })
		cleanups.push(cleanup)
		await db.write('events', async (tx) => {
			await tx.store('events').set({ type: 'click' }, 'e1')
		})
		expect(await db.store('events').get('e1')).toEqual({ type: 'click' })
	})

	it('opens a cursor within the scope', async () => {
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		cleanups.push(cleanup)
		await db.store('users').set([{ id: 'a' }, { id: 'b' }])
		let ids: readonly string[] = []
		await db.read('users', async (tx) => {
			const seen = await drainCursor(await tx.store('users').cursor())
			ids = seen.map((cursor) => String(cursor.value.id))
		})
		expect(ids).toEqual(['a', 'b'])
	})

	it('rolls every write in the scope back when it throws', async () => {
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		cleanups.push(cleanup)
		await db.store('users').set({ id: 'u1', n: 1 })
		await db
			.write('users', async (tx) => {
				const users = tx.store('users')
				await users.set({ id: 'u1', n: 2 })
				await users.set({ id: 'u2', n: 9 })
				throw new Error('boom')
			})
			.catch(() => {})
		expect(await db.store('users').get('u1')).toEqual({ id: 'u1', n: 1 })
		expect(await db.store('users').get('u2')).toBeUndefined()
	})
})
