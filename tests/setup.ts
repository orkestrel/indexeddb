// Base test setup — environment-agnostic helpers loaded first by every Vitest
// project (`setupFiles[0]`). Keep this file free of `node:*` and of
// `document` / `window`: DOM/IndexedDB helpers live in `setupBrowser.ts`.

import { afterEach, vi } from 'vitest'

afterEach(() => {
	vi.restoreAllMocks()
})

/**
 * Run `thunk` and return the value it threw, or `undefined` if it returned normally — the
 * one shared form of the `try { …; return undefined } catch (error) { return error }` IIFE
 * the error-path tests repeat (AGENTS §16.1). Lets a caller assert on the captured fault
 * unconditionally, never inside a conditional `expect`. For a synchronous throw site; an
 * async rejection is asserted with `await expect(…).rejects` instead.
 *
 * @param thunk - The (synchronous) operation to run and capture the throw of
 * @returns The thrown value, or `undefined` when `thunk` did not throw
 */
export function captureError(thunk: () => unknown): unknown {
	try {
		thunk()
		return undefined
	} catch (error) {
		return error
	}
}

/**
 * Wait `ms` milliseconds — the shared delay helper for tests that need a real
 * macrotask to pass (AGENTS §16.1), e.g. to let a transaction auto-commit
 * before asserting on the fault an operation raises afterward.
 *
 * @param ms - The delay, in milliseconds (defaults to `0`, one macrotask)
 */
export function waitForDelay(ms = 0): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}
