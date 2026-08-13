// Base test setup — environment-agnostic helpers loaded first by every Vitest
// project (`setupFiles[0]`). Keep this file free of `node:*` and of
// `document` / `window`: DOM/IndexedDB helpers live in `setupBrowser.ts`.
//
// The fleet-wide helpers live in `@orkestrel/test`. What remains here is what is
// specific to this package.

import { afterEach, vi } from 'vitest'

afterEach(() => {
	vi.restoreAllMocks()
})

/** Whether a repository-relative Vue SFC path belongs to the private browser application. */
export function isBrowserVuePath(path: string): boolean {
	const normalized = path.replaceAll('\\', '/')
	return normalized.startsWith('app/browser/')
}
