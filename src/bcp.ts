/**
 * Decodes the row data files of a .bacpac.
 *
 * The files carry no types and no row markers: a row is its columns back to back,
 * and the schema is what makes it readable. How each column is framed depends on
 * its type —
 *
 * - fixed-width types (`int`, `datetime`, `float`…) are raw when NOT NULL and take a
 *   one-byte length when nullable, `0xFF` for null
 * - `bit`, `uniqueidentifier`, `decimal` and the `date`/`time` family always take
 *   the one-byte length
 * - `char`/`varchar`/`binary` types and their Unicode forms take a two-byte length,
 *   `0xFFFF` for null
 * - `text`, `ntext` and `image` take a four-byte length
 * - `(max)` types and `xml` take an eight-byte length
 */
import type { Column } from './schema.ts'

export type Value = null | number | bigint | boolean | string | Uint8Array
export type Row = Value[]

/** Thrown, as a singleton, when a row runs past the bytes read so far. */
export const NEED_MORE = Symbol('need more bytes')

export class UnsupportedTypeError extends Error {
  constructor(column: Column) {
    super(`column ${column.name} has type ${column.type}, which is not supported`)
    this.name = 'UnsupportedTypeError'
  }
}

export interface Cursor {
  buffer: Buffer
  position: number
  /** After NEED_MORE, the buffer length that would have satisfied the failed read. */
  want: number
}

type Decode = (buffer: Buffer, offset: number, length: number) => Value
type ReadColumn = (cursor: Cursor) => Value

const DAY = 86_400_000
const EPOCH_1900 = Date.UTC(1900, 0, 1)
/** Days from 0001-01-01 to 1970-01-01. */
const DAYS_TO_UNIX = 719_162

const pad = (value: number, width: number) => String(value).padStart(width, '0')

function isoDate(ms: number): string {
  const date = new Date(ms)
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}`
}

function isoTime(ms: number, fraction: string): string {
  const date = new Date(ms)
  const time = `${pad(date.getUTCHours(), 2)}:${pad(date.getUTCMinutes(), 2)}:${pad(date.getUTCSeconds(), 2)}`
  return fraction ? `${time}.${fraction}` : time
}

function readUIntLE(buffer: Buffer, offset: number, length: number): number {
  let value = 0
  for (let i = length - 1; i >= 0; i--) value = value * 256 + (buffer[offset + i] as number)
  return value
}

/** A count of 10^-scale seconds since midnight, as `HH:MM:SS.fff` and whole days carried. */
function scaledTime(units: number, scale: number): { text: string; seconds: number } {
  const perSecond = 10 ** scale
  const seconds = Math.floor(units / perSecond)
  const fraction = scale > 0 ? pad(units % perSecond, scale) : ''
  return { text: isoTime(seconds * 1000, fraction), seconds }
}

export function formatDecimal(magnitude: bigint, negative: boolean, scale: number): string {
  let digits = magnitude.toString()
  if (scale > 0) {
    digits = digits.padStart(scale + 1, '0')
    digits = `${digits.slice(0, -scale)}.${digits.slice(-scale)}`
  }
  return negative && magnitude !== 0n ? `-${digits}` : digits
}

function magnitudeLE(buffer: Buffer, offset: number, length: number): bigint {
  let value = 0n
  for (let i = length - 1; i >= 0; i--) value = (value << 8n) | BigInt(buffer[offset + i] as number)
  return value
}

/** `uniqueidentifier` bytes as canonical text: the first three groups are little-endian. */
const GUID_ORDER = [3, 2, 1, 0, -1, 5, 4, -1, 7, 6, -1, 8, 9, -1, 10, 11, 12, 13, 14, 15]

/** `uniqueidentifier` bytes as canonical text: the first three groups are little-endian. */
export function formatGuid(buffer: Buffer, offset: number): string {
  let out = ''
  for (const index of GUID_ORDER)
    out += index < 0 ? '-' : (buffer[offset + index] as number).toString(16).padStart(2, '0')
  return out
}

const utf16: Decode = (buffer, offset, length) =>
  buffer.toString('utf16le', offset, offset + length)
const bytes: Decode = (buffer, offset, length) =>
  new Uint8Array(buffer.subarray(offset, offset + length))

function singleByte(encoding: string): Decode {
  const decoder = new TextDecoder(encoding as ConstructorParameters<typeof TextDecoder>[0])
  return (buffer, offset, length) => decoder.decode(buffer.subarray(offset, offset + length))
}

function integer(buffer: Buffer, offset: number, length: number): Value {
  switch (length) {
    case 1:
      return buffer.readUInt8(offset)
    case 2:
      return buffer.readInt16LE(offset)
    case 4:
      return buffer.readInt32LE(offset)
    default:
      return buffer.readBigInt64LE(offset)
  }
}

const float: Decode = (buffer, offset, length) =>
  length === 4 ? buffer.readFloatLE(offset) : buffer.readDoubleLE(offset)

const datetime: Decode = (buffer, offset, length) => {
  if (length === 4) {
    const ms =
      EPOCH_1900 + buffer.readUInt16LE(offset) * DAY + buffer.readUInt16LE(offset + 2) * 60_000
    return `${isoDate(ms)}T${isoTime(ms, '')}`
  }
  // Days since 1900, then 1/300ths of a second since midnight.
  const days = buffer.readInt32LE(offset)
  const ms = Math.round((buffer.readUInt32LE(offset + 4) * 10) / 3)
  const at = EPOCH_1900 + days * DAY + ms
  return `${isoDate(at)}T${isoTime(at, pad(new Date(at).getUTCMilliseconds(), 3))}`
}

const money: Decode = (buffer, offset, length) => {
  const value =
    length === 4
      ? BigInt(buffer.readInt32LE(offset))
      : (BigInt(buffer.readInt32LE(offset)) << 32n) | BigInt(buffer.readUInt32LE(offset + 4))
  return formatDecimal(value < 0n ? -value : value, value < 0n, 4)
}

function decimal(column: Column): Decode {
  return (buffer, offset, length) => {
    // Either a full numeric struct (precision, scale, sign, 16 bytes) or sign then magnitude.
    if (length === 19) {
      const scale = buffer[offset + 1] as number
      return formatDecimal(magnitudeLE(buffer, offset + 3, 16), buffer[offset + 2] === 0, scale)
    }
    return formatDecimal(
      magnitudeLE(buffer, offset + 1, length - 1),
      buffer[offset] === 0,
      column.scale ?? 0,
    )
  }
}

const date: Decode = (buffer, offset) =>
  isoDate((readUIntLE(buffer, offset, 3) - DAYS_TO_UNIX) * DAY)

function time(column: Column): Decode {
  const scale = column.scale ?? 7
  return (buffer, offset, length) => scaledTime(readUIntLE(buffer, offset, length), scale).text
}

function datetime2(column: Column, withOffset: boolean): Decode {
  const scale = column.scale ?? 7
  return (buffer, offset, length) => {
    const timeLength = length - 3 - (withOffset ? 2 : 0)
    const { text, seconds } = scaledTime(readUIntLE(buffer, offset, timeLength), scale)
    const days = readUIntLE(buffer, offset + timeLength, 3) - DAYS_TO_UNIX
    if (!withOffset) return `${isoDate(days * DAY)}T${text}`

    // Stored in UTC; shown in the offset it was written with.
    const minutes = buffer.readInt16LE(offset + timeLength + 3)
    const local = days * DAY + seconds * 1000 + minutes * 60_000
    const fraction = text.includes('.') ? text.slice(text.indexOf('.') + 1) : ''
    const sign = minutes < 0 ? '-' : '+'
    const abs = Math.abs(minutes)
    return `${isoDate(local)}T${isoTime(local, fraction)}${sign}${pad(Math.floor(abs / 60), 2)}:${pad(abs % 60, 2)}`
  }
}

const FIXED_WIDTH: Record<string, number> = {
  tinyint: 1,
  smallint: 2,
  int: 4,
  bigint: 8,
  real: 4,
  float: 8,
  datetime: 8,
  smalldatetime: 4,
  money: 8,
  smallmoney: 4,
}

function need(cursor: Cursor, length: number): number {
  const at = cursor.position
  if (at + length > cursor.buffer.length) {
    cursor.want = at + length
    throw NEED_MORE
  }
  cursor.position = at + length
  return at
}

/** A fixed-width column: raw when NOT NULL, one-byte length when nullable. */
function fixed(width: number, nullable: boolean, decode: Decode): ReadColumn {
  if (!nullable) return (cursor) => decode(cursor.buffer, need(cursor, width), width)
  return prefixed(1, decode)
}

function prefixed(prefix: 1 | 2 | 4 | 8, decode: Decode): ReadColumn {
  return (cursor) => {
    const at = need(cursor, prefix)
    const buffer = cursor.buffer
    let length: number
    switch (prefix) {
      case 1:
        length = buffer.readUInt8(at)
        if (length === 0xff) return null
        break
      case 2:
        length = buffer.readUInt16LE(at)
        if (length === 0xffff) return null
        break
      case 4:
        length = buffer.readUInt32LE(at)
        if (length === 0xffffffff) return null
        break
      default: {
        const wide = buffer.readBigUInt64LE(at)
        if (wide === 0xffffffffffffffffn) return null
        if (wide > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('value length out of range')
        length = Number(wide)
      }
    }
    return decode(buffer, need(cursor, length), length)
  }
}

export interface DecodeOptions {
  /** The encoding of `char`, `varchar` and `text` values. Defaults to windows-1252. */
  encoding?: string
}

export function columnReader(column: Column, options: DecodeOptions = {}): ReadColumn {
  const type = column.type
  const width = FIXED_WIDTH[type]
  if (width !== undefined) {
    const decode =
      type === 'real' || type === 'float'
        ? float
        : type === 'datetime' || type === 'smalldatetime'
          ? datetime
          : type === 'money' || type === 'smallmoney'
            ? money
            : integer
    return fixed(width, column.nullable, decode)
  }

  const ansi = () => singleByte(options.encoding ?? 'windows-1252')
  switch (type) {
    case 'bit':
      return prefixed(1, (buffer, offset) => buffer[offset] !== 0)
    case 'uniqueidentifier':
      return prefixed(1, (buffer, offset) => formatGuid(buffer, offset))
    case 'decimal':
    case 'numeric':
      return prefixed(1, decimal(column))
    case 'date':
      return prefixed(1, date)
    case 'time':
      return prefixed(1, time(column))
    case 'datetime2':
      return prefixed(1, datetime2(column, false))
    case 'datetimeoffset':
      return prefixed(1, datetime2(column, true))
    case 'nchar':
    case 'nvarchar':
    case 'sysname':
      return prefixed(column.isMax ? 8 : 2, utf16)
    case 'char':
    case 'varchar':
      return prefixed(column.isMax ? 8 : 2, ansi())
    case 'binary':
    case 'varbinary':
    case 'timestamp':
    case 'rowversion':
      return prefixed(column.isMax ? 8 : 2, bytes)
    case 'ntext':
      return prefixed(4, utf16)
    case 'text':
      return prefixed(4, ansi())
    case 'image':
      return prefixed(4, bytes)
    case 'xml':
      return prefixed(8, utf16)
    default:
      throw new UnsupportedTypeError(column)
  }
}

/** Types whose framing has been confirmed against real exports, rather than taken from documentation. */
export const VERIFIED_TYPES = new Set([
  'int',
  'bigint',
  'bit',
  'uniqueidentifier',
  'datetime',
  'datetime2',
  'decimal',
  'numeric',
  'nvarchar',
  'ntext',
  'varbinary',
])

/** Compiles a table's columns into a function that reads one row at the cursor. */
export function rowReader(columns: Column[], options: DecodeOptions = {}): (cursor: Cursor) => Row {
  const readers = columns.map((column) => columnReader(column, options))
  const count = readers.length
  return (cursor) => {
    const row: Row = new Array(count)
    for (let i = 0; i < count; i++) row[i] = (readers[i] as ReadColumn)(cursor)
    return row
  }
}

/**
 * Rows from a stream of chunks, in batches. A row may straddle any number of
 * chunks; a stream that ends inside one is an error rather than a short table.
 */
export async function* decodeRows(
  chunks: AsyncIterable<Buffer>,
  columns: Column[],
  options: DecodeOptions & { batchSize?: number } = {},
): AsyncGenerator<Row[]> {
  const read = rowReader(columns, options)
  const batchSize = options.batchSize ?? 1000
  const cursor: Cursor = { buffer: Buffer.alloc(0), position: 0, want: 0 }
  let pending: Buffer[] = []
  let pendingLength = 0
  let want = 0
  let batch: Row[] = []

  for await (const chunk of chunks) {
    pending.push(chunk)
    pendingLength += chunk.length
    if (pendingLength < want) continue

    cursor.buffer = pending.length === 1 ? chunk : Buffer.concat(pending, pendingLength)
    cursor.position = 0
    let rowStart = 0
    try {
      while (cursor.position < cursor.buffer.length) {
        rowStart = cursor.position
        batch.push(read(cursor))
        rowStart = cursor.position
        if (batch.length >= batchSize) {
          yield batch
          batch = []
        }
      }
    } catch (error) {
      if (error !== NEED_MORE) throw error
      want = cursor.want - rowStart
    }
    const rest = cursor.buffer.subarray(rowStart)
    pending = rest.length > 0 ? [rest] : []
    pendingLength = rest.length
    if (rest.length === 0) want = 0
  }

  if (pendingLength > 0)
    throw new Error(`table data ends inside a row (${pendingLength} bytes left over)`)
  if (batch.length > 0) yield batch
}
