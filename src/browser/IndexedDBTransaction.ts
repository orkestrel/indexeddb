import type {
	IndexedDBTransactionInterface,
	IndexedDBTransactionStoreInterface,
	StoresShape,
} from './types.js'
import { IndexedDBError } from './errors.js'
import { guardSync } from './helpers.js'
import { IndexedDBTransactionStore } from './IndexedDBTransactionStore.js'

/**
 * An explicit transaction over one or more stores.
 *
 * @remarks
 * Wraps `IDBTransaction` with state tracking and typed, scope-bound store access.
 * Constructed by the database's `read` / `write`, which await its completion (or
 * roll it back on a throw). `store` reaches a store within the transaction's scope;
 * `abort` rolls back; `commit` flushes early (the scope's completion commits
 * otherwise). `active` is true until commit or abort; `finished` is its complement.
 */
export class IndexedDBTransaction<
	Stores extends StoresShape = StoresShape,
> implements IndexedDBTransactionInterface<Stores> {
	readonly #transaction: IDBTransaction
	readonly #stores: readonly string[]
	#active = true
	#finished = false

	constructor(transaction: IDBTransaction) {
		this.#transaction = transaction
		this.#stores = Array.from(transaction.objectStoreNames)
		const settle = (): void => {
			this.#active = false
			this.#finished = true
		}
		// `addEventListener` rather than the `on*` slots: `#run` also awaits this
		// same native transaction through `promisifyTransaction`, which listens the
		// same way — assigning `on*` here would clobber whichever handler is wired
		// second.
		transaction.addEventListener('complete', settle)
		transaction.addEventListener('abort', settle)
		transaction.addEventListener('error', settle)
	}

	get transaction(): IDBTransaction {
		return this.#transaction
	}

	get mode(): IDBTransactionMode {
		return this.#transaction.mode
	}

	get stores(): readonly string[] {
		return this.#stores
	}

	get active(): boolean {
		return this.#active
	}

	get finished(): boolean {
		return this.#finished
	}

	get error(): DOMException | null {
		return this.#transaction.error
	}

	store<K extends keyof Stores & string>(name: K): IndexedDBTransactionStoreInterface {
		if (!this.#stores.includes(name)) {
			throw new IndexedDBError(
				'NOT_FOUND',
				`Store '${name}' is outside this transaction's scope (${this.#stores.join(', ')})`,
			)
		}
		if (!this.#active) {
			throw new IndexedDBError(
				'ABORTED',
				`Transaction over ${this.#stores.join(', ')} is no longer active`,
			)
		}
		return new IndexedDBTransactionStore(this.#transaction.objectStore(name))
	}

	abort(): void {
		// An already-finished transaction is no longer active, not "aborted" — a
		// transaction that committed cleanly was never aborted at all. INACTIVE
		// matches the native `TransactionInactiveError` this same call raises when
		// the transaction has auto-committed out from under the caller.
		if (this.#finished) {
			throw new IndexedDBError('INACTIVE', 'Cannot abort an already-finished transaction')
		}
		guardSync(() => this.#transaction.abort())
		this.#active = false
		this.#finished = true
	}

	commit(): void {
		if (this.#finished) {
			throw new IndexedDBError('INACTIVE', 'Cannot commit an already-finished transaction')
		}
		guardSync(() => this.#transaction.commit())
	}
}
