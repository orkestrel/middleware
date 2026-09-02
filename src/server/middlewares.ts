import type { MultipartBody, MultipartState } from '@src/core'
import type {
	AssetOptions,
	MultipartOptions,
	NodeCompressionOptions,
	StaticOptions,
} from './types.js'
import type { Stats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { DEFAULT_COMPRESSION_THRESHOLD, compressResponse } from '@src/core'
import { open, realpath, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { brotliDecompressSync } from 'node:zlib'
import type { MiddlewareHandler } from '@orkestrel/server'
import {
	computeBodyETag,
	HTTPError,
	matchesETag,
	negotiateEncoding,
	parseRange,
} from '@orkestrel/server'
import {
	isArrayBuffer,
	isFiniteNumber,
	isFunction,
	isObject,
	isString,
	isUint8Array,
} from '@orkestrel/contract'
import {
	DEFAULT_STATIC_DOTFILES,
	DEFAULT_STATIC_FALLBACK_EXCLUDE,
	DEFAULT_STATIC_INDEX,
	NODE_COMPRESSION_ENCODINGS,
} from './constants.js'
import { isMultipartError } from './errors.js'
import {
	computeFileETag,
	compressNodeBytes,
	isContainedPath,
	isDotfilePath,
	lookupContentType,
	resolveContainedRealPath,
	resolveStaticFallbackPath,
	resolveStaticPath,
	streamFile,
	unlinkStagedFiles,
} from './helpers.js'
import { parseMultipartRequest } from './parsers.js'

/**
 * Serve validated in-memory assets with identity/Brotli negotiation.
 *
 * @remarks
 * Only `GET` and `HEAD` are served. `/` resolves to `index.html`. Every other
 * key is decoded once, must remain relative, and refuses empty, dot, climbing,
 * backslash, and dotfile segments before the source is read. Successful source
 * values are copied and cached by key. A Brotli value is decompressed once for
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
	const identities = new Map<string, Uint8Array<ArrayBuffer>>()
	const brotlis = new Map<string, Uint8Array<ArrayBuffer>>()
	const tags = new Map<string, Promise<string>>()

	return async (request, context, next) => {
		if (context.method !== 'GET' && context.method !== 'HEAD') return next()
		let pathname: string
		try {
			pathname = decodeURIComponent(context.url.pathname)
		} catch {
			return next()
		}
		const key = pathname === '/' ? DEFAULT_STATIC_INDEX : pathname.slice(1)
		if (
			key.length === 0 ||
			key.includes('\\') ||
			key
				.split('/')
				.some((segment) => segment.length === 0 || segment === '.' || segment === '..') ||
			isDotfilePath(key)
		)
			return next()

		let identity = identities.get(key)
		let brotli = brotlis.get(key)
		if (identity === undefined) {
			const asset = options.source.read(key)
			if (asset === undefined) return next()
			if (!isObject(asset)) throw new TypeError('AssetSourceInterface.read must return an Asset')
			const body = asset.body
			const encoding = asset.encoding
			if (
				(!isArrayBuffer(body) && !isUint8Array(body)) ||
				(encoding !== undefined && encoding !== 'br')
			)
				throw new TypeError('AssetSourceInterface.read must return an Asset')
			const content = isArrayBuffer(body)
				? Uint8Array.from(new Uint8Array(body))
				: Uint8Array.from(body)
			if (encoding === 'br') {
				brotli = content
				identity = Uint8Array.from(brotliDecompressSync(content))
				brotlis.set(key, brotli)
			} else {
				identity = content
			}
			identities.set(key, identity)
		}

		let pending = tags.get(key)
		if (pending === undefined) {
			pending = computeBodyETag(identity)
			tags.set(key, pending)
		}
		const etag = await pending
		let body = identity
		let encoding: 'br' | undefined
		if (
			brotli !== undefined &&
			negotiateEncoding(request.headers.get('accept-encoding') ?? '', ['br']) === 'br'
		) {
			body = brotli
			encoding = 'br'
		}
		const headers = new Headers({
			'content-type': lookupContentType(key),
			etag,
			vary: 'accept-encoding',
		})
		if (encoding !== undefined) headers.set('content-encoding', encoding)
		const cached = request.headers.get('if-none-match')
		if (cached !== null && matchesETag(cached, etag))
			return new Response(null, { status: 304, headers })
		headers.set('content-length', String(body.byteLength))
		return new Response(context.method === 'HEAD' ? undefined : body, { headers })
	}
}

/**
 * Serve static files from `options.root` over `node:fs` — the node-bound
 * static-file battery.
 *
 * @remarks
 * Containment is enforced on CANONICAL paths, not merely the lexically
 * resolved one: `options.root` is canonicalized once (memoized) and every
 * request's candidate path is re-canonicalized (`fs.realpath`) before it is
 * served, so a symlink whose target escapes `root` is refused (falls through
 * to `next()`) even though the lexical path resolved inside `root`. A
 * symlink that resolves to a target still INSIDE `root` is unaffected and
 * still serves normally. A dangling symlink (`realpath` throws `ENOENT`) or
 * any other `realpath` failure is treated as a miss — this battery never
 * throws or 500s on a symlink surprise. On a streamed response (a 200 or 206
 * that carries a file body), the open `FileHandle` is owned by the
 * `Response` body and is released only once that body is fully read or
 * cancelled — Node HTTP servers do this automatically when sending the
 * response, but a caller that holds an unread `Response` (e.g. in a test)
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

	let canonicalRootPromise: Promise<string> | undefined

	return async (request, context, next) => {
		if (context.method !== 'GET' && context.method !== 'HEAD') return next()

		const target = resolveStaticPath(root, options.prefix, context.url.pathname)
		if (target === undefined) return next()

		const relativePath = relative(root, target)
		if (relativePath.length > 0 && isDotfilePath(relativePath)) {
			if (dotfiles === 'deny') throw new HTTPError(403, 'forbidden')
			if (dotfiles === 'ignore') return next()
		}

		let resolvedPath = target
		let fallbackNeeded = false
		try {
			if (canonicalRootPromise === undefined) canonicalRootPromise = realpath(root)
			const [rootReal, targetReal] = await Promise.all([canonicalRootPromise, realpath(target)])
			if (!isContainedPath(targetReal, rootReal)) return next()
			resolvedPath = targetReal
		} catch {
			fallbackNeeded = true
		}

		// Directory-detection only — routing decision, not the served file's
		// facts. The bytes streamed and the headers computed for them come
		// from a single `fstat` on an opened handle below, closing the
		// stat-to-stream TOCTOU (a file replaced between "check" and "serve"
		// can no longer yield a 200 with stale headers over swapped bytes).
		let directoryInfo: Stats | undefined
		if (!fallbackNeeded) {
			try {
				directoryInfo = await stat(resolvedPath)
			} catch {
				fallbackNeeded = true
			}
		}

		if (directoryInfo?.isDirectory()) {
			resolvedPath = join(resolvedPath, index)
			try {
				if (canonicalRootPromise === undefined) canonicalRootPromise = realpath(root)
				const rootReal = await canonicalRootPromise
				const indexReal = await resolveContainedRealPath(resolvedPath, rootReal)
				if (indexReal === undefined) fallbackNeeded = true
				else resolvedPath = indexReal
			} catch {
				fallbackNeeded = true
			}
		}

		let handle: FileHandle | undefined
		let info: Stats | undefined
		if (!fallbackNeeded) {
			try {
				handle = await open(resolvedPath, 'r')
			} catch {
				fallbackNeeded = true
			}
		}
		if (handle !== undefined) {
			try {
				info = await handle.stat()
			} catch {
				await handle.close()
				handle = undefined
				fallbackNeeded = true
			}
		}
		if (handle !== undefined && info !== undefined && !info.isFile()) {
			await handle.close()
			handle = undefined
			info = undefined
			fallbackNeeded = true
		}

		if (fallbackNeeded) {
			const shellPath = resolveStaticFallbackPath(
				root,
				index,
				fallback?.exclude ?? DEFAULT_STATIC_FALLBACK_EXCLUDE,
				context.method,
				context.url.pathname,
				request.headers.get('accept') ?? '',
			)
			if (fallback === undefined || shellPath === undefined) return next()
			let shellReal: string
			try {
				if (canonicalRootPromise === undefined) canonicalRootPromise = realpath(root)
				const rootReal = await canonicalRootPromise
				const candidate = await resolveContainedRealPath(shellPath, rootReal)
				if (candidate === undefined) return next()
				shellReal = candidate
			} catch {
				return next()
			}
			let shellHandle: FileHandle
			try {
				shellHandle = await open(shellReal, 'r')
			} catch {
				return next()
			}
			let shellInfo: Stats
			try {
				shellInfo = await shellHandle.stat()
			} catch {
				await shellHandle.close().catch(() => {})
				return next()
			}
			if (!shellInfo.isFile()) {
				await shellHandle.close().catch(() => {})
				return next()
			}
			// The shell answers through the SAME response block the primary path
			// uses, so `cache`, `etag`, conditional revalidation, `HEAD`, and
			// ranges are computed from the shell handle's own `fstat` and cannot
			// diverge between a served file and the shell served in its place.
			resolvedPath = shellReal
			handle = shellHandle
			info = shellInfo
		}

		if (handle === undefined || info === undefined) return next()

		let streaming = false
		try {
			const headers = new Headers({
				'content-type': lookupContentType(resolvedPath),
				'accept-ranges': 'bytes',
			})
			if (options.cache !== undefined) headers.set('cache-control', `max-age=${options.cache}`)

			if (useETag) {
				const etag = computeFileETag(info.size, info.mtimeMs)
				headers.set('etag', etag)
				const ifNoneMatch = request.headers.get('if-none-match')
				if (ifNoneMatch !== null && matchesETag(ifNoneMatch, etag)) {
					await handle.close()
					return new Response(null, { status: 304, headers })
				}
			}

			if (context.method === 'HEAD') {
				await handle.close()
				headers.set('content-length', String(info.size))
				return new Response(null, { status: 200, headers })
			}

			const rangeHeader = request.headers.get('range')
			const range = parseRange(rangeHeader === null ? undefined : rangeHeader, info.size)
			if (range === undefined) {
				headers.set('content-length', String(info.size))
				const body = streamFile(handle)
				streaming = true
				return new Response(body, { status: 200, headers })
			}
			if (!range.satisfiable) {
				await handle.close()
				headers.set('content-range', `bytes */${info.size}`)
				return new Response(null, { status: 416, headers })
			}
			headers.set('content-range', `bytes ${range.start}-${range.end}/${info.size}`)
			headers.set('content-length', String(range.end - range.start + 1))
			const body = streamFile(handle, { start: range.start, end: range.end })
			streaming = true
			return new Response(body, { status: 206, headers })
		} catch (error) {
			if (!streaming) await handle.close().catch(() => {})
			throw error
		}
	}
}

/**
 * Parse a streamed `multipart/form-data` request body and stash its
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
 * this node face's error type. Fail-closed on the DOWNSTREAM handler too: if
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
		let body: MultipartBody | undefined
		try {
			body = await parseMultipartRequest(request, options)
		} catch (error) {
			if (isMultipartError(error)) throw new HTTPError(error.status, error.message, error.context)
			throw error
		}
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
 * Compress response bodies through `node:zlib` — the node-bound sibling of
 * the core face's `CompressionStream`-feature-detected `createCompression`,
 * guaranteed available on any Node runtime rather than dependent on the
 * WHATWG `CompressionStream` global. Ships as a SEPARATE package entry point
 * (`@orkestrel/middleware/server`) from the core face's `createCompression`,
 * so the shared name is unambiguous per consumer import path.
 *
 * @remarks
 * Peer-type limitation, the same one the core face carries: the shipped
 * `@orkestrel/server` `Encoding` union is `'gzip' | 'deflate' | 'identity'`
 * — it does not include `'br'`, so this battery cannot honestly type or
 * negotiate a guaranteed brotli coding despite `node:zlib` shipping
 * `brotliCompress`. It guarantees `gzip`/`deflate` via `node:zlib` (never
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
