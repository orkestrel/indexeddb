# @orkestrel/indexeddb

> A lean, typed, Promise-based wrapper over the raw browser `IDBDatabase` /
> `IDBObjectStore` / `IDBIndex` / `IDBTransaction` API — object stores, secondary
> indexes, native key ranges, promisified cursors, multi-store transactions, and
> versioned schema upgrades, over `await` instead of raw `IDBRequest` events.

Declare your stores with the `createIndexedDBDatabase` function, reach one of
them with `db.store(name)`, and `await` the keyed reads and writes. Feature-detect
with `supportsIndexedDB` first where storage may be absent. Part of the
`@orkestrel` line.

## Install

```sh
npm install @orkestrel/indexeddb
```

## Requirements

- Node.js >= 22.12.0 (build/test tooling)
- ESM-only (no CommonJS build)
- A browser environment with `IndexedDB` (feature-detect with
  `supportsIndexedDB` before opening a database)

## Status

Pre-release. The public API is implemented and tested against a real
Chromium instance; see the
[guide](https://github.com/orkestrel/indexeddb/blob/main/guides/indexeddb.md)
for the full surface, patterns, and invariants.

## Package

Published as a single, browser-only ESM entry point per the `exports` field
in `package.json` — no server or Node-only build.

## License

MIT © [Orkestrel](https://github.com/orkestrel) — see [LICENSE](./LICENSE).
