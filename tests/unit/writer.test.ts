import { describe, expect, test } from 'bun:test'
import type { Column } from '../../src/schema.ts'
import { defaultIsTrue, fitIdentifier, parseDefault, sourceType } from '../../src/writer.ts'

const column = (type: string, extra: Partial<Column> = {}): Column => ({
  name: 'c',
  type,
  isMax: false,
  nullable: true,
  identity: false,
  ...extra,
})

describe('parseDefault', () => {
  test('unwraps the parentheses SQL Server adds around literals', () => {
    expect(parseDefault('((0))')).toEqual({ kind: 'number', text: '0' })
    expect(parseDefault('((-1.5))')).toEqual({ kind: 'number', text: '-1.5' })
    expect(parseDefault("('it''s')")).toEqual({ kind: 'string', text: "it's" })
    expect(parseDefault("(N'x')")).toEqual({ kind: 'string', text: 'x' })
  })

  test('recognises the current time and a new GUID, however they are spelt', () => {
    for (const expression of ['(getdate())', '(GETUTCDATE())', '(sysdatetime())'])
      expect(parseDefault(expression)).toEqual({ kind: 'now' })
    expect(parseDefault('(NEWID())')).toEqual({ kind: 'newGuid' })
  })

  test('anything else is left for the writer to report', () => {
    expect(parseDefault('(dateadd(day,(1),getdate()))')).toBeUndefined()
    expect(parseDefault('([dbo].[fn]())')).toBeUndefined()
  })

  test('a bit default is true unless it is zero, quoted or not', () => {
    const truth = (expression: string) => defaultIsTrue(parseDefault(expression) as never)
    expect([truth("('1')"), truth('((1))'), truth("('0')"), truth('((0))')]).toEqual([
      true,
      true,
      false,
      false,
    ])
  })
})

describe('sourceType', () => {
  test('writes a type as SQL Server would declare it', () => {
    expect(sourceType(column('int'))).toBe('int')
    expect(sourceType(column('nvarchar', { length: 255 }))).toBe('nvarchar(255)')
    expect(sourceType(column('nvarchar', { isMax: true }))).toBe('nvarchar(max)')
    expect(sourceType(column('decimal', { precision: 38, scale: 6 }))).toBe('decimal(38,6)')
    expect(sourceType(column('datetime2', { scale: 3 }))).toBe('datetime2(3)')
  })
})

describe('fitIdentifier', () => {
  const long = 'a'.repeat(100)

  test('leaves a name the target can hold', () => {
    expect(fitIdentifier('short', 63)).toBe('short')
    expect(fitIdentifier('a'.repeat(63), 63)).toBe('a'.repeat(63))
  })

  test('cuts a longer one to the limit, the same way every time', () => {
    expect(Buffer.byteLength(fitIdentifier(long, 63))).toBe(63)
    expect(Buffer.byteLength(fitIdentifier(long, 64))).toBe(64)
    expect(fitIdentifier(long, 63)).toBe(fitIdentifier(long, 63))
  })

  test('keeps two long names apart, which truncation would not', () => {
    expect(fitIdentifier(`${long}_one`, 63)).not.toBe(fitIdentifier(`${long}_two`, 63))
  })

  test('counts bytes, not characters, so a multi-byte name still fits', () => {
    expect(Buffer.byteLength(fitIdentifier('é'.repeat(40), 63))).toBeLessThanOrEqual(63)
  })
})
