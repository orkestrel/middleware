import type { MultipartBody, MultipartErrorCode, MultipartFile, MultipartLimits } from './types.js'
import { randomUUID } from 'node:crypto'
import { chmod, mkdtemp, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDangerousKey } from '@orkestrel/server'
import {
	DEFAULT_CONTENT_TYPE,
	MULTIPART_MAX_HEADER_BLOCK,
	MULTIPART_MAX_PREAMBLE,
} from './constants.js'
import { MultipartError } from './errors.js'
import { Upload } from './Upload.js'
import { createUploadedFile } from './factories.js'
import { detectMIME, parsePartHeaders } from './helpers.js'

export class MultipartParser {
	static #defaultDirectory: Promise<string> | undefined
	readonly #reader: ReadableStreamDefaultReader<Uint8Array>
	readonly #signal: AbortSignal
	readonly #abort: () => void
	readonly #boundary: string
	readonly #limits: MultipartLimits
	readonly #allowed: readonly string[] | undefined
	readonly #directory: string
	readonly #staged: string[] = []
	readonly #files: Record<string, MultipartFile[]> = Object.create(null)
	readonly #fields: Record<string, string> = Object.create(null)
	#buffer: Buffer = Buffer.alloc(0)
	#ended = false
	#fileCount = 0
	#fieldCount = 0
	#totalBytes = 0

	constructor(
		stream: ReadableStream<Uint8Array>,
		signal: AbortSignal,
		boundary: string,
		limits: MultipartLimits,
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
			await this.#seekOpenMarker(Buffer.from(`--${this.#boundary}`))
			const delimiter = Buffer.from(`\r\n--${this.#boundary}`)

			for (;;) {
				while (this.#buffer.length < 2)
					if (!(await this.#pull()))
						throw new MultipartError('malformed', 'unterminated multipart boundary')
				if (this.#buffer[0] === 0x2d && this.#buffer[1] === 0x2d) break
				if (this.#buffer[0] !== 0x0d || this.#buffer[1] !== 0x0a)
					throw new MultipartError('malformed', 'malformed multipart boundary')
				this.#buffer = this.#buffer.subarray(2)

				const headerBlock = await this.#collect(
					Buffer.from('\r\n\r\n'),
					'unterminated multipart part headers',
					MULTIPART_MAX_HEADER_BLOCK,
					'malformed',
					'multipart header block too large',
				)
				const { name, filename, mime } = parsePartHeaders(headerBlock.toString('utf8'))
				if (name === undefined) throw new MultipartError('malformed', 'multipart part missing name')

				if (filename !== undefined) await this.#consumeFile(name, filename, mime, delimiter)
				else await this.#consumeField(name, delimiter)
			}
		} catch (error) {
			await this.#cleanup()
			await this.#reader.cancel().catch(() => {})
			throw error
		} finally {
			this.#signal.removeEventListener('abort', this.#abort)
			if (!this.#ended) await this.#reader.cancel().catch(() => {})
		}

		const files: Record<string, readonly MultipartFile[]> = Object.create(null)
		for (const [field, records] of Object.entries(this.#files))
			files[field] = Object.freeze([...records])
		const fields: Record<string, string> = Object.assign(Object.create(null), this.#fields)
		return {
			files: Object.freeze(files),
			fields: Object.freeze(fields),
		}
	}

	async #seekOpenMarker(marker: Buffer): Promise<void> {
		for (;;) {
			const index = this.#buffer.indexOf(marker)
			if (index !== -1) {
				if (this.#totalBytes - this.#buffer.length + index > MULTIPART_MAX_PREAMBLE)
					throw new MultipartError('malformed', 'multipart preamble too large')
				this.#buffer = this.#buffer.subarray(index + marker.length)
				return
			}
			const carry = marker.length - 1
			if (this.#buffer.length > carry) {
				if (this.#totalBytes - carry > MULTIPART_MAX_PREAMBLE)
					throw new MultipartError('malformed', 'multipart preamble too large')
				this.#buffer = this.#buffer.subarray(this.#buffer.length - carry)
			}
			if (!(await this.#pull())) throw new MultipartError('malformed', 'missing multipart boundary')
		}
	}

	// Streams one file part through its upload and keys its record onto the
	// parsed body.
	async #consumeFile(
		name: string,
		filename: string,
		mime: string | undefined,
		delimiter: Buffer,
	): Promise<void> {
		if (filename !== '') this.#countFile()
		const path = join(this.#directory, randomUUID())
		this.#staged.push(path)
		const upload = new Upload(path, this.#limits.file.size, this.#allowed)
		try {
			await this.#scan(delimiter, 'unterminated multipart file part', (chunk) =>
				upload.write(chunk),
			)
			if (filename === '' && upload.size === 0) {
				await this.#discard(path)
				return
			}
			if (filename === '') this.#countFile()
			await upload.stage()
		} finally {
			await upload.close()
		}
		if (isDangerousKey(name)) {
			await this.#discard(path)
			return
		}
		const detected = detectMIME(upload.head)
		const declared = mime ?? DEFAULT_CONTENT_TYPE
		const record = createUploadedFile({
			field: name,
			name: filename,
			size: upload.size,
			mime: detected ?? declared,
			validated: detected !== undefined && detected === declared,
			status: 'staged',
			path,
		})
		const existing = this.#files[name]
		if (existing === undefined) this.#files[name] = [record]
		else existing.push(record)
	}

	#countFile(): void {
		this.#fileCount += 1
		if (this.#fileCount > this.#limits.file.count)
			throw new MultipartError('limit', 'too many multipart files')
	}

	// Accumulates one text field part and keys it onto the parsed body.
	async #consumeField(name: string, delimiter: Buffer): Promise<void> {
		this.#fieldCount += 1
		if (this.#fieldCount > this.#limits.field.count)
			throw new MultipartError('limit', 'too many multipart fields')
		const value = await this.#collect(
			delimiter,
			'unterminated multipart field part',
			this.#limits.field.size,
			'limit',
			'multipart field exceeds size limit',
		)
		if (!isDangerousKey(name)) this.#fields[name] = value.toString('utf8')
	}

	async #collect(
		delimiter: Buffer,
		unterminated: string,
		limit: number,
		code: MultipartErrorCode,
		message: string,
	): Promise<Buffer> {
		const log: Array<{ readonly bytes: Buffer; readonly total: number }> = []
		await this.#scan(delimiter, unterminated, (chunk) => {
			const total = (log.at(-1)?.total ?? 0) + chunk.length
			if (total > limit) throw new MultipartError(code, message)
			log.push({ bytes: chunk, total })
		})
		return Buffer.concat(log.map((entry) => entry.bytes))
	}

	// Drains one part's bytes into `sink` up to `delimiter`, carrying back the
	// partial tail that could still be the delimiter's own prefix, and leaves
	// the buffer positioned past the delimiter.
	async #scan(
		delimiter: Buffer,
		unterminated: string,
		sink: (chunk: Buffer) => void | Promise<void>,
	): Promise<void> {
		for (;;) {
			const index = this.#buffer.indexOf(delimiter)
			if (index === -1) {
				const safeLength = Math.max(0, this.#buffer.length - (delimiter.length - 1))
				if (safeLength > 0) {
					await sink(this.#buffer.subarray(0, safeLength))
					this.#buffer = this.#buffer.subarray(safeLength)
				}
				if (!(await this.#pull())) throw new MultipartError('malformed', unterminated)
				continue
			}
			if (index > 0) await sink(this.#buffer.subarray(0, index))
			this.#buffer = this.#buffer.subarray(index + delimiter.length)
			return
		}
	}

	// Unlinks one staged temp file best-effort and drops it from the staged
	// roster, leaving the roster untouched when the path is not on it.
	async #discard(path: string): Promise<void> {
		try {
			await unlink(path)
		} catch {
			// Already gone — cleanup is best-effort.
		}
		const index = this.#staged.indexOf(path)
		if (index !== -1) this.#staged.splice(index, 1)
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
		const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength)
		this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk])
		return true
	}

	#wakeReader(): void {
		this.#reader.cancel().catch(() => {})
	}
}
