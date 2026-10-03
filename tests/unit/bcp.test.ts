import { describe, expect, test } from 'bun:test'
import { decodeRows, formatDecimal, type Row, UnsupportedTypeError } from '../../src/bcp.ts'
import type { Column } from '../../src/schema.ts'
import { field, row } from '../support/build.ts'

const column = (type: string, extra: Partial<Column> = {}): Column => ({
  name: type,
  type,
  isMax: false,
  nullable: true,
  identity: false,
  ...extra,
})

async function* chunked(data: Buffer, size: number): AsyncGenerator<Buffer> {
  for (let p = 0; p < data.length; p += size) yield data.subarray(p, p + size)
}

async function decode(columns: Column[], data: Buffer, chunkSize = data.length || 1) {
  const rows: Row[] = []
  for await (const batch of decodeRows(chunked(data, chunkSize), columns)) rows.push(...batch)
  return rows
}

const one = async (col: Column, data: Buffer) => (await decode([col], data))[0]?.[0]

const le = (value: number | bigint, bytes: number) => field.raw(value, bytes)

describe('fixed-width types', () => {
  test('NOT NULL integers are raw', async () => {
    const columns = ['tinyint', 'smallint', 'int', 'bigint'].map((t) =>
      column(t, { nullable: false }),
    )
    const data = row(le(200, 1), le(-2, 2), le(-331, 4), le(-5n, 8))
    expect(await decode(columns, data)).toEqual([[200, -2, -331, -5n]])
  })

  test('nullable integers take a one-byte length, 0xFF for null', async () => {
    const columns = [column('int'), column('int'), column('bigint')]
    const data = row(field.nullable(7, 4), field.nullable(null, 4), field.nullable(2n ** 40n, 8))
    expect(await decode(columns, data)).toEqual([[7, null, 2n ** 40n]])
  })

  test('float and real', async () => {
    const double = Buffer.alloc(8)
    double.writeDoubleLE(1.5)
    const single = Buffer.alloc(4)
    single.writeFloatLE(0.25)
    expect(
      await decode(
        [column('float', { nullable: false }), column('real', { nullable: false })],
        row(double, single),
      ),
    ).toEqual([[1.5, 0.25]])
  })

  test('datetime is days since 1900 and 1/300ths of a second', async () => {
    const col = column('datetime', { nullable: false })
    expect(await one(col, field.datetime('2016-11-16T11:59:16.923'))).toBe(
      '2016-11-16T11:59:16.923',
    )
    expect(await one(col, row(le(0, 4), le(0, 4)))).toBe('1900-01-01T00:00:00.000')
    expect(await one(col, row(le(-1, 4), le(0, 4)))).toBe('1899-12-31T00:00:00.000')
  })

  test('smalldatetime is days and minutes', async () => {
    expect(await one(column('smalldatetime', { nullable: false }), row(le(1, 2), le(61, 2)))).toBe(
      '1900-01-02T01:01:00',
    )
  })

  test('money is a scaled 64-bit integer, high half first', async () => {
    expect(await one(column('money', { nullable: false }), row(le(0, 4), le(123456, 4)))).toBe(
      '12.3456',
    )
    expect(await one(column('money', { nullable: false }), row(le(-1, 4), le(-10000, 4)))).toBe(
      '-1.0000',
    )
    expect(await one(column('smallmoney', { nullable: false }), le(-5, 4))).toBe('-0.0005')
  })
})

describe('types that always take a length', () => {
  test('bit, even when NOT NULL', async () => {
    const col = column('bit', { nullable: false })
    expect(await decode([col, col], row(field.bit(true), field.bit(false)))).toEqual([
      [true, false],
    ])
    expect(await one(column('bit'), field.bit(null))).toBeNull()
  })

  test('uniqueidentifier, with its first three groups little-endian', async () => {
    // The bytes as they appear in a real export for Umbraco's data-type object type.
    const bytes = Buffer.from('1001a5a2307819db4da57bf7efed43ba3c', 'hex')
    expect(await one(column('uniqueidentifier', { nullable: false }), bytes)).toBe(
      '30a2a501-1978-4ddb-a57b-f7efed43ba3c',
    )
    expect(await one(column('uniqueidentifier'), field.guid(null))).toBeNull()
  })

  test('decimal as sign then magnitude', async () => {
    const col = column('decimal', { precision: 9, scale: 2 })
    expect(await one(col, field.prefixed1(row(le(1, 1), le(123456, 4))))).toBe('1234.56')
    expect(await one(col, field.prefixed1(row(le(0, 1), le(5, 4))))).toBe('-0.05')
    expect(await one(col, field.prefixed1(null))).toBeNull()
  })

  test('decimal as a full numeric struct', async () => {
    const struct = row(le(38, 1), le(6, 1), le(1, 1), le(1_000_001n, 16))
    expect(await one(column('decimal', { precision: 38, scale: 0 }), field.prefixed1(struct))).toBe(
      '1.000001',
    )
  })

  test('decimal keeps digits a double would lose', () => {
    expect(formatDecimal(12345678901234567890123456789n, false, 10)).toBe(
      '1234567890123456789.0123456789',
    )
    expect(formatDecimal(0n, true, 2)).toBe('0.00')
  })

  const days = 738_944 // 2024-02-29
  const units = 452_961_234_567 // 12:34:56.1234567 at scale 7

  test('date', async () => {
    expect(await one(column('date'), field.prefixed1(le(days, 3)))).toBe('2024-02-29')
    expect(await one(column('date'), field.prefixed1(le(0, 3)))).toBe('0001-01-01')
  })

  test('time at its scale', async () => {
    expect(await one(column('time', { scale: 7 }), field.prefixed1(le(units, 5)))).toBe(
      '12:34:56.1234567',
    )
    expect(await one(column('time', { scale: 0 }), field.prefixed1(le(45296, 3)))).toBe('12:34:56')
  })

  test('datetime2', async () => {
    expect(
      await one(column('datetime2', { scale: 7 }), field.prefixed1(row(le(units, 5), le(days, 3)))),
    ).toBe('2024-02-29T12:34:56.1234567')
  })

  test('datetimeoffset is stored in UTC and shown at its offset', async () => {
    const utc = (2 * 3600 + 34 * 60 + 56) * 1e7 + 1234567
    const body = row(le(utc, 5), le(days, 3), le(600, 2))
    expect(await one(column('datetimeoffset', { scale: 7 }), field.prefixed1(body))).toBe(
      '2024-02-29T12:34:56.1234567+10:00',
    )
  })
})

describe('variable-length types', () => {
  test('nvarchar takes a two-byte length even when NOT NULL', async () => {
    // The whole of a real export's umbracoLock row: id, value, name.
    const data = Buffer.from('b5feffffffffffff0e005300650072007600650072007300', 'hex')
    const columns = [
      column('int', { nullable: false }),
      column('int', { nullable: false }),
      column('nvarchar', { nullable: false, length: 64 }),
    ]
    expect(await decode(columns, data)).toEqual([[-331, -1, 'Servers']])
  })

  test('null, empty and non-ASCII strings', async () => {
    const col = column('nvarchar', { length: 50 })
    expect(
      await decode(
        [col, col, col],
        row(field.nvarchar(null), field.nvarchar(''), field.nvarchar('naïve 😀')),
      ),
    ).toEqual([[null, '', 'naïve 😀']])
  })

  test('varchar is decoded as windows-1252 unless told otherwise', async () => {
    const data = field.varbinary([0xe9, 0x80])
    expect(await one(column('varchar', { length: 10 }), data)).toBe('é€')
    const rows: Row[] = []
    for await (const batch of decodeRows(chunked(data, 9), [column('varchar')], {
      encoding: 'utf-8',
    }))
      rows.push(...batch)
    expect(rows[0]?.[0]).not.toBe('é€')
  })

  test('varbinary comes back as bytes', async () => {
    expect(await one(column('varbinary', { length: 8 }), field.varbinary([1, 2, 255]))).toEqual(
      new Uint8Array([1, 2, 255]),
    )
  })

  test('ntext takes a four-byte length', async () => {
    expect(
      await decode([column('ntext'), column('ntext')], row(field.ntext('xml'), field.ntext(null))),
    ).toEqual([['xml', null]])
  })

  test('max types take an eight-byte length', async () => {
    const col = column('nvarchar', { isMax: true })
    expect(
      await decode([col, col], row(field.nvarcharMax('big'), field.nvarcharMax(null))),
    ).toEqual([['big', null]])
  })
})

describe('decodeRows', () => {
  const columns = [
    column('int', { nullable: false }),
    column('nvarchar', { length: 50 }),
    column('uniqueidentifier'),
    column('ntext'),
  ]
  const expected: Row[] = [
    [1, 'first', '916724a5-173d-4619-b97e-b9de133dd6f5', 'a longer body of text'],
    [2, null, null, null],
    [3, '', '0f582a79-1e41-4cf0-bfa0-76340651891a', ''],
  ]
  const data = Buffer.concat(
    expected.map((r) =>
      row(
        le(r[0] as number, 4),
        field.nvarchar(r[1] as string | null),
        field.guid(r[2] as string | null),
        field.ntext(r[3] as string | null),
      ),
    ),
  )

  test('gives the same rows however the stream is chunked', async () => {
    for (let size = 1; size <= data.length; size++)
      expect(await decode(columns, data, size)).toEqual(expected)
  })

  test('yields batches of the requested size', async () => {
    const sizes: number[] = []
    for await (const batch of decodeRows(chunked(data, 16), columns, { batchSize: 2 }))
      sizes.push(batch.length)
    expect(sizes).toEqual([2, 1])
  })

  test('an empty stream is an empty table', async () => {
    expect(await decode(columns, Buffer.alloc(0))).toEqual([])
  })

  test('a stream that ends inside a row is an error, not a short table', async () => {
    expect(decode(columns, data.subarray(0, data.length - 3), 16)).rejects.toThrow(
      'ends inside a row',
    )
  })

  test('refuses a type it cannot decode, naming the column', () => {
    expect(decode([column('sql_variant')], Buffer.alloc(4))).rejects.toBeInstanceOf(
      UnsupportedTypeError,
    )
  })
})
