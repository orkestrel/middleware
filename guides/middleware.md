# Middleware

> Batteries for the `@orkestrel/server` middleware seam:
> `create{Noun}(options) => MiddlewareHandler<TState>` factories for error
> boundaries, telemetry, compression, security headers, CORS, deadlines,
> trusted-proxy client facts, ETag, bearer authentication, rate limiting, body
> parsing, sessions, and CSRF in the fetch-native core, plus in-memory assets,
> static files, streaming multipart uploads, and a `node:zlib` compression
> sibling in the node face.

This is the package's one guide, and it covers the core and the node face
together. Every battery composes the frozen `@orkestrel/server` middleware seam
(`MiddlewareHandler`, `MiddlewareContext`, `compose`) and its substrate —
cookies, WebCrypto tokens, negotiation, conditionals, and security primitives.
This package never re-implements that seam, and it supplies mechanism rather
than product policy. Source: [`src/core`](../src/core),
[`src/server`](../src/server). Surfaced through the `@orkestrel/middleware` and
`@orkestrel/middleware/server` barrels (aliased `@src/core` and `@src/server`
inside this repo).

## Surface

A battery closes over its guarded options and returns a
`MiddlewareHandler<TState>`, which composes with the others over the shipped
seam.

### Mount a battery

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

### Middlewares — core

| API                 | Kind     | Summary                                                                                                                                                                                                              |
| ------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createBoundary`    | function | Creates the outermost error-rendering battery — catches a downstream throw and renders it as a `Response`.                                                                                                           |
| `createTelemetry`   | function | Creates the access-log/timing seam — records one `TelemetryEntry` per request after the response settles.                                                                                                            |
| `createCompression` | function | Creates the response-body compression battery — negotiates and compresses a buffered response body over the runtime's feature-detected `CompressionStream` codings.                                                  |
| `createSecurity`    | function | Creates the security-headers + request-identifier battery — sets each documented header default, and mints or echoes a request identifier.                                                                           |
| `createCors`        | function | Creates the Cross-Origin Resource Sharing battery — answers a preflight itself, and reflects an allow-listed origin or serves the configured wildcard.                                                               |
| `createDeadline`    | function | Creates the application-level per-request deadline battery.                                                                                                                                                          |
| `createForwarded`   | function | Creates the trusted-proxy client-IP resolver battery — walks `X-Forwarded-For` past the hops its options declare trusted.                                                                                            |
| `createETag`        | function | Creates the dynamic response `ETag` + conditional GET battery (RFC 7232).                                                                                                                                            |
| `createBearer`      | function | Creates the bearer-token authentication battery — reads the token from its header and verifies it with `verifyToken`.                                                                                                |
| `createLimiter`     | function | Creates the fixed-window rate-limiting battery — checks a key's budget before consuming it, so one window admits exactly `max` requests.                                                                             |
| `createBody`        | function | Creates the body-driving battery — eagerly awaits the cached `context.body()` so its throws (or a malformed-JSON `undefined`) surface before the handler runs, and stashes the resolved value onto `BodyState.body`. |
| `createSession`     | function | Creates the generic session battery — resolves, mints, and persists a session across the request, with a mid-handler `regenerate`/`destroy` control handle.                                                          |
| `createCSRF`        | function | Creates the session-bound double-submit CSRF protection battery.                                                                                                                                                     |
| `only`              | function | Scopes a battery to a set of exact pathnames and nowhere else — outside that set it steps aside through `next()`.                                                                                                    |
| `except`            | function | Scopes a battery to every pathname outside a set of exact ones — on that set it steps aside through `next()`.                                                                                                        |

### Middlewares — node

| API                 | Kind     | Summary                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createAssets`      | function | Serves validated in-memory assets with identity/Brotli negotiation.                                                                                                                                                                                                                                                                                                                          |
| `createStatic`      | function | Serves static files from `options.root` over `node:fs` — the node-bound static-file battery, answering conditional, ranged, and SPA-fallback requests.                                                                                                                                                                                                                                       |
| `createMultipart`   | function | Parses a streamed `multipart/form-data` request body and stashes its `MultipartBody` on `context.state.multipart` — the node-bound streaming multipart battery.                                                                                                                                                                                                                              |
| `createCompression` | function | Compresses response bodies through `node:zlib`, guaranteed on any Node runtime rather than dependent on the WHATWG `CompressionStream` global. This battery is the node-bound sibling of the core face's feature-detected `createCompression`, and it ships from a separate package entry point (`@orkestrel/middleware/server`) so the shared name is unambiguous per consumer import path. |

### Types

A `Shape` cell holds an interface's data members as bare names in braces, `?` marking an optional member and `plus` introducing its call-signature members, and a type alias's own type literal with a union's arms escaped as `\|`.

| Type                        | Kind      | Shape                                                                                          | Summary                                                                                                                                                                                                                                                                                                 |
| --------------------------- | --------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BoundaryOptions`           | interface | `{ expose?, report? }`                                                                         | Configures `createBoundary` — the outermost error-rendering battery.                                                                                                                                                                                                                                    |
| `TelemetryEntry`            | interface | `{ method, pathname, status, duration }`                                                       | Represents one access-log-style entry `createTelemetry` records after a response settles — the access-log/timing seam's payload shape.                                                                                                                                                                  |
| `TelemetryOptions`          | interface | `{ record }`                                                                                   | Configures `createTelemetry` — the request timing/access-log seam.                                                                                                                                                                                                                                      |
| `CompressionOptions`        | interface | `{ threshold?, encodings?, filter? }`                                                          | Configures `createCompression` — response-body compression.                                                                                                                                                                                                                                             |
| `CompressResponseOptions`   | interface | `{ threshold, filter?, encodings, compress }`                                                  | Describes the already-resolved settings `compressResponse` runs its shared negotiate → skip → threshold → compress skeleton against — the shape each face's `createCompression` builds from its own option bag.                                                                                         |
| `SecurityIdentifierOptions` | type      | `{ trust? } \| false`                                                                          | Describes `createSecurity`'s `identifier` sub-option — request-id minting/echo policy, or `false` to disable the feature entirely.                                                                                                                                                                      |
| `SecurityOptions`           | interface | `{ frame?, csp?, referrer?, permissions?, coop?, corp?, cluster?, coep?, hsts?, identifier? }` | Configures `createSecurity` — the security-headers + request-id battery.                                                                                                                                                                                                                                |
| `CorsOptions`               | interface | `{ origin?, methods?, headers? }`                                                              | Configures `createCors` — Cross-Origin Resource Sharing.                                                                                                                                                                                                                                                |
| `DeadlineOptions`           | interface | `{ ms, status? }`                                                                              | Configures `createDeadline` — the application-level per-request deadline.                                                                                                                                                                                                                               |
| `ForwardedOptions`          | type      | `{ proxies } \| { trusted }`                                                                   | Configures `createForwarded` — the trusted-proxy client-IP resolver.                                                                                                                                                                                                                                    |
| `ETagOptions`               | interface | `{ weak? }`                                                                                    | Configures `createETag` — dynamic response ETag + conditional GET.                                                                                                                                                                                                                                      |
| `BearerOptions`             | interface | `{ secret, header?, scheme? }`                                                                 | Configures `createBearer` — bearer-token authentication.                                                                                                                                                                                                                                                |
| `LimiterOptions`            | interface | `{ max, window, capacity?, key?, message?, clock?, policy?, evict? }`                          | Configures `createLimiter` — fixed-window rate limiting.                                                                                                                                                                                                                                                |
| `BearerState`               | interface | `{ token? }`                                                                                   | Describes the bearer-authentication state slice `createBearer` stashes on `context.state` once a token verifies.                                                                                                                                                                                        |
| `IdentifierState`           | interface | `{ identifier? }`                                                                              | Describes the request-identifier state slice `createSecurity` stashes when its `identifier` option is enabled.                                                                                                                                                                                          |
| `Client`                    | interface | `{ ip? }`                                                                                      | Describes the resolved client connection facts `createForwarded` stashes.                                                                                                                                                                                                                               |
| `ClientState`               | interface | `{ client? }`                                                                                  | Describes the client-facts state slice `createForwarded` stashes.                                                                                                                                                                                                                                       |
| `ConnectionState`           | interface | `{ connection? }`                                                                              | Describes the connection-facts state slice `createLimiter`'s default key derivation falls back to when neither `BearerState` nor `ClientState` is present — the raw socket peer surfaced on `context.state` by the server's `state` option.                                                             |
| `SessionInterface`          | interface | `{ id, state } plus set, delete, clear`                                                        | Represents a server-managed session's public surface — an id, its live state, and the mutators that write it.                                                                                                                                                                                           |
| `SessionControlInterface`   | interface | `{} plus regenerate, destroy`                                                                  | Describes the mid-handler control handle `createSession` stashes alongside the session itself — the OWASP anti-fixation / logout primitives.                                                                                                                                                            |
| `SessionState`              | interface | `{ session?, control? }`                                                                       | Describes the session state slice `createSession` stashes.                                                                                                                                                                                                                                              |
| `BodyState`                 | interface | `{ body? }`                                                                                    | Describes the body state slice `createBody` stashes.                                                                                                                                                                                                                                                    |
| `SessionStoreInterface`     | interface | `{} plus get, set, delete`                                                                     | Describes the pluggable session persistence seam `createSession`'s `store` option implements — a point-access store keyed by session id.                                                                                                                                                                |
| `SessionTransportInterface` | interface | `{} plus read, write, clear`                                                                   | Describes the transport seam `createSession`'s `transport` option implements — how a session id travels to and from the client (a signed cookie, a header, …).                                                                                                                                          |
| `SessionOptions`            | interface | `{ transport, store?, ttl?, lifetime?, capacity?, evict?, create?, mint?, required?, clock? }` | Configures `createSession` — the generic session battery.                                                                                                                                                                                                                                               |
| `CookieTransportOptions`    | interface | `{ name?, secret, cookie? }`                                                                   | Configures `createCookieTransport` — the signed-cookie `SessionTransportInterface`.                                                                                                                                                                                                                     |
| `HeaderTransportOptions`    | interface | `{ header? }`                                                                                  | Configures `createHeaderTransport` — the bare-header `SessionTransportInterface`.                                                                                                                                                                                                                       |
| `MemorySessionStoreOptions` | interface | `{ ttl?, lifetime?, capacity?, evict? }`                                                       | Configures `createMemorySessionStore` — the default in-process `SessionStoreInterface`.                                                                                                                                                                                                                 |
| `SessionLimits`             | interface | `{ ttl?, lifetime? }`                                                                          | Describes the idle and absolute-lifetime thresholds a session store enforces — `sessionExpired`'s limits argument and both shipped stores' construction options.                                                                                                                                        |
| `SessionCursors`            | interface | `{ seen, created }`                                                                            | Describes the per-session instants a store stamps and `sessionExpired` measures against.                                                                                                                                                                                                                |
| `SessionRow`                | interface | `{ id, session, seen, created }`                                                               | Represents one persisted session row — an opaque snapshot column plus the store-owned idle/absolute-lifetime cursors, the shape a `DatabaseSessionStore`'s backing table holds.                                                                                                                         |
| `SessionEntry`              | interface | `{ session, seen, created }`                                                                   | Represents one in-process session entry — the payload `MemorySessionStore` holds against an id, alongside the same cursors a persisted row carries.                                                                                                                                                     |
| `SessionSnapshot`           | interface | `{ id, state }`                                                                                | Represents a session's serializable projection — the value `snapshotSession` produces and a durable store's `set` writes.                                                                                                                                                                               |
| `SessionRestoreFunction`    | type      | `(value: unknown) => SessionInterface \| undefined`                                            | Rebuilds a session entity from an untrusted stored snapshot, or resolves `undefined` when the value is malformed.                                                                                                                                                                                       |
| `CSRFState`                 | interface | `{ csrf? }`                                                                                    | Describes the CSRF state slice `createCSRF` stashes — the raw token a safe-method response exposes for a subsequent mutating request to submit back.                                                                                                                                                    |
| `CSRFOptions`               | interface | `{ secret, cookie?, header?, field?, safe? }`                                                  | Configures `createCSRF` — session-bound double-submit CSRF protection.                                                                                                                                                                                                                                  |
| `MultipartFile`             | interface | `{ field, name, size, mime, validated, status, path }`                                         | Represents one staged multipart upload's public record — the shape the node-face `createMultipart` battery (`@orkestrel/middleware/server`) produces per uploaded file.                                                                                                                                 |
| `MultipartBody`             | interface | `{ files, fields }`                                                                            | Describes the parsed multipart request body `createMultipart` stashes — files keyed by their field name, plus every plain text field.                                                                                                                                                                   |
| `MultipartState`            | interface | `{ multipart? }`                                                                               | Describes the multipart state slice `createMultipart` stashes.                                                                                                                                                                                                                                          |
| `Asset`                     | interface | `{ body, encoding? }`                                                                          | Describes one in-memory asset representation returned by an `AssetSourceInterface`.                                                                                                                                                                                                                     |
| `AssetSourceInterface`      | interface | `{} plus read`                                                                                 | Reads in-memory assets by decoded, browser-build-relative path.                                                                                                                                                                                                                                         |
| `AssetOptions`              | interface | `{ source }`                                                                                   | Configures `createAssets` — in-memory identity/Brotli asset serving.                                                                                                                                                                                                                                    |
| `StaticOptions`             | interface | `{ root, prefix?, index?, dotfiles?, cache?, etag?, fallback? }`                               | Configures `createStatic` — node `fs`-backed static file serving.                                                                                                                                                                                                                                       |
| `MultipartLimitsInput`      | interface | `{ file?, field?, total? }`                                                                    | Describes the caller's partial `MultipartLimits` — `createMultipart`'s `limits` option, with every member optional.                                                                                                                                                                                     |
| `MultipartLimits`           | interface | `{ file, field, total }`                                                                       | Describes the per-category size/count caps `createMultipart` enforces mid-stream — the effective limits, every documented default already applied.                                                                                                                                                      |
| `MultipartOptions`          | interface | `{ limits?, allowed?, directory? }`                                                            | Configures `createMultipart` — node `fs`/`os`/`crypto`-backed streaming multipart upload parsing.                                                                                                                                                                                                       |
| `NodeCompressionOptions`    | interface | `{ threshold?, filter? }`                                                                      | Configures the node face's `createCompression` — `node:zlib`-backed response compression.                                                                                                                                                                                                               |
| `MultipartErrorCode`        | type      | `'limit' \| 'malformed' \| 'rejected'`                                                         | Names the reason `createMultipart` rejected a request — the machine-readable code `MultipartError` carries and maps onto its HTTP status: `'limit'` → 413, `'malformed'` → 400, `'rejected'` → 415.                                                                                                     |
| `UploadStatus`              | type      | `'staged' \| 'moved'`                                                                          | Names the lifecycle stage of one staged upload's temp file.                                                                                                                                                                                                                                             |
| `UploadedFile`              | interface | `{ field, name, size, mime, validated, status, path }`                                         | Describes one uploaded file's post-parse record — the node-bound, richer sibling of the pure core's `MultipartFile` (identical fields, `status` narrowed to `UploadStatus`). Structurally assignable into `MultipartFile` so a `createMultipart`-built `MultipartBody` satisfies the shared core shape. |
| `PartHeaders`               | interface | `{ name, filename, mime }`                                                                     | Describes one multipart part's parsed header block — `parsePartHeaders`'s return shape.                                                                                                                                                                                                                 |
| `ByteRange`                 | interface | `{ start, end }`                                                                               | Describes one inclusive byte range over a file — `streamFile`'s optional `range` argument and the shape `createStatic` builds for a satisfiable `Range` request.                                                                                                                                        |

### Constants

A `Shape` cell holds the constant's declared type.

| API                               | Kind  | Shape                                          | Summary                                                                                                                                                                                                                                            |
| --------------------------------- | ----- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEFAULT_COMPRESSION_THRESHOLD`   | const | `number`                                       | Holds `1024`, the default minimum buffered body size in bytes `createCompression` will compress.                                                                                                                                                   |
| `DEFAULT_COMPRESSION_ENCODINGS`   | const | `readonly Encoding[]`                          | Lists `['gzip', 'deflate']`, the default content-codings `createCompression` offers in preference order — intersected at construction with what the runtime's `CompressionStream` actually supports.                                               |
| `DEFAULT_FRAME_OPTIONS`           | const | `string`                                       | Holds `'DENY'`, the default `X-Frame-Options` value `createSecurity` sets.                                                                                                                                                                         |
| `DEFAULT_CSP`                     | const | `string`                                       | Holds the default `Content-Security-Policy` value `createSecurity` sets — a custom `csp` option replaces this wholesale, never merges.                                                                                                             |
| `DEFAULT_REFERRER_POLICY`         | const | `string`                                       | Holds `'strict-origin-when-cross-origin'`, the default `Referrer-Policy` value `createSecurity` sets.                                                                                                                                              |
| `DEFAULT_PERMISSIONS_POLICY`      | const | `string`                                       | Holds the default `Permissions-Policy` value `createSecurity` sets.                                                                                                                                                                                |
| `DEFAULT_COOP`                    | const | `string`                                       | Holds `'same-origin'`, the default `Cross-Origin-Opener-Policy` value `createSecurity` sets.                                                                                                                                                       |
| `DEFAULT_CORP`                    | const | `string`                                       | Holds `'same-origin'`, the default `Cross-Origin-Resource-Policy` value `createSecurity` sets.                                                                                                                                                     |
| `DEFAULT_CLUSTER`                 | const | `string`                                       | Holds `'?1'`, the default `Origin-Agent-Cluster` value `createSecurity` sets.                                                                                                                                                                      |
| `DEFAULT_COEP`                    | const | `string`                                       | Holds `'require-corp'`, the value `createSecurity` sets for `Cross-Origin-Embedder-Policy` when `coep: true`.                                                                                                                                      |
| `DEFAULT_HSTS`                    | const | `string`                                       | Holds `'max-age=31536000; includeSubDomains'`, the value `createSecurity` sets for `Strict-Transport-Security` when `hsts: true`.                                                                                                                  |
| `DEFAULT_IDENTIFIER_HEADER`       | const | `string`                                       | Names `'x-request-id'`, the default header `createSecurity` mints or echoes a request identifier into.                                                                                                                                             |
| `DEFAULT_CORS_METHODS`            | const | `readonly string[]`                            | Lists the default methods `createCors` advertises on a preflight response.                                                                                                                                                                         |
| `DEFAULT_CORS_HEADERS`            | const | `readonly string[]`                            | Lists the default headers `createCors` advertises on a preflight response.                                                                                                                                                                         |
| `DEFAULT_DEADLINE_STATUS`         | const | `number`                                       | Holds `503`, the default response status `createDeadline` returns when its deadline fires first.                                                                                                                                                   |
| `DEFAULT_BEARER_HEADER`           | const | `string`                                       | Names `'authorization'`, the default header `createBearer` reads the token from.                                                                                                                                                                   |
| `DEFAULT_BEARER_SCHEME`           | const | `string`                                       | Names `'Bearer'`, the default scheme prefix `createBearer` strips before verification.                                                                                                                                                             |
| `DEFAULT_LIMITER_CAPACITY`        | const | `number`                                       | Holds `10_000`, the default maximum number of distinct rate-limit keys `createLimiter` tracks before LRU eviction.                                                                                                                                 |
| `DEFAULT_LIMITER_MESSAGE`         | const | `string`                                       | Holds the default 429 body message `createLimiter` sends when a key is over budget.                                                                                                                                                                |
| `DEFAULT_SESSION_CAPACITY`        | const | `number`                                       | Holds `10_000`, the default maximum number of distinct session ids `createMemorySessionStore` tracks before LRU (by last write) eviction.                                                                                                          |
| `DEFAULT_SESSION_COOKIE`          | const | `string`                                       | Names `'session'`, the default cookie `createCookieTransport` writes the signed session id under.                                                                                                                                                  |
| `DEFAULT_SESSION_HEADER`          | const | `string`                                       | Names `'session-id'`, the default header `createHeaderTransport` carries the session id in.                                                                                                                                                        |
| `DEFAULT_CSRF_COOKIE`             | const | `string`                                       | Names `'csrf'`, the default signed cookie `createCSRF` writes the CSRF token under.                                                                                                                                                                |
| `DEFAULT_CSRF_HEADER`             | const | `string`                                       | Names `'x-csrf-token'`, the default header `createCSRF` reads a mutating request's submitted token from.                                                                                                                                           |
| `DEFAULT_CSRF_FIELD`              | const | `string`                                       | Names `'_csrf'`, the default body field `createCSRF` falls back to reading a mutating request's submitted token from.                                                                                                                              |
| `DEFAULT_CSRF_SAFE_METHODS`       | const | `readonly string[]`                            | Lists `['GET', 'HEAD', 'OPTIONS']`, the default methods `createCSRF` treats as safe (mint instead of verify).                                                                                                                                      |
| `MULTIPART_STATUS`                | const | `Readonly<Record<MultipartErrorCode, number>>` | Holds the HTTP status `createMultipart` renders for each `MultipartErrorCode`: `'limit'` is 413, `'malformed'` is 400, and `'rejected'` is 415.                                                                                                    |
| `MULTIPART_ERROR_BRAND`           | const | `unique symbol`                                | Holds the `Symbol.for` brand `MultipartError` carries so `isMultipartError` recognizes an instance across duplicate copies of this package — a registry symbol rather than a module-local `Symbol()`, which would mint an unequal symbol per copy. |
| `NODE_COMPRESSION_ENCODINGS`      | const | `readonly Encoding[]`                          | Lists `['gzip', 'deflate']`, the content-codings the node face's `createCompression` offers — what `node:zlib` guarantees on every Node runtime, so this face never feature-detects.                                                               |
| `DEFAULT_STATIC_INDEX`            | const | `string`                                       | Names `'index.html'`, `createStatic`'s default directory-index filename.                                                                                                                                                                           |
| `DEFAULT_STATIC_FALLBACK_EXCLUDE` | const | `string`                                       | Names `'/api'`, `createStatic`'s `fallback: true` default excluded path prefix.                                                                                                                                                                    |
| `DEFAULT_STATIC_DOTFILES`         | const | `NonNullable<StaticOptions['dotfiles']>`       | Names `'ignore'`, `createStatic`'s default policy for a path carrying a dotfile segment.                                                                                                                                                           |
| `DEFAULT_CONTENT_TYPE`            | const | `string`                                       | Names `'application/octet-stream'`, the MIME type served when a file extension has no known mapping.                                                                                                                                               |
| `DEFAULT_MULTIPART_FILE_SIZE`     | const | `number`                                       | Holds `10_485_760`, `createMultipart`'s default per-file byte-size cap.                                                                                                                                                                            |
| `DEFAULT_MULTIPART_FILE_COUNT`    | const | `number`                                       | Holds `10`, `createMultipart`'s default maximum file-part count.                                                                                                                                                                                   |
| `DEFAULT_MULTIPART_FIELD_SIZE`    | const | `number`                                       | Holds `65_536`, `createMultipart`'s default per-field byte-size cap.                                                                                                                                                                               |
| `DEFAULT_MULTIPART_FIELD_COUNT`   | const | `number`                                       | Holds `100`, `createMultipart`'s default maximum field-part count.                                                                                                                                                                                 |
| `DEFAULT_MULTIPART_TOTAL`         | const | `number`                                       | Holds `52_428_800`, `createMultipart`'s default combined request-body byte-size cap.                                                                                                                                                               |
| `MULTIPART_MAX_HEADER_BLOCK`      | const | `number`                                       | Holds `16_384`, the maximum bytes a single multipart part's header block may occupy before it is malformed.                                                                                                                                        |
| `MULTIPART_MAX_PREAMBLE`          | const | `number`                                       | Holds `65_536`, the maximum bytes scanned before the first multipart boundary is found before it is malformed.                                                                                                                                     |
| `RESERVED_DEVICE_NAMES`           | const | `ReadonlySet<string>`                          | Lists the Windows reserved device-name stems (CVE-2025-27210) — matched case-insensitively against the segment's stem (before its first `.`).                                                                                                      |
| `EXTENSION_TYPES`                 | const | `Readonly<Record<string, string>>`             | Holds the file-extension (lowercase, with leading `.`) → MIME type lookup table for static serving.                                                                                                                                                |

### Shapers

| API              | Kind  | Summary                                                                                                                                                                                                                     |
| ---------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessionColumns` | const | Holds the `@orkestrel/database` column shape for a `SessionRow` table. Pass it as-is to `createDatabase({ tables: { sessions: sessionColumns } })` so an app declaring a durable session table never hand-writes the shape. |

### Helpers — core

| API                         | Kind     | Summary                                                                                                                                                                                                                                                                                |
| --------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolveKey`                | function | Derives `createLimiter`'s default rate-limit bucket key from a request's resolved identity facts.                                                                                                                                                                                      |
| `resolveOptInHeader`        | function | Resolves an opt-in, value-bearing security header — `string \| boolean` (off by default, `true` uses the secure default), the shape `createSecurity`'s `coep`/`hsts` options use, distinct from the plain value-or-`false` shape `resolveSecurityHeader` (the peer substrate) handles. |
| `buildRetryAfter`           | function | Builds the `Retry-After` header value — whole seconds until a window reset, floored at a minimum of `1`.                                                                                                                                                                               |
| `buildRateLimitField`       | function | Builds the draft `RateLimit` structured header field — emitted only when `createLimiter`'s `policy` option is `true`.                                                                                                                                                                  |
| `buildRateLimitPolicyField` | function | Builds the draft `RateLimit-Policy` structured header field — emitted only when `createLimiter`'s `policy` option is `true`.                                                                                                                                                           |
| `matchesTrustedEntry`       | function | Checks whether a candidate address is a bare (non-CIDR) trusted-hop match — an exact string match, or a simple prefix-CIDR match for IPv4 (`/8`–`/32`). An IPv6 entry matches by exact string only — there is no IPv6 CIDR support.                                                    |
| `resolveForwardedFor`       | function | Walks `X-Forwarded-For` right-to-left and resolves the first untrusted hop address — `createForwarded`'s core algorithm.                                                                                                                                                               |
| `detectEncodings`           | function | Feature-detects which of `candidates` the runtime's `CompressionStream` actually supports — `createCompression`'s construction-time intersection.                                                                                                                                      |
| `compressBytes`             | function | Compresses bytes with the host-independent `CompressionStream` primitive.                                                                                                                                                                                                              |
| `isBufferingIneligible`     | function | Checks whether a response is eligible for the compression/ETag buffering pipeline — the shared cheap-skip predicate both batteries apply before ever touching `response.arrayBuffer()`.                                                                                                |
| `isCompressionNegotiated`   | function | Checks whether a negotiated `Accept-Encoding` outcome is worth acting on — `createCompression`'s negotiation-eligibility half of the skip list.                                                                                                                                        |
| `rebuildResponse`           | function | Rebuilds a `Response` around a replacement body while preserving its status/statusText — the buffered-response reconstruction shared by the compression and ETag batteries after they have consumed `response.arrayBuffer()`.                                                          |
| `compressResponse`          | function | Runs the shared negotiate → skip → threshold → compress → header-set skeleton both faces' `createCompression` batteries compose — response-body compression over a caller-supplied set of feature-detected codings.                                                                    |
| `transferSessionState`      | function | Copies every entry of one session's `state` into another — the regenerate state-carry `createSession`'s `control.regenerate()` applies.                                                                                                                                                |
| `sessionExpired`            | function | Checks whether a session has aged past its idle timeout or absolute lifetime as of `now` — the pure expiry predicate `MemorySessionStore` delegates to.                                                                                                                                |
| `snapshotSession`           | function | Snapshots a session's `state` into a plain, serializable record — the projection a durable store's `set` writes to disk.                                                                                                                                                               |
| `validateSessionLimits`     | function | Validates a store's idle and absolute-lifetime thresholds, throwing when either is present and malformed — the shared construction gate `MemorySessionStore` and `DatabaseSessionStore` both apply, so one malformed `ttl` is refused identically by whichever store receives it.      |
| `isPreflight`               | function | Determines whether a request is a CORS preflight — an `OPTIONS` request carrying an `Access-Control-Request-Method` header.                                                                                                                                                            |
| `buildClient`               | function | Builds the `Client` slice `createForwarded` stashes, from the resolved client IP — a leaf shaping helper.                                                                                                                                                                              |
| `equalsConstantTime`        | function | Compares two strings in constant time — `createCSRF`'s double-submit token comparison, avoiding a timing oracle on the submitted-vs-cookie match.                                                                                                                                      |

### Validators — core

Each guard in the following table is total: it accepts any input, returns `false` off-shape, and never throws.

| API                | Kind     | Summary                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isSession`        | function | Determines whether a value implements `SessionInterface` — a total structural guard: an `id` string, a `state` `Map`, and the `set`, `delete`, and `clear` mutators. Prototype-agnostic — accepts a plain object, a null-prototype object, and a class instance (a real `Session`), because a restored or stored session is routinely a class instance rather than a literal. |
| `isSessionControl` | function | Determines whether a value implements `SessionControlInterface` — a total structural guard: callable `regenerate` and `destroy`.                                                                                                                                                                                                                                              |
| `isMultipartFile`  | function | Determines whether a value is one staged `MultipartFile` record — a total structural guard checking every required field's shape.                                                                                                                                                                                                                                             |
| `isMultipartBody`  | function | Determines whether a value implements `MultipartBody` — a total structural guard: `files` keyed by field name to arrays of `MultipartFile`, and a `fields` string record.                                                                                                                                                                                                     |

### Helpers — node

| API                         | Kind     | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolveStaticPath`         | function | Resolves a request pathname to an on-disk path under `root`, or `undefined` when it cannot — the traversal guard, whose algorithm and order are exact: strip `prefix` on a segment boundary → `decodeURIComponent` (a malformed escape refuses, never throws) → reject a NUL byte → strip the leading path separator first (so a leading `..` survives `normalize` as a genuine climbing segment) → `normalize` → refuse any Windows reserved- device-name segment (`isReservedDeviceName`) → `resolve` and require the result under `root`. |
| `isUnderPath`               | function | Checks whether `pathname` is `prefix` itself or lies under it on a segment boundary — the shared under-path test `resolveStaticPath`'s prefix strip and `createStatic`'s SPA-fallback `exclude` both apply, so `exclude: '/api'` matches `/api` and `/api/x` but never `/apifoo`.                                                                                                                                                                                                                                                            |
| `resolveStaticFallbackPath` | function | Resolves the fixed SPA shell path when a static-file miss is eligible for fallback.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `isContainedPath`           | function | Checks whether `child` is `parent` itself or lies inside it on-disk — the filesystem containment predicate `createStatic` applies to `fs.realpath` output (never to a URL pathname — that is `isUnderPath`'s job).                                                                                                                                                                                                                                                                                                                           |
| `resolveContainedRealPath`  | function | Canonicalizes `candidate` and returns it only when it lies inside `rootReal` — the shared realpath-then-contain step `createStatic` applies to a directory index and to its SPA shell.                                                                                                                                                                                                                                                                                                                                                       |
| `isReservedDeviceName`      | function | Checks whether a path segment is a Windows reserved device name (CVE-2025-27210).                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `isDotfilePath`             | function | Checks whether a relative path (already resolved under a static root) has any segment starting with `.` — a dotfile or dot-directory.                                                                                                                                                                                                                                                                                                                                                                                                        |
| `lookupContentType`         | function | Looks up the MIME type for a static file path by its extension.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `computeFileETag`           | function | Computes a static file's weak ETag from its size and modification time.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `detectMIME`                | function | Sniffs a MIME type from a file's leading bytes against a small magic-byte table (jpeg, png, gif87a/89a, webp, pdf, zip).                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `matchesBytes`              | function | Checks whether `bytes` contains `signature` at the requested offset.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `compressNodeBytes`         | function | Compresses response bytes with Node's guaranteed zlib gzip/deflate codecs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `extractMultipartBoundary`  | function | Extracts the `boundary` parameter from a `Content-Type` header, or `undefined` when the request is not `multipart/form-data`.                                                                                                                                                                                                                                                                                                                                                                                                                |
| `parsePartHeaders`          | function | Parses one multipart part's raw header block into its `name` (from `Content-Disposition`), optional `filename`, and optional `Content-Type`.                                                                                                                                                                                                                                                                                                                                                                                                 |
| `resolveMultipartLimits`    | function | Resolves `createMultipart`'s effective `MultipartLimits`, applying every documented default to an omitted leaf.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `createUploadedFile`        | function | Builds a frozen `UploadedFile` record.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `streamFile`                | function | Adapts a `node:fs` read stream over a file path (or an already-open `FileHandle`) into a DOM-compatible `ReadableStream<Uint8Array>` — the single shared node↔web stream bridge every static-file and uploaded-file response body routes through.                                                                                                                                                                                                                                                                                            |
| `streamUploadedFile`        | function | Opens a staged/moved uploaded file as a web `ReadableStream`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `readUploadedFile`          | function | Reads a staged/moved uploaded file's full contents into memory.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `moveUploadedFile`          | function | Moves a staged uploaded file to its final `destination`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `unlinkStagedFiles`         | function | Attempts to unlink every still-`'staged'` file in a parsed `MultipartBody` — the fail-closed cleanup `createMultipart` runs when its downstream handler throws, mirroring `parseMultipartRequest`'s own cleanup pattern (a missing file is already gone; failures are swallowed).                                                                                                                                                                                                                                                            |

### Parsers — node

| API                     | Kind     | Summary                                                                                                                          |
| ----------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `parseMultipartRequest` | function | Stream-parses a `multipart/form-data` request into its files and fields — the mid-stream state machine `createMultipart` drives. |

### Classes

| API                    | Kind  | Summary                                                                                                                                                                                                                                                                                     |
| ---------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Session`              | class | Represents a server-managed session's default entity — the `create` option's default value for `createSession`. It ships without a bare `create*` factory of its own, because the name `createSession` belongs to the battery; `createRestoredSession` rebuilds one from a stored snapshot. |
| `MemorySessionStore`   | class | Implements the default in-process `SessionStoreInterface` — a `Map`-backed store enforcing both an idle timeout and an absolute lifetime, with lazy (read-time) eviction, a bounded capacity, and no background timers.                                                                     |
| `DatabaseSessionStore` | class | Implements a durable `SessionStoreInterface` over an `@orkestrel/database` table — the same idle-timeout + absolute-lifetime contract as `MemorySessionStore`, backed by a caller-supplied `TableInterface` instead of an in-process `Map`.                                                 |

Multipart parsing has no entity row because it exposes no entity. The server source declares a
multipart lifecycle engine that `parseMultipartRequest` composes internally, and the barrel does not
export it: a consumer reaches every part of that behaviour through `parseMultipartRequest`, whose
result is a `MultipartBody`. `tests/guides.test.ts` names the class in its `INTERNAL` list, so the
omission is asserted rather than assumed, and adding it to the barrel would turn that assertion red.

### Factories

| API                          | Kind     | Summary                                                                                                                                                                                                     |
| ---------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createCookieTransport`      | function | Creates a signed-cookie `SessionTransportInterface` — the session id travels as a `signToken`-signed cookie value.                                                                                          |
| `createHeaderTransport`      | function | Creates a bare-header `SessionTransportInterface` — the session id travels verbatim in a request/response header.                                                                                           |
| `createMemorySessionStore`   | function | Creates the default in-process `SessionStoreInterface` — a `Map`-backed store enforcing an idle timeout and an absolute lifetime.                                                                           |
| `createDatabaseSessionStore` | function | Creates a `DatabaseSessionStore` as a `SessionStoreInterface` — the durable counterpart to `createMemorySessionStore`, over a caller-opened `@orkestrel/database` table (declare it with `sessionColumns`). |
| `createRestoredSession`      | function | Rebuilds a `Session` from an untrusted snapshot value — the inverse of `snapshotSession` and a durable store's `get` deserialization step.                                                                  |

### Errors

| API                | Kind     | Summary                                                                                                                                                                                                                   |
| ------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MultipartError`   | class    | Represents an error `createMultipart` throws when a streamed multipart request fails a mid-stream limit, is structurally malformed, or has a file whose sniffed bytes are rejected by the configured `allowed` MIME list. |
| `isMultipartError` | function | Narrows an unknown caught value to a `MultipartError`.                                                                                                                                                                    |

## Methods

The public methods of `AssetSourceInterface`, `SessionInterface`,
`SessionControlInterface`, `SessionStoreInterface`, and
`SessionTransportInterface` — the behavioral seams the middleware factories
compose (their `readonly` data members, where any exist, stay Surface rows
in the preceding section).

#### `AssetSourceInterface`

The in-memory lookup seam. `createAssets` validates a request key before it
calls `read`, copies each successful result, and caches that key for the
factory's lifetime. A miss may be read again later.

| Method | Returns              | Summary                                                                         |
| ------ | -------------------- | ------------------------------------------------------------------------------- |
| `read` | `Asset \| undefined` | Reads one identity or Brotli asset representation for a validated relative key. |

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
returns (`destroy` supersedes a prior `regenerate`).

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

## Contract

These invariants hold across `src/core` / `src/server` ↔ `middleware.md`.

1. **Guide ↔ source bijection.** Every `function` / `class` / `interface` /
   `type` / `const` row in the `## Surface` tables is a real export of its
   source directory, and every export appears as a Surface row — exhaustive,
   both directions.
2. **Guide ↔ source method bijection.** The `## Methods` tables list exactly
   `AssetSourceInterface`'s, `SessionInterface`'s, `SessionControlInterface`'s,
   `SessionStoreInterface`'s, and `SessionTransportInterface`'s public methods —
   exhaustive, both directions.

### The ordering doctrine

The canonical onion, outermost first, and the failure each position
prevents:

3. **`createTelemetry` is outermost.** It sees the mapped status (after
   `createBoundary` renders) and measures honest wall-clock duration —
   anything mounted inside it would be excluded from the timing.
4. **`createCompression` sits outside `createBoundary`.** An error `Response`
   the boundary renders from a caught throw still passes through
   compression — mount it inside instead and error bodies ship uncompressed.
5. **`createBoundary` is the renderer.** Everything mounted beneath it may
   throw `HTTPError` (or anything else) and have it mapped to a `Response`;
   nothing below it needs its own try/catch.
6. **`createDeadline` sits inside the boundary.** A downstream `AbortError`
   from the deadline firing is another throw the boundary maps cleanly
   — mounting it outside would bypass that rendering.
7. **`createSecurity` is a documented tradeoff, not a fixed position.** The
   canonical order places it inside the boundary, so an error `Response` a
   handler explicitly returns still carries security headers, but an error
   the boundary renders from a throw does not (`createSecurity`'s `next()`
   never resolves for a throw beneath it). A consumer who wants headers on
   every response, thrown errors included, mounts `createSecurity` above
   `createBoundary` instead — both orders are legitimate; pick the one your
   threat model wants.
8. **`createCors` claims preflights before the dispatcher's auto-`OPTIONS`.**
   Its `OPTIONS` short-circuit runs before the terminal `Dispatcher.handle`
   ever sees the request, by construction (any middleware position ahead of
   the terminal works — CORS needs only array membership, not a fragile
   slot).
9. **`createForwarded` resolves client facts before anything keys off
   them.** `createLimiter`'s default key and any session/telemetry logic
   that wants `ClientState.client.ip` must run downstream of it.
10. **`createETag` sits inside `createCompression`.** The hash is computed
    over the uncompressed representation — hashing the compressed bytes
    would break revalidation the instant the negotiated coding changes.
11. **`createBearer` sits before `createLimiter`.** The limiter's default key
    derivation prefers `BearerState.token` (the `token:<value>` idiom) over
    a client-IP fallback — bearer must have already stashed it.
12. **`createBody` sits before `createSession`/`createCSRF`.** `createSession`'s
    async `mint` and `createCSRF`'s `_csrf` body-field read both need the
    cached `context.body()` already resolved.
13. **`createSession` sits before `createCSRF`.** CSRF's session-binding —
    the security acceptance bar's CSRF item — requires `context.state.session`
    to already be stashed.

### The security acceptance bar, as documented behavior

14. **CORS.** `Vary: Origin` is merged only on the reflect (allow-list) path,
    never on the `'*'` wildcard path; the literal `Origin: null` is never
    reflected even when the string `'null'` is allow-listed.
15. **Headers.** A hostile `X-Request-ID` (off-charset, oversize, or
    CRLF-bearing) is never echoed — `createSecurity` mints a fresh
    `crypto.randomUUID()` instead; a custom `csp` string replaces the
    default wholesale (never merges); `X-Content-Type-Options: nosniff` is
    unconditional, with no opt-out.
16. **Bearer.** `verifyToken` is total over garbage, tampered, expired, or
    empty-rotation input — every failure renders `401`, never a crash;
    verification is constant-time through `crypto.subtle.verify`.
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
19. **Session.** The default `MemorySessionStore` enforces both an idle
    timeout (`ttl`, lazy eviction on `get`) and an absolute lifetime
    (`lifetime`, evicting even a continuously-touched session — `created`
    is stamped once at first `set` and preserved across every later
    re-persist); it is also capacity-capped (`capacity`, default
    `DEFAULT_SESSION_CAPACITY`) and evicts the least-recently-written id —
    every `set` (not `get`) refreshes recency — invoking the optional
    `evict` sink (throw-isolated) on a capacity eviction or an expired-entry
    prune, but never for an explicit `delete`; `control.regenerate()` rotates the id while carrying the
    session's `state` over and invalidating the old id; a signed cookie
    transport inherits the full substrate injection-hardening matrix
    (`__Host-` spoof rejection, `Domain`/`Path` injection throws,
    `SameSite=None` forces `Secure`, `Secure` derived from the connection's
    TLS fact when omitted). The battery installs no route of its own: it
    answers `404` when `required` is set and no session resolves or mints, and
    a consumer ending a session on `DELETE` mounts its own handler over
    `control.destroy()`.
20. **CSRF.** With a session ahead, the minted token is bound to that
    session's id (`signToken(sessionId)`) — a mutating request's recovered
    bound id must equal its own session's id, so a token minted under
    session A replayed against session B is `403` even with matching
    double-submit halves; without a session, `createCSRF` falls back to
    signed-random double-submit (documented weaker — no cross-session
    binding is possible without one).
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
22. **Assets.** `createAssets` decodes a browser-relative key and refuses
    malformed escapes, backslashes, empty segments, `.`/`..`, and dotfiles
    before it calls `AssetSourceInterface.read`. A successful value is copied
    and cached. A Brotli value is decompressed once; Brotli and identity share
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
    through `options.directory`).
24. **Boundary.** `expose: false` leaks nothing (a non-`HTTPError` throw's
    message never reaches the body); an `HTTPError`'s own `message` always
    surfaces (it is the handler's deliberate signal); a `report` sink's own
    throw is swallowed and can never alter the response.
25. **`only`/`except` are not a security boundary.** Both match
    `context.url.pathname` exactly — a trailing slash (`/login/` vs `/login`),
    a case variant, or a percent-encoded path silently falls outside an
    `only()`-scoped path set, and a security battery scoped that way goes
    dark on that request with no signal. Prefer `except()` for security
    batteries (CSRF, bearer, rate limiting) — its failure mode is fail-closed
    (an unlisted or misspelled path still gets the battery; only the
    explicitly excluded paths lose it), where `only()`'s failure mode is
    fail-open. Whichever combinator is used, keep its path set in lockstep
    with the router's actual routes — a route added after the fact and not
    added to the set is silently unscoped.

## Patterns

### Canonical onion — fetch-native runtime

The full ordering doctrine, composed directly over `compose` (no `@orkestrel/server`
`Server` required — any fetch-native runtime works):

```ts
import {
	createBearer,
	createBody,
	createBoundary,
	createCompression,
	createCors,
	createCSRF,
	createDeadline,
	createETag,
	createForwarded,
	createLimiter,
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
import { compose } from '@orkestrel/server'

interface State extends BearerState, ClientState, CSRFState, IdentifierState, SessionState {
	readonly connection?: { readonly ip?: string }
}

const onion = [
	createTelemetry({ record: (entry) => console.log(entry) }),
	createCompression(),
	createBoundary({ expose: false }),
	createDeadline({ ms: 5_000 }),
	createSecurity({ hsts: true }),
	createCors({ origin: ['https://app.example'] }),
	createForwarded({ proxies: 1 }),
	createETag(),
	createBearer({ secret: 'shh' }),
	createLimiter({ max: 100, window: 60_000 }),
	createBody(),
	createSession({ transport: createCookieTransport({ secret: 'shh' }) }),
	createCSRF({ secret: 'shh' }),
]

const handle = compose<State>(onion, async (_request, context) => {
	return Response.json({ session: context.state.session?.id })
})
```

### Canonical onion — behind `@orkestrel/server`

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
	middleware: [createBoundary(), createSecurity()],
})
const port = await server.start()
await server.stop()
```

### Body: eager cache drive

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
context.state.control?.regenerate() // rotate the id after a privilege change (anti-fixation)
context.state.control?.destroy() // end the session outright
```

### Session store seam — direct calls

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
closed rather than reading a stale row as live: the table's own read guard
refuses a row that does not satisfy `sessionColumns`, `store.get` resolves
`undefined`, and the row stays in place until the table is migrated or
recreated.

### Session transport seam — direct calls

```ts
import { createHeaderTransport } from '@orkestrel/middleware'

const transport = createHeaderTransport()
const request = new Request('https://x', { headers: { 'session-id': 'abc' } })
await transport.read(request) // 'abc'
const response = new Response('ok')
await transport.write(response, 'abc', false) // sets the session-id header
transport.clear(response) // removes it
```

### CSRF: session-bound double-submit

```ts
import { createCSRF, createSession, createCookieTransport } from '@orkestrel/middleware'
import type { CSRFState, SessionState } from '@orkestrel/middleware'

interface State extends SessionState, CSRFState {}

const session = createSession<import('@orkestrel/middleware').SessionInterface, State>({
	transport: createCookieTransport({ secret: 'session-secret' }),
})
const csrf = createCSRF({ secret: 'csrf-secret' }) // session ahead binds the token to its id
```

### Multipart: node face, sniffed-type allow-list

```ts
import { createMultipart } from '@orkestrel/middleware/server'
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

```ts
import { resolveMultipartLimits } from '@orkestrel/middleware/server'

resolveMultipartLimits({ file: { size: 1_048_576 } }) // fills in every other default cap
```

Multipart processing reports no progress.

### Assets: in-memory source

```ts
import type { AssetSourceInterface } from '@orkestrel/middleware/server'
import { createAssets } from '@orkestrel/middleware/server'

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

```ts
import { createStatic } from '@orkestrel/middleware/server'

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
  `transport.write` the new id; otherwise → `store.set` the resolved/minted
  session, `transport.write` only when freshly minted. `destroy()`
  supersedes a prior `regenerate()`.

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
- **Pick your `createSecurity` position deliberately** — inside the
  boundary (default; headers only on returned responses) or above it
  (headers on every response, thrown errors included) — see Contract §7.

## Tests

- [`tests/guides.test.ts`](../tests/guides.test.ts) — the `## Surface` ↔ `src/core` +
  `src/server` bijection (value and type exports), the `AssetSourceInterface`,
  `SessionInterface`, `SessionControlInterface`, `SessionStoreInterface`, and
  `SessionTransportInterface` method bijections, and the equality gate: every `Summary`
  cell against its declaration's description paragraph, the titled `Mount a battery`
  fence against the `@example` block of that title (pinned so the titled pair cannot be
  retired silently), and the README pitch against this guide's tagline.
- [`tests/src/core/helpers.test.ts`](../tests/src/core/helpers.test.ts) —
  `resolveKey` precedence, `buildRetryAfter`/`buildRateLimitField`/
  `buildRateLimitPolicyField` exact wire strings, `matchesTrustedEntry`/
  `resolveForwardedFor` matrices, `detectEncodings`, `compressBytes`, buffering-eligibility
  predicates, `transferSessionState`, `isPreflight`, `buildClient`,
  `validateSessionLimits`.
- [`tests/src/core/validators.test.ts`](../tests/src/core/validators.test.ts) —
  the `isSession`/`isSessionControl`/`isMultipartFile`/`isMultipartBody`
  totality guards, each driven over a well-shaped value and over the hostile
  inputs it must answer `false` to.
- [`tests/src/core/Session.test.ts`](../tests/src/core/Session.test.ts) —
  the entity shape (`id`, an independent `state` view and its mutators per instance).
- [`tests/src/core/stores/MemorySessionStore.test.ts`](../tests/src/core/stores/MemorySessionStore.test.ts) —
  construction guards, get/set/delete, idle + absolute-lifetime eviction,
  `created` stamped once and preserved across re-set.
- [`tests/src/core/stores/DatabaseSessionStore.test.ts`](../tests/src/core/stores/DatabaseSessionStore.test.ts) —
  get/set/delete over a real `@orkestrel/database` memory-driver table, idle +
  absolute-lifetime eviction (including the underlying row's removal),
  `created` stamped once and preserved across re-set, guard rejection,
  construction guards, rebuild through the injected restore step, and the
  fail-closed read of a row stored under the earlier cursor columns.
- [`tests/src/core/factories.test.ts`](../tests/src/core/factories.test.ts) —
  `createCookieTransport`/`createHeaderTransport` round-trips over real
  `Request`/`Response`, `createMemorySessionStore` shallow mirror,
  `createRestoredSession` snapshot rebuilds and malformed refusals,
  `createDatabaseSessionStore` construction guard.
- [`tests/src/core/middlewares.test.ts`](../tests/src/core/middlewares.test.ts) —
  every battery's defaults, options, skip conditions, and the security
  acceptance bar's invariants; the canonical onion composed end-to-end.
- [`tests/src/server/helpers.test.ts`](../tests/src/server/helpers.test.ts) —
  traversal and SPA-fallback resolution, byte-signature matching, node zlib
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
  in-memory asset ownership, key refusal, identity/Brotli negotiation,
  conditional and HEAD responses, filesystem static serving, multipart
  middleware, and the server-face composition.

## See also

- [`AGENTS.md`](../AGENTS.md) — the coding rules this package is written under.
- `@orkestrel/server` — the frozen seam and substrate every battery in this
  package is built over. Its mirrored guide is [`server.md`](server.md).
- `@orkestrel/contract` — the guards backing every construction boundary.
- `@orkestrel/budget` — `createLimiter`'s per-key tally.
- `@orkestrel/abort` / `@orkestrel/timeout` — `createDeadline`'s
  signal-linking and timer.
- [`README.md`](README.md) — the guides index.
