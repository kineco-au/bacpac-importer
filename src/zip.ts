/** A minimal streaming zip reader: the central directory, and one entry at a time as a stream. */
import { type FileHandle, open } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { createInflateRaw } from 'node:zlib'

export interface ZipEntry {
  name: string
  compressedSize: number
  size: number
  method: number
  headerOffset: number
}

const EOCD = 0x06054b50
const EOCD64_LOCATOR = 0x07064b50
const EOCD64 = 0x06064b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50
const MAX_COMMENT = 0xffff
const CHUNK = 1 << 18

const toNumber = (value: bigint, what: string): number => {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`zip ${what} is too large`)
  return Number(value)
}

export class ZipFile {
  readonly entries: ZipEntry[]
  readonly #handle: FileHandle

  private constructor(handle: FileHandle, entries: ZipEntry[]) {
    this.#handle = handle
    this.entries = entries
  }

  static async open(path: string): Promise<ZipFile> {
    const handle = await open(path, 'r')
    try {
      return new ZipFile(handle, await readDirectory(handle))
    } catch (error) {
      await handle.close()
      throw error
    }
  }

  entry(name: string): ZipEntry | undefined {
    return this.entries.find((entry) => entry.name === name)
  }

  /** The entry's bytes, decompressed, in chunks. */
  async *stream(entry: ZipEntry): AsyncGenerator<Buffer> {
    const local = Buffer.alloc(30)
    await this.#handle.read(local, 0, 30, entry.headerOffset)
    if (local.readUInt32LE(0) !== LOCAL) throw new Error(`zip entry ${entry.name} has no header`)
    const start = entry.headerOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28)
    if (entry.compressedSize === 0) return
    if (entry.method !== 0 && entry.method !== 8)
      throw new Error(`zip entry ${entry.name} uses unsupported compression ${entry.method}`)

    const handle = this.#handle
    const end = start + entry.compressedSize
    async function* raw(): AsyncGenerator<Buffer> {
      for (let at = start; at < end; ) {
        const chunk = Buffer.allocUnsafe(Math.min(CHUNK, end - at))
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, at)
        if (bytesRead === 0) throw new Error(`zip entry ${entry.name} is truncated`)
        at += bytesRead
        yield bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead)
      }
    }
    if (entry.method === 0) {
      yield* raw()
      return
    }
    const inflate = Readable.from(raw()).pipe(createInflateRaw())
    for await (const chunk of inflate) yield chunk as Buffer
  }

  async read(entry: ZipEntry): Promise<Buffer> {
    const chunks: Buffer[] = []
    for await (const chunk of this.stream(entry)) chunks.push(chunk)
    return Buffer.concat(chunks)
  }

  close(): Promise<void> {
    return this.#handle.close()
  }
}

async function readDirectory(handle: FileHandle): Promise<ZipEntry[]> {
  const { size } = await handle.stat()
  const tailLength = Math.min(size, MAX_COMMENT + 22 + 20)
  const tail = Buffer.alloc(tailLength)
  await handle.read(tail, 0, tailLength, size - tailLength)

  let at = -1
  for (let i = tailLength - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD) {
      at = i
      break
    }
  }
  if (at < 0) throw new Error('not a zip file: no end-of-central-directory record')

  let count = tail.readUInt16LE(at + 10)
  let directorySize = tail.readUInt32LE(at + 12)
  let directoryOffset = tail.readUInt32LE(at + 16)

  if (at >= 20 && tail.readUInt32LE(at - 20) === EOCD64_LOCATOR) {
    const recordOffset = toNumber(tail.readBigUInt64LE(at - 12), 'directory offset')
    const record = Buffer.alloc(56)
    await handle.read(record, 0, 56, recordOffset)
    if (record.readUInt32LE(0) !== EOCD64) throw new Error('corrupt zip64 directory record')
    count = toNumber(record.readBigUInt64LE(32), 'entry count')
    directorySize = toNumber(record.readBigUInt64LE(40), 'directory size')
    directoryOffset = toNumber(record.readBigUInt64LE(48), 'directory offset')
  }

  const directory = Buffer.alloc(directorySize)
  await handle.read(directory, 0, directorySize, directoryOffset)

  const entries: ZipEntry[] = []
  let p = 0
  for (let i = 0; i < count; i++) {
    if (directory.readUInt32LE(p) !== CENTRAL) throw new Error('corrupt zip central directory')
    const method = directory.readUInt16LE(p + 10)
    let compressedSize = directory.readUInt32LE(p + 20)
    let entrySize = directory.readUInt32LE(p + 24)
    const nameLength = directory.readUInt16LE(p + 28)
    const extraLength = directory.readUInt16LE(p + 30)
    const commentLength = directory.readUInt16LE(p + 32)
    let headerOffset = directory.readUInt32LE(p + 42)
    const name = directory.toString('utf8', p + 46, p + 46 + nameLength)

    // The zip64 extra field carries whichever of these overflowed, in this order.
    let e = p + 46 + nameLength
    const extraEnd = e + extraLength
    while (e + 4 <= extraEnd) {
      const id = directory.readUInt16LE(e)
      const length = directory.readUInt16LE(e + 2)
      if (id === 1) {
        let q = e + 4
        if (entrySize === 0xffffffff) {
          entrySize = toNumber(directory.readBigUInt64LE(q), 'entry size')
          q += 8
        }
        if (compressedSize === 0xffffffff) {
          compressedSize = toNumber(directory.readBigUInt64LE(q), 'entry size')
          q += 8
        }
        if (headerOffset === 0xffffffff)
          headerOffset = toNumber(directory.readBigUInt64LE(q), 'entry offset')
      }
      e += 4 + length
    }

    entries.push({
      name: name.replaceAll('\\', '/'),
      compressedSize,
      size: entrySize,
      method,
      headerOffset,
    })
    p = extraEnd + commentLength
  }
  return entries
}
