# @orkestrel/indexeddb

A typed, Promise-based wrapper over browser IndexedDB — object stores,
secondary indexes, native key ranges, promisified cursors, and versioned
schema upgrades, over `await` instead of raw `IDBRequest` events. Part of the
`@orkestrel` line.

## Install

```sh
npm install @orkestrel/indexeddb
```

## Requirements

- Node.js >= 24 (build/test tooling)
- ESM-only (no CommonJS build)
- A browser environment with `IndexedDB` (feature-detect with
  `isIndexedDBSupported` before opening a database)

## Status

Pre-release. The public API is implemented and tested against a real
Chromium instance; see the [guide](guides/src/indexeddb.md) for the full
surface, patterns, and invariants.

## Package

Published as a single, browser-only ESM entry point per the `exports` field
in `package.json` — no server or Node-only build.

## License

MIT © [Orkestrel](https://github.com/orkestrel) — see [LICENSE](./LICENSE).
