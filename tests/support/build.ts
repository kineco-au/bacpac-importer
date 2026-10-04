/**
 * Builds a .bacpac from a description, for tests. The encoding here is written
 * independently of the decoder, from the framing rules, so the two check each other.
 */
import { deflateRawSync } from 'node:zlib'

export interface TestColumn {
  name: string
  type: string
  length?: number
  isMax?: boolean
  precision?: number
  scale?: number
  nullable?: boolean
  identity?: boolean
  default?: string
}

export interface TestTable {
  schema?: string
  name: string
  columns: TestColumn[]
  primaryKey?: string[]
  uniqueConstraints?: Array<{ name: string; columns: string[] }>
  indexes?: Array<{ name: string; unique?: boolean; columns: string[] }>
  foreignKeys?: Array<{
    name: string
    columns: string[]
    table: string
    foreignColumns: string[]
    onDelete?: ReferentialAction
    onUpdate?: ReferentialAction
  }>
  /** Encoded rows, one buffer per data file. */
  data?: Buffer[]
}

const le = (value: number | bigint, bytes: number): Buffer => {
  const out = Buffer.alloc(bytes)
  let v = BigInt.asUintN(bytes * 8, BigInt(value))
  for (let i = 0; i < bytes; i++) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}

const prefix = (bytes: 1 | 2 | 4 | 8, body: Buffer | null): Buffer =>
  body === null ? Buffer.alloc(bytes, 0xff) : Buffer.concat([le(body.length, bytes), body])

const DAY = 86_400_000
/** Days from 0001-01-01 to 1970-01-01, which is where SQL Server counts dates from. */
const DAYS_TO_UNIX = 719_162
/** Bytes SQL Server spends on the time part at a given fractional scale. */
const timeBytes = (scale: number) => (scale <= 2 ? 3 : scale <= 4 ? 4 : 5)

/** `05:06:07.1234567` at scale 7 → units of 10⁻⁷ seconds since midnight. */
function timeUnits(time: string, scale: number): bigint {
  const [clock = '', fraction = ''] = time.split('.')
  const [hours = '0', minutes = '0', seconds = '0'] = clock.split(':')
  const digits = fraction.padEnd(scale, '0').slice(0, scale)
  return (
    (BigInt(hours) * 3600n + BigInt(minutes) * 60n + BigInt(seconds)) * 10n ** BigInt(scale) +
    BigInt(digits || '0')
  )
}

const midnight = (date: string) => Date.parse(`${date}T00:00:00Z`)

/** The field encoders, by framing. */
export const field = {
  raw: (value: number | bigint, bytes: number) => le(value, bytes),
  nullable: (value: number | bigint | null, bytes: number) =>
    prefix(1, value === null ? null : le(value, bytes)),
  bit: (value: boolean | null) => prefix(1, value === null ? null : Buffer.from([value ? 1 : 0])),
  guid: (text: string | null) => {
    if (text === null) return prefix(1, null)
    const hex = Buffer.from(text.replaceAll('-', ''), 'hex')
    const out = Buffer.from(hex)
    hex.subarray(0, 4).reverse().copy(out, 0)
    Buffer.from(hex.subarray(4, 6)).reverse().copy(out, 4)
    Buffer.from(hex.subarray(6, 8)).reverse().copy(out, 6)
    return prefix(1, out)
  },
  nvarchar: (text: string | null) => prefix(2, text === null ? null : Buffer.from(text, 'utf16le')),
  varchar: (text: string | null) => prefix(2, text === null ? null : Buffer.from(text, 'latin1')),
  varbinary: (bytes: number[] | null) => prefix(2, bytes === null ? null : Buffer.from(bytes)),
  ntext: (text: string | null) => prefix(4, text === null ? null : Buffer.from(text, 'utf16le')),
  nvarcharMax: (text: string | null) =>
    prefix(8, text === null ? null : Buffer.from(text, 'utf16le')),
  varbinaryMax: (bytes: number[] | null) => prefix(8, bytes === null ? null : Buffer.from(bytes)),
  /** `datetime`: days since 1900, then 1/300ths of a second. */
  datetime: (iso: string) => {
    const ms = Date.parse(`${iso}Z`) - Date.UTC(1900, 0, 1)
    const days = Math.floor(ms / 86_400_000)
    return Buffer.concat([le(days, 4), le(Math.round(((ms - days * 86_400_000) * 3) / 10), 4)])
  },
  /** `decimal`: a sign byte, then the unscaled magnitude little-endian. */
  decimal: (digits: string | null, bytes = 8) => {
    if (digits === null) return prefix(1, null)
    const negative = digits.startsWith('-')
    const magnitude = BigInt(digits.replace('-', '').replace('.', ''))
    return prefix(1, Buffer.concat([Buffer.from([negative ? 0 : 1]), le(magnitude, bytes)]))
  },
  /** `date`: days since 0001-01-01. */
  date: (iso: string) => prefix(1, le(midnight(iso) / DAY + DAYS_TO_UNIX, 3)),
  /** `time(scale)`: units of 10⁻ˢᶜᵃˡᵉ seconds since midnight. */
  time: (text: string, scale = 7) => prefix(1, le(timeUnits(text, scale), timeBytes(scale))),
  /** `datetime2(scale)`: the time units, then the day. */
  datetime2: (iso: string, scale = 7) => {
    const [date = '', time = ''] = iso.split('T')
    return prefix(
      1,
      Buffer.concat([
        le(timeUnits(time, scale), timeBytes(scale)),
        le(midnight(date) / DAY + DAYS_TO_UNIX, 3),
      ]),
    )
  },
  /**
   * `datetimeoffset(scale)`: the instant in UTC, then the offset it was written
   * with. `local` is the wall-clock time in that offset, which is what a reader
   * sees back.
   */
  datetimeoffset: (local: string, offsetMinutes: number, scale = 7) => {
    const [date = '', time = ''] = local.split('T')
    const per = 10n ** BigInt(scale)
    const perDay = 86_400n * per
    const utc =
      BigInt(midnight(date) / 1000) * per +
      timeUnits(time, scale) -
      BigInt(offsetMinutes) * 60n * per
    return prefix(
      1,
      Buffer.concat([
        le(utc % perDay, timeBytes(scale)),
        le(utc / perDay + BigInt(DAYS_TO_UNIX), 3),
        le(offsetMinutes, 2),
      ]),
    )
  },
  prefixed1: (body: Buffer | null) => prefix(1, body),
}

export type ReferentialAction = 'CASCADE' | 'SET NULL' | 'SET DEFAULT'

/** The codes `model.xml` uses for a foreign key's actions. */
const ACTION_CODES: Record<ReferentialAction, string> = {
  CASCADE: '1',
  'SET NULL': '2',
  'SET DEFAULT': '3',
}

export const row = (...fields: Buffer[]): Buffer => Buffer.concat(fields)

const bracket = (name: string) => `[${name.replaceAll(']', ']]')}]`

function columnXml(table: string, column: TestColumn): string {
  const properties = [
    column.nullable === false ? '<Property Name="IsNullable" Value="False" />' : '',
    column.identity ? '<Property Name="IsIdentity" Value="True" />' : '',
  ].join('')
  const specifier = [
    column.length !== undefined ? `<Property Name="Length" Value="${column.length}" />` : '',
    column.isMax ? '<Property Name="IsMax" Value="True" />' : '',
    column.precision !== undefined
      ? `<Property Name="Precision" Value="${column.precision}" />`
      : '',
    column.scale !== undefined ? `<Property Name="Scale" Value="${column.scale}" />` : '',
  ].join('')
  return `<Entry><Element Type="SqlSimpleColumn" Name="${table}.${bracket(column.name)}">${properties}
    <Relationship Name="TypeSpecifier"><Entry><Element Type="SqlTypeSpecifier">${specifier}
      <Relationship Name="Type"><Entry><References ExternalSource="BuiltIns" Name="[${column.type}]" /></Entry></Relationship>
    </Element></Entry></Relationship></Element></Entry>`
}

const refs = (names: string[]) =>
  names.map((n) => `<Entry><References Name="${n}" /></Entry>`).join('')

export function modelXml(
  tables: TestTable[],
  options: { caseSensitive?: boolean; extra?: string } = {},
): string {
  let body = `<Element Type="SqlDatabaseOptions"><Property Name="Collation" Value="SQL_Latin1_General_CP1_CI_AS" /></Element>`
  for (const table of tables) {
    const schema = table.schema ?? 'dbo'
    const name = `${bracket(schema)}.${bracket(table.name)}`
    body += `<Element Type="SqlTable" Name="${name}"><Relationship Name="Columns">${table.columns
      .map((column) => columnXml(name, column))
      .join('')}</Relationship></Element>`
    const specs = (columns: string[]) =>
      columns
        .map(
          (column) =>
            `<Entry><Element Type="SqlIndexedColumnSpecification"><Relationship Name="Column">${refs([`${name}.${bracket(column)}`])}</Relationship></Element></Entry>`,
        )
        .join('')
    if (table.primaryKey)
      body += `<Element Type="SqlPrimaryKeyConstraint" Name="${bracket(schema)}.${bracket(`PK_${table.name}`)}">
        <Relationship Name="ColumnSpecifications">${specs(table.primaryKey)}</Relationship>
        <Relationship Name="DefiningTable">${refs([name])}</Relationship></Element>`
    for (const unique of table.uniqueConstraints ?? [])
      body += `<Element Type="SqlUniqueConstraint" Name="${bracket(schema)}.${bracket(unique.name)}">
        <Relationship Name="ColumnSpecifications">${specs(unique.columns)}</Relationship>
        <Relationship Name="DefiningTable">${refs([name])}</Relationship></Element>`
    for (const index of table.indexes ?? [])
      body += `<Element Type="SqlIndex" Name="${name}.${bracket(index.name)}">${index.unique ? '<Property Name="IsUnique" Value="True" />' : ''}
        <Relationship Name="ColumnSpecifications">${specs(index.columns)}</Relationship>
        <Relationship Name="IndexedObject">${refs([name])}</Relationship></Element>`
    for (const foreign of table.foreignKeys ?? []) {
      const target = `${bracket(schema)}.${bracket(foreign.table)}`
      const actions = [
        foreign.onDelete
          ? `<Property Name="DeleteAction" Value="${ACTION_CODES[foreign.onDelete]}" />`
          : '',
        foreign.onUpdate
          ? `<Property Name="UpdateAction" Value="${ACTION_CODES[foreign.onUpdate]}" />`
          : '',
      ].join('')
      body += `<Element Type="SqlForeignKeyConstraint" Name="${bracket(schema)}.${bracket(foreign.name)}">${actions}
        <Relationship Name="Columns">${refs(foreign.columns.map((c) => `${name}.${bracket(c)}`))}</Relationship>
        <Relationship Name="DefiningTable">${refs([name])}</Relationship>
        <Relationship Name="ForeignColumns">${refs(foreign.foreignColumns.map((c) => `${target}.${bracket(c)}`))}</Relationship>
        <Relationship Name="ForeignTable">${refs([target])}</Relationship></Element>`
    }
    for (const column of table.columns) {
      if (column.default === undefined) continue
      body += `<Element Type="SqlDefaultConstraint" Name="${bracket(schema)}.${bracket(`DF_${table.name}_${column.name}`)}">
        <Property Name="DefaultExpressionScript"><Value><![CDATA[${column.default}]]></Value></Property>
        <Relationship Name="DefiningTable">${refs([name])}</Relationship>
        <Relationship Name="ForColumn">${refs([`${name}.${bracket(column.name)}`])}</Relationship></Element>`
    }
  }
  return `﻿<?xml version="1.0" encoding="utf-8"?>
<DataSchemaModel FileFormatVersion="1.2" SchemaVersion="3.5" CollationCaseSensitive="${options.caseSensitive ? 'True' : 'False'}" xmlns="http://schemas.microsoft.com/sqlserver/dac/Serialization/2012/02">
<Model>${body}${options.extra ?? ''}</Model></DataSchemaModel>`
}

export const originXml = (rows: number) => `﻿<?xml version="1.0" encoding="utf-8"?>
<DacOrigin xmlns="http://schemas.microsoft.com/sqlserver/dac/Serialization/2012/02">
  <Operation><Start>2024-01-02T03:04:05.0000000+00:00</Start></Operation>
  <Server><ServerVersion>Microsoft SQL Azure (RTM) - 12.0.2000.8
	Jan  1 2024</ServerVersion></Server>
  <ExportStatistics><TableRowCountTotalTag>${rows}</TableRowCountTotalTag></ExportStatistics>
</DacOrigin>`

/** A zip archive of the given files; `store` leaves them uncompressed. */
export function zip(files: Array<{ name: string; data: Buffer; store?: boolean }>): Buffer {
  const parts: Buffer[] = []
  const directory: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8')
    const body = file.store ? file.data : deflateRawSync(file.data)
    const crc = Bun.hash.crc32(file.data)
    const shared = Buffer.concat([
      le(file.store ? 0 : 8, 2),
      le(0, 4),
      le(crc, 4),
      le(body.length, 4),
      le(file.data.length, 4),
      le(name.length, 2),
    ])
    const local = Buffer.concat([le(0x04034b50, 4), le(20, 2), le(0, 2), shared, le(0, 2), name])
    directory.push(
      Buffer.concat([
        le(0x02014b50, 4),
        le(20, 2),
        le(20, 2),
        le(0, 2),
        shared,
        le(0, 2),
        le(0, 2),
        le(0, 2),
        le(0, 2),
        le(0, 4),
        le(offset, 4),
        name,
      ]),
    )
    parts.push(local, body)
    offset += local.length + body.length
  }
  const central = Buffer.concat(directory)
  return Buffer.concat([
    ...parts,
    central,
    le(0x06054b50, 4),
    le(0, 4),
    le(files.length, 2),
    le(files.length, 2),
    le(central.length, 4),
    le(offset, 4),
    le(0, 2),
  ])
}

export function bacpac(
  tables: TestTable[],
  options: { rows?: number; caseSensitive?: boolean; extra?: string } = {},
): Buffer {
  const files: Array<{ name: string; data: Buffer }> = [
    { name: 'model.xml', data: Buffer.from(modelXml(tables, options), 'utf8') },
    { name: 'Origin.xml', data: Buffer.from(originXml(options.rows ?? 0), 'utf8') },
  ]
  for (const table of tables) {
    ;(table.data ?? []).forEach((data, i) => {
      files.push({
        name: `Data/${table.schema ?? 'dbo'}.${table.name}/TableData-${String(i).padStart(3, '0')}-00000.BCP`,
        data,
      })
    })
  }
  return zip(files)
}

/** The sample database most tests share: two related tables covering the common types. */
export function sampleTables(): TestTable[] {
  return [
    {
      name: 'Author',
      columns: [
        { name: 'id', type: 'int', nullable: false, identity: true },
        { name: 'key', type: 'uniqueidentifier', nullable: false, default: '(newid())' },
        { name: 'name', type: 'nvarchar', length: 100, nullable: false },
        { name: 'active', type: 'bit', nullable: false, default: "('1')" },
        { name: 'created', type: 'datetime', nullable: false, default: '(getdate())' },
      ],
      primaryKey: ['id'],
      indexes: [{ name: 'IX_name', unique: true, columns: ['name'] }],
      data: [
        row(
          field.raw(1, 4),
          field.guid('916724a5-173d-4619-b97e-b9de133dd6f5'),
          field.nvarchar('Ada'),
          field.bit(true),
          field.datetime('2016-11-16T11:59:16.923'),
        ),
        row(
          field.raw(2, 4),
          field.guid('0f582a79-1e41-4cf0-bfa0-76340651891a'),
          field.nvarchar('Grace O’Néill'),
          field.bit(false),
          field.datetime('2023-12-14T20:49:34.023'),
        ),
      ],
    },
    {
      name: 'Post',
      columns: [
        { name: 'id', type: 'int', nullable: false, identity: true },
        { name: 'authorId', type: 'int', nullable: false },
        { name: 'title', type: 'nvarchar', length: 255 },
        { name: 'views', type: 'int', default: '((0))' },
        { name: 'body', type: 'ntext' },
        { name: 'size', type: 'bigint', nullable: false },
      ],
      primaryKey: ['id'],
      indexes: [{ name: 'IX_name', columns: ['title'] }],
      foreignKeys: [
        { name: 'FK_Post_Author', columns: ['authorId'], table: 'Author', foreignColumns: ['id'] },
      ],
      data: [
        Buffer.concat([
          row(
            field.raw(10, 4),
            field.raw(1, 4),
            field.nvarchar('Hello'),
            field.nullable(7, 4),
            field.ntext('line one\nline\ttwo \\ end'),
            field.raw(9_007_199_254_740_993n, 8),
          ),
          row(
            field.raw(11, 4),
            field.raw(2, 4),
            field.nvarchar(null),
            field.nullable(null, 4),
            field.ntext(null),
            field.raw(-1, 8),
          ),
        ]),
        row(
          field.raw(12, 4),
          field.raw(2, 4),
          field.nvarchar(''),
          field.nullable(0, 4),
          field.ntext(''),
          field.raw(0, 8),
        ),
      ],
    },
    { name: 'Empty', columns: [{ name: 'id', type: 'int', nullable: false }] },
  ]
}
