# Guides

A dual-axis index into this repository's guides — by concept, and by
directory (AGENTS §22).

## By concept

| Concept    | Spec                                     | Source                                                   | Tests                                                                            |
| ---------- | ---------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Middleware | [`src/middleware.md`](src/middleware.md) | [`src/core`](../src/core), [`src/server`](../src/server) | [`tests/src/core`](../tests/src/core), [`tests/src/server`](../tests/src/server) |

## By directory

| Directory    | Guide                                    |
| ------------ | ---------------------------------------- |
| `src/core`   | [`src/middleware.md`](src/middleware.md) |
| `src/server` | [`src/middleware.md`](src/middleware.md) |

## Dependency reference

[`src/server.md`](src/server.md) is a byte-identical mirror of the guide for
`@orkestrel/server` — this package's peerDependency, the frozen middleware
seam and substrate it is built over. It documents **that package's** surface
(`MiddlewareHandler`, `MiddlewareContext`, `compose`, the cookie/token/
negotiation/conditional/security substrate), not anything sourced in this
repo; it is kept here so a reader of this package can see the primitives it
is built from without leaving this guide set.

[`src/contract.md`](src/contract.md) is a byte-identical mirror of the guide for
`@orkestrel/contract` — one of this package's runtime dependencies. It documents
**that package's** surface (guards, combinators, parsers, and the shape DSL), not
anything sourced in this repo; it is kept here so a reader of this package can see
the primitives it is built from without leaving this guide set.

[`src/budget.md`](src/budget.md) is a byte-identical mirror of the guide for
`@orkestrel/budget` — this package's runtime dependency backing the rate
limiter's per-key tally. It documents **that package's** surface (the
`Budget` class, `BudgetInterface`, and the cumulative-consumption-against-a-
ceiling contract), not anything sourced in this repo; it is kept here so a
reader of this package can see the primitives it is built from without
leaving this guide set.

[`src/abort.md`](src/abort.md) is a byte-identical mirror of the guide for
`@orkestrel/abort` — this package's runtime dependency. It documents
**that package's** surface (the `Abort` class, `AbortInterface`, and the
parent-linking / cascading-cancellation contract), not anything sourced in
this repo; it is kept here so a reader of this package can see the primitives
it is built from without leaving this guide set.

[`src/timeout.md`](src/timeout.md) is a byte-identical mirror of the guide for
`@orkestrel/timeout` — this package's runtime dependency backing
`createDeadline`'s timer. It documents **that package's** surface (the
`Timeout` class, `TimeoutInterface`, and the start/clear deadline lifecycle),
not anything sourced in this repo; it is kept here so a reader of this
package can see the primitives it is built from without leaving this guide
set.

[`src/guide.md`](src/guide.md) is a byte-identical mirror of the guide for
`@orkestrel/guide` — the devDependency powering this repo's guides-parity test
suite (`tests/guides/src/parity.test.ts`). It documents **that package's**
surface (`Guide` / `Source`, the manifest and comparison helpers), not anything
sourced in this repo; it is kept here so a reader of the parity suite can see
the primitives it is built from without leaving this guide set.

## See also

- [`AGENTS.md`](../AGENTS.md) — the rules; §22 documentation-as-contracts.
