import { describe, expect, test } from 'bun:test'
import { parseIdentifier, parseModel, parseOrigin } from '../../src/schema.ts'
import { modelXml, originXml, sampleTables } from '../support/build.ts'

describe('parseIdentifier', () => {
  test('splits bracketed parts', () => {
    expect(parseIdentifier('[dbo].[cmsContent].[nodeId]')).toEqual(['dbo', 'cmsContent', 'nodeId'])
  })

  test('keeps dots and escaped brackets inside a part', () => {
    expect(parseIdentifier('[my.schema].[odd]]name]')).toEqual(['my.schema', 'odd]name'])
  })
})

describe('parseModel', () => {
  const database = parseModel(modelXml(sampleTables()).slice(1))

  test('reads tables and their columns in order', () => {
    expect(database.tables.map((t) => `${t.schema}.${t.name}`)).toEqual([
      'dbo.Author',
      'dbo.Post',
      'dbo.Empty',
    ])
    const author = database.tables[0]
    expect(author?.columns.map((c) => [c.name, c.type, c.nullable, c.identity])).toEqual([
      ['id', 'int', false, true],
      ['key', 'uniqueidentifier', false, false],
      ['name', 'nvarchar', false, false],
      ['active', 'bit', false, false],
      ['created', 'datetime', false, false],
    ])
    expect(author?.columns[2]?.length).toBe(100)
  })

  test('a column with no IsNullable property is nullable', () => {
    expect(database.tables[1]?.columns.find((c) => c.name === 'title')?.nullable).toBe(true)
  })

  test('attaches keys, indexes, foreign keys and defaults to their table', () => {
    const [author, post] = database.tables
    expect(author?.primaryKey).toEqual({ name: 'PK_Author', columns: ['id'] })
    expect(author?.indexes).toEqual([{ name: 'IX_name', unique: true, columns: ['name'] }])
    expect(post?.indexes[0]?.unique).toBe(false)
    expect(post?.foreignKeys).toEqual([
      {
        name: 'FK_Post_Author',
        columns: ['authorId'],
        foreignSchema: 'dbo',
        foreignTable: 'Author',
        foreignColumns: ['id'],
        onDelete: undefined,
        onUpdate: undefined,
      },
    ])
    expect(author?.columns.find((c) => c.name === 'key')?.defaultExpression).toBe('(newid())')
    expect(post?.columns.find((c) => c.name === 'views')?.defaultExpression).toBe('((0))')
  })

  test('reads collation and case sensitivity', () => {
    expect(database.collation).toBe('SQL_Latin1_General_CP1_CI_AS')
    expect(database.caseSensitive).toBe(false)
    expect(parseModel(modelXml([], { caseSensitive: true }).slice(1)).caseSensitive).toBe(true)
  })

  test('reports what it does not convert, and ignores security objects', () => {
    const extra = `<Element Type="SqlView" Name="[dbo].[v]" /><Element Type="SqlProcedure" Name="[dbo].[p]" /><Element Type="SqlUser" Name="[u]" />`
    expect(parseModel(modelXml([], { extra }).slice(1)).skipped).toEqual([
      { kind: 'SqlView', name: '[dbo].[v]' },
      { kind: 'SqlProcedure', name: '[dbo].[p]' },
    ])
  })

  test('reads max, precision and scale from the type specifier', () => {
    const [table] = parseModel(
      modelXml([
        {
          name: 't',
          columns: [
            { name: 'a', type: 'nvarchar', isMax: true },
            { name: 'b', type: 'decimal', precision: 38, scale: 6 },
          ],
        },
      ]).slice(1),
    ).tables
    expect(table?.columns[0]?.isMax).toBe(true)
    expect(table?.columns[1]).toMatchObject({ precision: 38, scale: 6 })
  })

  test('refuses a document that is not a model', () => {
    expect(() => parseModel('<nope/>')).toThrow('no DataSchemaModel')
  })
})

describe('parseOrigin', () => {
  test('reads the declared row count, the server and the export time', () => {
    expect(parseOrigin(originXml(42).slice(1))).toEqual({
      rowCount: 42,
      serverVersion: 'Microsoft SQL Azure (RTM) - 12.0.2000.8',
      exportedAt: '2024-01-02T03:04:05.0000000+00:00',
    })
  })
})
