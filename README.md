# @orkestrel/server

A typed HTTP server for the `@orkestrel` line — composes the
`@orkestrel/router` dispatcher behind a managed lifecycle over a pluggable
node adapter seam. Built to sit beside `@orkestrel/contract` (validation),
`@orkestrel/emitter` (observable lifecycle), and `@orkestrel/abort`
(cancellation), reusing all three as it takes shape. Its middleware
architecture is still under design.

## Install

```sh
npm install @orkestrel/server
```

## Requirements

- Node.js >= 24
- ESM-only (no CommonJS build)

## Status

The public API is under design and not yet implemented — this package
currently ships no runtime code. An upcoming `PROPOSAL.md` will define the
server surface (lifecycle, middleware, node adapter) before implementation
begins.

## Package

Published as a single entry point per the `exports` field in `package.json`.

## License

MIT © [Orkestrel](https://github.com/orkestrel) — see [LICENSE](./LICENSE).
