import type { MultipartState } from '@src/core'
import type { MultipartOptions, NodeCompressionOptions, StaticOptions } from './types.js'
import type { FileHandle } from 'node:fs/promises'
import { DEFAULT_COMPRESSION_THRESHOLD, compressResponse } from '@src/core'
import { open, realpath, stat } from 'node:fs/promises'
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
	isContainedPath,
	isDotfilePath,
	isUnderPath,
	lookupContentType,
	parseMultipartRequest,
	resolveStaticPath,
	streamFile,
	unlinkStagedFiles,
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
 * @remarks
 * Containment is enforced on CANONICAL paths, not merely the lexically
 * resolved one: `options.root` is canonicalized once (memoized) and every
 * request's candidate path is re-canonicalized (`fs.realpath`) before it is
 * served, so a symlink whose target escapes `root` is refused (falls through
 * to `next()`) even though the lexical path resolved inside `root`. A
 * symlink that resolves to a target still INSIDE `root` is unaffected and
 * still serves normally. A dangling symlink (`realpath` throws `ENOENT`) or
 * any other `realpath` failure is treated as a miss — this battery never
 * throws or 500s on a symlink surprise.
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

	let canonicalRootPromise: Promise<string> | undefined
	function canonicalRoot(): Promise<string> {
		if (canonicalRootPromise === undefined) canonicalRootPromise = realpath(root)
		return canonicalRootPromise
	}

	return async (request, context, next) => {
		if (context.method !== 'GET' && context.method !== 'HEAD') return next()

		const target = resolveStaticPath(root, options.prefix, context.url.pathname)
		if (target === undefined) return next()

		const relativePath = relative(root, target)
		if (relativePath.length > 0 && isDotfilePath(relativePath)) {
			if (dotfiles === 'deny') throw new HTTPError(403, 'forbidden')
			if (dotfiles === 'ignore') return next()
		}

		let resolvedPath: string
		try {
			const [rootReal, targetReal] = await Promise.all([canonicalRoot(), realpath(target)])
			if (!isContainedPath(targetReal, rootReal)) return next()
			resolvedPath = targetReal
		} catch {
			return trySpaFallback()
		}

		// Directory-detection only — routing decision, not the served file's
		// facts. The bytes streamed and the headers computed for them come
		// from a single `fstat` on an opened handle below, closing the
		// stat-to-stream TOCTOU (a file replaced between "check" and "serve"
		// can no longer yield a 200 with stale headers over swapped bytes).
		let directoryInfo: Awaited<ReturnType<typeof stat>>
		try {
			directoryInfo = await stat(resolvedPath)
		} catch {
			return trySpaFallback()
		}

		if (directoryInfo.isDirectory()) {
			resolvedPath = join(resolvedPath, index)
			try {
				const [rootReal, indexReal] = await Promise.all([canonicalRoot(), realpath(resolvedPath)])
				if (!isContainedPath(indexReal, rootReal)) return trySpaFallback()
				resolvedPath = indexReal
			} catch {
				return trySpaFallback()
			}
		}

		let handle: FileHandle
		try {
			handle = await open(resolvedPath, 'r')
		} catch {
			return trySpaFallback()
		}
		let info: Awaited<ReturnType<FileHandle['stat']>>
		try {
			info = await handle.stat()
		} catch {
			await handle.close()
			return trySpaFallback()
		}
		if (!info.isFile()) {
			await handle.close()
			return trySpaFallback()
		}

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

		function trySpaFallback(): Response | Promise<Response> {
			if (fallback === undefined) return next()
			if (context.method !== 'GET') return next()
			if (extname(context.url.pathname) !== '') return next()
			const accept = request.headers.get('accept') ?? ''
			if (!accept.includes('text/html') && !accept.includes('*/*')) return next()
			if (isUnderPath(context.url.pathname, fallback.exclude)) return next()
			const shellPath = join(root, index)
			return Promise.all([canonicalRoot(), realpath(shellPath)])
				.then(([rootReal, shellReal]) => {
					if (!isContainedPath(shellReal, rootReal)) return next()
					return open(shellReal, 'r').then((shellHandle) => {
						let shellStreaming = false
						try {
							const body = streamFile(shellHandle)
							shellStreaming = true
							return new Response(body, {
								status: 200,
								headers: new Headers({ 'content-type': lookupContentType(shellReal) }),
							})
						} catch (error) {
							if (!shellStreaming) shellHandle.close().catch(() => {})
							throw error
						}
					})
				})
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
		let body: Awaited<ReturnType<typeof parseMultipartRequest>>
		try {
			body = await parseMultipartRequest(request, options)
		} catch (error) {
			if (isMultipartError(error)) throw new HTTPError(error.status, error.message, error.context)
			throw error
		}
		if (body === undefined) return next()
		context.state.multipart = body
		try {
			return await next()
		} catch (error) {
			await unlinkStagedFiles(body)
			throw error
		}
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
