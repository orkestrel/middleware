# Middleware

> This package's ONE guide, covering both faces (AGENTS §22 — one guide per
> package): the pure, fetch-native core (`@orkestrel/middleware`) — thirteen
> `create{Noun}(options) => MiddlewareHandler<TState>` battery factories
> (boundary, telemetry, compression, security headers, CORS, deadlines,
> trusted-proxy client facts, ETag, bearer auth, rate limiting, body
> parsing, sessions, CSRF) plus the session/transport/store seam — and the
> node-bound face (`@orkestrel/middleware/server`) — static file serving and
> streaming multipart uploads, plus a `node:zlib`-guaranteed compression
> sibling. Every battery is built over the frozen `@orkestrel/server`
> middleware seam (`MiddlewareHandler`, `MiddlewareContext`, `compose`) and
> substrate (cookies, WebCrypto tokens, negotiation, conditionals, security
> primitives) — this package never re-implements the seam, only composes it
> into policy (AGENTS §21 "mechanism, never policy"). Source:
> [`src/core`](../../src/core), [`src/server`](../../src/server). Surfaced
> through the `@orkestrel/middleware` / `@orkestrel/middleware/server`
> barrels (aliased `@src/core` / `@src/server` inside this repo).

## Surface

Mount a battery over the shipped seam — it closes over its guarded options
and returns a `MiddlewareHandler<TState>`:

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

| API                  | Kind     | Summary                                                                          |
| -------------------- | -------- | -------------------------------------------------------------------------------- |
| `createBoundary`     | function | The outermost error-rendering battery — maps a downstream throw to a `Response`. |
| `createTelemetry`    | function | The access-log/timing seam — records one `TelemetryEntry` per settled request.   |
| `createCompression`  | function | Response-body compression over feature-detected `CompressionStream` codings.     |
| `resolveOptInHeader` | function | Resolve `createSecurity`'s `coep`/`hsts` opt-in header value.                    |
| `createSecurity`     | function | Security headers + request-identifier minting/echo battery.                      |
| `createCors`         | function | Cross-Origin Resource Sharing — preflight answering + reflect/wildcard.          |
| `createDeadline`     | function | The application-level per-request deadline, linked to `request.signal`.          |
| `createForwarded`    | function | The trusted-proxy `X-Forwarded-For` resolver — explicit proxy trust config.      |
| `createETag`         | function | Dynamic response `ETag` + conditional `GET` (RFC 7232).                          |
| `createBearer`       | function | Bearer-token authentication via `verifyToken`.                                   |
| `createLimiter`      | function | Fixed-window rate limiting with check-before-consume exactness.                  |
| `createBody`         | function | Eagerly drives the cached `context.body()` so its throws surface early.          |
| `createSession`      | function | The generic session battery — resolve/mint/persist + regenerate/destroy.         |
| `createCSRF`         | function | Session-bound double-submit CSRF protection.                                     |

### Middlewares — node

| API                 | Kind     | Summary                                                                              |
| ------------------- | -------- | ------------------------------------------------------------------------------------ |
| `createStatic`      | function | Serve static files from `options.root` over `node:fs`, with Range/ETag/SPA fallback. |
| `createMultipart`   | function | Stream-parse `multipart/form-data` into `context.state.multipart`.                   |
| `createCompression` | function | The `node:zlib`-backed compression sibling (gzip/deflate, no feature-detection).     |

### Types

| Type                        | Kind      | Shape                                                                                           |
| --------------------------- | --------- | ----------------------------------------------------------------------------------------------- |
| `BoundaryOptions`           | interface | `{ expose?; report? }` — options for `createBoundary`.                                          |
| `TelemetryEntry`            | interface | `{ method; pathname; status; duration }` — one settled-request record.                          |
| `TelemetryOptions`          | interface | `{ record }` — options for `createTelemetry`.                                                   |
| `CompressionOptions`        | interface | `{ threshold?; encodings?; filter? }` — options for `createCompression`.                        |
| `SecurityIdentifierOptions` | type      | `{ trust?: boolean } \| false` — `createSecurity`'s `identifier` sub-option.                    |
| `SecurityOptions`           | interface | `{ frame?; csp?; referrer?; permissions?; coop?; corp?; cluster?; coep?; hsts?; identifier? }`. |
| `CorsOptions`               | interface | `{ origin?; methods?; headers? }` — options for `createCors`.                                   |
| `DeadlineOptions`           | interface | `{ ms; status? }` — options for `createDeadline`.                                               |
| `ForwardedOptions`          | type      | `{ proxies } \| { trusted }` — exactly one, for `createForwarded`.                              |
| `ETagOptions`               | interface | `{ weak? }` — options for `createETag`.                                                         |
| `BearerOptions`             | interface | `{ secret; header?; scheme? }` — options for `createBearer`.                                    |
| `LimiterOptions`            | interface | `{ max; window; capacity?; key?; message?; clock?; policy? }`.                                  |
| `BearerState`               | interface | `{ token?: string }` — the state slice `createBearer` stashes.                                  |
| `IdentifierState`           | interface | `{ identifier?: string }` — the state slice `createSecurity` stashes.                           |
| `ClientInfo`                | interface | `{ readonly ip?: string }` — the resolved client connection facts.                              |
| `ClientState`               | interface | `{ client?: ClientInfo }` — the state slice `createForwarded` stashes.                          |
| `ConnectionState`           | interface | `{ connection?: ConnectionInfo }` — the socket-fact state slice `resolveKey` reads.             |
| `SessionInterface`          | interface | `{ id; data }` — a server-managed session's public surface.                                     |
| `SessionControlInterface`   | interface | `regenerate()` / `destroy()` — the mid-handler session control handle.                          |
| `SessionState`              | interface | `{ session?; control? }` — the state slice `createSession` stashes.                             |
| `SessionStoreInterface`     | interface | `get` / `set` / `delete` — the pluggable session persistence seam.                              |
| `SessionTransport`          | interface | `read` / `write` / `clear` — how a session id travels to/from the client.                       |
| `SessionOptions`            | interface | `{ transport; store?; ttl?; lifetime?; create?; mint?; require?; ends?; clock? }`.              |
| `CookieTransportOptions`    | interface | `{ name?; secret; cookie? }` — options for `createCookieTransport`.                             |
| `HeaderTransportOptions`    | interface | `{ header? }` — options for `createHeaderTransport`.                                            |
| `MemorySessionStoreOptions` | interface | `{ ttl?; lifetime? }` — options for `createMemorySessionStore`.                                 |
| `CSRFState`                 | interface | `{ csrf?: string }` — the state slice `createCSRF` stashes.                                     |
| `CSRFOptions`               | interface | `{ secret; cookie?; header?; field?; safe? }` — options for `createCSRF`.                       |
| `MultipartFile`             | interface | `{ field; name; size; mime; validated; status; path }` — one staged upload.                     |
| `MultipartBody`             | interface | `{ files; fields }` — the parsed multipart request body.                                        |
| `MultipartState`            | interface | `{ multipart?: MultipartBody }` — the state slice `createMultipart` stashes.                    |
| `StaticOptions`             | interface | `{ root; prefix?; index?; dotfiles?; cache?; etag?; fallback? }`.                               |
| `MultipartLimits`           | interface | `{ file?; files?; field?; fields?; total? }` — per-category mid-stream caps.                    |
| `MultipartOptions`          | interface | `{ limits?; allowed?; directory? }` — options for `createMultipart`.                            |
| `NodeCompressionOptions`    | interface | `{ threshold?; filter? }` — options for the node face's `createCompression`.                    |
| `MultipartReason`           | type      | `'limit' \| 'malformed' \| 'rejected'` — the axis `MultipartError` maps to a status.            |
| `UploadStatus`              | type      | `'staged' \| 'moved'` — a staged upload's temp-file lifecycle stage.                            |
| `UploadedFileInterface`     | interface | `{ field; name; size; mime; validated; status: UploadStatus; path }`.                           |

### Constants

| API                               | Kind  | Summary                                                                             |
| --------------------------------- | ----- | ----------------------------------------------------------------------------------- |
| `DEFAULT_COMPRESSION_THRESHOLD`   | const | Default minimum buffered body size (bytes) worth compressing (`1024`).              |
| `DEFAULT_COMPRESSION_ENCODINGS`   | const | Default codings offered, in preference order (`['gzip', 'deflate']`).               |
| `DEFAULT_FRAME_OPTIONS`           | const | Default `X-Frame-Options` value (`'DENY'`).                                         |
| `DEFAULT_CSP`                     | const | Default `Content-Security-Policy` value.                                            |
| `DEFAULT_REFERRER_POLICY`         | const | Default `Referrer-Policy` value (`'strict-origin-when-cross-origin'`).              |
| `DEFAULT_PERMISSIONS_POLICY`      | const | Default `Permissions-Policy` value.                                                 |
| `DEFAULT_COOP`                    | const | Default `Cross-Origin-Opener-Policy` value (`'same-origin'`).                       |
| `DEFAULT_CORP`                    | const | Default `Cross-Origin-Resource-Policy` value (`'same-origin'`).                     |
| `DEFAULT_CLUSTER`                 | const | Default `Origin-Agent-Cluster` value (`'?1'`).                                      |
| `DEFAULT_COEP`                    | const | The `coep: true` opt-in value (`'require-corp'`).                                   |
| `DEFAULT_HSTS`                    | const | The `hsts: true` opt-in value (`'max-age=31536000; includeSubDomains'`).            |
| `DEFAULT_IDENTIFIER_HEADER`       | const | The request-identifier header name (`'x-request-id'`).                              |
| `DEFAULT_CORS_METHODS`            | const | Default preflight-advertised methods.                                               |
| `DEFAULT_CORS_HEADERS`            | const | Default preflight-advertised headers.                                               |
| `DEFAULT_DEADLINE_STATUS`         | const | Default status returned when a deadline fires first (`503`).                        |
| `DEFAULT_BEARER_HEADER`           | const | Default bearer-token header (`'authorization'`).                                    |
| `DEFAULT_BEARER_SCHEME`           | const | Default bearer scheme prefix (`'Bearer'`).                                          |
| `DEFAULT_LIMITER_CAPACITY`        | const | Default max distinct rate-limit keys tracked (`10_000`).                            |
| `DEFAULT_LIMITER_MESSAGE`         | const | Default 429 body message.                                                           |
| `DEFAULT_SESSION_COOKIE`          | const | Default session cookie name (`'session'`).                                          |
| `DEFAULT_SESSION_HEADER`          | const | Default session header name (`'session-id'`).                                       |
| `DEFAULT_CSRF_COOKIE`             | const | Default CSRF cookie name (`'csrf'`).                                                |
| `DEFAULT_CSRF_HEADER`             | const | Default CSRF submission header (`'x-csrf-token'`).                                  |
| `DEFAULT_CSRF_FIELD`              | const | Default CSRF submission body field (`'_csrf'`).                                     |
| `DEFAULT_CSRF_SAFE_METHODS`       | const | Methods that mint instead of verify (`['GET', 'HEAD', 'OPTIONS']`).                 |
| `MULTIPART_REASON_STATUS`         | const | `MultipartReason` → HTTP status map (`limit`→413, `malformed`→400, `rejected`→415). |
| `DEFAULT_STATIC_INDEX`            | const | Default directory-index filename (`'index.html'`).                                  |
| `DEFAULT_STATIC_FALLBACK_EXCLUDE` | const | Default SPA-fallback excluded prefix (`'/api'`).                                    |
| `DEFAULT_CONTENT_TYPE`            | const | Fallback `Content-Type` for an unmapped extension.                                  |
| `DEFAULT_MULTIPART_FILE`          | const | Default max size (bytes) of one uploaded file (`10_485_760`).                       |
| `DEFAULT_MULTIPART_FILES`         | const | Default max number of file parts (`10`).                                            |
| `DEFAULT_MULTIPART_FIELD`         | const | Default max size (bytes) of one text field (`65_536`).                              |
| `DEFAULT_MULTIPART_FIELDS`        | const | Default max number of text field parts (`100`).                                     |
| `DEFAULT_MULTIPART_TOTAL`         | const | Default max combined request body size (bytes) (`52_428_800`).                      |
| `MULTIPART_MAX_HEADER_BLOCK`      | const | Max bytes a single multipart part header block may occupy (`16_384`).               |
| `RESERVED_DEVICE_NAMES`           | const | The Windows reserved-device-name set the static traversal guard refuses.            |
| `EXTENSION_TYPES`                 | const | The file-extension → `Content-Type` lookup table `lookupContentType` uses.          |

### Helpers — core

| API                         | Kind     | Summary                                                                                   |
| --------------------------- | -------- | ----------------------------------------------------------------------------------------- |
| `resolveKey`                | function | Derive a rate-limit bucket key: bearer token, then client IP, then connection IP.         |
| `buildRetryAfter`           | function | Build the `Retry-After` header value (whole seconds to reset, min 1).                     |
| `buildRateLimitField`       | function | Build the draft `RateLimit` structured header field.                                      |
| `buildRateLimitPolicyField` | function | Build the draft `RateLimit-Policy` structured header field.                               |
| `matchesTrustedEntry`       | function | Whether a client address matches one trusted CIDR/exact-match roster entry.               |
| `resolveForwardedFor`       | function | Walk `X-Forwarded-For` right-to-left past trusted hops to the client IP.                  |
| `detectEncodings`           | function | Feature-detect which candidate `Encoding`s the runtime's `CompressionStream` supports.    |
| `isBufferingIneligible`     | function | Whether a response must pass through untouched (HEAD, 204/304, SSE, already-encoded).     |
| `isCompressionNegotiated`   | function | Narrow a negotiated `Encoding` to one worth actually compressing with.                    |
| `rebuildResponse`           | function | Reconstruct a `Response` with a new body, copying status/headers (with overrides).        |
| `compressResponse`          | function | The shared compression decision skeleton — eligibility, negotiation, buffer, compress.    |
| `transferSessionData`       | function | Copy one session's `data` Map onto another — the `regenerate()` data-carry.               |
| `isSession`                 | function | Whether a value implements `SessionInterface`.                                            |
| `isSessionControl`          | function | Whether a value implements `SessionControlInterface`.                                     |
| `isMultipartFile`           | function | Whether a value implements `MultipartFile`.                                               |
| `isMultipartBody`           | function | Whether a value implements `MultipartBody`.                                               |
| `isPreflight`               | function | Whether a request is a CORS preflight (`OPTIONS` + `Access-Control-Request-Method`).      |
| `buildClientInfo`           | function | Build a `ClientInfo` from a resolved (or absent) client IP.                               |
| `equalsConstantTime`        | function | Constant-time string equality (avoids a timing oracle in the CSRF double-submit compare). |

### Helpers — node

| API                      | Kind     | Summary                                                                                           |
| ------------------------ | -------- | ------------------------------------------------------------------------------------------------- |
| `resolveStaticPath`      | function | The traversal-safe request-path-to-filesystem-path resolver (exact algorithm order load-bearing). |
| `isUnderPath`            | function | Segment-boundary under-path test shared by the traversal strip and the SPA `exclude`.             |
| `isReservedDeviceName`   | function | Whether a path segment is a Windows reserved device name (CVE-2025-27210).                        |
| `isDotfilePath`          | function | Whether a relative path has a dotfile segment.                                                    |
| `lookupContentType`      | function | Resolve a `Content-Type` from a file's extension.                                                 |
| `computeFileETag`        | function | Compute a weak file `ETag` from size + mtime (`W/"<size>-<floor(mtimeMs)>"`).                     |
| `detectMIME`             | function | Sniff a MIME type from a file's leading magic bytes.                                              |
| `multipartBoundary`      | function | Extract the multipart boundary token from a `Content-Type` header.                                |
| `parsePartHeaders`       | function | Parse one multipart part's raw header block into its field/filename/mime facts.                   |
| `resolveMultipartLimits` | function | Resolve `MultipartLimits` defaults into a fully-populated `Required<MultipartLimits>`.            |
| `parseMultipartRequest`  | function | Stream-parse a multipart request body into a `MultipartBody`, or `undefined`.                     |
| `createUploadedFile`     | function | Build a frozen `UploadedFileInterface` record.                                                    |
| `streamFile`             | function | Open a DOM `ReadableStream` over a file's bytes (optional byte range), for a `Response` body.     |
| `streamUploadedFile`     | function | Open a `ReadableStream` over a staged upload's on-disk bytes.                                     |
| `readUploadedFile`       | function | Read a staged upload's on-disk bytes into one `Uint8Array`.                                       |
| `moveUploadedFile`       | function | Relocate a staged upload's temp file (rename, with EXDEV copy+unlink fallback).                   |

### Entities

| API                  | Kind  | Summary                                                                               |
| -------------------- | ----- | ------------------------------------------------------------------------------------- |
| `Session`            | class | The default session entity — `id` + a live `data` Map; implements `SessionInterface`. |
| `MemorySessionStore` | class | The default in-process `SessionStoreInterface` — idle + absolute-lifetime eviction.   |

### Factories

| API                        | Kind     | Summary                                                    |
| -------------------------- | -------- | ---------------------------------------------------------- |
| `createCookieTransport`    | function | Build a signed-cookie `SessionTransport`.                  |
| `createHeaderTransport`    | function | Build a bare-header `SessionTransport`.                    |
| `createMemorySessionStore` | function | Build a `MemorySessionStore` as a `SessionStoreInterface`. |

### Errors

| API                | Kind     | Summary                                                                           |
| ------------------ | -------- | --------------------------------------------------------------------------------- |
| `MultipartError`   | class    | An error `createMultipart` throws — carries a `MultipartReason`-derived `status`. |
| `isMultipartError` | function | Narrow an unknown caught value to a `MultipartError`.                             |

## Methods

The public methods of `SessionControlInterface`, `SessionStoreInterface`, and
`SessionTransport` — the three behavioral seams `createSession` composes
(their `readonly` data members, where any exist, stay Surface rows above).

#### `SessionControlInterface`

`regenerate` is the OWASP anti-fixation primitive (rotate the id, keep the
data); `destroy` ends the session outright. Both record intent
SYNCHRONOUSLY; the store I/O and transport write happen after `next()`
returns (`destroy` supersedes a prior `regenerate`).

| Method       | Returns | Behavior                                                               |
| ------------ | ------- | ---------------------------------------------------------------------- |
| `regenerate` | `void`  | Mint a new id, carry the session's `data` over, invalidate the old id. |
| `destroy`    | `void`  | End the session — deletes it from the store and clears its transport.  |

#### `SessionStoreInterface`

The pluggable point-access persistence seam (AGENTS §5 store mold) —
`get`/`set`/`delete`, every primitive async with a trailing injected `now`.

| Method   | Returns                   | Behavior                                                           |
| -------- | ------------------------- | ------------------------------------------------------------------ |
| `get`    | `Promise<S \| undefined>` | Read a session by id, applying idle/absolute expiry against `now`. |
| `set`    | `Promise<void>`           | Persist a session's current state, refreshing its idle window.     |
| `delete` | `Promise<void>`           | Remove a session by id — a no-op on an absent id, never throws.    |

#### `SessionTransport`

How a session id travels to and from the client — `read` is total (never
throws); `write`/`clear` mutate the RETURNED `Response` on the way out (the
returning onion makes "before send" automatic).

| Method  | Returns                               | Behavior                                                                                       |
| ------- | ------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `read`  | `string \| undefined \| Promise<...>` | Read the incoming session id from the request — `undefined` on any failure.                    |
| `write` | `void \| Promise<void>`               | Write a freshly-minted or regenerated session id + encrypted-transport fact onto the response. |
| `clear` | `void`                                | Clear the transport's credential on `destroy()`.                                               |

## Contract

These invariants hold across `src/core` / `src/server` ↔ `middleware.md`.

1. **DOC ↔ SOURCE bijection.** Every `function` / `class` / `interface` /
   `type` / `const` row in the `## Surface` tables is a real export of its
   source directory, and every export appears as a Surface row — exhaustive,
   both directions (AGENTS §22).
2. **DOC ↔ SOURCE method bijection.** The `## Methods` tables list exactly
   `SessionControlInterface`'s, `SessionStoreInterface`'s, and
   `SessionTransport`'s public methods — exhaustive, both directions (AGENTS
   §22).

### The ordering doctrine (PROPOSAL §5)

The canonical onion, outermost first, and the failure each position
prevents:

3. **`createTelemetry` is outermost.** It sees the mapped status (after
   `createBoundary` renders) and measures honest wall-clock duration —
   anything mounted inside it would be excluded from the timing.
4. **`createCompression` sits OUTSIDE `createBoundary`.** An error `Response`
   the boundary renders from a caught throw still passes through
   compression — mount it inside instead and error bodies ship uncompressed.
5. **`createBoundary` is the renderer.** Everything mounted BENEATH it may
   throw `HTTPError` (or anything else) and have it mapped to a `Response`;
   nothing below it needs its own try/catch.
6. **`createDeadline` sits INSIDE the boundary.** A downstream `AbortError`
   from the deadline firing is just another throw the boundary maps cleanly
   — mounting it outside would bypass that rendering.
7. **`createSecurity` is a documented tradeoff, not a fixed position.** The
   canonical order places it INSIDE the boundary, so an error `Response` a
   handler explicitly RETURNS still carries security headers, but an error
   the boundary RENDERS FROM A THROW does not (`createSecurity`'s `next()`
   never resolves for a throw beneath it). A consumer who wants headers on
   every response, thrown errors included, mounts `createSecurity` ABOVE
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
10. **`createETag` sits INNER of `createCompression`.** The hash is computed
    over the UNCOMPRESSED representation — hashing the compressed bytes
    would break revalidation the instant the negotiated coding changes.
11. **`createBearer` sits before `createLimiter`.** The limiter's default key
    derivation prefers `BearerState.token` (the `token:<value>` idiom) over
    a client-IP fallback — bearer must have already stashed it.
12. **`createBody` sits before `createSession`/`createCSRF`.** `createSession`'s
    async `mint` and `createCSRF`'s `_csrf` body-field read both need the
    cached `context.body()` already resolved.
13. **`createSession` sits before `createCSRF`.** CSRF's session-binding
    (§6 below) requires `context.state.session` to already be stashed.

### The security acceptance bar (PROPOSAL §6), as documented behavior

14. **CORS.** `Vary: Origin` is merged only on the reflect (allow-list) path,
    never on the `'*'` wildcard path; the literal `Origin: null` is NEVER
    reflected even when the string `'null'` is allow-listed.
15. **Headers.** A hostile `X-Request-ID` (off-charset, oversize, or
    CRLF-bearing) is never echoed — `createSecurity` mints a fresh
    `crypto.randomUUID()` instead; a custom `csp` string REPLACES the
    default wholesale (never merges); `X-Content-Type-Options: nosniff` is
    unconditional, with no opt-out.
16. **Bearer.** `verifyToken` is TOTAL over garbage, tampered, expired, or
    empty-rotation input — every failure renders `401`, never a crash;
    verification is constant-time via `crypto.subtle.verify`.
17. **Limiter.** The key derivation NEVER reads `X-Forwarded-For` itself (only
    `createForwarded`'s already-resolved `ClientState` does, when mounted) —
    so an unmounted `createForwarded` leaves XFF completely untrusted;
    same-socket requests with different XFF values still share one bucket
    without it; IPv6 addresses collapse to their `/64` network via
    `ipv6Network`/`clientRateKey`; the exhausted check runs BEFORE `consume`,
    admitting exactly `max` requests per window; capacity eviction is
    oldest-inserted (FIFO), never resettable by an attacker re-requesting
    a hot key.
18. **Body.** `createBody` maps a malformed-JSON `undefined` resolution to a
    `400`; the size/decompression caps and the `__proto__`/`constructor`/
    `prototype` scrub are the substrate's own `readBody` behavior
    (`ServerOptions.limit`) — this battery only drives the cache eagerly and
    maps its outcomes.
19. **Session.** The default `MemorySessionStore` enforces BOTH an idle
    timeout (`ttl`, lazy eviction on `get`) AND an absolute lifetime
    (`lifetime`, evicting even a continuously-touched session — `createdAt`
    is stamped once at first `set` and preserved across every later
    re-persist); `control.regenerate()` rotates the id while carrying the
    session's `data` over and invalidating the old id; a signed cookie
    transport inherits the full substrate injection-hardening matrix
    (`__Host-` spoof rejection, `Domain`/`Path` injection throws,
    `SameSite=None` forces `Secure`, `Secure` derived from the connection's
    TLS fact when omitted).
20. **CSRF.** With a session ahead, the minted token is bound to that
    session's id (`signToken(sessionId)`) — a mutating request's recovered
    bound id must equal ITS OWN session's id, so a token minted under
    session A replayed against session B is `403` even with matching
    double-submit halves; without a session, `createCSRF` falls back to
    signed-random double-submit (documented weaker — no cross-session
    binding is possible without one).
21. **Static.** The traversal guard's algorithm order is load-bearing —
    strip `prefix` on a segment boundary, `decodeURIComponent` (refusing
    malformed escapes), reject NUL, make relative BEFORE `normalize` (so a
    leading `..` survives as a climbing segment), `normalize`, refuse a
    Windows reserved-device segment (`NUL.json` refused, `nullable.css`
    served), then `resolve` under `root` and require containment; a
    multi-range or malformed `Range` header serves the FULL body (`200`),
    never a partial guess; the SPA fallback shell path is a fixed,
    non-user-controlled join — never re-run through the traversal resolver.
22. **Multipart.** A declared `Content-Type` whose SNIFFED (magic-byte)
    bytes disagree is rejected `415`, as is a signature-less declared type
    on an `allowed` list (sniffing cannot validate it — a list can never
    honestly allow it); staged temp filenames are `randomUUID()`, never
    derived from the client-declared filename (traversal-by-filename is
    impossible by construction); every limit trips MID-STREAM with already-
    staged files cleaned up; a mid-upload client disconnect triggers the
    same fail-closed cleanup.
23. **Boundary.** `expose: false` leaks nothing (a non-`HTTPError` throw's
    message never reaches the body); an `HTTPError`'s own `message` ALWAYS
    surfaces (it is the handler's deliberate signal); a `report` sink's own
    throw is swallowed and can never alter the response.

## Patterns

### Canonical onion — fetch-native runtime

The full §5 ordering, composed directly over `compose` (no `@orkestrel/server`
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
await store.set('id-1', new Session('id-1'), now)
await store.get('id-1', now) // resolves the session, or undefined if expired
await store.delete('id-1') // no-op on an already-absent id
```

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

resolveMultipartLimits({ file: 1_048_576 }) // fills in every other default cap
```

### Static: SPA fallback

```ts
import { createStatic } from '@orkestrel/middleware/server'

const serveApp = createStatic({ root: '/srv/public', fallback: true }) // excludes '/api' by default
```

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
  runs, `context.body()` must NOT be called for that request — the
  underlying stream is exhausted.
- **`SessionTransport.write`/`clear` mutate the RETURNED `Response` on the
  way out.** `createSession` applies store I/O and transport writes AFTER
  `next()` resolves: `destroy()` → `store.delete` + `transport.clear`;
  `regenerate()` → `store.set` the new session, `store.delete` the old,
  `transport.write` the new id; otherwise → `store.set` the resolved/minted
  session, `transport.write` only when freshly minted. `destroy()`
  supersedes a prior `regenerate()`.

### Practices

- **Mount `createTelemetry` and `createCompression` OUTSIDE `createBoundary`**
  — error bodies still compress, and duration still measures the whole
  onion (Contract §3–4).
- **Mount `createForwarded` before anything that keys off `ClientState`** —
  `createLimiter`'s default key and any client-IP-sensitive logic
  downstream (Contract §9).
- **Never derive a rate-limit key from `X-Forwarded-For` yourself** — mount
  `createForwarded` and let its resolved `ClientState` do it (§6.17).
- **Call `control.regenerate()` on every privilege change** (login,
  elevation) — the OWASP anti-fixation requirement session-based auth
  depends on.
- **Install a `report` sink on `createBoundary`** for observability — its
  own throw is swallowed, so it can never crash a response.
- **Pick your `createSecurity` position deliberately** — inside the
  boundary (default; headers only on returned responses) or above it
  (headers on every response, thrown errors included) — see Contract §7.

## Tests

- [`tests/src/core/helpers.test.ts`](../../tests/src/core/helpers.test.ts) —
  `resolveKey` precedence, `buildRetryAfter`/`buildRateLimitField`/
  `buildRateLimitPolicyField` exact wire strings, `matchesTrustedEntry`/
  `resolveForwardedFor` matrices, `detectEncodings`, buffering-eligibility
  predicates, `transferSessionData`, the `isSession`/`isSessionControl`/
  `isMultipartBody` totality guards, `isPreflight`, `buildClientInfo`.
- [`tests/src/core/Session.test.ts`](../../tests/src/core/Session.test.ts) —
  the entity shape (`id`, an independent, mutable `data` Map per instance).
- [`tests/src/core/MemorySessionStore.test.ts`](../../tests/src/core/MemorySessionStore.test.ts) —
  construction guards, get/set/delete, idle + absolute-lifetime eviction,
  `createdAt` stamped once and preserved across re-set.
- [`tests/src/core/factories.test.ts`](../../tests/src/core/factories.test.ts) —
  `createCookieTransport`/`createHeaderTransport` round-trips over real
  `Request`/`Response`, `createMemorySessionStore` shallow mirror.
- [`tests/src/core/middlewares.test.ts`](../../tests/src/core/middlewares.test.ts) —
  every battery's defaults, options, skip conditions, and §6 invariants;
  the canonical onion composed end-to-end.

## See also

- [`AGENTS.md`](../../AGENTS.md) — the rules; §5 the centralized-file
  pattern and `middlewares.ts`'s kind-purity, §14 contract & validation
  architecture, §21 "mechanism, never policy", §22 documentation-as-contracts.
- [`server.md`](server.md) — `@orkestrel/server`, the frozen seam and
  substrate every battery in this package is built over.
- [`contract.md`](contract.md) — `@orkestrel/contract`, the guards backing
  every construction boundary.
- [`budget.md`](budget.md) — `@orkestrel/budget`, `createLimiter`'s per-key
  tally.
- [`abort.md`](abort.md) / [`timeout.md`](timeout.md) — `@orkestrel/abort` /
  `@orkestrel/timeout`, `createDeadline`'s signal-linking and timer.
- [`README.md`](../README.md) — the guides index.
