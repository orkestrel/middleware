# @orkestrel/middleware

> Batteries for the `@orkestrel/server` middleware seam:
> `create{Noun}(options) => MiddlewareHandler<TState>` factories for error
> boundaries, telemetry, compression, security headers, CORS, deadlines,
> trusted-proxy client facts, ETag, bearer authentication, rate limiting, body
> parsing, sessions, and CSRF over web-standard `Request` and `Response`, plus
> in-memory assets, static files, streaming multipart uploads, and a
> `node:zlib` compression sibling on Node.

Mount the batteries your threat model needs over the `compose` seam: each one
closes over its guarded options and returns a `MiddlewareHandler<TState>`, and
its position in the chain decides what it can see. Read
[`guides/middleware.md`](guides/middleware.md) for the ordering doctrine and
the security acceptance bar before you fix an order. Part of the `@orkestrel`
line.

## Install

```sh
npm install @orkestrel/middleware @orkestrel/server @orkestrel/router
```

## Requirements

- Node.js ^22.18.0 or >= 24.4.0
- `@orkestrel/server` as a peer dependency (the seam and substrate are
  imported, never bundled)
- `@orkestrel/router` as a peer dependency (`only` and `except` match through
  its path grammar)
- Dual ESM and CommonJS entry: one server-only entry (`.`) that carries every
  battery, including the node-bound ones. Before 0.0.35, the node-bound
  batteries published under `./server`; move every import from
  `@orkestrel/middleware/server` to `@orkestrel/middleware`

## Usage

```ts
import { createBoundary, createSecurity } from '@orkestrel/middleware'
import type { IdentifierState } from '@orkestrel/middleware'
import { compose } from '@orkestrel/server'

interface State extends IdentifierState {}

const boundary = createBoundary({ expose: false })
const security = createSecurity({ hsts: true })

const handle = compose<State>([security, boundary], async (_request, context) => {
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
