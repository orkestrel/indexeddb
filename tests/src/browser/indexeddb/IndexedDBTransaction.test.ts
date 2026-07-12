import type { IndexedDBTransactionInterface } from '@src/browser'
import { IndexedDBError } from '@src/browser'
import { afterEach, describe, expect, it } from 'vitest'
import { captureError } from '../../../setup.js'
import { createCleanups, createTestDatabase, errorCode } from '../../../setupBrowser.js'

// `IndexedDBTransactionInterface` in real Chromium, obtained through the `scope`
// callback of `db.read` / `db.write`: the metadata getters (`transaction` /
// `mode` / `stores` / `active` / `finished` / `error`), scoped `store` access
// with its out-of-scope guard, and `abort` / `commit` with their finished-state
// faults. Most assertions run INSIDE the scope, where the transaction is live;
// the captured reference lets a few outlive the scope. Each test opens a
// uniquely-named database through the shared opener.

const cleanups = createCleanups()

afterEach(cleanups.run)

describe('IndexedDBTransaction — metadata', () => {
	it('reports its native transaction, mode, and scope', async () => {
		const { db, cleanup } = await createTestDatabase({
			users: { path: 'id' },
			posts: { path: 'id' },
		})
		cleanups.push(cleanup)
		await db.read(['users', 'posts'], (tx) => {
			expect(tx.transaction).toBeInstanceOf(IDBTransaction)
			expect(tx.mode).toBe('readonly')
			expect([...tx.stores].sort()).toEqual(['posts', 'users'])
			expect(tx.active).toBe(true)
			expect(tx.finished).toBe(false)
			expect(tx.error).toBeNull()
		})
	})

	it('a write scope reports the readwrite mode', async () => {
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		cleanups.push(cleanup)
		await db.write('users', (tx) => {
			expect(tx.mode).toBe('readwrite')
		})
	})
})

describe('IndexedDBTransaction — scoped store access', () => {
	it('reaches a store within scope and throws NOT_FOUND outside it', async () => {
		const { db, cleanup } = await createTestDatabase({
			users: { path: 'id' },
			posts: { path: 'id' },
		})
		cleanups.push(cleanup)
		await db.read('users', (tx) => {
			expect(tx.store('users').store).toBeInstanceOf(IDBObjectStore)
			const caught = captureError(() => tx.store('posts')) // not in this transaction's scope
			expect(caught).toBeInstanceOf(IndexedDBError)
			expect(errorCode(caught)).toBe('NOT_FOUND')
		})
	})

	it('throws ABORTED when reaching a store after the transaction aborts', async () => {
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		cleanups.push(cleanup)
		// Abort, then capture the fault from reaching a store on the dead transaction.
		// The aborted scope rejects, so the write is caught; the captured error is
		// asserted unconditionally afterwards (no conditional expect).
		let caught: unknown
		await db
			.write('users', (tx) => {
				tx.abort()
				try {
					tx.store('users') // no longer active
				} catch (error) {
					caught = error
				}
			})
			.catch(() => {})
		expect(caught).toBeInstanceOf(IndexedDBError)
		expect(errorCode(caught)).toBe('ABORTED')
	})
})

describe('IndexedDBTransaction — abort', () => {
	it('rolls every write in the scope back and marks itself finished', async () => {
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		cleanups.push(cleanup)
		await db.store('users').set({ id: 'u1', n: 1 })
		// Capture the transaction and its post-abort state; assert unconditionally
		// after the (rejected, caught) scope settles.
		let captured: IndexedDBTransactionInterface | undefined
		let activeAfterAbort = true
		let finishedAfterAbort = false
		await db
			.write('users', async (tx) => {
				captured = tx
				await tx.store('users').set({ id: 'u1', n: 2 })
				await tx.store('users').set({ id: 'u2', n: 9 })
				tx.abort()
				activeAfterAbort = tx.active
				finishedAfterAbort = tx.finished
			})
			.catch(() => {})
		// `abort` flips the state synchronously, and it survives on the reference.
		expect(activeAfterAbort).toBe(false)
		expect(finishedAfterAbort).toBe(true)
		expect(captured?.finished).toBe(true)
		// Neither write survived the rollback.
		expect(await db.store('users').get('u1')).toEqual({ id: 'u1', n: 1 })
		expect(await db.store('users').get('u2')).toBeUndefined()
	})

	it('throws ABORTED when aborting an already-finished transaction', async () => {
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		cleanups.push(cleanup)
		let caught: unknown
		await db
			.write('users', (tx) => {
				tx.abort()
				try {
					tx.abort() // already finished
				} catch (error) {
					caught = error
				}
			})
			.catch(() => {})
		expect(caught).toBeInstanceOf(IndexedDBError)
		expect(errorCode(caught)).toBe('ABORTED')
	})
})

describe('IndexedDBTransaction — commit', () => {
	it('flushes the scope early and persists its writes', async () => {
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		cleanups.push(cleanup)
		await db.write('users', async (tx) => {
			await tx.store('users').set({ id: 'u1', name: 'Ada' })
			tx.commit()
		})
		expect(await db.store('users').get('u1')).toEqual({ id: 'u1', name: 'Ada' })
	})

	it('throws ABORTED when committing an already-finished transaction', async () => {
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		cleanups.push(cleanup)
		let caught: unknown
		await db
			.write('users', (tx) => {
				tx.abort()
				try {
					tx.commit() // already finished
				} catch (error) {
					caught = error
				}
			})
			.catch(() => {})
		expect(caught).toBeInstanceOf(IndexedDBError)
		expect(errorCode(caught)).toBe('ABORTED')
	})
})
