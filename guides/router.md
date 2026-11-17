# Router

> The typed request router: a path-matching engine (`Router`) that compiles route patterns,
> extracts URL-decoded params, and resolves the most specific match, with a fetch-standard,
> method-dimensioned dispatcher (`Dispatcher`), a headless History or hash `Navigator`, and a
> `node:http` adapter all composing that same engine.

This guide covers every face the package publishes. The core is pure and
environment-agnostic: it speaks `string`, `RegExp`, `URL`, `Request`, and `Response`, and
neither DOM nor `node:*`. Precedence, trailing-slash folding, tolerant percent-decoding, and
the `answers` override seam all live in the engine rather than in a face, which is what keeps
the browser and server faces thin; a native override earns its place only on a genuinely
faster path. Source: [`src/core`](../src/core), [`src/browser`](../src/browser), and
[`src/server`](../src/server), surfaced through the `@orkestrel/router` barrel (aliased
`@src/core` / `@src/browser` / `@src/server` inside this repo).

## Surface

### Register and match

Register routes on a `Router`, resolve the most-specific match, and dispatch
fetch-standard requests through a `Dispatcher`:

```ts
import { createDispatcher, createRouter } from '@orkestrel/router'

const router = createRouter<{ readonly page: string }>()
router.add({ path: '/users/:id', meta: { page: 'profile' } })
router.match('/users/7') // { path: '/users/:id', params: { id: '7' }, meta: { page: 'profile' } }

const dispatcher = createDispatcher<{ readonly userId: string }>({
	routes: [
		{
			method: 'GET',
			path: '/users/:id',
			handler: (_request, context) => Response.json(context.params),
		},
	],
})
const response = await dispatcher.handle(new Request('http://x/users/7'), { userId: 'me' })
```

Path patterns are `/`-prefixed: a literal segment (`/users`), a `:name` param
(one segment), or a final `*name` wildcard (captures the rest of the path).
Matching is case-sensitive by default (`sensitive: false` folds ASCII letters); a single
trailing slash is always optional except on the root `/` and the empty
pattern.

Browser and server usage appear under [Patterns](#patterns).

### Factories

| Name               | Kind     | Signature                                                                                  | Summary                                                                                                                                   |
| ------------------ | -------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `createRouter`     | function | `<Meta>(options?: RouterOptions<Meta>) => RouterInterface<Meta>`                           | Creates a `RouterInterface` — the pure path-matching + registry engine shared by the browser `Navigator` and the core `Dispatcher`.       |
| `createDispatcher` | function | `<TState = undefined>(options?: DispatcherOptions<TState>) => DispatcherInterface<TState>` | Creates a `DispatcherInterface` — the fetch-standard, method-dimensioned dispatch entity over one internal `Router<RouteRecord<TState>>`. |
| `createNavigator`  | function | `<Meta>(options: NavigatorOptions<Meta>) => NavigatorInterface<Meta>`                      | Creates a `NavigatorInterface` — the headless History/hash navigation entity composing one core `Router<Meta>`.                           |

### Constants

| Name                  | Kind  | Signature                                                               | Summary                                                                                                                                                                                                              |
| --------------------- | ----- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `METHOD_LIST`         | const | `readonly ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]` | Lists the HTTP methods a `DispatcherInterface` registers routes under, in canonical order — a frozen literal tuple, and the single source the `Method` type, `HTTP_METHODS`, and `parseMethod` are all derived from. |
| `HTTP_METHODS`        | const | `ReadonlySet<string>`                                                   | Holds every HTTP method a `DispatcherInterface` registers routes under as a `ReadonlySet` — backs the registration guard (`add` rejects any `method` outside this set).                                              |
| `PATH_ENCODE_SET`     | const | `ReadonlySet<string>`                                                   | Holds the printable ASCII members of the path encode set `encodePath` reads: the URL Standard's path percent-encode set plus `\|`, beside every C0 control, U+007F, and greater code point.                          |
| `PATH_ESCAPE_PATTERN` | const | `RegExp`                                                                | Matches each ASCII code point `encodePath` writes as one escape — a C0 control, a member of `PATH_ENCODE_SET`, or U+007F — in one global `replace` pass.                                                             |
| `PATH_WIDE_PATTERN`   | const | `RegExp`                                                                | Matches each run of non-ASCII code points `encodePath` hands to one `encodeURIComponent` call, in one global `replace` pass.                                                                                         |
| `PERCENT_ESCAPES`     | const | `readonly string[]`                                                     | Lists the uppercase percent-escape of every byte value, indexed by the byte, so `encodePath` writes each escape with one lookup.                                                                                     |
| `PATH_ENCODE_PATTERN` | const | `RegExp`                                                                | Matches one code point `encodePath` writes as escapes: a C0 control, a member of `PATH_ENCODE_SET`, U+007F, or any greater code point.                                                                               |
| `PATH_REFUSED_SET`    | const | `ReadonlySet<string>`                                                   | Holds the code points a route pattern must not hold: `\`, tab, line feed, and carriage return, which a URL parser reads as a separator or deletes, so the pattern would name a path other than its text.             |
| `PROTOTYPE_KEYS`      | const | `ReadonlySet<string>`                                                   | Holds the own property names of `Object.prototype` — the names `compilePath` refuses as a param name, so a params record never shadows or drops an inherited key.                                                    |
| `TIER_LITERAL`        | const | `2`                                                                     | Names the specificity tier for a \*\*literal\*\* path segment (`/users`) — the highest tier, always outranking a param or wildcard segment at the same position.                                                     |
| `TIER_PARAM`          | const | `1`                                                                     | Names the specificity tier for a \*\*param\*\* path segment (`:name`) — ranks below a literal segment and above a wildcard segment at the same position.                                                             |
| `TIER_WILDCARD`       | const | `0`                                                                     | Names the specificity tier for a \*\*wildcard\*\* path segment (`*name`) — the lowest tier; a wildcard only ever wins against another wildcard shape (an equal-specificity tie resolved by registration order).      |

### Helpers

| Name                   | Kind     | Signature                                                                                                      | Summary                                                                                                                                                                                                                                                                                                                        |
| ---------------------- | -------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `canonicalizePath`     | function | `(path: string) => string`                                                                                     | Canonicalizes a route path for registry identity — encodes it with `encodePath` and strips a single trailing slash, except the root `/` (and the empty pattern). The trailing-slash fold `compilePath` normalizes a pattern through, so identity agrees with the matcher.                                                      |
| `computeDispatchKey`   | function | `(entry: RouteEntry<{ readonly method: Method; }>) => string`                                                  | Computes the canonical `METHOD /path` registry key for a method-dimensioned dispatcher route.                                                                                                                                                                                                                                  |
| `compilePath`          | function | `(path: string, sensitive?: boolean) => CompiledPath`                                                          | Compiles a route path pattern into an anchored regex, its ordered param names, and its specificity vector.                                                                                                                                                                                                                     |
| `encodePath`           | function | `(text: string) => string`                                                                                     | Encodes path text, raw or already encoded, into the canonical form the router compares: each member of its path encode set becomes its UTF-8 percent-escapes.                                                                                                                                                                  |
| `collectInputs`        | function | `<T>(input: T \| readonly T[]) => readonly T[]`                                                                | Returns the input list as it is, or a one-entry list holding a single input — the shape every batch-capable `add` reads.                                                                                                                                                                                                       |
| `decodeParam`          | function | `(value: string) => string`                                                                                    | Decodes one captured param value from a URL, tolerating a malformed percent-escape — the decode `matchPath` applies to each captured group.                                                                                                                                                                                    |
| `matchPath`            | function | `(compiled: CompiledPath, pathname: string) => Readonly<Record<string, string>> \| undefined`                  | Extracts the URL-decoded params a compiled path captures from a concrete pathname, or `undefined` when the pathname does not match.                                                                                                                                                                                            |
| `classifySegment`      | function | `(segment: string, isFinal: boolean) => number`                                                                | Classifies one path segment into its specificity tier — the same syntax `compilePath` rewrites: a syntactically valid `:name` head is a param segment, a final `*name` is a wildcard segment, and everything else (including a literal segment that merely contains a `:` mid-string, for example `a:b`) is a literal segment. |
| `computeSpecificity`   | function | `(path: string) => readonly SegmentRank[]`                                                                     | Computes a route path's specificity vector — one `SegmentRank` per segment, the ranking that picks the winner when several registered routes match the same concrete pathname.                                                                                                                                                 |
| `compareSpecificity`   | function | `(a: readonly SegmentRank[], b: readonly SegmentRank[]) => number`                                             | Compares two specificity vectors — the comparator that picks the most-specific matching route: tier first, then literal length, segment by segment.                                                                                                                                                                            |
| `joinPaths`            | function | `(prefix: string, path: string) => string`                                                                     | Joins a group prefix and a route path into one `/`-prefixed path, normalizing duplicate or missing joining slashes.                                                                                                                                                                                                            |
| `defineRoute`          | function | `<const Path extends string, TState = undefined>(input: RouteInput<Path, TState>) => RouteInput<Path, TState>` | Provides an identity pass-through for a `RouteInput` that pins its `Path` generic to the literal registration-site string, so `context.params` types correctly through `PathParams` without an explicit type argument.                                                                                                         |
| `computeNavigationKey` | function | `(entry: RouteEntry<unknown>) => string`                                                                       | Computes the canonical path key a `Navigator` registers a browser navigation route under.                                                                                                                                                                                                                                      |
| `extractHashPath`      | function | `(hash: string) => string`                                                                                     | Extracts the `/`-prefixed pathname from a `location.hash` value — strips the leading `#` (keeping the route's own leading `/`) and any `?query` suffix.                                                                                                                                                                        |
| `resolveLocationPath`  | function | `(location: Pick<Location, 'hash' \| 'pathname'>, history: boolean, base?: string) => string \| undefined`     | Resolves the `/`-prefixed pathname to match for the current location, in either navigation mode — the one seam `extractHashPath` (hash mode) and history-mode base-stripping share.                                                                                                                                            |
| `findAnchor`           | function | `(event: Event) => HTMLAnchorElement \| undefined`                                                             | Finds the nearest enclosing `<a>` element a DOM event originated from, by walking its composed path — the pure lookup behind history-mode link interception.                                                                                                                                                                   |
| `buildRequest`         | function | `(message: IncomingMessage, options?: RequestOptions) => Request`                                              | Builds a fetch-standard `Request` from a `node:http` `IncomingMessage` — the server-adapter half of the fetch/node conversion seam.                                                                                                                                                                                            |
| `sendResponse`         | function | `(response: Response, target: ServerResponse) => Promise<void>`                                                | Writes a fetch-standard `Response` back to a `node:http` `ServerResponse` — the reverse half of the fetch/node conversion seam.                                                                                                                                                                                                |
| `buildURL`             | function | `(message: IncomingMessage, origin?: string) => URL`                                                           | Builds the URL of a `node:http` request from its request target, by the target's form.                                                                                                                                                                                                                                         |
| `readChunk`            | function | `(message: IncomingMessage, signal: AbortSignal) => Promise<Uint8Array \| undefined>`                          | Reads the next chunk of a `node:http` request body, waiting for one to arrive.                                                                                                                                                                                                                                                 |
| `discardBody`          | function | `(message: IncomingMessage, discard: AbortController) => void`                                                 | Discards the unread rest of a `node:http` request body in place, leaving the connection reusable.                                                                                                                                                                                                                              |

### Parsers

| Name          | Kind     | Signature                                | Summary                                                                            |
| ------------- | -------- | ---------------------------------------- | ---------------------------------------------------------------------------------- |
| `parseMethod` | function | `(value: string) => Method \| undefined` | Narrows a raw `request.method` string into a typed `Method` — total, never throws. |

### Guards

| Name                | Kind     | Signature                                                      | Summary                                                                                                                                                                    |
| ------------------- | -------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isEncryptedSocket` | function | `(socket: unknown) => socket is { readonly encrypted: true; }` | Determines whether a `node:http` connection socket is TLS-encrypted — the total, never-throwing narrow `buildRequest` uses to pick the derived scheme (`https` vs `http`). |
| `isAuthority`       | function | `(value: unknown) => value is string`                          | Checks whether a value is an HTTP authority a server accepts: a host with an optional port, and no userinfo.                                                               |

### Classes

| Name            | Kind  | Signature                                                                                             | Summary                                                                                                                                                                                                                                                                                                    |
| --------------- | ----- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Router`        | class | `new <Meta>(options?: RouterOptions<Meta>) => RouterInterface<Meta>`                                  | Represents the path-matching + registry engine — registers `{ path, meta, name? }` entries (compiling each path once) and resolves raw or encoded text to the most specific matching entry. The shared machine both the `Navigator` (browser) and the `Dispatcher` (core, method-dimensioned) compose.     |
| `Group`         | class | `new <Meta>(parent: RouterInterface<Meta>, prefix: string) => GroupInterface<Meta>`                   | Represents a prefix-scoped registration handle over a `Router` — pure string composition, no independent state or storage.                                                                                                                                                                                 |
| `Dispatcher`    | class | `new <TState = undefined>(options?: DispatcherOptions<TState>) => DispatcherInterface<TState>`        | Represents the fetch-standard, method-dimensioned dispatch entity — layers HTTP method dispatch and web-standard `Request`/`Response` handling over one internal `Router<RouteRecord<TState>>`. The core machine the server face and any fetch-native runtime consume directly.                            |
| `DispatchGroup` | class | `new <TState>(parent: DispatcherInterface<TState>, prefix: string) => DispatchGroupInterface<TState>` | Represents a prefix-scoped registration handle over a `Dispatcher` — the method-dimensioned counterpart of `Group`.                                                                                                                                                                                        |
| `Navigator`     | class | `new <Meta>(options: NavigatorOptions<Meta>) => NavigatorInterface<Meta>`                             | Represents the headless History/hash navigation entity — composes one core `Router<Meta>`, resolving the current location on `start()` and every subsequent navigation event, tracking `active`, and emitting `navigate` through the core `Emitter`. No `render` / `outlet` — the consumer owns rendering. |

### Types

| Name                     | Kind      | Signature                                                                                                                                                                                                                                                                                                                                                                         | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------ | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PathParams`             | type      | `{ readonly [K in keyof PathParamsRaw<Path>]: PathParamsRaw<Path>[K]; }`                                                                                                                                                                                                                                                                                                          | Extracts `{ name: string }` param records from a path pattern at the type level — the typed half of the path grammar.                                                                                                                                                                                                                                                                                                                                                                                  |
| `PathParamsRaw`          | type      | ``string extends Path ? Readonly<Record<string, string>> : Path extends `${infer Segment}/${infer Rest}` ? SegmentParam<Segment> & PathParamsRaw<Rest> : SegmentParam<Path>``                                                                                                                                                                                                     | Performs recursive, unflattened param extraction for `PathParams` — walks a path pattern segment by segment (split on `/`), extracting each segment's `SegmentParam` contribution and intersecting the rest.                                                                                                                                                                                                                                                                                           |
| `IdentifierStartChar`    | type      | `'a' \| 'b' \| 'c' \| 'd' \| 'e' \| 'f' \| 'g' \| 'h' \| 'i' \| 'j' \| 'k' \| 'l' \| 'm' \| 'n' \| 'o' \| 'p' \| 'q' \| 'r' \| 's' \| 't' \| 'u' \| 'v' \| 'w' \| 'x' \| 'y' \| 'z' \| 'A' \| 'B' \| 'C' \| 'D' \| 'E' \| 'F' \| 'G' \| 'H' \| 'I' \| 'J' \| 'K' \| 'L' \| 'M' \| 'N' \| 'O' \| 'P' \| 'Q' \| 'R' \| 'S' \| 'T' \| 'U' \| 'V' \| 'W' \| 'X' \| 'Y' \| 'Z' \| '_'` | Names the identifier start characters an identifier-grammar param name may begin with — mirrors the runtime classifier's `[A-Za-z_]` head class, the one `classifySegment` and `compilePath` share.                                                                                                                                                                                                                                                                                                    |
| `IdentifierChar`         | type      | `IdentifierStartChar \| '0' \| '1' \| '2' \| '3' \| '4' \| '5' \| '6' \| '7' \| '8' \| '9'`                                                                                                                                                                                                                                                                                       | Names the identifier continuation characters after the first — mirrors the runtime classifier's `[A-Za-z0-9_]*` tail class.                                                                                                                                                                                                                                                                                                                                                                            |
| `TakeIdentifierTail`     | type      | ``S extends `${infer Head}${infer Tail}` ? Head extends IdentifierChar ? TakeIdentifierTail<Tail, `${Acc}${Head}`> : Acc : Acc``                                                                                                                                                                                                                                                  | Consumes the identifier-continuation run at the front of a string literal, char by char, appending each onto the accumulator.                                                                                                                                                                                                                                                                                                                                                                          |
| `IdentifierHead`         | type      | ``S extends `${infer Head}${infer Tail}` ? Head extends IdentifierStartChar ? TakeIdentifierTail<Tail, Head> : '' : ''``                                                                                                                                                                                                                                                          | Captures the identifier at the front of a string literal, or an empty string when the literal does not begin with an identifier-start char.                                                                                                                                                                                                                                                                                                                                                            |
| `SegmentParam`           | type      | ``Segment extends `:${infer Rest}` ? IdentifierHead<Rest> extends infer Name extends string ? Name extends '' ? unknown : { readonly [K in Name]: string; } : unknown : Segment extends `*${infer Rest}` ? IdentifierHead<Rest> extends infer Name extends string ? Name extends '' ? unknown : { readonly [K in Name]: string; } : unknown : unknown``                           | Contributes one path segment's type-level param record — the type-level mirror of the runtime `classifySegment` and `compilePath` segment parser.                                                                                                                                                                                                                                                                                                                                                      |
| `SegmentRank`            | interface | `{ tier, length }`                                                                                                                                                                                                                                                                                                                                                                | Represents one segment's place in a route path's specificity vector — its tier, then the length of the literal text it carries.                                                                                                                                                                                                                                                                                                                                                                        |
| `CompiledPath`           | interface | `{ regex, params, specificity }`                                                                                                                                                                                                                                                                                                                                                  | Represents a compiled route path — the anchored regex, its ordered param names, and its specificity vector.                                                                                                                                                                                                                                                                                                                                                                                            |
| `RouteEntry`             | interface | `{ path, meta, name? }`                                                                                                                                                                                                                                                                                                                                                           | Represents one registered route in a `RouterInterface` — the `path` pattern plus the opaque `meta` payload to return on a match, with an optional `name`.                                                                                                                                                                                                                                                                                                                                              |
| `RouterMatch`            | interface | `{ path, params, meta, name? }`                                                                                                                                                                                                                                                                                                                                                   | Represents one matched route — the winning entry's registered pattern, its decoded params, its `meta` payload, and its optional `name`.                                                                                                                                                                                                                                                                                                                                                                |
| `AnswerHandler`          | type      | `(meta: Meta) => boolean`                                                                                                                                                                                                                                                                                                                                                         | Represents the native-override seam — a predicate deciding whether an entry's `meta` answers a given `match` call, beyond path matching.                                                                                                                                                                                                                                                                                                                                                               |
| `RouterOptions`          | interface | `{ entries?, sensitive?, key? }`                                                                                                                                                                                                                                                                                                                                                  | Represents the options for `createRouter` — an optional initial entry set, the case-sensitivity toggle, and the dedup identity function.                                                                                                                                                                                                                                                                                                                                                               |
| `RouterInterface`        | interface | `{ count, add(), match(), entries(), group(), clear() }`                                                                                                                                                                                                                                                                                                                          | Represents the path-matching + registry engine contract (the behavioral-interface role for the one-class-per-file `Router`). Registers `{ path, meta, name? }` entries (compiling each path once) and resolves path text, raw or encoded, to the most specific matching entry by the per-segment precedence `compareSpecificity` defines, a remaining tie going to the earlier registration. The shared engine both the `Navigator` (browser) and the `Dispatcher` (core, method-dimensioned) compose. |
| `GroupInterface`         | interface | `{ prefix, add(), group() }`                                                                                                                                                                                                                                                                                                                                                      | Represents a prefix-scoped registration handle over a `RouterInterface` — pure string composition, no independent state or storage.                                                                                                                                                                                                                                                                                                                                                                    |
| `Method`                 | type      | `(typeof METHOD_LIST)[number]`                                                                                                                                                                                                                                                                                                                                                    | Names the HTTP methods a `DispatcherInterface` dimensions dispatch over — derived from `METHOD_LIST`, whose membership counterpart is `HTTP_METHODS`.                                                                                                                                                                                                                                                                                                                                                  |
| `RouteContext`           | interface | `{ params, pattern, url, state }`                                                                                                                                                                                                                                                                                                                                                 | Represents the ambient context a `RouteHandler` receives alongside the raw `Request` — decoded params, the winning pattern, the parsed URL, and the consumer's opaque per-request state.                                                                                                                                                                                                                                                                                                               |
| `RouteHandler`           | type      | `(request: Request, context: RouteContext<Path, TState>) => Response \| Promise<Response>`                                                                                                                                                                                                                                                                                        | Receives the raw fetch `Request` plus its typed `RouteContext` and returns (or resolves) a fetch `Response`.                                                                                                                                                                                                                                                                                                                                                                                           |
| `RouteInput`             | interface | `{ method, path, handler, name? }`                                                                                                                                                                                                                                                                                                                                                | Represents one route registration input for `DispatcherInterface.add` — the method-dimensioned counterpart of `RouteEntry`.                                                                                                                                                                                                                                                                                                                                                                            |
| `RouteRecord`            | interface | `{ method, handler, name? }`                                                                                                                                                                                                                                                                                                                                                      | Represents the `meta` payload a `DispatcherInterface` stores in its underlying `Router` — what `RouterInterface.match` returns as `RouterMatch.meta` on a dispatch hit.                                                                                                                                                                                                                                                                                                                                |
| `DispatchResult`         | type      | `{ readonly status: 'matched'; readonly match: RouterMatch<RouteRecord<TState>>; } \| { readonly status: 'unmethoded'; readonly allow: readonly Method[]; } \| { readonly status: 'unmatched'; }`                                                                                                                                                                                 | Represents the outcome of `DispatcherInterface.match` — a discriminated union over the dispatch tiers: a full hit, a path that matches with no route for the method (405 territory), or nothing matched at all (404 territory).                                                                                                                                                                                                                                                                        |
| `DispatcherEventMap`     | type      | `{ readonly match: readonly [method: Method, pattern: string]; readonly miss: readonly [method: string, pathname: string, status: 'unmatched' \| 'unmethoded']; }`                                                                                                                                                                                                                | Represents the `Dispatcher`'s event map — the dispatch-outcome signals a consumer can observe alongside the return value of `handle`.                                                                                                                                                                                                                                                                                                                                                                  |
| `DispatcherOptions`      | interface | `{ routes?, sensitive?, unmatched?, unmethoded?, on?, error? }`                                                                                                                                                                                                                                                                                                                   | Represents the options for `createDispatcher` — initial routes, case sensitivity, the default-responder overrides, and the Emitter pattern's wiring.                                                                                                                                                                                                                                                                                                                                                   |
| `DispatcherInterface`    | interface | `{ router, emitter, add(), group(), match(), handle(), destroy() }`                                                                                                                                                                                                                                                                                                               | Represents the fetch-standard, method-dimensioned dispatch entity contract (the behavioral-interface role for the one-class-per-file `Dispatcher`). Layers HTTP method dispatch and web-standard `Request`/`Response` handling over a single internal `Router<RouteRecord<TState>>`.                                                                                                                                                                                                                   |
| `DispatchGroupInterface` | interface | `{ prefix, add(), group() }`                                                                                                                                                                                                                                                                                                                                                      | Represents a prefix-scoped registration handle over a `DispatcherInterface` — the method-dimensioned counterpart of `GroupInterface`.                                                                                                                                                                                                                                                                                                                                                                  |
| `NavigatorEventMap`      | type      | `{ readonly navigate: readonly [match: RouterMatch<Meta>]; }`                                                                                                                                                                                                                                                                                                                     | Represents the `Navigator`'s event map — the single `navigate` signal a consumer observes.                                                                                                                                                                                                                                                                                                                                                                                                             |
| `NavigatorOptions`       | interface | `{ routes, history?, base?, fallback?, guard?, intercept?, sensitive?, on?, error? }`                                                                                                                                                                                                                                                                                             | Represents the options for `createNavigator` — the `routes` to dispatch between, the navigation substrate, the optional guard hook, and the Emitter pattern's wiring.                                                                                                                                                                                                                                                                                                                                  |
| `NavigatorInterface`     | interface | `{ router, emitter, active, start(), stop(), navigate(), destroy() }`                                                                                                                                                                                                                                                                                                             | Represents the headless History/hash navigation entity contract (the behavioral-interface role for the one-class-per-file `Navigator`). Composes a core `Router<Meta>`, resolves the current location on `start()` and on every subsequent navigation event, tracks `active`, and emits `navigate` through the `EmitterInterface`.                                                                                                                                                                     |
| `RequestOptions`         | interface | `{ origin?, response?, signal? }`                                                                                                                                                                                                                                                                                                                                                 | Represents the options for `buildRequest` — URL origin, response-side disconnect tracking, and a linked cancellation signal.                                                                                                                                                                                                                                                                                                                                                                           |

The `count` member of `RouterInterface`, the `prefix` member of `GroupInterface` and
`DispatchGroupInterface`, the `router` and `emitter` members of `DispatcherInterface`, and the
`router`, `emitter`, and `active` members of `NavigatorInterface` are all `readonly` data members
(the preceding Surface rows) — the call-signature members each `Signature` cell names with parentheses are
documented under [Methods](#methods).

## Methods

The public methods of `RouterInterface`, `GroupInterface`,
`DispatcherInterface`, `DispatchGroupInterface`, and `NavigatorInterface` —
every call-signature member listed (their `readonly` data members stay
Surface rows). `Router`, `Group`, `Dispatcher`, `DispatchGroup`, and
`Navigator` implement their interfaces exactly, so this doubles as each
class's instance-method surface.

#### `RouterInterface`

The registry engine's call-signature members, each documented on the interface
declaration it belongs to:

| Method    | Returns                    | Summary                                                                                                                                |
| --------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `add`     | `void`                     | Registers one entry, or many in one call (batch registration), compiling each path once; throws a `ContractError` on a malformed path. |
| `match`   | `RouterMatch \| undefined` | Resolves the most-specific matching entry for a pathname, or `undefined` when nothing matches.                                         |
| `entries` | `readonly RouteEntry[]`    | Lists every registered entry in registration order, or only those whose path matches a given pathname.                                 |
| `group`   | `GroupInterface`           | Returns a prefix-scoped registration handle over this router.                                                                          |
| `clear`   | `void`                     | Drops every entry, leaving the router reusable.                                                                                        |

#### `DispatcherInterface`

The dispatch entity's call-signature members, each documented on the interface
declaration it belongs to:

| Method    | Returns                  | Summary                                                                                                                                                             |
| --------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `add`     | `void`                   | Registers one route input, or many in one call (batch registration); throws a `ContractError` on a malformed registration.                                          |
| `group`   | `DispatchGroupInterface` | Returns a prefix-scoped registration handle over this dispatcher.                                                                                                   |
| `match`   | `DispatchResult`         | Decides the raw `DispatchResult` for a method and pathname pair, with no `Request` or `Response` involvement — the pure decision `handle` builds its response from. |
| `handle`  | `Promise<Response>`      | Runs the full dispatch: parses the request URL, matches, and invokes either the winning handler or the `unmatched`/`unmethoded` responder.                          |
| `destroy` | `void`                   | Tears down the emitter; the underlying router is left registered rather than cleared, so introspection stays valid afterwards.                                      |

#### `NavigatorInterface`

The navigation entity's call-signature members, each documented on the interface
declaration it belongs to:

| Method     | Returns | Summary                                                                                                                                        |
| ---------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `start`    | `void`  | Begins listening and resolves the current location — idempotent, so a second call is a no-op.                                                  |
| `stop`     | `void`  | Stops listening and aborts any pending guard — idempotent.                                                                                     |
| `navigate` | `void`  | Navigates programmatically — runs the guard, then pushes the entry (`#path` in hash mode, the `base`-joined path in history mode) and commits. |
| `destroy`  | `void`  | Stops listening, aborts any pending guard, and tears down the emitter.                                                                         |

#### `GroupInterface`

The group handle's call-signature members — a group holds no registry of its own,
and every registration lands on the owning router:

| Method  | Returns          | Summary                                                                                                          |
| ------- | ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| `add`   | `void`           | Registers one entry, or many in one call, on the owning router with this group's prefix composed onto each path. |
| `group` | `GroupInterface` | Returns a nested group whose prefix is this prefix followed by the given one.                                    |

#### `DispatchGroupInterface`

The dispatch group handle's call-signature members — the owning dispatcher's
registration guard still applies to every route a group registers:

| Method  | Returns                  | Summary                                                                                                                    |
| ------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `add`   | `void`                   | Registers one route input, or many in one call, on the owning dispatcher with this group's prefix composed onto each path. |
| `group` | `DispatchGroupInterface` | Returns a nested group whose prefix is this prefix followed by the given one.                                              |

## Contract

These invariants hold across `src/core` / `src/browser` / `src/server` ↔
`router.md`.

1. **Doc-to-source bijection.** Every `function` / `class` / `interface` /
   `type` / `const` row in the `## Surface` tables is a real export of its
   source directory, and every export appears as a Surface row — exhaustive,
   both directions.
2. **Doc-to-source method bijection.** The `## Methods` tables list exactly
   `RouterInterface`'s, `GroupInterface`'s, `DispatcherInterface`'s,
   `DispatchGroupInterface`'s, and `NavigatorInterface`'s public methods —
   exhaustive, both directions — and `Router` / `Group` / `Dispatcher` /
   `DispatchGroup` / `Navigator` expose the same public methods, no more.
3. **Path grammar.** Segment kinds: literal (`/users`), param
   (`:name`, one segment, with optional literal text after the name, as in
   `:name.json`), wildcard (`*name`, final segment only, captures the rest of
   the path including slashes). `compilePath` throws a `ContractError` at
   registration for a wildcard anywhere but the final segment, a final
   `*name` followed by more text (`/files/*rest.json`), a param or wildcard
   named for a `PROTOTYPE_KEYS` member (`:__proto__`, `:constructor`), and a
   name used twice (`/a/:id/b/:id`). It also throws, with code `pattern`, for
   a pattern holding `\`, tab, line feed, or carriage return anywhere, because
   a URL parser reads `\` as a separator and deletes the others; the `limit`
   names each one and its escape (`%5C`, `%09`, `%0A`, `%0D`). 0.0.22 refused
   only the wildcard outside the final segment and registered every other
   pattern this item names. The matcher
   compares one canonical text, which `encodePath` writes from its own table,
   `PATH_ENCODE_SET`, on both sides. The table is the URL Standard's path
   percent-encode set (Last Updated 2026-11-14, snapshot `47721bbd`) plus
   `|`, a declared departure: Chromium encodes `|` in a path as `%7C` and Node
   leaves it raw, so with `|` in the table both compare as `%7C`. The encoder
   runs on the pattern at
   registration, and on the request text inside `router.match`,
   `router.entries`, and `matchPath`. So `/café` matches `/café` and
   `/caf%C3%A9`, `/^w` matches `/^w` and `/%5Ew`, and `router.match` takes path
   text raw or encoded. Nothing is decoded before matching, so `/us%65rs`
   does not match `/users`, and `/100%25` does not match `/100%`. In 0.0.22
   the matcher compared the pattern as written with the text as given, so
   `/café` answered 404 through `Dispatcher.handle`, whose pathname is
   encoded, and `/a|b` missed `/a%7Cb`, the form Chromium writes. Each capture is decoded with
   `decodeParam` and is opaque text the router refuses nothing in:
   `/files/*rest` captures `../../etc/passwd` from
   `/files/..%2F..%2Fetc%2Fpasswd`. A consumer that maps a capture to a file
   path must contain it within its root.
4. **Precedence.** A literal segment (`TIER_LITERAL`, 2) outranks a
   param (`TIER_PARAM`, 1), which outranks a wildcard (`TIER_WILDCARD`, 0).
   Two matching routes compare left to right, segment by segment: the higher
   tier wins, and within one tier the longer literal text wins, so
   `/files/:name.json` outranks `/files/:name` in either registration order.
   A shorter pattern that is a prefix of a longer one ranks below it. A
   remaining tie, such as `/t/:a.js` against `/t/:b.js`, goes to the earlier
   registration. In 0.0.22 only the tier counted, so the earlier registration
   of `/files/:name` and `/files/:name.json` won.
5. **Trailing slash is insensitive.** A single trailing slash on the request
   path is always optional, folded both at registration (`canonicalizePath`)
   and at match time — except the root `/` and the empty pattern, which are
   exempt and anchor exactly.
6. **Case-sensitive by default.** `sensitive: true` (`Router`/`Dispatcher`
   construction) is the default; `sensitive: false` folds the ASCII letters
   A to Z with a to z during matching, in literal text and in escape hex,
   without altering the pattern's own stored casing. No other letter folds:
   `/CAFÉ` misses `/café` under either setting, while `/CAFé` and
   `/caf%c3%a9` hit it under `sensitive: false`. In 0.0.22 `sensitive: false`
   folded every letter the regular expression `i` flag folds, so `/CAFÉ` hit
   `/café`.
7. **Dedup with `key`.** When `RouterOptions.key` is set, an entry whose
   computed key already exists replaces the prior entry in place (last write
   wins, no engine rebuild); `Dispatcher` always constructs its internal
   `Router` with `key: computeDispatchKey`, which pairs the route's method
   with `canonicalizePath(entry.path)`, the encoded pattern with one trailing
   slash removed, so two registrations differing only by a trailing slash or
   by encoding (`/café` and `/caf%C3%A9`) replace each other while different
   methods stay distinct. A batch `add` admits every entry before it registers
   any, so a refused batch registers nothing.
8. **The `answers` seam.** `RouterInterface.match`'s optional
   `AnswerHandler<Meta>` predicate is the single native-override point both
   faces compose differently: the `Dispatcher` passes a method-check, the
   browser `Navigator` omits it entirely — every path match answers.
9. **Dispatch semantics.** A `HEAD` request with no explicit `HEAD` route
   runs the matching `GET` handler, cancels the `GET` response body, and
   answers with its status and headers alone. An `OPTIONS` request with no
   explicit `OPTIONS` route answers `204` with a derived `Allow` header: the
   methods of `router.entries(pathname)` in registration order, then `HEAD`
   when `GET` is present, then `OPTIONS`. A path-matches-but-method-doesn't
   dispatch invokes the `unmethoded` responder with the same set (default
   `405` + `Allow`, so `GET` alone reads `GET, HEAD, OPTIONS`); nothing matching
   invokes the `unmatched` responder (default `404`). In 0.0.22 the `405`
   `Allow` header left `OPTIONS` out, so `GET` alone read `GET, HEAD`, and
   auto-`HEAD` dropped the `GET` body without cancelling it. **A handler throw
   propagates uncaught** — the dispatcher never invents an error boundary
   (that is the consuming server's policy).
10. **Wildcard trailing-slash capture is asymmetric with param folding
    (intended).** A final `*name` wildcard captures any trailing slash on the
    request path into its own captured value (`/files/a/b/` → `rest: 'a/b/'`)
    — unlike a `:name` param segment, whose own trailing slash is folded away
    by the shared trailing-slash-insensitivity rule stated earlier. This is
    deliberate: the wildcard's capture is "the rest of the path, verbatim,"
    including whatever trailing slash the caller sent.
11. **Event map.** `DispatcherEventMap` carries `match` (emitted on every
    dispatch the dispatcher answers, the derived `HEAD` and `OPTIONS` cases
    included; for a derived `OPTIONS` answer the `pattern` is the
    most-specific pattern the pathname resolved to) and `miss` (emitted on
    every non-matching dispatch, tagged
    `'unmatched'`/`'unmethoded'` through its `status` field) — no
    `error`/`observerError` domain event (listener errors route through the
    emitter's own `error` option).
12. **Headless by design.** No `render`/`outlet`. The `Navigator` resolves,
    tracks `active`, and emits `navigate`; rendering is entirely the
    consumer's responsibility.
13. **One shared engine.** Each route's `path` is registered once on the same
    `Router` machine the core `Dispatcher` composes, keyed for dedup by its
    `canonicalizePath` (last write wins, replace-in-place). `Navigator` never
    rebuilds matching logic of its own.
14. **The history toggle.** `history: false` (default) reads/writes
    `location.hash` and binds `hashchange`; `history: true` reads/writes through
    `pushState`/`popstate`, with an optional `base` path prefix stripped
    before matching and prepended when navigating. `base` is compared in the
    encoded form `location.pathname` carries, so `base: '/café'` strips from
    `/caf%C3%A9/users/7`. `intercept: true` (history mode only) adds
    same-origin `<a>` click interception for a link inside `base` — a plain
    left-click with no modifier keys, no `target`, and no `download`
    attribute. A link outside `base` navigates natively, where 0.0.22
    intercepted it and pushed it under `base`, so `/other/page` became
    `/app/other/page`. In history mode, `navigate` throws a `ContractError`
    coded `pattern` for a path that resolves on another origin, such as
    `//elsewhere.example/b`, before the guard runs; 0.0.22 handed that path to
    `pushState`, which threw a `DOMException`. `navigate` pushes an
    entry in both modes, `#path` in hash mode, and writes `{ index }` into its
    `history.state`; `start` writes `{ index: 0 }` to an entry that carries no
    index. A hash `navigate` to the hash the location shows keeps its entry.
15. **Fallback semantics.** A location that matches nothing, or in history
    mode lies outside `base`, resolves the configured `fallback` pattern
    (default: the first route's path) through the same engine. 0.0.22 matched
    a location outside `base` by its whole pathname, so `/other/page` under
    `base: '/app'` resolved the `/other/page` route. A `fallback`
    that itself matches no registered route leaves `active` `undefined` and
    emits nothing — no phantom match is ever fabricated.
16. **Guard + supersede semantics.** An optional `guard(to, from, signal)` may
    veto (or asynchronously veto) a navigation.
    - `navigate` and an intercepted link ask the guard before the URL moves: a
      veto leaves the location, the history length, and `active` unchanged,
      and an allowed navigation pushes its entry, then commits.
    - When the browser moves the URL first (`popstate` or `hashchange`), a veto
      moves it back with `history.go` to the entry `active` describes, by the
      `index` both entries carry. An entry the navigator did not write — a
      native fragment link, an address-bar edit, or an entry from before
      `start` — carries no index: the location stays where the browser put
      it, `active` stays unchanged, and the consumer reconciles them.
    - Each navigation holds an `@orkestrel/abort` handle until its verdict
      arrives. A newer navigation, `stop`, and `destroy` abort every pending
      handle, and a verdict that resolves after its abort (`signal.aborted`)
      is discarded, same as a synchronous `false`/rejected verdict: `active`
      stays unchanged and nothing is emitted. A guard throw routes to the
      `error` handler (not through the emitter's own `emit`) and vetoes.
    - A `navigate` called from a `navigate` listener runs in a microtask after
      the emission ends, unless a later navigation supersedes it first. Every
      listener of one emission reads `active` equal to the match it receives,
      and the second navigation's emission follows.
    - After `destroy`, `start` and `navigate` do nothing: no listener, no
      history entry, and no emit.
17. **Case-sensitive by default.** `sensitive: true` (forwarded to the
    underlying `Router`) is the default; `sensitive: false` folds the ASCII
    letters A to Z with a to z during matching, and no other letter.
18. **Intercepted links carry pathname only (known limitation).** Click
    interception passes only the intercepted link's `/`-prefixed pathname
    through to `navigate` — a query string on the link's `href` is not
    preserved (the pathname-only grammar has no query concept). A consumer
    needing query data reads it from `window.location.search` after
    navigating, or skips interception for that link.
19. **Only HTML `<a>` elements are intercepted (known limitation).** Click
    interception ({@link findAnchor}) walks up the event's composed path for
    an `HTMLAnchorElement` — an SVG `<a>` (`SVGAElement`) is not intercepted,
    even inside a same-origin document, and falls through to the browser's
    native navigation.
20. **The target form decides the URL.** `buildRequest` builds its URL
    through `buildURL`. An origin-form target is appended to the origin, so
    `GET //evil.example/admin` keeps the origin's authority and routes the
    pathname `//evil.example/admin`. An absolute-form target takes its own
    authority, for `http:` and `https:` only. The asterisk form and every
    other form throw a `ContractError`. The origin is `RequestOptions.origin`
    when given; otherwise it is the connection's scheme and the `Host` header.
    A `Host` header that is present must pass `isAuthority` for every target
    form, with `RequestOptions.origin` set as well: a host with an optional
    port, with no path, userinfo, whitespace, or port above 65535, on one
    field line only (RFC 9112 section 3.2). A consuming server maps the throw
    to 400. In 0.0.22 `buildRequest` resolved the target against the origin
    with no check of its form or of the `Host` header: `//evil.example/admin`
    took the authority `evil.example`, the asterisk form read as the path `/*`,
    and the first of several `Host` lines won.
21. **The request signal aborts on a peer disconnect or on
    `RequestOptions.signal`, and on nothing else.** `buildRequest` mints an
    `AbortController`, builds the `Request` over its `signal`, and listens on
    `RequestOptions.signal` until the exchange ends: when the paired
    `RequestOptions.response` closes, or, without one, when the message
    closes. An option signal that aborts in that time aborts the request
    signal with the option signal's own reason; afterward it holds no
    listener of the exchange and aborts nothing. A peer disconnect is the
    message closing before it completed, or the paired response closing
    before it ended. A body cancel, a discarded body, and a finished response
    never abort it. 0.0.22 took no `signal` option and ignored one passed.
22. **The request body is pull-based.** For a body-carrying method, the body
    reads the message only when its reader reads, through `readChunk`, with
    `duplex: 'half'` set as Node's fetch implementation requires. An unread
    body holds no more than the message's own buffer whatever the upload
    size, and Node discards it after the response. A cancel discards the
    remainder in place through `discardBody`, and so does the `finish` of the
    paired response, so the connection serves its next request. In 0.0.22
    `buildRequest` pumped the whole upload into the body whether or not a
    reader read it, and a cancel destroyed the message, aborted
    `request.signal`, and left the next request on the connection unanswered.
23. **A failed response reads as aborted.** `sendResponse` ends the
    `ServerResponse` with a body that completes in its first chunk, framed by
    its length, and pipes any other non-`null` body through
    `Readable.fromWeb`, which honors backpressure. It removes every listener
    it adds when the exchange ends. A response to a `HEAD` request, and a 1xx, 204, or 304 response,
    carries no body on the wire, so `sendResponse` cancels its body unread and
    ends the target, where 0.0.22 read a `HEAD` response's body to its end and
    Node dropped each write. When the peer closes first, it cancels
    the body, even one waiting for its next chunk, and resolves. When Node
    refuses a header or the body fails, it destroys the target and rejects, so
    the client reads an aborted response, never a truncated one that looks
    complete. In 0.0.22 a failed body ended the target and `sendResponse`
    resolved, so the client read the truncated response as complete.
24. **Header fidelity.** `buildRequest` copies every incoming header
    (multi-value headers comma-joined, except `set-cookie`, appended
    individually); `sendResponse` writes every outgoing header and re-derives
    `set-cookie` through `Headers.getSetCookie()` so multiple response cookies
    stay distinct instead of collapsing into one comma-joined header.

## Patterns

### Groups and dedup

`group(prefix)` scopes a registration handle that composes its prefix onto
every entry it registers on the same underlying router; a `key` function
lets a later registration replace an earlier one in place instead of adding
a duplicate candidate.

```ts
import { createRouter } from '@orkestrel/router'

const router = createRouter<{ readonly page: string }>({
	key: (entry) => entry.path,
})
const api = router.group('/api')
api.add({ path: '/users', meta: { page: 'list' } })
router.match('/api/users')?.path // '/api/users'

router.add({ path: '/api/users', meta: { page: 'list-v2' } }) // replaces the prior entry
```

### Wildcard capture and precedence

A literal segment always outranks a param, which always outranks a wildcard,
compared left-to-right at the earliest differing segment:

```ts
import { createRouter } from '@orkestrel/router'

const router = createRouter<{ readonly handler: string }>()
router.add([
	{ path: '/files/*rest', meta: { handler: 'catchAll' } },
	{ path: '/files/:name', meta: { handler: 'named' } },
	{ path: '/files/readme', meta: { handler: 'literal' } },
])
router.match('/files/readme')?.meta.handler // 'literal'
router.match('/files/other')?.meta.handler // 'named'
router.match('/files/a/b.png')?.meta.handler // 'catchAll'
```

### Method-dimensioned dispatch (auto-HEAD, auto-OPTIONS, 405)

Registering a single `GET` route yields an auto-derived `HEAD`, an auto-derived `OPTIONS`,
and a `405` for every other method on that path:

```ts
import { createDispatcher } from '@orkestrel/router'

const dispatcher = createDispatcher()
dispatcher.add({ method: 'GET', path: '/health', handler: () => new Response('ok') })

const head = await dispatcher.handle(new Request('http://x/health', { method: 'HEAD' }), undefined)
head.body // null — auto-HEAD strips the GET handler's body

const options = await dispatcher.handle(
	new Request('http://x/health', { method: 'OPTIONS' }),
	undefined,
)
options.headers.get('Allow') // 'GET, HEAD, OPTIONS'

const notAllowed = await dispatcher.handle(
	new Request('http://x/health', { method: 'DELETE' }),
	undefined,
)
notAllowed.status // 405
```

### Observing dispatch outcomes

The `on` hooks report every dispatch outcome, matched or missed, alongside the return
value of `handle`:

```ts
import { createDispatcher } from '@orkestrel/router'

const dispatcher = createDispatcher({
	on: {
		match: (method, pattern) => console.log('matched', method, pattern),
		miss: (method, pathname, status) => console.log('missed', method, pathname, status),
	},
})
dispatcher.add({ method: 'GET', path: '/health', handler: () => new Response('ok') })
await dispatcher.handle(new Request('http://x/missing'), undefined) // logs a 'miss'
```

### Typing a route input at the registration site

`defineRoute(...)` is a pure identity pass-through with a `const Path extends
string` generic — wrapping a route literal in it pins `Path` to the literal
string at the call site (instead of the widened `string` a bare intermediate
binding would get), so `context.params` types correctly through
`PathParams` even when the input is built before the `add` call:

```ts
import { createDispatcher, defineRoute } from '@orkestrel/router'

const input = defineRoute({
	method: 'GET',
	path: '/users/:id',
	handler: (_request, context) => new Response(context.params.id), // typed string
})

const dispatcher = createDispatcher()
dispatcher.add(input)
```

A heterogeneous `RouteInput[]` built by collecting several `defineRoute(...)`
results still widens each element's `Path` to `string` the moment the array
type is inferred — TypeScript has no per-element literal-preserving array
type. The realistic ceiling `defineRoute` raises is per-call typing at the
registration site (a single `defineRoute({...})` or a direct `add({...})`
call), not a stored, still-literal-typed array of route records.

### Introspection and reset

`entries()` lists every registration (or only those matching a pathname —
the same set a 405 response's `Allow` header derives from); `clear()` drops
every entry while leaving the router usable; `Dispatcher.destroy()` tears
down its emitter.

```ts
import { createDispatcher, createRouter } from '@orkestrel/router'

const router = createRouter<{ readonly page: string }>()
router.add([
	{ path: '/users/:id', meta: { page: 'profile' } },
	{ path: '/tokens', meta: { page: 'tokens' } },
])
router.entries().length // 2
router.entries('/users/7').length // 1 — only the matching entry
router.clear()
router.entries().length // 0 — the router stays usable

const dispatcher = createDispatcher()
dispatcher.add({ method: 'GET', path: '/health', handler: () => new Response('ok') })
dispatcher.destroy() // tears down the #emitter; router.entries() is still valid afterward
```

### Hash-mode navigation

A `Navigator` in hash mode dispatches on `location.hash`, updates `active` after each
`hashchange`, and commits a `navigate` call as it pushes the hash. In 0.0.22 a hash
`navigate` set `location.hash` and committed after the `hashchange` fired. 0.0.23
removes the 0.0.22 `navigator.match` method, and `navigator.router.match` answers the
same lookup, as the following example shows:

```ts
import { createNavigator } from '@orkestrel/router/browser'

const navigator = createNavigator({
	routes: [
		{ path: '/', meta: { title: 'Home' } },
		{ path: '/about', meta: { title: 'About' } },
	],
})
navigator.emitter.on('navigate', (match) => (document.title = match.meta.title))
navigator.start()
navigator.router.match('/about')?.meta.title // 'About' — a lookup, no location read
navigator.navigate('/about') // pushes '#/about'; `active` updates before the call returns
navigator.stop()
navigator.destroy() // stop() plus tear down the #emitter
```

### History mode with link interception

History mode binds `popstate` and, with `intercept` set, same-origin `<a>` clicks:

```ts
import { createNavigator } from '@orkestrel/router/browser'

const navigator = createNavigator({
	routes: [{ path: '/users/:id', meta: { title: 'User' } }],
	history: true,
	base: '/app',
	intercept: true,
})
navigator.start() // binds popstate + same-origin <a> click interception
```

### Guarding navigation (auth walls)

A guard may veto synchronously or asynchronously; a superseded guard's
verdict is discarded through its own `signal`. A `navigate` call or an intercepted
link asks the guard before the URL moves, so a vetoed one leaves the address bar
alone. In 0.0.22 both moved the URL first and asked the guard after, and no veto moved
the browser back, so the address bar kept the vetoed location while `active` kept the
previous match. When the browser moves first, through back, forward, a native fragment
link, or an address-bar edit, a veto of an entry the navigator wrote moves the
browser back to the entry `active` describes. For an entry it did not write, the
address bar keeps the vetoed location while `active` keeps the previous match:
compare `location` with `active` in your own `hashchange` or `popstate` listener
and `navigate` to the location you want.

```ts
import { createNavigator } from '@orkestrel/router/browser'

const navigator = createNavigator({
	routes: [
		{ path: '/private', meta: { title: 'Private' } },
		{ path: '/', meta: { title: 'Home' } },
	],
	guard: async (to, _from, signal) => {
		const allowed = await checkAuth({ signal }) // cancels its own work if superseded
		return signal.aborted ? false : allowed
	},
})
navigator.start()
```

### Composing a server

The server face converts and writes, and your server composes three calls:
`buildRequest`, `Dispatcher.handle`, and `sendResponse`. The error policy is
yours. `buildRequest` throws a `ContractError` for a refused target or `Host`,
which a server can answer with 400, and `sendResponse` has already destroyed
the connection when it rejects. 0.0.22 exported a `createListener` function
that composed these three calls and answered a throw before the headers went
out with a bare 500. 0.0.23 removes it, with `handleListenerRequest`,
`ListenerFunction`, and `StateFunction`, so compose the calls as the following
example does:

```ts
import { buildRequest, sendResponse } from '@orkestrel/router/server'
import { createDispatcher } from '@orkestrel/router'
import http from 'node:http'

const dispatcher = createDispatcher<{ readonly requestId: string }>()
dispatcher.add({
	method: 'GET',
	path: '/users/:id',
	handler: (_request, context) =>
		Response.json({ id: context.params.id, requestId: context.state.requestId }),
})

const server = http.createServer(async (message, target) => {
	try {
		const request = buildRequest(message, { response: target })
		const response = await dispatcher.handle(request, { requestId: crypto.randomUUID() })
		await sendResponse(response, target)
	} catch {
		if (!target.headersSent && !target.destroyed) target.writeHead(500).end() // this consumer's own error policy
	}
})
server.listen(0)
```

### Observing client disconnect

The `Request` returned by `buildRequest` carries a `signal` that aborts when the peer
disconnects, or when the `signal` option aborts, such as a server's own shutdown:

```ts
import { buildRequest } from '@orkestrel/router/server'
import http from 'node:http'

const shutdown = new AbortController()
const server = http.createServer((incoming, response) => {
	const request = buildRequest(incoming, { response, signal: shutdown.signal })
	request.signal.addEventListener('abort', () => console.log('client gone or server stopping'))
})
```

### Practices

- **One engine, one seam per face** — compose `Router` directly for a
  method-less consumer (a `Navigator`), or through `Dispatcher` for
  method-dimensioned fetch dispatch; never rebuild the matching logic per
  face.
- **Guard the registration boundary, not the hot path** — `add` throws a
  `ContractError` on a malformed entry; `match`/`handle` carry zero guards.
- **Let handler throws propagate** — the dispatcher is not an error
  boundary; a consuming server installs its own around `handle`.
- **Dedup with `key`, not manual lookups** — pass a `key` function instead of
  checking `router.entries()` before every `add`.
- **Never build a second registry** — compose the same core `Router` other
  faces use; a `Navigator` never hand-rolls its own path matching.
- **Thread `signal` into async guard work** — a slow guard can cancel its own
  work when it observes `signal.aborted`, closing the stale-guard race.
- **Keep rendering outside the Navigator** — subscribe to `navigate` and
  render in the consumer, never inside this headless entity.
- **`stop()`/`destroy()` before disposal** — releases listeners and aborts
  any pending guard; `destroy()` also tears down the `#emitter`.
- **Pass the paired response to `buildRequest`** — its `close` aborts the
  request signal on a disconnect after the body, and its `finish` discards a
  body the handler left unread, so a keep-alive connection serves its next
  request.
- **Cancel a body you stop reading** — a cancel discards the rest of the upload
  in place; it never aborts `request.signal` and never closes the connection.
- **Install your own error boundary for mapped error responses** — the
  router (core and this adapter) never invents one; a handler throw
  propagates.
- **Thread `request.signal` into downstream work** — a handler can cancel
  its own I/O when the client disconnects, the fetch-standard idiom.
- **Skip this face entirely on fetch-native runtimes** — Bun, Deno, and
  workers hand `Request`s to `dispatcher.handle` directly.

## Tests

- [`tests/guides.test.ts`](../tests/guides.test.ts) — the `## Surface` ↔
  `src/core` / `src/browser` / `src/server` bijection (value + type exports), the
  interface-to-class method bijection for `RouterInterface`, `GroupInterface`,
  `DispatcherInterface`, `DispatchGroupInterface`, and `NavigatorInterface`, and the
  equality gate: every `Summary` cell against its declaration's description paragraph,
  the titled `Register and match` fence against the `@example` block of that title (pinned so
  the titled pair cannot be retired silently), and the README pitch against this guide's
  tagline. It also runs the flagship fences this project can execute and asserts the
  values their comments claim.
- [`tests/src/core/Router.test.ts`](../tests/src/core/Router.test.ts) —
  registration boundary guard, method-less matching, order-independent
  literal-over-param-over-wildcard precedence, wildcard capture, the
  `answers` seam, `entries()` (all + filtered), dedup through `key`, case
  sensitivity, and `RouterInterface` conformance.
- [`tests/src/core/Group.test.ts`](../tests/src/core/Group.test.ts) —
  `Group` direct construction, prefix composition and nesting, batch
  registration, dedup-key collision across differently-nested group chains,
  and `GroupInterface` conformance.
- [`tests/src/core/Dispatcher.test.ts`](../tests/src/core/Dispatcher.test.ts) —
  type-level surfaces (`RouteHandler` context typing, `TState` generic flow,
  `DispatcherInterface` member shape, factory return type), emitter event
  payload shapes, destroy idempotence, the cross-face grammar parity
  fixture, the full functional dispatch matrix (auto-HEAD, auto-OPTIONS,
  404/405 responders, handler-throw propagation), and per-method dedup.
- [`tests/src/core/DispatchGroup.test.ts`](../tests/src/core/DispatchGroup.test.ts) —
  `DispatchGroup` direct construction and group + nested group registration
  with prefixes composed.
- [`tests/src/core/helpers.test.ts`](../tests/src/core/helpers.test.ts) —
  `canonicalizePath`, `computeDispatchKey`, `compilePath` (literal/param/wildcard, escaped
  regex metacharacters, encoded literals, trailing-slash folding, case sensitivity, and each
  registration refusal), `decodeParam` (including a malformed `%` escape), `matchPath`,
  `classifySegment` (the literal-vs-param classification fix regression
  case), `computeSpecificity`, `compareSpecificity` (tier, then literal length),
  `encodePath`, `collectInputs`, `joinPaths`, and
  `defineRoute` (identity pass-through, literal `Path` preservation at the
  call site).
- [`tests/src/core/integration.test.ts`](../tests/src/core/integration.test.ts) —
  the path matrix: `Router.match` and `Dispatcher.handle` against a reference
  matcher written from the declared grammar, with its own encode set, refusal list,
  and method list, over segment shapes, segment counts, trailing slashes, request
  forms, case rules, methods, and registration orders, through the URL door and the
  raw-text door, with the precedence applied by sort, an order-permutation property,
  the encoder's pairs and a seeded differential, the host row, the registration
  refusals, the batch admission, and the hand-declared rows for each path finding.
- [`tests/src/core/parsers.test.ts`](../tests/src/core/parsers.test.ts) —
  `parseMethod` narrowing every registrable verb, rejecting an unknown verb
  and the wrong casing, and accepting exactly the verbs `METHOD_LIST`
  declares.
- [`tests/src/core/factories.test.ts`](../tests/src/core/factories.test.ts) —
  `createRouter`/`createDispatcher` round-trips and factory return-type
  assertions.
- [`tests/src/browser/Navigator.test.ts`](../tests/src/browser/Navigator.test.ts) —
  hash and history modes, `navigate()`/`active`/`navigate` event, fallback
  semantics, guard veto (sync + async, including supersede-discard), the guard
  before the URL moves, the restore after a browser-initiated veto, a `navigate`
  from a `navigate` listener, calls after `destroy`, link interception on/off and
  outside `base`, `base` and hash text compared in one form,
  `start`/`stop`/`destroy` idempotence, every door (history and hash `navigate`,
  the configured and default fallback, raw and encoded text through `router.match`)
  reaching a literal the path encoder changes,
  `NavigatorInterface` conformance, and the transcriptions of this guide's
  `@orkestrel/router/browser` fences.
- [`tests/src/browser/integration.test.ts`](../tests/src/browser/integration.test.ts) —
  the core path grammar on the Chromium host: the host row, and a `|` literal through
  Chromium's URL parsing of `new URL` and `history.pushState`, handed to `new Request` and
  the real dispatcher (no fetch, navigation, or socket runs there).
- [`tests/src/browser/factories.test.ts`](../tests/src/browser/factories.test.ts) —
  `createNavigator` returns a working `NavigatorInterface`.
- [`tests/src/browser/helpers.test.ts`](../tests/src/browser/helpers.test.ts) —
  `computeNavigationKey`, `extractHashPath`, `resolveLocationPath` (hash + history, with/without
  `base`, a non-ASCII `base`, and `undefined` outside `base`), and `findAnchor` (including a click on a styled child inside an
  anchor).
- [`tests/src/server/validators.test.ts`](../tests/src/server/validators.test.ts) —
  `isEncryptedSocket` on a real TLS socket, a plain socket, a plain record, and
  every off-shape value; `isAuthority` over accepted and refused authorities and
  every non-string value.
- [`tests/src/server/helpers.test.ts`](../tests/src/server/helpers.test.ts) —
  `buildURL` by target form, scheme, `Host`, and origin, with each refusal;
  `readChunk` and `discardBody` on a paused message; `buildRequest` fidelity
  (method, URL, headers including multi-value and `set-cookie`, body streaming,
  the incomplete-request abort, and normal-response signal and listener
  cleanup); and `sendResponse` (status, headers including `set-cookie`, bodies,
  backpressure, a disconnect under pressure, and a body that is no stream) over
  real `node:http` sockets.
- [`tests/src/server/integration.test.ts`](../tests/src/server/integration.test.ts) —
  the HTTP conformance matrix: each row fed to a bare `node:http` control and to
  the adapter, read through a raw client's own framing parse — the target form
  and `Host` tables, the unread body's `bytesRead` at two upload sizes, a cancel
  that leaves the connection reusable, a failed body and a refused header read
  as aborted, the idle-body cancel on disconnect, the request signal, and the
  transport rows (matched, 404, 405, auto-HEAD, auto-OPTIONS, a handler throw,
  and per-request state) through the three-call composition, with the
  `Composing a server` fence transcribed.

## See also

- [`AGENTS.md`](../AGENTS.md) — the rules: the Emitter pattern, the
  contract & validation architecture, one engine with native overrides,
  and documentation as contracts.
- [`abort.md`](abort.md) — `@orkestrel/abort`, the supersede-safe guard
  cancellation primitive the Navigator composes, and the primitive behind the
  request signal `buildRequest` builds.
- [`README.md`](README.md) — the guides index.
