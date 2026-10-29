import type { MultipartState } from '@src/core'
import type {
	AssetOptions,
	MultipartOptions,
	NodeCompressionOptions,
	StaticOptions,
} from './types.js'
import type { MiddlewareHandler } from '@orkestrel/server'
import { DEFAULT_COMPRESSION_THRESHOLD, compressResponse } from '@src/core'
import { realpath } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { HTTPError } from '@orkestrel/server'
import { attempt, isFiniteNumber, isFunction, isObject, isString } from '@orkestrel/contract'
import {
	DEFAULT_STATIC_DOTFILES,
	DEFAULT_STATIC_FALLBACK_EXCLUDE,
	DEFAULT_STATIC_INDEX,
	NODE_COMPRESSION_ENCODINGS,
} from './constants.js'
import { isMultipartError } from './errors.js'
import {
	compressNodeBytes,
	isDotfilePath,
	resolveAssetKey,
	readAssetRecord,
	buildAssetResponse,
	resolveStaticFile,
	openStaticFile,
	planStaticResponse,
	resolveStaticFallbackPath,
	resolveStaticPath,
	streamFile,
	unlinkStagedFiles,
} from './helpers.js'
import { parseMultipartRequest } from './parsers.js'
import { MemoryAssetStore } from './stores/MemoryAssetStore.js'

/**
 * Serves validated in-memory assets with identity/Brotli negotiation.
 *
 * @remarks
 * Only `GET` and `HEAD` are served. `/` resolves to `index.html`. Every other
 * key is decoded once, must remain relative, and refuses empty, dot, climbing,
 * backslash, and dotfile segments before the source is read. Successful source
 * values are copied and cached by key. Concurrent misses can compute a digest twice.
 * A Brotli value is decompressed for
 * the identity representation; both representations share an ETag computed
 * from those identity bytes. Responses always vary on `Accept-Encoding`.
 * Range requests are intentionally served as full responses because an asset
 * source exposes complete in-memory representations rather than file handles.
 *
 * @typeParam TState - The consumer's opaque per-request state type
 * @param options - See {@link AssetOptions}
 * @returns A `MiddlewareHandler<TState>`
 * @throws {TypeError} When `options.source` does not implement
 * {@link AssetSourceInterface}, or when it returns malformed asset data
 * @throws {Error} When a source marks bytes as Brotli but they cannot be decompressed
 *
 * @example
 * ```ts
 * import { createAssets } from '@orkestrel/middleware/server'
 *
 * const assets = createAssets({
 * 	source: {
 * 		read: (path) =>
 * 			path === 'index.html'
 * 				? { body: new TextEncoder().encode('home') }
 * 				: undefined,
 * 	},
 * })
 * ```
 */
export function createAssets<TState>(options: AssetOptions): MiddlewareHandler<TState> {
	if (!isObject(options?.source) || !('read' in options.source) || !isFunction(options.source.read))
		throw new TypeError('AssetOptions.source must implement AssetSourceInterface')
	if (
		options.store !== undefined &&
		(!isFunction(options.store.get) ||
			!isFunction(options.store.set) ||
			!isFunction(options.store.delete))
	)
		throw new TypeError('AssetOptions.store must implement AssetStoreInterface')
	const store = options.store ?? new MemoryAssetStore()

	return async (request, context, next) => {
		if (context.method !== 'GET' && context.method !== 'HEAD') return next()
		const key = resolveAssetKey(context.url.pathname)
		if (key === undefined) return next()
		const cached = await store.get(key)
		const record = cached ?? (await readAssetRecord(options.source, key))
		if (record === undefined) return next()
		if (cached === undefined) await store.set(record)
		return buildAssetResponse(request, context.method, record)
	}
}

/**
 * Serves static files from `options.root` over `node:fs` — the node-bound static-file
 * battery, answering conditional, ranged, and SPA-fallback requests.
 *
 * @remarks
 * Containment is enforced on canonical paths, not merely the lexically
 * resolved one: `options.root` is canonicalized per request and every
 * request's candidate path is re-canonicalized (`fs.realpath`) before it is
 * served, so a symlink whose target escapes `root` is refused (falls through
 * to `next()`) even though the lexical path resolved inside `root`. A
 * symlink that resolves to a target still inside `root` is unaffected and
 * still serves normally. A dangling symlink (`realpath` throws `ENOENT`) or
 * any other `realpath` failure is treated as a miss — this battery never
 * throws or 500s on a symlink surprise. On a streamed response (a 200 or 206
 * that carries a file body), the open `FileHandle` is owned by the
 * `Response` body and is released only once that body is fully read or
 * cancelled — Node HTTP servers do this automatically when sending the
 * response, but a caller that holds an unread `Response` (for example in a test)
 * must cancel its body to release the handle promptly.
 *
 * @typeParam TState - The consumer's opaque per-request state type
 * @param options - See {@link StaticOptions}
 * @returns A `MiddlewareHandler<TState>`
 * @throws {TypeError} When `options.root` is not a non-empty string
 *
 * @example
 * ```ts
 * import { createStatic } from '@orkestrel/middleware/server'
 *
 * const serveFiles = createStatic({ root: '/srv/public', fallback: true })
 * ```
 */
export function createStatic<TState>(options: StaticOptions): MiddlewareHandler<TState> {
	if (!isString(options.root) || options.root.length === 0)
		throw new TypeError('createStatic requires options.root to be a non-empty string')
	const root = resolve(options.root)
	const index = options.index ?? DEFAULT_STATIC_INDEX
	const dotfiles = options.dotfiles ?? DEFAULT_STATIC_DOTFILES
	const useETag = options.etag ?? true
	const fallback =
		options.fallback === true
			? { exclude: DEFAULT_STATIC_FALLBACK_EXCLUDE }
			: options.fallback === false || options.fallback === undefined
				? undefined
				: { exclude: options.fallback.exclude ?? DEFAULT_STATIC_FALLBACK_EXCLUDE }

	return async (request, context, next) => {
		if (context.method !== 'GET' && context.method !== 'HEAD') return next()

		const target = resolveStaticPath(root, options.prefix, context.url.pathname)
		if (target === undefined) return next()

		const relativePath = relative(root, target)
		if (relativePath.length > 0 && isDotfilePath(relativePath)) {
			if (dotfiles === 'deny') throw new HTTPError(403, 'forbidden')
			if (dotfiles === 'ignore') return next()
		}

		const rootReal = await realpath(root).catch(() => undefined)
		if (rootReal === undefined) return next()
		const primary = await resolveStaticFile(target, rootReal, index)
		const direct = primary === undefined ? undefined : await openStaticFile(primary)
		const shellPath =
			direct === undefined && fallback !== undefined
				? resolveStaticFallbackPath(
						root,
						index,
						fallback.exclude,
						context.method,
						context.url.pathname,
						request.headers.get('accept') ?? '',
					)
				: undefined
		const shellReal =
			shellPath === undefined ? undefined : await resolveStaticFile(shellPath, rootReal, index)
		const shell = shellReal === undefined ? undefined : await openStaticFile(shellReal)
		const file = direct ?? shell
		if (file === undefined) return next()
		const plan = attempt(() =>
			planStaticResponse(request, context.method, file.info, file.path, {
				...(options.cache === undefined ? {} : { cache: options.cache }),
				etag: useETag,
			}),
		)
		if (!plan.success) {
			await file.handle.close().catch(() => {})
			throw plan.error
		}
		const streamed =
			context.method === 'GET' && (plan.value.status === 200 || plan.value.status === 206)
		if (!streamed) {
			await file.handle.close()
			return new Response(null, plan.value)
		}
		const body = streamFile(file.handle, plan.value.range)
		return new Response(body, plan.value)
	}
}

/**
 * Parses a streamed `multipart/form-data` request body and stashes its
 * {@link MultipartBody} on `context.state.multipart` — the node-bound
 * streaming multipart battery.
 *
 * @remarks
 * A non-multipart request passes through untouched. Consumes `request.body`
 * as a stream — `context.body()` must not be called for a request this
 * battery has processed (the underlying stream is exhausted). Every
 * {@link MultipartError} this battery's parser throws is re-thrown as an
 * {@link HTTPError} carrying the same status/message, so `createBoundary`
 * (or any HTTPError-aware renderer) maps it correctly without depending on
 * this node face's error type. Fail-closed on the downstream handler too: if
 * `next()` throws, every still-`'staged'` uploaded file is unlinked
 * (best-effort) before the error is re-thrown, so an unhandled downstream
 * failure never leaks temp files. A normal return leaves staged files
 * untouched — the downstream handler owns moving/reading them.
 *
 * @typeParam TState - The consumer's state type, extending {@link MultipartState}
 * @param options - See {@link MultipartOptions}
 * @returns A `MiddlewareHandler<TState>`
 * @throws {HTTPError} When the underlying parse throws a {@link MultipartError}
 * (limit breach → 413, malformed structure → 400, rejected file type → 415)
 *
 * @example
 * ```ts
 * import { createMultipart } from '@orkestrel/middleware/server'
 *
 * const uploads = createMultipart({ allowed: ['image/png', 'image/jpeg'] })
 * ```
 */
export function createMultipart<TState extends MultipartState>(
	options: MultipartOptions = {},
): MiddlewareHandler<TState> {
	return async (request, context, next) => {
		const [outcome] = await Promise.allSettled([parseMultipartRequest(request, options)])
		if (outcome.status === 'rejected') {
			const error: unknown = outcome.reason
			if (isMultipartError(error)) throw new HTTPError(error.status, error.message, error.context)
			throw error
		}
		const body = outcome.value
		if (body === undefined) return next()
		Object.assign(context.state, { multipart: body })
		try {
			return await next()
		} catch (error) {
			await unlinkStagedFiles(body)
			throw error
		}
	}
}

/**
 * Compresses response bodies through `node:zlib`, guaranteed on any Node runtime rather
 * than dependent on the WHATWG `CompressionStream` global. This battery is the
 * node-bound sibling of the core face's feature-detected `createCompression`, and it
 * ships from a separate package entry point (`@orkestrel/middleware/server`) so the
 * shared name is unambiguous per consumer import path.
 *
 * @remarks
 * Peer-type limitation, the same one the core face carries: the shipped
 * `@orkestrel/server` `Encoding` union is `'gzip' | 'deflate' | 'identity'`
 * — it does not include `'br'`, so this battery cannot honestly type or
 * negotiate a guaranteed brotli coding despite `node:zlib` shipping
 * `brotliCompress`. It guarantees `gzip`/`deflate` through `node:zlib` (never
 * feature-detected — always available) and negotiates only those.
 *
 * @typeParam TState - The consumer's opaque per-request state type
 * @param options - See {@link NodeCompressionOptions}
 * @returns A `MiddlewareHandler<TState>`
 * @throws {TypeError} When `options.threshold` is provided and is not a
 * finite number, or `options.filter` is provided and is not a function
 *
 * @example
 * ```ts
 * import { createCompression } from '@orkestrel/middleware/server'
 *
 * const compress = createCompression({ threshold: 512 })
 * ```
 */
export function createCompression<TState>(
	options?: NodeCompressionOptions,
): MiddlewareHandler<TState> {
	if (options?.threshold !== undefined && !isFiniteNumber(options.threshold))
		throw new TypeError('NodeCompressionOptions.threshold must be a finite number when provided')
	if (options?.filter !== undefined && !isFunction(options.filter))
		throw new TypeError('NodeCompressionOptions.filter must be a function when provided')
	const threshold = options?.threshold ?? DEFAULT_COMPRESSION_THRESHOLD
	const filter = options?.filter
	const encodings = NODE_COMPRESSION_ENCODINGS
	return async (request, context, next) => {
		const response = await next()
		return compressResponse(request, context, response, {
			threshold,
			...(filter !== undefined ? { filter } : {}),
			encodings,
			compress: compressNodeBytes,
		})
	}
}
