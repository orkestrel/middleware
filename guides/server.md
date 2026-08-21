# Server

> This package's ONE guide (AGENTS §22 — one guide per package), covering its
> single published surface: the middleware seam (`compose`,
> `MiddlewareContext`/`NextFunction`/`MiddlewareHandler`), the `HTTPError`
> vocabulary, the shared substrate (cookies, WebCrypto tokens, content
> negotiation via `Negotiator`, ETag/Range, security primitives, SSE, and the
> body pipeline), and the deliberately node-bound `Server` lifecycle entity
> binding `node:http` via `@orkestrel/router`'s adapter helpers, the upgrade
> seam, connection-fact injection, and `discoverPort`. The server
> **consumes** `@orkestrel/router` — routing, matching, and dispatch are that
> package's, never re-implemented here (AGENTS §21 "mechanism, never
> policy"). Source: [`src/server`](../src/server). Surfaced through the
> `@orkestrel/server` barrel (aliased `@src/server` inside this repo).

## Surface

Bring your own `@orkestrel/router` dispatcher, mount middleware, and start:

```ts
import type { MiddlewareHandler } from '@orkestrel/server'
import { createServer } from '@orkestrel/server'
import { createDispatcher } from '@orkestrel/router'

interface State {
	readonly requestId: string
}

const dispatcher = createDispatcher<State>()
dispatcher.add({
	method: 'GET',
	path: '/users/:id',
	handler: (_request, context) =>
		Response.json({ id: context.params.id, requestId: context.state.requestId }),
})

const withRequestId: MiddlewareHandler<State> = async (_request, context, next) => {
	const response = await next()
	response.headers.set('X-Request-ID', context.state.requestId)
	return response
}

const server = createServer<State>({
	dispatcher,
	state: () => ({ requestId: crypto.randomUUID() }),
	middleware: [withRequestId],
})
const port = await server.start()
server.address // { address, family, port } for the bound listener
await server.stop()
```

A route handler reads `context.state` exactly as middleware wrote it — the
composed onion terminates in `dispatcher.handle(request, context.state)`, so
there is no second plumbing between the middleware seam and the router.

Cross-face and substrate usage appear under [Patterns](#patterns).

### Factories

| API                | Kind     | Summary                                                                   |
| ------------------ | -------- | ------------------------------------------------------------------------- |
| `createNegotiator` | function | Create a `NegotiatorInterface` — the content-negotiation machine.         |
| `createServer`     | function | Create a `ServerInterface<TState>` over a consumed `DispatcherInterface`. |

### Constants

| API                          | Kind  | Summary                                                                                                                                        |
| ---------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEFAULT_DRAIN_MS`           | const | Default graceful-stop deadline (ms) `stop()` gives in-flight requests and claimed upgraded sockets.                                            |
| `DEFAULT_BODY_LIMIT`         | const | Default maximum request body size (bytes) `readBody` accepts before a 413.                                                                     |
| `DEFAULT_DECOMPRESSED_LIMIT` | const | Default maximum DECOMPRESSED body size (bytes) — the zip-bomb cap.                                                                             |
| `SSE_HEADERS`                | const | The response headers `openStream` always sets for an SSE stream.                                                                               |
| `REQUEST_ID_PATTERN`         | const | The strict charset `isValidRequestId` requires an `X-Request-ID` to match.                                                                     |
| `COMPRESSIBLE_TYPES`         | const | The bare `Content-Type`s `isCompressibleType` treats as compressible.                                                                          |
| `HTTP_ERROR_BRAND`           | const | The `Symbol.for`-interned brand `HTTPError` carries so `isHTTPError` recognizes an instance across package copies. Not a field to set by hand. |
| `DEFAULT_ENCODINGS`          | const | The default `Encoding` content-codings the substrate offers, in preference order.                                                              |

### Helpers

| API                     | Kind     | Summary                                                                                                                                     |
| ----------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `compose`               | function | Compose an ordered middleware chain around a `terminal` handler (the frozen seam).                                                          |
| `wrapMiddleware`        | function | Wrap one middleware layer around its downstream handler while enforcing the one-call `next` invariant.                                      |
| `parseCookies`          | function | Parse a raw `Cookie:` header into a `name → value` lookup.                                                                                  |
| `isCookieName`          | function | Whether a string is a valid RFC 6265 cookie name (no whitespace).                                                                           |
| `decodeCookieValue`     | function | Decode a cookie value, falling back to raw text on malformed escapes.                                                                       |
| `isCookieAttribute`     | function | Whether a string is safe to interpolate as a `Domain`/`Path` attribute value.                                                               |
| `serializeCookie`       | function | Serialize a cookie into a `Set-Cookie` header value with its attributes.                                                                    |
| `resolveSecure`         | function | Resolve a cookie's effective `Secure` flag from its setting + the TLS fact.                                                                 |
| `appendCookie`          | function | Append a `Set-Cookie` header onto `Headers` without clobbering a prior one.                                                                 |
| `writeSignedCookie`     | function | Write a SIGNED cookie (`signToken` + `Set-Cookie`).                                                                                         |
| `readSignedCookie`      | function | Read + verify a SIGNED cookie off a request — total, returns `undefined` on any failure.                                                    |
| `clearCookie`           | function | Clear a cookie via an immediately-expiring `Set-Cookie`.                                                                                    |
| `encodeBase64Url`       | function | Base64url-encode a byte sequence.                                                                                                           |
| `decodeBase64Url`       | function | Decode a base64url string back into its bytes.                                                                                              |
| `signToken`             | function | Sign a value into a stateless, HMAC-SHA256 token.                                                                                           |
| `verifyToken`           | function | Verify a stateless token and return its embedded value — total, never throws.                                                               |
| `decodeTokenPayload`    | function | Decode + narrow a signed token's payload, honoring its expiry.                                                                              |
| `normalizeSecret`       | function | Normalize a `TokenSecret` to a concrete list of usable secrets.                                                                             |
| `parseAcceptHeader`     | function | Parse a weighted `Accept`-family header into its q-sorted entries.                                                                          |
| `codingQuality`         | function | The client's quality for one content-coding from parsed `Accept-Encoding` entries.                                                          |
| `negotiateEncoding`     | function | Select the best content-coding for an `Accept-Encoding` header.                                                                             |
| `matchMediaType`        | function | Rank + quality of one candidate media type against parsed `Accept` entries.                                                                 |
| `languageQuality`       | function | The client's quality for one candidate language from parsed `Accept-Language` entries.                                                      |
| `isCompressibleType`    | function | Whether a `Content-Type` is worth compressing.                                                                                              |
| `computeBodyETag`       | function | Compute a content `ETag` over a fully-buffered response body via WebCrypto.                                                                 |
| `unwrapETag`            | function | Strip the weak indicator (`W/`) from an entity-tag.                                                                                         |
| `matchesETag`           | function | Whether a request's `If-None-Match` matches a resource's current `ETag` (RFC 7232 weak comparison).                                         |
| `parseRange`            | function | Parse an HTTP `Range` header against a known resource size — total.                                                                         |
| `resolveOrigin`         | function | Resolve the `Access-Control-Allow-Origin` value for a request.                                                                              |
| `mergeVary`             | function | Merge a `Vary` value into an existing `Vary` header without duplication.                                                                    |
| `resolveSecurityHeader` | function | Resolve one opt-out, value-bearing security header.                                                                                         |
| `isValidRequestId`      | function | Whether a client-supplied `X-Request-ID` is safe to echo back.                                                                              |
| `ipv6Network`           | function | Compute the `/64` network of a full IPv6 address, or `undefined`.                                                                           |
| `clientRateKey`         | function | Collapse a client IP into its rate-limit bucket key (IPv6 `/64`, IPv4 unchanged).                                                           |
| `serializeEvent`        | function | Serialize one `SSEMessage` to the SSE wire.                                                                                                 |
| `enqueueStreamText`     | function | Enqueue encoded text into an open byte stream, safely ignoring closed or unstarted streams.                                                 |
| `openStream`            | function | Open a generic Server-Sent-Events stream whose producer can observe and await process-local queue backpressure.                             |
| `isDangerousKey`        | function | Whether a key is a prototype-pollution vector (`__proto__`/`constructor`/`prototype`).                                                      |
| `scrubPrototype`        | function | Recursively strip prototype-pollution keys from a parsed value in place.                                                                    |
| `collectRequestBody`    | function | Collect a `Request` body into one `Uint8Array`, enforcing a size limit.                                                                     |
| `requestEncoding`       | function | Narrow a raw `Content-Encoding` header to a decompressible `Encoding`.                                                                      |
| `decompressRequestBody` | function | Transparently decompress a collected body, capping decompressed output (the zip-bomb defense).                                              |
| `readBody`              | function | Collect + decode a `Request` body — the pipeline behind `context.body()`.                                                                   |
| `isHTTPError`           | function | Narrow an unknown caught value to an `HTTPError` (including subclasses) — recognized across package copies via a structural brand fallback. |
| `isAddressInfo`         | function | Whether a `node:net` address is the structured `AddressInfo` shape.                                                                         |
| `probePort`             | function | Bind and close one throwaway TCP server to resolve an available port.                                                                       |
| `discoverPort`          | function | Find a free TCP port — try a `preferred` one first, else an ephemeral port.                                                                 |

### Entities

| API                    | Kind  | Summary                                                                                                                     |
| ---------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------- |
| `HTTPError`            | class | An error a handler throws to produce an HTTP response of a specific status.                                                 |
| `ContentTooLargeError` | class | The `HTTPError` (413) thrown when a request body exceeds its size limit.                                                    |
| `Negotiator`           | class | The content-negotiation machine over the weighted `Accept` family; implements `NegotiatorInterface`.                        |
| `Server`               | class | The `node:http` lifecycle entity composing the middleware onion around a consumed dispatcher; implements `ServerInterface`. |

### Types

| Type                      | Kind      | Shape                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MiddlewareContext`       | interface | `{ url; method; state; body() }` — the per-request composition context.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `NextFunction`            | type      | `(request?) => Promise<Response>` — the double-`next`-guarded continuation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `MiddlewareHandler`       | type      | `(request, context, next) => Response \| Promise<Response>` — one onion link.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `ConnectionInfo`          | interface | `{ ip?; encrypted }` — the adapter-injected per-request connection facts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `TokenSecret`             | type      | `string \| readonly string[]` — a secret or `[current, ...older]` rotation list.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `TokenOptions`            | interface | `{ secret; ttl? }` — options for `signToken`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `CookieOptions`           | interface | `{ path?; domain?; maxAge?; httpOnly?; secure?; sameSite? }` — `Set-Cookie` attributes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `AcceptEntry`             | interface | `{ value; q }` — one parsed weighted-header entry.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `Encoding`                | type      | `'gzip' \| 'deflate' \| 'identity'` — the compression coding vocabulary.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `FormatHandlerMap`        | type      | Media type → responder table for `NegotiatorInterface.format`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `NegotiatorInterface`     | interface | `negotiate` / `encoding` / `language` / `format` — the content-negotiation contract.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `SSEMessage`              | interface | `{ data; event?; id?; retry? }` — one Server-Sent Event.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `StreamOptions`           | interface | `{ status?; headers? }` — options for `openStream`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `StreamInterface`         | interface | `response` / `closed` data members + `write` / `comment` / `drain` / `end`; `write` returns local queue readiness and `drain` parks until capacity or closure.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `RangeSpec`               | type      | `{ satisfiable: true; start; end } \| { satisfiable: false }` — a parsed `Range`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `BodyOptions`             | interface | `{ limit?; decompression? }` — caps for `readBody`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `ServerStatus`            | type      | `'idle' \| 'starting' \| 'listening' \| 'stopping' \| 'stopped'` — the AGENTS §10 lifecycle.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `ServerEventMap`          | type      | `{ start; request; upgrade; error; stop; drain; response }` — the `Server`'s AGENTS §13 event map. `error`'s second element and `report`'s second parameter are an OPTIONAL `{ method, url }` — present for a request-pipeline fault, `undefined` for an upgrade-path fault (no fetch `Request` exists there). `response` fires with `{ method, pathname, status, ms }` for every request reaching the middleware pipeline (success or outer-boundary error path) — not for one rejected at the inner `buildRequest` boundary (plain `400`, no parsed `Request` to derive facts from). `drain` carries `(pending, upgraded)` — the requests still in flight and the upgraded sockets still attached when the drain settled; both `0` means the close that followed was clean, either non-zero means it was forced. |
| `UpgradeHandler`          | type      | `(request, socket, head) => boolean` — a raw protocol-upgrade claimant. A claimed socket is tracked until it closes, so `stop()` can drain and then cut it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `ConnectionStateFunction` | type      | `(connection: ConnectionInfo) => TState` — derives a request's `TState`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `ServerOptions`           | interface | `{ dispatcher; state; middleware?; host?; port?; drain?; limit?; expose?; report?; timeouts?; sockets?; on?; error? }` — `timeouts.start` bounds listener startup; `sockets.{connections,headers,requests}` maps to node's `maxConnections` / `maxHeadersCount` / `maxRequestsPerSocket`; `report?: (error, request?) => void`, `request` present only for a request-pipeline fault.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `ServerInterface`         | interface | `id` / `status` / `port` / `address` / `dispatcher` / `emitter` data members + `use` / `upgrade` / `start` / `stop` / `destroy`. `address` is the bound node `AddressInfo` while the listener is active and `undefined` otherwise.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

The `value`/`q` members of `AcceptEntry`, the `response`/`closed` members of
`StreamInterface`, and the `id` / `status` / `port` / `address` / `dispatcher` /
`emitter` members of `ServerInterface` are all `readonly` data members (Surface rows,
above) — the call-signature methods of `NegotiatorInterface`,
`StreamInterface`, and `ServerInterface` are documented under
[Methods](#methods).

## Methods

The public methods of `NegotiatorInterface`, `StreamInterface`, and
`ServerInterface` — every call-signature member listed (their `readonly` data
members stay Surface rows). `Negotiator` and `Server` implement their
interfaces exactly, so their tables also double as each class's
instance-method surface (AGENTS §22).

#### `NegotiatorInterface`

`negotiate` is the generic media-type primitive; `encoding` / `language` are
its sibling axes over the same q-value parser; `format` is the dispatcher —
it reads the request `Accept`, negotiates a `FormatHandlerMap`'s keys, and
invokes the winner, or answers `406`.

| Method      | Returns                 | Behavior                                                                    |
| ----------- | ----------------------- | --------------------------------------------------------------------------- |
| `negotiate` | `string \| undefined`   | Pick the best `available` value for a weighted `Accept`-style header.       |
| `encoding`  | `Encoding \| undefined` | Pick the best `available` content-coding for an `Accept-Encoding` header.   |
| `language`  | `string \| undefined`   | Pick the best `available` language for an `Accept-Language` header.         |
| `format`    | `Promise<Response>`     | Dispatch to the handler whose media type the client most prefers, or `406`. |

#### `StreamInterface`

`write` always accepts an event while open and returns whether the local
`ReadableStream` queue still has positive desired size afterward. A producer
receiving `false` parks on `drain` before writing again. This is process-local
queue state, not proof that the remote peer consumed bytes; the router's
drain-honoring response pump makes socket pressure stop pulls so the local
queue can faithfully signal that transport pressure. Ignoring the boolean
preserves the prior unconditional-enqueue behavior. The default queue strategy
counts chunks rather than their byte lengths, so a producer needing a byte
bound must also cap each individual event. The route must return `response`
before its producer awaits a `false` write, because no consumer can pull the
body before receiving that response.

| Method    | Returns         | Behavior                                                                                                                                   |
| --------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `write`   | `boolean`       | Serialize and enqueue one event; report positive local queue capacity afterward (`false` also when already closed).                        |
| `comment` | `void`          | Enqueue one SSE comment/keep-alive line; safely do nothing once closed.                                                                    |
| `drain`   | `Promise<void>` | Resolve on the pull that restores positive local queue capacity, or immediately when already writable/closed; event-driven, never polling. |
| `end`     | `void`          | Close the response stream; safely do nothing once already closed and settle any parked producer.                                           |

#### `ServerInterface`

`use` mounts middleware (§9.2 batch — one handler or an array); `upgrade`
registers a raw protocol-upgrade claimant; `start` binds the listener and
resolves the actually-bound port while accepting an optional caller
`AbortSignal`; `stop` gracefully drains then closes; `destroy` is the
terminal, idempotent teardown. Both always resolve: an upgraded socket a
handler claimed is drained up to the `drain` deadline and then destroyed,
never waited on forever.

| Method    | Returns           | Behavior                                                                                                                       |
| --------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `use`     | `void`            | Mount one middleware, or many (§9.2 batch), appended outer-to-inner in call order.                                             |
| `upgrade` | `void`            | Register an `UpgradeHandler` claimant (fan-out in registration order); a claimed socket is tracked until it closes.            |
| `start`   | `Promise<number>` | Bind the configured `host`/`port` (or an ephemeral one), cancellable by an optional `AbortSignal`, and resolve the bound port. |
| `stop`    | `Promise<void>`   | Refuse new connections, fire the stop signal, drain requests and upgraded sockets up to the deadline, then close.              |
| `destroy` | `Promise<void>`   | The terminal, idempotent teardown — force-closes any live listener and socket, then tears down the `#emitter`.                 |

## Contract

These invariants hold across `src/server` ↔ `server.md`.

1. **DOC ↔ SOURCE bijection.** Every `function` / `class` / `interface` /
   `type` / `const` row in the `## Surface` tables is a real export of its
   source directory, and every export appears as a Surface row — exhaustive,
   both directions (AGENTS §22).
2. **DOC ↔ SOURCE method bijection.** The `## Methods` tables list exactly
   `NegotiatorInterface`'s and `ServerInterface`'s public methods — exhaustive,
   both directions — and `Negotiator` / `Server` expose the same public
   methods, no more (AGENTS §22).
3. **Status machine + bound address + restart-fresh-abort.** `idle → starting → listening →
stopping → stopped`; `start()` from `listening`/`starting`/`stopping`
   rejects; each `start()` mints a FRESH stop signal, so a restarted server is
   never born aborted; `address` is the real bound `AddressInfo` after a
   successful start and `undefined` before start and after stop or destroy;
   `stop()`/`destroy()` are idempotent no-ops from a state with nothing to tear
   down; `EADDRINUSE` rejects `start()` outright — no
   silent ephemeral fallback (use `discoverPort` up front for a guaranteed-free
   port).
4. **Startup is bounded and caller-cancellable.** `start(signal?)` observes
   caller cancellation only while binding; `timeouts.start` independently
   bounds the bind (`0` permits no startup window). Cancellation or deadline
   expiry closes the partial listener, clears the startup deadline, resets
   the entity to `idle`, and rejects; expiry rejects with a `DOMException`
   named `TimeoutError`, while caller cancellation rejects with that signal's
   `reason`. A later `start()` is therefore permitted. Aborting the caller
   signal after a successful start does not stop a live server.
5. **Graceful drain is event-driven, never a busy-loop.** `stop()` fires the
   stop signal, arms a `@orkestrel/timeout` deadline, and PARKS on the
   drainable count reaching zero OR the deadline firing (a wake-park, not
   polling); it then emits `drain` with the still-pending counts and closes —
   dropping idle keep-alive sockets always, force-closing every open socket
   only when the deadline fired with work still pending (or on `destroy()`).
   Drainable work is every in-flight REQUEST plus every upgraded SOCKET a
   handler claimed, because a long-lived upgraded connection is work a
   graceful stop should let finish rather than cut mid-frame. `drain` carries
   both counts, so a caller can tell a clean stop from a forced one. This is
   also what makes `stop()` and `destroy()` ALWAYS resolve: node detaches an
   upgraded socket from its own connection set, so neither
   `closeIdleConnections()` nor `closeAllConnections()` reaches it while
   `server.close()` still waits on it, and the server therefore tracks each
   claimed socket until it closes and destroys the survivors itself on a
   forced close. The claimant still owns the socket; tracking only watches it.
   A handler that wants a protocol-clean goodbye — a WebSocket close frame —
   sends it on the `stop` event, which fires before the drain begins, and the
   drain then settles on that close instead of running the deadline out. A
   socket nothing closes costs `stop()` the whole `drain` budget and is then
   cut, so lower `drain` for a faster shutdown.
6. **The built-in boundary is lifecycle machinery, not policy — one seam
   that spans setup AND dispatch.** The `Server` wraps the WHOLE per-request
   lifecycle in two nested phases of the same boundary. The innermost phase
   covers only `buildRequest`: a malformed request (e.g. an unparsable `Host`)
   answers a plain `400`, with no `error` emit, no `report` call, and no
   `response` emit, since nothing downstream ever ran and no parsed `Request`
   exists yet to derive its facts from. The outer phase covers everything
   after —
   a throwing `this.#state(connection)` through the middleware/dispatcher
   run — where a thrown `HTTPError` renders as its own status + message; any
   other throw renders `500` with its message hidden unless `expose` is set,
   `report` is invoked with the caught error PLUS the originating request's
   `{ method, url }` (its own throw swallowed so reporting can never crash
   the response), and `error` is emitted with that same `{ method, url }` as
   its second argument. Beneath this single seam sits one server-owned last
   resort: if writing the mapped response itself throws, the connection is
   destroyed rather than left half-written or crashing the process — the
   middleware package may still ship a richer boundary that short-circuits
   earlier. On both the success path and this outer-boundary error path, a
   `response` event fires once the response has been sent, carrying
   `{ method, pathname, status, ms }` — so observability covers every request
   that reached the middleware pipeline, exactly once, regardless of outcome.
   A request rejected at the inner `buildRequest` boundary above is the one
   exception: it emits no `response` at all.
7. **Upgrade fan-out is isolated, first-claimer-wins.** Registered
   `UpgradeHandler`s run in registration order; the first to return `true`
   CLAIMS the socket and stops the fan-out; a handler that THROWS is treated as
   declined (the throw surfaces on `error` with NO request context — `error`'s
   second argument is `undefined` on the upgrade path, since no fetch
   `Request` exists there, only a raw `IncomingMessage` — and never crashes
   the process) and the fan-out continues; an upgrade nothing claims destroys
   the socket so it never leaks a dangling connection. A CLAIMED socket is
   tracked until it closes, which is what item 5's drain and forced close
   act on — ownership stays with the claimant either way.
8. **Body read exactly once, capped, zip-bomb-safe, scrubbed.**
   `MiddlewareContext.body()` is lazy and CACHED, so a body-parsing middleware
   and the eventual handler both reading it consume the underlying stream
   exactly once; `readBody` caps the wire size (`ContentTooLargeError`/413 over
   `limit`), transparently decompresses a `gzip`/`deflate` body through a
   byte-counting `TransformStream` that ABORTS the instant decompressed output
   would exceed `decompression` (fail BEFORE materializing a decompression
   bomb, since `DecompressionStream` has no `maxOutputLength`), and scrubs
   `__proto__`/`constructor`/`prototype` keys from a parsed JSON body
   (`scrubPrototype`) before it is ever handed to application code.
9. **Cookie + token jewels preserved.** `parseCookies` rejects a
   whitespace-padded name so a `'  __Host-x'` never reconciles into a
   protected `__Host-` name; `serializeCookie` THROWS on a `Domain`/`Path`
   injection attempt rather than silently dropping it; a `sameSite: 'None'`
   cookie is ALWAYS `Secure` regardless of the `secure` setting;
   `resolveSecure` derives `Secure` from the connection's TLS fact whenever
   `secure` is left `undefined` (omitted).
   `verifyToken` is TOTAL (malformed / tampered / expired / empty-rotation all
   yield `undefined`, never throw); the expiry is HMAC-COVERED inside the
   signed payload; a `TokenSecret` rotation list signs with the FIRST secret
   and verifies against ANY; comparison is constant-time via
   `crypto.subtle.verify` (the old `safeCompare` is retired, not ported).
10. **Seam semantics: returning onion.** Each `MiddlewareHandler` receives a
    `next` that, called, runs the downstream chain and resolves its `Response`;
    NOT calling it short-circuits with the middleware's own `Response`; a
    SECOND call to the same `next` within one invocation REJECTS (the
    double-`next` guard) — a middleware can transform the request
    (`next(newRequest)`), transform the response (mutate after `await next()`),
    or short-circuit, but never fork the chain.
11. **The bag IS the router's state.** `compose`'s `terminal` is
    `(request, context) => dispatcher.handle(request, context.state)` — the
    exact object every middleware wrote into `context.state` is what a route
    handler reads as `RouteContext.state`. No second plumbing.
12. **Connection facts are injected once, at the adapter boundary.**
    `ConnectionInfo` (`ip`, `encrypted`) is built per-request from the raw
    socket and handed to `ServerOptions.state` — `X-Forwarded-For` is NEVER
    implicitly trusted; a deployment behind a trusted proxy derives its own
    client key explicitly in `state` or in middleware.
13. **The stop signal is observable inside a handler.** The `Request`'s
    `signal` (already tied to client disconnect by the router's
    `buildRequest`) is LINKED, via `@orkestrel/abort`'s `linkSignal`, to the
    server's per-run stop signal — so a handler awaiting `request.signal`
    observes EITHER the client disconnecting OR the server calling `stop()`,
    closing the old design's latent gap.
14. **Enterprise timeout knobs, Slowloris-guarded.** `timeouts.request` /
    `timeouts.headers` / `timeouts.keepalive` map onto `node:http`'s
    `requestTimeout` / `headersTimeout` / `keepAliveTimeout`; construction
    THROWS a `TypeError` when `headers` exceeds `keepalive` (the Slowloris
    footgun) — a guard at the boundary, never on the hot path (AGENTS §14).
15. **Socket caps map without policy.** `sockets.connections` /
    `sockets.headers` / `sockets.requests` apply directly to node's
    `maxConnections` / `maxHeadersCount` / `maxRequestsPerSocket` before bind.
    Each is optional, so omission preserves node's native default; `0` keeps
    each native meaning (reject all connections for `connections`, unlimited
    for `headers` and `requests`).
16. **Content negotiation is total and q-value-linear.** `parseAcceptHeader`
    is a single pass with no backtracking (ReDoS-safe); a `;q=0` entry is KEPT
    (an explicit rejection a caller must honor, never silently dropped); an
    absent/malformed `Accept` header resolves to the any-range (the first
    offered value/handler) rather than rejecting.
17. **`expose: false` leaks nothing; `HTTPError` messages always surface.** A
    generic (non-`HTTPError`) throw's message is hidden behind a fixed
    `'Internal Server Error'` string unless `expose` is explicitly `true`; an
    `HTTPError`'s own `message` is ALWAYS client-facing (it is the handler's
    deliberate signal), independent of `expose`.
18. **`isHTTPError` recognizes an `HTTPError` across package copies, not just
    `instanceof`.** A version-skewed or workspace-linked duplicate install of
    this package produces a SECOND, distinct `HTTPError` constructor —
    `instanceof` fails across the two copies even though the thrown value is
    structurally identical, which would otherwise collapse a deliberate 4xx
    into the built-in boundary's 500 fallback. `isHTTPError` tries
    `instanceof` first, then falls back to a total structural check: the
    value must carry a stable cross-copy brand (a `Symbol.for`-interned key,
    so every copy resolves the same symbol) AND expose a numeric `status` and
    a string `message` — the exact fields the boundary reads off a
    recognized error. The brand is an implementation detail of `HTTPError`'s
    constructor, not a field a consumer sets by hand.
19. **SSE producers can cooperate with real process-local transport
    backpressure.** `StreamInterface.write` returns `true` only while the
    underlying `ReadableStream` controller retains positive desired size after
    accepting the event. A `false` result means the producer should await
    `drain()`; that promise parks without polling until a consumer pull restores
    capacity, or stream closure settles the wait. Because the router response
    pump stops pulling while `ServerResponse.write` is backpressured, a slow TCP
    consumer makes this queue fill and the producer park. The signal remains
    process-local — it does not prove remote receipt — and callers that ignore
    it retain the original unconditional-enqueue behavior. The queue's default
    strategy counts chunks, not their byte lengths, so a producer seeking a
    byte bound must also cap each individual event.

## Patterns

### Quickstart: dispatcher, middleware, lifecycle

```ts
import type { MiddlewareHandler } from '@orkestrel/server'
import { createServer } from '@orkestrel/server'
import { createDispatcher } from '@orkestrel/router'

interface State {
	readonly requestId: string
}

const dispatcher = createDispatcher<State>()
dispatcher.add({ method: 'GET', path: '/health', handler: () => new Response('ok') })

const logRequestId: MiddlewareHandler<State> = async (_request, context, next) => {
	const response = await next()
	response.headers.set('X-Request-ID', context.state.requestId)
	return response
}

const server = createServer<State>({
	dispatcher,
	state: () => ({ requestId: crypto.randomUUID() }),
})
server.use(logRequestId)
const port = await server.start()
await server.stop()
await server.destroy()
```

### Middleware ordering idiom

Middleware runs OUTERMOST-first (`middleware[0]` wraps everything after it).
A CORS handler must claim a preflight `OPTIONS` request BEFORE the
dispatcher's own auto-`OPTIONS` responder ever sees it — mount it earliest in
the array, ahead of anything that would short-circuit later.

```ts
import type { MiddlewareHandler } from '@orkestrel/server'
import { createServer } from '@orkestrel/server'
import { createDispatcher } from '@orkestrel/router'

interface State {
	readonly userId?: string
}

const cors: MiddlewareHandler<State> = async (request, _context, next) => {
	if (request.method === 'OPTIONS') return new Response(null, { status: 204 })
	return next()
}
const auth: MiddlewareHandler<State> = async (request, context, next) => {
	return next(request)
}

const dispatcher = createDispatcher<State>()
const server = createServer<State>({
	dispatcher,
	state: () => ({}),
	middleware: [cors, auth], // CORS claims preflights before dispatcher.handle's auto-OPTIONS
})
```

### Typed state slices

Each middleware family publishes its OWN state-slice interface; a consumer
intersects the slices it mounts into one `TState` — no per-middleware generic
accumulation.

```ts
import type { MiddlewareHandler } from '@orkestrel/server'

interface TokenState {
	readonly userId?: string
}
interface RequestIdState {
	readonly requestId: string
}
type State = TokenState & RequestIdState

const withUser: MiddlewareHandler<State> = async (_request, context, next) => next()
```

### SSE route

```ts
import type { StreamInterface } from '@orkestrel/server'
import { openStream } from '@orkestrel/server'

async function pumpStream(stream: StreamInterface): Promise<void> {
	if (!stream.write({ event: 'token', data: 'hello' })) await stream.drain()
	stream.comment('keep-alive')
	stream.end()
}

function streamHandler(): Response {
	const stream = openStream()
	void pumpStream(stream)
	return stream.response
}
```

### Graceful shutdown

`stop()` refuses new connections, gives in-flight work up to the `drain`
deadline, then closes; `destroy()` is the final, idempotent teardown. In-flight
work is requests AND claimed upgraded sockets, so both calls always return.

```ts
import { createServer } from '@orkestrel/server'
import { createDispatcher } from '@orkestrel/router'

const dispatcher = createDispatcher()
const server = createServer({ dispatcher, state: () => ({}), drain: 5_000 })
server.emitter.on('drain', (pending, upgraded) =>
	console.log(`drained with ${pending} requests and ${upgraded} sockets still open`),
)
await server.start()
await server.stop() // graceful — waits up to 5s for requests and upgraded sockets
await server.destroy() // idempotent final teardown
```

A long-lived upgraded socket does not end by itself, so close it from the
`stop` event to keep the shutdown short. Without that the drain runs its whole
budget and the socket is cut instead.

```ts
import type { Duplex } from 'node:stream'
import { createServer } from '@orkestrel/server'
import { createDispatcher } from '@orkestrel/router'

const live = new Set<Duplex>()
const server = createServer({ dispatcher: createDispatcher(), state: () => ({}) })
server.upgrade((_request, socket) => {
	socket.write('HTTP/1.1 101 Switching Protocols\r\n\r\n')
	live.add(socket)
	return true
})
server.emitter.on('stop', () => {
	for (const socket of live) socket.end() // your protocol's clean goodbye
})
```

### Bounded startup and socket caps

`timeouts.start` bounds only listener startup; pass an `AbortSignal` to cancel
that same pending bind from the caller. Socket caps use one grouped option and
map directly to node's server properties.

```ts
import { createServer } from '@orkestrel/server'
import { createDispatcher } from '@orkestrel/router'

const controller = new AbortController()
const server = createServer({
	dispatcher: createDispatcher(),
	state: () => ({}),
	timeouts: { start: 5_000 },
	sockets: { connections: 1_000, headers: 100, requests: 1_000 },
})

// Calling controller.abort() while startup is pending cancels this bind.
const port = await server.start(controller.signal)
```

### Upgrade attach

```ts
import { createServer } from '@orkestrel/server'
import { createDispatcher } from '@orkestrel/router'

const dispatcher = createDispatcher()
const server = createServer({ dispatcher, state: () => ({}) })
server.upgrade((_request, socket, _head) => {
	if (socket.destroyed) return false
	socket.write('HTTP/1.1 101 Switching Protocols\r\n\r\n')
	return true // claims the socket; a later handler never sees it
})
```

### Substrate direct use — tokens, cookies, negotiation

```ts
import type { MiddlewareContext } from '@orkestrel/server'
import {
	createNegotiator,
	decodeTokenPayload,
	decompressRequestBody,
	readSignedCookie,
	signToken,
	verifyToken,
	writeSignedCookie,
} from '@orkestrel/server'

declare const context: MiddlewareContext<Record<string, never>>

const negotiator = createNegotiator()
negotiator.negotiate('text/html, application/json;q=0.9', ['application/json', 'text/html']) // 'text/html'
negotiator.encoding('gzip;q=1.0, deflate;q=0.8', ['gzip', 'deflate']) // 'gzip'
negotiator.language('en-US, en;q=0.8, fr;q=0.5', ['en', 'fr']) // 'en'
await negotiator.format(new Request('http://x'), context, {
	'application/json': (_request, _context) => Response.json({ ok: true }),
})

const headers = new Headers()
await writeSignedCookie(headers, 'session', 'user-1', 'secret')
const value = await readSignedCookie(
	new Request('http://x', { headers: { cookie: 'session=abc' } }),
	'session',
	'secret',
)
await verifyToken('bad.token', 'secret') // undefined — total, never throws

const token = await signToken('client', { secret: 'shh' })
decodeTokenPayload(token.split('.')[0]) // 'client' — the shared decode step verifyToken applies after a signature match

const gzipped = new Uint8Array(await new Response('hi').arrayBuffer())
await decompressRequestBody(gzipped, 'gzip', 1_048_576) // capped decompression — the zip-bomb defense
```

### Practices

- **The server consumes the router, never re-implements it** — bring your own
  `DispatcherInterface`; this package owns zero route matching (AGENTS §21).
- **Mount CORS before anything that could short-circuit an `OPTIONS`** — the
  ordering idiom above; the dispatcher's own auto-`OPTIONS` runs LAST.
- **Read `context.body()` through the cache, never `request.body` directly**
  — the stream is drained exactly once, capped and zip-bomb-safe.
- **Thread `request.signal` into downstream work** — it fires on EITHER
  client disconnect or server `stop()`.
- **Never derive a rate key from `X-Forwarded-For`** — use the injected
  `ConnectionInfo.ip` (or your own trusted-proxy derivation).
- **Publish a state-slice interface per middleware family** — intersect the
  slices a consumer mounts into one `TState`, never a generic-accumulating
  chain.
- **`stop()` before `destroy()`** for a graceful shutdown; `destroy()` alone
  is the abrupt final teardown, idempotent from any state.
- **Close your upgraded sockets on the `stop` event** — the server tracks them
  so shutdown terminates, but only your handler speaks the protocol, so only
  it can close one cleanly before the deadline cuts it.
- **Install a `report` sink for observability** — its own throw is swallowed,
  so it can never crash a response.

## Tests

- [`tests/src/server/helpers.test.ts`](../tests/src/server/helpers.test.ts) —
  `compose` (outer-first ordering, double-`next` rejection, short-circuit,
  request substitution, response transformation), cookie parse/serialize/
  attribute-injection guards, `resolveSecure`, `appendCookie`/`clearCookie`,
  `isAddressInfo` narrowing, `openStream` readiness/drain and
  ignore-the-signal behavior, and `discoverPort` (default, preferred, and
  taken-preferred-falls-back cases).
- [`tests/src/server/Negotiator.test.ts`](../tests/src/server/Negotiator.test.ts) —
  `negotiate`/`encoding`/`language`/`format`: exact vs subtype-wildcard vs
  any-range precedence, `;q=0` rejection semantics, q-tie server-order
  break, `format`'s 406 fallback and handler dispatch.
- [`tests/src/server/errors.test.ts`](../tests/src/server/errors.test.ts) —
  `HTTPError`/`ContentTooLargeError` shape and `isHTTPError` narrowing.
- [`tests/src/server/factories.test.ts`](../tests/src/server/factories.test.ts) —
  `createNegotiator` round-trip + factory return-type assertion, and
  `createServer` round-trip, option threading, and construction guards.
- [`tests/src/server/Server.test.ts`](../tests/src/server/Server.test.ts) —
  the status matrix, restart-fresh-abort, caller-cancelled / timed-out / clean
  bounded startup, `EADDRINUSE` honesty, host/port binds, ephemeral default,
  connection / header / per-socket request caps, graceful-vs-forced drain,
  the held-upgraded-socket stop (drained to the deadline then cut, settled
  early when the claimant closes it, reported on `drain`, and force-closed by
  `destroy()`) against a no-socket control, 20-parallel-none-dropped,
  connection facts threaded into state,
  `context.body()` caching, boundary mapping (`HTTPError`/other/`expose`), the
  stop-signal-reaches-handlers case, and the real slow-TCP proof that an SSE
  producer parks at local queue pressure, resumes on drain, and stays bounded
  when cooperative while ignored readiness retains unconditional enqueue.

## See also

- [`AGENTS.md`](../AGENTS.md) — the rules; §13 the Emitter pattern, §14
  contract & validation architecture, §21 "mechanism, never policy", §22
  documentation-as-contracts.
- [`router.md`](router.md) — `@orkestrel/router`, the dispatcher this server
  consumes and never re-implements.
- [`abort.md`](abort.md) — `@orkestrel/abort`, the stop-signal/request-signal
  linking primitive.
- [`emitter.md`](emitter.md) — `@orkestrel/emitter`, the `Server`'s §13
  lifecycle event map.
- [`contract.md`](contract.md) — `@orkestrel/contract`, the guards backing
  every construction boundary and untrusted read.
- [`README.md`](README.md) — the guides index.
