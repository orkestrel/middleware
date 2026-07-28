import type { MultipartBody, MultipartFile } from '@src/core'
import type { MultipartLimits } from './types.js'
import { randomUUID } from 'node:crypto'
import { chmod, mkdtemp, open, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDangerousKey } from '@orkestrel/server'
import {
	DEFAULT_CONTENT_TYPE,
	MULTIPART_MAX_HEADER_BLOCK,
	MULTIPART_MAX_PREAMBLE,
} from './constants.js'
import { MultipartError } from './errors.js'
import { createUploadedFile, detectMIME, parsePartHeaders } from './helpers.js'

export class MultipartParser {
	static #defaultDirectory: Promise<string> | undefined
	readonly #reader: ReadableStreamDefaultReader<Uint8Array>
	readonly #signal: AbortSignal
	readonly #abort: () => void
	readonly #boundary: string
	readonly #limits: Required<MultipartLimits>
	readonly #allowed: readonly string[] | undefined
	readonly #directory: string
	readonly #staged: string[] = []
	readonly #files: Record<string, MultipartFile[]> = Object.create(null)
	readonly #fields: Record<string, string> = Object.create(null)
	#buffer = Buffer.alloc(0)
	#ended = false
	#fileCount = 0
	#fieldCount = 0
	#totalBytes = 0

	constructor(
		stream: ReadableStream<Uint8Array>,
		signal: AbortSignal,
		boundary: string,
		limits: Required<MultipartLimits>,
		allowed: readonly string[] | undefined,
		directory: string,
	) {
		this.#reader = stream.getReader()
		this.#signal = signal
		this.#abort = this.#wakeReader.bind(this)
		this.#boundary = boundary
		this.#limits = limits
		this.#allowed = allowed
		this.#directory = directory
	}

	static directory(): Promise<string> {
		if (MultipartParser.#defaultDirectory === undefined)
			MultipartParser.#defaultDirectory = MultipartParser.#createDirectory()
		return MultipartParser.#defaultDirectory
	}

	async parse(): Promise<MultipartBody> {
		this.#signal.addEventListener('abort', this.#abort, { once: true })
		try {
			const openMarker = Buffer.from(`--${this.#boundary}`)
			let preambleScanned = 0
			let index = this.#buffer.indexOf(openMarker)
			while (index === -1) {
				const carry = openMarker.length - 1
				if (this.#buffer.length > carry) {
					const drop = this.#buffer.length - carry
					preambleScanned += drop
					if (preambleScanned > MULTIPART_MAX_PREAMBLE)
						throw new MultipartError('malformed', 'multipart preamble too large')
					this.#buffer = this.#buffer.subarray(drop)
				}
				if (!(await this.#pull()))
					throw new MultipartError('malformed', 'missing multipart boundary')
				index = this.#buffer.indexOf(openMarker)
			}
			if (preambleScanned + index > MULTIPART_MAX_PREAMBLE)
				throw new MultipartError('malformed', 'multipart preamble too large')
			this.#buffer = this.#buffer.subarray(index + openMarker.length)

			for (;;) {
				while (this.#buffer.length < 2)
					if (!(await this.#pull()))
						throw new MultipartError('malformed', 'unterminated multipart boundary')
				if (this.#buffer[0] === 0x2d && this.#buffer[1] === 0x2d) break
				if (this.#buffer[0] !== 0x0d || this.#buffer[1] !== 0x0a)
					throw new MultipartError('malformed', 'malformed multipart boundary')
				this.#buffer = this.#buffer.subarray(2)

				let headerEnd = this.#buffer.indexOf('\r\n\r\n')
				while (headerEnd === -1) {
					if (this.#buffer.length > MULTIPART_MAX_HEADER_BLOCK)
						throw new MultipartError('malformed', 'multipart header block too large')
					if (!(await this.#pull()))
						throw new MultipartError('malformed', 'unterminated multipart part headers')
					headerEnd = this.#buffer.indexOf('\r\n\r\n')
				}
				if (headerEnd > MULTIPART_MAX_HEADER_BLOCK)
					throw new MultipartError('malformed', 'multipart header block too large')
				const headerBlock = this.#buffer.subarray(0, headerEnd).toString('utf8')
				this.#buffer = this.#buffer.subarray(headerEnd + 4)
				const { name, filename, contentType } = parsePartHeaders(headerBlock)
				if (name === undefined) throw new MultipartError('malformed', 'multipart part missing name')

				const partDelimiter = Buffer.from(`\r\n--${this.#boundary}`)

				if (filename !== undefined) {
					if (filename !== '') {
						this.#fileCount += 1
						if (this.#fileCount > this.#limits.files)
							throw new MultipartError('limit', 'too many multipart files')
					}
					const path = join(this.#directory, randomUUID())
					this.#staged.push(path)
					const handle = await open(path, 'w', 0o600)
					let size = 0
					let head = Buffer.alloc(0)
					try {
						for (;;) {
							const boundaryIndex = this.#buffer.indexOf(partDelimiter)
							if (boundaryIndex === -1) {
								const safeLength = Math.max(0, this.#buffer.length - (partDelimiter.length - 1))
								if (safeLength > 0) {
									const chunk = this.#buffer.subarray(0, safeLength)
									size += chunk.length
									if (size > this.#limits.file)
										throw new MultipartError('limit', 'multipart file exceeds size limit')
									if (head.length < 16)
										head = Buffer.concat([head, chunk.subarray(0, 16 - head.length)])
									await handle.write(chunk)
									this.#buffer = this.#buffer.subarray(safeLength)
								}
								if (!(await this.#pull()))
									throw new MultipartError('malformed', 'unterminated multipart file part')
								continue
							}
							const chunk = this.#buffer.subarray(0, boundaryIndex)
							size += chunk.length
							if (size > this.#limits.file)
								throw new MultipartError('limit', 'multipart file exceeds size limit')
							if (head.length < 16)
								head = Buffer.concat([head, chunk.subarray(0, 16 - head.length)])
							await handle.write(chunk)
							this.#buffer = this.#buffer.subarray(boundaryIndex + 2)
							break
						}
					} finally {
						await handle.close()
					}
					if (filename === '' && size === 0) {
						await unlink(path)
						this.#staged.splice(this.#staged.indexOf(path), 1)
					} else {
						if (filename === '') {
							this.#fileCount += 1
							if (this.#fileCount > this.#limits.files)
								throw new MultipartError('limit', 'too many multipart files')
						}
						const detected = detectMIME(head)
						const declared = contentType ?? DEFAULT_CONTENT_TYPE
						const validated = detected !== undefined && detected === declared
						if (this.#allowed !== undefined) {
							const acceptable = detected !== undefined && this.#allowed.includes(detected)
							if (!acceptable)
								throw new MultipartError('rejected', 'multipart file failed type validation')
						}
						if (isDangerousKey(name)) {
							await unlink(path)
							this.#staged.splice(this.#staged.indexOf(path), 1)
						} else {
							const record = createUploadedFile({
								field: name,
								name: filename,
								size,
								mime: detected ?? declared,
								validated,
								status: 'staged',
								path,
							})
							const existing = this.#files[name]
							if (existing === undefined) this.#files[name] = [record]
							else existing.push(record)
						}
					}
				} else {
					this.#fieldCount += 1
					if (this.#fieldCount > this.#limits.fields)
						throw new MultipartError('limit', 'too many multipart fields')
					let value = Buffer.alloc(0)
					for (;;) {
						const boundaryIndex = this.#buffer.indexOf(partDelimiter)
						if (boundaryIndex === -1) {
							const safeLength = Math.max(0, this.#buffer.length - (partDelimiter.length - 1))
							if (safeLength > 0) {
								value = Buffer.concat([value, this.#buffer.subarray(0, safeLength)])
								if (value.length > this.#limits.field)
									throw new MultipartError('limit', 'multipart field exceeds size limit')
								this.#buffer = this.#buffer.subarray(safeLength)
							}
							if (!(await this.#pull()))
								throw new MultipartError('malformed', 'unterminated multipart field part')
							continue
						}
						value = Buffer.concat([value, this.#buffer.subarray(0, boundaryIndex)])
						if (value.length > this.#limits.field)
							throw new MultipartError('limit', 'multipart field exceeds size limit')
						this.#buffer = this.#buffer.subarray(boundaryIndex + 2)
						break
					}
					if (!isDangerousKey(name)) this.#fields[name] = value.toString('utf8')
				}

				while (this.#buffer.length < openMarker.length)
					if (!(await this.#pull()))
						throw new MultipartError('malformed', 'unterminated multipart boundary')
				this.#buffer = this.#buffer.subarray(openMarker.length)
			}
		} catch (error) {
			await this.#cleanup()
			await this.#reader.cancel().catch(() => {})
			throw error
		} finally {
			this.#signal.removeEventListener('abort', this.#abort)
			if (!this.#ended) await this.#reader.cancel().catch(() => {})
		}

		return {
			files: Object.freeze(this.#files),
			fields: Object.freeze(this.#fields),
		}
	}

	static async #createDirectory(): Promise<string> {
		const path = await mkdtemp(join(tmpdir(), 'orkestrel-multipart-'))
		await chmod(path, 0o700)
		return path
	}

	async #cleanup(): Promise<void> {
		for (const path of this.#staged) {
			try {
				await unlink(path)
			} catch {
				// Already gone — cleanup is best-effort.
			}
		}
	}

	async #pull(): Promise<boolean> {
		if (this.#signal.aborted) throw new MultipartError('malformed', 'request aborted mid-upload')
		if (this.#ended) return false
		const { done, value } = await this.#reader.read()
		if (this.#signal.aborted) throw new MultipartError('malformed', 'request aborted mid-upload')
		if (done) {
			this.#ended = true
			return false
		}
		this.#totalBytes += value.byteLength
		if (this.#totalBytes > this.#limits.total)
			throw new MultipartError('limit', 'multipart body exceeds total limit')
		this.#buffer = Buffer.concat([
			this.#buffer,
			Buffer.from(value.buffer, value.byteOffset, value.byteLength),
		])
		return true
	}

	#wakeReader(): void {
		this.#reader.cancel().catch(() => {})
	}
}
