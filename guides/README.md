# Guides

A dual-axis index into this repository's guides — by concept, and by
directory.

## By concept

| Concept    | Spec                             | Source                                                   | Tests                                                                            |
| ---------- | -------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Middleware | [`middleware.md`](middleware.md) | [`src/core`](../src/core), [`src/server`](../src/server) | [`tests/src/core`](../tests/src/core), [`tests/src/server`](../tests/src/server) |

## By directory

| Directory    | Guide                            |
| ------------ | -------------------------------- |
| `src/core`   | [`middleware.md`](middleware.md) |
| `src/server` | [`middleware.md`](middleware.md) |

## Dependency reference

[`guide.md`](guide.md) is a byte-identical mirror of the guide for
`@orkestrel/guide` — the devDependency powering this repo's guides-parity test
suite (`tests/guides.test.ts`). It documents **that package's**
surface (`Guide` / `Source`, the manifest and comparison helpers), not anything
sourced in this repo; it is kept here so a reader of the parity suite can see
the primitives it is built from without leaving this guide set.

[`scaffold.md`](scaffold.md) is a byte-identical mirror of the guide for
`@orkestrel/scaffold` — the devDependency owning this repo's shared file set,
configuration, and gate scripts. It documents **that package's** surface, not
anything sourced in this repo; it is kept here so a reader can see the
toolchain this repository is generated against without leaving this guide set.

Every other dependency guide sits here as a byte-identical mirror of its own
package's guide, kept so a reader can follow a seam without leaving the guide
set: [`abort.md`](abort.md), [`budget.md`](budget.md),
[`contract.md`](contract.md), and [`timeout.md`](timeout.md) for the runtime
dependencies; [`server.md`](server.md) and [`database.md`](database.md) for the
peers; [`router.md`](router.md), [`probe.md`](probe.md), and
[`test.md`](test.md) for the development dependencies.

## See also

- [`AGENTS.md`](../AGENTS.md) — the coding rules this package is written under.
