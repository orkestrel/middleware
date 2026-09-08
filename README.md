# @orkestrel/middleware

> Batteries for the `@orkestrel/server` middleware seam:
> `create{Noun}(options) => MiddlewareHandler<TState>` factories for error
> boundaries, telemetry, compression, security headers, CORS, deadlines,
> trusted-proxy client facts, ETag, bearer authentication, rate limiting, body
> parsing, sessions, and CSRF in the fetch-native core, plus in-memory assets,
> static files, streaming multipart uploads, and a `node:zlib` compression
> sibling in the node face.

Mount the batteries your threat model needs over the `compose` seam: each one
closes over its guarded options and returns a `MiddlewareHandler<TState>`, and
its position in the chain decides what it can see. Read
[`guides/middleware.md`](guides/middleware.md) for the ordering doctrine and
the security acceptance bar before you fix an order. Part of the `@orkestrel`
line.

## Install

```sh
npm install @orkestrel/middleware @orkestrel/server
```

## Requirements

- Node.js >= 22.12.0
- `@orkestrel/server` as a peer dependency (the seam and substrate are
  imported, never bundled)
- Dual ESM and CommonJS entries: the core (`.`) and the node face (`./server`),
  which carries the node-bound batteries

## Usage

```ts
import { createBoundary, createSecurity } from '@orkestrel/middleware'
import type { IdentifierState } from '@orkestrel/middleware'
import { compose } from '@orkestrel/server'

interface State extends IdentifierState {}

const boundary = createBoundary({ expose: false })
const security = createSecurity({ hsts: true })

const handle = compose<State>([boundary, security], async (_request, context) => {
	return Response.json({ identifier: context.state.identifier })
})
```

Each battery is a typed `options => MiddlewareHandler<TState>` factory that composes with
the others through the frozen `@orkestrel/server` seam, in any combination, scoped with
`only()` and `except()` where needed.

## Guides

See [`guides/README.md`](./guides/README.md) for the concept and dependency
index; the full battery-by-battery surface docs land in `guides/middleware.md`
alongside the implementation.

## License

MIT © [Orkestrel](https://github.com/orkestrel) — see [LICENSE](./LICENSE).
