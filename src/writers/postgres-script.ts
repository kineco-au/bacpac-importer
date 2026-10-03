/** Writes a plain SQL script for Postgres: the schema, then `COPY` blocks, loadable with `psql`. */

import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createWriteStream, type WriteStream } from 'node:fs'
import type { Row, Value } from '../bcp.ts'
import type { Column, Database, Table } from '../schema.ts'
import { defaultIsTrue, parseDefault, type Writer } from '../writer.ts'

export interface PostgresScriptOptions {
  /** Put every table in this schema. By default each keeps its source schema. */
  schema?: string
  /** Leave foreign keys out, for a source whose data does not satisfy them. */
  skipForeignKeys?: boolean
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`

const MAX_IDENTIFIER_BYTES = 63

/**
 * Postgres truncates an identifier past 63 bytes, silently and so that two long
 * names can become one. A name that long is cut here instead, with a hash of the
 * whole of it, so it stays distinct and is the same on every run.
 */
export function fitIdentifier(name: string): string {
  if (Buffer.byteLength(name) <= MAX_IDENTIFIER_BYTES) return name
  const hash = createHash('sha1').update(name).digest('hex').slice(0, 8)
  let head = name
  while (Buffer.byteLength(head) > MAX_IDENTIFIER_BYTES - 9) head = head.slice(0, -1)
  return `${head}_${hash}`
}

/** A constraint or index name, shortened if Postgres would have truncated it. */
const named = (name: string) => quote(fitIdentifier(name))

const FIXED: Record<string, string> = {
  tinyint: 'smallint',
  smallint: 'smallint',
  int: 'integer',
  bigint: 'bigint',
  bit: 'boolean',
  real: 'real',
  float: 'double precision',
  money: 'numeric(19,4)',
  smallmoney: 'numeric(10,4)',
  uniqueidentifier: 'uuid',
  date: 'date',
  datetime: 'timestamp(3)',
  smalldatetime: 'timestamp(0)',
  ntext: 'text',
  text: 'text',
  xml: 'text',
  sysname: 'varchar(128)',
  binary: 'bytea',
  varbinary: 'bytea',
  image: 'bytea',
  timestamp: 'bytea',
  rowversion: 'bytea',
}

function renderDefault(column: Column): string | undefined {
  const value = parseDefault(column.defaultExpression ?? '')
  switch (value?.kind) {
    case 'number':
    case 'string':
      if (column.type === 'bit') return String(defaultIsTrue(value))
      return value.kind === 'number' ? value.text : `'${value.text.replaceAll("'", "''")}'`
    case 'now':
      return 'CURRENT_TIMESTAMP'
    case 'newGuid':
      return 'gen_random_uuid()'
    default:
      return undefined
  }
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'))
const NEEDS_ESCAPE = /[\\\n\r\t\0]/
const ESCAPES: Record<string, string> = { '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t' }

export class PostgresScriptWriter implements Writer {
  readonly target = 'postgres-script'
  readonly warnings: string[] = []
  readonly #path: string
  readonly #options: PostgresScriptOptions
  #out: WriteStream | undefined
  #tables: Table[] = []
  #strippedNul = new Set<string>()

  constructor(path: string, options: PostgresScriptOptions = {}) {
    this.#path = path
    this.#options = options
  }

  tableName(table: Table): string {
    return `${this.#options.schema ?? table.schema}.${table.name}`
  }

  #qualified(table: Table): string {
    return `${quote(this.#options.schema ?? table.schema)}.${quote(table.name)}`
  }

  columnType(column: Column): string {
    const scale = Math.min(column.scale ?? 6, 6)
    switch (column.type) {
      case 'decimal':
      case 'numeric':
        return `numeric(${column.precision ?? 18},${column.scale ?? 0})`
      case 'char':
      case 'nchar':
        return column.length ? `char(${column.length})` : 'text'
      case 'varchar':
      case 'nvarchar':
        return column.isMax || !column.length ? 'text' : `varchar(${column.length})`
      case 'time':
        return `time(${scale})`
      case 'datetime2':
        return `timestamp(${scale})`
      case 'datetimeoffset':
        return `timestamptz(${scale})`
      default:
        return FIXED[column.type] ?? 'text'
    }
  }

  async #write(text: string): Promise<void> {
    const out = this.#out
    if (!out) throw new Error('the Postgres script writer has not been started')
    if (!out.write(text)) await once(out, 'drain')
  }

  async begin(database: Database, tables: Table[]): Promise<void> {
    this.#tables = tables
    this.#out = createWriteStream(this.#path, { encoding: 'utf8' })
    if (!database.caseSensitive)
      this.warnings.push(
        'the source database compares text case-insensitively and Postgres does not; unique indexes and lookups on text are stricter about case than they were',
      )

    const schemas = new Set(tables.map((table) => this.#options.schema ?? table.schema))
    let sql = 'BEGIN;\n\n'
    for (const schema of schemas) sql += `CREATE SCHEMA IF NOT EXISTS ${quote(schema)};\n`
    for (const table of tables) sql += `\n${this.#createTable(table)}\n`
    await this.#write(sql)
  }

  #createTable(table: Table): string {
    const lines: string[] = []
    for (const column of table.columns) {
      let line = `${quote(column.name)} ${this.columnType(column)}`
      if (column.identity) line += ' GENERATED BY DEFAULT AS IDENTITY'
      if (!column.nullable) line += ' NOT NULL'
      if (column.defaultExpression !== undefined && !column.identity) {
        const translated = renderDefault(column)
        if (translated !== undefined) line += ` DEFAULT ${translated}`
        else
          this.warnings.push(
            `default ${column.defaultExpression} on ${table.name}.${column.name} was not translated`,
          )
      }
      lines.push(line)
    }
    if (table.primaryKey)
      lines.push(
        `CONSTRAINT ${named(table.primaryKey.name)} PRIMARY KEY (${table.primaryKey.columns.map(quote).join(', ')})`,
      )
    return `CREATE TABLE ${this.#qualified(table)} (\n  ${lines.join(',\n  ')}\n);`
  }

  async beginTable(table: Table): Promise<void> {
    await this.#write(
      `\nCOPY ${this.#qualified(table)} (${table.columns.map((c) => quote(c.name)).join(', ')}) FROM stdin;\n`,
    )
  }

  #field(value: Value, table: Table): string {
    if (value === null) return '\\N'
    switch (typeof value) {
      case 'string': {
        if (!NEEDS_ESCAPE.test(value)) return value
        let text = value
        if (text.includes('\0')) {
          // Postgres text cannot hold a NUL character.
          text = text.replaceAll('\0', '')
          this.#strippedNul.add(table.name)
        }
        return text.replace(/[\\\n\r\t]/g, (character) => ESCAPES[character] as string)
      }
      case 'boolean':
        return value ? 't' : 'f'
      case 'number':
      case 'bigint':
        return String(value)
      default: {
        let hex = '\\\\x'
        for (const byte of value) hex += HEX[byte]
        return hex
      }
    }
  }

  async writeRows(table: Table, rows: Row[]): Promise<void> {
    let text = ''
    for (const row of rows) {
      for (let i = 0; i < row.length; i++)
        text += (i === 0 ? '' : '\t') + this.#field(row[i] as Value, table)
      text += '\n'
    }
    await this.#write(text)
  }

  async endTable(): Promise<void> {
    await this.#write('\\.\n')
  }

  async end(): Promise<void> {
    let sql = '\n'
    const used = new Set<string>()
    for (const table of this.#tables) {
      const name = this.#qualified(table)
      for (const unique of table.uniqueConstraints)
        sql += `ALTER TABLE ${name} ADD CONSTRAINT ${named(unique.name)} UNIQUE (${unique.columns.map(quote).join(', ')});\n`
      for (const index of table.indexes) {
        // Index names are per table in SQL Server and per schema in Postgres.
        let indexName = index.name
        const scope = `${this.#options.schema ?? table.schema}.`.toLowerCase()
        if (used.has(scope + indexName.toLowerCase())) indexName = `${table.name}_${index.name}`
        used.add(scope + indexName.toLowerCase())
        sql += `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${named(indexName)} ON ${name} (${index.columns.map(quote).join(', ')});\n`
      }
      for (const column of table.columns) {
        if (!column.identity) continue
        const literal = name.replaceAll("'", "''")
        // A sequence starts at 1, so a table holding only ids below that leaves it untouched.
        const max = `(SELECT MAX(${quote(column.name)}) FROM ${name})`
        sql += `SELECT setval(pg_get_serial_sequence('${literal}', '${column.name.replaceAll("'", "''")}'), GREATEST(COALESCE(${max}, 1), 1), COALESCE(${max}, 0) >= 1);\n`
      }
    }
    if (!this.#options.skipForeignKeys) {
      for (const table of this.#tables) {
        for (const foreign of table.foreignKeys) {
          const target = this.#tables.find(
            (other) =>
              other.schema === foreign.foreignSchema && other.name === foreign.foreignTable,
          )
          if (!target) {
            this.warnings.push(
              `foreign key ${foreign.name} points at a table that was not converted`,
            )
            continue
          }
          sql +=
            `ALTER TABLE ${this.#qualified(table)} ADD CONSTRAINT ${named(foreign.name)} FOREIGN KEY (${foreign.columns.map(quote).join(', ')}) ` +
            `REFERENCES ${this.#qualified(target)} (${foreign.foreignColumns.map(quote).join(', ')})` +
            (foreign.onDelete ? ` ON DELETE ${foreign.onDelete}` : '') +
            (foreign.onUpdate ? ` ON UPDATE ${foreign.onUpdate}` : '') +
            ';\n'
        }
      }
    }
    for (const table of this.#strippedNul)
      this.warnings.push(`NUL characters were removed from text in ${table}`)
    await this.#write(`${sql}\nCOMMIT;\n`)
    await this.#close()
  }

  async abort(): Promise<void> {
    await this.#close()
  }

  async #close(): Promise<void> {
    const out = this.#out
    if (!out) return
    this.#out = undefined
    out.end()
    await once(out, 'close')
  }
}
