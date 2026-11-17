# Middleware

> Batteries for the `@orkestrel/server` middleware seam:
> `create{Noun}(options) => MiddlewareHandler<TState>` factories for error
> boundaries, telemetry, compression, security headers, CORS, deadlines,
> trusted-proxy client facts, ETag, bearer authentication, rate limiting, body
> parsing, sessions, and CSRF over web-standard `Request` and `Response`, plus
> in-memory assets, static files, streaming multipart uploads, and a
> `node:zlib` compression sibling on Node.

This is the package's one guide. The package publishes one server-only entry,
and every battery returns the `@orkestrel/server` `MiddlewareHandler`. Every
battery composes the frozen `@orkestrel/server` middleware seam
(`MiddlewareHandler`, `MiddlewareContext`, `compose`) and its substrate —
cookies, WebCrypto tokens, negotiation, conditionals, and security primitives.
This package never re-implements that seam, and it supplies mechanism rather
than product policy. Source: [`src/server`](../src/server). Surfaced through
the `@orkestrel/middleware` barrel (aliased `@src/server` inside this repo).
Before 0.0.35, the package published two entries: the host-independent core at
`@orkestrel/middleware`, and `createAssets`, `createStatic`, `createMultipart`,
`createNodeCompression`, and the rest of the node face (its helpers, parsers,
errors, and asset store) at `@orkestrel/middleware/server`. From 0.0.35, the `./server` subpath is gone and
no alias replaces it: move every import from `@orkestrel/middleware/server` to
`@orkestrel/middleware`. The move removed and renamed no symbol.

## Surface

A battery closes over its guarded options and returns a
`MiddlewareHandler<TState>`, which composes with the others over the shipped
seam.

### Mount a battery

The fence composes the security battery outside an error boundary over `compose`, then answers with the request identifier `createSecurity` stashed on `context.state`.

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

### Middlewares — web-standard

| Name                | Kind     | Signature                                                                                                                                                      | Summary                                                                                                                                                                                                              |
| ------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createBoundary`    | function | `<TState>(options?: BoundaryOptions) => MiddlewareHandler<TState>`                                                                                             | Creates the error-rendering battery — catches a downstream throw and renders it as a `Response`.                                                                                                                     |
| `createTelemetry`   | function | `<TState>(options: TelemetryOptions) => MiddlewareHandler<TState>`                                                                                             | Creates the access-log/timing seam — records one `TelemetryEntry` per request after the response settles.                                                                                                            |
| `createCompression` | function | `<TState>(options?: CompressionOptions) => MiddlewareHandler<TState>`                                                                                          | Creates the response-body compression battery — negotiates and compresses a buffered response body over the runtime's feature-detected `CompressionStream` codings.                                                  |
| `createSecurity`    | function | `<TState extends IdentifierState>(options?: SecurityOptions) => MiddlewareHandler<TState>`                                                                     | Creates the security-headers + request-identifier battery — sets each documented header default, and mints or echoes a request identifier.                                                                           |
| `createCORS`        | function | `<TState>(options?: CORSOptions) => MiddlewareHandler<TState>`                                                                                                 | Creates the Cross-Origin Resource Sharing battery — answers a preflight itself, and reflects an allow-listed origin or serves the configured wildcard.                                                               |
| `createDeadline`    | function | `<TState>(options: DeadlineOptions) => MiddlewareHandler<TState>`                                                                                              | Creates the application-level per-request deadline battery.                                                                                                                                                          |
| `createForwarded`   | function | `<TState extends ClientState>(options: ForwardedOptions) => MiddlewareHandler<TState>`                                                                         | Creates the trusted-proxy client-IP resolver battery — walks `X-Forwarded-For` past the hops its options declare trusted.                                                                                            |
| `createETag`        | function | `<TState>(options?: ETagOptions) => MiddlewareHandler<TState>`                                                                                                 | Creates the dynamic response `ETag` + conditional GET battery (RFC 7232).                                                                                                                                            |
| `createBearer`      | function | `<TState extends BearerState<TCredential>, TCredential = string>(options: BearerOptions<TCredential>) => MiddlewareHandler<TState>`                            | Creates the bearer-token authentication battery — reads the token from its header, resolves its credential through `verify`, and answers each `401` with a `WWW-Authenticate` challenge.                             |
| `createLimiter`     | function | `<TState extends BearerState<unknown> & ClientState>(options: LimiterOptions<TState>) => MiddlewareHandler<TState>`                                            | Creates the fixed-window rate-limiting battery — checks a key's budget before consuming it, so one window admits exactly `max` requests.                                                                             |
| `createBody`        | function | `<TState extends BodyState = BodyState>() => MiddlewareHandler<TState>`                                                                                        | Creates the body-driving battery — eagerly awaits the cached `context.body()` so its throws (or a malformed-JSON `undefined`) surface before the handler runs, and stashes the resolved value onto `BodyState.body`. |
| `createSession`     | function | `<S extends SessionInterface = SessionInterface, TState extends SessionState = SessionState>(options: SessionOptions<S, TState>) => MiddlewareHandler<TState>` | Creates the generic session battery — resolves, mints, and persists a session across the request, with a mid-handler `regenerate`/`destroy` control handle.                                                          |
| `createCSRF`        | function | `<TState extends CSRFState & SessionState>(options: CSRFOptions) => MiddlewareHandler<TState>`                                                                 | Creates the CSRF protection battery: a signed double submit bound to the session the client holds, or to the battery's own nonce cookie when it holds none.                                                          |
| `only`              | function | `<TState>(paths: string \| readonly string[], handler: MiddlewareHandler<TState>) => MiddlewareHandler<TState>`                                                | Scopes a battery to the paths its route patterns match and nowhere else — outside them it steps aside through `next()`.                                                                                              |
| `except`            | function | `<TState>(paths: string \| readonly string[], handler: MiddlewareHandler<TState>) => MiddlewareHandler<TState>`                                                | Scopes a battery to every path its route patterns do not match — on the matched paths it steps aside through `next()`.                                                                                               |

### Middlewares — node

| Name                    | Kind     | Signature                                                                                  | Summary                                                                                                                                                                                                                                                                                   |
| ----------------------- | -------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createAssets`          | function | `<TState>(options: AssetOptions) => MiddlewareHandler<TState>`                             | Serves validated in-memory assets with identity/Brotli negotiation.                                                                                                                                                                                                                       |
| `createStatic`          | function | `<TState>(options: StaticOptions) => MiddlewareHandler<TState>`                            | Serves static files from `options.root` over `node:fs` — the node-bound static-file battery, answering conditional, ranged, and SPA-fallback requests.                                                                                                                                    |
| `createMultipart`       | function | `<TState extends MultipartState>(options?: MultipartOptions) => MiddlewareHandler<TState>` | Parses a streamed `multipart/form-data` request body and stashes its `MultipartBody` on `context.state.multipart` — the node-bound streaming multipart battery.                                                                                                                           |
| `createNodeCompression` | function | `<TState>(options?: NodeCompressionOptions) => MiddlewareHandler<TState>`                  | Compresses response bodies through `node:zlib`, which every Node runtime bundles, instead of relying on the WHATWG `CompressionStream` global. This battery is the node-bound sibling of the feature-detected `createCompression`, and both compose the same `compressResponse` skeleton. |

### Types

| Name                        | Kind      | Signature                                                                                            | Summary                                                                                                                                                                                                                                                                                                           |
| --------------------------- | --------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ForeignContract`           | interface | `{ expected, is }`                                                                                   | Describes a foreign implementation contract an options key admits — the members its published interface declares, checked as that interface declares them.                                                                                                                                                        |
| `BoundaryOptions`           | interface | `{ expose?, report? }`                                                                               | Configures `createBoundary` — the error-rendering battery. The factory admits the bag whole, and a refusal is a `ContractError`. The bag must be a plain object; a class instance refuses.                                                                                                                        |
| `TelemetryEntry`            | interface | `{ method, pathname, status, duration }`                                                             | Represents one access-log-style entry `createTelemetry` records after a response settles — the access-log/timing seam's payload shape.                                                                                                                                                                            |
| `TelemetryOptions`          | interface | `{ record }`                                                                                         | Configures `createTelemetry` — the request timing/access-log seam. The factory admits the bag whole, and a refusal is a `ContractError`. The bag must be a plain object; a class instance refuses.                                                                                                                |
| `CompressionOptions`        | interface | `{ threshold?, encodings?, filter? }`                                                                | Configures `createCompression` — response-body compression. The factory admits the bag whole, and a refusal is a `ContractError`. The bag must be a plain object; a class instance refuses.                                                                                                                       |
| `CompressResponseOptions`   | interface | `{ threshold, filter?, encodings, compress }`                                                        | Describes the already-resolved settings `compressResponse` runs its shared negotiate → skip → threshold → compress skeleton against — the shape each of `createCompression` and `createNodeCompression` builds from its own option bag.                                                                           |
| `SecurityIdentifierOptions` | type      | `{ readonly trust?: boolean; } \| false`                                                             | Describes `createSecurity`'s `identifier` sub-option — request-id minting/echo policy, or `false` to disable the feature entirely.                                                                                                                                                                                |
| `SecurityOptions`           | interface | `{ frame?, csp?, referrer?, permissions?, coop?, corp?, cluster?, coep?, hsts?, identifier? }`       | Configures `createSecurity` — the security-headers + request-id battery. The factory admits the bag whole, and a refusal is a `ContractError`. The bag must be a plain object; a class instance refuses.                                                                                                          |
| `CORSOptions`               | interface | `{ origin?, methods?, headers? }`                                                                    | Configures `createCORS` — Cross-Origin Resource Sharing. The factory admits the bag whole, and a refusal is a `ContractError`. The bag must be a plain object; a class instance refuses.                                                                                                                          |
| `DeadlineOptions`           | interface | `{ ms, status? }`                                                                                    | Configures `createDeadline` — the application-level per-request deadline. The factory admits the bag whole, and a refusal is a `ContractError`. The bag must be a plain object; a class instance refuses.                                                                                                         |
| `ForwardedOptions`          | type      | `{ readonly proxies: number; } \| { readonly trusted: readonly string[]; }`                          | Configures `createForwarded` — the trusted-proxy client-IP resolver. The factory admits the bag whole, and a refusal is a `ContractError`. The bag must be a plain object; a class instance refuses.                                                                                                              |
| `ETagOptions`               | interface | `{ weak? }`                                                                                          | Configures `createETag` — dynamic response ETag + conditional GET. The factory admits the bag whole, and a refusal is a `ContractError`. The bag must be a plain object; a class instance refuses.                                                                                                                |
| `BearerOptions`             | interface | `{ verify, header?, scheme?, challenge? }`                                                           | Configures `createBearer` — bearer-token authentication. The factory admits the bag whole, and a refusal is a `ContractError`. The bag must be a plain object; a class instance refuses.                                                                                                                          |
| `BearerVerifyFunction`      | type      | `(token: string, request: Request) => TCredential \| undefined \| Promise<TCredential \| undefined>` | Verifies a presented bearer token and resolves its credential, or `undefined` to refuse it.                                                                                                                                                                                                                       |
| `LimiterOptions`            | interface | `{ store?, max, window, capacity?, key?, message?, clock?, policy?, evict? }`                        | Configures `createLimiter` — fixed-window rate limiting. The factory admits the bag whole, and a refusal is a `ContractError`. The bag must be a plain object; a class instance refuses.                                                                                                                          |
| `BearerState`               | interface | `{ token? }`                                                                                         | Describes the bearer-authentication state slice `createBearer` stashes on `context.state` after a token verifies.                                                                                                                                                                                                 |
| `IdentifierState`           | interface | `{ identifier? }`                                                                                    | Describes the request-identifier state slice `createSecurity` stashes when its `identifier` option is enabled.                                                                                                                                                                                                    |
| `Client`                    | interface | `{ ip? }`                                                                                            | Describes the resolved client connection facts `createForwarded` stashes.                                                                                                                                                                                                                                         |
| `ClientState`               | interface | `{ client? }`                                                                                        | Describes the client-facts state slice `createForwarded` stashes.                                                                                                                                                                                                                                                 |
| `SessionInterface`          | interface | `{ id, state, set(), delete(), clear() }`                                                            | Represents a server-managed session's public surface — an id, its live state, and the mutators that write it.                                                                                                                                                                                                     |
| `SessionControlInterface`   | interface | `{ destroyed, successor, fresh, regenerate(), destroy() }`                                           | Describes the mid-handler control handle `createSession` stashes alongside the session itself — the OWASP anti-fixation / logout primitives.                                                                                                                                                                      |
| `SessionState`              | interface | `{ session?, control? }`                                                                             | Describes the session state slice `createSession` stashes.                                                                                                                                                                                                                                                        |
| `BodyState`                 | interface | `{ body? }`                                                                                          | Describes the body state slice `createBody` stashes.                                                                                                                                                                                                                                                              |
| `SessionStoreInterface`     | interface | `{ get(), set(), delete() }`                                                                         | Describes the pluggable session persistence seam `createSession`'s `store` option implements — a point-access store keyed by session id.                                                                                                                                                                          |
| `SessionTransportInterface` | interface | `{ read(), write(), clear() }`                                                                       | Describes the transport seam `createSession`'s `transport` option implements — how a session id travels to and from the client (a signed cookie, a header, …).                                                                                                                                                    |
| `SessionOptions`            | interface | `{ transport, store?, ttl?, lifetime?, capacity?, evict?, create?, mint?, required?, clock? }`       | Configures `createSession` — the generic session battery. The factory admits the bag whole, and a refusal is a `ContractError`. The bag must be a plain object; a class instance refuses.                                                                                                                         |
| `CookieTransportOptions`    | interface | `{ name?, signer, cookie? }`                                                                         | Configures `createCookieTransport` — the signed-cookie `SessionTransportInterface`. The factory admits the bag whole, and a refusal is a `ContractError`. The bag must be a plain object; a class instance refuses.                                                                                               |
| `HeaderTransportOptions`    | interface | `{ header? }`                                                                                        | Configures `createHeaderTransport` — the bare-header `SessionTransportInterface`. The factory admits the bag whole, and a refusal is a `ContractError`. The bag must be a plain object; a class instance refuses.                                                                                                 |
| `MemorySessionStoreOptions` | interface | `{ capacity?, evict? }`                                                                              | Configures `createMemorySessionStore` — the default in-process `SessionStoreInterface`. The factory admits the bag whole, and a refusal is a `ContractError`. The bag must be a plain object; a class instance refuses.                                                                                           |
| `SessionLimits`             | interface | `{ ttl?, lifetime? }`                                                                                | Describes the idle and absolute-lifetime thresholds a session store enforces — `sessionExpired`'s limits argument and both shipped stores' construction options. `createDatabaseSessionStore` admits the bag whole, and a refusal is a `ContractError`. The bag must be a plain object; a class instance refuses. |
| `SessionCursors`            | interface | `{ seen, created }`                                                                                  | Describes the per-session instants a store stamps and `sessionExpired` measures against.                                                                                                                                                                                                                          |
| `SessionRow`                | interface | `{ id, session }`                                                                                    | Represents one persisted session row — an opaque snapshot column plus the store-owned idle/absolute-lifetime cursors, the shape a `DatabaseSessionStore`'s backing table holds.                                                                                                                                   |
| `SessionEntry`              | interface | `{ session }`                                                                                        | Represents one in-process session entry — the payload `MemorySessionStore` holds against an id, alongside the same cursors a persisted row carries.                                                                                                                                                               |
| `SessionSnapshot`           | interface | `{ id, state }`                                                                                      | Represents a session's serializable projection — the value `snapshotSession` produces and a durable store's `set` writes.                                                                                                                                                                                         |
| `SessionRestoreFunction`    | type      | `(value: unknown) => SessionInterface \| undefined`                                                  | Rebuilds a session entity from an untrusted stored snapshot, or resolves `undefined` when the value is malformed.                                                                                                                                                                                                 |
| `CSRFState`                 | interface | `{ csrf? }`                                                                                          | Describes the CSRF state slice `createCSRF` stashes — a token bound to the session the request arrived with, or to the battery's nonce, for the page to submit back.                                                                                                                                              |
| `CSRFOptions`               | interface | `{ signer, cookie?, header?, field?, safe? }`                                                        | Configures `createCSRF` — signed double-submit CSRF protection, bound to the session the client holds or to the battery's own nonce. The factory admits the bag whole, and a refusal is a `ContractError`. The bag must be a plain object; a class instance refuses.                                              |
| `MultipartFile`             | interface | `{ field, name, size, mime, validated, status, path }`                                               | Represents one staged multipart upload's public record — the shape the node-face `createMultipart` battery (`@orkestrel/middleware`) produces per uploaded file.                                                                                                                                                  |
| `MultipartBody`             | interface | `{ files, fields }`                                                                                  | Describes the parsed multipart request body `createMultipart` stashes — files keyed by their field name, plus every plain text field.                                                                                                                                                                             |
| `MultipartState`            | interface | `{ multipart? }`                                                                                     | Describes the multipart state slice `createMultipart` stashes.                                                                                                                                                                                                                                                    |
| `AssetRepresentation`       | interface | `{ body, encoding? }`                                                                                | Describes one in-memory asset representation returned by an `AssetSourceInterface`.                                                                                                                                                                                                                               |
| `AssetSourceInterface`      | interface | `{ read() }`                                                                                         | Reads in-memory assets by decoded, browser-build-relative path.                                                                                                                                                                                                                                                   |
| `AssetOptions`              | interface | `{ source, store? }`                                                                                 | Configures `createAssets` — in-memory identity/Brotli asset serving. The factory admits the bag whole, and a refusal is a `ContractError`. The bag must be a plain object; a class instance refuses.                                                                                                              |
| `StaticOptions`             | interface | `{ root, prefix?, index?, dotfiles?, cache?, etag?, fallback? }`                                     | Configures `createStatic` — node `fs`-backed static file serving. The factory admits the bag whole, and a refusal is a `ContractError`. The bag must be a plain object; a class instance refuses.                                                                                                                 |
| `MultipartLimitsInput`      | interface | `{ file?, field?, total? }`                                                                          | Describes the caller's partial `MultipartLimits` — `createMultipart`'s `limits` option, with every member optional.                                                                                                                                                                                               |
| `MultipartLimits`           | interface | `{ file, field, total }`                                                                             | Describes the per-category size/count caps `createMultipart` enforces mid-stream — the effective limits, every documented default already applied.                                                                                                                                                                |
| `MultipartOptions`          | interface | `{ limits?, allowed?, directory? }`                                                                  | Configures `createMultipart` — node `fs`/`os`/`crypto`-backed streaming multipart upload parsing. The factory admits the bag whole, and a refusal is a `ContractError`. The bag must be a plain object; a class instance refuses.                                                                                 |
| `NodeCompressionOptions`    | interface | `{ threshold?, filter? }`                                                                            | Configures `createNodeCompression` — `node:zlib`-backed response compression. The factory admits the bag whole, and a refusal is a `ContractError`. The bag must be a plain object; a class instance refuses.                                                                                                     |
| `MultipartErrorCode`        | type      | `'limit' \| 'malformed' \| 'rejected'`                                                               | Names the reason `createMultipart` rejected a request — the machine-readable code `MultipartError` carries and maps onto its HTTP status: `'limit'` → 413, `'malformed'` → 400, `'rejected'` → 415.                                                                                                               |
| `UploadStatus`              | type      | `'staged' \| 'moved'`                                                                                | Names the lifecycle stage of one staged upload's temp file.                                                                                                                                                                                                                                                       |
| `UploadedFile`              | interface | `{ status }`                                                                                         | Describes one uploaded file's post-parse record — the node-bound, richer sibling of `MultipartFile` (identical fields, `status` narrowed to `UploadStatus`). Structurally assignable into `MultipartFile` so a `createMultipart`-built `MultipartBody` satisfies the shared shape.                                |
| `PartHeaders`               | interface | `{ name, filename, mime }`                                                                           | Describes one multipart part's parsed header block — `parsePartHeaders`'s return shape.                                                                                                                                                                                                                           |
| `ByteRange`                 | interface | `{ start, end }`                                                                                     | Describes one inclusive byte range over a file — `streamFile`'s optional `range` argument and the shape `createStatic` builds for a satisfiable `Range` request.                                                                                                                                                  |

### Store and response types

| Name                        | Kind      | Signature                         | Summary                                                                                                                                                                                               |
| --------------------------- | --------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `StaticFile`                | interface | `{ path, handle, info }`          | Describes an opened static file and the facts read from its handle.                                                                                                                                   |
| `StaticResolution`          | interface | `{ path, contained }`             | Describes a canonical static path and whether it lies inside the serving root.                                                                                                                        |
| `StaticPlan`                | interface | `{ status, headers, range }`      | Describes response headers and the optional byte interval of a static file.                                                                                                                           |
| `LimiterLimits`             | interface | `{ max, window }`                 | Describes the budget and duration used when a limiter window starts.                                                                                                                                  |
| `LimiterResult`             | interface | `{ admitted, expiry }`            | Reports an atomic admission decision and its window expiry instant.                                                                                                                                   |
| `LimiterEntry`              | interface | `{ budget, expiry }`              | Holds the budget and expiry instant of an in-memory limiter entry.                                                                                                                                    |
| `LimiterStoreInterface`     | interface | `{ consume() }`                   | Provides atomic per-key fixed-window admission.                                                                                                                                                       |
| `MemoryLimiterStoreOptions` | interface | `{ capacity?, evict? }`           | Configures the in-memory limiter's capacity and eviction observation. The factory admits the bag whole, and a refusal is a `ContractError`. The bag must be a plain object; a class instance refuses. |
| `AssetRecord`               | interface | `{ key, identity, brotli, etag }` | Holds copied asset representations and their shared identity validator.                                                                                                                               |
| `AssetStoreInterface`       | interface | `{ get(), set(), delete() }`      | Provides asynchronous point access to cached asset representations.                                                                                                                                   |

### Request control and stores

| Name                       | Kind     | Signature                                                                                                                      | Summary                                                                             |
| -------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `SessionControl`           | class    | `new (session: SessionInterface, create?: (id: string) => SessionInterface, fresh?: boolean) => SessionControlInterface`       | Records one request's session regeneration or destruction intent.                   |
| `MemoryLimiterStore`       | class    | `new (options?: MemoryLimiterStoreOptions) => LimiterStoreInterface`                                                           | Stores fixed-window budgets with atomic admission and bounded LRU retention.        |
| `MemoryAssetStore`         | class    | `new () => AssetStoreInterface`                                                                                                | Stores asset representations by key for the lifetime of the store.                  |
| `createMemoryLimiterStore` | function | `(options?: MemoryLimiterStoreOptions) => LimiterStoreInterface`                                                               | Creates a bounded in-memory atomic limiter store.                                   |
| `createMemoryAssetStore`   | function | `() => AssetStoreInterface`                                                                                                    | Creates an in-memory asset representation store.                                    |
| `extractBearerToken`       | function | `(raw: string, scheme: string) => string \| undefined`                                                                         | Extracts a token after a case-insensitive scheme and one space.                     |
| `extractFieldToken`        | function | `(body: unknown, field: string) => string \| undefined`                                                                        | Extracts a string field from a parsed body record.                                  |
| `resolveStaticFile`        | function | `(target: string, rootReal: string, index: string) => Promise<StaticResolution \| undefined>`                                  | Resolves a contained static path, including a directory's index.                    |
| `openStaticFile`           | function | `(path: string) => Promise<StaticFile \| undefined>`                                                                           | Opens a static file and reads its handle's metadata.                                |
| `planStaticResponse`       | function | `(request: Request, method: string, info: Stats, path: string, options: Pick<StaticOptions, 'cache' \| 'etag'>) => StaticPlan` | Plans conditional, HEAD, and byte-range responses from opened-file metadata.        |
| `resolveAssetKey`          | function | `(pathname: string) => string \| undefined`                                                                                    | Resolves a decoded relative asset key while refusing hidden or traversing segments. |
| `readAssetRecord`          | function | `(source: AssetSourceInterface, key: string) => Promise<AssetRecord \| undefined>`                                             | Copies an asset, derives its identity bytes, and computes their validator.          |
| `buildAssetResponse`       | function | `(request: Request, method: string, record: AssetRecord) => Response`                                                          | Builds a conditional asset response with identity or Brotli negotiation.            |

### Constants

| Name                              | Kind  | Signature                                                                                              | Summary                                                                                                                                                                                                                                            |
| --------------------------------- | ----- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEFAULT_COMPRESSION_THRESHOLD`   | const | `1024`                                                                                                 | Holds `1024`, the default minimum buffered body size in bytes `createCompression` will compress.                                                                                                                                                   |
| `DEFAULT_COMPRESSION_ENCODINGS`   | const | `readonly Encoding[]`                                                                                  | Lists `['gzip', 'deflate']`, the default content-codings `createCompression` offers in preference order — intersected at construction with what the runtime's `CompressionStream` actually supports.                                               |
| `DEFAULT_FRAME_OPTIONS`           | const | `"DENY"`                                                                                               | Holds `'DENY'`, the default `X-Frame-Options` value `createSecurity` sets.                                                                                                                                                                         |
| `DEFAULT_CSP`                     | const | `"default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'self'; form-action 'self'"` | Holds `"default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'self'; form-action 'self'"`, the default `Content-Security-Policy` value `createSecurity` sets — a custom `csp` option replaces this wholesale, never merges.     |
| `DEFAULT_REFERRER_POLICY`         | const | `"strict-origin-when-cross-origin"`                                                                    | Holds `'strict-origin-when-cross-origin'`, the default `Referrer-Policy` value `createSecurity` sets.                                                                                                                                              |
| `DEFAULT_PERMISSIONS_POLICY`      | const | `"camera=(), microphone=(), geolocation=()"`                                                           | Holds `'camera=(), microphone=(), geolocation=()'`, the default `Permissions-Policy` value `createSecurity` sets.                                                                                                                                  |
| `DEFAULT_COOP`                    | const | `"same-origin"`                                                                                        | Holds `'same-origin'`, the default `Cross-Origin-Opener-Policy` value `createSecurity` sets.                                                                                                                                                       |
| `DEFAULT_CORP`                    | const | `"same-origin"`                                                                                        | Holds `'same-origin'`, the default `Cross-Origin-Resource-Policy` value `createSecurity` sets.                                                                                                                                                     |
| `DEFAULT_CLUSTER`                 | const | `"?1"`                                                                                                 | Holds `'?1'`, the default `Origin-Agent-Cluster` value `createSecurity` sets.                                                                                                                                                                      |
| `DEFAULT_COEP`                    | const | `"require-corp"`                                                                                       | Holds `'require-corp'`, the value `createSecurity` sets for `Cross-Origin-Embedder-Policy` when `coep: true`.                                                                                                                                      |
| `DEFAULT_HSTS`                    | const | `"max-age=31536000; includeSubDomains"`                                                                | Holds `'max-age=31536000; includeSubDomains'`, the value `createSecurity` sets for `Strict-Transport-Security` when `hsts: true`.                                                                                                                  |
| `DEFAULT_IDENTIFIER_HEADER`       | const | `"x-request-id"`                                                                                       | Names `'x-request-id'`, the default header `createSecurity` mints or echoes a request identifier into.                                                                                                                                             |
| `DEFAULT_CORS_METHODS`            | const | `readonly string[]`                                                                                    | Lists the default methods `createCORS` advertises on a preflight response.                                                                                                                                                                         |
| `DEFAULT_CORS_HEADERS`            | const | `readonly string[]`                                                                                    | Lists the default headers `createCORS` advertises on a preflight response.                                                                                                                                                                         |
| `DEFAULT_DEADLINE_STATUS`         | const | `503`                                                                                                  | Holds `503`, the default response status `createDeadline` returns when its deadline fires first.                                                                                                                                                   |
| `DEFAULT_BEARER_HEADER`           | const | `"authorization"`                                                                                      | Names `'authorization'`, the default header `createBearer` reads the token from.                                                                                                                                                                   |
| `DEFAULT_BEARER_SCHEME`           | const | `"Bearer"`                                                                                             | Names `'Bearer'`, the default scheme prefix `createBearer` strips before verification.                                                                                                                                                             |
| `CHALLENGE_TOKEN`                 | const | `Readonly<RegExp>`                                                                                     | Matches an RFC 9110 `token`, the form a challenge scheme and an auth-param name take.                                                                                                                                                              |
| `CHALLENGE_VALUE`                 | const | `Readonly<RegExp>`                                                                                     | Matches the characters RFC 6750 § 3 admits in a quoted auth-param value: `%x20-21 / %x23-5B / %x5D-7E`.                                                                                                                                            |
| `IPV4_ADDRESS`                    | const | `Readonly<RegExp>`                                                                                     | Matches a dotted-decimal IPv4 address: four decimal octets from 0 to 255, with no sign, hex digit, leading zero, or empty octet.                                                                                                                   |
| `IPV4_MAPPED_PREFIX`              | const | `Readonly<RegExp>`                                                                                     | Matches the `::ffff:` prefix, in either case, of an IPv4-mapped IPv6 address written with its embedded dotted IPv4.                                                                                                                                |
| `CIDR_LENGTH`                     | const | `Readonly<RegExp>`                                                                                     | Matches an IPv4 CIDR prefix length `createForwarded`'s roster admits: a decimal from 8 to 32, with no sign or leading zero.                                                                                                                        |
| `DEFAULT_LIMITER_CAPACITY`        | const | `10000`                                                                                                | Holds `10_000`, the default maximum number of distinct rate-limit keys `createLimiter` tracks before LRU eviction.                                                                                                                                 |
| `DEFAULT_LIMITER_MESSAGE`         | const | `"rate limit exceeded"`                                                                                | Holds `'rate limit exceeded'`, the default 429 body message `createLimiter` sends when a key is over budget.                                                                                                                                       |
| `DEFAULT_SESSION_CAPACITY`        | const | `10000`                                                                                                | Holds `10_000`, the default maximum number of distinct session ids `createMemorySessionStore` tracks before least-recently-used eviction.                                                                                                          |
| `DEFAULT_SESSION_COOKIE`          | const | `"session"`                                                                                            | Names `'session'`, the default cookie `createCookieTransport` writes the signed session id under.                                                                                                                                                  |
| `DEFAULT_SESSION_HEADER`          | const | `"session-id"`                                                                                         | Names `'session-id'`, the default header `createHeaderTransport` carries the session id in.                                                                                                                                                        |
| `DEFAULT_CSRF_COOKIE`             | const | `"csrf"`                                                                                               | Names `'csrf'`, the default cookie `createCSRF` keeps its nonce in when the client holds no session.                                                                                                                                               |
| `CSRF_LABEL`                      | const | `"csrf:"`                                                                                              | Opens every message `createCSRF` signs; its `:` lies outside the base64url alphabet, so no base64url `signToken` payload equals a CSRF message.                                                                                                    |
| `CSRF_NONCE_BYTES`                | const | `32`                                                                                                   | Holds `32`, the byte count of a CSRF nonce and of a CSRF token's random part.                                                                                                                                                                      |
| `CSRF_NONCE_PATTERN`              | const | `Readonly<RegExp>`                                                                                     | Matches a CSRF nonce or a CSRF token's random part: the 43 base64url characters that encode `CSRF_NONCE_BYTES` bytes.                                                                                                                              |
| `CSRF_FIELD_TYPES`                | const | `readonly string[]`                                                                                    | Lists the media types whose body `createCSRF` reads its field from: the two the server decodes to a record.                                                                                                                                        |
| `DEFAULT_CSRF_HEADER`             | const | `"x-csrf-token"`                                                                                       | Names `'x-csrf-token'`, the default header `createCSRF` reads a mutating request's submitted token from.                                                                                                                                           |
| `DEFAULT_CSRF_FIELD`              | const | `"_csrf"`                                                                                              | Names `'_csrf'`, the default body field `createCSRF` falls back to reading a mutating request's submitted token from.                                                                                                                              |
| `DEFAULT_CSRF_SAFE_METHODS`       | const | `readonly string[]`                                                                                    | Lists `['GET', 'HEAD', 'OPTIONS']`, the default methods `createCSRF` treats as safe (mint instead of verify).                                                                                                                                      |
| `MULTIPART_STATUS`                | const | `Readonly<Record<MultipartErrorCode, number>>`                                                         | Holds the HTTP status `createMultipart` renders for each `MultipartErrorCode`: `'limit'` is 413, `'malformed'` is 400, and `'rejected'` is 415.                                                                                                    |
| `MULTIPART_ERROR_BRAND`           | const | `unique symbol`                                                                                        | Holds the `Symbol.for` brand `MultipartError` carries so `isMultipartError` recognizes an instance across duplicate copies of this package — a registry symbol rather than a module-local `Symbol()`, which would mint an unequal symbol per copy. |
| `NODE_COMPRESSION_ENCODINGS`      | const | `readonly Encoding[]`                                                                                  | Lists `['gzip', 'deflate']`, the content-codings `createNodeCompression` offers — the codecs of `node:zlib`, which every Node runtime bundles, so this face never feature-detects.                                                                 |
| `DEFAULT_STATIC_INDEX`            | const | `"index.html"`                                                                                         | Names `'index.html'`, `createStatic`'s default directory-index filename.                                                                                                                                                                           |
| `DEFAULT_STATIC_FALLBACK_EXCLUDE` | const | `"/api"`                                                                                               | Names `'/api'`, `createStatic`'s `fallback: true` default excluded path prefix.                                                                                                                                                                    |
| `DEFAULT_STATIC_DOTFILES`         | const | `NonNullable<StaticOptions['dotfiles']>`                                                               | Names `'ignore'`, `createStatic`'s default policy for a path carrying a dotfile segment.                                                                                                                                                           |
| `DEFAULT_CONTENT_TYPE`            | const | `"application/octet-stream"`                                                                           | Names `'application/octet-stream'`, the MIME type served when a file extension has no known mapping.                                                                                                                                               |
| `DEFAULT_MULTIPART_FILE_SIZE`     | const | `10485760`                                                                                             | Holds `10_485_760`, `createMultipart`'s default per-file byte-size cap.                                                                                                                                                                            |
| `DEFAULT_MULTIPART_FILE_COUNT`    | const | `10`                                                                                                   | Holds `10`, `createMultipart`'s default maximum file-part count.                                                                                                                                                                                   |
| `DEFAULT_MULTIPART_FIELD_SIZE`    | const | `65536`                                                                                                | Holds `65_536`, `createMultipart`'s default per-field byte-size cap.                                                                                                                                                                               |
| `DEFAULT_MULTIPART_FIELD_COUNT`   | const | `100`                                                                                                  | Holds `100`, `createMultipart`'s default maximum field-part count.                                                                                                                                                                                 |
| `DEFAULT_MULTIPART_TOTAL`         | const | `52428800`                                                                                             | Holds `52_428_800`, `createMultipart`'s default combined request-body byte-size cap.                                                                                                                                                               |
| `MULTIPART_MAX_HEADER_BLOCK`      | const | `16384`                                                                                                | Holds `16_384`, the maximum bytes a single multipart part's header block may occupy before it is malformed.                                                                                                                                        |
| `MULTIPART_MAX_PREAMBLE`          | const | `65536`                                                                                                | Holds `65_536`, the maximum bytes scanned before the first multipart boundary is found before it is malformed.                                                                                                                                     |
| `MULTIPART_MAX_BOUNDARY`          | const | `70`                                                                                                   | Holds `70`, the maximum length of a multipart boundary, which RFC 2046 § 5.1.1 fixes.                                                                                                                                                              |
| `RESERVED_DEVICE_NAMES`           | const | `ReadonlySet<string>`                                                                                  | Lists the Windows reserved device-name stems (CVE-2025-27210) — matched case-insensitively against the segment's stem (before its first `.`).                                                                                                      |
| `EXTENSION_TYPES`                 | const | `Readonly<Record<string, string>>`                                                                     | Holds the file-extension (lowercase, with leading `.`) → MIME type lookup table for static serving.                                                                                                                                                |

### Contracts

| Name                            | Kind  | Signature                                                                                                                                                                                                                                                                                                                                                                                  | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BOUNDARY_CONTRACT`             | const | `import("@orkestrel/contract").ContractInterface<Readonly<{} & { expose?: boolean; report?: (...args: never[]) => unknown; }>>`                                                                                                                                                                                                                                                            | Admits `BoundaryOptions` whole for `createBoundary`: a boolean `expose` and a function `report`.                                                                                                                                                                                                                                                                                                                                                         |
| `TELEMETRY_CONTRACT`            | const | `import("@orkestrel/contract").ContractInterface<Readonly<{ record: (...args: never[]) => unknown; } & {}>>`                                                                                                                                                                                                                                                                               | Admits `TelemetryOptions` whole for `createTelemetry`: a required function `record`.                                                                                                                                                                                                                                                                                                                                                                     |
| `COMPRESSION_CONTRACT`          | const | `import("@orkestrel/contract").ContractInterface<Readonly<{} & { threshold?: number; encodings?: readonly ("deflate" \| "gzip" \| "identity")[]; filter?: (...args: never[]) => unknown; }>>`                                                                                                                                                                                              | Admits `CompressionOptions` whole for `createCompression`: a non-negative finite `threshold`, an `encodings` array of `Encoding` literals, and a function `filter`.                                                                                                                                                                                                                                                                                      |
| `NODE_COMPRESSION_CONTRACT`     | const | `import("@orkestrel/contract").ContractInterface<Readonly<{} & { threshold?: number; filter?: (...args: never[]) => unknown; }>>`                                                                                                                                                                                                                                                          | Admits `NodeCompressionOptions` whole for `createNodeCompression`: a non-negative finite `threshold` and a function `filter`.                                                                                                                                                                                                                                                                                                                            |
| `SECURITY_CONTRACT`             | const | `import("@orkestrel/contract").ContractInterface<Readonly<{} & { frame?: "DENY" \| "SAMEORIGIN" \| false; csp?: string \| false; referrer?: string \| false; permissions?: string \| false; coop?: string \| false; corp?: string \| false; cluster?: string \| false; coep?: string \| boolean; hsts?: string \| boolean; identifier?: false \| Readonly<{} & { trust?: boolean; }>; }>>` | Admits `SecurityOptions` whole for `createSecurity`: each header option is a string or `false`, `coep` and `hsts` are a string or a boolean, and `identifier` is `{ trust? }` or `false`.                                                                                                                                                                                                                                                                |
| `CORS_CONTRACT`                 | const | `import("@orkestrel/contract").ContractInterface<Readonly<{} & { origin?: string \| readonly string[]; methods?: readonly string[]; headers?: readonly string[]; }>>`                                                                                                                                                                                                                      | Admits `CORSOptions` whole for `createCORS`: `origin` is a string or a string array, and `methods` and `headers` are string arrays.                                                                                                                                                                                                                                                                                                                      |
| `DEADLINE_CONTRACT`             | const | `import("@orkestrel/contract").ContractInterface<Readonly<{ ms: number; } & { status?: number; }>>`                                                                                                                                                                                                                                                                                        | Admits `DeadlineOptions` whole for `createDeadline`: an integer `ms` from 1 through 2147483647, the range `@orkestrel/timeout` enforces, and an integer `status` from 200 through 599.                                                                                                                                                                                                                                                                   |
| `FORWARDED_CONTRACT`            | const | `import("@orkestrel/contract").ContractInterface<Readonly<{ proxies: number; } & {}> \| Readonly<{ trusted: readonly string[]; } & {}>>`                                                                                                                                                                                                                                                   | Admits `ForwardedOptions` whole for `createForwarded`: exactly one of an integer `proxies` of at least 1 or a `trusted` string array.                                                                                                                                                                                                                                                                                                                    |
| `ETAG_CONTRACT`                 | const | `import("@orkestrel/contract").ContractInterface<Readonly<{} & { weak?: boolean; }>>`                                                                                                                                                                                                                                                                                                      | Admits `ETagOptions` whole for `createETag`: a boolean `weak`.                                                                                                                                                                                                                                                                                                                                                                                           |
| `BEARER_CONTRACT`               | const | `import("@orkestrel/contract").ContractInterface<Readonly<{ verify: (...args: never[]) => unknown; } & { header?: string; scheme?: string; challenge?: { readonly [k: string]: string; }; }>>`                                                                                                                                                                                             | Admits `BearerOptions` whole for `createBearer`: a required function `verify`, string `header` and `scheme`, and a `challenge` record of strings.                                                                                                                                                                                                                                                                                                        |
| `LIMITER_CONTRACT`              | const | `import("@orkestrel/contract").ContractInterface<Readonly<{ max: number; window: number; } & { store?: unknown; capacity?: number; key?: (...args: never[]) => unknown; message?: string; clock?: (...args: never[]) => unknown; policy?: boolean; evict?: (...args: never[]) => unknown; }>>`                                                                                             | Admits `LimiterOptions` whole for `createLimiter`: an integer `max` of at least 1, a positive finite `window`, an integer `capacity` of at least 1, and the declared functions; `store` is a foreign key that `LIMITER_STORE_FOREIGN` checks after admission.                                                                                                                                                                                            |
| `SESSION_CONTRACT`              | const | `import("@orkestrel/contract").ContractInterface<Readonly<{ transport: unknown; } & { store?: unknown; ttl?: number; lifetime?: number; capacity?: number; evict?: (...args: never[]) => unknown; create?: (...args: never[]) => unknown; mint?: (...args: never[]) => unknown; required?: boolean; clock?: (...args: never[]) => unknown; }>>`                                            | Admits `SessionOptions` whole for `createSession`: positive finite `ttl` and `lifetime`, an integer `capacity` of at least 1, and the declared functions; `transport` and `store` are foreign keys that `SESSION_TRANSPORT_FOREIGN` and `SESSION_STORE_FOREIGN` check after admission.                                                                                                                                                                   |
| `COOKIE_TRANSPORT_CONTRACT`     | const | `import("@orkestrel/contract").ContractInterface<Readonly<{ signer: unknown; } & { name?: string; cookie?: Readonly<{} & { path?: string; domain?: string; maxAge?: number; httpOnly?: boolean; secure?: boolean; sameSite?: "Lax" \| "None" \| "Strict"; }>; }>>`                                                                                                                         | Admits `CookieTransportOptions` whole for `createCookieTransport`: a string `name`, a required `signer`, checked as a foreign key, and an owned `cookie` record of the six optional members `@orkestrel/server` declares: string `path` and `domain`, a finite number `maxAge` (a non-finite value writes `Max-Age=NaN` or `Max-Age=Infinity` into `Set-Cookie`), boolean `httpOnly` and `secure`, and a `sameSite` of `'Strict'`, `'Lax'`, or `'None'`. |
| `HEADER_TRANSPORT_CONTRACT`     | const | `import("@orkestrel/contract").ContractInterface<Readonly<{} & { header?: string; }>>`                                                                                                                                                                                                                                                                                                     | Admits `HeaderTransportOptions` whole for `createHeaderTransport`: a string `header`.                                                                                                                                                                                                                                                                                                                                                                    |
| `SESSION_LIMITS_CONTRACT`       | const | `import("@orkestrel/contract").ContractInterface<Readonly<{} & { ttl?: number; lifetime?: number; }>>`                                                                                                                                                                                                                                                                                     | Admits `SessionLimits` whole for `createDatabaseSessionStore`: positive finite `ttl` and `lifetime`.                                                                                                                                                                                                                                                                                                                                                     |
| `MEMORY_SESSION_STORE_CONTRACT` | const | `import("@orkestrel/contract").ContractInterface<Readonly<{} & { ttl?: number; lifetime?: number; capacity?: number; evict?: (...args: never[]) => unknown; }>>`                                                                                                                                                                                                                           | Admits `MemorySessionStoreOptions` whole for `createMemorySessionStore`: positive finite `ttl` and `lifetime`, an integer `capacity` of at least 1, and a function `evict`.                                                                                                                                                                                                                                                                              |
| `MEMORY_LIMITER_STORE_CONTRACT` | const | `import("@orkestrel/contract").ContractInterface<Readonly<{} & { capacity?: number; evict?: (...args: never[]) => unknown; }>>`                                                                                                                                                                                                                                                            | Admits `MemoryLimiterStoreOptions` whole for `createMemoryLimiterStore`: an integer `capacity` of at least 1 and a function `evict`.                                                                                                                                                                                                                                                                                                                     |
| `CSRF_CONTRACT`                 | const | `import("@orkestrel/contract").ContractInterface<Readonly<{ signer: unknown; } & { cookie?: string; header?: string; field?: string; safe?: readonly string[]; }>>`                                                                                                                                                                                                                        | Admits `CSRFOptions` whole for `createCSRF`: a required `signer` that `SIGNER_FOREIGN` checks after admission, string `cookie`, `header`, and `field`, and a `safe` string array.                                                                                                                                                                                                                                                                        |
| `SCOPE_CONTRACT`                | const | `import("@orkestrel/contract").ContractInterface<Readonly<{ paths: string \| readonly string[]; handler: (...args: never[]) => unknown; } & {}>>`                                                                                                                                                                                                                                          | Admits the arguments of `only` and `except` whole: `paths` is a string or a string array, and `handler` is a function.                                                                                                                                                                                                                                                                                                                                   |
| `ASSET_CONTRACT`                | const | `import("@orkestrel/contract").ContractInterface<Readonly<{ source: unknown; } & { store?: unknown; }>>`                                                                                                                                                                                                                                                                                   | Admits `AssetOptions` whole for `createAssets`: both keys are foreign, so `ASSET_SOURCE_FOREIGN` and `ASSET_STORE_FOREIGN` check them after admission.                                                                                                                                                                                                                                                                                                   |
| `STATIC_CONTRACT`               | const | `import("@orkestrel/contract").ContractInterface<Readonly<{ root: string; } & { prefix?: string; index?: string; dotfiles?: "allow" \| "deny" \| "ignore"; cache?: number; etag?: boolean; fallback?: boolean \| Readonly<{} & { exclude?: string; }>; }>>`                                                                                                                                | Admits `StaticOptions` whole for `createStatic`: a non-empty string `root`, a non-negative finite `cache`, a `dotfiles` literal, and a `fallback` that is a boolean or `{ exclude? }`.                                                                                                                                                                                                                                                                   |
| `MULTIPART_CONTRACT`            | const | `import("@orkestrel/contract").ContractInterface<Readonly<{} & { limits?: Readonly<{} & { file?: Readonly<{} & { size?: number; count?: number; }>; field?: Readonly<{} & { size?: number; count?: number; }>; total?: number; }>; allowed?: readonly string[]; directory?: string; }>>`                                                                                                   | Admits `MultipartOptions` whole for `createMultipart`: non-negative finite sizes and totals, non-negative integer counts, a string array `allowed`, and a string `directory`.                                                                                                                                                                                                                                                                            |
| `UPLOADED_FILE_CONTRACT`        | const | `import("@orkestrel/contract").ContractInterface<Readonly<{ field: string; name: string; size: number; mime: string; validated: boolean; status: "moved" \| "staged"; path: string; } & {}>>`                                                                                                                                                                                              | Admits one `UploadedFile` whole for `createUploadedFile`: string `field`, `name`, `mime`, and `path`, a non-negative finite `size`, a boolean `validated`, and a `status` literal.                                                                                                                                                                                                                                                                       |
| `LIMITER_STORE_FOREIGN`         | const | `import("./types.js").ForeignContract`                                                                                                                                                                                                                                                                                                                                                     | Holds the members `LimiterOptions.store` declares: `consume`.                                                                                                                                                                                                                                                                                                                                                                                            |
| `SESSION_TRANSPORT_FOREIGN`     | const | `import("./types.js").ForeignContract`                                                                                                                                                                                                                                                                                                                                                     | Holds the members `SessionOptions.transport` declares: `read`, `write`, and `clear`.                                                                                                                                                                                                                                                                                                                                                                     |
| `SESSION_STORE_FOREIGN`         | const | `import("./types.js").ForeignContract`                                                                                                                                                                                                                                                                                                                                                     | Holds the members `SessionOptions.store` declares: `get`, `set`, and `delete`.                                                                                                                                                                                                                                                                                                                                                                           |
| `SIGNER_FOREIGN`                | const | `import("./types.js").ForeignContract`                                                                                                                                                                                                                                                                                                                                                     | Holds the members `CookieTransportOptions.signer` and `CSRFOptions.signer` declare: `sign` and `verify`.                                                                                                                                                                                                                                                                                                                                                 |
| `ASSET_SOURCE_FOREIGN`          | const | `import("./types.js").ForeignContract`                                                                                                                                                                                                                                                                                                                                                     | Holds the members `AssetOptions.source` declares: `read`.                                                                                                                                                                                                                                                                                                                                                                                                |
| `ASSET_STORE_FOREIGN`           | const | `import("./types.js").ForeignContract`                                                                                                                                                                                                                                                                                                                                                     | Holds the members `AssetOptions.store` declares: `get`, `set`, and `delete`.                                                                                                                                                                                                                                                                                                                                                                             |

### Combinators

| Name                   | Kind     | Signature                                         | Summary                                                                                                                                                      |
| ---------------------- | -------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `buildForeignContract` | function | `(members: readonly string[]) => ForeignContract` | Builds a `ForeignContract` whose every declared member is a function — the contract an implementation key admits, such as a store, a transport, or a source. |

### Shapers

| Name             | Kind  | Signature                                                                                                                                                                                                   | Summary                                                                                                                                                                                                                     |
| ---------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessionColumns` | const | `{ id: import("@orkestrel/contract").StringShape; session: import("@orkestrel/contract").JSONShape; seen: import("@orkestrel/contract").NumberShape; created: import("@orkestrel/contract").NumberShape; }` | Holds the `@orkestrel/database` column shape for a `SessionRow` table. Pass it as-is to `createDatabase({ tables: { sessions: sessionColumns } })` so an app declaring a durable session table never hand-writes the shape. |

### Helpers — web-standard

| Name                             | Kind     | Signature                                                                                                                               | Summary                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolveKey`                     | function | `(state: BearerState<unknown> & ClientState, connection: Connection) => string`                                                         | Derives `createLimiter`'s default rate-limit bucket key from a request's resolved identity facts.                                                                                                                                                                                                                                                                 |
| `renderChallenge`                | function | `(scheme: string, parameters?: Readonly<Record<string, string>>, door?: string) => string`                                              | Renders a `WWW-Authenticate` challenge as the scheme alone, or the scheme followed by quoted auth-params in the record's own key order.                                                                                                                                                                                                                           |
| `resolveOptInHeader`             | function | `(value: string \| boolean \| undefined, fallback: string) => string \| undefined`                                                      | Resolves an opt-in, value-bearing security header — `string \| boolean` (off by default, `true` uses the secure default), the shape `createSecurity`'s `coep`/`hsts` options use, distinct from the plain value-or-`false` shape `resolveSecurityHeader` (the peer substrate) handles.                                                                            |
| `buildRetryAfter`                | function | `(expiry: number, now: number) => string`                                                                                               | Builds the `Retry-After` header value — whole seconds until a window reset, floored at a minimum of `1`.                                                                                                                                                                                                                                                          |
| `buildRateLimitField`            | function | `(remaining: number, expiry: number, now: number) => string`                                                                            | Builds the draft `RateLimit` structured header field — emitted only when `createLimiter`'s `policy` option is `true`.                                                                                                                                                                                                                                             |
| `buildRateLimitPolicyField`      | function | `(max: number, window: number) => string`                                                                                               | Builds the draft `RateLimit-Policy` structured header field — emitted only when `createLimiter`'s `policy` option is `true`.                                                                                                                                                                                                                                      |
| `matchesTrustedEntry`            | function | `(address: string, entry: string) => boolean`                                                                                           | Checks whether a candidate address is a trusted-hop match — an exact match, or a prefix-CIDR match for IPv4 (`/8`–`/32`), with an IPv4-mapped address compared by its embedded IPv4. An IPv6 entry matches by exact string only — there is no IPv6 CIDR support.                                                                                                  |
| `resolveForwardedFor`            | function | `(header: string \| undefined, trust: ForwardedOptions, peer: string \| undefined) => string \| undefined`                              | Resolves the client address from `X-Forwarded-For` and the socket peer — `createForwarded`'s core algorithm.                                                                                                                                                                                                                                                      |
| `matchesScope`                   | function | `(patterns: readonly CompiledPath[], pathname: string) => boolean`                                                                      | Checks whether a request pathname matches any compiled scope pattern — the test `only` and `except` apply, through the router's own `matchPath`.                                                                                                                                                                                                                  |
| `detectEncodings`                | function | `(candidates: readonly Encoding[]) => readonly Encoding[]`                                                                              | Feature-detects which of `candidates` the runtime's `CompressionStream` actually supports — `createCompression`'s construction-time intersection.                                                                                                                                                                                                                 |
| `compressBytes`                  | function | `(bytes: Uint8Array<ArrayBuffer>, encoding: Exclude<Encoding, 'identity'>) => Promise<Uint8Array<ArrayBuffer>>`                         | Compresses bytes with the host-independent `CompressionStream` primitive.                                                                                                                                                                                                                                                                                         |
| `matchesUnbufferableResponse`    | function | `(method: string, response: Response, skipHeader: string) => boolean`                                                                   | Checks whether a response must skip the compression and ETag buffering pipeline — the shared cheap-skip predicate both batteries apply before ever touching `response.arrayBuffer()`, true for a `HEAD` request, a `204`/`304` or otherwise bodyless response, an `event-stream` response, and a response already carrying the header the caller is about to set. |
| `matchesUntransformableResponse` | function | `(response: Response) => boolean`                                                                                                       | Checks whether a response must keep its content coding — a `206 Partial Content`, whose `Content-Range` counts bytes of the identity representation, or a response whose `Cache-Control` carries the `no-transform` directive (RFC 9111 § 5.2.2.6).                                                                                                               |
| `isCompressionNegotiated`        | function | `(encoding: Encoding \| undefined) => encoding is Exclude<Encoding, 'identity'>`                                                        | Checks whether a negotiated `Accept-Encoding` outcome is worth acting on — `createCompression`'s negotiation-eligibility half of the skip list.                                                                                                                                                                                                                   |
| `rebuildResponse`                | function | `(body: ConstructorParameters<typeof Response>[0], response: Response, headers?: ConstructorParameters<typeof Headers>[0]) => Response` | Rebuilds a `Response` around a replacement body while preserving its status/statusText — the buffered-response reconstruction shared by the compression and ETag batteries after they have consumed `response.arrayBuffer()`.                                                                                                                                     |
| `compressResponse`               | function | `(request: Request, context: MiddlewareContext<unknown>, response: Response, options: CompressResponseOptions) => Promise<Response>`    | Runs the shared negotiate → skip → threshold → compress → header-set skeleton `createCompression` and `createNodeCompression` compose — response-body compression over a caller-supplied set of feature-detected codings.                                                                                                                                         |
| `transferSessionState`           | function | `(from: SessionInterface, to: SessionInterface) => void`                                                                                | Copies every entry of one session's `state` into another — the regenerate state-carry `createSession`'s `control.regenerate()` applies.                                                                                                                                                                                                                           |
| `matchesSessionState`            | function | `(before: ReadonlyMap<string, unknown>, after: ReadonlyMap<string, unknown>) => boolean`                                                | Checks whether two session states hold the same keys, each bound to the same value by `Object.is` — the test `createSession` applies to decide whether a handler wrote to a session.                                                                                                                                                                              |
| `generateNonce`                  | function | `() => string`                                                                                                                          | Generates a random nonce: 32 bytes from the platform's cryptographic source, as 43 base64url characters — the nonce `createCSRF` keeps in its cookie and a CSRF token's random part.                                                                                                                                                                              |
| `signCSRFToken`                  | function | `(signer: SignerInterface, binding: string) => Promise<string>`                                                                         | Signs a CSRF token bound to `binding`: `random.signature`, where `signature` is the signer's HMAC over `CSRF_LABEL`, `binding`, and `random`, so the token carries no form of the binding.                                                                                                                                                                        |
| `verifyCSRFToken`                | function | `(signer: SignerInterface, binding: string, token: string) => Promise<boolean>`                                                         | Verifies a CSRF token against `binding`: the token's random part must match `CSRF_NONCE_PATTERN`, and its signature must be the signer's HMAC over `CSRF_LABEL`, `binding`, and that random part, under any held key.                                                                                                                                             |
| `sessionExpired`                 | function | `(cursors: SessionCursors, now: number, limits: SessionLimits) => boolean`                                                              | Checks whether a session has aged past its idle timeout or absolute lifetime as of `now` — the pure expiry predicate `MemorySessionStore` delegates to.                                                                                                                                                                                                           |
| `snapshotSession`                | function | `(session: SessionInterface) => SessionSnapshot`                                                                                        | Snapshots a session's `state` into a plain, serializable record — the projection a durable store's `set` writes to disk.                                                                                                                                                                                                                                          |
| `admitForeign`                   | function | `(door: string, path: readonly string[], foreign: ForeignContract, value: unknown) => void`                                             | Admits one foreign implementation key against the members its published interface declares, accepting a class instance and unknown members.                                                                                                                                                                                                                       |
| `admitOptions`                   | function | `<T>(door: string, contract: ContractInterface<T>, value: unknown) => void`                                                             | Admits an options bag whole against its compiled contract, refusing a missing required key, an undeclared key, and a value outside a declared range.                                                                                                                                                                                                              |
| `isPreflight`                    | function | `(method: string, headers: Headers) => boolean`                                                                                         | Determines whether a request is a CORS preflight — an `OPTIONS` request carrying an `Access-Control-Request-Method` header.                                                                                                                                                                                                                                       |
| `buildClient`                    | function | `(ip: string \| undefined) => Client`                                                                                                   | Builds the `Client` slice `createForwarded` stashes, from the resolved client IP — a leaf shaping helper.                                                                                                                                                                                                                                                         |
| `equalsConstantTime`             | function | `(a: string, b: string) => boolean`                                                                                                     | Compares two strings in constant time when their lengths match, so a per-character mismatch never changes how long the comparison takes.                                                                                                                                                                                                                          |

### Validators — web-standard

Each guard in the following table is total: it accepts any input, returns `false` off-shape, and never throws.

| Name               | Kind     | Signature                                              | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------ | -------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `isSession`        | function | `(value: unknown) => value is SessionInterface`        | Determines whether a value implements `SessionInterface` — a total structural guard: an `id` string, a `state` `Map`, and the `set`, `delete`, and `clear` mutators. Prototype-agnostic — accepts a plain object, a null-prototype object, and a class instance (a real `Session`), because a restored or stored session is routinely a class instance rather than a literal.                                                                                                                                            |
| `isSessionControl` | function | `(value: unknown) => value is SessionControlInterface` | Determines whether a value implements `SessionControlInterface` — a total structural guard over every declared member: boolean `destroyed` and `fresh`, a `successor` that is `undefined` or satisfies `isSession`, and callable `regenerate` and `destroy`. Prototype-agnostic — accepts a plain object, a callable object, and a class instance (a real `SessionControl`), and ignores unknown members. A value missing a declared member answers false, and so does a member read that throws, as on a revoked proxy. |
| `isMultipartFile`  | function | `(value: unknown) => value is MultipartFile`           | Determines whether a value is one staged `MultipartFile` record — a total structural guard checking every required field's shape.                                                                                                                                                                                                                                                                                                                                                                                        |
| `isMultipartBody`  | function | `(value: unknown) => value is MultipartBody`           | Determines whether a value implements `MultipartBody` — a total structural guard: `files` keyed by field name to arrays of `MultipartFile`, and a `fields` string record.                                                                                                                                                                                                                                                                                                                                                |

Before 0.0.35, `isSessionControl` refused every class instance, a real `SessionControl` included, and accepted any value with callable `regenerate` and `destroy`. From 0.0.35, it also requires `destroyed`, `successor`, and `fresh` at their declared types, so a value that carries only the two methods answers false.

### Helpers — node

| Name                        | Kind     | Signature                                                                                                                 | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolveStaticPath`         | function | `(root: string, prefix: string \| undefined, pathname: string) => string \| undefined`                                    | Resolves a request pathname to an on-disk path under `root`, or `undefined` when it cannot — the traversal guard, whose algorithm and order are exact: strip `prefix` on a segment boundary → `decodeURIComponent` (a malformed escape refuses, never throws) → reject a NUL byte → strip the leading path separator first (so a leading `..` survives `normalize` as a genuine climbing segment) → `normalize` → refuse any Windows reserved-device-name segment (`isReservedDeviceName`) → `resolve` and require the result under `root`. |
| `isUnderPath`               | function | `(pathname: string, prefix: string) => boolean`                                                                           | Checks whether `pathname` is `prefix` itself or lies under it on a segment boundary — the shared under-path test `resolveStaticPath`'s prefix strip and `createStatic`'s SPA-fallback `exclude` both apply, so `exclude: '/api'` matches `/api` and `/api/x` but never `/apifoo`.                                                                                                                                                                                                                                                           |
| `resolveStaticFallbackPath` | function | `(root: string, index: string, exclude: string, method: string, pathname: string, accept: string) => string \| undefined` | Resolves the fixed SPA shell path when a static-file miss is eligible for fallback.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `isContainedPath`           | function | `(child: string, parent: string) => boolean`                                                                              | Checks whether `child` is `parent` itself or lies inside it on-disk — the filesystem containment predicate `createStatic` applies to `fs.realpath` output (never to a URL pathname — that is `isUnderPath`'s job).                                                                                                                                                                                                                                                                                                                          |
| `resolveContainedRealPath`  | function | `(candidate: string, rootReal: string) => Promise<string \| undefined>`                                                   | Canonicalizes `candidate` and returns it only when it lies inside `rootReal` — the shared realpath-then-contain step `createStatic` applies to a directory index and to its SPA shell.                                                                                                                                                                                                                                                                                                                                                      |
| `isReservedDeviceName`      | function | `(segment: string) => boolean`                                                                                            | Checks whether a path segment is a Windows reserved device name (CVE-2025-27210).                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `isDotfilePath`             | function | `(relativePath: string) => boolean`                                                                                       | Checks whether a relative path (already resolved under a static root) has any segment starting with `.` — a dotfile or dot-directory.                                                                                                                                                                                                                                                                                                                                                                                                       |
| `lookupContentType`         | function | `(pathname: string) => string`                                                                                            | Looks up the MIME type for a static file path by its extension.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `computeFileETag`           | function | `(size: number, mtimeMs: number) => string`                                                                               | Computes a static file's weak ETag from its size and modification time.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `detectMIME`                | function | `(head: Uint8Array) => string \| undefined`                                                                               | Sniffs a MIME type from a file's leading bytes against a small magic-byte table (jpeg, png, gif87a/89a, webp, pdf, zip).                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `matchesBytes`              | function | `(bytes: Uint8Array, signature: readonly number[], offset?: number) => boolean`                                           | Checks whether `bytes` contains `signature` at the requested offset.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `compressNodeBytes`         | function | `(bytes: Uint8Array<ArrayBuffer>, encoding: Exclude<Encoding, 'identity'>) => Promise<Uint8Array<ArrayBuffer>>`           | Compresses response bytes with the gzip or deflate codec of `node:zlib`, which every Node runtime bundles.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `extractMultipartBoundary`  | function | `(contentType: string \| null) => string \| undefined`                                                                    | Extracts the `boundary` parameter from a `Content-Type` header, or `undefined` when the request is not `multipart/form-data`.                                                                                                                                                                                                                                                                                                                                                                                                               |
| `parsePartHeaders`          | function | `(block: string) => PartHeaders`                                                                                          | Parses one multipart part's raw header block into its `name` (from `Content-Disposition`), optional `filename`, and optional `Content-Type`.                                                                                                                                                                                                                                                                                                                                                                                                |
| `resolveMultipartLimits`    | function | `(limits: MultipartLimitsInput \| undefined) => MultipartLimits`                                                          | Resolves `createMultipart`'s effective `MultipartLimits`, applying every documented default to an omitted leaf.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `streamFile`                | function | `(source: string \| FileHandle, range?: ByteRange) => ReadableStream<Uint8Array>`                                         | Adapts a `node:fs` read stream over a file path (or an already-open `FileHandle`) into a DOM-compatible `ReadableStream<Uint8Array>` — the single shared node↔web stream bridge every static-file and uploaded-file response body routes through.                                                                                                                                                                                                                                                                                           |
| `streamUploadedFile`        | function | `(file: UploadedFile) => ReadableStream<Uint8Array>`                                                                      | Opens a staged/moved uploaded file as a web `ReadableStream`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `readUploadedFile`          | function | `(file: UploadedFile) => Promise<Uint8Array>`                                                                             | Reads a staged/moved uploaded file's full contents into memory.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `moveUploadedFile`          | function | `(file: UploadedFile, destination: string) => Promise<UploadedFile>`                                                      | Moves a staged uploaded file to its final `destination`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `unlinkStagedFiles`         | function | `(body: MultipartBody) => Promise<void>`                                                                                  | Attempts to unlink every still-`'staged'` file in a parsed `MultipartBody` — the cleanup `createMultipart` runs when its downstream handler settles, mirroring `parseMultipartRequest`'s own cleanup pattern (a missing file is already gone; failures are swallowed).                                                                                                                                                                                                                                                                      |

### Parsers — node

| Name                    | Kind     | Signature                                                                               | Summary                                                                                                                          |
| ----------------------- | -------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `parseMultipartRequest` | function | `(request: Request, options?: MultipartOptions) => Promise<MultipartBody \| undefined>` | Stream-parses a `multipart/form-data` request into its files and fields — the mid-stream state machine `createMultipart` drives. |

### Classes

| Name                   | Kind  | Signature                                                                                                                                                                              | Summary                                                                                                                                                                                                                                                                                     |
| ---------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Session`              | class | `new (id: string) => SessionInterface`                                                                                                                                                 | Represents a server-managed session's default entity — the `create` option's default value for `createSession`. It ships without a bare `create*` factory of its own, because the name `createSession` belongs to the battery; `createRestoredSession` rebuilds one from a stored snapshot. |
| `MemorySessionStore`   | class | `new <S extends SessionInterface>(options?: MemorySessionStoreOptions) => SessionStoreInterface<S>`                                                                                    | Implements the default in-process `SessionStoreInterface` — a `Map`-backed store enforcing both an idle timeout and an absolute lifetime, with lazy (read-time) eviction, a bounded capacity, and no background timers.                                                                     |
| `DatabaseSessionStore` | class | `new <S extends SessionInterface = Session>(table: TableInterface<SessionRow>, guard: Guard<S>, restore: SessionRestoreFunction, options?: SessionLimits) => SessionStoreInterface<S>` | Implements a durable `SessionStoreInterface` over an `@orkestrel/database` table — the same idle-timeout + absolute-lifetime contract as `MemorySessionStore`, backed by a caller-supplied `TableInterface` instead of an in-process `Map`.                                                 |

Multipart parsing has no entity row because it exposes no entity. The server source declares a
multipart lifecycle engine that `parseMultipartRequest` composes internally, and the barrel does not
export it: a consumer reaches every part of that behaviour through `parseMultipartRequest`, whose
result is a `MultipartBody`. `tests/guides.test.ts` names the class in its `INTERNAL` list, so the
omission is asserted rather than assumed, and adding it to the barrel would turn that assertion red.

### Factories

| Name                         | Kind     | Signature                                                                                                                                         | Summary                                                                                                                                                                                                     |
| ---------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createUploadedFile`         | function | `(input: UploadedFile) => UploadedFile`                                                                                                           | Builds a frozen `UploadedFile` record.                                                                                                                                                                      |
| `createCookieTransport`      | function | `(options: CookieTransportOptions) => SessionTransportInterface`                                                                                  | Creates a signed-cookie `SessionTransportInterface` — the session id travels as a `signToken`-signed cookie value.                                                                                          |
| `createHeaderTransport`      | function | `(options?: HeaderTransportOptions) => SessionTransportInterface`                                                                                 | Creates a bare-header `SessionTransportInterface` — the session id travels verbatim in a request/response header.                                                                                           |
| `createMemorySessionStore`   | function | `<S extends SessionInterface>(options?: MemorySessionStoreOptions) => SessionStoreInterface<S>`                                                   | Creates the default in-process `SessionStoreInterface` — a `Map`-backed store enforcing an idle timeout and an absolute lifetime.                                                                           |
| `createDatabaseSessionStore` | function | `<S extends SessionInterface = Session>(table: TableInterface<SessionRow>, guard: Guard<S>, options?: SessionLimits) => SessionStoreInterface<S>` | Creates a `DatabaseSessionStore` as a `SessionStoreInterface` — the durable counterpart to `createMemorySessionStore`, over a caller-opened `@orkestrel/database` table (declare it with `sessionColumns`). |
| `createRestoredSession`      | function | `(value: unknown) => Session \| undefined`                                                                                                        | Rebuilds a `Session` from an untrusted snapshot value — the inverse of `snapshotSession` and a durable store's `get` deserialization step.                                                                  |

### Errors

| Name               | Kind     | Signature                                                                                                        | Summary                                                                                                                                                                                                                   |
| ------------------ | -------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MultipartError`   | class    | `new (code: MultipartErrorCode, message: string, context?: Readonly<Record<string, unknown>>) => MultipartError` | Represents an error `createMultipart` throws when a streamed multipart request fails a mid-stream limit, is structurally malformed, or has a file whose sniffed bytes are rejected by the configured `allowed` MIME list. |
| `isMultipartError` | function | `(value: unknown) => value is MultipartError`                                                                    | Narrows an unknown caught value to a `MultipartError`.                                                                                                                                                                    |

## Methods

The public methods of `AssetSourceInterface`, `SessionInterface`,
`SessionControlInterface`, `SessionStoreInterface`, and
`SessionTransportInterface` — the behavioral seams the middleware factories
compose (their `readonly` data members, where any exist, stay Surface rows
in the preceding section).

The multipart guard requires an Error subclass with its own identity brand,
a declared code, a numeric status, and a context of the declared type. It accepts
subclasses across package copies and refuses transparent proxies and plain objects.

#### `AssetSourceInterface`

The in-memory lookup seam. `createAssets` validates a request key before it
calls `read`, copies each successful result, and caches that key for the
factory's lifetime. A miss may be read again later.

| Method | Returns                            | Summary                                                                         |
| ------ | ---------------------------------- | ------------------------------------------------------------------------------- |
| `read` | `AssetRepresentation \| undefined` | Reads one identity or Brotli asset representation for a validated relative key. |

#### `SessionInterface`

The session entity's own write seam. `state` is a `ReadonlyMap` view:
TypeScript refuses a write through it, and `set`, `delete`, and `clear` are
the write path.

| Method   | Returns   | Summary                                                  |
| -------- | --------- | -------------------------------------------------------- |
| `set`    | `void`    | Writes one key's value into the session's state.         |
| `delete` | `boolean` | Removes one key from the session's state.                |
| `clear`  | `void`    | Empties the state, leaving the session and its id alive. |

#### `SessionControlInterface`

`regenerate` is the OWASP anti-fixation primitive (rotate the id, keep the
state); `destroy` ends the session outright. Both record intent
synchronously; the store I/O and transport write happen after `next()`
returns (`destroy` supersedes a prior `regenerate`). `fresh` is `true` for a
session minted on this request, which the client holds no credential for
until a write or a `regenerate` persists it; `createCSRF` reads it to bind a
token to the battery's nonce instead.

| Method       | Returns | Summary                                                                           |
| ------------ | ------- | --------------------------------------------------------------------------------- |
| `regenerate` | `void`  | Mints a fresh id, carries the session's `state` over, and invalidates the old id. |
| `destroy`    | `void`  | Ends the session — deletes it from the store and clears its transport.            |

#### `SessionStoreInterface`

The pluggable point-access persistence seam — `get`/`set`/`delete`, every
primitive async with a trailing injected `now`. `set` reads the id from the
session it is handed, so no separate id is passed. `DatabaseSessionStore`
takes its snapshot rebuild step as a constructor argument, and
`createDatabaseSessionStore` supplies `createRestoredSession` as that step.

| Method   | Returns                   | Summary                                                                     |
| -------- | ------------------------- | --------------------------------------------------------------------------- |
| `get`    | `Promise<S \| undefined>` | Reads a session by id, applying the idle and absolute expiry against `now`. |
| `set`    | `Promise<void>`           | Persists a session under its own `id`, refreshing its idle window.          |
| `delete` | `Promise<void>`           | Removes a session by id — a no-op on an absent id, never throws.            |

#### `SessionTransportInterface`

How a session id travels to and from the client — `read` is total (never
throws); `write`/`clear` mutate the returned `Response` on the way out (the
returning onion makes "before send" automatic).

| Method  | Returns                               | Summary                                                                                                                    |
| ------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `read`  | `string \| undefined \| Promise<...>` | Reads the incoming session id from the request — `undefined` on any failure.                                               |
| `write` | `void \| Promise<void>`               | Writes a freshly minted or regenerated session id onto the response, together with the request's encrypted-transport fact. |
| `clear` | `void`                                | Clears the transport's credential on `destroy()`.                                                                          |

#### `LimiterStoreInterface`

| Method    | Returns                  | Summary                                                                   |
| --------- | ------------------------ | ------------------------------------------------------------------------- |
| `consume` | `Promise<LimiterResult>` | Checks and consumes a budget without interleaving its admission decision. |

#### `AssetStoreInterface`

| Method   | Returns                             | Summary                                         |
| -------- | ----------------------------------- | ----------------------------------------------- |
| `get`    | `Promise<AssetRecord \| undefined>` | Reads a cached representation by key.           |
| `set`    | `Promise<void>`                     | Stores a representation under its own key.      |
| `delete` | `Promise<void>`                     | Removes a cached key; an absent key is a no-op. |

## Contract

These invariants hold across `src/server` ↔ `middleware.md`.

1. **Guide ↔ source bijection.** Every `function` / `class` / `interface` /
   `type` / `const` row in the `## Surface` tables is a real export of its
   source directory, and every export appears as a Surface row — exhaustive,
   both directions.
2. **Guide ↔ source method bijection.** The `## Methods` tables list exactly
   `AssetSourceInterface`'s, `SessionInterface`'s, `SessionControlInterface`'s,
   `SessionStoreInterface`'s, and `SessionTransportInterface`'s public methods —
   exhaustive, both directions.

### The ordering doctrine

The canonical onion, outermost first, is `createTelemetry`, `createNodeCompression`,
`createSecurity`, `createCORS`, `createBoundary`, `createDeadline`, `createForwarded`,
`createETag`, `createBearer`, `createLimiter`, `createBody`, `createSession`, and `createCSRF`.
Before 0.0.35, the canonical onion mounted `createCompression` where it mounts
`createNodeCompression`, and placed `createSecurity` and `createCORS` inside `createBoundary` and
`createDeadline`, so an error the boundary rendered from a throw, and the deadline's answer,
carried no security headers and no `Vary: Origin`. Each item names a position and the failure it
prevents:

3. **`createTelemetry` is outermost.** It sees the mapped status (after
   `createBoundary` renders) and measures honest wall-clock duration —
   anything mounted inside it would be excluded from the timing.
4. **Compression sits outside `createBoundary`.** An error `Response`
   the boundary renders from a caught throw still passes through
   compression — mount it inside instead and error bodies ship uncompressed.
   Compression leaves a `206` response and a response whose `Cache-Control` carries
   `no-transform` identity-coded (`matchesUntransformableResponse`), because the
   `Content-Range` of a `206` counts bytes of the identity representation; before
   0.0.35 it compressed both. Mount `createNodeCompression`, as the canonical
   onion does, and mount `createCompression` only on a host without
   `node:zlib`: in the kernel readings of 2026-11-16 on middleware 0.0.33 and
   Node 22.23.5, gzip through `CompressionStream` took 542 µs per 1 KiB
   response against 327 µs through `node:zlib`, and 815 µs against 617 µs at
   64 KiB.
5. **`createBoundary` is the renderer.** Everything mounted beneath it may
   throw `HTTPError` (or anything else) and have it mapped to a `Response`;
   nothing below it needs its own try/catch.
6. **`createDeadline` sits inside the boundary.** A deadline that fires calls
   `context.abort(reason)`, answers `status` with no body, and discards
   whatever the downstream returns or throws after that. Inside the boundary,
   a throw a handler raises on the aborted `signal` stops at the deadline;
   mounted outside, the boundary beneath it reports that throw as a fault. The
   battery builds no `Request`, so it composes with `createBody` in either
   order.
7. **`createSecurity` sits outside `createBoundary` and `createDeadline`.**
   Every response then carries the security headers: a returned response, a
   redirect, an error the boundary renders from a throw, and the deadline's
   answer. Mounted inside the boundary, `createSecurity`'s `next()` never
   resolves for a throw beneath it, so the rendered error ships without the
   headers.
8. **`createCORS` sits outside `createBoundary` and `createDeadline`.** In
   list mode every response then carries `Vary: Origin`, an error the
   boundary renders from a throw and the deadline's answer included, so a
   shared cache never serves one origin's answer to another. Its preflight
   answer runs before the terminal `Dispatcher.handle` sees the `OPTIONS`
   request, so it claims a preflight before the dispatcher's automatic
   `OPTIONS`.
9. **`createForwarded` resolves client facts before anything keys off
   them.** `createLimiter`'s default key and any session/telemetry logic
   that wants `ClientState.client.ip` must run downstream of it. It reads
   `X-Forwarded-For` only and ignores a `Forwarded` header. With
   `proxies: N`, each of the `N` proxies appends one hop, and the client is
   the hop at index `length − N`: `proxies: 1` behind one appending proxy
   resolves the rightmost hop, the address that proxy saw. A header with fewer
   than `N` hops resolves the socket peer. `proxies` fits only when every
   request arrives through exactly `N` proxies, because a request that reaches
   the server directly names its own client. With `trusted`, the walk starts
   at the socket peer, `context.connection.ip`, and moves left through every
   address the roster matches; the first address outside the roster is the
   client. An untrusted socket peer is the client, whatever its header says,
   and when the peer and every hop match, the leftmost hop is the client.
   The roster compares an IPv4-mapped address (`::ffff:10.0.0.6`, which Node
   reports for an IPv4 client on a dual-stack listener) by its embedded IPv4,
   and reads an IPv4 address only as four decimal octets from 0 to 255, so a
   hop such as `0x0a.0.0.1` matches no IPv4 entry. The resolved address is not
   validated: it is the peer or the hop as written, so a malformed hop, a hop
   with a port (`198.51.100.66:4711`), or an IPv4-mapped hop resolves
   unchanged. Before 0.0.35, `proxies: 1` resolved the hop left of the
   rightmost one, and `trusted` began its walk at the rightmost hop instead of
   the socket peer.
10. **`createETag` sits inside compression.** The hash is computed
    over the uncompressed representation — hashing the compressed bytes
    would break revalidation the instant the negotiated coding changes.
    Behind compression, a strong tag on a coded body gains `W/`, because one
    tag across two codings is no strong validator (RFC 9110 § 8.8.1), and the
    weak tag still revalidates. A `304` carries the tag and the `Vary` header
    that the `200` response would have carried. The `304` that `createETag` answers states the
    length of the `200` body it stands for, and compression drops that length
    from a `304` whose `200` it would code. Before 0.0.35, a coded body kept
    its strong tag, a `304` passed compression with the strong tag and no
    `Vary: Accept-Encoding`, and the `304` that `createETag` answered carried
    no `Content-Length`.
11. **`createBearer` sits before `createLimiter`.** The limiter's default key
    derivation prefers a string `BearerState.token` (the `token:<value>` idiom)
    over a client-IP fallback — bearer must have already stashed it. An object
    credential never keys the limiter: the key falls through to the client address.
12. **`createBody` sits before `createSession`/`createCSRF`.** `createSession`'s
    async `mint` and `createCSRF`'s `_csrf` body-field read both need the
    cached `context.body()` already resolved.
13. **`createSession` sits before `createCSRF`.** CSRF's session-binding —
    the security acceptance bar's CSRF item — requires `context.state.session`
    and `context.state.control` to already be stashed.

### The security acceptance bar, as documented behavior

14. **CORS.** In list mode `Vary: Origin` is merged on every response and
    preflight, from an allowed origin, a disallowed origin, or no `Origin`
    alike, and never in `'*'` wildcard or fixed-string mode. A preflight from a
    disallowed origin, or with no `Origin`, answers `204` with `Vary: Origin`
    and no `Access-Control-*` header. The literal `Origin: null` is never
    reflected even when the string `'null'` is allow-listed. Before 0.0.35,
    list mode merged `Vary: Origin` only for an allowed origin, every preflight
    carried `Access-Control-Allow-Methods` and `Access-Control-Allow-Headers`,
    and the battery and its options were named `createCors` and `CorsOptions`.
15. **Headers.** A malformed `X-Request-ID` (off-charset, oversize, or
    CRLF-bearing) is never echoed — `createSecurity` mints a fresh
    `crypto.randomUUID()` instead; a custom `csp` string replaces the
    default wholesale (never merges); `X-Content-Type-Options: nosniff` is
    unconditional, with no opt-out.
16. **Bearer.** `createBearer` returns a `401` for a missing, wrong-scheme, or empty token
    and for a credential `verify` refuses, and a throw from `verify` propagates
    unchanged. With `verify: (token) => verifyToken(token, signer)`, `verifyToken` is
    total over garbage, tampered, or expired input — every failure
    renders `401`, never a crash; the signer that the `createSigner` function of
    `@orkestrel/server` returns compares signature bytes only through `timingSafeEqual`. The `401` is a returned response, so each outer
    battery decorates it and `createBoundary`'s `report` never sees it; read
    refusals from `createTelemetry`'s status.
17. **Limiter.** The key derivation never reads `X-Forwarded-For` itself (only
    `createForwarded`'s already-resolved `ClientState` does, when mounted) —
    so an unmounted `createForwarded` leaves XFF completely untrusted;
    same-socket requests with different XFF values still share one bucket
    without it; IPv6 addresses collapse to their `/64` network through
    `computeClientKey`; the exhausted check runs before `consume`, admitting
    exactly `max` requests per window; capacity eviction is true LRU — every
    access (not only insertion) refreshes a key's recency, so an attacker
    re-requesting a hot key can never keep it evicted-and-reset; a bucket
    evicted for capacity invokes the optional `evict` sink (throw-isolated).
18. **Body.** `createBody` maps a malformed-JSON `undefined` resolution to a
    `400`; the size/decompression caps and the `__proto__`/`constructor`/
    `prototype` scrub are the substrate's own `readBody` behavior
    (`ServerOptions.limit`) — this battery only drives the cache eagerly and
    maps its outcomes.
19. **Session.** `createSession` stores a session, and writes its
    credential, only after a handler writes to it or regenerates it. A write
    is a `set`, `delete`, or `clear` that leaves the state holding other keys,
    or other values by `Object.is`, than it held when the handler started; a
    `set` of the value a key already holds is none, so replace a value rather
    than changing it in place when the store is durable. A request with no
    credential gets a session with `control.fresh` true, and when the handler
    writes nothing, the store and the response carry no trace of it: a flood
    of such requests leaves every written session in place. Since 0.0.35 the
    session cookie first appears on the response to the first write, where
    earlier releases set it on the first response. The default `MemorySessionStore` enforces both an idle
    timeout (`ttl`, lazy eviction on `get`) and an absolute lifetime
    (`lifetime`, evicting even a continuously-touched session — `created`
    is stamped once at first `set` and preserved across every later
    re-persist); it is also capacity-capped (`capacity`, default
    `DEFAULT_SESSION_CAPACITY`) and evicts the least recently used id —
    every `set` and every live `get` refreshes recency — in time that does
    not grow with the store's size, invoking the optional
    `evict` sink (throw-isolated) on a capacity eviction or an expired read,
    but never for an explicit `delete`; `control.regenerate()` rotates the id while carrying the
    session's `state` over and invalidating the old id; a signed cookie
    transport inherits the full substrate injection-hardening matrix
    (`__Host-` spoof rejection, `Domain`/`Path` injection throws,
    `SameSite=None` forces `Secure`, `Secure` derived from the connection's
    TLS fact when omitted). The battery installs no route of its own: it
    answers `404` when `required` is set and no session resolves or mints, and
    a consumer ending a session on `DELETE` mounts its own handler over
    `control.destroy()`.
20. **CSRF.** A token is `random.signature`, where `signature` is the
    signer's HMAC over `CSRF_LABEL`, a binding, and `random`
    (`signCSRFToken`), OWASP's signed double submit; it carries no form of the
    binding. While the client holds a session (`state.session` with
    `control.fresh` not true), the binding is the session id and the battery
    writes no cookie, so a token minted under session A is `403` under
    session B, and a nonce-bound token is `403` beside a session even with its
    nonce cookie. While it holds none, the binding is the battery's own nonce:
    a safe request without a valid nonce cookie mints one and sets it
    HttpOnly, `SameSite=Lax`, and `Path=/` under `cookie`. Every request that
    passes, safe or mutating, stashes a fresh token bound to the binding it
    arrived with on `state.csrf`, so every tab's token verifies while the
    session or the nonce holds. A mutating request submits its token in
    `header`, or in `field` of an `application/json` or
    `application/x-www-form-urlencoded` body; the battery reads no other body,
    so a multipart form sends its token in the header, and its stream stays
    unread for `createMultipart`. The token format changed in 0.0.35: a token
    an earlier release issued stops verifying at the upgrade, so a page
    rendered before it must reload before its next write. Before 0.0.35, the
    `signToken` function signed the session id, or a random value without a
    session, into the token, and every safe response wrote that token into a
    script-readable cookie named by the `cookie` option, which a mutating
    request's token had to equal. A handler that
    starts a session (the first write to a fresh one), regenerates it, or
    destroys it changes the binding: `state.csrf` in that handler holds a
    token bound to the binding the request arrived with, and tokens minted
    earlier stop verifying under the new one. Such a handler answers with a
    redirect; § CSRF: redirect after a session change states the contract.
    Before 0.0.35, the battery re-minted the token for a regenerated session,
    and cleared it for a destroyed one, on the handler's own response.
21. **Static.** Every served response is opened as a `FileHandle` and its
    headers (`Content-Length`/`ETag`) are computed from that same handle's
    `fstat` — the bytes `streamFile` later reads can never diverge from the
    headers already sent, closing the stat-to-stream TOCTOU. The traversal
    guard's algorithm order is load-bearing —
    strip `prefix` on a segment boundary, `decodeURIComponent` (refusing
    malformed escapes), reject NUL, make relative before `normalize` (so a
    leading `..` survives as a climbing segment), `normalize`, refuse a
    Windows reserved-device segment (`NUL.json` refused, `nullable.css`
    served), then `resolve` under `root` and require containment; a
    multi-range or malformed `Range` header serves the full body (`200`),
    never a partial guess; the SPA fallback shell path is a fixed,
    non-user-controlled join — never re-run through the traversal resolver.
    A `Range` under any `If-Range` serves the full `200`, because no validator
    the battery sends compares strongly. A `prefix` and a fallback `exclude`
    hold one slash law: each compares case-sensitively, one trailing slash on
    it is optional, so `/static/` covers `/static`, and it covers a path
    beneath it only on a segment boundary. Before 0.0.35, a `Range` under
    `If-Range` answered `206` whatever the validator, and a `prefix` or an
    `exclude` written `/static/` did not cover `/static`.
22. **Assets.** `createAssets` decodes a browser-relative key and refuses
    malformed escapes, backslashes, empty segments, `.`/`..`, and dotfiles
    before it calls `AssetSourceInterface.read`. A successful value is copied
    and cached through the configured store. Concurrent misses can decompress
    and hash the same key independently. Brotli and identity share
    the identity body's `computeBodyETag` validator and vary on
    `Accept-Encoding`. Gzip is not offered. `Range` is ignored and serves the
    selected complete representation as `200`.
23. **Multipart.** Type rejection applies only when `allowed` is configured:
    a file whose sniffed (magic-byte) bytes detect no type on that list is
    rejected `415`, and a signature-less file is always rejected because
    sniffing cannot place it on the list. A declared `Content-Type`
    disagreeing with the sniffed type is reported as `validated: false` and
    is never rejected on its own — with no `allowed` list, a disagreement
    produces a normal response. Staged temp filenames are `randomUUID()`, never
    derived from the client-declared filename (traversal-by-filename is
    impossible by construction); every limit trips mid-stream with already-
    staged files cleaned up; a mid-upload client disconnect triggers the
    same fail-closed cleanup; a preamble longer than
    `MULTIPART_MAX_PREAMBLE` before the first boundary is rejected
    `'malformed'` rather than scanned unbounded; an empty-filename part
    with a zero-byte body (a file input submitted with no file chosen) is a
    no-op — staged then discarded, never counted against `limits.file.count`,
    never surfaced as an upload; staged files default to a
    process-owned `mkdtemp` directory under `os.tmpdir()` locked to mode
    `0o700`, with each staged file opened at mode `0o600` (both overridable
    through `options.directory`). A file the `allowed` list refuses is
    refused before a byte of it is staged. A boundary longer than
    `MULTIPART_MAX_BOUNDARY` is refused `400` as malformed. A header block
    exactly at `MULTIPART_MAX_HEADER_BLOCK` is admitted however its chunks
    arrive. When the handler settles, by a return or a throw, `createMultipart`
    unlinks every file still at its staged path, so a handler moves or reads
    each file it keeps before it returns. Before 0.0.35, a normal return left
    staged files on disk, a file the `allowed` list refused was written to disk
    first, a boundary of any length was taken, and that header block was
    refused when it arrived in small chunks.
24. **Boundary.** `expose: false` leaks nothing (a non-`HTTPError` throw's
    message never reaches the body); an `HTTPError`'s own `message` always
    surfaces (it is the handler's deliberate signal); a `report` sink's own
    throw is swallowed and can never alter the response.
25. **`only`/`except` match through the router's path grammar.** Each path
    is a route pattern compiled by `@orkestrel/router`'s `compilePath` and
    matched against `context.url.pathname` by its `matchPath`. A pattern
    matches case-sensitively whatever the dispatcher's `sensitive` option, with
    one trailing slash optional, so `/admin` covers `/admin` and `/admin/`.
    Under `createDispatcher({ sensitive: false })`, a case variant such as
    `/ADMIN` dispatches to the `/admin` route, but it falls outside
    `only('/admin', …)`, which skips its battery, and inside
    `except('/admin', …)`, which runs it. A
    pattern covers no path beneath it: `/admin` does not cover `/admin/users`.
    To scope a subtree, list `/admin` and `/admin/*rest`; a `*name` wildcard
    matches one or more characters across segments and must be the final
    segment, and `:name` matches one segment. A wildcard before the final
    segment refuses at construction with a `ContractError`. Before 0.0.35,
    both compared the pathname by string equality, so `/admin/` fell outside
    `only('/admin', …)` while the router still dispatched it. Prefer
    `except()` for security batteries (CSRF, bearer, rate limiting): an
    unlisted path still gets the battery, where an unlisted path under
    `only()` goes without it. Keep the pattern set in lockstep with the
    router's routes, because a route added later and left out of the set is
    unscoped.
26. **Challenge.** Every `401` `createBearer` returns carries a `WWW-Authenticate`
    challenge (RFC 9110 § 15.5.2). A missing, wrong-scheme, or empty token renders
    the configured `challenge` auth-params, and a refused credential adds
    `error="invalid_token"` (RFC 6750 § 3). `renderChallenge` refuses a scheme or
    parameter name that is not a `token`, two names that match ignoring case, and a
    value outside `%x20-21 / %x23-5B / %x5D-7E`; it never escapes or strips. `createBearer`
    refuses a `challenge` that names `error` at construction, because the battery
    owns that parameter.

## Patterns

### Canonical onion — over `compose`

The full ordering doctrine, composed directly over `compose` (no `@orkestrel/server`
`Server` required — these batteries read and return `Request` and `Response`):

```ts
import {
	createBearer,
	createBody,
	createBoundary,
	createCORS,
	createCSRF,
	createDeadline,
	createETag,
	createForwarded,
	createLimiter,
	createNodeCompression,
	createSecurity,
	createSession,
	createTelemetry,
	createCookieTransport,
} from '@orkestrel/middleware'
import type {
	BearerState,
	ClientState,
	CSRFState,
	IdentifierState,
	SessionState,
} from '@orkestrel/middleware'
import { compose, createSigner, verifyToken } from '@orkestrel/server'

interface State extends BearerState, ClientState, CSRFState, IdentifierState, SessionState {}

const signer = createSigner('shh')
const onion = [
	createTelemetry({ record: (entry) => console.log(entry) }),
	createNodeCompression(),
	createSecurity({ hsts: true }),
	createCORS({ origin: ['https://app.example'] }),
	createBoundary({ expose: false }),
	createDeadline({ ms: 5_000 }),
	createForwarded({ proxies: 1 }),
	createETag(),
	createBearer({ verify: (token) => verifyToken(token, signer) }),
	createLimiter({ max: 100, window: 60_000 }),
	createBody(),
	createSession({ transport: createCookieTransport({ signer }) }),
	createCSRF({ signer }),
]

const handle = compose<State>(onion, async (_request, context) => {
	return Response.json({ session: context.state.session?.id })
})
```

### Canonical onion — behind `@orkestrel/server`

The fence hands the same chain to `createServer` as its `middleware` option, so the server owns the listening socket and the dispatcher the chain terminates in. The batteries read connection facts (`ip`, `encrypted`) from `context.connection`, so the `state: () => ({})` factory carries none, and each calls `next()` with no argument.

```ts
import { createBoundary, createSecurity } from '@orkestrel/middleware'
import type { IdentifierState } from '@orkestrel/middleware'
import { createServer } from '@orkestrel/server'
import { createDispatcher } from '@orkestrel/router'

interface State extends IdentifierState {}

const dispatcher = createDispatcher<State>()
dispatcher.add({ method: 'GET', path: '/health', handler: () => new Response('ok') })

const server = createServer<State>({
	dispatcher,
	state: () => ({}),
	middleware: [createSecurity(), createBoundary()],
})
const port = await server.start()
await server.stop()
```

### Body: eager cache drive

The fence constructs the body battery with no options of its own.

```ts
import { createBody } from '@orkestrel/middleware'

const body = createBody() // no options — the seam's context.body() owns limits
```

`createBody` stashes a defined resolved value on `context.state.body` (and
leaves the optional property absent when resolution yields `undefined`), so its
`TState` must extend `BodyState`. Zero-annotation usage (`createBody()`) infers
`BodyState` by default. An explicitly-typed chain state
(`createBody<SomeState>()`) must include the `BodyState` slice —
`SomeState & BodyState`, or `SomeState` extending `BodyState` — unless it
already carries a `body` field.

### Session: control handle, header transport, injected store

The fence wires the session battery to a header transport and an injected memory store, then rotates and ends the session through the control handle a downstream handler reads.

```ts
import {
	createHeaderTransport,
	createMemorySessionStore,
	createSession,
} from '@orkestrel/middleware'
import type { SessionState } from '@orkestrel/middleware'

interface State extends SessionState {}

const store = createMemorySessionStore({ ttl: 900_000, lifetime: 86_400_000 })
const session = createSession<import('@orkestrel/middleware').SessionInterface, State>({
	transport: createHeaderTransport({ header: 'session-id' }),
	store,
	mint: () => true,
})

// Inside a handler downstream of `session`:
declare const context: { readonly state: State }
context.state.session?.set('user', 'u_1') // the first write stores the session and writes its id
context.state.control?.regenerate() // rotate the id after a privilege change (anti-fixation)
context.state.control?.destroy() // end the session outright
```

A request with no credential reaches the handler with a session whose `control.fresh` is
`true`. The battery stores it, and the transport writes its id, only after the handler writes
to it or regenerates it, so the session header or cookie first appears on the response to that
write. A request that reads a session and writes nothing leaves the store untouched beyond the
store's own `get`.

### Session store seam — direct calls

The fence drives a memory store's `set`, `get`, and `delete` methods directly, with no middleware chain around them.

```ts
import { createMemorySessionStore } from '@orkestrel/middleware'
import { Session } from '@orkestrel/middleware'

const store = createMemorySessionStore({ ttl: 60_000 })
const now = Date.now()
await store.set(new Session('id-1'), now)
await store.get('id-1', now) // resolves the session, or undefined if expired
await store.delete('id-1') // no-op on an already-absent id
```

### Session store seam — durable database-backed store

The `@orkestrel/database` peer is optional and type-only inside this
package's `src` — a memory-only consumer installs nothing extra. An app that
wants durable sessions installs `@orkestrel/database` itself, declares a
table with `sessionColumns`, and passes the open table + a guard to
`createDatabaseSessionStore`:

```ts
import {
	createDatabaseSessionStore,
	isSession,
	Session,
	sessionColumns,
} from '@orkestrel/middleware'
import { createDatabase, createMemoryDriver } from '@orkestrel/database'

const db = createDatabase({ driver: createMemoryDriver(), tables: { sessions: sessionColumns } })
const store = createDatabaseSessionStore(db.table('sessions'), isSession, { ttl: 900_000 })
const now = Date.now()
await store.set(new Session('id-1'), now)
await store.get('id-1', now) // resolves the session, or undefined if expired/removed
```

The `session` column holds the `SessionSnapshot` JSON that `snapshotSession`
writes and `createRestoredSession` reads back: `{ id, state }`, where `state`
carries the session's entries. The cursor columns are `seen` and `created`. A
table still declared with the earlier `lastSeen` and `createdAt` columns fails
closed rather than reading a stale row as live: the table raises a `DRIVER`
`DatabaseError` for a row that does not satisfy `sessionColumns`, `store.get`
and `store.set` reject with it, and the row stays in place until the table is
migrated or recreated.

### Session transport seam — direct calls

The fence drives a header transport's `read`, `write`, and `clear` methods over a real `Request` and `Response`.

```ts
import { createHeaderTransport } from '@orkestrel/middleware'

const transport = createHeaderTransport()
const request = new Request('https://x', { headers: { 'session-id': 'abc' } })
await transport.read(request) // 'abc'
const response = new Response('ok')
await transport.write(response, 'abc', false) // sets the session-id header
transport.clear(response) // removes it
```

### CSRF: signed double submit over one signer

The fence mounts the CSRF battery behind a cookie-transport session, which binds each token a held session mints to that session's id.

```ts
import { createCSRF, createSession, createCookieTransport } from '@orkestrel/middleware'
import { createSigner } from '@orkestrel/server'
import type { CSRFState, SessionState } from '@orkestrel/middleware'

interface State extends SessionState, CSRFState {}

const signer = createSigner(['current-secret', 'previous-secret'])
const session = createSession<import('@orkestrel/middleware').SessionInterface, State>({
	transport: createCookieTransport({ signer }),
})
const csrf = createCSRF({ signer }) // session ahead binds the token to its id
```

No option takes a secret. `CookieTransportOptions.signer` and `CSRFOptions.signer` each take a
`SignerInterface`, and a bag that still carries `secret` refuses as an undeclared key. Create the
signer once per secret list with `createSigner` from `@orkestrel/server` and share it between the
batteries: `createSigner` creates every key at that call, so no request imports a key. One signer
is safe for both because a CSRF message opens with `CSRF_LABEL`, which no `signToken` payload can
equal, and a CSRF token sent as the session cookie resolves no session.

### CSRF: redirect after a session change

A handler that starts a session (the first write to a fresh one), regenerates it, or destroys it
answers with a redirect to a page, such as a `303` to `/account`. The tokens the client holds
were bound to the session or nonce the request arrived with, and `state.csrf` in that handler
still is; the page the redirect loads renders a token bound to the session or nonce the client
then holds.

```ts
import type { CSRFState, SessionState } from '@orkestrel/middleware'

declare const context: { readonly url: URL; readonly state: SessionState & CSRFState }
context.state.control?.regenerate() // after a login check passes
const response = Response.redirect(new URL('/account', context.url), 303)
```

### Multipart: node face, sniffed-type allow-list

The fence mounts the node-face multipart battery with a sniffed-type allow-list and narrows its parsed result on `context.state` through the shipped guards.

```ts
import { createMultipart } from '@orkestrel/middleware'
import { isMultipartBody, isMultipartFile } from '@orkestrel/middleware'
import type { MultipartState } from '@orkestrel/middleware'

interface State extends MultipartState {}

const uploads = createMultipart<State>({ allowed: ['image/png', 'image/jpeg'] })

declare const context: { readonly state: State }
if (isMultipartBody(context.state.multipart)) {
	context.state.multipart.files // narrowed, ready to stream/read/move
	for (const files of Object.values(context.state.multipart.files)) {
		files.every((file) => isMultipartFile(file)) // true — every entry is a staged MultipartFile
	}
}
```

### Multipart limits — direct resolution

The fence resolves one partial limits input into the effective caps, with no battery around it.

```ts
import { resolveMultipartLimits } from '@orkestrel/middleware'

resolveMultipartLimits({ file: { size: 1_048_576 } }) // fills in every other default cap
```

Multipart processing reports no progress.

### Assets: in-memory source

The fence implements an `AssetSourceInterface` over a single in-memory entry and hands it to `createAssets`.

```ts
import type { AssetSourceInterface } from '@orkestrel/middleware'
import { createAssets } from '@orkestrel/middleware'

const source: AssetSourceInterface = {
	read(path) {
		return path === 'index.html'
			? { body: new TextEncoder().encode('<!doctype html><title>App</title>') }
			: undefined
	},
}

const serveAssets = createAssets({ source })
```

Return `{ body, encoding: 'br' }` when `body` contains Brotli bytes.
`createAssets` keeps those bytes for Brotli clients and caches one identity
decompression for every other client. Both responses share an identity-body
ETag. Gzip is not offered.

`read` must answer a bounded key set and return `undefined` for every key
outside it. `createAssets` retains every successful result for the factory's
lifetime and evicts nothing, so a `read` that synthesizes a representation for
an arbitrary key grows that cache without limit under request pressure. A miss
is never retained, so an absent key is read again on its next request.

### Static: SPA fallback

The fence serves a directory over `node:fs` with the SPA fallback on, which answers an eligible miss with the shell.

```ts
import { createStatic } from '@orkestrel/middleware'

const serveApp = createStatic({ root: '/srv/public', fallback: true }) // excludes '/api' by default
```

An eligible miss is a `GET` or `HEAD` request for an extensionless pathname
outside the excluded prefix whose `Accept` admits `text/html`. It answers with
`index` through the same opened-handle `fstat` header block a directly
requested file answers through. `Cache-Control`, `ETag`, `Content-Length`, and
`Accept-Ranges` therefore carry the shell's own facts, `If-None-Match`
revalidates to `304`, and `Range` serves `206` — identically on both routes. A
`HEAD` navigation resolves the same shell as its `GET` and answers `200` with
those headers and no body.

The shell path is a fixed `root`-plus-`index` join rather than a request-derived
path, so the `dotfiles` policy screens the request pathname alone. A dotfile
`index` is refused when it is requested directly under `dotfiles: 'deny'` and is
still served through the fallback, because the operator configured that path.

### Seam adaptations — read before wiring sessions or multipart

- **`createBody` carries no `limit`/`decompression` options.** The shipped
  `MiddlewareContext.body()` is a parameterless, server-owned cache
  (`ServerOptions.limit` governs its size cap) — this battery eagerly
  awaits it and maps its outcomes (a `ContentTooLargeError`/`HTTPError`
  propagates untouched; `undefined` under a declared `application/json`
  maps to `400`).
- **`createMultipart` consumes `request.body` as a stream — never
  `context.body()`.** Its parsed result is stashed on
  `context.state.multipart`, narrowed with `isMultipartBody`. After it
  runs, `context.body()` must not be called for that request — the
  underlying stream is exhausted.
- **`SessionTransportInterface.write`/`clear` mutate the returned `Response` on the
  way out.** `createSession` applies store I/O and transport writes after
  `next()` resolves: `destroy()` → `store.delete` + `transport.clear`;
  `regenerate()` → `store.set` the new session, `store.delete` the old,
  `transport.write` the new id; otherwise, after a write → `store.set` the
  resolved or minted session, `transport.write` only when it was minted on
  this request; otherwise nothing. `destroy()` supersedes a prior
  `regenerate()`.

### Admission: option bags admitted whole

Every factory admits its options bag whole through the strict `admitValue` function of `@orkestrel/contract`, against the compiled contract its options interface declares, before it reads a default. The store classes `MemorySessionStore`, `MemoryLimiterStore`, and `DatabaseSessionStore` admit in their constructors, so a direct `new` call and the factory refuse alike, and their messages lead with the class name. A bag must be a plain object: a class instance, an array, `null`, and a primitive refuse. A bag refuses on an undeclared key such as `origins` for `createCORS`, on a missing required key, on a wrong type, on an explicit `undefined`, and on a number outside its range; a `status` lies from 200 through 599, a `ms` is an integer from 1 through 2147483647 (the range `@orkestrel/timeout` enforces), a size is a non-negative finite number, a count is a non-negative integer, and `NaN` refuses everywhere. An absent bag (`undefined`) admits as `{}`, so a factory with a required key refuses it at that key.

Each refusal is a `ContractError`, and the message leads with the factory name. A refusal from `admitOptions` reports the first fault's path in `context.path`, every fault in `cause`, and, for an undeclared key, the declared keys in the message. `createForwarded` admits a union of its two forms, so its refusal carries the root path `[]` and a message that lists both forms. A foreign-key check (`admitForeign`) reports the key as `context.path`, such as `['store']`, with a message of the form `createSession: options.store must be an object with function members get, set, delete`. `renderChallenge` and the `createBearer` refusal of a `challenge` that names `error` report `['scheme']` or `['challenge', name]` as `context.path`, and carry no `cause`.

An implementation key (`LimiterOptions.store`, `SessionOptions.transport`, `SessionOptions.store`, `CookieTransportOptions.signer`, `CSRFOptions.signer`, `AssetOptions.source`, and `AssetOptions.store`) is a foreign contract. The bag's contract carries it as present or absent, and `admitForeign` then checks each member the published interface declares, accepts a class instance and unknown members, and refuses a value that is not an object with every declared member a function, with a `ContractError` at the key. It reports the first implementation key that fails, in one sentence that names every member the interface declares, such as `get, set, delete`; it neither names the member that failed nor reports a fault for each member. The `cookie` record of `CookieTransportOptions` is an owned plain record the caller writes: the bag's contract admits its six members (`path`, `domain`, `maxAge`, `httpOnly`, `secure`, `sameSite`) and refuses any other key, so `maxage` refuses. `maxAge` is a finite number because a non-finite value writes `Max-Age=NaN` or `Max-Age=Infinity` into `Set-Cookie`.

```ts
import {
	admitForeign,
	admitOptions,
	buildForeignContract,
	CORS_CONTRACT,
	DEADLINE_CONTRACT,
} from '@orkestrel/middleware'

admitOptions('createCORS', CORS_CONTRACT, { origin: ['https://app.example'] }) // returns
admitOptions('createCORS', CORS_CONTRACT, { origins: ['https://app.example'] }) // throws a ContractError at ['origins']
admitOptions('createDeadline', DEADLINE_CONTRACT, { ms: 1_000, status: 1000 }) // throws a ContractError at ['status']

const store = buildForeignContract(['get', 'set', 'delete'])
admitForeign('createSession', ['store'], store, new Map()) // returns: a class instance with the members
admitForeign('createSession', ['store'], store, {}) // throws a ContractError at ['store']
```

### Practices

- **Mount `createTelemetry` and `createCompression` outside `createBoundary`**
  — error bodies still compress, and duration still measures the whole
  onion (Contract §3–4).
- **Mount `createForwarded` before anything that keys off `ClientState`** —
  `createLimiter`'s default key and any client-IP-sensitive logic
  downstream (Contract §9).
- **Never derive a rate-limit key from `X-Forwarded-For` yourself** — mount
  `createForwarded` and let its resolved `ClientState` do it (Contract §17).
- **Call `control.regenerate()` on every privilege change** (login,
  elevation) — the OWASP anti-fixation requirement session-based auth
  depends on.
- **Install a `report` sink on `createBoundary`** for observability — its
  own throw is swallowed, so it can never crash a response.

### Session control intent

```ts
import { Session, SessionControl } from '@orkestrel/middleware'

const control = new SessionControl(new Session('original'))
console.log(control.fresh) // false
control.regenerate()
console.log(control.successor?.id)
control.destroy()
console.log(control.destroyed) // true
```

### Atomic limiter store

A fresh window takes the current maximum and duration. An active window retains
its budget. Share a store when middleware instances must enforce the same quota.

```ts
import { createBudget } from '@orkestrel/budget'
import { createLimiter, createMemoryLimiterStore, MemoryLimiterStore } from '@orkestrel/middleware'
import type {
	LimiterEntry,
	LimiterLimits,
	LimiterResult,
	LimiterStoreInterface,
	MemoryLimiterStoreOptions,
} from '@orkestrel/middleware'

const options: MemoryLimiterStoreOptions = { capacity: 100 }
const store: LimiterStoreInterface = createMemoryLimiterStore(options)
const limits: LimiterLimits = { max: 3, window: 1000 }
const result: LimiterResult = await store.consume('client', Date.now(), limits)
const entry: LimiterEntry = {
	budget: createBudget({ max: limits.max, consumer: Number }),
	expiry: result.expiry,
}
const limiter = createLimiter({ ...limits, store })
console.log(result.admitted, entry.expiry, limiter, new MemoryLimiterStore(options))
```

### Asset store and response stages

The default store retains successful records until replacement or deletion.
Concurrent cache misses can read, decompress, and hash the same key independently.

```ts
import {
	buildAssetResponse,
	createAssets,
	createMemoryAssetStore,
	MemoryAssetStore,
	readAssetRecord,
	resolveAssetKey,
} from '@orkestrel/middleware'
import type { AssetRecord, AssetSourceInterface, AssetStoreInterface } from '@orkestrel/middleware'

const source: AssetSourceInterface = {
	read: (path) =>
		path === 'index.html' ? { body: new TextEncoder().encode('<h1>Home</h1>') } : undefined,
}
const store: AssetStoreInterface = createMemoryAssetStore()
const key = resolveAssetKey('/')
const record: AssetRecord | undefined =
	key === undefined ? undefined : await readAssetRecord(source, key)
if (record !== undefined) {
	await store.set(record)
	console.log(await store.get(record.key))
	console.log(buildAssetResponse(new Request('https://example.test/'), 'HEAD', record))
	await store.delete(record.key)
}
console.log(createAssets({ source, store }), new MemoryAssetStore())
```

### Static file response stages

The opened handle supplies response metadata. Close it after a bodiless response;
a streamed response transfers ownership to `streamFile`.

```ts
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { openStaticFile, planStaticResponse, resolveStaticFile } from '@orkestrel/middleware'
import type { StaticFile, StaticPlan } from '@orkestrel/middleware'

const root = await realpath('./public')
const path = await resolveStaticFile(join(root, 'index.html'), root, 'index.html')
const file: StaticFile | undefined = path === undefined ? undefined : await openStaticFile(path)
if (file !== undefined) {
	try {
		const plan: StaticPlan = planStaticResponse(
			new Request('https://example.test/', { method: 'HEAD' }),
			'HEAD',
			file.info,
			file.path,
			{ etag: true },
		)
		console.log(new Response(null, { status: plan.status, headers: plan.headers }))
	} finally {
		await file.handle.close()
	}
}
```

### Token extraction

```ts
import { extractBearerToken, extractFieldToken } from '@orkestrel/middleware'

console.log(extractBearerToken('Bearer credential', 'Bearer'))
console.log(extractFieldToken({ csrf: 'credential' }, 'csrf'))
```

## Tests

- [`tests/guides.test.ts`](../tests/guides.test.ts) — the `## Surface` ↔
  `src/server` bijection (value and type exports), the `AssetSourceInterface`,
  `SessionInterface`, `SessionControlInterface`, `SessionStoreInterface`, and
  `SessionTransportInterface` method bijections, and the equality gate: every `Summary`
  cell against its declaration's description paragraph, the titled `Mount a battery`
  fence against the `@example` block of that title (pinned so the titled pair cannot be
  retired silently), and the README pitch against this guide's tagline.
- [`tests/src/server/validators.test.ts`](../tests/src/server/validators.test.ts) —
  the `isSession`/`isSessionControl`/`isMultipartFile`/`isMultipartBody`
  totality guards, each driven over a well-shaped value and over the malformed
  inputs it must answer `false` to.
- [`tests/src/server/Session.test.ts`](../tests/src/server/Session.test.ts) —
  the entity shape (`id`, an independent `state` view and its mutators per instance).
- [`tests/src/server/stores/MemorySessionStore.test.ts`](../tests/src/server/stores/MemorySessionStore.test.ts) —
  construction guards, get/set/delete, idle + absolute-lifetime eviction,
  `created` stamped once and preserved across re-set, recency refreshed by a
  live read, one eviction per insert at capacity, and the cost row that bounds
  the time of an insert at capacity in a store of 4n sessions against one of n.
- [`tests/src/server/stores/DatabaseSessionStore.test.ts`](../tests/src/server/stores/DatabaseSessionStore.test.ts) —
  get/set/delete over a real `@orkestrel/database` memory-driver table, idle +
  absolute-lifetime eviction (including the underlying row's removal),
  `created` stamped once and preserved across re-set, guard rejection,
  construction guards, rebuild through the injected restore step, and the
  propagated `DRIVER` refusal of a row stored under the earlier cursor columns.
- [`tests/src/server/factories.test.ts`](../tests/src/server/factories.test.ts) —
  `createCookieTransport`/`createHeaderTransport` round-trips over real
  `Request`/`Response`, `createMemorySessionStore` shallow mirror,
  `createRestoredSession` snapshot rebuilds and malformed refusals,
  `createDatabaseSessionStore` construction guard.
- [`tests/src/server/helpers.test.ts`](../tests/src/server/helpers.test.ts) —
  `resolveKey` precedence, `buildRetryAfter`/`buildRateLimitField`/
  `buildRateLimitPolicyField` exact wire strings, `matchesTrustedEntry`/
  `resolveForwardedFor` matrices, `detectEncodings`, `compressBytes`, buffering-eligibility
  predicates, `transferSessionState`, `matchesSessionState`, `generateNonce`,
  `signCSRFToken` and `verifyCSRFToken` over the malformed-token table, `isPreflight`, `buildClient`,
  `admitOptions` and `admitForeign`, traversal and SPA-fallback resolution, byte-signature matching, node zlib
  compression, multipart limit resolution, boundary extraction, part-header
  parsing, `streamFile`'s pull-driven backpressure and descriptor release, and
  the uploaded-file operations, including `moveUploadedFile`'s cross-device
  fallback where a runtime device probe finds a second filesystem.
- [`tests/src/server/parsers.test.ts`](../tests/src/server/parsers.test.ts) —
  `parseMultipartRequest` end to end: field and file staging, dangerous-key
  refusal, the sniff-authoritative allow-list, every limit and its boundary,
  the malformed matrix, reader cancellation, abort mid-upload, and the staged
  file permission bits.
- [`tests/src/server/MultipartParser.test.ts`](../tests/src/server/MultipartParser.test.ts) —
  the interned state machine driven directly: the preamble cap, the
  header-block cap, the total-bytes cap, the abort-mid-upload path, and the
  staged-file cleanup each throw performs.
- [`tests/src/server/middlewares.test.ts`](../tests/src/server/middlewares.test.ts) —
  every battery's defaults, options, skip conditions, and the security
  acceptance bar's invariants; the canonical onion composed end-to-end;
  in-memory asset ownership, key refusal, identity/Brotli negotiation,
  conditional and HEAD responses, filesystem static serving, multipart
  middleware, and the server-face composition.

## See also

- [`AGENTS.md`](../AGENTS.md) — the coding rules this package is written under.
- `@orkestrel/server` — the frozen seam and substrate every battery in this
  package is built over. Its mirrored guide is [`server.md`](server.md).
- `@orkestrel/contract` — the guards backing every construction boundary.
- `@orkestrel/budget` — `createLimiter`'s per-key tally.
- `@orkestrel/timeout` — `createDeadline`'s timer.
- [`README.md`](README.md) — the guides index.
