import type { IndexedDBTransactionStoreInterface } from '@src/browser'
import { IndexedDBError, isIndexedDBError, promisifyRequest, rangeFromKey } from '@src/browser'
import { afterEach, describe, expect, it } from 'vitest'
import { isNumber } from '@orkestrel/contract'
import { createTeardown, waitForDelay } from '@orkestrel/test'
import { createTestDatabase, drainCursor, errorCode, seedNonRecord } from '../../setupBrowser.js'

// `IndexedDBTransactionStoreInterface` in real Chromium, reached through
// `transaction.store(name)` inside a `db.read` / `db.write` scope: the live `store`
// getter, the same keyed CRUD surface as a standalone store (with array-first
// batch overloads, key ranges, and a `cursor`) but bound to the owning
// transaction — so a sequence of reads and writes is atomic — and WITHOUT
// `index`. Each test opens a uniquely-named database through the shared opener.

const teardown = createTeardown()

afterEach(teardown.destroy)

describe('IndexedDBTransactionStore — store handle', () => {
	it('exposes the live native object store', async () => {
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		teardown.add(cleanup)
		await db.read('users', (transaction) => {
			const bound = transaction.store('users')
			expect(bound.store).toBeInstanceOf(IDBObjectStore)
			expect(bound.store.name).toBe('users')
		})
	})
})

describe('IndexedDBTransactionStore — CRUD within a scope', () => {
	it('reads back its own uncommitted writes inside one scope', async () => {
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		teardown.add(cleanup)
		const seen = Promise.withResolvers<unknown>()
		const present = Promise.withResolvers<boolean>()
		const total = Promise.withResolvers<number>()
		await db.write('users', async (transaction) => {
			const users = transaction.store('users')
			await users.set({ id: 'u1', name: 'Ada' })
			// Same transaction — the write is visible before the scope commits.
			seen.resolve(await users.get('u1'))
			present.resolve(await users.has('u1'))
			total.resolve(await users.count())
		})
		expect(await seen.promise).toEqual({ id: 'u1', name: 'Ada' })
		expect(await present.promise).toBe(true)
		expect(await total.promise).toBe(1)
		// And it committed with the scope.
		expect(await db.store('users').get('u1')).toEqual({ id: 'u1', name: 'Ada' })
	})

	it('resolve throws NOT_FOUND on a miss within the scope', async () => {
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		teardown.add(cleanup)
		const caught = Promise.withResolvers<unknown>()
		await db.read('users', async (transaction) => {
			caught.resolve(
				await transaction
					.store('users')
					.resolve('nope')
					.catch((error: unknown) => error),
			)
		})
		expect(await caught.promise).toBeInstanceOf(IndexedDBError)
		expect(errorCode(await caught.promise)).toBe('NOT_FOUND')
	})

	it('resolve writes a missing key through a capped preview, and keeps the raw key in the context', async () => {
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		teardown.add(cleanup)
		const long = 'k'.repeat(1_000_000)
		const faults = Promise.withResolvers<readonly unknown[]>()
		await db.read('users', async (transaction) => {
			const users = transaction.store('users')
			faults.resolve([
				await users.resolve(long).catch((error: unknown) => error),
				await users.resolve("x); store 'y'").catch((error: unknown) => error),
			])
		})
		const [lengthy, forged] = await faults.promise
		expect(errorCode(lengthy)).toBe('NOT_FOUND')
		expect(isIndexedDBError(lengthy) ? lengthy.message.length : Number.NaN).toBeLessThan(200)
		expect(isIndexedDBError(lengthy) ? lengthy.context : undefined).toEqual({
			store: 'users',
			key: long,
		})
		expect(isIndexedDBError(forged) ? forged.message : undefined).toBe(
			`No record in store "users" for key "x); store 'y'"`,
		)
		expect(forged).toHaveProperty('context', { store: 'users', key: "x); store 'y'" })
	})

	it('add throws CONSTRAINT on a duplicate within the scope', async () => {
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		teardown.add(cleanup)
		await db.store('users').set({ id: 'u1' })
		const caught = Promise.withResolvers<unknown>()
		await db
			.write('users', async (transaction) => {
				caught.resolve(
					await transaction
						.store('users')
						.add({ id: 'u1' })
						.catch((error: unknown) => error),
				)
			})
			.catch(() => {})
		expect(await caught.promise).toBeInstanceOf(IndexedDBError)
		expect(errorCode(await caught.promise)).toBe('CONSTRAINT')
	})

	it('lists keys / records over a range and clears within the scope', async () => {
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		teardown.add(cleanup)
		await db.write('users', async (transaction) => {
			const users = transaction.store('users')
			await users.set([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
			expect(await users.keys()).toEqual(['a', 'b', 'c'])
			expect((await users.records(rangeFromKey('b'))).map((row) => row.id)).toEqual(['b', 'c'])
			expect((await users.records(undefined, 2)).length).toBe(2)
		})
		await db.write('users', async (transaction) => {
			await transaction.store('users').clear()
		})
		expect(await db.store('users').count()).toBe(0)
	})
})

describe('IndexedDBTransactionStore — array-first batch overloads', () => {
	it('batches set / get / has / remove inside the scope', async () => {
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		teardown.add(cleanup)
		const gotten = Promise.withResolvers<unknown>()
		const presence = Promise.withResolvers<readonly boolean[]>()
		await db.write('users', async (transaction) => {
			const users = transaction.store('users')
			const keys = await users.set([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
			expect(keys).toEqual(['a', 'b', 'c'])
			gotten.resolve(await users.get(['a', 'missing', 'c']))
			presence.resolve(await users.has(['a', 'missing']))
			await users.remove(['a', 'b'])
		})
		expect(await gotten.promise).toEqual([{ id: 'a' }, undefined, { id: 'c' }])
		expect(await presence.promise).toEqual([true, false])
		expect(await db.store('users').keys()).toEqual(['c'])
	})
})

describe('IndexedDBTransactionStore — out-of-line keys and cursor', () => {
	it('writes out-of-line keys with an explicit key argument', async () => {
		const { db, cleanup } = await createTestDatabase({ events: {} })
		teardown.add(cleanup)
		await db.write('events', async (transaction) => {
			await transaction.store('events').set({ type: 'click' }, 'e1')
		})
		expect(await db.store('events').get('e1')).toEqual({ type: 'click' })
	})

	it('opens a cursor within the scope', async () => {
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		teardown.add(cleanup)
		await db.store('users').set([{ id: 'a' }, { id: 'b' }])
		const ids = Promise.withResolvers<readonly string[]>()
		await db.read('users', async (transaction) => {
			const seen = await drainCursor(await transaction.store('users').cursor())
			ids.resolve(seen.map((cursor) => String(cursor.value.id)))
		})
		expect(await ids.promise).toEqual(['a', 'b'])
	})

	it('rolls every write in the scope back when it throws', async () => {
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		teardown.add(cleanup)
		await db.store('users').set({ id: 'u1', n: 1 })
		await db
			.write('users', async (transaction) => {
				const users = transaction.store('users')
				await users.set({ id: 'u1', n: 2 })
				await users.set({ id: 'u2', n: 9 })
				throw new Error('boom')
			})
			.catch(() => {})
		expect(await db.store('users').get('u1')).toEqual({ id: 'u1', n: 1 })
		expect(await db.store('users').get('u2')).toBeUndefined()
	})
})

describe('IndexedDBTransactionStore — synchronous native faults', () => {
	it('throws a real INACTIVE once the owning transaction auto-commits out from under it', async () => {
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		teardown.add(cleanup)
		const captured = Promise.withResolvers<IndexedDBTransactionStoreInterface>()
		await db.write('users', (transaction) => {
			// Capture the transaction-bound store but issue no request on it — the
			// scope resolves synchronously, so the owning transaction auto-commits
			// once control returns to the event loop.
			captured.resolve(transaction.store('users'))
		})
		// A macrotask past the scope's resolution: the transaction has committed and
		// gone inactive. `get` issues a synchronous native `IDBObjectStore.get` on a
		// store whose transaction is no longer active — the wrapper's `wrapCall`
		// catches that synchronous `TransactionInactiveError` and rejects with a
		// typed `IndexedDBError`, never an unhandled throw.
		await waitForDelay(10)
		const bound = await captured.promise
		const caught = await bound.get('u1').catch((error: unknown) => error)
		expect(caught).toBeInstanceOf(IndexedDBError)
		expect(errorCode(caught)).toBe('INACTIVE')
	})
})

describe('IndexedDBTransactionStore — a stored value that is no record', () => {
	it('raises RECORD from get, resolve, and records, each naming the key', async () => {
		const db = await seedNonRecord(teardown, 7310)
		const faults = Promise.withResolvers<readonly unknown[]>()
		await db.read('books', async (transaction) => {
			const books = transaction.store('books')
			faults.resolve([
				await books.get('b').catch((error: unknown) => error),
				await books.resolve('b').catch((error: unknown) => error),
				await books.records().catch((error: unknown) => error),
			])
		})
		const [got, resolved, bulk] = await faults.promise
		expect(errorCode(got)).toBe('RECORD')
		expect(got).toHaveProperty('context', { store: 'books', key: 'b' })
		expect(errorCode(resolved)).toBe('RECORD')
		expect(resolved).toHaveProperty('context', { store: 'books', key: 'b' })
		expect(errorCode(bulk)).toBe('RECORD')
		expect(bulk).toHaveProperty('context', { store: 'books', key: 'b' })
	})

	it('reads the entry through count, has, and keys inside the scope', async () => {
		const db = await seedNonRecord(teardown, 7310)
		const reads = Promise.withResolvers<readonly unknown[]>()
		await db.read('books', async (transaction) => {
			const books = transaction.store('books')
			reads.resolve([await books.count(), await books.has('b'), await books.keys()])
		})
		expect(await reads.promise).toEqual([3, true, ['a', 'b', 'c']])
	})
})

describe('IndexedDBTransactionStore — the key a failing bulk read names beside the caller writes', () => {
	it('names no key when the caller removes the number before the pair reads, and the record stays', async () => {
		const { db, cleanup } = await createTestDatabase({ notes: {} })
		teardown.add(cleanup)
		await db.write('notes', async (transaction) => {
			const native = transaction.store('notes').store
			await promisifyRequest(native.put(7310, 'k01'))
			await promisifyRequest(native.put({ title: 'Kept' }, 'k02'))
		})
		const outcome = Promise.withResolvers<unknown>()
		await db.write('notes', async (transaction) => {
			const notes = transaction.store('notes')
			const [caught] = await Promise.all([
				notes.records().catch((error: unknown) => error),
				notes.remove('k01'),
			])
			outcome.resolve(caught)
		})
		const caught = await outcome.promise
		expect(errorCode(caught)).toBe('RECORD')
		expect(caught).toHaveProperty('context', { store: 'notes' })
		expect(String(caught)).toContain('left before its key was read')
		expect(await db.store('notes').get('k02')).toEqual({ title: 'Kept' })
	})

	it('reaches the hazard: a key list asked after the failing read names the record at k02', async () => {
		// The control for the preceding case: the late form, `getAllKeys(query, position + 1)`
		// issued after the failing read settles, queues behind the caller's delete.
		const { db, cleanup } = await createTestDatabase({ notes: {} })
		teardown.add(cleanup)
		await db.write('notes', async (transaction) => {
			const native = transaction.store('notes').store
			await promisifyRequest(native.put(7310, 'k01'))
			await promisifyRequest(native.put({ title: 'Kept' }, 'k02'))
		})
		const named = Promise.withResolvers<unknown>()
		await db.write('notes', async (transaction) => {
			const native = transaction.store('notes').store
			const read = promisifyRequest(native.getAll())
			const removal = promisifyRequest(native.delete('k01'))
			const values = await read
			const position = values.findIndex(isNumber)
			const late = await promisifyRequest(native.getAllKeys(undefined, position + 1))
			await removal
			named.resolve(late.at(-1))
		})
		expect(await named.promise).toBe('k02')
	})

	it('names the key the pair read when the caller removes that entry after a read queued behind the failing one', async () => {
		// The caller's removal is issued after the failing read settles and after the pair
		// is issued, so only a pair with no `await` between its calls reads both lists
		// before the removal runs.
		const { db, cleanup } = await createTestDatabase({ notes: {} })
		teardown.add(cleanup)
		await db.write('notes', async (transaction) => {
			const native = transaction.store('notes').store
			await promisifyRequest(native.put(7310, 'k01'))
			await promisifyRequest(native.put({ title: 'Kept' }, 'k02'))
		})
		const outcome = Promise.withResolvers<unknown>()
		await db.write('notes', async (transaction) => {
			const notes = transaction.store('notes')
			const read = notes.records().catch((error: unknown) => error)
			await notes.get('k02')
			await notes.remove('k01')
			outcome.resolve(await read)
		})
		const caught = await outcome.promise
		expect(errorCode(caught)).toBe('RECORD')
		expect(caught).toHaveProperty('context', { store: 'notes', key: 'k01' })
	})

	it('names k02 when the number sits at k02 and the caller removes the record at k01', async () => {
		const { db, cleanup } = await createTestDatabase({ notes: {} })
		teardown.add(cleanup)
		await db.write('notes', async (transaction) => {
			const native = transaction.store('notes').store
			await promisifyRequest(native.put({ title: 'Gone' }, 'k01'))
			await promisifyRequest(native.put(7310, 'k02'))
		})
		const outcome = Promise.withResolvers<unknown>()
		await db.write('notes', async (transaction) => {
			const notes = transaction.store('notes')
			const [caught] = await Promise.all([
				notes.records().catch((error: unknown) => error),
				notes.remove('k01'),
			])
			outcome.resolve(caught)
		})
		const caught = await outcome.promise
		expect(errorCode(caught)).toBe('RECORD')
		expect(caught).toHaveProperty('context', { store: 'notes', key: 'k02' })
		expect(String(caught)).not.toContain('7310')
	})
})
