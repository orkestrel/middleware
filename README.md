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

## Status

The public API is defined in `PROPOSAL.md` and not yet implemented — this
package currently ships no runtime code.

## Guides

See [`guides/README.md`](./guides/README.md) for the concept and dependency
index; the full battery-by-battery surface docs land in `guides/src/middleware.md`
alongside the implementation.

## License

MIT © [Orkestrel](https://github.com/orkestrel) — see [LICENSE](./LICENSE).
