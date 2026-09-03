import type { IndexedDBTransactionInterface } from '@src/browser'
import { IndexedDBError } from '@src/browser'
import { afterEach, describe, expect, it } from 'vitest'
import { captureError, createTeardown } from '@orkestrel/test'
import { createTestDatabase, errorCode } from '../../setupBrowser.js'

// `IndexedDBTransactionInterface` in real Chromium, obtained through the `scope`
// callback of `db.read` / `db.write`: the metadata getters (`transaction` /
// `mode` / `stores` / `active` / `finished` / `error`), scoped `store` access
// with its out-of-scope guard, and `abort` / `commit` with their finished-state
// faults. Most assertions run INSIDE the scope, where the transaction is live;
// the captured reference lets a few outlive the scope. Each test opens a
// uniquely-named database through the shared opener.

const teardown = createTeardown()

afterEach(teardown.destroy)

describe('IndexedDBTransaction — metadata', () => {
	it('reports its native transaction, mode, and scope', async () => {
		const { db, cleanup } = await createTestDatabase({
			users: { path: 'id' },
			posts: { path: 'id' },
		})
		teardown.add(cleanup)
		await db.read(['users', 'posts'], (transaction) => {
			expect(transaction.transaction).toBeInstanceOf(IDBTransaction)
			expect(transaction.mode).toBe('readonly')
			expect([...transaction.stores].sort()).toEqual(['posts', 'users'])
			expect(transaction.active).toBe(true)
			expect(transaction.finished).toBe(false)
			expect(transaction.error).toBeNull()
		})
	})

	it('a write scope reports the readwrite mode', async () => {
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		teardown.add(cleanup)
		await db.write('users', (transaction) => {
			expect(transaction.mode).toBe('readwrite')
		})
	})
})

describe('IndexedDBTransaction — scoped store access', () => {
	it('reaches a store within scope and throws NOT_FOUND outside it', async () => {
		const { db, cleanup } = await createTestDatabase({
			users: { path: 'id' },
			posts: { path: 'id' },
		})
		teardown.add(cleanup)
		await db.read('users', (transaction) => {
			expect(transaction.store('users').store).toBeInstanceOf(IDBObjectStore)
			const caught = captureError(() => transaction.store('posts')) // not in this transaction's scope
			expect(caught).toBeInstanceOf(IndexedDBError)
			expect(errorCode(caught)).toBe('NOT_FOUND')
		})
	})

	it('throws ABORTED when reaching a store after the transaction aborts', async () => {
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		teardown.add(cleanup)
		// Abort, then capture the fault from reaching a store on the dead transaction.
		// The aborted scope rejects, so the write is caught; the captured error is
		// asserted unconditionally afterwards (no conditional expect).
		let caught: unknown
		await db
			.write('users', (transaction) => {
				transaction.abort()
				try {
					transaction.store('users') // no longer active
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
		teardown.add(cleanup)
		await db.store('users').set({ id: 'u1', n: 1 })
		// Capture the transaction and its post-abort state; assert unconditionally
		// after the (rejected, caught) scope settles.
		let captured: IndexedDBTransactionInterface | undefined
		let activeAfterAbort = true
		let finishedAfterAbort = false
		await db
			.write('users', async (transaction) => {
				captured = transaction
				await transaction.store('users').set({ id: 'u1', n: 2 })
				await transaction.store('users').set({ id: 'u2', n: 9 })
				transaction.abort()
				activeAfterAbort = transaction.active
				finishedAfterAbort = transaction.finished
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

	it('throws INACTIVE when aborting an already-finished transaction', async () => {
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		teardown.add(cleanup)
		let caught: unknown
		await db
			.write('users', (transaction) => {
				transaction.abort()
				try {
					transaction.abort() // already finished
				} catch (error) {
					caught = error
				}
			})
			.catch(() => {})
		expect(caught).toBeInstanceOf(IndexedDBError)
		expect(errorCode(caught)).toBe('INACTIVE')
	})
})

describe('IndexedDBTransaction — commit', () => {
	it('flushes the scope early and persists its writes', async () => {
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		teardown.add(cleanup)
		await db.write('users', async (transaction) => {
			await transaction.store('users').set({ id: 'u1', name: 'Ada' })
			transaction.commit()
		})
		expect(await db.store('users').get('u1')).toEqual({ id: 'u1', name: 'Ada' })
	})

	it('settles the transaction, so a second commit throws INACTIVE', async () => {
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		teardown.add(cleanup)
		// `commit` is one of the two terminating transitions, so it writes the same
		// settled fact `abort` writes. Read the state synchronously after the call,
		// before the native `complete` event has had a turn to settle it instead.
		let activeAfterCommit = true
		let finishedAfterCommit = false
		let caught: unknown
		await db.write('users', async (transaction) => {
			await transaction.store('users').set({ id: 'u1', name: 'Ada' })
			transaction.commit()
			activeAfterCommit = transaction.active
			finishedAfterCommit = transaction.finished
			try {
				transaction.commit() // already finished
			} catch (error) {
				caught = error
			}
		})
		expect(finishedAfterCommit).toBe(true)
		expect(activeAfterCommit).toBe(false)
		expect(caught).toBeInstanceOf(IndexedDBError)
		expect(errorCode(caught)).toBe('INACTIVE')
	})

	it('throws INACTIVE when committing an already-finished transaction', async () => {
		const { db, cleanup } = await createTestDatabase({ users: { path: 'id' } })
		teardown.add(cleanup)
		let caught: unknown
		await db
			.write('users', (transaction) => {
				transaction.abort()
				try {
					transaction.commit() // already finished
				} catch (error) {
					caught = error
				}
			})
			.catch(() => {})
		expect(caught).toBeInstanceOf(IndexedDBError)
		expect(errorCode(caught)).toBe('INACTIVE')
	})
})
