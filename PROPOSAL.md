# PROPOSAL — `@orkestrel/middleware`

The batteries package for the `@orkestrel/server` middleware seam: every policy
middleware the server deliberately does not ship — boundary, telemetry,
compression, security headers, CORS, deadlines, trusted-proxy client facts,
ETag, bearer auth, rate limiting, body parsing, sessions, CSRF, static files,
multipart uploads — as `options => MiddlewareHandler<TState>` factories over
the shipped seam and substrate.

> **Status: awaiting approval.** This document lives in the server repo until
> the `orkestrel/middleware` repo exists, then moves there. It is also the
> **spec of record**: the original middleware implementations (the old server's
> `middlewares.ts` era) were deleted with `old/` after the server rebuild, so
> every behavior, invariant, and test pin this package must preserve is written
> out here in full — building it never requires consulting deleted sources.

---

## 1. The inheritance — what is already waiting

`@orkestrel/server` shipped with this package's foundation frozen:

- **The seam** (`@orkestrel/server`, all node-free): `MiddlewareHandler<TState>`,
  `MiddlewareContext<TState>` (`url` / `method` / `state` / cached `body()`),
  `NextFunction`, `ConnectionInfo`, `compose`. Returning onion — short-circuit
  by returning a `Response` without calling `next`; post-process by decorating
  `await next()`; transform by calling `next(newRequest)`; a second `next()`
  rejects.
- **The substrate** (same barrel): cookie machinery (`parseCookies`,
  `serializeCookie`, `writeSignedCookie`/`readSignedCookie`, `clearCookie`,
  `resolveSecure`, injection-hardened), WebCrypto tokens (`signToken`/
  `verifyToken`/`normalizeSecret` — rotation, HMAC-covered expiry, total
  verify), negotiation (`parseAcceptHeader`, `negotiateEncoding`,
  `isCompressibleType`, the `Negotiator` entity), conditionals
  (`computeBodyETag`, `matchesETag`, `unwrapETag`, `parseRange`), security
  primitives (`resolveOrigin`, `mergeVary`, `resolveSecurityHeader`,
  `isValidRequestId`, `clientRateKey`, `ipv6Network`), SSE, and `readBody`
  (limits + transparent request decompression + zip-bomb cap + prototype
  scrub) behind the context's exactly-once `body()`.
- **The error vocabulary**: `HTTPError`, `ContentTooLargeError`, `isHTTPError`.
  (`MultipartError` was explicitly deferred to this package.)
- **The boundary division of labor**: the `Server` owns crash-proofing
  (setup-phase guard, silent 400 on malformed requests, 500 + `report` +
  `error` emit on faults, socket-destroy last resort). This package's
  `createBoundary` is the _richer, earlier_ renderer a consumer may mount —
  the server guard beneath it never becomes unreachable.
- **Structural ordering freedom**: auto-OPTIONS/auto-HEAD/405 live _inside_
  `Dispatcher.handle`, which is `compose`'s terminal — any middleware that
  short-circuits (a CORS preflight 204, a rate-limit 429) preempts them by
  construction. CORS needs only membership in the array, not a fragile slot.

The substrate audit found **zero server-package additions required**: every
gap a battery has (response-side compression, session stores, the multipart
state machine, static-file serving, rate-window bookkeeping) is genuinely this
package's own, composed from the shipped exports plus web/node standards.

## 2. Design philosophy

- **Factories over the frozen seam.** Every battery is
  `create{Noun}(options) => MiddlewareHandler<TState>` — construction-time
  guards (contract), zero per-request allocation beyond necessity, no battery
  ever writes to the transport directly (throw `HTTPError` or return a
  `Response`; rendering is the boundary's and the server's job).
- **Typed state slices, not stringly keys.** Each stateful battery publishes a
  slice interface (`BearerState`, `SessionState`, `IdentifierState`,
  `ClientState`) with a **fixed property name**; the consumer intersects the
  slices they mount into their `TState`. The old design's `key?: string`
  options are dropped — a configurable key cannot be honestly typed, and the
  slice property IS the contract. Likewise the old session `onMissing?:
(ctx) => void` hook is dropped — its default wrote through a context
  responder (`context.empty(404)`) that the shipped seam deliberately does not
  have; `require` now renders a fixed 404 via `HTTPError`. (Both recorded as
  deliberate breaks from the old option surfaces.)
- **§4 modernization of the old names.** Single-word members and factory nouns
  throughout: `createBearer` (was createTokenGuard), `createLimiter` (was
  createRateLimiter), `createCSRF` (was createCSRFGuard), `createBody` (was
  createBodyParser), `ttl`/`lifetime` (was ttl/absoluteTtl), `cache` (was
  maxAge on static), `identifier` (was requestId). The full mapping is in each
  battery's spec; behavior is name-for-name preserved.
- **Pure face by default, node face only when physical.** Thirteen batteries
  are fetch/string-pure and run on any runtime that has `Request`/`Response`.
  Only `createStatic` (`node:fs`) and `createMultipart` (`node:fs`/`os`) are
  node-bound, plus the node compression fallback.
- **Contract is the backbone.** Every option bag guarded at construction
  (`isFunction`, `isFiniteNumber`, `isString`, shape guards on nested bags);
  every untrusted read narrowed total (`isValidRequestId`, cookie parsing,
  token verify); hot paths guard-free per the line convention.
- **Ordering is doctrine, not folklore.** §5 defines the canonical onion and
  states _why each position is load-bearing_, verbatim from the old
  composition tests — it ships in the guide as a contract, not a suggestion.

### Non-goals

A logger implementation (`createTelemetry` is a seam that calls your sink);
health/readiness endpoints (an app route over the server's drain state);
method-override and trailing-slash (router concerns); WebSocket (a consumer of
the server's upgrade seam); templating/ORM/DI/validation DSLs; distributed
rate-limit stores (the `clock`/store seams admit them; none ships);
a database session store (the `SessionStoreInterface` seam is preserved for
it; no database sibling exists yet).

## 3. Architecture and package shape

```
src/core/    types.ts (options + state slices), constants.ts (defaults),
             errors.ts, helpers.ts (pure helpers: window math, transports,
             feature detection), middlewares.ts (the 13 pure batteries),
             Session.ts, MemorySessionStore.ts, factories.ts (createSession
             companions), index.ts
src/server/  middlewares.ts (createStatic, createMultipart, and the node-
             backed compression variant guaranteeing br/zstd via node:zlib
             where CompressionStream lacks them), errors.ts
             (MultipartError), helpers.ts (resolveStaticPath,
             isReservedDeviceName, isDotfilePath, detectMIME, temp staging,
             uploaded-file ops), types.ts, index.ts
```

Template: the `server`/`router` dual-face precedent verbatim — ESM core at the
`.` export, vite-bundled CJS node face at `./server`, `configs/src/*` pairs,
the same scripts block, guides + parity suite.

Dependencies: `@orkestrel/server` as **peerDependency** (+ dev) — the seam and
substrate are imported, never bundled; `@orkestrel/contract` and
`@orkestrel/budget` as regular dependencies (guards; the limiter's tally);
`@orkestrel/abort` + `@orkestrel/timeout` as regular dependencies
(`createDeadline`); `@orkestrel/router` as devDependency only (the
integration capstone — no battery touches the Dispatcher).

## 4. The catalog

Each battery: signature, options (defaults), semantics, invariants (the
acceptance bar — every one was a pinned test in the old suite), ordering.

### 4.1 `createBoundary` — pure, no state

`(options?: { expose?: boolean; report?: (error: unknown) => void }) => MiddlewareHandler<TState>`

Outermost catch (bar compression/telemetry). On a downstream throw:
`HTTPError` → its status + its message (always surfaced — the handler's
deliberate signal); `ContentTooLargeError` → 413; anything else → 500 with a
generic body unless `expose: true` (then `error.message`, never a stack).
`report` is fire-and-forget; its own throw is swallowed. Richer than the
server's built-in guard (which stays beneath as crash-proofing).
**Invariants:** `expose: false` leaks nothing; HTTPError messages always
surface; report throw cannot alter the response.

### 4.2 `createTelemetry` — pure, no state _(new; open decision 3)_

`(options: { record: (entry: TelemetryEntry) => void }) => MiddlewareHandler<TState>`

The access-log/timing _seam_, not a logger: wraps the whole onion, calls
`record({ method, pathname, status, duration })` after the response settles
(and with the mapped status when the boundary rendered an error). `record`'s
throw is swallowed. Truly outermost so the duration is honest.

### 4.3 `createCompression` — pure (+ node fallback)

`(options?: { threshold?: number; encodings?: readonly Encoding[]; filter?: (request: Request, response: Response) => boolean }) => MiddlewareHandler<TState>`

Defaults: `threshold: 1024`; `encodings: ['br', 'gzip', 'deflate']` filtered
at construction by **feature detection** — codings the runtime's
`CompressionStream` supports (the "no brotli" cost recorded in the server
proposal is dated: the spec now lists brotli/zstd; node ships them in
`node:zlib`, and the node face exports a variant that guarantees `br` via
`node:zlib` where `CompressionStream` lacks it).

Post-processes `await next()`: negotiate via the shared `negotiateEncoding`
(server order breaks ties, `*` honored, explicit `;q=0` rejects); compress iff
the buffered body ≥ `threshold` AND `isCompressibleType(contentType)` AND
`filter` (default true) allows. On compress: set `Content-Encoding`, merge
`Vary: Accept-Encoding`, correct `Content-Length`. **Skip untouched:** below
threshold, incompressible type, already `Content-Encoding`-ed, `identity`/no
`Accept-Encoding`, HEAD, 204/304, and **streaming bypass** — `text/event-stream`
and any response the `filter` predicate declines are passed through without
buffering (in fetch vocabulary, buffering an SSE `Response` would hang; the
content-type sentinel plus `filter` is the honest bypass).
**BREACH posture (documented in the guide):** never compress responses that
reflect secrets alongside attacker-controlled input; this package's CSRF
token travels in cookie + header, not the body, which sidesteps the classic
vector — `filter` is the per-route opt-out for consumers who put secrets in
bodies. **Invariants:** gzip verified on the wire; 304 revalidation passes
through it; error bodies compress (it sits outside the boundary); SSE never
buffered.

### 4.4 `createSecurity` — pure, stashes `IdentifierState` `{ identifier: string }`

`(options?: SecurityOptions) => MiddlewareHandler<TState>`

Set-headers-then-`next()`. `X-Content-Type-Options: nosniff` unconditional.
Everything else via `resolveSecurityHeader` (`false` → omit, string →
override wholesale, unset → default):

| Option        | Default                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------- |
| `frame`       | `'DENY'`                                                                                             |
| `csp`         | `default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'self'; form-action 'self'` |
| `referrer`    | `strict-origin-when-cross-origin`                                                                    |
| `permissions` | `camera=(), microphone=(), geolocation=()`                                                           |
| `coop`        | `same-origin`                                                                                        |
| `corp`        | `same-origin`                                                                                        |
| `cluster`     | `?1` (Origin-Agent-Cluster — _new_, helmet/OWASP baseline)                                           |
| `coep`        | **off**; `true` → `require-corp` (opt-in — breaks cross-origin subresources)                         |
| `hsts`        | **off**; `true` → `max-age=31536000; includeSubDomains` (opt-in — destructive if misconfigured)      |
| `identifier`  | **on**: `{ trust?: boolean }` \| `false`                                                             |

`identifier` mints `crypto.randomUUID()`, sets `X-Request-ID`, stashes the
slice. `trust: true` echoes an incoming id only if it passes
`isValidRequestId` (`/^[A-Za-z0-9_-]{1,200}$/`); anything off-charset,
oversize, or CRLF-bearing is replaced with a fresh mint, never echoed.
**Invariants:** custom `csp` string replaces wholesale (never merges);
`csp: false` omits; hostile request-ids never echo. The defaults are the old
implementation's, aligned with current OWASP guidance (Permissions-Policy and
Referrer-Policy were already defaults — the old Appendix A under-described
them); where they differ from helmet (`frame: 'DENY'` vs `SAMEORIGIN`,
`referrer: strict-origin-when-cross-origin` vs `no-referrer`) the old,
stricter-or-equal value is kept deliberately.

### 4.5 `createCors` — pure, no state

`(options?: { origin?: string | readonly string[]; methods?: readonly string[]; headers?: readonly string[] }) => MiddlewareHandler<TState>`

Defaults: `origin: '*'`; `methods: GET/POST/PUT/PATCH/DELETE/OPTIONS`;
`headers: Content-Type, Authorization`. Resolves `Access-Control-Allow-Origin`
via `resolveOrigin`, then continues; answers preflights (OPTIONS +
`Access-Control-Request-Method`) itself with 204 + the advertised
methods/headers — which structurally preempts the Dispatcher's auto-OPTIONS.
**Crown jewels:** on the allow-list (reflect) path, merge `Vary: Origin`
(cache-poisoning guard; wildcard/single-origin adds no Vary); the literal
`Origin: null` is **never** reflected, even if `'null'` is allow-listed.

### 4.6 `createDeadline` — pure, no state _(new; open decision 3)_

`(options: { ms: number; status?: number }) => MiddlewareHandler<TState>`

The application-level per-request deadline (the server's `timeouts.*` are
socket-level). Arms `createTimeout({ ms })` from `@orkestrel/timeout`, links
its signal to the request's via `@orkestrel/abort`'s `linkSignal`, and passes
the reconstructed `Request` downstream so handlers observe the deadline as an
abort. If the deadline fires first: return `status` (default **503**) with
`Retry-After` omitted (the consumer's proxy owns 504 semantics). The
downstream promise is not orphaned — its eventual settle is awaited-and-
discarded so a late throw cannot become an unhandled rejection. Sits inside
the boundary (a downstream `AbortError` maps cleanly).

### 4.7 `createForwarded` — pure, stashes `ClientState` `{ client: { ip?: string } }` _(new; open decision 3)_

`(options: { proxies: number } | { trusted: readonly string[] }) => MiddlewareHandler<TState>`

The trusted-proxy resolver — the single most load-bearing roster gap. The
server injects the _socket_ peer as `ConnectionInfo.ip` and never trusts
`X-Forwarded-For`; deployments behind proxies previously had to hand-roll XFF
parsing in their `state` function (the enterprise footgun). This battery makes
trust **explicit configuration**: walk `X-Forwarded-For` right-to-left,
skipping exactly `proxies` trusted hops (a positive integer — trusting zero
hops is rejected at construction, since it would return the wholly
client-supplied rightmost hop) or every hop matching the `trusted` CIDR list,
and stash the first untrusted address as `client.ip` (falling back to the
socket peer). RFC 7239 `Forwarded`-header parsing is deferred to a follow-up;
the header form shipped is `X-Forwarded-For`. Downstream consumers
(`createLimiter`'s default key, session security, telemetry) prefer
`ClientState` when present. **Invariant preserved:** without this battery
mounted, XFF remains completely untrusted — nothing implicit anywhere.

### 4.8 `createETag` — pure, no state

`(options?: { weak?: boolean }) => MiddlewareHandler<TState>`

Acts only on `GET` responses with status 200 and a buffered body (streaming /
`text/event-stream` passes through untouched; a response that already carries
`ETag` is respected, never re-hashed). Hashes via `computeBodyETag` (WebCrypto
digest), default weak (`W/"…"`, `weak: false` → strong). If `If-None-Match`
matches (`matchesETag` — RFC 7232 weak comparison: `*` matches anything,
comma-lists match on any member, `W/` stripped both sides) → 304 with no
body; else set `ETag` and return the body. **Ordering (load-bearing):** inner
of compression — the hash is computed over the _uncompressed_ representation
so revalidation survives re-encoding. **Invariants:** the full RFC 7232
match matrix (weak/strong/list/`*`) pins.

### 4.9 `createBearer` — pure, stashes `BearerState` `{ token: string }` _(was createTokenGuard)_

`(options: { secret: TokenSecret; header?: string; scheme?: string }) => MiddlewareHandler<TState>`

Defaults: `header: 'authorization'`, `scheme: 'Bearer'` (case-insensitive;
`''` means the whole header value is the raw token). Extract → `verifyToken`
(total, async, rotation-aware, HMAC-covered expiry). Valid → stash the
verified value, continue. Missing → `HTTPError(401, 'missing token')`;
invalid/expired/tampered → `HTTPError(401, 'invalid token')` — thrown, never
written (the boundary renders). **Invariants:** verify is total — garbage,
flipped bytes, wrong secrets, expired payloads all yield a clean 401, never a
crash; rotation accepts any listed secret, signs with the first.

### 4.10 `createLimiter` — pure, reads `BearerState`/`ClientState`/`ConnectionInfo` _(was createRateLimiter)_

`(options: { max: number; window: number; capacity?: number; key?: (context) => string; message?: string; clock?: () => number; policy?: boolean }) => MiddlewareHandler<TState>`

Defaults: `capacity: 10_000`, `message: 'rate limit exceeded'`,
`clock: Date.now`, `policy: false`. Per key: one `@orkestrel/budget`
`createBudget({ max, consume: () => 1 })` plus the window's reset instant
(budget has no clock — the middleware owns all window math against the
injected `clock`, the distributed-store seam). **Check-before-consume**:
read `exhausted` synchronously, deny the `max+1`th request first — exactly
`max` admitted per window. **Lazy fixed window**: the first request after a
key's window elapsed `clear()`s that same budget and re-arms `resetAt` — no
background timers. **Capacity LRU**: a brand-new key at capacity evicts the
oldest. Over-limit **short-circuits** (no throw, no `next()`): 429 +
`Retry-After` (whole seconds to reset, floored at 1) + `message`; with
`policy: true` also the draft `RateLimit`/`RateLimit-Policy` structured
fields (opt-in — the IETF draft is not yet frozen).
**Default key derivation:** `BearerState.token` → `token:<value>`; else
`ClientState.client.ip` (when `createForwarded` is mounted) else
`ConnectionInfo.ip` → `ip:<clientRateKey(ip)>` — IPv6 collapsed to `/64` via
`ipv6Network`, IPv4 and IPv4-mapped kept whole, zones stripped. **Never**
reads `X-Forwarded-For` itself. **Invariants:** same-socket different-XFF
share one bucket; same-/64 IPv6 shares one bucket, different /64s do not;
check-before-consume admits exactly `max`; all window math reads `clock`.

### 4.11 `createBody` — pure, no state _(was createBodyParser)_

`(options?: { limit?: number; decompression?: number }) => MiddlewareHandler<TState>`

Defaults: `limit: 1_048_576`; `decompression` defaults to **`limit`** ("limit
means limit" — note the bare substrate `body()` fallback cap is the separate
16 MiB `DEFAULT_DECOMPRESSED_LIMIT`; mounting this battery makes the caps
explicit and equal by default). Drives the context's single cached `body()`
**eagerly** with its limits — it does not collect separately, so the
exactly-once stream guarantee holds with or without it. Mapping: over-limit
(compressed wire bytes past `limit` OR decompressed bytes past
`decompression`) → **413**; corrupt compressed body → **400** (client fault);
malformed JSON resolves `undefined` from the substrate — this battery maps it
to **400**. Prototype-pollution scrub is the substrate's (`scrubPrototype` at
every depth). **Invariants:** the zip-bomb matrix — 50 MB-of-zeros under a
small cap → 413 without materializing; the between-cap-and-limit isolation
case; `__proto__` bodies never pollute.

### 4.12 `createSession` — pure, stashes `SessionState` `{ session: SessionInterface; control: SessionControlInterface }`

`(options: SessionOptions<S>) => MiddlewareHandler<TState>`

```ts
interface SessionOptions<S> {
	readonly transport: SessionTransport // cookieTransport(...) | headerTransport(...) | yours
	readonly store?: SessionStoreInterface<S> // default createMemoryStore({ ttl, lifetime })
	readonly ttl?: number // idle ms
	readonly lifetime?: number // absolute ms from mint (was absoluteTtl)
	readonly create?: (id: string) => S // default new Session(id)
	readonly mint?: (context) => boolean | Promise<boolean> // default always (auto-session)
	readonly require?: boolean // default false
	readonly ends?: boolean // DELETE with a valid id ends the session → 204 (was deleteEnds)
	readonly clock?: () => number
}
```

One factory replaces the old createSession/createCookieSession pair;
transports are helper factories: `cookieTransport({ name?, secret, cookie? })`
(default `name: 'session'`; value is `signToken(id)` — a signed cookie;
tampered/absent reads as no session; `Max-Age` derived from `ttl`;
cookie defaults `path: '/'`, `HttpOnly`, `SameSite=Lax`, `secure` omitted =
derived from the connection per the shipped `resolveSecure`) and
`headerTransport({ header? })` (default `'session-id'`).

**Per-request lifecycle:** `transport.read` (total) → valid stored session →
stash + continue; `ends` + `DELETE` with valid id → `store.delete` → 204;
no session + `mint()` true → mint `randomUUID()`, `create`, `store.set`,
`transport.write`, stash, continue; else `require` ? 404 : continue
sessionless. On the way out, a resolved session is re-`store.set` (durable
stores round-trip data). **Control handle** (`control` on the slice):
`regenerate()` — anti-fixation: new id, data carried over, old id deleted,
transport rewritten (privilege changes MUST call it); `destroy()` —
`store.delete` + `transport.clear`; destroy supersedes regenerate; transport
writes happen synchronously at call time, store I/O defers to the way out.
Required companions ship with it: the `Session` entity, `transferSessionData`
(the regenerate data-carry), and the `isSession`/`isSessionControl` guards.
**Store contract** (`SessionStoreInterface<S>`: `get`/`set`/`delete` with a
trailing `now` clock seam): `MemorySessionStore` ships — lazy idle eviction
(`now - lastSeen >= ttl`), **absolute lifetime** (`now - createdAt >=
lifetime` evicts even continuously-touched sessions; `createdAt` stamped once
at first set and preserved across way-out re-persists), no background timers.
**Invariants:** the OWASP pair (idle AND absolute timeout); regenerate rotates
the id keeping data while the old id stops resolving; `createdAt` survives
touches; cookie transport inherits the full injection-hardening matrix
(`__Host-` spoof rejection, Domain/Path throws, SameSite=None forces Secure,
Secure derived from TLS when omitted).

### 4.13 `createCSRF` — pure, reads `SessionState`, stashes `CSRFState` `{ csrf: string }` _(was createCSRFGuard)_

`(options: { secret: TokenSecret; cookie?: string; header?: string; field?: string; safe?: readonly string[] }) => MiddlewareHandler<TState>`

Defaults: `cookie: 'csrf'`, `header: 'x-csrf-token'`, `field: '_csrf'`,
`safe: ['GET', 'HEAD', 'OPTIONS']`. Safe method → mint, set the **signed**
cookie (`SameSite=Strict`, `HttpOnly: false` so client JS can read it,
`Secure` derived), expose the raw token on the slice, continue. Mutating
method → read the submitted token (header, else body `field` — body parser
must sit ahead for form posts), read the signed cookie, verify both; missing
either or mismatch → `HTTPError(403, 'invalid csrf token')`. No server store.
**Crown jewel — session binding** (current OWASP doctrine: naive double-submit
is insecure; the signed, session-bound variant is the pattern): with a session
ahead, the minted token is `signToken(sessionId)` — a mutating request's
recovered bound id must equal _its own_ session id, so a token minted under
session A replayed on session B is 403 even with matching halves. Without a
session, falls back to signed-random double-submit, documented weaker.
**Invariants:** the A-token-on-B-session 403 pin; A-on-A 200; sessionless
match still 200.

### 4.14 `createStatic` — node face

`(options: { root: string; prefix?: string; index?: string; dotfiles?: 'ignore' | 'deny' | 'allow'; cache?: number; etag?: boolean; fallback?: boolean | { exclude?: string } }) => MiddlewareHandler<TState>`

Defaults: `index: 'index.html'`, `dotfiles: 'ignore'`, `etag: true`,
`fallback` off (`true` → `exclude: '/api'`). Serves GET/HEAD only; misses
call `next()` (non-terminal). Streams via `fs.createReadStream` (a mid-stream
read error destroys the response, never the process), typed via the extension
map (default `application/octet-stream`), `Cache-Control: max-age=<cache>`,
weak file ETag `W/"<size>-<floor(mtimeMs)>"` honoring `If-None-Match` → 304,
`Accept-Ranges: bytes` with full Range support: single `bytes=` ranges only
(closed/open/suffix, clamped inclusive) → 206 + `Content-Range`;
wholly-unsatisfiable → 416; **multi-range and malformed → full 200** (refused,
total, linear-time even on 5000-digit bounds).
**The traversal guard (exact algorithm, order load-bearing):** strip `prefix`
on a segment boundary (`/apifoo` is not under `/api`) → `decodeURIComponent`
(malformed % → refuse, no throw) → reject NUL → make **relative first** (so a
leading `..` survives `normalize` as a climbing segment) → `normalize` →
refuse any **Windows reserved-device segment** (CVE-2025-27210: superscript
digits normalized first, trailing dots/spaces stripped, stem-before-first-dot
uppercased against CON/PRN/AUX/NUL/COM1-9/LPT1-9 — `NUL.json` refused,
`nullable.css` served) → `resolve(root, relative)` and require the result
under `root`. Reversing relative-strip and normalize masks the escape; the
screen is explicit, never delegated to `path` normalization. **Dotfiles:**
any relative segment starting `.` → policy (`ignore` falls through, `deny`
403s, `allow` serves). **SPA fallback:** an unresolved, extension-less GET
accepting `text/html` outside `exclude` serves `index` (the client router
owns the route).

### 4.15 `createMultipart` — node face

`(options?: { limits?: { file?: number; files?: number; field?: number; fields?: number; total?: number }; allowed?: readonly string[]; directory?: string }) => MiddlewareHandler<TState>`

Defaults: `file: 10_485_760`, `files: 10`, `field: 65_536`, `fields: 100`,
`total: 52_428_800`, `directory: os.tmpdir()`. Non-multipart requests pass
through untouched. **Streams `request.body` through a boundary state
machine — never `formData()`** (buffering the whole body would defeat every
mid-stream defense): each limit trips the moment it is exceeded — reading
stops, every already-staged temp file is deleted, `MultipartError(413, …,
'limit')`. Files stage to `join(directory, randomUUID())` — the client
filename is metadata only, never a path component (traversal by filename is
impossible by construction); the staged path is recorded _before_ the first
byte lands (a breach cleans partials); back-pressure respected; on any
failure the write stream is destroyed and the fd closed before rethrow;
client disconnect mid-upload triggers the same fail-closed cleanup.
**Sniff-authoritative typing:** the first bytes are matched against the
magic-byte table (jpeg/png/gif/webp/pdf/zip); with an `allowed` list, a part
is accepted only if the _detected_ type is listed AND matches the declared
type — a declared `image/png` whose bytes are HTML is 415, a signature-less
declared type on the list is still 415 (sniffing cannot validate it), and
`allowed: []` accepts nothing; without a list, `mime` + `validated` are
recorded and nothing is type-rejected. Fields named `__proto__`/
`constructor`/`prototype` are skipped. Malformed structure (missing/
unterminated boundary, nameless part, oversized header block) →
`MultipartError(400, …, 'malformed')`. Parsed `{ files, fields }` seeds
`context.body()`; handlers narrow with `isMultipartBody`.
**Companions that move here:** `MultipartError` + `isMultipartError` +
`MultipartReason` (`'limit' | 'malformed' | 'rejected'` → 413/400/415),
`UploadedFileInterface` (frozen records: field/name/size/mime/validated/
status/path), `createUploadedFile`, and the post-parse ops
`streamUploadedFile` / `readUploadedFile` / `moveUploadedFile` (rename with
EXDEV copy+unlink fallback).

## 5. The ordering doctrine (ships in the guide as contract)

```
createTelemetry      outermost — honest wall-clock, sees the mapped status
createCompression    outside the boundary — error bodies compress too
createBoundary       the renderer — everything below may throw HTTPError
createDeadline       inside the boundary — its abort maps cleanly
createSecurity       every response gets headers, even errors below… (see note)
createCors           claims preflights before the dispatcher's auto-OPTIONS
createForwarded      client facts resolved before anything keys off them
createETag           inner of compression — hash the uncompressed body
createBearer         stashes the identity the limiter keys off
createLimiter        cheap denial before body work
createBody           body read before sessions/CSRF need fields
createSession        before CSRF — binding requires it
createCSRF           after session (binding), after body (form field)
createStatic         last — misses fall through to the dispatcher terminal
```

Load-bearing positions, with the failure each prevents: compression outside
the boundary (else error bodies ship uncompressed — the old composition test
pins compression #1, boundary #2); ETag inner of compression (else the hash
covers compressed bytes and revalidation breaks on re-encoding); CORS
anywhere before the terminal (its 204 short-circuit preempts auto-OPTIONS
structurally); bearer before limiter (the `token:` key idiom); body before
session/CSRF (async `mint` and the `_csrf` field read the cached body);
session before CSRF (binding). One honest divergence from the old placement:
the old guidance put security headers _near the top_ so even error responses
carried them; the canonical order above places `createSecurity` inside the
boundary, so error `Response`s **returned** by handlers still get headers,
but errors the boundary **renders from a throw** do not. Consumers who want
headers on every response, thrown errors included, mount security above the
boundary — the guide documents both orders and this tradeoff plainly.

## 6. Security invariants — the acceptance bar

Every item below was a pinned test in the old suite and must be re-pinned
here (this section is the checklist the reviewer audits):

1. **CORS**: `Vary: Origin` on reflect, never on wildcard; literal `null`
   never reflected even when allow-listed.
2. **Headers**: hostile request-ids (off-charset/oversize/CRLF) never echoed;
   CSP replaces wholesale; nosniff unconditional.
3. **Bearer**: verify total on garbage/tamper/expiry/rotation — 401, never a
   crash; constant-time via `subtle.verify`.
4. **Limiter**: XFF cannot split buckets (same socket = one bucket); IPv6
   `/64` collapse; check-before-consume exactness; LRU cannot be used to
   reset a hot key (eviction is oldest-inserted, a re-created key starts a
   fresh window honestly).
5. **Body**: zip-bomb 413 before materializing (including the
   between-cap-and-limit case); corrupt stream 400 not 413; `__proto__`
   scrubbed at depth.
6. **Session**: idle AND absolute timeout both enforced (absolute evicts
   continuously-touched sessions; `createdAt` stamped once); regenerate
   rotates id keeping data, old id dead; signed cookie transport inherits the
   full injection matrix; Secure derived from TLS when omitted.
7. **CSRF**: session-bound — A's token on B's session 403s even with matching
   double-submit halves; sessionless fallback works but is documented weaker.
8. **Static**: the traversal matrix (encoded dots, absolute leaks, prefix
   segment boundaries), reserved device names (`NUL.json` 404, `nullable.css`
   200), dotfiles policy, multi-range refused whole, SPA fallback respects
   `exclude`.
9. **Multipart**: declared-vs-sniffed mismatch 415; signature-less type on an
   allow-list 415; temp names random (traversal filenames stay metadata);
   every limit trips mid-stream with staged files cleaned; disconnect
   fail-closed.
10. **Boundary**: `expose: false` leaks nothing; HTTPError messages surface;
    report throw swallowed.

## 7. Sibling integration

| Package               | Where                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| `@orkestrel/server`   | peerDependency — the seam, the substrate, the error vocabulary; never bundled, never duplicated |
| `@orkestrel/contract` | construction guards on every option bag; total narrows on every untrusted read                  |
| `@orkestrel/budget`   | the limiter's per-key tally (check-before-consume over `exhausted`/`consume`/`clear`)           |
| `@orkestrel/abort`    | `createDeadline`'s `linkSignal` (deadline observable by handlers)                               |
| `@orkestrel/timeout`  | `createDeadline`'s timer                                                                        |
| `@orkestrel/router`   | devDependency — the integration capstone only; no battery touches the Dispatcher                |
| `@orkestrel/guide`    | parity: one `middleware.md` concept row spanning both faces                                     |

## 8. Testing strategy

- **Per-battery units** (pure face, env-agnostic setup: a `next` recorder, a
  `MiddlewareContext` factory, a request builder): every default, every
  option, every skip condition, every invariant in §6 — the old security
  suite's middleware pins ported 1:1 onto the new option names.
- **Composition suite** (ports the old `composition.test`): the §5 canonical
  onion end-to-end — gzip on the wire, 304 through compression, error bodies
  compressed, preflight preempting auto-OPTIONS, the bearer→limiter key
  idiom, session→CSRF binding, body→CSRF field reads.
- **Node-face suites**: static (temp-dir fixtures — the traversal/reserved/
  dotfile/Range matrices over real files), multipart (real streamed bodies —
  limits mid-stream, cleanup on abort, sniff matrix over real magic bytes).
- **Clock/determinism**: limiter and session suites drive injected `clock`
  exclusively — zero wall-clock sleeps.
- **Integration capstone**: one real `Server` + `Dispatcher` + the canonical
  onion over a socket — request in, every layer's fingerprint out.
- **Guides parity**: `middleware.md` spanning both faces, standard suite.

## 9. Implementation plan

| Unit | Owns                                                         | Content                                                                              |
| ---- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| U0   | repo identity                                                | template → `@orkestrel/middleware`, dual-face configs, deps per §3, lockfile         |
| U1   | `src/core/types.ts`, `constants.ts`, `errors.ts`             | option bags, state slices, transports/store interfaces, defaults, telemetry entry    |
| U2   | `src/core/helpers.ts`, `Session.ts`, `MemorySessionStore.ts` | window math, transports, session machinery, feature detection                        |
| U3   | `src/core/middlewares.ts` + `factories.ts` + barrel          | the 13 pure batteries                                                                |
| U4   | `src/server/**`                                              | `createStatic`, `createMultipart`, `MultipartError`, traversal/sniff/staging helpers |
| U5   | `tests/**` (pure)                                            | per-battery units + composition suite + clock determinism                            |
| U6   | `tests/**` (node) + capstone                                 | static/multipart matrices, the socket capstone                                       |
| U7   | `guides/**`, parity                                          | `middleware.md` (ordering doctrine as contract), manifest, dependency mirrors        |
| U8   | —                                                            | verifier sweep; checker + opus reviewers (§6 is the audit checklist); push           |

Serial U0→U1→U2→U3; U4 ∥ U5 after U3; U6 ∥ U7 after U4/U5; U8 last. Same
disjoint-ownership, deviation-report, independent-verification discipline as
the router and server builds.

## 10. Open decisions (approval requested)

1. **The roster split into fifteen batteries** as cataloged — the original
   twelve, with request-id folded inside `createSecurity` (as the old design
   had it) rather than a separate battery.
2. **The §4 modernization renames** (`createBearer`, `createLimiter`,
   `createCSRF`, `createBody`, `ttl`/`lifetime`, `cache`, `identifier`) and
   the **typed fixed state slices replacing `key?: string` options**.
3. **The three new batteries**: `createForwarded` (explicit proxy trust — the
   researched enterprise gap), `createDeadline` (app-level deadline, the
   natural abort+timeout consumer), `createTelemetry` (timing seam, not a
   logger). Each is cut cleanly if you'd rather stay at twelve.
4. **`createSession` unification** — one factory + `cookieTransport`/
   `headerTransport` helpers, replacing the old createSession/
   createCookieSession pair.
5. **Compression posture** — feature-detected `br`/`zstd` in the pure face
   with a node-`zlib`-backed variant in the node face; BREACH documented with
   `filter` as the opt-out.
6. **Draft `RateLimit` header fields** behind `policy: false` (opt-in until
   the IETF draft freezes); `Retry-After` always ships.
7. **Repo timing** — this proposal moves to `orkestrel/middleware` when you
   create it; nothing here blocks on that.
