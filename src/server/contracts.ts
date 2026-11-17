import {
	arrayShape,
	booleanShape,
	createContract,
	functionShape,
	integerShape,
	literalShape,
	numberShape,
	objectShape,
	optionalShape,
	rawShape,
	recordShape,
	stringShape,
	unionShape,
} from '@orkestrel/contract'
import { buildForeignContract } from './combinators.js'

/**
 * Admits `BoundaryOptions` whole for `createBoundary`: a boolean `expose` and a function `report`.
 *
 * @remarks
 * Every bag contract in this file refuses an undeclared key and a missing required key; a foreign
 * guard accepts a class instance and unknown members.
 */
export const BOUNDARY_CONTRACT = createContract(
	objectShape({
		expose: optionalShape(booleanShape()),
		report: optionalShape(functionShape()),
	}),
)

/** Admits `TelemetryOptions` whole for `createTelemetry`: a required function `record`. */
export const TELEMETRY_CONTRACT = createContract(objectShape({ record: functionShape() }))

/**
 * Admits `CompressionOptions` whole for `createCompression`: a non-negative finite `threshold`,
 * an `encodings` array of `Encoding` literals, and a function `filter`.
 */
export const COMPRESSION_CONTRACT = createContract(
	objectShape({
		threshold: optionalShape(numberShape({ min: 0 })),
		encodings: optionalShape(arrayShape(literalShape(['gzip', 'deflate', 'identity']))),
		filter: optionalShape(functionShape()),
	}),
)

/**
 * Admits `NodeCompressionOptions` whole for `createNodeCompression`: a non-negative finite
 * `threshold` and a function `filter`.
 */
export const NODE_COMPRESSION_CONTRACT = createContract(
	objectShape({
		threshold: optionalShape(numberShape({ min: 0 })),
		filter: optionalShape(functionShape()),
	}),
)

/**
 * Admits `SecurityOptions` whole for `createSecurity`: each header option is a string or
 * `false`, `coep` and `hsts` are a string or a boolean, and `identifier` is `{ trust? }` or `false`.
 */
export const SECURITY_CONTRACT = createContract(
	objectShape({
		frame: optionalShape(literalShape(['DENY', 'SAMEORIGIN', false])),
		csp: optionalShape(unionShape(stringShape(), literalShape([false]))),
		referrer: optionalShape(unionShape(stringShape(), literalShape([false]))),
		permissions: optionalShape(unionShape(stringShape(), literalShape([false]))),
		coop: optionalShape(unionShape(stringShape(), literalShape([false]))),
		corp: optionalShape(unionShape(stringShape(), literalShape([false]))),
		cluster: optionalShape(unionShape(stringShape(), literalShape([false]))),
		coep: optionalShape(unionShape(stringShape(), booleanShape())),
		hsts: optionalShape(unionShape(stringShape(), booleanShape())),
		identifier: optionalShape(
			unionShape(objectShape({ trust: optionalShape(booleanShape()) }), literalShape([false])),
		),
	}),
)

/**
 * Admits `CorsOptions` whole for `createCors`: `origin` is a string or a string array, and
 * `methods` and `headers` are string arrays.
 */
export const CORS_CONTRACT = createContract(
	objectShape({
		origin: optionalShape(unionShape(stringShape(), arrayShape(stringShape()))),
		methods: optionalShape(arrayShape(stringShape())),
		headers: optionalShape(arrayShape(stringShape())),
	}),
)

/**
 * Admits `DeadlineOptions` whole for `createDeadline`: an integer `ms` from 1 through
 * 2147483647, the range `@orkestrel/timeout` enforces, and an integer `status` from 200 through 599.
 *
 * @remarks
 * The shape has no exclusive bound, so `Number.MIN_VALUE`, the smallest positive number, is the
 * inclusive minimum of every other positive range in this file.
 */
export const DEADLINE_CONTRACT = createContract(
	objectShape({
		ms: integerShape({ min: 1, max: 2_147_483_647 }),
		status: optionalShape(integerShape({ min: 200, max: 599 })),
	}),
)

/**
 * Admits `ForwardedOptions` whole for `createForwarded`: exactly one of an integer `proxies` of
 * at least 1 or a `trusted` string array.
 */
export const FORWARDED_CONTRACT = createContract(
	unionShape(
		objectShape({ proxies: integerShape({ min: 1 }) }),
		objectShape({ trusted: arrayShape(stringShape()) }),
	),
)

/** Admits `ETagOptions` whole for `createETag`: a boolean `weak`. */
export const ETAG_CONTRACT = createContract(objectShape({ weak: optionalShape(booleanShape()) }))

/**
 * Admits `BearerOptions` whole for `createBearer`: a required function `verify`, string `header`
 * and `scheme`, and a `challenge` record of strings.
 */
export const BEARER_CONTRACT = createContract(
	objectShape({
		verify: functionShape(),
		header: optionalShape(stringShape()),
		scheme: optionalShape(stringShape()),
		challenge: optionalShape(recordShape(stringShape())),
	}),
)

/**
 * Admits `LimiterOptions` whole for `createLimiter`: an integer `max` of at least 1, a positive
 * finite `window`, an integer `capacity` of at least 1, and the declared functions; `store` is a
 * foreign key that {@link LIMITER_STORE_FOREIGN} checks after admission.
 */
export const LIMITER_CONTRACT = createContract(
	objectShape({
		store: optionalShape(rawShape({})),
		max: integerShape({ min: 1 }),
		window: numberShape({ min: Number.MIN_VALUE }),
		capacity: optionalShape(integerShape({ min: 1 })),
		key: optionalShape(functionShape()),
		message: optionalShape(stringShape()),
		clock: optionalShape(functionShape()),
		policy: optionalShape(booleanShape()),
		evict: optionalShape(functionShape()),
	}),
)

/**
 * Admits `SessionOptions` whole for `createSession`: positive finite `ttl` and `lifetime`, an
 * integer `capacity` of at least 1, and the declared functions; `transport` and `store` are
 * foreign keys that {@link SESSION_TRANSPORT_FOREIGN} and {@link SESSION_STORE_FOREIGN} check
 * after admission.
 */
export const SESSION_CONTRACT = createContract(
	objectShape({
		transport: rawShape({}),
		store: optionalShape(rawShape({})),
		ttl: optionalShape(numberShape({ min: Number.MIN_VALUE })),
		lifetime: optionalShape(numberShape({ min: Number.MIN_VALUE })),
		capacity: optionalShape(integerShape({ min: 1 })),
		evict: optionalShape(functionShape()),
		create: optionalShape(functionShape()),
		mint: optionalShape(functionShape()),
		required: optionalShape(booleanShape()),
		clock: optionalShape(functionShape()),
	}),
)

/**
 * Admits `CookieTransportOptions` whole for `createCookieTransport`: a string `name`, a required
 * `signer`, checked as a foreign key, and an owned `cookie` record of the six optional members
 * `@orkestrel/server` declares: string `path` and `domain`, a finite number `maxAge` (a
 * non-finite value writes `Max-Age=NaN` or `Max-Age=Infinity` into `Set-Cookie`), boolean
 * `httpOnly` and `secure`, and a `sameSite` of `'Strict'`, `'Lax'`, or `'None'`.
 */
export const COOKIE_TRANSPORT_CONTRACT = createContract(
	objectShape({
		name: optionalShape(stringShape()),
		signer: rawShape({}),
		cookie: optionalShape(
			objectShape({
				path: optionalShape(stringShape()),
				domain: optionalShape(stringShape()),
				maxAge: optionalShape(numberShape()),
				httpOnly: optionalShape(booleanShape()),
				secure: optionalShape(booleanShape()),
				sameSite: optionalShape(literalShape(['Strict', 'Lax', 'None'])),
			}),
		),
	}),
)

/** Admits `HeaderTransportOptions` whole for `createHeaderTransport`: a string `header`. */
export const HEADER_TRANSPORT_CONTRACT = createContract(
	objectShape({ header: optionalShape(stringShape()) }),
)

/**
 * Admits `SessionLimits` whole for `createDatabaseSessionStore`: positive finite `ttl` and
 * `lifetime`.
 */
export const SESSION_LIMITS_CONTRACT = createContract(
	objectShape({
		ttl: optionalShape(numberShape({ min: Number.MIN_VALUE })),
		lifetime: optionalShape(numberShape({ min: Number.MIN_VALUE })),
	}),
)

/**
 * Admits `MemorySessionStoreOptions` whole for `createMemorySessionStore`: positive finite `ttl`
 * and `lifetime`, an integer `capacity` of at least 1, and a function `evict`.
 */
export const MEMORY_SESSION_STORE_CONTRACT = createContract(
	objectShape({
		ttl: optionalShape(numberShape({ min: Number.MIN_VALUE })),
		lifetime: optionalShape(numberShape({ min: Number.MIN_VALUE })),
		capacity: optionalShape(integerShape({ min: 1 })),
		evict: optionalShape(functionShape()),
	}),
)

/**
 * Admits `MemoryLimiterStoreOptions` whole for `createMemoryLimiterStore`: an integer `capacity`
 * of at least 1 and a function `evict`.
 */
export const MEMORY_LIMITER_STORE_CONTRACT = createContract(
	objectShape({
		capacity: optionalShape(integerShape({ min: 1 })),
		evict: optionalShape(functionShape()),
	}),
)

/**
 * Admits `CSRFOptions` whole for `createCSRF`: a required `signer` that {@link SIGNER_FOREIGN}
 * checks after admission, string `cookie`, `header`, and `field`, and a `safe` string array.
 */
export const CSRF_CONTRACT = createContract(
	objectShape({
		signer: rawShape({}),
		cookie: optionalShape(stringShape()),
		header: optionalShape(stringShape()),
		field: optionalShape(stringShape()),
		safe: optionalShape(arrayShape(stringShape())),
	}),
)

/**
 * Admits the arguments of `only` and `except` whole: `paths` is a string or a string array, and
 * `handler` is a function.
 */
export const SCOPE_CONTRACT = createContract(
	objectShape({
		paths: unionShape(stringShape(), arrayShape(stringShape())),
		handler: functionShape(),
	}),
)

/**
 * Admits `AssetOptions` whole for `createAssets`: both keys are foreign, so
 * {@link ASSET_SOURCE_FOREIGN} and {@link ASSET_STORE_FOREIGN} check them after admission.
 */
export const ASSET_CONTRACT = createContract(
	objectShape({
		source: rawShape({}),
		store: optionalShape(rawShape({})),
	}),
)

/**
 * Admits `StaticOptions` whole for `createStatic`: a non-empty string `root`, a non-negative
 * finite `cache`, a `dotfiles` literal, and a `fallback` that is a boolean or `{ exclude? }`.
 */
export const STATIC_CONTRACT = createContract(
	objectShape({
		root: stringShape({ min: 1 }),
		prefix: optionalShape(stringShape()),
		index: optionalShape(stringShape()),
		dotfiles: optionalShape(literalShape(['ignore', 'deny', 'allow'])),
		cache: optionalShape(numberShape({ min: 0 })),
		etag: optionalShape(booleanShape()),
		fallback: optionalShape(
			unionShape(booleanShape(), objectShape({ exclude: optionalShape(stringShape()) })),
		),
	}),
)

/**
 * Admits `MultipartOptions` whole for `createMultipart`: non-negative finite sizes and totals,
 * non-negative integer counts, a string array `allowed`, and a string `directory`.
 */
export const MULTIPART_CONTRACT = createContract(
	objectShape({
		limits: optionalShape(
			objectShape({
				file: optionalShape(
					objectShape({
						size: optionalShape(numberShape({ min: 0 })),
						count: optionalShape(integerShape({ min: 0 })),
					}),
				),
				field: optionalShape(
					objectShape({
						size: optionalShape(numberShape({ min: 0 })),
						count: optionalShape(integerShape({ min: 0 })),
					}),
				),
				total: optionalShape(numberShape({ min: 0 })),
			}),
		),
		allowed: optionalShape(arrayShape(stringShape())),
		directory: optionalShape(stringShape()),
	}),
)

/**
 * Admits one `UploadedFile` whole for `createUploadedFile`: string `field`, `name`, `mime`, and
 * `path`, a non-negative finite `size`, a boolean `validated`, and a `status` literal.
 */
export const UPLOADED_FILE_CONTRACT = createContract(
	objectShape({
		field: stringShape(),
		name: stringShape(),
		size: numberShape({ min: 0 }),
		mime: stringShape(),
		validated: booleanShape(),
		status: literalShape(['staged', 'moved']),
		path: stringShape(),
	}),
)

/** Holds the members `LimiterOptions.store` declares: `consume`. */
export const LIMITER_STORE_FOREIGN = buildForeignContract(['consume'])

/** Holds the members `SessionOptions.transport` declares: `read`, `write`, and `clear`. */
export const SESSION_TRANSPORT_FOREIGN = buildForeignContract(['read', 'write', 'clear'])

/** Holds the members `SessionOptions.store` declares: `get`, `set`, and `delete`. */
export const SESSION_STORE_FOREIGN = buildForeignContract(['get', 'set', 'delete'])

/** Holds the members `CookieTransportOptions.signer` and `CSRFOptions.signer` declare: `sign` and `verify`. */
export const SIGNER_FOREIGN = buildForeignContract(['sign', 'verify'])

/** Holds the members `AssetOptions.source` declares: `read`. */
export const ASSET_SOURCE_FOREIGN = buildForeignContract(['read'])

/** Holds the members `AssetOptions.store` declares: `get`, `set`, and `delete`. */
export const ASSET_STORE_FOREIGN = buildForeignContract(['get', 'set', 'delete'])
