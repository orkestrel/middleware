# Server

> A typed HTTP server for the `@orkestrel` line: a node-bound `Server` lifecycle entity
> that composes a middleware onion around a consumed `@orkestrel/router` dispatcher,
> beside the `HTTPError` vocabulary and a shared substrate for cookies, WebCrypto
> tokens, content negotiation, ETag and Range, security headers, Server-Sent Events,
> and the body pipeline.

The server consumes `@orkestrel/router` — routing, matching, and dispatch are that
package's, never re-implemented here — mechanism, not product policy. Its node face
adds the upgrade seam, per-request connection-fact injection, and `discoverPort` over
`node:http` through that package's adapter helpers. Source:
[`src/server`](../src/server). Surfaced through the `@orkestrel/server` barrel
(aliased `@src/server` inside this repo).

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

| API                | Kind     | Summary                                                                                                                                      |
| ------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `createNegotiator` | function | Creates a `NegotiatorInterface` — the reusable content-negotiation machine over the weighted `Accept` family.                                |
| `createServer`     | function | Creates a `ServerInterface` — the node face's HTTP server facade over a consumed `@orkestrel/router` dispatcher.                             |
| `createStream`     | function | Creates a `StreamInterface` — a generic Server-Sent-Events stream whose `response` is a fetch-standard streaming `Response` a route returns. |

### Constants

A `Shape` cell holds the constant's declared type.

| API                          | Kind  | Shape                              | Summary                                                                                                                                                                                                                            |
| ---------------------------- | ----- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEFAULT_DRAIN_MS`           | const | `10_000`                           | Names the default graceful-stop deadline `stop()` gives in-flight requests and claimed upgraded sockets, `10_000` ms.                                                                                                              |
| `DEFAULT_BODY_LIMIT`         | const | `1_048_576`                        | Names the default maximum request body size `readBody` accepts before a 413, `1_048_576` bytes.                                                                                                                                    |
| `DEFAULT_DECOMPRESSED_LIMIT` | const | `16_777_216`                       | Names the default maximum decompressed request body size, `16_777_216` bytes — the zip-bomb cap the body pipeline's byte-counting `TransformStream` enforces when it transparently decompresses a `Content-Encoding` request body. |
| `SSE_HEADERS`                | const | `Readonly<Record<string, string>>` | Holds the SSE response headers a `Stream` sets on its response, merged under any caller `headers` so a caller repeating one of these keys replaces its value.                                                                      |
| `REQUEST_ID_PATTERN`         | const | `Readonly<RegExp>`                 | Defines the strict charset `isValidRequestId` requires an incoming `X-Request-ID` to match, `^[A-Za-z0-9_-]{1,200}$`.                                                                                                              |
| `COMPRESSIBLE_TYPES`         | const | `ReadonlySet<string>`              | Holds the bare `Content-Type` values `isCompressibleType` treats as compressible, beyond the `text/*` prefix and structured-suffix (`+json`, `+xml`) rules that helper also applies.                                               |
| `HTTP_ERROR_BRAND`           | const | `symbol`                           | Names the `Symbol.for`-interned brand `HTTPError` carries, `@orkestrel/server.HTTPError`, so `isHTTPError` recognizes an instance across package copies. A consumer never sets it by hand.                                         |
| `DEFAULT_ENCODINGS`          | const | `readonly Encoding[]`              | Lists the default `Encoding` content-codings the substrate offers, in preference order — `gzip` then `deflate`.                                                                                                                    |

### Helpers

| API                      | Kind     | Summary                                                                                                                                                                                                                                                                       |
| ------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compose`                | function | Composes an ordered chain of `MiddlewareHandler` layers around a `terminal` handler into one request handler — the frozen middleware seam.                                                                                                                                    |
| `wrapMiddleware`         | function | Wraps one middleware layer around its downstream handler, enforcing the one-call `next` invariant.                                                                                                                                                                            |
| `parseCookies`           | function | Parses a raw `Cookie:` request header into a `name → value` lookup.                                                                                                                                                                                                           |
| `isCookieName`           | function | Checks whether a string is a valid RFC 6265 cookie name — a non-empty run of cookie-token characters with no surrounding or interior whitespace.                                                                                                                              |
| `decodeCookieValue`      | function | Decodes a cookie value with `decodeURIComponent`, falling back to the raw text when the value is not valid percent-encoding.                                                                                                                                                  |
| `isCookieAttribute`      | function | Checks whether a string is safe to interpolate as a `Set-Cookie` attribute value — the guard `serializeCookie` applies to a `Domain` and a `Path` before it emits them.                                                                                                       |
| `serializeCookie`        | function | Serializes a cookie into a `Set-Cookie` header value — `name=value` plus its attributes.                                                                                                                                                                                      |
| `resolveSecure`          | function | Resolves a cookie's effective `Secure` flag from its `CookieOptions` `secure` setting and whether the request arrived over TLS.                                                                                                                                               |
| `writeSignedCookie`      | function | Writes a signed cookie — HMAC-signs `value` with `signToken` and appends it as a `Set-Cookie` (the inverse of `readSignedCookie`).                                                                                                                                            |
| `readSignedCookie`       | function | Reads and verifies a signed cookie off a request — total, returning the embedded value or `undefined` (the inverse of `writeSignedCookie`).                                                                                                                                   |
| `clearCookie`            | function | Clears a cookie — appends a `Set-Cookie` that expires it immediately (`Max-Age=0`).                                                                                                                                                                                           |
| `signToken`              | function | Signs a value into a stateless, HMAC-SHA256 token — `<payload>.<signature>`.                                                                                                                                                                                                  |
| `verifyToken`            | function | Verifies a stateless token and returns its embedded value — total, never throws.                                                                                                                                                                                              |
| `decodeTokenPayload`     | function | Decodes and narrows a signed token's base64url JSON payload, honoring its expiry — the shared decode step `verifyToken` applies after a signature match.                                                                                                                      |
| `normalizeSecret`        | function | Normalizes a `TokenSecret` to a concrete list of usable secrets — the list behind both `signToken` and `verifyToken`.                                                                                                                                                         |
| `parseAcceptHeader`      | function | Parses a weighted `Accept` / `Accept-Encoding` / `Accept-Language` header into its q-sorted entries.                                                                                                                                                                          |
| `computeCodingQuality`   | function | Computes the client's quality (q) for one content-coding from the parsed `Accept-Encoding` entries — the scoring leaf `resolveCoding` runs over each offered coding.                                                                                                          |
| `resolveCoding`          | function | Picks the highest-scoring content-coding the server offers against already parsed `Accept-Encoding` entries — the shared selection leaf behind `negotiateEncoding` and a `Negotiator`'s `encoding` axis.                                                                      |
| `negotiateEncoding`      | function | Selects the best content-coding for a raw `Accept-Encoding` header from the codings the server offers.                                                                                                                                                                        |
| `matchMediaType`         | function | Reports the rank and quality of one `candidate` media type against the parsed `Accept` entries — the generic media-type primitive the `Negotiator`'s `negotiate` uses to score each `available` candidate.                                                                    |
| `computeLanguageQuality` | function | Computes the client's quality for one `candidate` language from the parsed `Accept-Language` entries — the scoring leaf the `Negotiator`'s `language` axis runs over each offered tag.                                                                                        |
| `isCompressibleType`     | function | Checks whether a `Content-Type` is worth compressing.                                                                                                                                                                                                                         |
| `computeBodyETag`        | function | Computes a content `ETag` over a fully-buffered response body by using WebCrypto.                                                                                                                                                                                             |
| `unwrapETag`             | function | Strips the weak indicator (`W/`) from an entity-tag, returning its opaque comparison body — the reduction `matchesETag` applies to each side before the RFC 7232 §2.3.2 weak comparison.                                                                                      |
| `matchesETag`            | function | Checks whether a request's `If-None-Match` header matches a resource's current `ETag` — the RFC 7232 §2.3.2 weak comparison.                                                                                                                                                  |
| `parseRange`             | function | Parses an HTTP `Range` request header against a known resource `size` — total, returning a `RangeSpec` or `undefined`.                                                                                                                                                        |
| `resolveOrigin`          | function | Resolves the `Access-Control-Allow-Origin` value for a request.                                                                                                                                                                                                               |
| `mergeVary`              | function | Merges a `Vary` value into an existing `Vary` header without duplication.                                                                                                                                                                                                     |
| `resolveSecurityHeader`  | function | Resolves one opt-out, value-bearing security header.                                                                                                                                                                                                                          |
| `isValidRequestId`       | function | Checks whether a client-supplied `X-Request-ID` is safe to echo into a response header and `context.state`.                                                                                                                                                                   |
| `computeIPv6Network`     | function | Computes the `/64` network of a full IPv6 address, or `undefined` when the input is not a plain IPv6 address to collapse.                                                                                                                                                     |
| `computeClientKey`       | function | Collapses a client IP into its rate-limit bucket key — an IPv6 address to its `/64` network, an IPv4 (or IPv4-mapped) address unchanged.                                                                                                                                      |
| `serializeEvent`         | function | Serializes one `SSEMessage` to the SSE wire.                                                                                                                                                                                                                                  |
| `isDangerousKey`         | function | Checks whether a key is a prototype-pollution vector — `__proto__`, `constructor`, or `prototype`, each of which can reach and mutate `Object.prototype` when it is assigned onto a normal object.                                                                            |
| `scrubPrototype`         | function | Strips the prototype-pollution keys from a parsed value in place, recursively.                                                                                                                                                                                                |
| `collectRequestBody`     | function | Collects a `Request` body into a single `Uint8Array`, enforcing a size limit.                                                                                                                                                                                                 |
| `parseEncoding`          | function | Parses a raw `Content-Encoding` header value into a decompressible `Encoding` — the boundary `readBody` coerces through to decide whether a request body needs transparent decompression.                                                                                     |
| `decompressRequestBody`  | function | Decompresses an already-collected, `gzip`/`deflate`-encoded byte sequence transparently through `DecompressionStream`, capping the decompressed output — the zip-bomb defense.                                                                                                |
| `readBody`               | function | Collects and decodes a `Request` body — the shared body-collection pipeline surfaced to middleware and handlers as the middleware context's cached `body()`. An empty body and a malformed `application/json` body each decode to `undefined`.                                |
| `isHTTPError`            | function | Narrows an unknown caught value to an `HTTPError`, including a subclass such as `ContentTooLargeError`, and recognizes an instance from another copy of this package through a structural brand fallback.                                                                     |
| `isServerError`          | function | Narrows an unknown caught value to a `ServerError` — the code-bearing refusal of a call the caller programmed.                                                                                                                                                                |
| `isAddressInfo`          | function | Checks whether a `node:net` `server.address()` return is the structured `AddressInfo` (carrying a numeric `port`) rather than a pipe `string` or `null` — the total, never-throwing narrow `discoverPort` and the `Server`'s own port resolution read the bound port through. |
| `probePort`              | function | Binds and closes a throwaway TCP server to resolve one available port.                                                                                                                                                                                                        |
| `discoverPort`           | function | Finds a free TCP port — binds a throwaway `node:net` server on a `preferred` port where one is given and on an ephemeral port otherwise, reads the bound port, closes the server, and resolves that port.                                                                     |

### Classes

| API                    | Kind  | Summary                                                                                                                                                                                                      |
| ---------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `HTTPError`            | class | Represents an error a handler (or middleware) throws to produce an HTTP response of a specific status.                                                                                                       |
| `ContentTooLargeError` | class | Represents the `HTTPError` thrown when a request body exceeds the body pipeline's size limit — a `413 Content Too Large`.                                                                                    |
| `ServerError`          | class | Represents the error this package raises when a caller programmed a call the entity refuses, carrying `'STATUS'` or `'NEXT'` as its code.                                                                    |
| `Negotiator`           | class | Represents the content-negotiation machine over the weighted `Accept` family — a reusable, cross-middleware entity rather than a middleware. Implements exactly `NegotiatorInterface`.                       |
| `Server`               | class | Represents the HTTP server facade — an observable `node:http` lifecycle composing this module's own middleware onion around a consumed `@orkestrel/router` dispatcher. Implements exactly `ServerInterface`. |
| `Stream`               | class | Represents the Server-Sent-Events handle over an open, fetch-standard streaming `Response`. Implements exactly `StreamInterface`.                                                                            |

### Types

A `Shape` cell holds an interface's data members as bare names in braces, `?` marking an optional member and `plus` introducing its call-signature members, and a type alias's own type literal with a union's arms escaped as `\|`.

| Type                      | Kind      | Shape                                                                                                                  | Summary                                                                                                                                                                                                      |
| ------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MiddlewareContext`       | interface | `{ url, method, state } plus body`                                                                                     | Represents the composition context — plain data, one per request, shared by every middleware and, as `state`, by the route handlers behind the dispatcher.                                                   |
| `NextFunction`            | type      | `(request?: Request) => Promise<Response>`                                                                             | Represents the downstream continuation a `MiddlewareHandler` invokes to run the rest of the onion — guarded so a second call within one invocation rejects.                                                  |
| `MiddlewareHandler`       | type      | `(request: Request, context: MiddlewareContext<TState>, next: NextFunction) => Response \| Promise<Response>`          | Represents one link in the middleware onion — runs around the rest of the chain.                                                                                                                             |
| `Connection`              | interface | `{ ip?, encrypted }`                                                                                                   | Represents the per-request connection facts the server face injects — the only data that genuinely exists solely on the socket, surfaced so middleware and a consumer's `state` factory stay core-pure.      |
| `TokenSecret`             | type      | `string \| readonly string[]`                                                                                          | Represents a secret, or a `[current, ...older]` rotation list, for signing and verifying a stateless, HMAC-signed token.                                                                                     |
| `TokenOptions`            | interface | `{ secret, ttl? }`                                                                                                     | Options for `signToken` — how a stateless, HMAC-signed token is minted.                                                                                                                                      |
| `CookieOptions`           | interface | `{ path?, domain?, maxAge?, httpOnly?, secure?, sameSite? }`                                                           | Represents the `Set-Cookie` attributes for `serializeCookie` (and any signed-cookie transport built over it).                                                                                                |
| `AcceptEntry`             | interface | `{ value, q }`                                                                                                         | Represents one parsed entry of a weighted `Accept` / `Accept-Encoding` / `Accept-Language` header — a value and its quality weight, the element type `parseAcceptHeader` returns (sorted by `q` descending). |
| `MediaMatch`              | interface | `{ q, rank }`                                                                                                          | Rates one candidate media type against a parsed `Accept` header — the quality and specificity `matchMediaType` reports for the best matching `AcceptEntry`.                                                  |
| `Encoding`                | type      | `'gzip' \| 'deflate' \| 'identity'`                                                                                    | Represents a content-coding the substrate compresses or decompresses with. Its members are the `Content-Encoding` and `Accept-Encoding` token vocabulary the substrate understands.                          |
| `FormatHandlerMap`        | type      | `Readonly<Record<string, (request: Request, context: MiddlewareContext<TState>) => Response \| Promise<Response>>>`    | Represents a map of media type → handler for `NegotiatorInterface.format` — the content-negotiation dispatch table.                                                                                          |
| `NegotiatorInterface`     | interface | `{} plus negotiate, encoding, language, format`                                                                        | Represents content negotiation over the weighted `Accept` family — a reusable, cross-middleware machine (not itself a middleware).                                                                           |
| `SSEMessage`              | interface | `{ data, event?, id?, retry? }`                                                                                        | Represents one Server-Sent Event to serialize to the wire.                                                                                                                                                   |
| `StreamOptions`           | interface | `{ status?, headers? }`                                                                                                | Options for a `StreamInterface` — how `createStream` opens the streaming response.                                                                                                                           |
| `StreamInterface`         | interface | `{ response, closed } plus write, comment, drain, end`                                                                 | Represents a handle to write Server-Sent Events to an open, fetch-standard streaming `Response` — the generic streaming surface `createStream` returns over a `ReadableStream`.                              |
| `RangeSpec`               | type      | `{ readonly satisfiable: true; readonly start: number; readonly end: number } \| { readonly satisfiable: false }`      | Represents the parsed outcome of an HTTP `Range` request header.                                                                                                                                             |
| `BodyOptions`             | interface | `{ limit?, decompression? }`                                                                                           | Options for `readBody` — how the shared body-collection pipeline caps and decompresses a request body.                                                                                                       |
| `ServerStatus`            | type      | `'idle' \| 'starting' \| 'listening' \| 'stopping' \| 'stopped'`                                                       | Represents the `Server`'s lifecycle state.                                                                                                                                                                   |
| `ServerErrorCode`         | type      | `'STATUS' \| 'NEXT'`                                                                                                   | Represents the machine-readable category a `ServerError` carries — `'STATUS'` for a lifecycle call the current status forbids, `'NEXT'` for a middleware that called its `next` a second time.               |
| `RequestLine`             | interface | `{ method, url }`                                                                                                      | Identifies the request a server-level fault came from — its method and its parsed URL.                                                                                                                       |
| `ResponseRecord`          | interface | `{ method, pathname, status, ms }`                                                                                     | Records one finished request — the payload `ServerEventMap.response` carries.                                                                                                                                |
| `ServerEventMap`          | type      | `{ start, request, upgrade, error, stop, drain, response }`                                                            | Represents the `Server`'s observable lifecycle events.                                                                                                                                                       |
| `UpgradeHandler`          | type      | `(request: IncomingMessage, socket: Duplex, head: Buffer) => boolean`                                                  | Represents a raw `node:http` protocol-upgrade claimant — registered through `ServerInterface.upgrade`.                                                                                                       |
| `ConnectionStateFunction` | type      | `(connection: Connection) => TState`                                                                                   | Derives a consumer's per-request `TState` from the adapter-injected `Connection` — `ServerOptions.state`, invoked once per request before the middleware onion runs.                                         |
| `ServerOptions`           | interface | `{ dispatcher, state, middleware?, host?, port?, drain?, limit?, expose?, report?, timeouts?, sockets?, on?, error? }` | Options for `createServer` — the dispatcher and per-request state factory the server requires, plus its listener, drain, boundary, timeout, socket-cap, and emitter knobs.                                   |
| `ServerInterface`         | interface | `{ id, status, port, address, dispatcher, emitter } plus use, upgrade, start, stop, destroy`                           | Represents the HTTP server facade — an observable `node:http` lifecycle that composes a middleware onion (this module's own middleware seam) around a consumed `@orkestrel/router` `DispatcherInterface`.    |

Each interface's `readonly` data members stay Surface rows, and its call-signature
members are documented under [Methods](#methods). `ServerInterface.address` is the
bound node `AddressInfo` while the listener is active and `undefined` otherwise.

## Methods

The public methods of `NegotiatorInterface`, `StreamInterface`, and
`ServerInterface` — every call-signature member listed (their `readonly` data
members stay Surface rows). `Negotiator`, `Server`, and `Stream` implement
their interfaces exactly, so their tables also double as each class's
instance-method surface.

#### `NegotiatorInterface`

`negotiate` is the generic media-type primitive; `encoding` / `language` are
its sibling axes over the same q-value parser; `format` is the dispatcher —
it reads the request `Accept`, negotiates a `FormatHandlerMap`'s keys, and
invokes the winner, or answers `406`.

The axes diverge on an absent, empty, or unparseable header. `encoding`
resolves to `undefined` — no compression — rather than to the first offered
coding, because an absent `Accept-Encoding` makes identity the correct answer;
`negotiate` and `language` fall back to the first offered value instead.

| Method      | Returns                 | Summary                                                                                                                                                                                      |
| ----------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `negotiate` | `string \| undefined`   | Picks the best `available` value for a weighted `Accept`-style `header` — the generic media-type primitive (`encoding` / `language` build on it).                                            |
| `encoding`  | `Encoding \| undefined` | Picks the best `available` content-coding for an `Accept-Encoding` header — the coding axis of the same q-value parser (a bare `*` wildcard ⇒ the first `available`).                        |
| `language`  | `string \| undefined`   | Picks the best `available` language for an `Accept-Language` header — `negotiate` with a language-prefix match (`en` accepts `en-US`) and a bare `*` wildcard.                               |
| `format`    | `Promise<Response>`     | Dispatches to the handler whose media type the client most prefers — reads the request `Accept`, negotiates against `handlers`' keys, and invokes the winner; `406` when none is acceptable. |

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

| Method    | Returns         | Summary                                                                                                                                                                                                        |
| --------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `write`   | `boolean`       | Serializes and enqueues one `SSEMessage` to the wire, reporting whether the process-local queue still has capacity afterward — `false` also once the stream is closed.                                         |
| `comment` | `void`          | Writes a `: text` SSE comment line — a keep-alive a conforming parser ignores, and a no-op once the stream is closed.                                                                                          |
| `drain`   | `Promise<void>` | Parks until the process-local stream queue has capacity again — resolving on the consumer pull that restores it, or immediately when capacity is already available or the stream is closed, and never polling. |
| `end`     | `void`          | Ends the stream, completing the response — a no-op once already `closed`, and it settles any parked producer.                                                                                                  |

#### `ServerInterface`

`use` mounts middleware (one handler or an array); `upgrade`
registers a raw protocol-upgrade claimant; `start` binds the listener and
resolves the actually-bound port while accepting an optional caller
`AbortSignal`; `stop` gracefully drains then closes; `destroy` is the
terminal, idempotent teardown. `stop` and `destroy` always resolve: an upgraded socket a
handler claimed is drained up to the `drain` deadline and then destroyed,
never waited on forever.

| Method    | Returns           | Summary                                                                                                                                                           |
| --------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `use`     | `void`            | Appends one middleware, or an array of them in order, to the onion, outer-to-inner in call order.                                                                 |
| `upgrade` | `void`            | Registers an `UpgradeHandler` claimant that runs in registration order; a claimed socket is tracked until it closes.                                              |
| `start`   | `Promise<number>` | Binds the configured `host` and `port`, or an ephemeral port, under an optional caller `AbortSignal`, and resolves the actually-bound port.                       |
| `stop`    | `Promise<void>`   | Stops gracefully: refuses new connections, fires the stop signal, drains in-flight requests and claimed upgraded sockets up to the `drain` deadline, then closes. |
| `destroy` | `Promise<void>`   | Tears down for good: force-closes the listener and every socket, then the emitter — terminal and idempotent from any state.                                       |

## Contract

These invariants hold across `src/server` ↔ `server.md`.

1. **Doc ↔ source bijection.** Every `function` / `class` / `interface` /
   `type` / `const` row in the `## Surface` tables is a real export of its
   source directory, and every export appears as a Surface row — exhaustive,
   both directions.
2. **Doc ↔ source method bijection.** The `## Methods` tables list exactly
   `NegotiatorInterface`'s, `StreamInterface`'s, and `ServerInterface`'s public
   methods — exhaustive, both directions — and `Negotiator` / `Stream` /
   `Server` expose the same public methods, no more.
3. **Status machine + bound address + restart-fresh-abort.**
   `idle → starting → listening → stopping → stopped`; `start()` from
   `listening`/`starting`/`stopping` rejects with a `ServerError` of code
   `'STATUS'`, carrying that status in its `context` and narrowed by
   `isServerError`; each `start()` mints a fresh stop signal, so a restarted
   server is never born aborted; `address` is the real bound `AddressInfo`
   after a successful start and `undefined` before start and after stop or
   destroy; `stop()`/`destroy()` are idempotent no-ops from a state with
   nothing to tear down; `EADDRINUSE` rejects `start()` outright — no silent
   ephemeral fallback (use `discoverPort` up front for a guaranteed-free
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
   stop signal, arms a `@orkestrel/timeout` deadline, and parks on the
   drainable count reaching zero or the deadline firing (a wake-park, not
   polling); it then emits `drain` with the still-pending counts and closes —
   dropping idle keep-alive sockets always, force-closing every open socket
   only when the deadline fired with work still pending (or on `destroy()`).
   Drainable work is every in-flight request plus every upgraded socket a
   handler claimed, because a long-lived upgraded connection is work a
   graceful stop lets finish rather than cuts mid-frame. `drain` carries
   both counts, so a caller can tell a clean stop from a forced one. This is
   also what makes `stop()` and `destroy()` always resolve: node detaches an
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
   that spans setup and dispatch.** The `Server` wraps the whole per-request
   lifecycle in an inner phase and an outer phase of the same boundary. The
   inner phase covers only `buildRequest`: a malformed request (for example,
   an unparsable `Host`) answers a plain `400`, with no `error` emit, no
   `report` call, and no `response` emit, because nothing downstream ever ran
   and no parsed `Request` exists yet to derive its facts from. The outer
   phase covers everything after — a throwing `this.#state(connection)`
   through the middleware/dispatcher run — where a thrown `HTTPError` renders
   as its own status + message; any
   other throw renders `500` with its message hidden unless `expose` is set,
   `report` is invoked with the caught error plus the originating request's
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
   A request rejected at the inner `buildRequest` boundary is the one
   exception: it emits no `response` at all.
7. **Upgrade fan-out is isolated, first-claimer-wins.** Registered
   `UpgradeHandler`s run in registration order; the first to return `true`
   claims the socket and stops the fan-out; a handler that throws is treated as
   declined (the throw surfaces on `error` with no request context — `error`'s
   second argument is `undefined` on the upgrade path, since no fetch
   `Request` exists there, only a raw `IncomingMessage` — and never crashes
   the process) and the fan-out continues; an upgrade nothing claims destroys
   the socket so it never leaks a dangling connection. A claimed socket is
   tracked until it closes, which is what item 5's drain and forced close
   act on — ownership stays with the claimant either way.
8. **Body read exactly once, capped, zip-bomb-safe, scrubbed.**
   `MiddlewareContext.body()` is lazy and cached, so a body-parsing middleware
   and the eventual handler both reading it consume the underlying stream
   exactly once; `readBody` caps the wire size (`ContentTooLargeError`/413 over
   `limit`), transparently decompresses a `gzip`/`deflate` body through a
   byte-counting `TransformStream` that aborts the instant decompressed output
   would exceed `decompression` (fail before materializing a decompression
   bomb, since `DecompressionStream` has no `maxOutputLength`), and scrubs
   `__proto__`/`constructor`/`prototype` keys from a parsed JSON body
   (`scrubPrototype`) before it is ever handed to application code.
9. **Cookie + token jewels preserved.** `parseCookies` rejects a
   whitespace-padded name so a `'  __Host-x'` never reconciles into a
   protected `__Host-` name; `serializeCookie` throws on a `Domain`/`Path`
   injection attempt rather than silently dropping it; a `sameSite: 'None'`
   cookie is always `Secure` regardless of the `secure` setting;
   `resolveSecure` derives `Secure` from the connection's TLS fact whenever
   `secure` is left `undefined` (omitted).
   `verifyToken` is total (malformed / tampered / expired / empty-rotation all
   yield `undefined`, never throw); the expiry is HMAC-covered inside the
   signed payload; a `TokenSecret` rotation list signs with the first secret
   and verifies against any of them; comparison is constant-time through
   `crypto.subtle.verify` (the old `safeCompare` is retired, not ported).
10. **Seam semantics: returning onion.** Each `MiddlewareHandler` receives a
    `next` that, called, runs the downstream chain and resolves its `Response`;
    not calling it short-circuits with the middleware's own `Response`; a
    second call to the same `next` within one invocation rejects with a
    `ServerError` of code `'NEXT'` (the double-`next` guard) — a middleware can
    transform the request (`next(newRequest)`), transform the response (mutate
    after `await next()`), or short-circuit, but never fork the chain. That
    rejection escapes into the request boundary, which carries no `status` for
    it and answers a generic 500.
11. **The bag is the router's state.** `compose`'s `terminal` is
    `(request, context) => dispatcher.handle(request, context.state)` — the
    exact object every middleware wrote into `context.state` is what a route
    handler reads as `RouteContext.state`. No second plumbing.
12. **Connection facts are injected once, at the adapter boundary.**
    `Connection` (`ip`, `encrypted`) is built per-request from the raw
    socket and handed to `ServerOptions.state` — `X-Forwarded-For` is never
    implicitly trusted; a deployment behind a trusted proxy derives its own
    client key explicitly in `state` or in middleware.
13. **The stop signal is observable inside a handler.** The `Request`'s
    `signal` (already tied to client disconnect by the router's
    `buildRequest`) is linked, through `@orkestrel/abort`'s `linkSignal`, to the
    server's per-run stop signal — so a handler awaiting `request.signal`
    observes either the client disconnecting or the server calling `stop()`,
    closing the old design's latent gap.
14. **Enterprise timeout knobs, Slowloris-guarded.** `timeouts.request` /
    `timeouts.headers` / `timeouts.keepalive` map onto `node:http`'s
    `requestTimeout` / `headersTimeout` / `keepAliveTimeout`; construction
    throws a `TypeError` when `headers` exceeds `keepalive` (the Slowloris
    footgun) — a guard at the boundary, never on the hot path.
15. **Socket caps map without policy.** `sockets.connections` /
    `sockets.headers` / `sockets.requests` apply directly to node's
    `maxConnections` / `maxHeadersCount` / `maxRequestsPerSocket` before bind.
    Each is optional, so omission preserves node's native default; `0` keeps
    each native meaning (reject all connections for `connections`, unlimited
    for `headers` and `requests`).
16. **Content negotiation is total and q-value-linear.** `parseAcceptHeader`
    is a single pass with no backtracking (ReDoS-safe); a `;q=0` entry is kept
    (an explicit rejection a caller must honor, never silently dropped); an
    absent/malformed `Accept` header resolves to the any-range (the first
    offered value/handler) rather than rejecting.
17. **`expose: false` leaks nothing; `HTTPError` messages always surface.** A
    generic (non-`HTTPError`) throw's message is hidden behind a fixed
    `'Internal Server Error'` string unless `expose` is explicitly `true`; an
    `HTTPError`'s own `message` is always client-facing (it is the handler's
    deliberate signal), independent of `expose`.
18. **`isHTTPError` recognizes an `HTTPError` across package copies, not only
    `instanceof`.** A version-skewed or workspace-linked duplicate install of
    this package produces a second, distinct `HTTPError` constructor —
    `instanceof` fails across the copies even though the thrown value is
    structurally identical, which would otherwise collapse a deliberate 4xx
    into the built-in boundary's 500 fallback. `isHTTPError` tries
    `instanceof` first, then falls back to a total structural check: the
    value must carry a stable cross-copy brand (a `Symbol.for`-interned key,
    so every copy resolves the same symbol) and expose a numeric `status` and
    a string `message` — the exact fields the boundary reads off a
    recognized error. The brand is an implementation detail of `HTTPError`'s
    constructor, not a field a consumer sets by hand.
19. **SSE producers can cooperate with real process-local transport
    backpressure.** `StreamInterface.write` returns `true` only while the
    underlying `ReadableStream` controller retains positive desired size after
    accepting the event. A `false` result tells a cooperative producer to await
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

`createServer` takes a dispatcher and a per-request state factory, `use`
mounts middleware around the dispatch, and `start`, `stop`, and `destroy`
run the lifecycle.

```ts
import type { MiddlewareHandler } from '@orkestrel/server'
import { createServer } from '@orkestrel/server'
import { createDispatcher } from '@orkestrel/router'

interface State {
	readonly requestId: string
	readonly ip: string | undefined
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
	state: (connection) => ({ requestId: crypto.randomUUID(), ip: connection.ip }),
})
server.use(logRequestId)
const port = await server.start()
await server.stop()
await server.destroy()
```

### Middleware ordering idiom

Middleware runs outermost-first (`middleware[0]` wraps everything after it).
A CORS handler must claim a preflight `OPTIONS` request before the
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

Each middleware family publishes its own state-slice interface; a consumer
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

A route returns the stream's `response` at once and pumps events into the
handle afterwards; a `write` that reports `false` is backpressure `drain`
waits out.

```ts
import type { StreamInterface } from '@orkestrel/server'
import { createStream } from '@orkestrel/server'

async function pumpStream(stream: StreamInterface): Promise<void> {
	if (!stream.write({ event: 'token', data: 'hello' })) await stream.drain()
	stream.comment('keep-alive')
	stream.end()
}

function streamHandler(): Response {
	const stream = createStream()
	void pumpStream(stream)
	return stream.response
}
```

### Graceful shutdown

`stop()` refuses new connections, gives in-flight work up to the `drain`
deadline, then closes; `destroy()` is the final, idempotent teardown. In-flight
work is requests and claimed upgraded sockets, so each call always returns.

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

An upgrade handler returns `true` to claim the socket, which ends the
fan-out and leaves the connection with that handler.

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

Each substrate helper stands on its own, so a caller reaches negotiation,
signed cookies, tokens, and capped decompression without a `Server`.

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
await readSignedCookie(
	new Request('http://x', { headers: { cookie: 'session=abc' } }),
	'session',
	'secret',
)
await verifyToken('bad.token', 'secret') // undefined — total, never throws

const token = await signToken('client', { secret: 'shh' })
decodeTokenPayload(token.split('.')[0]) // 'client' — the shared decode step verifyToken applies after a signature match

const gzipped = new Uint8Array(
	await new Response(
		new Blob(['hi']).stream().pipeThrough(new CompressionStream('gzip')),
	).arrayBuffer(),
)
const body = await decompressRequestBody(gzipped, 'gzip', 1_048_576)
new TextDecoder().decode(body) // 'hi' — capped decompression, the zip-bomb defense
```

### Practices

- **The server consumes the router, never re-implements it** — bring your own
  `DispatcherInterface`; this package owns zero route matching — mechanism,
  not product policy.
- **Mount CORS before anything that could short-circuit an `OPTIONS`** — the
  ordering idiom under [Middleware ordering idiom](#middleware-ordering-idiom);
  the dispatcher's own auto-`OPTIONS` runs last.
- **Read `context.body()` through the cache, never `request.body` directly**
  — the stream is drained exactly once, capped and zip-bomb-safe.
- **Thread `request.signal` into downstream work** — it fires on either
  client disconnect or server `stop()`.
- **Never derive a rate key from `X-Forwarded-For`** — use the injected
  `Connection.ip` (or your own trusted-proxy derivation).
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

- [`tests/guides.test.ts`](../tests/guides.test.ts) — the `## Surface` ↔ `src/server`
  bijection (value and type exports), the `NegotiatorInterface` / `StreamInterface` /
  `ServerInterface` ↔ implementing-class method bijections, and the equality gate:
  every `Summary` cell against its declaration's description paragraph, the titled
  `Substrate direct use — tokens, cookies, negotiation` fence against the `@example`
  block of that title (pinned so the titled pair cannot be retired silently), and the
  README pitch against this guide's tagline. It also runs the flagship fences and
  asserts the values their comments claim.
- [`tests/src/server/helpers.test.ts`](../tests/src/server/helpers.test.ts) —
  `compose` (outer-first ordering, double-`next` rejection, short-circuit,
  request substitution, response transformation), cookie parse/serialize/
  attribute-injection guards, `resolveSecure`, `clearCookie` (expiry and
  accumulation), `computeCodingQuality`/`resolveCoding`/`negotiateEncoding`,
  the `ETag` hex digest, and `discoverPort` (default, preferred, and
  taken-preferred-falls-back cases).
- [`tests/src/server/validators.test.ts`](../tests/src/server/validators.test.ts) —
  `isAddressInfo` narrowing over every shape `node:net`'s `server.address()`
  returns.
- [`tests/src/server/Negotiator.test.ts`](../tests/src/server/Negotiator.test.ts) —
  `negotiate`/`encoding`/`language`/`format`: exact vs subtype-wildcard vs
  any-range precedence, `;q=0` rejection semantics, q-tie server-order
  break, `format`'s 406 fallback and handler dispatch, the empty-header
  divergence between `encoding` and `negotiate`, and the proof that
  `encoding` and `negotiateEncoding` agree because they run one selection leaf.
- [`tests/src/server/Stream.test.ts`](../tests/src/server/Stream.test.ts) —
  the opened SSE response and its header merge order, the serialized wire for
  events and comments, readiness/drain and ignore-the-signal behavior, and the
  ways the handle closes (`end`, and a consumer cancelling).
- [`tests/src/server/errors.test.ts`](../tests/src/server/errors.test.ts) —
  `HTTPError`/`ContentTooLargeError` shape and `isHTTPError` narrowing, and
  `ServerError` shape with `isServerError` narrowing.
- [`tests/src/server/factories.test.ts`](../tests/src/server/factories.test.ts) —
  `createNegotiator`, `createServer`, and `createStream` round-trips + factory
  return-type assertions, `createServer` option threading and construction
  guards, and `createStream` option threading.
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

- [`AGENTS.md`](../AGENTS.md) — the rules this package is written to, including
  the design laws behind its emitter, its guards, and its
  documentation-as-contract.
- [`router.md`](router.md) — `@orkestrel/router`, the dispatcher this server
  consumes and never re-implements.
- [`abort.md`](abort.md) — `@orkestrel/abort`, the stop-signal/request-signal
  linking primitive.
- [`emitter.md`](emitter.md) — `@orkestrel/emitter`, the `Server`'s lifecycle
  event map.
- [`contract.md`](contract.md) — `@orkestrel/contract`, the guards backing
  every construction boundary and untrusted read.
- [`README.md`](README.md) — the guides index.
