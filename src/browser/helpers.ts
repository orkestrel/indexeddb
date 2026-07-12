// The browser layer's cross-cutting helpers — capabilities that gate a whole
// module rather than belong to any one of them. `isIndexedDBSupported` lives
// here because it is the probe a consumer runs *before* entering the IndexedDB
// module (to fall back to an in-memory driver where storage is absent), the same
// way `src/core/helpers.ts` holds the layer-wide `Result` helpers above its
// modules.

/**
 * Whether IndexedDB is available in this environment.
 *
 * @remarks
 * Gate IndexedDB code with this and fall back to `createMemoryDriver` where it is
 * absent (a non-browser runtime, a privacy mode that disables storage). It is the
 * browser-layer entry probe, checked before reaching for the IndexedDB module.
 *
 * @returns `true` when `globalThis.indexedDB` exists
 */
export function isIndexedDBSupported(): boolean {
	return typeof globalThis.indexedDB !== 'undefined'
}
