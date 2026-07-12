import type { MultipartState } from '@src/core'
import type { MultipartOptions, NodeCompressionOptions, StaticOptions } from './types.js'
import { DEFAULT_COMPRESSION_THRESHOLD, compressResponse } from '@src/core'
import { stat } from 'node:fs/promises'
import { extname, join, relative, resolve } from 'node:path'
import { deflate as zlibDeflate, gzip as zlibGzip } from 'node:zlib'
import { promisify } from 'node:util'
import type { Encoding, MiddlewareHandler } from '@orkestrel/server'
import { HTTPError, matchesETag, parseRange } from '@orkestrel/server'
import { isFiniteNumber, isFunction, isString } from '@orkestrel/contract'
import { DEFAULT_STATIC_FALLBACK_EXCLUDE, DEFAULT_STATIC_INDEX } from './constants.js'
import { isMultipartError } from './errors.js'
import {
	computeFileETag,
	isDotfilePath,
	isUnderPath,
	lookupContentType,
	parseMultipartRequest,
	resolveStaticPath,
	streamFile,
} from './helpers.js'

// ============================================================================
//  @orkestrel/middleware/server — node-face battery factories (AGENTS §5
//  middlewares.ts). createStatic (node:fs static file serving) and
//  createMultipart (node:fs/os/crypto streaming multipart uploads) — the two
//  genuinely node-bound batteries — plus createCompression, the node-`zlib`
//  guaranteed-availability sibling of the core face's `CompressionStream`-
//  feature-detected battery (separate package entry point, ruling H).
// ============================================================================

/**
 * Serve static files from `options.root` over `node:fs` — the node-bound
 * static-file battery (PROPOSAL §4.14).
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
	const dotfiles = options.dotfiles ?? 'ignore'
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

		let resolvedPath = target
		let info: Awaited<ReturnType<typeof stat>>
		try {
			info = await stat(resolvedPath)
		} catch {
			return trySpaFallback()
		}

		if (info.isDirectory()) {
			resolvedPath = join(resolvedPath, index)
			try {
				info = await stat(resolvedPath)
			} catch {
				return trySpaFallback()
			}
		}

		if (!info.isFile()) return trySpaFallback()

		const headers = new Headers({
			'content-type': lookupContentType(resolvedPath),
			'accept-ranges': 'bytes',
		})
		if (options.cache !== undefined) headers.set('cache-control', `max-age=${options.cache}`)

		if (useETag) {
			const etag = computeFileETag(info.size, info.mtimeMs)
			headers.set('etag', etag)
			const ifNoneMatch = request.headers.get('if-none-match')
			if (ifNoneMatch !== null && matchesETag(ifNoneMatch, etag))
				return new Response(null, { status: 304, headers })
		}

		if (context.method === 'HEAD') {
			headers.set('content-length', String(info.size))
			return new Response(null, { status: 200, headers })
		}

		const rangeHeader = request.headers.get('range')
		const range = parseRange(rangeHeader === null ? undefined : rangeHeader, info.size)
		if (range === undefined) {
			headers.set('content-length', String(info.size))
			const body = streamFile(resolvedPath)
			return new Response(body, { status: 200, headers })
		}
		if (!range.satisfiable) {
			headers.set('content-range', `bytes */${info.size}`)
			return new Response(null, { status: 416, headers })
		}
		headers.set('content-range', `bytes ${range.start}-${range.end}/${info.size}`)
		headers.set('content-length', String(range.end - range.start + 1))
		const body = streamFile(resolvedPath, { start: range.start, end: range.end })
		return new Response(body, { status: 206, headers })

		function trySpaFallback(): Response | Promise<Response> {
			if (fallback === undefined) return next()
			if (context.method !== 'GET') return next()
			if (extname(context.url.pathname) !== '') return next()
			const accept = request.headers.get('accept') ?? ''
			if (!accept.includes('text/html') && !accept.includes('*/*')) return next()
			if (isUnderPath(context.url.pathname, fallback.exclude)) return next()
			const shellPath = join(root, index)
			return stat(shellPath)
				.then(
					() =>
						new Response(streamFile(shellPath), {
							status: 200,
							headers: new Headers({ 'content-type': lookupContentType(shellPath) }),
						}),
				)
				.catch(() => next())
		}
	}
}

/**
 * Parse a streamed `multipart/form-data` request body and stash its
 * {@link MultipartBody} on `context.state.multipart` — the node-bound
 * streaming multipart battery (PROPOSAL §4.15, ruling C).
 *
 * @remarks
 * A non-multipart request passes through untouched. Consumes `request.body`
 * as a stream — `context.body()` must not be called for a request this
 * battery has processed (the underlying stream is exhausted). Every
 * {@link MultipartError} this battery's parser throws is re-thrown as an
 * {@link HTTPError} carrying the same status/message, so `createBoundary`
 * (or any HTTPError-aware renderer) maps it correctly without depending on
 * this node face's error type.
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
		let body: Awaited<ReturnType<typeof parseMultipartRequest>>
		try {
			body = await parseMultipartRequest(request, options)
		} catch (error) {
			if (isMultipartError(error)) throw new HTTPError(error.status, error.message, error.context)
			throw error
		}
		if (body === undefined) return next()
		context.state.multipart = body
		return next()
	}
}

/**
 * Compress response bodies via `node:zlib` — the node-bound sibling of the
 * core face's `CompressionStream`-feature-detected `createCompression`,
 * guaranteed available on any Node runtime rather than dependent on the
 * WHATWG `CompressionStream` global (PROPOSAL §4.3, ruling J). Ships as a
 * SEPARATE package entry point (`@orkestrel/middleware/server`) from the core
 * face's `createCompression`, so the shared name is unambiguous per
 * consumer import path (ruling H).
 *
 * @remarks
 * Peer-type limitation (same one U1 recorded on the core face): the shipped
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
	const encodings: readonly Encoding[] = ['gzip', 'deflate']
	const gzipAsync = promisify(zlibGzip)
	const deflateAsync = promisify(zlibDeflate)

	return async (request, context, next) => {
		const response = await next()
		return compressResponse(request, context, response, {
			threshold,
			filter,
			encodings,
			compress: async (bytes, encoding) =>
				encoding === 'gzip' ? gzipAsync(bytes) : deflateAsync(bytes),
		})
	}
}
