# @orkestrel/middleware

Batteries for the `@orkestrel/server` middleware seam — the frozen
`MiddlewareHandler<TState>` / `compose` contract and its substrate ship
policy-free; this package supplies the policies the server deliberately does
not: boundary rendering, telemetry, compression, security headers, CORS,
deadlines, trusted-proxy client facts, ETag, bearer auth, rate limiting, body
parsing, sessions, CSRF, static files, and multipart uploads — each a typed
`options => MiddlewareHandler<TState>` factory over the shipped seam.

## Install

```sh
npm install @orkestrel/middleware @orkestrel/server
```

## Requirements

- Node.js >= 24
- `@orkestrel/server` as a peer dependency (the seam and substrate are
  imported, never bundled)
- ESM core (`.`); a CJS node face (`./server`) for the node-bound batteries
  (`createStatic`, `createMultipart`)

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
the others through the frozen `@orkestrel/server` seam — mount boundary, telemetry,
compression, security headers, CORS, rate limiting, sessions (with `MemorySessionStore` or
`DatabaseSessionStore` over `@orkestrel/database`), CSRF, static files, and multipart uploads
in any combination, scoped with `only()` / `except()` where needed.

## Guides

See [`guides/README.md`](./guides/README.md) for the concept and dependency
index; the full battery-by-battery surface docs land in `guides/src/middleware.md`
alongside the implementation.

## License

MIT © [Orkestrel](https://github.com/orkestrel) — see [LICENSE](./LICENSE).
