import { ContractError } from '@orkestrel/contract'
import type { CapstoneState, ExchangeFixtureInterface, ExchangeState } from '../../setupServer.js'
import { MiddlewareValue, createOversizedContext, createCountedStore } from '../../setup.js'
import type {
	BearerOptions,
	BearerState,
	BodyState,
	ClientState,
	CSRFState,
	MultipartState,
	SessionInterface,
	SessionState,
} from '@src/server'
import { join } from 'node:path'
import { symlink } from 'node:fs/promises'
import http from 'node:http'
import { brotliCompressSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { createRecorder, waitForCondition, waitForDelay } from '@orkestrel/test'
import { createLoopback, createScratch } from '@orkestrel/test/server'
import {
	createAssets,
	createBearer,
	createBody,
	createBoundary,
	createCompression,
	createCookieTransport,
	createCors,
	createCSRF,
	createDeadline,
	createETag,
	createForwarded,
	createHeaderTransport,
	createLimiter,
	createMemorySessionStore,
	createMultipart,
	createNodeCompression,
	createSecurity,
	createSession,
	createStatic,
	createTelemetry,
	createUploadedFile,
	except,
	isMultipartBody,
	MemoryLimiterStore,
	moveUploadedFile,
	only,
} from '@src/server'
import { compose, ContentTooLargeError, HTTPError, signToken, verifyToken } from '@orkestrel/server'
import { createDispatcher } from '@orkestrel/router'
import { buildRequest as buildRouterRequest, sendResponse } from '@orkestrel/router/server'
import {
	buildDirectoryIndexFixture,
	buildMultipartRequest,
	buildStaticFixture,
	buildSymlinkFixture,
	createAssetSource,
	PNG_MAGIC,
	startExchange,
} from '../../setupServer.js'
import {
	buildTestRequest,
	compressibleBody,
	createEchoTerminal,
	createManualClock,
	createRecordingNext,
	createRecordingTerminal,
	buildSession,
	createTestContext,
	createTestTransport,
	decompress,
	ECHO_MARKER,
	runChain,
	TEST_SECRET,
} from '../../setup.js'

// ── createAssets ─────────────────────────────────────────────────────────────

describe('createAssets', () => {
	it('serves and owns an identity root asset with media and validator headers', async () => {
		const bytes = new TextEncoder().encode('<!doctype html><title>Embedded</title>')
		const source = createAssetSource(new Map([['index.html', { body: bytes }]]))
		const handler = createAssets({ source: source.source })
		const request = buildTestRequest('/')
		const response = await handler(
			request,
			createTestContext(request, {}),
			async () => new Response('miss'),
		)
		expect(response.status).toBe(200)
		expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
		expect(response.headers.get('content-encoding')).toBeNull()
		expect(response.headers.get('vary')).toBe('accept-encoding')
		expect(response.headers.get('etag')).not.toBeNull()
		expect(response.headers.get('content-length')).toBe(String(bytes.byteLength))
		expect(await response.text()).toBe('<!doctype html><title>Embedded</title>')

		bytes.fill(0)
		const repeated = await handler(
			request,
			createTestContext(request, {}),
			async () => new Response('miss'),
		)
		expect(await repeated.text()).toBe('<!doctype html><title>Embedded</title>')
		expect(source.paths).toEqual(['index.html'])

		const rangeRequest = buildTestRequest('/', { headers: { range: 'bytes=0-3' } })
		const ranged = await handler(
			rangeRequest,
			createTestContext(rangeRequest, {}),
			async () => new Response('miss'),
		)
		expect(ranged.status).toBe(200)
		expect(await ranged.text()).toBe('<!doctype html><title>Embedded</title>')

		const missingRequest = buildTestRequest('/missing.js')
		const missing = await handler(
			missingRequest,
			createTestContext(missingRequest, {}),
			async () => new Response('miss'),
		)
		expect(await missing.text()).toBe('miss')
		expect(source.paths).toEqual(['index.html', 'missing.js'])
	})

	it('negotiates one Brotli asset against identity without changing its ETag', async () => {
		const plain = new TextEncoder().encode('globalThis.embedded = true')
		const compressed = Uint8Array.from(brotliCompressSync(plain))
		const source = createAssetSource(
			new Map([['operator.js', { body: compressed, encoding: 'br' }]]),
		)
		const handler = createAssets({ source: source.source })
		const identityRequest = buildTestRequest('/operator.js', {
			headers: { 'accept-encoding': 'identity' },
		})
		const identity = await handler(
			identityRequest,
			createTestContext(identityRequest, {}),
			async () => new Response('miss'),
		)
		expect(identity.headers.get('content-encoding')).toBeNull()
		expect(await identity.text()).toBe('globalThis.embedded = true')

		const brotliRequest = buildTestRequest('/operator.js', {
			headers: { 'accept-encoding': 'gzip;q=1, br;q=0.8' },
		})
		const brotli = await handler(
			brotliRequest,
			createTestContext(brotliRequest, {}),
			async () => new Response('miss'),
		)
		expect(brotli.headers.get('content-encoding')).toBe('br')
		expect(brotli.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
		expect(brotli.headers.get('etag')).toBe(identity.headers.get('etag'))
		expect(new Uint8Array(await brotli.arrayBuffer())).toEqual(compressed)

		const refusedRequest = buildTestRequest('/operator.js', {
			headers: { 'accept-encoding': 'br;q=0, *;q=1' },
		})
		const refused = await handler(
			refusedRequest,
			createTestContext(refusedRequest, {}),
			async () => new Response('miss'),
		)
		expect(refused.headers.get('content-encoding')).toBeNull()
		expect(await refused.text()).toBe('globalThis.embedded = true')
		expect(source.paths).toEqual(['operator.js'])
	})

	it('uses the selected representation for HEAD and returns shared validators on 304', async () => {
		const plain = new TextEncoder().encode('const embedded = true')
		const compressed = Uint8Array.from(brotliCompressSync(plain))
		const source = createAssetSource(
			new Map([['operator.js', { body: compressed, encoding: 'br' }]]),
		)
		const handler = createAssets({ source: source.source })
		const firstRequest = buildTestRequest('/operator.js')
		const first = await handler(
			firstRequest,
			createTestContext(firstRequest, {}),
			async () => new Response('miss'),
		)
		const etag = first.headers.get('etag')
		if (etag === null) throw new Error('expected an asset ETag')

		const headRequest = buildTestRequest('/operator.js', {
			method: 'HEAD',
			headers: { 'accept-encoding': 'br' },
		})
		const head = await handler(
			headRequest,
			createTestContext(headRequest, {}),
			async () => new Response('miss'),
		)
		expect(head.status).toBe(200)
		expect(head.headers.get('content-encoding')).toBe('br')
		expect(head.headers.get('content-length')).toBe(String(compressed.byteLength))
		expect(await head.text()).toBe('')

		const cachedRequest = buildTestRequest('/operator.js', {
			headers: { 'accept-encoding': 'br', 'if-none-match': etag },
		})
		const cached = await handler(
			cachedRequest,
			createTestContext(cachedRequest, {}),
			async () => new Response('miss'),
		)
		expect(cached.status).toBe(304)
		expect(cached.headers.get('content-encoding')).toBe('br')
		expect(cached.headers.get('etag')).toBe(etag)
		expect(cached.headers.get('content-length')).toBeNull()
	})

	it('retains a successful read for the factory lifetime while an unknown key is read again', async () => {
		const source = createAssetSource(
			new Map([['app.js', { body: new TextEncoder().encode('bounded') }]]),
		)
		const handler = createAssets({ source: source.source })
		const first = await handler(
			buildTestRequest('/app.js'),
			createTestContext(buildTestRequest('/app.js'), {}),
			async () => new Response('miss'),
		)
		expect(await first.text()).toBe('bounded')
		const second = await handler(
			buildTestRequest('/app.js'),
			createTestContext(buildTestRequest('/app.js'), {}),
			async () => new Response('miss'),
		)
		expect(await second.text()).toBe('bounded')
		// The retained entry answers the repeat, so a key `read` has answered
		// once is never read again — the reason `read` owes a BOUNDED key set.
		expect(source.paths).toEqual(['app.js'])

		const miss = await handler(
			buildTestRequest('/absent.js'),
			createTestContext(buildTestRequest('/absent.js'), {}),
			async () => new Response('miss'),
		)
		expect(await miss.text()).toBe('miss')
		const missAgain = await handler(
			buildTestRequest('/absent.js'),
			createTestContext(buildTestRequest('/absent.js'), {}),
			async () => new Response('miss'),
		)
		expect(await missAgain.text()).toBe('miss')
		expect(source.paths).toEqual(['app.js', 'absent.js', 'absent.js'])
	})

	it('decodes valid keys and refuses malformed, climbing, empty, backslash, and dotfile keys', async () => {
		const asset = { body: new TextEncoder().encode('asset') }
		const source = createAssetSource(new Map([['nested/app shell.js', asset]]), asset)
		const handler = createAssets({ source: source.source })
		const validRequest = buildTestRequest('/nested/app%20shell.js')
		const valid = await handler(
			validRequest,
			createTestContext(validRequest, {}),
			async () => new Response('miss'),
		)
		expect(await valid.text()).toBe('asset')
		expect(source.paths).toEqual(['nested/app shell.js'])

		for (const path of [
			'/%zz',
			'/safe%2F..%2Fsecret.js',
			'/safe%2F.%2Fsecret.js',
			'/safe%5Csecret.js',
			'/nested//secret.js',
			'/.secret',
			'/nested/.secret/file.js',
		]) {
			const request = buildTestRequest(path)
			const response = await handler(
				request,
				createTestContext(request, {}),
				async () => new Response('miss'),
			)
			expect(await response.text()).toBe('miss')
		}
		expect(source.paths).toEqual(['nested/app shell.js'])

		const postRequest = buildTestRequest('/operator.js', { method: 'POST' })
		const post = await handler(
			postRequest,
			createTestContext(postRequest, {}),
			async () => new Response('miss'),
		)
		expect(await post.text()).toBe('miss')
		expect(source.paths).toEqual(['nested/app shell.js'])
	})
})

// ── createStatic ─────────────────────────────────────────────────────────────

describe('createStatic', () => {
	it('refuses an outside canonical path before trying the SPA fallback', async () => {
		const root = createScratch({ files: { 'index.html': 'spa shell' } })
		const outside = createScratch({ files: { 'index.html': 'outside secret' } })
		try {
			await symlink(outside.path, join(root.path, 'outside'), 'junction')
			const handler = createStatic({ root: root.path, fallback: true })
			const request = buildTestRequest('/outside', { headers: { accept: 'text/html' } })
			const response = await handler(
				request,
				createTestContext(request, {}),
				async () => new Response('miss', { status: 404 }),
			)
			expect(response.status).toBe(404)
			expect(await response.text()).toBe('miss')
		} finally {
			root.destroy()
			outside.destroy()
		}
	})

	it('serves a file when the method getter throws on its third read', async () => {
		const root = createScratch({ files: { 'index.html': 'static body' } })
		try {
			const handler = createStatic({ root: root.path })
			const request = buildTestRequest('/index.html')
			const context = createTestContext(request, {})
			const reads = new MiddlewareValue(0)
			Object.defineProperty(context, 'method', {
				get() {
					reads.value += 1
					if (reads.value === 3) throw new Error('third method read')
					return 'GET'
				},
			})
			const response = await handler(request, context, async () => new Response('miss'))
			expect(response.status).toBe(200)
			expect(await response.text()).toBe('static body')
		} finally {
			root.destroy()
		}
	})

	it('serves a file with the correct MIME and a cache header', async () => {
		const fixture = buildStaticFixture()
		try {
			const handler = createStatic({ root: fixture.scratch.path, cache: 60 })
			const context = createTestContext(buildTestRequest('/index.html'), {})
			const response = await handler(
				buildTestRequest('/index.html'),
				context,
				async () => new Response('miss'),
			)
			expect(response.status).toBe(200)
			expect(response.headers.get('content-type')).toContain('text/html')
			expect(response.headers.get('cache-control')).toBe('max-age=60')
			expect(await response.text()).toContain('root index')
		} finally {
			fixture.scratch.destroy()
		}
	})

	it('serves a nested file', async () => {
		const fixture = buildStaticFixture()
		try {
			const handler = createStatic({ root: fixture.scratch.path })
			const context = createTestContext(buildTestRequest('/nested/deep/page.html'), {})
			const response = await handler(
				buildTestRequest('/nested/deep/page.html'),
				context,
				async () => new Response('miss'),
			)
			expect(response.status).toBe(200)
			expect(await response.text()).toContain('nested page')
		} finally {
			fixture.scratch.destroy()
		}
	})

	it('HEAD carries headers with no body', async () => {
		const fixture = buildStaticFixture()
		try {
			const handler = createStatic({ root: fixture.scratch.path })
			const request = buildTestRequest('/index.html', { method: 'HEAD' })
			const context = createTestContext(request, {})
			Object.defineProperty(context, 'method', { value: 'HEAD' })
			const response = await handler(request, context, async () => new Response('miss'))
			expect(response.status).toBe(200)
			expect(response.headers.get('content-length')).toBeDefined()
			expect(await response.text()).toBe('')
		} finally {
			fixture.scratch.destroy()
		}
	})

	it('calls next() on a miss', async () => {
		const fixture = buildStaticFixture()
		try {
			const handler = createStatic({ root: fixture.scratch.path })
			const context = createTestContext(buildTestRequest('/nope.html'), {})
			const called = new MiddlewareValue(false)
			const response = await handler(buildTestRequest('/nope.html'), context, async () => {
				called.value = true
				return new Response('miss', { status: 200 })
			})
			expect(called.value).toBe(true)
			expect(await response.text()).toBe('miss')
		} finally {
			fixture.scratch.destroy()
		}
	})

	it('dotfiles matrix — ignore falls through, deny 403s, allow serves', async () => {
		const fixture = buildStaticFixture()
		try {
			const ignoreHandler = createStatic({ root: fixture.scratch.path, dotfiles: 'ignore' })
			const nextCalled = new MiddlewareValue(false)
			const ignoreResponse = await ignoreHandler(
				buildTestRequest('/.env'),
				createTestContext(buildTestRequest('/.env'), {}),
				async () => {
					nextCalled.value = true
					return new Response('miss')
				},
			)
			expect(nextCalled.value).toBe(true)
			expect(await ignoreResponse.text()).toBe('miss')

			const denyHandler = createStatic({ root: fixture.scratch.path, dotfiles: 'deny' })
			await expect(
				denyHandler(
					buildTestRequest('/.env'),
					createTestContext(buildTestRequest('/.env'), {}),
					async () => new Response('miss'),
				),
			).rejects.toSatisfy((error: unknown) => error instanceof HTTPError && error.status === 403)

			const allowHandler = createStatic({ root: fixture.scratch.path, dotfiles: 'allow' })
			const allowResponse = await allowHandler(
				buildTestRequest('/.env'),
				createTestContext(buildTestRequest('/.env'), {}),
				async () => new Response('miss'),
			)
			expect(allowResponse.status).toBe(200)
			expect(await allowResponse.text()).toContain('SECRET')
		} finally {
			fixture.scratch.destroy()
		}
	})

	it('traversal requests never escape root — 404-or-next, no leaked content', async () => {
		const fixture = buildStaticFixture()
		try {
			const handler = createStatic({ root: fixture.scratch.path })
			for (const path of [
				'/../../../etc/passwd',
				'/%2e%2e/%2e%2e/etc/passwd',
				'/..%2f..%2fetc%2fpasswd',
			]) {
				const nextCalled = new MiddlewareValue(false)
				const response = await handler(
					buildTestRequest(path),
					createTestContext(buildTestRequest(path), {}),
					async () => {
						nextCalled.value = true
						return new Response('fell through')
					},
				)
				expect(nextCalled.value).toBe(true)
				expect(await response.text()).not.toContain('root:')
			}
		} finally {
			fixture.scratch.destroy()
		}
	})

	it('reserved-device path 404s (falls to next) while a console.js-like file serves', async () => {
		const fixture = buildStaticFixture()
		try {
			const handler = createStatic({ root: fixture.scratch.path })
			const nextCalled = new MiddlewareValue(false)
			const reservedResponse = await handler(
				buildTestRequest('/NUL.json'),
				createTestContext(buildTestRequest('/NUL.json'), {}),
				async () => {
					nextCalled.value = true
					return new Response('miss')
				},
			)
			expect(nextCalled.value).toBe(true)
			expect(await reservedResponse.text()).toBe('miss')

			const okResponse = await handler(
				buildTestRequest('/nullable.css'),
				createTestContext(buildTestRequest('/nullable.css'), {}),
				async () => new Response('miss'),
			)
			expect(okResponse.status).toBe(200)
			expect(await okResponse.text()).toContain('color: red')
		} finally {
			fixture.scratch.destroy()
		}
	})

	it('ignored extensionless dotfile falls through to next() rather than being served the SPA shell', async () => {
		const fixture = buildStaticFixture()
		try {
			const handler = createStatic({
				root: fixture.scratch.path,
				dotfiles: 'ignore',
				fallback: true,
			})
			const request = new Request('http://test.local/.env', { headers: { accept: 'text/html' } })
			const nextCalled = new MiddlewareValue(false)
			const response = await handler(request, createTestContext(request, {}), async () => {
				nextCalled.value = true
				return new Response('fell through', { status: 404 })
			})
			expect(nextCalled.value).toBe(true)
			expect(response.status).toBe(404)
			expect(await response.text()).not.toContain('root index')
		} finally {
			fixture.scratch.destroy()
		}
	})

	it('index + SPA fallback matrix, including exclude', async () => {
		const fixture = buildStaticFixture()
		try {
			const handler = createStatic({ root: fixture.scratch.path, fallback: { exclude: '/api' } })
			const spaRequest = new Request('http://test.local/app/dashboard', {
				headers: { accept: 'text/html' },
			})
			const spaResponse = await handler(
				spaRequest,
				createTestContext(spaRequest, {}),
				async () => new Response('miss'),
			)
			expect(spaResponse.status).toBe(200)
			expect(await spaResponse.text()).toContain('root index')

			const apiRequest = new Request('http://test.local/api/missing', {
				headers: { accept: 'text/html' },
			})
			const nextCalled = new MiddlewareValue(false)
			const apiResponse = await handler(apiRequest, createTestContext(apiRequest, {}), async () => {
				nextCalled.value = true
				return new Response('api miss', { status: 404 })
			})
			expect(nextCalled.value).toBe(true)
			expect(apiResponse.status).toBe(404)

			// SEGMENT-boundary exclude: `/apifoo` is not under `/api`, so it still
			// falls back to the SPA shell rather than being wrongly excluded.
			const apifooRequest = new Request('http://test.local/apifoo', {
				headers: { accept: 'text/html' },
			})
			const apifooResponse = await handler(
				apifooRequest,
				createTestContext(apifooRequest, {}),
				async () => new Response('miss'),
			)
			expect(apifooResponse.status).toBe(200)
			expect(await apifooResponse.text()).toContain('root index')
		} finally {
			fixture.scratch.destroy()
		}
	})

	it("SPA fallback answers through the shell handle's own fstat headers on GET, HEAD, and revalidation", async () => {
		const fixture = buildStaticFixture()
		try {
			const handler = createStatic({
				root: fixture.scratch.path,
				fallback: true,
				cache: 60,
				etag: true,
			})
			const primary = await handler(
				buildTestRequest('/index.html'),
				createTestContext(buildTestRequest('/index.html'), {}),
				async () => new Response('miss'),
			)
			expect(primary.status).toBe(200)
			const shellETag = primary.headers.get('etag')
			if (shellETag === null) throw new Error('expected an ETag on the primary shell response')
			const shellLength = primary.headers.get('content-length')
			await primary.text()

			const spaRequest = new Request('http://test.local/dashboard', {
				headers: { accept: 'text/html' },
			})
			const spa = await handler(
				spaRequest,
				createTestContext(spaRequest, {}),
				async () => new Response('miss'),
			)
			expect(spa.status).toBe(200)
			expect(spa.headers.get('etag')).toBe(shellETag)
			expect(spa.headers.get('cache-control')).toBe('max-age=60')
			expect(spa.headers.get('content-length')).toBe(shellLength)
			expect(spa.headers.get('accept-ranges')).toBe('bytes')
			expect(await spa.text()).toContain('root index')

			const headRequest = new Request('http://test.local/dashboard', {
				method: 'HEAD',
				headers: { accept: 'text/html' },
			})
			const head = await handler(
				headRequest,
				createTestContext(headRequest, {}),
				async () => new Response('miss', { status: 404 }),
			)
			expect(head.status).toBe(200)
			expect(head.headers.get('etag')).toBe(shellETag)
			expect(head.headers.get('cache-control')).toBe('max-age=60')
			expect(head.headers.get('content-length')).toBe(shellLength)
			expect(await head.text()).toBe('')

			const revalidateRequest = new Request('http://test.local/dashboard', {
				headers: { accept: 'text/html', 'if-none-match': shellETag },
			})
			const revalidated = await handler(
				revalidateRequest,
				createTestContext(revalidateRequest, {}),
				async () => new Response('miss'),
			)
			expect(revalidated.status).toBe(304)
			expect(revalidated.headers.get('etag')).toBe(shellETag)
			expect(await revalidated.text()).toBe('')

			const rangeRequest = new Request('http://test.local/dashboard', {
				headers: { accept: 'text/html', range: 'bytes=0-9' },
			})
			const ranged = await handler(
				rangeRequest,
				createTestContext(rangeRequest, {}),
				async () => new Response('miss'),
			)
			expect(ranged.status).toBe(206)
			expect(ranged.headers.get('content-range')).toBe(`bytes 0-9/${shellLength ?? ''}`)
			expect(ranged.headers.get('content-length')).toBe('10')
			expect(await ranged.text()).toBe('<!doctype ')
		} finally {
			fixture.scratch.destroy()
		}
	})

	it('SPA fallback serves the configured index even when dotfiles deny that same path directly', async () => {
		const scratch = createScratch({
			prefix: 'middleware-dotshell-',
			files: {
				'.shell.html': '<!doctype html><html><body>configured shell</body></html>',
				'.env': 'SECRET=hidden',
			},
		})
		try {
			const handler = createStatic({
				root: scratch.path,
				index: '.shell.html',
				dotfiles: 'deny',
				fallback: true,
			})
			const directRequest = new Request('http://test.local/.shell.html', {
				headers: { accept: 'text/html' },
			})
			await expect(
				handler(
					directRequest,
					createTestContext(directRequest, {}),
					async () => new Response('miss'),
				),
			).rejects.toSatisfy((error: unknown) => error instanceof HTTPError && error.status === 403)

			const spaRequest = new Request('http://test.local/dashboard', {
				headers: { accept: 'text/html' },
			})
			const spa = await handler(
				spaRequest,
				createTestContext(spaRequest, {}),
				async () => new Response('miss'),
			)
			expect(spa.status).toBe(200)
			expect(await spa.text()).toContain('configured shell')
		} finally {
			scratch.destroy()
		}
	})

	it('SPA fallback Accept gate: a non-HTML Accept header falls through to next() instead of the shell', async () => {
		const fixture = buildStaticFixture()
		try {
			const handler = createStatic({ root: fixture.scratch.path, fallback: true })
			const request = new Request('http://test.local/app/dashboard', {
				headers: { accept: 'application/json' },
			})
			const nextCalled = new MiddlewareValue(false)
			const response = await handler(request, createTestContext(request, {}), async () => {
				nextCalled.value = true
				return new Response('json miss', { status: 404 })
			})
			expect(nextCalled.value).toBe(true)
			expect(response.status).toBe(404)
			expect(await response.text()).not.toContain('root index')
		} finally {
			fixture.scratch.destroy()
		}
	})

	it('If-None-Match returns 304', async () => {
		const fixture = buildStaticFixture()
		try {
			const handler = createStatic({ root: fixture.scratch.path })
			const first = await handler(
				buildTestRequest('/index.html'),
				createTestContext(buildTestRequest('/index.html'), {}),
				async () => new Response('miss'),
			)
			const etag = first.headers.get('etag')
			expect(etag).not.toBeNull()
			await first.body?.cancel()
			if (etag === null) throw new Error('expected an etag header on the first response')
			const conditional = new Request('http://test.local/index.html', {
				headers: { 'if-none-match': etag },
			})
			const response = await handler(
				conditional,
				createTestContext(conditional, {}),
				async () => new Response('miss'),
			)
			expect(response.status).toBe(304)
			expect(await response.text()).toBe('')
		} finally {
			fixture.scratch.destroy()
		}
	})

	it('a non-matching If-None-Match returns 200 with the full body', async () => {
		const fixture = buildStaticFixture()
		try {
			const handler = createStatic({ root: fixture.scratch.path })
			const conditional = new Request('http://test.local/index.html', {
				headers: { 'if-none-match': '"not-a-real-etag"' },
			})
			const response = await handler(
				conditional,
				createTestContext(conditional, {}),
				async () => new Response('miss'),
			)
			expect(response.status).toBe(200)
			expect(await response.text()).toContain('root index')
		} finally {
			fixture.scratch.destroy()
		}
	})

	it('etag:false omits the ETag header entirely', async () => {
		const fixture = buildStaticFixture()
		try {
			const handler = createStatic({ root: fixture.scratch.path, etag: false })
			const response = await handler(
				buildTestRequest('/index.html'),
				createTestContext(buildTestRequest('/index.html'), {}),
				async () => new Response('miss'),
			)
			expect(response.status).toBe(200)
			expect(response.headers.get('etag')).toBeNull()
			await response.body?.cancel()
		} finally {
			fixture.scratch.destroy()
		}
	})

	it.runIf(process.platform !== 'win32')(
		'symlink escape: an in-root symlink to an OUTSIDE target falls through to next(); an in-root symlink to an in-root target still serves 200',
		async () => {
			const symlinkFixture = buildSymlinkFixture()
			try {
				const handler = createStatic({ root: symlinkFixture.scratch.path })

				const nextCalled = new MiddlewareValue(false)
				const escapeResponse = await handler(
					buildTestRequest('/link-outside.html'),
					createTestContext(buildTestRequest('/link-outside.html'), {}),
					async () => {
						nextCalled.value = true
						return new Response('miss', { status: 404 })
					},
				)
				expect(nextCalled.value).toBe(true)
				expect(escapeResponse.status).toBe(404)
				expect(await escapeResponse.text()).not.toContain('outside secret')

				const insideResponse = await handler(
					buildTestRequest('/link-inside.html'),
					createTestContext(buildTestRequest('/link-inside.html'), {}),
					async () => new Response('miss'),
				)
				expect(insideResponse.status).toBe(200)
				expect(await insideResponse.text()).toContain('inside target')
			} finally {
				symlinkFixture.destroy()
			}
		},
	)

	it.runIf(process.platform !== 'win32')(
		'directory-index symlink escape: a directory whose index.html symlinks OUTSIDE root is a miss, not served',
		async () => {
			const fixture = buildDirectoryIndexFixture()
			try {
				const handler = createStatic({ root: fixture.scratch.path })
				const nextCalled = new MiddlewareValue(false)
				const response = await handler(
					buildTestRequest('/sub/'),
					createTestContext(buildTestRequest('/sub/'), {}),
					async () => {
						nextCalled.value = true
						return new Response('miss', { status: 404 })
					},
				)
				expect(nextCalled.value).toBe(true)
				expect(response.status).toBe(404)
				expect(await response.text()).not.toContain('outside secret')
			} finally {
				fixture.destroy()
			}
		},
	)

	it.runIf(process.platform !== 'win32')(
		'SPA-shell control: the root index.html (no symlink escape) still serves normally through the fallback',
		async () => {
			const scratch = createScratch({
				prefix: 'middleware-spashell-root-',
				files: { 'index.html': '<!doctype html><html><body>spa shell</body></html>' },
			})
			try {
				const handler = createStatic({ root: scratch.path, fallback: true })
				const request = buildTestRequest('/missing-route', { headers: { accept: 'text/html' } })
				const response = await handler(
					request,
					createTestContext(request, {}),
					async () => new Response('miss', { status: 404 }),
				)
				expect(response.status).toBe(200)
				expect(await response.text()).toContain('spa shell')
			} finally {
				scratch.destroy()
			}
		},
	)

	it('Range: single request returns 206 with the exact byte slice', async () => {
		const fixture = buildStaticFixture()
		try {
			const handler = createStatic({ root: fixture.scratch.path })
			const rangeRequest = new Request('http://test.local/large.bin', {
				headers: { range: 'bytes=10-19' },
			})
			const response = await handler(
				rangeRequest,
				createTestContext(rangeRequest, {}),
				async () => new Response('miss'),
			)
			expect(response.status).toBe(206)
			expect(response.headers.get('content-range')).toBe('bytes 10-19/200000')
			const bytes = new Uint8Array(await response.arrayBuffer())
			expect(bytes).toHaveLength(10)
			expect(Array.from(bytes)).toEqual(Array(10).fill(0x41))
		} finally {
			fixture.scratch.destroy()
		}
	})

	it('Range: suffix and open ranges', async () => {
		const fixture = buildStaticFixture()
		try {
			const handler = createStatic({ root: fixture.scratch.path })
			const suffixRequest = new Request('http://test.local/large.bin', {
				headers: { range: 'bytes=-10' },
			})
			const suffixResponse = await handler(
				suffixRequest,
				createTestContext(suffixRequest, {}),
				async () => new Response('miss'),
			)
			expect(suffixResponse.status).toBe(206)
			expect(suffixResponse.headers.get('content-range')).toBe('bytes 199990-199999/200000')
			await suffixResponse.body?.cancel()

			const openRequest = new Request('http://test.local/large.bin', {
				headers: { range: 'bytes=199990-' },
			})
			const openResponse = await handler(
				openRequest,
				createTestContext(openRequest, {}),
				async () => new Response('miss'),
			)
			expect(openResponse.status).toBe(206)
			expect(openResponse.headers.get('content-range')).toBe('bytes 199990-199999/200000')
			await openResponse.body?.cancel()
		} finally {
			fixture.scratch.destroy()
		}
	})

	it('Range: unsatisfiable returns 416', async () => {
		const fixture = buildStaticFixture()
		try {
			const handler = createStatic({ root: fixture.scratch.path })
			const request = new Request('http://test.local/large.bin', {
				headers: { range: 'bytes=999999999-' },
			})
			const response = await handler(
				request,
				createTestContext(request, {}),
				async () => new Response('miss'),
			)
			expect(response.status).toBe(416)
			expect(response.headers.get('content-range')).toBe('bytes */200000')
		} finally {
			fixture.scratch.destroy()
		}
	})

	it('Range: multi-range and malformed refused — served full 200', async () => {
		const fixture = buildStaticFixture()
		try {
			const handler = createStatic({ root: fixture.scratch.path })
			const multiRequest = new Request('http://test.local/large.bin', {
				headers: { range: 'bytes=0-9,20-29' },
			})
			const multiResponse = await handler(
				multiRequest,
				createTestContext(multiRequest, {}),
				async () => new Response('miss'),
			)
			expect(multiResponse.status).toBe(200)
			expect((await multiResponse.arrayBuffer()).byteLength).toBe(200_000)

			const malformedRequest = new Request('http://test.local/large.bin', {
				headers: { range: 'not-a-range' },
			})
			const malformedResponse = await handler(
				malformedRequest,
				createTestContext(malformedRequest, {}),
				async () => new Response('miss'),
			)
			expect(malformedResponse.status).toBe(200)
			await malformedResponse.body?.cancel()
		} finally {
			fixture.scratch.destroy()
		}
	})

	it('If-Range: a Range under any If-Range validator serves the full 200', async () => {
		const fixture = buildStaticFixture()
		try {
			const handler = createStatic({ root: fixture.scratch.path })
			const probe = new Request('http://test.local/large.bin', { method: 'HEAD' })
			const head = await handler(
				probe,
				createTestContext(probe, {}),
				async () => new Response('miss'),
			)
			const etag = head.headers.get('etag') ?? ''
			expect(etag.startsWith('W/"')).toBe(true)
			const replies = await Promise.all(
				[etag, etag.slice(2), '"stale"', new Date().toUTCString()].map(async (condition) => {
					const request = new Request('http://test.local/large.bin', {
						headers: { range: 'bytes=10-19', 'if-range': condition },
					})
					const response = await handler(
						request,
						createTestContext(request, {}),
						async () => new Response('miss'),
					)
					return [response.status, (await response.arrayBuffer()).byteLength]
				}),
			)
			expect(replies).toEqual([
				[200, 200_000],
				[200, 200_000],
				[200, 200_000],
				[200, 200_000],
			])
		} finally {
			fixture.scratch.destroy()
		}
	})

	it('serves a prefix written with a trailing slash on its bare form', async () => {
		const fixture = buildStaticFixture()
		try {
			const handler = createStatic({ root: fixture.scratch.path, prefix: '/static/' })
			const statuses = await Promise.all(
				['/static', '/static/', '/static/nested/deep/page.html', '/staticx/index.html'].map(
					async (path) => {
						const request = buildTestRequest(path)
						const response = await handler(
							request,
							createTestContext(request, {}),
							async () => new Response('miss', { status: 404 }),
						)
						return [response.status, await response.text()]
					},
				),
			)
			expect(statuses).toEqual([
				[200, '<!doctype html><html><body>root index</body></html>'],
				[200, '<!doctype html><html><body>root index</body></html>'],
				[200, '<!doctype html><html><body>nested page</body></html>'],
				[404, 'miss'],
			])
		} finally {
			fixture.scratch.destroy()
		}
	})

	it('excludes the bare form of a fallback exclude written with a trailing slash', async () => {
		const fixture = buildStaticFixture()
		try {
			const handler = createStatic({
				root: fixture.scratch.path,
				fallback: { exclude: '/api/' },
			})
			const statuses = await Promise.all(
				['/api', '/api/users', '/dashboard'].map(async (path) => {
					const request = buildTestRequest(path, { headers: { accept: 'text/html' } })
					const response = await handler(
						request,
						createTestContext(request, {}),
						async () => new Response('miss', { status: 404 }),
					)
					await response.body?.cancel()
					return response.status
				}),
			)
			expect(statuses).toEqual([404, 404, 200])
		} finally {
			fixture.scratch.destroy()
		}
	})
})

// ── createMultipart ──────────────────────────────────────────────────────────

describe('createMultipart', () => {
	it('happy path — files and fields staged under random names, not client filenames', async () => {
		const directory = createScratch({ prefix: 'middleware-multipart-' })
		try {
			const handler = createMultipart<MultipartState>({ directory: directory.path })
			const request = buildMultipartRequest([
				{ kind: 'field', name: 'title', value: 'hello' },
				{
					kind: 'file',
					name: 'avatar',
					filename: 'a.png',
					contentType: 'image/png',
					bytes: Buffer.concat([Buffer.from(PNG_MAGIC), Buffer.from('body')]),
				},
			])
			const state: MultipartState = {}
			const context = createTestContext(request, state)
			const staged = new MiddlewareValue<readonly string[]>([])
			await handler(request, context, async () => {
				staged.value = directory.names()
				return new Response('ok')
			})
			expect(staged.value).toHaveLength(1)
			expect(isMultipartBody(state.multipart)).toBe(true)
			const files = state.multipart?.files.avatar
			expect(files?.[0]?.name).toBe('a.png')
			expect(files?.[0]?.path).not.toContain('a.png')
		} finally {
			directory.destroy()
		}
	})

	it('preserves a traversal filename as metadata only', async () => {
		const directory = createScratch({ prefix: 'middleware-multipart-' })
		try {
			const handler = createMultipart<MultipartState>({ directory: directory.path })
			const request = buildMultipartRequest([
				{
					kind: 'file',
					name: 'avatar',
					filename: '../../etc/passwd',
					bytes: new TextEncoder().encode('x'),
				},
			])
			const state: MultipartState = {}
			const context = createTestContext(request, state)
			await handler(request, context, async () => new Response('ok'))
			expect(state.multipart?.files.avatar?.[0]?.name).toBe('../../etc/passwd')
			expect(state.multipart?.files.avatar?.[0]?.path.includes('..')).toBe(false)
		} finally {
			directory.destroy()
		}
	})

	it('every limit trips as a 413 HTTPError, with temp files GONE', async () => {
		const directory = createScratch({ prefix: 'middleware-multipart-' })
		try {
			const handler = createMultipart<MultipartState>({
				directory: directory.path,
				limits: { file: { size: 5 } },
			})
			const request = buildMultipartRequest([
				{ kind: 'file', name: 'avatar', filename: 'big.bin', bytes: new Uint8Array(500) },
			])
			const context = createTestContext(request, {})
			await expect(handler(request, context, async () => new Response('ok'))).rejects.toSatisfy(
				(error: unknown) => error instanceof HTTPError && error.status === 413,
			)
			expect(directory.names()).toHaveLength(0)
		} finally {
			directory.destroy()
		}
	})

	it('declared-vs-sniffed mismatch is a 415, including a signature-less type on the list', async () => {
		const handler = createMultipart<MultipartState>({ allowed: ['image/png'] })
		const mismatchRequest = buildMultipartRequest([
			{
				kind: 'file',
				name: 'avatar',
				filename: 'a.png',
				contentType: 'image/png',
				bytes: new TextEncoder().encode('<html>not a png</html>'),
			},
		])
		await expect(
			handler(
				mismatchRequest,
				createTestContext(mismatchRequest, {}),
				async () => new Response('ok'),
			),
		).rejects.toSatisfy((error: unknown) => error instanceof HTTPError && error.status === 415)

		const textHandler = createMultipart<MultipartState>({ allowed: ['text/plain'] })
		const textRequest = buildMultipartRequest([
			{
				kind: 'file',
				name: 'note',
				filename: 'note.txt',
				contentType: 'text/plain',
				bytes: new TextEncoder().encode('signature-less plain text'),
			},
		])
		await expect(
			textHandler(textRequest, createTestContext(textRequest, {}), async () => new Response('ok')),
		).rejects.toSatisfy((error: unknown) => error instanceof HTTPError && error.status === 415)
	})

	it('an empty allowed list rejects everything', async () => {
		const handler = createMultipart<MultipartState>({ allowed: [] })
		const request = buildMultipartRequest([
			{
				kind: 'file',
				name: 'avatar',
				filename: 'a.png',
				contentType: 'image/png',
				bytes: Buffer.from(PNG_MAGIC),
			},
		])
		await expect(
			handler(request, createTestContext(request, {}), async () => new Response('ok')),
		).rejects.toSatisfy((error: unknown) => error instanceof HTTPError && error.status === 415)
	})

	it('__proto__-named file part is skipped, never keyed, and does not crash the handler', async () => {
		const directory = createScratch({ prefix: 'middleware-multipart-' })
		try {
			const handler = createMultipart<MultipartState>({ directory: directory.path })
			const request = buildMultipartRequest([
				{
					kind: 'file',
					name: '__proto__',
					filename: 'a.png',
					contentType: 'image/png',
					bytes: Buffer.from(PNG_MAGIC),
				},
			])
			const state: MultipartState = {}
			const nextCalled = new MiddlewareValue(false)
			const response = await handler(request, createTestContext(request, state), async () => {
				nextCalled.value = true
				return new Response('ok', { status: 200 })
			})
			expect(nextCalled.value).toBe(true)
			expect(response.status).toBe(200)
			expect(Object.prototype.hasOwnProperty.call(state.multipart?.files ?? {}, '__proto__')).toBe(
				false,
			)
			expect(directory.names()).toHaveLength(0)
		} finally {
			directory.destroy()
		}
	})

	it('__proto__ field is skipped', async () => {
		const handler = createMultipart<MultipartState>()
		const request = buildMultipartRequest([{ kind: 'field', name: '__proto__', value: 'polluted' }])
		const state: MultipartState = {}
		await handler(request, createTestContext(request, state), async () => new Response('ok'))
		expect(Object.prototype.hasOwnProperty.call(state.multipart?.fields ?? {}, '__proto__')).toBe(
			false,
		)
	})

	it('a non-multipart request passes through untouched', async () => {
		const handler = createMultipart<MultipartState>()
		const request = new Request('http://test.local/x', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{}',
		})
		const state: MultipartState = {}
		const nextCalled = new MiddlewareValue(false)
		await handler(request, createTestContext(request, state), async () => {
			nextCalled.value = true
			return new Response('ok')
		})
		expect(nextCalled.value).toBe(true)
		expect(state.multipart).toBeUndefined()
	})

	it('a downstream throw unlinks every still-staged temp file, but a MOVED file survives', async () => {
		const directory = createScratch({ prefix: 'middleware-multipart-' })
		try {
			const handler = createMultipart<MultipartState>({ directory: directory.path })
			const request = buildMultipartRequest([
				{
					kind: 'file',
					name: 'keep',
					filename: 'a.png',
					contentType: 'image/png',
					bytes: Buffer.from(PNG_MAGIC),
				},
				{
					kind: 'file',
					name: 'discard',
					filename: 'b.png',
					contentType: 'image/png',
					bytes: Buffer.from(PNG_MAGIC),
				},
			])
			const state: MultipartState = {}
			const context = createTestContext(request, state)
			const destination = join(directory.path, 'moved.png')
			await expect(
				handler(request, context, async () => {
					const keep = state.multipart?.files.keep?.[0]
					if (keep !== undefined) {
						const record = createUploadedFile({
							field: keep.field,
							name: keep.name,
							size: keep.size,
							mime: keep.mime,
							validated: keep.validated,
							status: 'staged',
							path: keep.path,
						})
						await moveUploadedFile(record, destination)
					}
					throw new Error('downstream failure')
				}),
			).rejects.toThrow('downstream failure')

			const remaining = directory.names()
			// The moved file (renamed to `moved.png`) survives; the still-staged
			// `discard` file was unlinked by the fail-closed cleanup.
			expect(remaining).toEqual(['moved.png'])
		} finally {
			directory.destroy()
		}
	})

	it('unlinks every still-staged file when the handler returns, and a moved file survives', async () => {
		const directory = createScratch({ prefix: 'middleware-multipart-' })
		try {
			const handler = createMultipart<MultipartState>({ directory: directory.path })
			const request = buildMultipartRequest([
				{ kind: 'field', name: 'title', value: 'lamp' },
				{
					kind: 'file',
					name: 'keep',
					filename: 'a.png',
					contentType: 'image/png',
					bytes: Buffer.from(PNG_MAGIC),
				},
				{
					kind: 'file',
					name: 'left',
					filename: 'b.png',
					contentType: 'image/png',
					bytes: Buffer.from(PNG_MAGIC),
				},
			])
			const state: MultipartState = {}
			const destination = join(directory.path, 'moved.png')
			const staged = new MiddlewareValue<readonly string[]>([])
			const response = await handler(request, createTestContext(request, state), async () => {
				staged.value = directory.names()
				const keep = state.multipart?.files.keep?.[0]
				if (keep !== undefined)
					await moveUploadedFile(createUploadedFile({ ...keep, status: 'staged' }), destination)
				return new Response('ok', { status: 201 })
			})
			expect(response.status).toBe(201)
			expect(staged.value).toHaveLength(2)
			expect(directory.names()).toEqual(['moved.png'])
		} finally {
			directory.destroy()
		}
	})

	it('refuses a boundary longer than 70 characters with a 400', async () => {
		const handler = createMultipart<MultipartState>()
		const request = buildMultipartRequest(
			[{ kind: 'field', name: 'title', value: 'lamp' }],
			'b'.repeat(71),
		)
		const nextCalled = new MiddlewareValue(false)
		await expect(
			handler(request, createTestContext(request, {}), async () => {
				nextCalled.value = true
				return new Response('ok')
			}),
		).rejects.toSatisfy((error: unknown) => error instanceof HTTPError && error.status === 400)
		expect(nextCalled.value).toBe(false)
	})
})

// ── createNodeCompression (node face) ────────────────────────────────────────────

describe('createNodeCompression (node face)', () => {
	it('compresses a large compressible response with gzip', async () => {
		const handler = createNodeCompression({ threshold: 10 })
		const body = 'x'.repeat(5000)
		const request = new Request('http://test.local/', { headers: { 'accept-encoding': 'gzip' } })
		const response = await handler(
			request,
			createTestContext(request, {}),
			async () => new Response(body, { headers: { 'content-type': 'text/plain' } }),
		)
		expect(response.headers.get('content-encoding')).toBe('gzip')
		expect(response.headers.get('vary')).toContain('Accept-Encoding')
	})

	it('compresses with deflate when the client only sends Accept-Encoding: deflate, and it decodes correctly', async () => {
		const handler = createNodeCompression({ threshold: 10 })
		const body = 'y'.repeat(5000)
		const request = new Request('http://test.local/', { headers: { 'accept-encoding': 'deflate' } })
		const response = await handler(
			request,
			createTestContext(request, {}),
			async () => new Response(body, { headers: { 'content-type': 'text/plain' } }),
		)
		expect(response.headers.get('content-encoding')).toBe('deflate')
		const compressed = new Uint8Array(await response.arrayBuffer())
		const { inflateSync } = await import('node:zlib')
		const decoded = inflateSync(Buffer.from(compressed)).toString('utf8')
		expect(decoded).toBe(body)
	})

	it('br is honestly exercised only if the runtime negotiates it — this node face guarantees only gzip/deflate', async () => {
		// The node face's `Encoding` union (peer-typed) is `'gzip' | 'deflate' |
		// 'identity'` — no `'br'` — so this battery never negotiates brotli
		// regardless of what the client sends. Documented, not silently skipped.
		const handler = createNodeCompression({ threshold: 10 })
		const request = new Request('http://test.local/', { headers: { 'accept-encoding': 'br' } })
		const response = await handler(
			request,
			createTestContext(request, {}),
			async () => new Response('x'.repeat(5000), { headers: { 'content-type': 'text/plain' } }),
		)
		expect(response.headers.get('content-encoding')).toBeNull()
	})

	it('skips below threshold', async () => {
		const handler = createNodeCompression({ threshold: 10_000 })
		const request = new Request('http://test.local/', { headers: { 'accept-encoding': 'gzip' } })
		const response = await handler(
			request,
			createTestContext(request, {}),
			async () => new Response('small', { headers: { 'content-type': 'text/plain' } }),
		)
		expect(response.headers.get('content-encoding')).toBeNull()
	})

	it('refuses a threshold that is not a finite number', () => {
		expect(() => createNodeCompression({ threshold: Number.NaN })).toThrow(
			'createNodeCompression: threshold',
		)
		expect(() => createNodeCompression({ threshold: Number.POSITIVE_INFINITY })).toThrow(
			ContractError,
		)
		expect(() => createNodeCompression({ threshold: -1 })).toThrow(ContractError)
	})
})

// ── The capstone — a real socket + Dispatcher + the canonical onion ────────
//
// DEVIATION (documented, not improvised): the dispatch calls for "a real
// `@orkestrel/server` `Server` + `@orkestrel/router` dispatcher". The
// installed `@orkestrel/server`'s `./server` entry point (`createServer`) is
// itself broken — its built `dist/src/server/index.cjs` `require`s
// `'../core/index.cjs'`, but the installed package's core face ships ONLY an
// ESM `index.js` (no `.cjs` sibling), so `require('@orkestrel/server/server')`
// throws `MODULE_NOT_FOUND` unconditionally, confirmed through a direct
// `node -e "require('@orkestrel/server/server')"` repro — an external
// peer-package build defect, out of this dispatch's scope to fix. The
// following capstone substitutes a real `node:http` socket (this repo's own
// `startServer` helper) plus `@orkestrel/router`'s server-face
// `buildRequest`/`sendResponse` conversion seam driving the SAME real
// `@orkestrel/router` `Dispatcher` and the SAME canonical onion through the peer's
// own `compose` — every layer this capstone is meant to fingerprint is still
// real and still exercised end-to-end over a real socket; only the specific
// `Server` class is swapped for its two documented conversion primitives.

describe('capstone: real socket + Dispatcher + canonical onion', () => {
	it('one authenticated JSON round-trip fingerprints every layer on the wire, plus a 429 and a CSRF 403', async () => {
		const secret = 'capstone-secret'
		const bearerToken = await signToken('capstone-user', { secret })
		const telemetryEntries: Array<{
			readonly method: string
			readonly pathname: string
			readonly status: number
		}> = []

		const dispatcher = createDispatcher<CapstoneState>()
		dispatcher.add({
			method: 'POST',
			path: '/echo',
			handler: async () => Response.json({ ok: true, large: 'y'.repeat(3000) }),
		})
		dispatcher.add({
			method: 'GET',
			path: '/prime',
			// Exposes `state.csrf` (the RAW double-submit token, distinct from the
			// double-SIGNED `Set-Cookie` wire value) through a response header — the
			// documented consumption pattern a real app follows (a template or
			// JSON body field, never decoded back out of the cookie by the client).
			handler: async (_request, context) =>
				new Response('primed', {
					headers: context.state.csrf === undefined ? {} : { 'x-csrf-issued': context.state.csrf },
				}),
		})

		const onion = [
			createTelemetry<CapstoneState>({ record: (entry) => telemetryEntries.push(entry) }),
			createNodeCompression<CapstoneState>({ threshold: 100 }),
			createBoundary<CapstoneState>({ expose: false }),
			createSecurity<CapstoneState>(),
			createCors<CapstoneState>({ origin: ['https://app.example'] }),
			createForwarded<CapstoneState>({ proxies: 1 }),
			createETag<CapstoneState>(),
			createBearer<CapstoneState>({ verify: (token) => verifyToken(token, secret) }),
			createLimiter<CapstoneState>({ max: 3, window: 60_000 }),
			createSession<SessionInterface, CapstoneState>({
				transport: createCookieTransport({ secret }),
			}),
			createCSRF<CapstoneState>({ secret }),
		]

		const composed = compose(onion, async (request, context) =>
			dispatcher.handle(request, context.state),
		)

		const server = http.createServer(async (message, response) => {
			const request = buildRouterRequest(message)
			const ip = message.socket.remoteAddress
			const state: CapstoneState = {}
			const context = createTestContext(request, state, {
				connection: { ...(ip !== undefined ? { ip } : {}), encrypted: false },
			})
			const result = await composed(request, context)
			await sendResponse(result, response)
		})
		const handle = await createLoopback(server)
		try {
			const base = handle.url

			const auth = await fetch(`${base}/echo`, {
				method: 'POST',
				headers: { authorization: `Bearer ${bearerToken}`, origin: 'https://app.example' },
				body: JSON.stringify({}),
			})
			expect(auth.status).toBe(403) // no CSRF token submitted on the first mutating request

			// Prime a CSRF token through a safe GET, carrying forward cookies.
			const primed = await fetch(`${base}/prime`, {
				headers: { authorization: `Bearer ${bearerToken}`, origin: 'https://app.example' },
			})
			expect(primed.status).toBe(200)
			expect(primed.headers.get('x-content-type-options')).toBe('nosniff')
			expect(primed.headers.get('x-request-id')).toBeDefined()
			expect(primed.headers.get('access-control-allow-origin')).toBe('https://app.example')
			expect(primed.headers.get('etag')).toBeDefined()
			const setCookies = primed.headers.getSetCookie()
			const sessionCookie = setCookies.find((value) => value.startsWith('session='))
			const csrfCookie = setCookies.find((value) => value.startsWith('csrf='))
			expect(sessionCookie).toBeDefined()
			expect(csrfCookie).toBeDefined()
			expect(telemetryEntries.length).toBeGreaterThan(0)

			const cookieHeader = [sessionCookie, csrfCookie]
				.filter((value): value is string => value !== undefined)
				.map((value) => value.split(';')[0])
				.join('; ')
			// The RAW double-submit token — `context.state.csrf` — travels through
			// the `x-csrf-issued` response header the `/prime` handler exposes
			// earlier in this case,
			// NOT by decoding the `Set-Cookie` wire value (which is a SECOND,
			// outer signing layer over that same raw token).
			const csrfToken = primed.headers.get('x-csrf-issued')
			expect(csrfToken).toBeDefined()

			const authenticated = await fetch(`${base}/echo`, {
				method: 'POST',
				headers: {
					authorization: `Bearer ${bearerToken}`,
					origin: 'https://app.example',
					cookie: cookieHeader,
					'x-csrf-token': csrfToken ?? '',
					'content-type': 'application/json',
				},
				body: JSON.stringify({}),
			})
			expect(authenticated.status).toBe(200)
			expect(authenticated.headers.get('content-encoding')).toBe('gzip') // large body, compressed
			const payload: { readonly ok: boolean } = await authenticated.json()
			expect(payload.ok).toBe(true)

			// Third request against the max:3/window limiter → 429.
			const limited = await fetch(`${base}/prime`, {
				headers: { authorization: `Bearer ${bearerToken}`, origin: 'https://app.example' },
			})
			expect(limited.status).toBe(429)
			expect(limited.headers.get('retry-after')).toBeDefined()
		} finally {
			await handle.destroy()
		}
	})

	it('a limiter behind a bearer that stashes an object credential keys by client address', async () => {
		type Principal = { readonly subject: string }
		type PrincipalState = BearerState<Principal> & ClientState
		const keys = createRecorder<[string]>()
		const memory = new MemoryLimiterStore()
		const bearer = createBearer<PrincipalState, Principal>({
			verify: (token) => ({ subject: token }),
		})
		const limiter = createLimiter<PrincipalState>({
			max: 1,
			window: 60_000,
			store: {
				consume: (key, now, limits) => {
					keys.handler(key)
					return memory.consume(key, now, limits)
				},
			},
		})
		const composed = compose<PrincipalState>(
			[bearer, limiter],
			async () => new Response('admitted'),
		)
		const server = http.createServer(async (message, response) => {
			const request = buildRouterRequest(message)
			const ip = message.socket.remoteAddress
			const state: PrincipalState = {}
			const context = createTestContext(request, state, {
				connection: { ...(ip !== undefined ? { ip } : {}), encrypted: false },
			})
			await sendResponse(await composed(request, context), response)
		})
		const handle = await createLoopback(server)
		try {
			const first = await fetch(handle.url, { headers: { authorization: 'Bearer alice' } })
			const second = await fetch(handle.url, { headers: { authorization: 'Bearer bob' } })
			expect(first.status).toBe(200)
			expect(second.status).toBe(429)
			expect(keys.calls.map(([key]) => key)).toEqual(['ip:127.0.0.1', 'ip:127.0.0.1'])
		} finally {
			await handle.destroy()
		}
	})
})

// ── createBoundary ────────────────────────────────────────────────────────

describe('createBoundary', () => {
	it('renders a thrown HTTPError with its status and message', async () => {
		const boundary = createBoundary()
		const context = createTestContext(buildTestRequest('/'), {})
		const response = await boundary(buildTestRequest('/'), context, async () => {
			throw new HTTPError(404, 'not found')
		})
		expect(response.status).toBe(404)
		expect(await response.text()).toBe('not found')
	})

	it('renders a ContentTooLargeError as a 413', async () => {
		const boundary = createBoundary()
		const context = createTestContext(buildTestRequest('/'), {})
		const response = await boundary(buildTestRequest('/'), context, async () => {
			throw new ContentTooLargeError(1024)
		})
		expect(response.status).toBe(413)
	})

	it('with expose false (default), a generic throw never leaks its message', async () => {
		const boundary = createBoundary()
		const context = createTestContext(buildTestRequest('/'), {})
		const response = await boundary(buildTestRequest('/'), context, async () => {
			throw new Error('secret internal detail')
		})
		expect(response.status).toBe(500)
		expect(await response.text()).not.toContain('secret internal detail')
	})

	it('with expose true, a generic throw surfaces its message', async () => {
		const boundary = createBoundary({ expose: true })
		const context = createTestContext(buildTestRequest('/'), {})
		const response = await boundary(buildTestRequest('/'), context, async () => {
			throw new Error('visible detail')
		})
		expect(await response.text()).toBe('visible detail')
	})

	it('a report sink is invoked with the caught error, and its own throw is swallowed', async () => {
		const seen: unknown[] = []
		const boundary = createBoundary({
			report: (error) => {
				seen.push(error)
				throw new Error('report sink is broken')
			},
		})
		const context = createTestContext(buildTestRequest('/'), {})
		const response = await boundary(buildTestRequest('/'), context, async () => {
			throw new HTTPError(400, 'bad')
		})
		expect(response.status).toBe(400)
		expect(seen).toHaveLength(1)
	})

	it('passes a successful response through unchanged', async () => {
		const boundary = createBoundary()
		const context = createTestContext(buildTestRequest('/'), {})
		const response = await runChain(
			[boundary],
			createEchoTerminal(),
			buildTestRequest('/'),
			context,
		)
		expect(await response.text()).toBe(ECHO_MARKER)
	})
})

// ── createTelemetry ───────────────────────────────────────────────────────

describe('createTelemetry', () => {
	it('records status 500 and preserves a synchronous downstream error', async () => {
		const entries: Array<{ readonly status: number }> = []
		const error = new Error('synchronous downstream failure')
		const telemetry = createTelemetry({ record: (entry) => entries.push(entry) })
		const request = buildTestRequest('/')
		await expect(
			telemetry(request, createTestContext(request, {}), () => {
				throw error
			}),
		).rejects.toBe(error)
		expect(entries.map((entry) => entry.status)).toEqual([500])
	})

	it('records one entry per request with method/pathname/status/duration', async () => {
		const entries: Array<{ method: string; pathname: string; status: number; duration: number }> =
			[]
		const telemetry = createTelemetry({ record: (entry) => entries.push(entry) })
		const context = createTestContext(buildTestRequest('/users?x=1'), {})
		await runChain([telemetry], createEchoTerminal(201), buildTestRequest('/users?x=1'), context)
		expect(entries).toHaveLength(1)
		expect(entries[0]?.method).toBe('GET')
		expect(entries[0]?.pathname).toBe('/users')
		expect(entries[0]?.status).toBe(201)
		expect(entries[0]?.duration).toBeGreaterThanOrEqual(0)
	})

	it('records status 500 when the downstream throws (no boundary present)', async () => {
		const entries: Array<{ status: number }> = []
		const telemetry = createTelemetry({ record: (entry) => entries.push(entry) })
		const context = createTestContext(buildTestRequest('/'), {})
		await expect(
			telemetry(buildTestRequest('/'), context, async () => {
				throw new Error('boom')
			}),
		).rejects.toThrow('boom')
		expect(entries[0]?.status).toBe(500)
	})

	it('records the boundary-mapped status when boundary sits inside telemetry', async () => {
		const entries: Array<{ status: number }> = []
		const telemetry = createTelemetry({ record: (entry) => entries.push(entry) })
		const boundary = createBoundary()
		const context = createTestContext(buildTestRequest('/'), {})
		const response = await runChain(
			[telemetry, boundary],
			async () => {
				throw new HTTPError(418, 'teapot')
			},
			buildTestRequest('/'),
			context,
		)
		expect(response.status).toBe(418)
		expect(entries[0]?.status).toBe(418)
	})

	it('a broken record sink is swallowed and never fails the response', async () => {
		const telemetry = createTelemetry({
			record: () => {
				throw new Error('sink broken')
			},
		})
		const context = createTestContext(buildTestRequest('/'), {})
		const response = await runChain(
			[telemetry],
			createEchoTerminal(),
			buildTestRequest('/'),
			context,
		)
		expect(await response.text()).toBe(ECHO_MARKER)
	})
})

// ── createCompression ─────────────────────────────────────────────────────

describe('createCompression', () => {
	it('compresses an eligible, over-threshold, compressible response and the output round-trips through DecompressionStream', async () => {
		const compression = createCompression<Record<string, never>>({ threshold: 16 })
		const body = compressibleBody(2048)
		const context = createTestContext(
			buildTestRequest('/', { headers: { 'accept-encoding': 'gzip' } }),
			{},
		)
		const response = await runChain(
			[compression],
			async () => new Response(body, { headers: { 'content-type': 'text/plain' } }),
			buildTestRequest('/', { headers: { 'accept-encoding': 'gzip' } }),
			context,
		)
		expect(response.headers.get('content-encoding')).toBe('gzip')
		const compressed = await response.arrayBuffer()
		const decoded = await decompress(compressed, 'gzip')
		expect(decoded).toBe(body)
	})

	it('skips a response under the threshold', async () => {
		const compression = createCompression<Record<string, never>>({ threshold: 100_000 })
		const context = createTestContext(
			buildTestRequest('/', { headers: { 'accept-encoding': 'gzip' } }),
			{},
		)
		const response = await runChain(
			[compression],
			async () =>
				new Response(compressibleBody(2048), { headers: { 'content-type': 'text/plain' } }),
			buildTestRequest('/', { headers: { 'accept-encoding': 'gzip' } }),
			context,
		)
		expect(response.headers.has('content-encoding')).toBe(false)
	})

	it('skips an incompressible content type', async () => {
		const compression = createCompression<Record<string, never>>({ threshold: 16 })
		const context = createTestContext(
			buildTestRequest('/', { headers: { 'accept-encoding': 'gzip' } }),
			{},
		)
		const response = await runChain(
			[compression],
			async () =>
				new Response(compressibleBody(2048), { headers: { 'content-type': 'image/png' } }),
			buildTestRequest('/', { headers: { 'accept-encoding': 'gzip' } }),
			context,
		)
		expect(response.headers.has('content-encoding')).toBe(false)
	})

	it('skips a response already carrying Content-Encoding', async () => {
		const compression = createCompression<Record<string, never>>({ threshold: 16 })
		const context = createTestContext(
			buildTestRequest('/', { headers: { 'accept-encoding': 'gzip' } }),
			{},
		)
		const response = await runChain(
			[compression],
			async () =>
				new Response(compressibleBody(2048), {
					headers: { 'content-type': 'text/plain', 'content-encoding': 'identity' },
				}),
			buildTestRequest('/', { headers: { 'accept-encoding': 'gzip' } }),
			context,
		)
		expect(response.headers.get('content-encoding')).toBe('identity')
	})

	it('skips a HEAD request, a 204, and an event-stream response', async () => {
		const compression = createCompression<Record<string, never>>({ threshold: 16 })
		const headRequest = buildTestRequest('/', {
			method: 'HEAD',
			headers: { 'accept-encoding': 'gzip' },
		})
		const headContext = createTestContext(headRequest, {})
		const headResponse = await runChain(
			[compression],
			async () =>
				new Response(compressibleBody(2048), { headers: { 'content-type': 'text/plain' } }),
			headRequest,
			headContext,
		)
		expect(headResponse.headers.has('content-encoding')).toBe(false)

		const noBodyRequest = buildTestRequest('/', { headers: { 'accept-encoding': 'gzip' } })
		const noBodyContext = createTestContext(noBodyRequest, {})
		const noBodyResponse = await runChain(
			[compression],
			async () => new Response(null, { status: 204 }),
			noBodyRequest,
			noBodyContext,
		)
		expect(noBodyResponse.headers.has('content-encoding')).toBe(false)

		const sseRequest = buildTestRequest('/', { headers: { 'accept-encoding': 'gzip' } })
		const sseContext = createTestContext(sseRequest, {})
		const sseResponse = await runChain(
			[compression],
			async () =>
				new Response(compressibleBody(2048), { headers: { 'content-type': 'text/event-stream' } }),
			sseRequest,
			sseContext,
		)
		expect(sseResponse.headers.has('content-encoding')).toBe(false)
	})

	it('merges Vary: Accept-Encoding onto an existing Vary header', async () => {
		const compression = createCompression<Record<string, never>>({ threshold: 16 })
		const request = buildTestRequest('/', { headers: { 'accept-encoding': 'gzip' } })
		const context = createTestContext(request, {})
		const response = await runChain(
			[compression],
			async () =>
				new Response(compressibleBody(2048), {
					headers: { 'content-type': 'text/plain', vary: 'Origin' },
				}),
			request,
			context,
		)
		expect(response.headers.get('vary')).toBe('Origin, Accept-Encoding')
	})

	it('respects a filter opt-out', async () => {
		const compression = createCompression<Record<string, never>>({
			threshold: 16,
			filter: () => false,
		})
		const request = buildTestRequest('/', { headers: { 'accept-encoding': 'gzip' } })
		const context = createTestContext(request, {})
		const response = await runChain(
			[compression],
			async () =>
				new Response(compressibleBody(2048), { headers: { 'content-type': 'text/plain' } }),
			request,
			context,
		)
		expect(response.headers.has('content-encoding')).toBe(false)
	})

	it('rejects a negative threshold at construction', () => {
		expect(() => createCompression({ threshold: -1 })).toThrow(ContractError)
	})

	it('rejects a q=0 coding through negotiation (nothing negotiated)', async () => {
		const compression = createCompression<Record<string, never>>({ threshold: 16 })
		const request = buildTestRequest('/', {
			headers: { 'accept-encoding': 'gzip;q=0, deflate;q=0' },
		})
		const context = createTestContext(request, {})
		const response = await runChain(
			[compression],
			async () =>
				new Response(compressibleBody(2048), { headers: { 'content-type': 'text/plain' } }),
			request,
			context,
		)
		expect(response.headers.has('content-encoding')).toBe(false)
	})
})

// ── createSecurity ────────────────────────────────────────────────────────

describe('createSecurity', () => {
	it('sets the full default header set including nosniff and cluster', async () => {
		const security = createSecurity<{ identifier?: string }>()
		const context = createTestContext(buildTestRequest('/'), {})
		const response = await runChain(
			[security],
			createEchoTerminal(),
			buildTestRequest('/'),
			context,
		)
		expect(response.headers.get('x-content-type-options')).toBe('nosniff')
		expect(response.headers.get('x-frame-options')).toBe('DENY')
		expect(response.headers.get('origin-agent-cluster')).toBe('?1')
		expect(response.headers.get('content-security-policy')).toBeTruthy()
		expect(response.headers.has('cross-origin-embedder-policy')).toBe(false)
		expect(response.headers.has('strict-transport-security')).toBe(false)
	})

	it('csp option replaces the default wholesale', async () => {
		const security = createSecurity<{ identifier?: string }>({ csp: "default-src 'none'" })
		const context = createTestContext(buildTestRequest('/'), {})
		const response = await runChain(
			[security],
			createEchoTerminal(),
			buildTestRequest('/'),
			context,
		)
		expect(response.headers.get('content-security-policy')).toBe("default-src 'none'")
	})

	it('csp: false omits the header entirely', async () => {
		const security = createSecurity<{ identifier?: string }>({ csp: false })
		const context = createTestContext(buildTestRequest('/'), {})
		const response = await runChain(
			[security],
			createEchoTerminal(),
			buildTestRequest('/'),
			context,
		)
		expect(response.headers.has('content-security-policy')).toBe(false)
	})

	it('mints a fresh identifier by default and stashes it on state', async () => {
		const security = createSecurity<{ identifier?: string }>()
		const state: { identifier?: string } = {}
		const context = createTestContext(buildTestRequest('/'), state)
		const response = await runChain(
			[security],
			createEchoTerminal(),
			buildTestRequest('/'),
			context,
		)
		expect(state.identifier).toBeTruthy()
		expect(response.headers.get('x-request-id')).toBe(state.identifier)
	})

	it('trust-echo matrix: with trust true, a valid incoming request id is echoed', async () => {
		const security = createSecurity<{ identifier?: string }>({ identifier: { trust: true } })
		const state: { identifier?: string } = {}
		const request = buildTestRequest('/', { headers: { 'x-request-id': 'req_abc-123' } })
		const context = createTestContext(request, state)
		const response = await runChain([security], createEchoTerminal(), request, context)
		expect(state.identifier).toBe('req_abc-123')
		expect(response.headers.get('x-request-id')).toBe('req_abc-123')
	})

	it('trust-echo matrix: a hostile incoming id (fails isValidRequestId) is regenerated, not echoed', async () => {
		const security = createSecurity<{ identifier?: string }>({ identifier: { trust: true } })
		const state: { identifier?: string } = {}
		const request = buildTestRequest('/', {
			headers: { 'x-request-id': 'bad header with spaces!' },
		})
		const context = createTestContext(request, state)
		await runChain([security], createEchoTerminal(), request, context)
		expect(state.identifier).not.toBe('bad header with spaces!')
	})

	it('trust-echo matrix: with trust false (default), an incoming id is always replaced by a fresh mint', async () => {
		const security = createSecurity<{ identifier?: string }>()
		const state: { identifier?: string } = {}
		const request = buildTestRequest('/', { headers: { 'x-request-id': 'req_abc-123' } })
		const context = createTestContext(request, state)
		await runChain([security], createEchoTerminal(), request, context)
		expect(state.identifier).not.toBe('req_abc-123')
	})

	it('identifier: false disables minting entirely', async () => {
		const security = createSecurity<{ identifier?: string }>({ identifier: false })
		const state: { identifier?: string } = {}
		const context = createTestContext(buildTestRequest('/'), state)
		const response = await runChain(
			[security],
			createEchoTerminal(),
			buildTestRequest('/'),
			context,
		)
		expect(state.identifier).toBeUndefined()
		expect(response.headers.has('x-request-id')).toBe(false)
	})

	it('coep/hsts are opt-in: true uses the secure default, a string overrides, omitted stays off', async () => {
		const security = createSecurity<{ identifier?: string }>({ coep: true, hsts: 'max-age=1' })
		const context = createTestContext(buildTestRequest('/'), {})
		const response = await runChain(
			[security],
			createEchoTerminal(),
			buildTestRequest('/'),
			context,
		)
		expect(response.headers.get('cross-origin-embedder-policy')).toBe('require-corp')
		expect(response.headers.get('strict-transport-security')).toBe('max-age=1')
	})
})

// ── createCors ────────────────────────────────────────────────────────────

describe('createCors', () => {
	it('wildcard origin sets Access-Control-Allow-Origin: * with no Vary', async () => {
		const cors = createCors()
		const request = buildTestRequest('/', { headers: { origin: 'https://app.example' } })
		const context = createTestContext(request, {})
		const response = await runChain([cors], createEchoTerminal(), request, context)
		expect(response.headers.get('access-control-allow-origin')).toBe('*')
		expect(response.headers.has('vary')).toBe(false)
	})

	it('list origin reflects a matching request Origin and merges Vary: Origin', async () => {
		const cors = createCors({ origin: ['https://app.example'] })
		const request = buildTestRequest('/', { headers: { origin: 'https://app.example' } })
		const context = createTestContext(request, {})
		const response = await runChain([cors], createEchoTerminal(), request, context)
		expect(response.headers.get('access-control-allow-origin')).toBe('https://app.example')
		expect(response.headers.get('vary')).toBe('Origin')
	})

	it('the literal Origin: null is never reflected even when "null" is allow-listed', async () => {
		const cors = createCors({ origin: ['null'] })
		const request = buildTestRequest('/', { headers: { origin: 'null' } })
		const context = createTestContext(request, {})
		const response = await runChain([cors], createEchoTerminal(), request, context)
		expect(response.headers.has('access-control-allow-origin')).toBe(false)
	})

	it('preflight short-circuits with 204 and advertised methods/headers', async () => {
		const cors = createCors({ methods: ['GET', 'POST'], headers: ['Content-Type'] })
		const request = buildTestRequest('/', {
			method: 'OPTIONS',
			headers: { origin: 'https://app.example', 'access-control-request-method': 'POST' },
		})
		const context = createTestContext(request, {})
		const terminal = createRecordingTerminal()
		const response = await runChain([cors], terminal.handler, request, context)
		expect(response.status).toBe(204)
		expect(response.headers.get('access-control-allow-methods')).toBe('GET, POST')
		expect(response.headers.get('access-control-allow-headers')).toBe('Content-Type')
		expect(terminal.count).toBe(0)
	})

	it('a non-preflight OPTIONS (no Access-Control-Request-Method) passes through to the terminal', async () => {
		const cors = createCors()
		const request = buildTestRequest('/', { method: 'OPTIONS' })
		const context = createTestContext(request, {})
		const terminal = createRecordingTerminal()
		await runChain([cors], terminal.handler, request, context)
		expect(terminal.count).toBe(1)
	})

	it('fixed-string origin mode: the configured origin is set verbatim, matching or not, with no Vary', async () => {
		const cors = createCors({ origin: 'https://static.example' })

		const matching = buildTestRequest('/', { headers: { origin: 'https://static.example' } })
		const matchingResponse = await runChain(
			[cors],
			createEchoTerminal(),
			matching,
			createTestContext(matching, {}),
		)
		expect(matchingResponse.headers.get('access-control-allow-origin')).toBe(
			'https://static.example',
		)
		expect(matchingResponse.headers.has('vary')).toBe(false)

		const mismatched = buildTestRequest('/', { headers: { origin: 'https://evil.example' } })
		const mismatchedResponse = await runChain(
			[cors],
			createEchoTerminal(),
			mismatched,
			createTestContext(mismatched, {}),
		)
		expect(mismatchedResponse.headers.get('access-control-allow-origin')).toBe(
			'https://static.example',
		)
		expect(mismatchedResponse.headers.has('vary')).toBe(false)
	})
})

// ── createDeadline ────────────────────────────────────────────────────────

describe('createDeadline', () => {
	it('a fast handler is unaffected and the timer is cleared', async () => {
		const deadline = createDeadline<Record<string, never>>({ ms: 200 })
		const context = createTestContext(buildTestRequest('/'), {})
		const response = await runChain(
			[deadline],
			createEchoTerminal(),
			buildTestRequest('/'),
			context,
		)
		expect(await response.text()).toBe(ECHO_MARKER)
	})

	it('a slow handler triggers the default 503 and the context aborts once with the deadline reason', async () => {
		const deadline = createDeadline<Record<string, never>>({ ms: 20 })
		const reasons: unknown[] = []
		const context = createTestContext(
			buildTestRequest('/'),
			{},
			{ abort: (reason) => reasons.push(reason) },
		)
		const response = await deadline(buildTestRequest('/'), context, async () => {
			await waitForDelay(100)
			return new Response('too slow')
		})
		expect(response.status).toBe(503)
		expect(reasons).toHaveLength(1)
		expect(reasons[0]).toBeInstanceOf(Error)
	})

	it('a fast handler never aborts the context', async () => {
		const deadline = createDeadline<Record<string, never>>({ ms: 200 })
		const reasons: unknown[] = []
		const context = createTestContext(
			buildTestRequest('/'),
			{},
			{ abort: (reason) => reasons.push(reason) },
		)
		const next = createRecordingNext()
		await deadline(buildTestRequest('/'), context, next.next)
		expect(next.calls).toEqual([0])
		expect(reasons).toEqual([])
	})

	it('accepts a custom status', async () => {
		const deadline = createDeadline<Record<string, never>>({ ms: 20, status: 504 })
		const context = createTestContext(buildTestRequest('/'), {})
		const response = await deadline(buildTestRequest('/'), context, async () => {
			await waitForDelay(100)
			return new Response('too slow')
		})
		expect(response.status).toBe(504)
	})

	it('rejects a non-finite ms at construction', () => {
		expect(() => createDeadline({ ms: Number.NaN })).toThrow(ContractError)
	})

	it('rejects a non-positive ms at construction', () => {
		expect(() => createDeadline({ ms: 0 })).toThrow(ContractError)
		expect(() => createDeadline({ ms: -1 })).toThrow(ContractError)
	})

	it('a downstream throw arriving AFTER the deadline wins never escapes as an unhandled rejection', async () => {
		const deadline = createDeadline<Record<string, never>>({ ms: 20 })
		const context = createTestContext(buildTestRequest('/'), {})
		// `handler` is a stable reference, so `off` removes the listener `on`
		// added rather than leaking it into the rest of the run.
		const unhandled = createRecorder<[unknown]>()
		process.on('unhandledRejection', unhandled.handler)
		try {
			const response = await deadline(buildTestRequest('/'), context, async () => {
				await waitForDelay(20)
				throw new Error('downstream failed after deadline')
			})
			expect(response.status).toBe(503)
			await waitForDelay(60)
			expect(unhandled.count).toBe(0)
		} finally {
			process.off('unhandledRejection', unhandled.handler)
		}
	})
})

// ── The exchange seam through a real Server ───────────────────────────────

describe('the exchange seam through a real Server', () => {
	const running: ExchangeFixtureInterface[] = []

	afterEach(async () => {
		await Promise.all(running.splice(0).map((fixture) => fixture.stop()))
	})

	const json = { 'content-type': 'application/json' }

	it('F1: createDeadline then createBody answers a JSON POST 200 with the body', async () => {
		const fixture = await startExchange(running, [
			createDeadline<ExchangeState>({ ms: 5_000 }),
			createBody(),
		])
		const response = await fetch(`${fixture.url}/echo`, {
			method: 'POST',
			headers: json,
			body: '{"item":"lamp"}',
		})
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ body: { item: 'lamp' } })
	})

	it('F1: the same composition behind createBoundary answers 200 with the body', async () => {
		const fixture = await startExchange(running, [
			createBoundary<ExchangeState>({ expose: false }),
			createDeadline<ExchangeState>({ ms: 5_000 }),
			createBody(),
		])
		const response = await fetch(`${fixture.url}/echo`, {
			method: 'POST',
			headers: json,
			body: '{"item":"lamp"}',
		})
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ body: { item: 'lamp' } })
	})

	it('F1 expiry: a deadline that fires first answers its status and aborts the handler request with the deadline reason', async () => {
		const fixture = await startExchange(running, [
			createDeadline<ExchangeState>({ ms: 20, status: 504 }),
		])
		const response = await fetch(`${fixture.url}/slow`)
		expect(response.status).toBe(504)
		await waitForCondition(
			'the slow route received its request',
			() => fixture.requests.length === 1,
		)
		const signal = fixture.requests[0]?.signal
		expect(signal?.aborted).toBe(true)
		expect(signal?.reason).toBeInstanceOf(Error)
	})

	it('F4: createForwarded resolves the client ip from the socket peer under state: () => ({})', async () => {
		const fixture = await startExchange(running, [createForwarded<ExchangeState>({ proxies: 1 })])
		const response = await fetch(`${fixture.url}/client`)
		expect(await response.text()).toBe('127.0.0.1')
	})

	it('F4: createSession and createCSRF omit Secure over the plain Server', async () => {
		const fixture = await startExchange(running, [
			createSession<SessionInterface, ExchangeState>({
				transport: createCookieTransport({ secret: TEST_SECRET }),
			}),
			createCSRF<ExchangeState>({ secret: TEST_SECRET }),
		])
		const response = await fetch(`${fixture.url}/plain`)
		const cookies = response.headers.getSetCookie()
		expect(cookies.find((value) => value.startsWith('session='))).toBeDefined()
		expect(cookies.find((value) => value.startsWith('csrf='))).toBeDefined()
		for (const cookie of cookies) expect(cookie).not.toContain('Secure')
	})

	it('every battery hands the terminal the Request the server built', async () => {
		const fixture = buildStaticFixture()
		const outer: Request[] = []
		try {
			const server = await startExchange(running, [
				async (request, _context, next) => {
					outer.push(request)
					return next()
				},
				createTelemetry<ExchangeState>({ record: () => {} }),
				createBoundary<ExchangeState>({ expose: false }),
				createSecurity<ExchangeState>(),
				createCors<ExchangeState>({ origin: ['https://app.example'] }),
				createDeadline<ExchangeState>({ ms: 5_000 }),
				createForwarded<ExchangeState>({ proxies: 1 }),
				createETag<ExchangeState>(),
				createCompression<ExchangeState>(),
				createNodeCompression<ExchangeState>(),
				createBearer<ExchangeState>({ verify: (token) => token }),
				createLimiter<ExchangeState>({ max: 10, window: 60_000 }),
				createSession<SessionInterface, ExchangeState>({
					transport: createCookieTransport({ secret: TEST_SECRET }),
				}),
				createCSRF<ExchangeState>({ secret: TEST_SECRET }),
				createBody(),
				createMultipart<ExchangeState>(),
				createStatic<ExchangeState>({ root: fixture.scratch.path, prefix: '/static' }),
				createAssets<ExchangeState>({ source: createAssetSource(new Map()).source }),
			])
			const response = await fetch(`${server.url}/plain`, {
				headers: { authorization: 'Bearer token-1', origin: 'https://app.example' },
			})
			expect(response.status).toBe(200)
			expect(await response.text()).toBe('plain')
			expect(server.requests).toHaveLength(1)
			expect(outer).toHaveLength(1)
			expect(server.requests[0]).toBe(outer[0])
		} finally {
			fixture.scratch.destroy()
		}
	})
})

// ── createForwarded ───────────────────────────────────────────────────────

describe('createForwarded', () => {
	it('with one proxy, resolves the hop that proxy appended', async () => {
		const forwarded = createForwarded<ClientState>({ proxies: 1 })
		const request = buildTestRequest('/', {
			headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' },
		})
		const state: ClientState = {}
		const context = createTestContext(request, state, {
			connection: { ip: '10.0.0.2', encrypted: false },
		})
		await runChain([forwarded], createEchoTerminal(), request, context)
		expect(state.client?.ip).toBe('10.0.0.1')
	})

	it('with a trusted roster, walks left from a trusted socket peer to the first untrusted hop', async () => {
		const forwarded = createForwarded<ClientState>({ trusted: ['10.0.0.0/8'] })
		const request = buildTestRequest('/', {
			headers: { 'x-forwarded-for': '198.51.100.66, 203.0.113.7, 10.0.0.1' },
		})
		const state: ClientState = {}
		const context = createTestContext(request, state, {
			connection: { ip: '10.0.0.2', encrypted: false },
		})
		await runChain([forwarded], createEchoTerminal(), request, context)
		expect(state.client?.ip).toBe('203.0.113.7')
	})

	it('with a trusted roster, resolves an untrusted socket peer that names a trusted hop', async () => {
		const forwarded = createForwarded<ClientState>({ trusted: ['10.0.0.0/8'] })
		const request = buildTestRequest('/', {
			headers: { 'x-forwarded-for': '198.51.100.66, 10.0.0.1' },
		})
		const state: ClientState = {}
		const context = createTestContext(request, state, {
			connection: { ip: '192.0.2.55', encrypted: false },
		})
		await runChain([forwarded], createEchoTerminal(), request, context)
		expect(state.client?.ip).toBe('192.0.2.55')
	})

	it('reads no Forwarded header: a Forwarded hop alone resolves the socket peer', async () => {
		const forwarded = createForwarded<ClientState>({ proxies: 1 })
		const request = buildTestRequest('/', { headers: { forwarded: 'for=198.51.100.66' } })
		const state: ClientState = {}
		const context = createTestContext(request, state, {
			connection: { ip: '10.0.0.2', encrypted: false },
		})
		await runChain([forwarded], createEchoTerminal(), request, context)
		expect(state.client?.ip).toBe('10.0.0.2')
	})

	it('requires exactly one of proxies/trusted at construction', () => {
		expect(() => createForwarded({ proxies: 1, trusted: ['10.0.0.0/8'] })).toThrow(ContractError)
	})

	it('rejects a non-positive-integer proxies at construction (proxies:0 would trust zero hops, letting an attacker-controlled rightmost hop resolve as the client)', () => {
		expect(() => createForwarded({ proxies: 0 })).toThrow(ContractError)
		expect(() => createForwarded({ proxies: 1.5 })).toThrow(ContractError)
		expect(() => createForwarded({ proxies: -1 })).toThrow(ContractError)
	})

	it('with one proxy, never resolves a hop the client wrote ahead of the appended one', async () => {
		const forwarded = createForwarded<ClientState>({ proxies: 1 })
		const request = buildTestRequest('/', {
			headers: { 'x-forwarded-for': '198.51.100.66, 203.0.113.7, 10.0.0.1' },
		})
		const state: ClientState = {}
		const context = createTestContext(request, state, {
			connection: { ip: '10.0.0.2', encrypted: false },
		})
		await runChain([forwarded], createEchoTerminal(), request, context)
		expect(state.client?.ip).toBe('10.0.0.1')
	})

	it('with a proxies count longer than the header, resolves the socket peer', async () => {
		const forwarded = createForwarded<ClientState>({ proxies: 2 })
		const request = buildTestRequest('/', { headers: { 'x-forwarded-for': '198.51.100.66' } })
		const state: ClientState = {}
		const context = createTestContext(request, state, {
			connection: { ip: '10.0.0.2', encrypted: false },
		})
		await runChain([forwarded], createEchoTerminal(), request, context)
		expect(state.client?.ip).toBe('10.0.0.2')
	})

	it('falls back to the connection ip when no forwarded hop qualifies', async () => {
		const forwarded = createForwarded<ClientState>({ proxies: 1 })
		const request = buildTestRequest('/')
		const state: ClientState = {}
		const context = createTestContext(request, state, {
			connection: { ip: '198.51.100.9', encrypted: false },
		})
		await runChain([forwarded], createEchoTerminal(), request, context)
		expect(state.client?.ip).toBe('198.51.100.9')
	})
})

// ── createETag ────────────────────────────────────────────────────────────

describe('createETag', () => {
	it('mints a weak ETag by default', async () => {
		const etag = createETag<Record<string, never>>()
		const request = buildTestRequest('/')
		const context = createTestContext(request, {})
		const response = await runChain(
			[etag],
			async () => new Response('body content'),
			request,
			context,
		)
		const header = response.headers.get('etag')
		expect(header).not.toBeNull()
		expect(header?.startsWith('W/"')).toBe(true)
	})

	it('mints a strong ETag when weak: false', async () => {
		const etag = createETag<Record<string, never>>({ weak: false })
		const request = buildTestRequest('/')
		const context = createTestContext(request, {})
		const response = await runChain(
			[etag],
			async () => new Response('body content'),
			request,
			context,
		)
		expect(response.headers.get('etag')?.startsWith('W/')).toBe(false)
	})

	it('If-None-Match matching a single value returns 304 without a body', async () => {
		const etag = createETag<Record<string, never>>()
		const first = await runChain(
			[etag],
			async () => new Response('body content'),
			buildTestRequest('/'),
			createTestContext(buildTestRequest('/'), {}),
		)
		const known = first.headers.get('etag')
		expect(known).not.toBeNull()
		const request = buildTestRequest('/', { headers: { 'if-none-match': known ?? '' } })
		const context = createTestContext(request, {})
		const response = await runChain(
			[etag],
			async () => new Response('body content'),
			request,
			context,
		)
		expect(response.status).toBe(304)
		expect(await response.text()).toBe('')
	})

	it('the 304 response carries the ETag and never a stale Content-Length', async () => {
		const etag = createETag<Record<string, never>>()
		const first = await runChain(
			[etag],
			async () => new Response('body content'),
			buildTestRequest('/'),
			createTestContext(buildTestRequest('/'), {}),
		)
		const known = first.headers.get('etag')
		expect(known).not.toBeNull()
		const request = buildTestRequest('/', { headers: { 'if-none-match': known ?? '' } })
		const context = createTestContext(request, {})
		const response = await runChain(
			[etag],
			async () => new Response('body content', { headers: { 'content-length': '12' } }),
			request,
			context,
		)
		expect(response.status).toBe(304)
		expect(response.headers.get('etag')).toBe(known)
		expect(response.headers.has('content-length')).toBe(false)
	})

	it('If-None-Match with a list or * short-circuits with 304', async () => {
		const etag = createETag<Record<string, never>>()
		const first = await runChain(
			[etag],
			async () => new Response('body content'),
			buildTestRequest('/'),
			createTestContext(buildTestRequest('/'), {}),
		)
		const known = first.headers.get('etag')
		const listRequest = buildTestRequest('/', {
			headers: { 'if-none-match': `"other", ${known ?? ''}` },
		})
		const listResponse = await runChain(
			[etag],
			async () => new Response('body content'),
			listRequest,
			createTestContext(listRequest, {}),
		)
		expect(listResponse.status).toBe(304)

		const starRequest = buildTestRequest('/', { headers: { 'if-none-match': '*' } })
		const starResponse = await runChain(
			[etag],
			async () => new Response('body content'),
			starRequest,
			createTestContext(starRequest, {}),
		)
		expect(starResponse.status).toBe(304)
	})

	it('an existing ETag on the response is respected (skipped, not overwritten)', async () => {
		const etag = createETag<Record<string, never>>()
		const request = buildTestRequest('/')
		const context = createTestContext(request, {})
		const response = await runChain(
			[etag],
			async () => new Response('body content', { headers: { etag: '"preset"' } }),
			request,
			context,
		)
		expect(response.headers.get('etag')).toBe('"preset"')
	})

	it('a non-GET or non-200 response is left untouched', async () => {
		const etag = createETag<Record<string, never>>()
		const postRequest = buildTestRequest('/', { method: 'POST' })
		const postResponse = await runChain(
			[etag],
			async () => new Response('body content'),
			postRequest,
			createTestContext(postRequest, {}),
		)
		expect(postResponse.headers.has('etag')).toBe(false)

		const errorRequest = buildTestRequest('/')
		const errorResponse = await runChain(
			[etag],
			async () => new Response('nope', { status: 404 }),
			errorRequest,
			createTestContext(errorRequest, {}),
		)
		expect(errorResponse.headers.has('etag')).toBe(false)
	})
})

// ── createBearer ──────────────────────────────────────────────────────────

describe('createBearer', () => {
	it('a request with no Authorization header answers a 401 challenge and the handler never runs', async () => {
		const bearer = createBearer<BearerState>({
			verify: () => 'user-1',
			challenge: { realm: 'taverna' },
		})
		const next = createRecordingNext()
		const request = buildTestRequest('/')
		const response = await bearer(request, createTestContext(request, {}), next.next)
		expect(response.status).toBe(401)
		expect(await response.text()).toBe('missing token')
		expect(response.headers.get('www-authenticate')).toBe('Bearer realm="taverna"')
		expect(response.headers.get('www-authenticate')).not.toContain('error')
		expect(next.count).toBe(0)
	})

	it('a scheme that does not match answers the same missing-token challenge', async () => {
		const bearer = createBearer<BearerState>({
			verify: () => 'user-1',
			challenge: { realm: 'taverna' },
		})
		const next = createRecordingNext()
		const request = buildTestRequest('/', { headers: { authorization: 'Basic dXNlcjpwYXNz' } })
		const response = await bearer(request, createTestContext(request, {}), next.next)
		expect(response.status).toBe(401)
		expect(await response.text()).toBe('missing token')
		expect(response.headers.get('www-authenticate')).toBe('Bearer realm="taverna"')
		expect(next.count).toBe(0)
	})

	it('a bare scheme, which Headers trims to a scheme mismatch, answers the missing-token challenge without calling verify', async () => {
		const calls = createRecorder<[string, Request]>()
		const bearer = createBearer<BearerState>({
			verify: (token, request) => {
				calls.handler(token, request)
				return 'user-1'
			},
			challenge: { realm: 'taverna' },
		})
		const next = createRecordingNext()
		const request = buildTestRequest('/', { headers: { authorization: 'Bearer ' } })
		const response = await bearer(request, createTestContext(request, {}), next.next)
		expect(response.status).toBe(401)
		expect(await response.text()).toBe('missing token')
		expect(response.headers.get('www-authenticate')).toBe('Bearer realm="taverna"')
		expect(calls.count).toBe(0)
		expect(next.count).toBe(0)
	})

	it('an empty header under scheme: "" answers the missing-token challenge without calling verify', async () => {
		const calls = createRecorder<[string, Request]>()
		const bearer = createBearer<BearerState>({
			verify: (token, request) => {
				calls.handler(token, request)
				return 'user-1'
			},
			scheme: '',
		})
		const next = createRecordingNext()
		const request = buildTestRequest('/', { headers: { authorization: '' } })
		expect(request.headers.get('authorization')).toBe('')
		const response = await bearer(request, createTestContext(request, {}), next.next)
		expect(response.status).toBe(401)
		expect(await response.text()).toBe('missing token')
		expect(response.headers.get('www-authenticate')).toBe('Bearer')
		expect(calls.count).toBe(0)
		expect(next.count).toBe(0)
	})

	it('verify resolving undefined answers an invalid_token challenge and the handler never runs', async () => {
		const bearer = createBearer<BearerState>({
			verify: () => undefined,
			challenge: { realm: 'taverna' },
		})
		const next = createRecordingNext()
		const request = buildTestRequest('/', { headers: { authorization: 'Bearer abc' } })
		const response = await bearer(request, createTestContext(request, {}), next.next)
		expect(response.status).toBe(401)
		expect(await response.text()).toBe('invalid token')
		expect(response.headers.get('www-authenticate')).toBe(
			'Bearer realm="taverna", error="invalid_token"',
		)
		expect(next.count).toBe(0)
	})

	it('a verify that throws rejects with that same error and the handler never runs', async () => {
		const failure = new Error('verifier is down')
		const bearer = createBearer<BearerState>({
			verify: () => {
				throw failure
			},
		})
		const next = createRecordingNext()
		const request = buildTestRequest('/', { headers: { authorization: 'Bearer abc' } })
		await expect(bearer(request, createTestContext(request, {}), next.next)).rejects.toBe(failure)
		expect(next.count).toBe(0)
	})

	it('a verify that rejects propagates that same error', async () => {
		const failure = new Error('verifier rejected')
		const bearer = createBearer<BearerState>({ verify: () => Promise.reject(failure) })
		const next = createRecordingNext()
		const request = buildTestRequest('/', { headers: { authorization: 'Bearer abc' } })
		await expect(bearer(request, createTestContext(request, {}), next.next)).rejects.toBe(failure)
		expect(next.count).toBe(0)
	})

	it('an object credential is stashed on state.token and next runs exactly once', async () => {
		const credential = { subject: 'user-1', scope: 'read' }
		const bearer = createBearer<BearerState<typeof credential>, typeof credential>({
			verify: () => credential,
		})
		const state: BearerState<typeof credential> = {}
		const next = createRecordingNext()
		const request = buildTestRequest('/', { headers: { authorization: 'Bearer abc' } })
		const response = await bearer(request, createTestContext(request, state), next.next)
		expect(response.status).toBe(200)
		expect(state.token).toBe(credential)
		expect(next.count).toBe(1)
	})

	it('verify receives the extracted token and the same Request object', async () => {
		const calls = createRecorder<[string, Request]>()
		const bearer = createBearer<BearerState>({
			verify: (token, request) => {
				calls.handler(token, request)
				return 'user-1'
			},
		})
		const request = buildTestRequest('/', { headers: { authorization: 'Bearer abc.def' } })
		await bearer(request, createTestContext(request, {}), createRecordingNext().next)
		expect(calls.count).toBe(1)
		expect(calls.calls[0]?.[0]).toBe('abc.def')
		expect(calls.calls[0]?.[1]).toBe(request)
	})

	it('a synchronous verify returning a credential admits the request', async () => {
		const bearer = createBearer<BearerState>({ verify: (token) => `sync:${token}` })
		const state: BearerState = {}
		const request = buildTestRequest('/', { headers: { authorization: 'Bearer abc' } })
		const response = await runChain(
			[bearer],
			createEchoTerminal(),
			request,
			createTestContext(request, state),
		)
		expect(await response.text()).toBe(ECHO_MARKER)
		expect(state.token).toBe('sync:abc')
	})

	it('the HMAC arrangement: a valid token is stashed on state and the chain continues', async () => {
		const token = await signToken('user-1', { secret: TEST_SECRET })
		const bearer = createBearer<BearerState>({ verify: (value) => verifyToken(value, TEST_SECRET) })
		const state: BearerState = {}
		const request = buildTestRequest('/', { headers: { authorization: `Bearer ${token}` } })
		const context = createTestContext(request, state)
		const response = await runChain([bearer], createEchoTerminal(), request, context)
		expect(await response.text()).toBe(ECHO_MARKER)
		expect(state.token).toBe('user-1')
	})

	it('the HMAC arrangement: a missing token answers a returned 401', async () => {
		const bearer = createBearer<BearerState>({ verify: (value) => verifyToken(value, TEST_SECRET) })
		const request = buildTestRequest('/')
		const response = await bearer(
			request,
			createTestContext(request, {}),
			createRecordingNext().next,
		)
		expect(response.status).toBe(401)
		expect(await response.text()).toBe('missing token')
	})

	it('the HMAC arrangement: a tampered token answers a returned 401', async () => {
		const token = await signToken('user-1', { secret: TEST_SECRET })
		const bearer = createBearer<BearerState>({ verify: (value) => verifyToken(value, TEST_SECRET) })
		const next = createRecordingNext()
		const request = buildTestRequest('/', { headers: { authorization: `Bearer ${token}xx` } })
		const response = await bearer(request, createTestContext(request, {}), next.next)
		expect(response.status).toBe(401)
		expect(await response.text()).toBe('invalid token')
		expect(response.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"')
		expect(next.count).toBe(0)
	})

	it('the HMAC arrangement: an expired token answers a returned 401', async () => {
		const token = await signToken('user-1', { secret: TEST_SECRET, ttl: 1 })
		await waitForDelay(20)
		const bearer = createBearer<BearerState>({ verify: (value) => verifyToken(value, TEST_SECRET) })
		const next = createRecordingNext()
		const request = buildTestRequest('/', { headers: { authorization: `Bearer ${token}` } })
		const response = await bearer(request, createTestContext(request, {}), next.next)
		expect(response.status).toBe(401)
		expect(await response.text()).toBe('invalid token')
		expect(next.count).toBe(0)
	})

	it('the HMAC arrangement: a token signed with an older secret verifies against a rotation list', async () => {
		const oldToken = await signToken('user-1', { secret: 'old-secret' })
		const bearer = createBearer<BearerState>({
			verify: (value) => verifyToken(value, ['new-secret', 'old-secret']),
		})
		const state: BearerState = {}
		const request = buildTestRequest('/', { headers: { authorization: `Bearer ${oldToken}` } })
		const context = createTestContext(request, state)
		await runChain([bearer], createEchoTerminal(), request, context)
		expect(state.token).toBe('user-1')
	})

	it('the HMAC arrangement: the scheme prefix match is case-insensitive', async () => {
		const token = await signToken('user-1', { secret: TEST_SECRET })
		const bearer = createBearer<BearerState>({ verify: (value) => verifyToken(value, TEST_SECRET) })
		const state: BearerState = {}
		const request = buildTestRequest('/', { headers: { authorization: `bearer ${token}` } })
		const context = createTestContext(request, state)
		await runChain([bearer], createEchoTerminal(), request, context)
		expect(state.token).toBe('user-1')
	})

	it('the HMAC arrangement: scheme "" treats the whole header value as the raw token', async () => {
		const token = await signToken('user-1', { secret: TEST_SECRET })
		const bearer = createBearer<BearerState>({
			verify: (value) => verifyToken(value, TEST_SECRET),
			scheme: '',
		})
		const state: BearerState = {}
		const request = buildTestRequest('/', { headers: { authorization: token } })
		const context = createTestContext(request, state)
		await runChain([bearer], createEchoTerminal(), request, context)
		expect(state.token).toBe('user-1')
	})

	it('scheme "" with no header answers a challenge naming Bearer', async () => {
		const bearer = createBearer<BearerState>({ verify: () => 'user-1', scheme: '' })
		const request = buildTestRequest('/')
		const response = await bearer(
			request,
			createTestContext(request, {}),
			createRecordingNext().next,
		)
		expect(response.headers.get('www-authenticate')).toBe('Bearer')
	})

	it('scheme "Token" answers a challenge naming Token', async () => {
		const bearer = createBearer<BearerState>({ verify: () => undefined, scheme: 'Token' })
		const missing = buildTestRequest('/')
		const invalid = buildTestRequest('/', { headers: { authorization: 'Token abc' } })
		const first = await bearer(missing, createTestContext(missing, {}), createRecordingNext().next)
		const second = await bearer(invalid, createTestContext(invalid, {}), createRecordingNext().next)
		expect(first.headers.get('www-authenticate')).toBe('Token')
		expect(second.headers.get('www-authenticate')).toBe('Token error="invalid_token"')
	})

	it('with no challenge given the missing response header is exactly Bearer', async () => {
		const bearer = createBearer<BearerState>({ verify: () => 'user-1' })
		const request = buildTestRequest('/')
		const response = await bearer(
			request,
			createTestContext(request, {}),
			createRecordingNext().next,
		)
		expect(response.headers.get('www-authenticate')).toBe('Bearer')
	})

	it('refuses a missing or non-function verify at construction', () => {
		const missing: BearerOptions = JSON.parse('{}')
		const text: BearerOptions = JSON.parse('{"verify":"not-a-function"}')
		expect(() => createBearer(missing)).toThrow(ContractError)
		expect(() => createBearer(text)).toThrow(ContractError)
	})

	it('refuses a non-string header or scheme at construction', () => {
		// JSON.parse supplies the malformed member, absorbed by the annotated binding.
		const header: BearerOptions = Object.assign({ verify: () => 'x' }, JSON.parse('{"header":1}'))
		const scheme: BearerOptions = Object.assign({ verify: () => 'x' }, JSON.parse('{"scheme":1}'))
		expect(() => createBearer(header)).toThrow(ContractError)
		expect(() => createBearer(scheme)).toThrow(ContractError)
	})

	it('refuses a challenge that is not a record of string values at construction', () => {
		const number: BearerOptions = Object.assign(
			{ verify: () => 'x' },
			JSON.parse('{"challenge":{"realm":1}}'),
		)
		const list: BearerOptions = Object.assign(
			{ verify: () => 'x' },
			JSON.parse('{"challenge":["realm"]}'),
		)
		expect(() => createBearer(number)).toThrow(ContractError)
		expect(() => createBearer(list)).toThrow(ContractError)
	})

	it('refuses a challenge that names error in any case, because the battery owns it', () => {
		expect(() => createBearer({ verify: () => 'x', challenge: { error: 'x' } })).toThrow(
			ContractError,
		)
		expect(() => createBearer({ verify: () => 'x', challenge: { Error: 'x' } })).toThrow(
			ContractError,
		)
	})

	it('refuses a challenge name that is not a token at construction', () => {
		expect(() => createBearer({ verify: () => 'x', challenge: { 'two words': 'x' } })).toThrow(
			ContractError,
		)
	})

	it('refuses a challenge value holding a quote, a backslash, a CR, or an LF at construction', () => {
		for (const value of ['a"b', 'a\\b', 'a\rb', 'a\nb']) {
			expect(() => createBearer({ verify: () => 'x', challenge: { realm: value } })).toThrow(
				ContractError,
			)
		}
	})
})

// ── createLimiter ─────────────────────────────────────────────────────────

describe('createLimiter', () => {
	it('admits exactly max requests then 429s with Retry-After >= 1', async () => {
		const clock = createManualClock()
		const limiter = createLimiter<BearerState & ClientState>({
			max: 2,
			window: 1_000,
			clock: clock.clock,
		})
		const state: BearerState & ClientState = { client: { ip: '203.0.113.1' } }
		const context = createTestContext(buildTestRequest('/'), state)
		const first = await runChain([limiter], createEchoTerminal(), buildTestRequest('/'), context)
		const second = await runChain([limiter], createEchoTerminal(), buildTestRequest('/'), context)
		const third = await runChain([limiter], createEchoTerminal(), buildTestRequest('/'), context)
		expect(first.status).toBe(200)
		expect(second.status).toBe(200)
		expect(third.status).toBe(429)
		const retryAfter = Number(third.headers.get('retry-after'))
		expect(retryAfter).toBeGreaterThanOrEqual(1)
	})

	it('lazily rolls the window once the clock passes resetAt', async () => {
		const clock = createManualClock()
		const limiter = createLimiter<BearerState & ClientState>({
			max: 1,
			window: 1_000,
			clock: clock.clock,
		})
		const state: BearerState & ClientState = { client: { ip: '203.0.113.1' } }
		const context = createTestContext(buildTestRequest('/'), state)
		const first = await runChain([limiter], createEchoTerminal(), buildTestRequest('/'), context)
		const blocked = await runChain([limiter], createEchoTerminal(), buildTestRequest('/'), context)
		clock.advance(1_000)
		const afterRoll = await runChain(
			[limiter],
			createEchoTerminal(),
			buildTestRequest('/'),
			context,
		)
		expect(first.status).toBe(200)
		expect(blocked.status).toBe(429)
		expect(afterRoll.status).toBe(200)
	})

	it('isolates buckets per key, including the token: vs ip: idiom', async () => {
		const clock = createManualClock()
		const limiter = createLimiter<BearerState & ClientState>({
			max: 1,
			window: 1_000,
			clock: clock.clock,
		})
		const tokenState: BearerState & ClientState = { token: 'abc' }
		const ipState: BearerState & ClientState = { client: { ip: '203.0.113.1' } }
		const tokenContext = createTestContext(buildTestRequest('/'), tokenState)
		const ipContext = createTestContext(buildTestRequest('/'), ipState)
		const tokenResponse1 = await runChain(
			[limiter],
			createEchoTerminal(),
			buildTestRequest('/'),
			tokenContext,
		)
		const ipResponse1 = await runChain(
			[limiter],
			createEchoTerminal(),
			buildTestRequest('/'),
			ipContext,
		)
		expect(tokenResponse1.status).toBe(200)
		expect(ipResponse1.status).toBe(200)
	})

	it('collapses an IPv6 client address to its /64 network for the bucket key', async () => {
		const clock = createManualClock()
		const limiter = createLimiter<BearerState & ClientState>({
			max: 1,
			window: 1_000,
			clock: clock.clock,
		})
		const stateA: BearerState & ClientState = {
			client: { ip: '2001:db8:1:2:dead:beef:0:9' },
		}
		const stateB: BearerState & ClientState = {
			client: { ip: '2001:db8:1:2:aaaa:bbbb:0:1' },
		}
		const first = await runChain(
			[limiter],
			createEchoTerminal(),
			buildTestRequest('/'),
			createTestContext(buildTestRequest('/'), stateA),
		)
		const second = await runChain(
			[limiter],
			createEchoTerminal(),
			buildTestRequest('/'),
			createTestContext(buildTestRequest('/'), stateB),
		)
		expect(first.status).toBe(200)
		expect(second.status).toBe(429)
	})

	it('true LRU: eviction follows access recency, not insertion order', async () => {
		const clock = createManualClock()
		const limiter = createLimiter<BearerState & ClientState>({
			max: 1,
			window: 1_000,
			capacity: 2,
			clock: clock.clock,
		})
		const stateA: BearerState & ClientState = { client: { ip: '203.0.113.1' } }
		const stateB: BearerState & ClientState = { client: { ip: '203.0.113.2' } }
		const stateC: BearerState & ClientState = { client: { ip: '203.0.113.3' } }
		// Insert A then B (buckets: A, B — both exhausted at max:1).
		await runChain(
			[limiter],
			createEchoTerminal(),
			buildTestRequest('/'),
			createTestContext(buildTestRequest('/'), stateA),
		)
		await runChain(
			[limiter],
			createEchoTerminal(),
			buildTestRequest('/'),
			createTestContext(buildTestRequest('/'), stateB),
		)
		// Re-access A — under FIFO this would not matter, but true LRU moves A to
		// the most-recently-used position, leaving B as the least-recently-used.
		await runChain(
			[limiter],
			createEchoTerminal(),
			buildTestRequest('/'),
			createTestContext(buildTestRequest('/'), stateA),
		)
		// Inserting a brand-new key C exceeds capacity 2 — evicts the LRU entry, B.
		await runChain(
			[limiter],
			createEchoTerminal(),
			buildTestRequest('/'),
			createTestContext(buildTestRequest('/'), stateC),
		)
		// A's bucket survived (still exhausted from its earlier requests) —
		// FIFO would instead have evicted A here, admitting it fresh.
		const retryA = await runChain(
			[limiter],
			createEchoTerminal(),
			buildTestRequest('/'),
			createTestContext(buildTestRequest('/'), stateA),
		)
		expect(retryA.status).toBe(429)
		// B's bucket was evicted, so it is re-admitted fresh.
		const retryB = await runChain(
			[limiter],
			createEchoTerminal(),
			buildTestRequest('/'),
			createTestContext(buildTestRequest('/'), stateB),
		)
		expect(retryB.status).toBe(200)
	})

	it('invokes evict with the evicted bucket key', async () => {
		const clock = createManualClock()
		const evicted: string[] = []
		const limiter = createLimiter<BearerState & ClientState>({
			max: 1,
			window: 1_000,
			capacity: 1,
			clock: clock.clock,
			evict: (key) => evicted.push(key),
		})
		const stateA: BearerState & ClientState = { client: { ip: '203.0.113.1' } }
		const stateB: BearerState & ClientState = { client: { ip: '203.0.113.2' } }
		await runChain(
			[limiter],
			createEchoTerminal(),
			buildTestRequest('/'),
			createTestContext(buildTestRequest('/'), stateA),
		)
		await runChain(
			[limiter],
			createEchoTerminal(),
			buildTestRequest('/'),
			createTestContext(buildTestRequest('/'), stateB),
		)
		expect(evicted).toEqual(['ip:203.0.113.1'])
	})

	it('honors a custom key function', async () => {
		const clock = createManualClock()
		const limiter = createLimiter<BearerState & ClientState>({
			max: 1,
			window: 1_000,
			clock: clock.clock,
			key: () => 'fixed-key',
		})
		const stateA: BearerState & ClientState = { client: { ip: '203.0.113.1' } }
		const stateB: BearerState & ClientState = { client: { ip: '203.0.113.2' } }
		const first = await runChain(
			[limiter],
			createEchoTerminal(),
			buildTestRequest('/'),
			createTestContext(buildTestRequest('/'), stateA),
		)
		const second = await runChain(
			[limiter],
			createEchoTerminal(),
			buildTestRequest('/'),
			createTestContext(buildTestRequest('/'), stateB),
		)
		expect(first.status).toBe(200)
		expect(second.status).toBe(429)
	})

	it('honors a custom message on the 429 body', async () => {
		const clock = createManualClock()
		const limiter = createLimiter<BearerState & ClientState>({
			max: 1,
			window: 1_000,
			clock: clock.clock,
			message: 'slow down',
		})
		const state: BearerState & ClientState = { client: { ip: '203.0.113.1' } }
		const context = createTestContext(buildTestRequest('/'), state)
		await runChain([limiter], createEchoTerminal(), buildTestRequest('/'), context)
		const second = await runChain([limiter], createEchoTerminal(), buildTestRequest('/'), context)
		expect(second.status).toBe(429)
		expect(await second.text()).toBe('slow down')
	})

	it('rejects malformed construction options with a ContractError', () => {
		expect(() => createLimiter({ max: 0, window: 1_000 })).toThrow(ContractError)
		expect(() => createLimiter({ max: 1.5, window: 1_000 })).toThrow(ContractError)
		expect(() => createLimiter({ max: 1, window: 0 })).toThrow(ContractError)
		expect(() => createLimiter({ max: 1, window: 1_000, capacity: 0 })).toThrow(ContractError)
		expect(() => createLimiter({ max: 1, window: 1_000, capacity: 1.5 })).toThrow(ContractError)
	})

	it('emits the exact RateLimit/RateLimit-Policy wire shape when policy: true', async () => {
		const clock = createManualClock()
		const limiter = createLimiter<BearerState & ClientState>({
			max: 3,
			window: 60_000,
			policy: true,
			clock: clock.clock,
		})
		const state: BearerState & ClientState = { client: { ip: '203.0.113.1' } }
		const context = createTestContext(buildTestRequest('/'), state)
		await runChain([limiter], createEchoTerminal(), buildTestRequest('/'), context)
		await runChain([limiter], createEchoTerminal(), buildTestRequest('/'), context)
		await runChain([limiter], createEchoTerminal(), buildTestRequest('/'), context)
		const fourth = await runChain([limiter], createEchoTerminal(), buildTestRequest('/'), context)
		expect(fourth.status).toBe(429)
		expect(fourth.headers.get('ratelimit')).toBe('"default";r=0;t=60')
		expect(fourth.headers.get('ratelimit-policy')).toBe('"default";q=3;w=60')
	})
})

// ── createBody ────────────────────────────────────────────────────────────

describe('createBody', () => {
	it('eagerly reads the body before the handler runs', async () => {
		const body = createBody<Record<string, never>>()
		const request = buildTestRequest('/', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{"a":1}',
		})
		const context = createTestContext(request, {})
		const sawBody = new MiddlewareValue<unknown>(undefined)
		await runChain(
			[body],
			async (_request, requestContext) => {
				sawBody.value = await requestContext.body()
				return new Response()
			},
			request,
			context,
		)
		expect(sawBody.value).toEqual({ a: 1 })
	})

	it('stashes the parsed body onto state.body', async () => {
		const body = createBody<BodyState>()
		const request = buildTestRequest('/', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{"a":1}',
		})
		const state: BodyState = {}
		const context = createTestContext(request, state)
		await runChain([body], createEchoTerminal(), request, context)
		expect(context.state.body).toEqual({ a: 1 })
	})

	it('still throws HTTPError 400 on invalid declared JSON after stashing undefined', async () => {
		const body = createBody<BodyState>()
		const request = buildTestRequest('/', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '',
		})
		const state: BodyState = {}
		const context = createTestContext(request, state)
		await expect(body(request, context, async () => new Response())).rejects.toMatchObject({
			status: 400,
		})
		expect(context.state.body).toBeUndefined()
	})

	it('throws HTTPError 400 when application/json body resolves undefined (invalid JSON)', async () => {
		const body = createBody<Record<string, never>>()
		const request = buildTestRequest('/', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '',
		})
		const context = createTestContext(request, {})
		await expect(body(request, context, async () => new Response())).rejects.toMatchObject({
			status: 400,
		})
	})

	it('propagates a ContentTooLargeError as a 413 through the chain', async () => {
		const body = createBody<Record<string, never>>()
		const oversized = 'x'.repeat(2_000_000)
		const request = new Request('http://test.local/', { method: 'POST', body: oversized })
		const context = createOversizedContext(request)
		await expect(body(request, context, async () => new Response())).rejects.toBeInstanceOf(
			ContentTooLargeError,
		)
	})
})

// ── createSession ─────────────────────────────────────────────────────────

describe('createSession', () => {
	it('auto-mints a session and writes the transport on the way out', async () => {
		const transport = createTestTransport()
		const session = createSession<SessionInterface, SessionState>({ transport })
		const request = buildTestRequest('/')
		const state: SessionState = {}
		const context = createTestContext(request, state)
		const response = await runChain([session], createEchoTerminal(), request, context)
		expect(state.session).toBeDefined()
		expect(response.headers.get('x-test-session')).toBe(state.session?.id)
	})

	it('resolves an existing session and re-persists it without re-writing the transport', async () => {
		const transport = createTestTransport()
		const store = createMemorySessionStore<SessionInterface>()
		const session = createSession<SessionInterface, SessionState>({ transport, store })
		const first = await runChain(
			[session],
			createEchoTerminal(),
			buildTestRequest('/'),
			createTestContext(buildTestRequest('/'), {}),
		)
		const id = first.headers.get('x-test-session')
		expect(id).not.toBeNull()

		const secondRequest = buildTestRequest('/', { headers: { 'x-test-session': id ?? '' } })
		const state: SessionState = {}
		const response = await runChain(
			[session],
			createEchoTerminal(),
			secondRequest,
			createTestContext(secondRequest, state),
		)
		expect(state.session?.id).toBe(id)
		expect(response.headers.has('x-test-session')).toBe(false)
	})

	it('rejects a malformed capacity at construction (admitted by the session contract)', () => {
		const transport = createTestTransport()
		expect(() => createSession<SessionInterface, SessionState>({ transport, capacity: 0 })).toThrow(
			ContractError,
		)
	})

	it('required: true renders 404 when no session resolves and mint declines', async () => {
		const transport = createTestTransport()
		const session = createSession<SessionInterface, SessionState>({
			transport,
			mint: () => false,
			required: true,
		})
		const request = buildTestRequest('/')
		const context = createTestContext(request, {})
		await expect(session(request, context, async () => new Response())).rejects.toMatchObject({
			status: 404,
		})
	})

	it('regenerate() rotates the id, keeps the state, and the old id is dead', async () => {
		const transport = createTestTransport()
		const store = createMemorySessionStore<SessionInterface>()
		const session = createSession<SessionInterface, SessionState>({ transport, store })
		const first = await runChain(
			[session],
			createEchoTerminal(),
			buildTestRequest('/'),
			createTestContext(buildTestRequest('/'), {}),
		)
		const oldId = first.headers.get('x-test-session')
		expect(oldId).not.toBeNull()
		const seeded = await store.get(oldId ?? '', Date.now())
		expect(seeded).toBeDefined()
		if (seeded !== undefined) seeded.set('k', 'v')
		if (seeded !== undefined) await store.set(seeded, Date.now())

		const request = buildTestRequest('/', { headers: { 'x-test-session': oldId ?? '' } })
		const state: SessionState = {}
		const response = await runChain(
			[session],
			async (_request, requestContext) => {
				requestContext.state.control?.regenerate()
				return new Response()
			},
			request,
			createTestContext(request, state),
		)
		const newId = response.headers.get('x-test-session')
		expect(newId).not.toBeNull()
		expect(newId).not.toBe(oldId)
		const newStored = await store.get(newId ?? '', Date.now())
		expect(newStored?.state.get('k')).toBe('v')
		const oldStored = await store.get(oldId ?? '', Date.now())
		expect(oldStored).toBeUndefined()
	})

	it('destroy() clears the session from the store and the transport', async () => {
		const transport = createTestTransport()
		const store = createMemorySessionStore<SessionInterface>()
		const session = createSession<SessionInterface, SessionState>({ transport, store })
		const first = await runChain(
			[session],
			createEchoTerminal(),
			buildTestRequest('/'),
			createTestContext(buildTestRequest('/'), {}),
		)
		const id = first.headers.get('x-test-session')

		const request = buildTestRequest('/', { headers: { 'x-test-session': id ?? '' } })
		const state: SessionState = {}
		const response = await runChain(
			[session],
			async (_request, requestContext) => {
				requestContext.state.control?.destroy()
				return new Response()
			},
			request,
			createTestContext(request, state),
		)
		expect(response.headers.has('x-test-session')).toBe(false)
		const stored = await store.get(id ?? '', Date.now())
		expect(stored).toBeUndefined()
	})

	it('installs no route of its own on DELETE — the terminal runs and the session survives', async () => {
		const transport = createTestTransport()
		const store = createMemorySessionStore<SessionInterface>()
		const session = createSession<SessionInterface, SessionState>({ transport, store })
		const first = await runChain(
			[session],
			createEchoTerminal(),
			buildTestRequest('/'),
			createTestContext(buildTestRequest('/'), {}),
		)
		const id = first.headers.get('x-test-session') ?? ''
		expect(id).not.toBe('')

		const request = buildTestRequest('/', {
			method: 'DELETE',
			headers: { 'x-test-session': id },
		})
		const terminal = createRecordingTerminal<SessionState>()
		const state: SessionState = {}
		const response = await runChain(
			[session],
			terminal.handler,
			request,
			createTestContext(request, state),
		)
		expect(terminal.count).toBe(1)
		expect(response.status).not.toBe(204)
		expect(await store.get(id, Date.now())).toBeDefined()
	})

	it('the mint predicate is honored, including async', async () => {
		const transport = createTestTransport()
		const session = createSession<SessionInterface, SessionState>({
			transport,
			mint: async () => Promise.resolve(false),
		})
		const request = buildTestRequest('/')
		const state: SessionState = {}
		const response = await runChain(
			[session],
			createEchoTerminal(),
			request,
			createTestContext(request, state),
		)
		expect(state.session).toBeUndefined()
		expect(response.headers.has('x-test-session')).toBe(false)
	})

	it('idle ttl evicts a session through the manual clock and an injected store', async () => {
		const clock = createManualClock()
		const transport = createTestTransport()
		const store = createMemorySessionStore<SessionInterface>({ ttl: 1_000 })
		const session = createSession<SessionInterface, SessionState>({
			transport,
			store,
			clock: clock.clock,
		})
		const first = await runChain(
			[session],
			createEchoTerminal(),
			buildTestRequest('/'),
			createTestContext(buildTestRequest('/'), {}),
		)
		const id = first.headers.get('x-test-session')
		clock.advance(2_000)
		const request = buildTestRequest('/', { headers: { 'x-test-session': id ?? '' } })
		const state: SessionState = {}
		await runChain([session], createEchoTerminal(), request, createTestContext(request, state))
		expect(state.session?.id).not.toBe(id)
	})

	it('absolute lifetime evicts a session even when continuously touched', async () => {
		const clock = createManualClock()
		const transport = createTestTransport()
		const store = createMemorySessionStore<SessionInterface>({ lifetime: 1_000 })
		const session = createSession<SessionInterface, SessionState>({
			transport,
			store,
			clock: clock.clock,
		})
		const first = await runChain(
			[session],
			createEchoTerminal(),
			buildTestRequest('/'),
			createTestContext(buildTestRequest('/'), {}),
		)
		const id = first.headers.get('x-test-session')
		clock.advance(500)
		const midRequest = buildTestRequest('/', { headers: { 'x-test-session': id ?? '' } })
		await runChain([session], createEchoTerminal(), midRequest, createTestContext(midRequest, {}))
		clock.advance(600)
		const lateRequest = buildTestRequest('/', { headers: { 'x-test-session': id ?? '' } })
		const state: SessionState = {}
		await runChain(
			[session],
			createEchoTerminal(),
			lateRequest,
			createTestContext(lateRequest, state),
		)
		expect(state.session?.id).not.toBe(id)
	})

	it('created is preserved across a re-set of the same session', async () => {
		const store = createMemorySessionStore<SessionInterface>({ lifetime: 10_000 })
		await store.set(buildSession('s1'), 0)
		await store.set(buildSession('s1'), 5_000)
		const stillAlive = await store.get('s1', 9_000)
		expect(stillAlive).toBeDefined()
		const expired = await store.get('s1', 10_500)
		expect(expired).toBeUndefined()
	})

	it('auto-Secure: the cookie transport carries Secure when connection.encrypted is true, omits it when false/absent', async () => {
		const transport = createCookieTransport({ secret: TEST_SECRET })
		const session = createSession<SessionInterface, SessionState>({ transport })

		const secureRequest = buildTestRequest('/')
		const secureResponse = await runChain(
			[session],
			createEchoTerminal(),
			secureRequest,
			createTestContext(secureRequest, {}, { connection: { ip: '203.0.113.1', encrypted: true } }),
		)
		expect(secureResponse.headers.get('set-cookie')).toContain('Secure')

		const plainRequest = buildTestRequest('/')
		const plainResponse = await runChain(
			[session],
			createEchoTerminal(),
			plainRequest,
			createTestContext(plainRequest, {}, { connection: { ip: '203.0.113.1', encrypted: false } }),
		)
		expect(plainResponse.headers.get('set-cookie')).not.toContain('Secure')
	})

	it('persists a freshly-minted session exactly once (no redundant mint-time store.set)', async () => {
		const setCount = new MiddlewareValue(0)
		const transport = createTestTransport()
		const memory = createMemorySessionStore<SessionInterface>()
		const store = createCountedStore(memory, setCount)
		const session = createSession<SessionInterface, SessionState>({ transport, store })
		const request = buildTestRequest('/')
		const state: SessionState = {}
		await runChain([session], createEchoTerminal(), request, createTestContext(request, state))
		expect(setCount.value).toBe(1)
	})

	it('threads capacity/evict into the default MemorySessionStore, which evicts and notifies at capacity', async () => {
		const evicted: string[] = []
		const transport = createTestTransport()
		const session = createSession<SessionInterface, SessionState>({
			transport,
			capacity: 1,
			evict: (id) => evicted.push(id),
		})
		const first = await runChain(
			[session],
			createEchoTerminal(),
			buildTestRequest('/'),
			createTestContext(buildTestRequest('/'), {}),
		)
		const firstId = first.headers.get('x-test-session')
		expect(firstId).not.toBeNull()

		// A second, distinct incoming (unresolvable) session id forces the store to
		// mint a brand-new session, exceeding capacity:1 and evicting the first.
		const second = await runChain(
			[session],
			createEchoTerminal(),
			buildTestRequest('/'),
			createTestContext(buildTestRequest('/'), {}),
		)
		expect(second.headers.get('x-test-session')).not.toBe(firstId)
		expect(evicted).toContain(firstId)
	})

	it('destroy() after an earlier regenerate() wins — the session is not persisted', async () => {
		const transport = createTestTransport()
		const store = createMemorySessionStore<SessionInterface>()
		const session = createSession<SessionInterface, SessionState>({ transport, store })
		const first = await runChain(
			[session],
			createEchoTerminal(),
			buildTestRequest('/'),
			createTestContext(buildTestRequest('/'), {}),
		)
		const oldId = first.headers.get('x-test-session')
		expect(oldId).not.toBeNull()

		const request = buildTestRequest('/', { headers: { 'x-test-session': oldId ?? '' } })
		const state: SessionState = {}
		const response = await runChain(
			[session],
			async (_request, requestContext) => {
				requestContext.state.control?.regenerate()
				requestContext.state.control?.destroy()
				return new Response()
			},
			request,
			createTestContext(request, state),
		)
		expect(response.headers.has('x-test-session')).toBe(false)
		const oldStored = await store.get(oldId ?? '', Date.now())
		expect(oldStored).toBeUndefined()
	})
})

// ── createCSRF ────────────────────────────────────────────────────────────

describe('createCSRF', () => {
	it('a safe method mints a token, stashes it on state, and sets the signed cookie', async () => {
		const csrf = createCSRF<CSRFState & SessionState>({ secret: TEST_SECRET })
		const request = buildTestRequest('/')
		const state: CSRFState & SessionState = {}
		const response = await runChain(
			[csrf],
			createEchoTerminal(),
			request,
			createTestContext(request, state),
		)
		expect(state.csrf).toBeTruthy()
		const setCookie = response.headers.get('set-cookie')
		expect(setCookie).toContain('csrf=')
		expect(setCookie).toContain('SameSite=Strict')
		expect(setCookie).not.toContain('HttpOnly')
	})

	it('mutating happy path: header submission matches the cookie and is accepted', async () => {
		const csrf = createCSRF<CSRFState & SessionState>({ secret: TEST_SECRET })
		const mintState: CSRFState & SessionState = {}
		const mintResponse = await runChain(
			[csrf],
			createEchoTerminal(),
			buildTestRequest('/'),
			createTestContext(buildTestRequest('/'), mintState),
		)
		const setCookie = mintResponse.headers.get('set-cookie') ?? ''
		const cookieValue = setCookie.split(';')[0] ?? ''
		const token = mintState.csrf ?? ''

		const postRequest = buildTestRequest('/', {
			method: 'POST',
			headers: { 'x-csrf-token': token, cookie: cookieValue },
		})
		const terminal = createRecordingTerminal()
		const response = await runChain(
			[csrf],
			terminal.handler,
			postRequest,
			createTestContext(postRequest, {}),
		)
		expect(terminal.count).toBe(1)
		expect(response.status).toBe(200)
	})

	it('mutating happy path: field submission matches the cookie and is accepted', async () => {
		const csrf = createCSRF<CSRFState & SessionState>({ secret: TEST_SECRET })
		const mintState: CSRFState & SessionState = {}
		const mintResponse = await runChain(
			[csrf],
			createEchoTerminal(),
			buildTestRequest('/'),
			createTestContext(buildTestRequest('/'), mintState),
		)
		const setCookie = mintResponse.headers.get('set-cookie') ?? ''
		const cookieValue = setCookie.split(';')[0] ?? ''
		const token = mintState.csrf ?? ''

		const postRequest = buildTestRequest('/', {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie: cookieValue },
			body: JSON.stringify({ _csrf: token }),
		})
		const terminal = createRecordingTerminal()
		const response = await runChain(
			[csrf],
			terminal.handler,
			postRequest,
			createTestContext(postRequest, {}),
		)
		expect(terminal.count).toBe(1)
		expect(response.status).toBe(200)
	})

	it('a missing submitted token throws HTTPError 403', async () => {
		const csrf = createCSRF<CSRFState & SessionState>({ secret: TEST_SECRET })
		const request = buildTestRequest('/', { method: 'POST' })
		const context = createTestContext(request, {})
		await expect(csrf(request, context, async () => new Response())).rejects.toMatchObject({
			status: 403,
		})
	})

	it('a mismatched submitted token throws HTTPError 403', async () => {
		const csrf = createCSRF<CSRFState & SessionState>({ secret: TEST_SECRET })
		const mintResponse = await runChain(
			[csrf],
			createEchoTerminal(),
			buildTestRequest('/'),
			createTestContext(buildTestRequest('/'), {}),
		)
		const setCookie = mintResponse.headers.get('set-cookie') ?? ''
		const cookieValue = setCookie.split(';')[0] ?? ''
		const postRequest = buildTestRequest('/', {
			method: 'POST',
			headers: { 'x-csrf-token': 'wrong-value', cookie: cookieValue },
		})
		const context = createTestContext(postRequest, {})
		await expect(csrf(postRequest, context, async () => new Response())).rejects.toMatchObject({
			status: 403,
		})
	})

	it('SESSION-BOUND: a token minted under session A replayed under session B is rejected with 403; A-on-A is accepted', async () => {
		const csrf = createCSRF<CSRFState & SessionState>({ secret: TEST_SECRET })
		const sessionA: SessionInterface = buildSession('session-a')
		const sessionB: SessionInterface = buildSession('session-b')

		const mintStateA: CSRFState & SessionState = { session: sessionA }
		const mintResponseA = await runChain(
			[csrf],
			createEchoTerminal(),
			buildTestRequest('/'),
			createTestContext(buildTestRequest('/'), mintStateA),
		)
		const setCookieA = mintResponseA.headers.get('set-cookie') ?? ''
		const cookieValueA = setCookieA.split(';')[0] ?? ''
		const tokenA = mintStateA.csrf ?? ''

		const aOnARequest = buildTestRequest('/', {
			method: 'POST',
			headers: { 'x-csrf-token': tokenA, cookie: cookieValueA },
		})
		const aOnAState: CSRFState & SessionState = { session: sessionA }
		const aOnAContext = createTestContext(aOnARequest, aOnAState)
		const aOnATerminal = createRecordingTerminal()
		const aOnAResponse = await runChain([csrf], aOnATerminal.handler, aOnARequest, aOnAContext)
		expect(aOnAResponse.status).toBe(200)
		expect(aOnATerminal.count).toBe(1)

		const bOnARequest = buildTestRequest('/', {
			method: 'POST',
			headers: { 'x-csrf-token': tokenA, cookie: cookieValueA },
		})
		const bOnAState: CSRFState & SessionState = { session: sessionB }
		const bOnAContext = createTestContext(bOnARequest, bOnAState)
		await expect(csrf(bOnARequest, bOnAContext, async () => new Response())).rejects.toMatchObject({
			status: 403,
		})
	})

	it('sessionless fallback still works (no session on state)', async () => {
		const csrf = createCSRF<CSRFState & SessionState>({ secret: TEST_SECRET })
		const mintState: CSRFState & SessionState = {}
		const mintResponse = await runChain(
			[csrf],
			createEchoTerminal(),
			buildTestRequest('/'),
			createTestContext(buildTestRequest('/'), mintState),
		)
		const setCookie = mintResponse.headers.get('set-cookie') ?? ''
		const cookieValue = setCookie.split(';')[0] ?? ''
		const token = mintState.csrf ?? ''
		const postRequest = buildTestRequest('/', {
			method: 'POST',
			headers: { 'x-csrf-token': token, cookie: cookieValue },
		})
		const terminal = createRecordingTerminal()
		const response = await runChain(
			[csrf],
			terminal.handler,
			postRequest,
			createTestContext(postRequest, {}),
		)
		expect(terminal.count).toBe(1)
		expect(response.status).toBe(200)
	})

	it('auto-Secure: the double-submit cookie carries Secure when connection.encrypted is true, omits it when false', async () => {
		const csrf = createCSRF<CSRFState & SessionState>({ secret: TEST_SECRET })

		const secureResponse = await runChain(
			[csrf],
			createEchoTerminal(),
			buildTestRequest('/'),
			createTestContext(
				buildTestRequest('/'),
				{},
				{ connection: { ip: '203.0.113.1', encrypted: true } },
			),
		)
		expect(secureResponse.headers.get('set-cookie')).toContain('Secure')

		const plainResponse = await runChain(
			[csrf],
			createEchoTerminal(),
			buildTestRequest('/'),
			createTestContext(
				buildTestRequest('/'),
				{},
				{ connection: { ip: '203.0.113.1', encrypted: false } },
			),
		)
		expect(plainResponse.headers.get('set-cookie')).not.toContain('Secure')
	})
})

// ── createCSRF across a session rotation ──────────────────────────────────

describe('createCSRF session rotation', () => {
	it('an unsafe handler that rotates the session leaves a token for the new session on the same response', async () => {
		const transport = createTestTransport()
		const session = createSession<SessionInterface, CSRFState & SessionState>({ transport })
		const csrf = createCSRF<CSRFState & SessionState>({ secret: TEST_SECRET })
		const mintRequest = buildTestRequest('/')
		const mintState: CSRFState & SessionState = {}
		const mintResponse = await runChain(
			[session, csrf],
			createEchoTerminal(),
			mintRequest,
			createTestContext(mintRequest, mintState),
		)
		const sessionId = mintResponse.headers.get('x-test-session') ?? ''
		const cookieValue = (mintResponse.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
		const token = mintState.csrf ?? ''

		const loginRequest = buildTestRequest('/login', {
			method: 'POST',
			headers: { 'x-test-session': sessionId, 'x-csrf-token': token, cookie: cookieValue },
		})
		const loginState: CSRFState & SessionState = {}
		const loginResponse = await runChain(
			[session, csrf],
			async (_request, context) => {
				context.state.control?.regenerate()
				const successor = context.state.control?.successor?.id ?? ''
				return new Response(await signToken(successor, { secret: TEST_SECRET }))
			},
			loginRequest,
			createTestContext(loginRequest, loginState),
		)
		const rotatedId = loginResponse.headers.get('x-test-session') ?? ''
		expect(rotatedId).not.toBe('')
		expect(rotatedId).not.toBe(sessionId)
		const rotatedCookies = loginResponse.headers.getSetCookie()
		expect(rotatedCookies).toHaveLength(1)
		const rotatedCookie = (rotatedCookies[0] ?? '').split(';')[0] ?? ''
		expect(rotatedCookie).toMatch(/^csrf=./)
		const rotatedToken = await loginResponse.text()
		expect(loginState.csrf).toBe(rotatedToken)
		expect(await verifyToken(rotatedToken, TEST_SECRET)).toBe(rotatedId)

		const writeRequest = buildTestRequest('/', {
			method: 'POST',
			headers: { 'x-test-session': rotatedId, 'x-csrf-token': rotatedToken, cookie: rotatedCookie },
		})
		const terminal = createRecordingTerminal()
		const response = await runChain(
			[session, csrf],
			terminal.handler,
			writeRequest,
			createTestContext(writeRequest, {}),
		)
		expect(response.status).toBe(200)
		expect(terminal.count).toBe(1)
	})

	it('a safe handler that rotates the session mints for the new session, not the one it arrived with', async () => {
		const transport = createTestTransport()
		const session = createSession<SessionInterface, CSRFState & SessionState>({ transport })
		const csrf = createCSRF<CSRFState & SessionState>({ secret: TEST_SECRET })
		const mintRequest = buildTestRequest('/')
		const mintResponse = await runChain(
			[session, csrf],
			createEchoTerminal(),
			mintRequest,
			createTestContext(mintRequest, {}),
		)
		const sessionId = mintResponse.headers.get('x-test-session') ?? ''

		const rotateRequest = buildTestRequest('/', { headers: { 'x-test-session': sessionId } })
		const rotateState: CSRFState & SessionState = {}
		const rotateResponse = await runChain(
			[session, csrf],
			async (_request, context) => {
				context.state.control?.regenerate()
				return new Response(ECHO_MARKER)
			},
			rotateRequest,
			createTestContext(rotateRequest, rotateState),
		)
		const rotatedId = rotateResponse.headers.get('x-test-session') ?? ''
		expect(rotatedId).not.toBe('')
		expect(rotatedId).not.toBe(sessionId)
		const rotatedCookies = rotateResponse.headers.getSetCookie()
		expect(rotatedCookies).toHaveLength(1)
		const rotatedCookie = (rotatedCookies[0] ?? '').split(';')[0] ?? ''
		const rotatedToken = rotateState.csrf ?? ''
		expect(await verifyToken(rotatedToken, TEST_SECRET)).toBe(rotatedId)

		const writeRequest = buildTestRequest('/', {
			method: 'POST',
			headers: { 'x-test-session': rotatedId, 'x-csrf-token': rotatedToken, cookie: rotatedCookie },
		})
		const terminal = createRecordingTerminal()
		const response = await runChain(
			[session, csrf],
			terminal.handler,
			writeRequest,
			createTestContext(writeRequest, {}),
		)
		expect(response.status).toBe(200)
		expect(terminal.count).toBe(1)
	})

	it('a write with the token minted before the rotation is still refused, under the new session and the old', async () => {
		const transport = createTestTransport()
		const session = createSession<SessionInterface, CSRFState & SessionState>({ transport })
		const csrf = createCSRF<CSRFState & SessionState>({ secret: TEST_SECRET })
		const mintRequest = buildTestRequest('/')
		const mintState: CSRFState & SessionState = {}
		const mintResponse = await runChain(
			[session, csrf],
			createEchoTerminal(),
			mintRequest,
			createTestContext(mintRequest, mintState),
		)
		const sessionId = mintResponse.headers.get('x-test-session') ?? ''
		const cookieValue = (mintResponse.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
		const token = mintState.csrf ?? ''
		const loginRequest = buildTestRequest('/login', {
			method: 'POST',
			headers: { 'x-test-session': sessionId, 'x-csrf-token': token, cookie: cookieValue },
		})
		const loginState: CSRFState & SessionState = {}
		const loginResponse = await runChain(
			[session, csrf],
			async (_request, context) => {
				context.state.control?.regenerate()
				return new Response(ECHO_MARKER)
			},
			loginRequest,
			createTestContext(loginRequest, loginState),
		)
		const rotatedId = loginResponse.headers.get('x-test-session') ?? ''
		expect(rotatedId).not.toBe('')
		expect(rotatedId).not.toBe(sessionId)

		const newRequest = buildTestRequest('/', {
			method: 'POST',
			headers: { 'x-test-session': rotatedId, 'x-csrf-token': token, cookie: cookieValue },
		})
		await expect(
			runChain(
				[session, csrf],
				createEchoTerminal(),
				newRequest,
				createTestContext(newRequest, {}),
			),
		).rejects.toMatchObject({ status: 403, message: 'invalid csrf token' })

		const oldRequest = buildTestRequest('/', {
			method: 'POST',
			headers: { 'x-test-session': sessionId, 'x-csrf-token': token, cookie: cookieValue },
		})
		await expect(
			runChain(
				[session, csrf],
				createEchoTerminal(),
				oldRequest,
				createTestContext(oldRequest, {}),
			),
		).rejects.toMatchObject({ status: 403, message: 'invalid csrf token' })
	})

	it('an unsafe request that keeps its session writes no csrf cookie and stashes no token', async () => {
		const transport = createTestTransport()
		const session = createSession<SessionInterface, CSRFState & SessionState>({ transport })
		const csrf = createCSRF<CSRFState & SessionState>({ secret: TEST_SECRET })
		const mintRequest = buildTestRequest('/')
		const mintState: CSRFState & SessionState = {}
		const mintResponse = await runChain(
			[session, csrf],
			createEchoTerminal(),
			mintRequest,
			createTestContext(mintRequest, mintState),
		)
		const sessionId = mintResponse.headers.get('x-test-session') ?? ''
		const cookieValue = (mintResponse.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
		const token = mintState.csrf ?? ''

		const writeRequest = buildTestRequest('/', {
			method: 'POST',
			headers: { 'x-test-session': sessionId, 'x-csrf-token': token, cookie: cookieValue },
		})
		const writeState: CSRFState & SessionState = {}
		const terminal = createRecordingTerminal()
		const response = await runChain(
			[session, csrf],
			terminal.handler,
			writeRequest,
			createTestContext(writeRequest, writeState),
		)
		expect(response.status).toBe(200)
		expect(terminal.count).toBe(1)
		expect(response.headers.getSetCookie()).toEqual([])
		expect(writeState.csrf).toBeUndefined()
	})

	it('a handler that ends the session clears the csrf cookie instead of leaving one bound to the ended session', async () => {
		const transport = createTestTransport()
		const session = createSession<SessionInterface, CSRFState & SessionState>({ transport })
		const csrf = createCSRF<CSRFState & SessionState>({ secret: TEST_SECRET })
		const mintRequest = buildTestRequest('/')
		const mintState: CSRFState & SessionState = {}
		const mintResponse = await runChain(
			[session, csrf],
			createEchoTerminal(),
			mintRequest,
			createTestContext(mintRequest, mintState),
		)
		const sessionId = mintResponse.headers.get('x-test-session') ?? ''
		const cookieValue = (mintResponse.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
		const token = mintState.csrf ?? ''

		const logoutRequest = buildTestRequest('/logout', {
			method: 'POST',
			headers: { 'x-test-session': sessionId, 'x-csrf-token': token, cookie: cookieValue },
		})
		const logoutState: CSRFState & SessionState = {}
		const logoutResponse = await runChain(
			[session, csrf],
			async (_request, context) => {
				context.state.control?.destroy()
				return new Response(ECHO_MARKER)
			},
			logoutRequest,
			createTestContext(logoutRequest, logoutState),
		)
		expect(logoutResponse.headers.get('x-test-session')).toBeNull()
		const logoutCookies = logoutResponse.headers.getSetCookie()
		expect(logoutCookies).toHaveLength(1)
		expect(logoutCookies[0]).toMatch(/^csrf=;/)
		expect(logoutCookies[0]).toContain('Max-Age=0')
		expect(logoutCookies[0]).toContain('Path=/')
		expect(logoutState.csrf).toBeUndefined()

		const secondMintRequest = buildTestRequest('/')
		const secondMintResponse = await runChain(
			[session, csrf],
			createEchoTerminal(),
			secondMintRequest,
			createTestContext(secondMintRequest, {}),
		)
		const secondId = secondMintResponse.headers.get('x-test-session') ?? ''
		const endRequest = buildTestRequest('/', { headers: { 'x-test-session': secondId } })
		const endState: CSRFState & SessionState = {}
		const endResponse = await runChain(
			[session, csrf],
			async (_request, context) => {
				context.state.control?.destroy()
				return new Response(ECHO_MARKER)
			},
			endRequest,
			createTestContext(endRequest, endState),
		)
		const endCookies = endResponse.headers.getSetCookie()
		expect(endCookies).toHaveLength(1)
		expect(endCookies[0]).toMatch(/^csrf=;/)
		expect(endCookies[0]).toContain('Max-Age=0')
		expect(endState.csrf).toBeUndefined()
	})
})

// ── Composition (the canonical onion, end-to-end) ─────────────────────────

describe('composition', () => {
	it('error body compressed: boundary sits INSIDE compression, so a rendered error body is still compressible', async () => {
		const boundary = createBoundary({ expose: true })
		const compression = createCompression<Record<string, never>>({ threshold: 16 })
		const request = buildTestRequest('/', { headers: { 'accept-encoding': 'gzip' } })
		const context = createTestContext(request, {})
		const response = await runChain(
			[compression, boundary],
			async () => {
				throw new Error('x'.repeat(2048))
			},
			request,
			context,
		)
		expect(response.headers.get('content-encoding')).toBe('gzip')
	})

	it('304 passes through compression untouched (no double body work)', async () => {
		const etag = createETag<Record<string, never>>()
		const compression = createCompression<Record<string, never>>({ threshold: 16 })
		const first = await runChain(
			[compression, etag],
			async () =>
				new Response(compressibleBody(2048), { headers: { 'content-type': 'text/plain' } }),
			buildTestRequest('/'),
			createTestContext(buildTestRequest('/'), {}),
		)
		const known = first.headers.get('etag')
		const request = buildTestRequest('/', {
			headers: { 'if-none-match': known ?? '', 'accept-encoding': 'gzip' },
		})
		const response = await runChain(
			[compression, etag],
			async () =>
				new Response(compressibleBody(2048), { headers: { 'content-type': 'text/plain' } }),
			request,
			createTestContext(request, {}),
		)
		expect(response.status).toBe(304)
		expect(response.headers.has('content-encoding')).toBe(false)
	})

	it('ETag hash is stable when computed inner-of-compression (etag mounted inside compression)', async () => {
		const etag = createETag<Record<string, never>>()
		const compression = createCompression<Record<string, never>>({ threshold: 16 })
		const request = buildTestRequest('/')
		const first = await runChain(
			[compression, etag],
			async () =>
				new Response(compressibleBody(2048), { headers: { 'content-type': 'text/plain' } }),
			request,
			createTestContext(request, {}),
		)
		const second = await runChain(
			[compression, etag],
			async () =>
				new Response(compressibleBody(2048), { headers: { 'content-type': 'text/plain' } }),
			request,
			createTestContext(request, {}),
		)
		expect(first.headers.get('etag')).toBe(second.headers.get('etag'))
	})

	it('preflight preempts the terminal in a full onion', async () => {
		const cors = createCors()
		const boundary = createBoundary()
		const terminal = createRecordingTerminal()
		const request = buildTestRequest('/', {
			method: 'OPTIONS',
			headers: { origin: 'https://app.example', 'access-control-request-method': 'GET' },
		})
		const response = await runChain(
			[boundary, cors],
			terminal.handler,
			request,
			createTestContext(request, {}),
		)
		expect(response.status).toBe(204)
		expect(terminal.count).toBe(0)
	})

	it('bearer -> limiter token-key idiom: the limiter keys off the bearer-stashed token', async () => {
		const clock = createManualClock()
		const token = await signToken('user-1', { secret: TEST_SECRET })
		const bearer = createBearer<BearerState & ClientState>({
			verify: (value) => verifyToken(value, TEST_SECRET),
		})
		const limiter = createLimiter<BearerState & ClientState>({
			max: 1,
			window: 1_000,
			clock: clock.clock,
		})
		const request = buildTestRequest('/', { headers: { authorization: `Bearer ${token}` } })
		const state: BearerState & ClientState = {}
		const context = createTestContext(request, state)
		const first = await runChain([bearer, limiter], createEchoTerminal(), request, context)
		const second = await runChain([bearer, limiter], createEchoTerminal(), request, context)
		expect(first.status).toBe(200)
		expect(second.status).toBe(429)
	})

	it('body -> csrf field read: csrf reads the field the body battery cached', async () => {
		const body = createBody<BodyState & CSRFState & SessionState>()
		const csrf = createCSRF<CSRFState & SessionState>({ secret: TEST_SECRET })
		const mintState: CSRFState & SessionState = {}
		const mintResponse = await runChain(
			[csrf],
			createEchoTerminal(),
			buildTestRequest('/'),
			createTestContext(buildTestRequest('/'), mintState),
		)
		const setCookie = mintResponse.headers.get('set-cookie') ?? ''
		const cookieValue = setCookie.split(';')[0] ?? ''
		const token = mintState.csrf ?? ''
		const postRequest = buildTestRequest('/', {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie: cookieValue },
			body: JSON.stringify({ _csrf: token }),
		})
		const terminal = createRecordingTerminal()
		const response = await runChain(
			[body, csrf],
			terminal.handler,
			postRequest,
			createTestContext(postRequest, {}),
		)
		expect(terminal.count).toBe(1)
		expect(response.status).toBe(200)
	})

	it('session -> csrf binding: the csrf battery binds to the session resolved upstream', async () => {
		const transport = createTestTransport()
		const session = createSession<SessionInterface, CSRFState & SessionState>({ transport })
		const csrf = createCSRF<CSRFState & SessionState>({ secret: TEST_SECRET })

		const mintRequest = buildTestRequest('/')
		const mintState: CSRFState & SessionState = {}
		const mintResponse = await runChain(
			[session, csrf],
			createEchoTerminal(),
			mintRequest,
			createTestContext(mintRequest, mintState),
		)
		const sessionId = mintResponse.headers.get('x-test-session')
		expect(sessionId).not.toBeNull()
		const setCookie = mintResponse.headers.get('set-cookie') ?? ''
		const cookieValue = setCookie.split(';')[0] ?? ''
		const token = mintState.csrf ?? ''

		const postRequest = buildTestRequest('/', {
			method: 'POST',
			headers: { 'x-test-session': sessionId ?? '', 'x-csrf-token': token, cookie: cookieValue },
		})
		const terminal = createRecordingTerminal()
		const response = await runChain(
			[session, csrf],
			terminal.handler,
			postRequest,
			createTestContext(postRequest, {}),
		)
		expect(terminal.count).toBe(1)
		expect(response.status).toBe(200)
	})
})

// ── createCookieTransport / createHeaderTransport (from factories.ts, exercised indirectly earlier in this file; direct smoke) ──

describe('transports', () => {
	it('createHeaderTransport reads/writes/clears the configured header', async () => {
		const transport = createHeaderTransport({ header: 'x-session' })
		const request = buildTestRequest('/', { headers: { 'x-session': 'abc' } })
		expect(await transport.read(request)).toBe('abc')
		const response = new Response()
		transport.write(response, 'xyz', false)
		expect(response.headers.get('x-session')).toBe('xyz')
		transport.clear(response)
		expect(response.headers.has('x-session')).toBe(false)
	})

	it('createCookieTransport signs and reads back a session id through a real cookie round-trip', async () => {
		const transport = createCookieTransport({ secret: TEST_SECRET })
		const response = new Response()
		await transport.write(response, 'session-id-1', false)
		const setCookie = response.headers.get('set-cookie') ?? ''
		const cookieValue = setCookie.split(';')[0] ?? ''
		const request = buildTestRequest('/', { headers: { cookie: cookieValue } })
		expect(await transport.read(request)).toBe('session-id-1')
	})
})

// ── only / except ────────────────────────────────────────────────────────

describe('only', () => {
	it('runs the handler when the pathname matches a single string', async () => {
		const scoped = only('/admin', createEchoTerminal())
		const response = await runChain(
			[scoped],
			async () => new Response('unreached'),
			buildTestRequest('/admin'),
			createTestContext(buildTestRequest('/admin'), {}),
		)
		expect(await response.text()).toBe(ECHO_MARKER)
	})

	it('skips (next()) when the pathname does not match a single string', async () => {
		const scoped = only('/admin', createEchoTerminal())
		const response = await runChain(
			[scoped],
			async () => new Response('reached'),
			buildTestRequest('/other'),
			createTestContext(buildTestRequest('/other'), {}),
		)
		expect(await response.text()).toBe('reached')
	})

	it('runs the handler when the pathname matches any entry in an array', async () => {
		const scoped = only(['/a', '/b'], createEchoTerminal())
		const response = await runChain(
			[scoped],
			async () => new Response('unreached'),
			buildTestRequest('/b'),
			createTestContext(buildTestRequest('/b'), {}),
		)
		expect(await response.text()).toBe(ECHO_MARKER)
	})

	it('skips when the pathname matches no entry in an array', async () => {
		const scoped = only(['/a', '/b'], createEchoTerminal())
		const response = await runChain(
			[scoped],
			async () => new Response('reached'),
			buildTestRequest('/c'),
			createTestContext(buildTestRequest('/c'), {}),
		)
		expect(await response.text()).toBe('reached')
	})

	it('runs the handler on the trailing-slash form of a pattern, as the router dispatches it', async () => {
		const scoped = only('/admin', createEchoTerminal())
		const response = await runChain(
			[scoped],
			async () => new Response('reached'),
			buildTestRequest('/admin/'),
			createTestContext(buildTestRequest('/admin/'), {}),
		)
		expect(await response.text()).toBe(ECHO_MARKER)
	})

	it('runs the handler on the bare form of a pattern written with a trailing slash', async () => {
		const scoped = only('/admin/', createEchoTerminal())
		const response = await runChain(
			[scoped],
			async () => new Response('reached'),
			buildTestRequest('/admin'),
			createTestContext(buildTestRequest('/admin'), {}),
		)
		expect(await response.text()).toBe(ECHO_MARKER)
	})

	it('skips the paths beneath a literal pattern and a case variant of it', async () => {
		const scoped = only('/admin', createEchoTerminal())
		const beneath = await runChain(
			[scoped],
			async () => new Response('reached'),
			buildTestRequest('/admin/users'),
			createTestContext(buildTestRequest('/admin/users'), {}),
		)
		const folded = await runChain(
			[scoped],
			async () => new Response('reached'),
			buildTestRequest('/Admin'),
			createTestContext(buildTestRequest('/Admin'), {}),
		)
		expect(await beneath.text()).toBe('reached')
		expect(await folded.text()).toBe('reached')
	})

	it('runs the handler on every path a param or a wildcard pattern matches', async () => {
		const scoped = only(['/users/:id', '/admin/*rest'], createEchoTerminal())
		const paths = ['/users/7', '/users/7/', '/admin/users', '/admin/users/7/']
		const texts = await Promise.all(
			paths.map(async (path) => {
				const response = await runChain(
					[scoped],
					async () => new Response('reached'),
					buildTestRequest(path),
					createTestContext(buildTestRequest(path), {}),
				)
				return response.text()
			}),
		)
		expect(texts).toEqual([ECHO_MARKER, ECHO_MARKER, ECHO_MARKER, ECHO_MARKER])
	})

	it('skips the paths a param or a wildcard pattern does not match', async () => {
		const scoped = only(['/users/:id', '/admin/*rest'], createEchoTerminal())
		const paths = ['/users', '/users/7/posts', '/admin', '/admin/']
		const texts = await Promise.all(
			paths.map(async (path) => {
				const response = await runChain(
					[scoped],
					async () => new Response('reached'),
					buildTestRequest(path),
					createTestContext(buildTestRequest(path), {}),
				)
				return response.text()
			}),
		)
		expect(texts).toEqual(['reached', 'reached', 'reached', 'reached'])
	})

	it('refuses a wildcard segment that is not the final segment at construction', () => {
		expect(() => only('/files/*rest/edit', createEchoTerminal())).toThrow(ContractError)
		expect(() => only(['/a', '/files/*rest/edit'], createEchoTerminal())).toThrow(ContractError)
	})
})

describe('except', () => {
	it('skips (next()) when the pathname matches a single string', async () => {
		const scoped = except('/health', createEchoTerminal())
		const response = await runChain(
			[scoped],
			async () => new Response('reached'),
			buildTestRequest('/health'),
			createTestContext(buildTestRequest('/health'), {}),
		)
		expect(await response.text()).toBe('reached')
	})

	it('runs the handler when the pathname does not match a single string', async () => {
		const scoped = except('/health', createEchoTerminal())
		const response = await runChain(
			[scoped],
			async () => new Response('unreached'),
			buildTestRequest('/other'),
			createTestContext(buildTestRequest('/other'), {}),
		)
		expect(await response.text()).toBe(ECHO_MARKER)
	})

	it('skips when the pathname matches any entry in an array', async () => {
		const scoped = except(['/a', '/b'], createEchoTerminal())
		const response = await runChain(
			[scoped],
			async () => new Response('reached'),
			buildTestRequest('/a'),
			createTestContext(buildTestRequest('/a'), {}),
		)
		expect(await response.text()).toBe('reached')
	})

	it('runs the handler when the pathname matches no entry in an array', async () => {
		const scoped = except(['/a', '/b'], createEchoTerminal())
		const response = await runChain(
			[scoped],
			async () => new Response('unreached'),
			buildTestRequest('/c'),
			createTestContext(buildTestRequest('/c'), {}),
		)
		expect(await response.text()).toBe(ECHO_MARKER)
	})

	it('skips the trailing-slash form of a pattern, as the router dispatches it', async () => {
		const scoped = except('/health', createEchoTerminal())
		const response = await runChain(
			[scoped],
			async () => new Response('reached'),
			buildTestRequest('/health/'),
			createTestContext(buildTestRequest('/health/'), {}),
		)
		expect(await response.text()).toBe('reached')
	})

	it('runs the handler on the paths beneath a literal pattern', async () => {
		const scoped = except('/health', createEchoTerminal())
		const response = await runChain(
			[scoped],
			async () => new Response('unreached'),
			buildTestRequest('/health/deep'),
			createTestContext(buildTestRequest('/health/deep'), {}),
		)
		expect(await response.text()).toBe(ECHO_MARKER)
	})

	it('skips every path a param pattern matches', async () => {
		const scoped = except('/files/:name', createEchoTerminal())
		const response = await runChain(
			[scoped],
			async () => new Response('reached'),
			buildTestRequest('/files/report.txt'),
			createTestContext(buildTestRequest('/files/report.txt'), {}),
		)
		expect(await response.text()).toBe('reached')
	})

	it('refuses a wildcard segment that is not the final segment at construction', () => {
		expect(() => except('/files/*rest/edit', createEchoTerminal())).toThrow(ContractError)
	})
})
