# Guides

A dual-axis index into this repository's guides — by concept, and by
directory (`AGENTS.md` § Documentation contract).

## By concept

| Concept   | Spec                           | Source                          | Tests                                       |
| --------- | ------------------------------ | ------------------------------- | ------------------------------------------- |
| IndexedDB | [`indexeddb.md`](indexeddb.md) | [`src/browser`](../src/browser) | [`tests/src/browser`](../tests/src/browser) |

## By directory

| Directory     | Guide                          |
| ------------- | ------------------------------ |
| `src/browser` | [`indexeddb.md`](indexeddb.md) |

## Dependency reference

[`contract.md`](contract.md) is a byte-identical mirror of the guide for
`@orkestrel/contract` — this package's sole runtime dependency. It documents
**that package's** surface (guards, combinators, parsers, and the shape DSL), not
anything sourced in this repo; it is kept here so a reader of this package can see
the primitives it is built from without leaving this guide set.

[`guide.md`](guide.md) is a byte-identical mirror of the guide for
`@orkestrel/guide` — the devDependency powering this repo's guides-parity test
suite (`tests/guides.test.ts`). It documents **that package's**
surface (`Guide` / `Source`, the manifest and comparison helpers), not anything
sourced in this repo; it is kept here so a reader of the parity suite can see
the primitives it is built from without leaving this guide set.

[`test.md`](test.md) is a byte-identical mirror of the guide for
`@orkestrel/test` — the devDependency supplying this repo's shared test
infrastructure (the call recorder, the real delay, the teardown list, and the
owned scratch directory). It documents **that package's** surface, not anything
sourced in this repo; it is kept here so a reader of `tests/setupBrowser.ts` can
see the helpers it is built from without leaving this guide set.

[`probe.md`](probe.md) is a byte-identical mirror of the guide for
`@orkestrel/probe` — the devDependency providing the probe bench an agent calls
to settle a TypeScript claim before relying on it. It documents **that
package's** surface, not anything sourced in this repo; it is kept here so a
reader running that bench can see what it offers without leaving this guide set.

[`scaffold.md`](scaffold.md) is a byte-identical mirror of the guide for
`@orkestrel/scaffold` — the devDependency that generates and repairs this
workspace's vendored configuration, tests, and tooling. It documents **that
package's** surface, not anything sourced in this repo; it is kept here so a
reader of the vendored host inventory can see where those files come from
without leaving this guide set.

A mirror's own relative links address its upstream tree, so they resolve to
nothing here and sit outside this repository's link parity. Refresh a mirror
from upstream rather than rewriting it.

## See also

- [`AGENTS.md`](../AGENTS.md) — the coding contract every guide is written against.
