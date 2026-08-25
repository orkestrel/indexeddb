import * as setup from './setup.js'
import { describe, expect, it } from 'vitest'

// The base test setup module's proof (`tests/setup.ts`), `setupFiles[0]` for every Vitest
// project. The module is deliberately export-free: its whole body is the `afterEach` hook that
// restores Vitest's own registry between cases, and it hands the suites no helper of its own.
//
// So its observable contract is that loading it first contributes nothing to a project's module
// namespace. That is what this file pins — the host-independent guarantee that a DOM, `node:*`,
// or IndexedDB helper landing here by accident would break, rather than leaking into the
// `policy`, `config`, `setup`, `guides`, and `distribution` projects that load it in Node with
// the browser disabled. The package's IndexedDB helpers live in `tests/setupBrowser.ts` and are
// proven by the `src:browser` suites that drive them against real Chromium storage.

describe('setup', () => {
	it('adds no export', () => {
		expect(Object.keys(setup)).toEqual([])
	})
})
