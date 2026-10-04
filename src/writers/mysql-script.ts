/** Writes a plain SQL script for MySQL: the schema, then batched `INSERT`s, loadable with `mysql`. */

import { once } from 'node:events'
import { createWriteStream, type WriteStream } from 'node:fs'
import type { Row, Value } from '../bcp.ts'
import type { Column, Database, Table } from '../schema.ts'
import { defaultIsTrue, fitIdentifier, parseDefault, type Writer } from '../writer.ts'

export interface MysqlScriptOptions {
  /**
   * Create this database and `USE` it. Without one the script names no database,
   * so `mysql -D <name>` or an earlier `USE` chooses it.
   */
  database?: string
  /** Leave foreign keys out, for a source whose data does not satisfy them. */
  skipForeignKeys?: boolean
  /**
   * The collation for tables and text columns. The default matches the source's
   * case sensitivity and needs MySQL 8.0; name one explicitly for MariaDB or 5.7.
   */
  collation?: string
  /** How many bytes of values to gather into one `INSERT`. Defaults to 900 KB. */
  maxStatementBytes?: number
}

const quote = (name: string) => `\`${name.replaceAll('`', '``')}\``

const MAX_IDENTIFIER_BYTES = 64
/** The widest key InnoDB indexes, with the row format this writer declares. */
const MAX_KEY_BYTES = 3072
/** MySQL keeps at most six fractional digits of a second; SQL Server keeps seven. */
const MAX_FRACTION = 6
/** Bytes a utf8mb4 character can take, which is what a key budget counts. */
const BYTES_PER_CHARACTER = 4

/** An index or constraint name, shortened if MySQL would have rejected it. */
const named = (name: string) => quote(fitIdentifier(name, MAX_IDENTIFIER_BYTES))

const FIXED: Record<string, string> = {
  // SQL Server's tinyint is unsigned; MySQL's is not.
  tinyint: 'tinyint unsigned',
  smallint: 'smallint',
  int: 'int',
  bigint: 'bigint',
  bit: 'tinyint(1)',
  real: 'float',
  float: 'double',
  money: 'decimal(19,4)',
  smallmoney: 'decimal(10,4)',
  uniqueidentifier: 'char(36)',
  date: 'date',
  datetime: 'datetime(3)',
  smalldatetime: 'datetime(0)',
  ntext: 'longtext',
  text: 'longtext',
  xml: 'longtext',
  sysname: 'varchar(128)',
  image: 'longblob',
  timestamp: 'varbinary(8)',
  rowversion: 'varbinary(8)',
}

const LONG = new Set(['longtext', 'longblob'])

const ESCAPES: Record<string, string> = {
  '\0': '\\0',
  '\b': '\\b',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  // Ctrl-Z ends input for the Windows mysql client unless it is escaped.
  '\u001a': '\\Z',
  '\\': '\\\\',
  "'": "\\'",
}
/** Built from the table above, so the two cannot drift apart. */
const NEEDS_ESCAPE = new RegExp(
  `[${Object.keys(ESCAPES)
    .map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
    .join('')}]`,
  'g',
)

const literal = (text: string) =>
  `'${text.replace(NEEDS_ESCAPE, (character) => ESCAPES[character] as string)}'`

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'))

/** How one value of one column is written into an `INSERT`. */
type Render = (value: Value) => string

const generic: Render = (value) => {
  if (value === null) return 'NULL'
  switch (typeof value) {
    case 'string':
      return literal(value)
    case 'boolean':
      return value ? '1' : '0'
    case 'number':
    case 'bigint':
      return String(value)
    default: {
      let hex = ''
      for (const byte of value) hex += HEX[byte]
      return `X'${hex}'`
    }
  }
}

/** A decimal arrives as an exact string, which MySQL takes unquoted. */
const NUMBER = /^[-+]?\d+(\.\d+)?$/
const numeric: Render = (value) =>
  typeof value === 'string' && NUMBER.test(value) ? value : generic(value)

const OFFSET = /[+-]\d\d:\d\d$/

/**
 * MySQL has no zoned timestamp and no seventh fractional digit, and wants a
 * space where ISO 8601 puts a `T`. Digits past the column's precision would
 * otherwise be rounded by the server, which can carry into the next second.
 */
const temporal =
  (digits: number): Render =>
  (value) => {
    if (typeof value !== 'string') return generic(value)
    let text = value.replace(OFFSET, '').replace('T', ' ')
    const dot = text.indexOf('.')
    if (dot >= 0) text = digits === 0 ? text.slice(0, dot) : text.slice(0, dot + 1 + digits)
    return literal(text)
  }

const FRACTION = /^(?:datetime|time)\((\d)\)$/
/** A type whose width a key counts, and whose prefix a key can take. */
const WIDTH = /^(char|varchar|binary|varbinary)\((\d+)\)$/

/** One column of a key: what it costs, and what a prefix of it costs per character. */
interface KeyPart {
  name: string
  bytes: number
  /** Zero when the column has no prefix form, so it is taken whole or not at all. */
  perCharacter: number
}

function renderDefault(column: Column, type: string): string | undefined {
  const value = parseDefault(column.defaultExpression ?? '')
  // A default on a text or blob column is only taken as an expression.
  const wrap = (text: string) => (LONG.has(type) ? `(${text})` : text)
  switch (value?.kind) {
    case 'number':
    case 'string':
      if (column.type === 'bit') return defaultIsTrue(value) ? '1' : '0'
      return wrap(value.kind === 'number' ? value.text : literal(value.text))
    case 'now': {
      // CURRENT_TIMESTAMP has to carry the column's own fractional precision.
      const fraction = FRACTION.exec(type)
      if (fraction) return `CURRENT_TIMESTAMP(${fraction[1]})`
      return type === 'date' ? '(CURRENT_DATE)' : '(CURRENT_TIMESTAMP)'
    }
    case 'newGuid':
      return '(UUID())'
    default:
      return undefined
  }
}

export class MysqlScriptWriter implements Writer {
  readonly target = 'mysql-script'
  readonly warnings: string[] = []
  readonly #path: string
  readonly #options: MysqlScriptOptions
  readonly #limit: number
  #out: WriteStream | undefined
  #tables: Table[] = []
  #flat = true
  #collation = 'utf8mb4_0900_as_ci'
  #prefixed = new Map<string, number>()
  #stricter = new Set<string>()
  #renderers: Render[] = []
  #insert = ''
  #values: string[] = []
  #bytes = 0

  constructor(path: string, options: MysqlScriptOptions = {}) {
    this.#path = path
    this.#options = options
    this.#limit = options.maxStatementBytes ?? 900_000
  }

  tableName(table: Table): string {
    // MySQL has no schemas, so a table keeps its bare name unless two schemas share it.
    return this.#flat ? table.name : `${table.schema}_${table.name}`
  }

  columnType(column: Column): string {
    const fraction = Math.min(column.scale ?? MAX_FRACTION, MAX_FRACTION)
    switch (column.type) {
      case 'decimal':
      case 'numeric':
        return `decimal(${column.precision ?? 18},${column.scale ?? 0})`
      case 'char':
      case 'nchar':
        if (column.isMax || !column.length) return 'longtext'
        // MySQL's char stops at 255 characters.
        return column.length > 255 ? `varchar(${column.length})` : `char(${column.length})`
      case 'varchar':
      case 'nvarchar':
        return column.isMax || !column.length ? 'longtext' : `varchar(${column.length})`
      case 'binary':
        if (column.isMax || !column.length) return 'longblob'
        return column.length > 255 ? `varbinary(${column.length})` : `binary(${column.length})`
      case 'varbinary':
        return column.isMax || !column.length ? 'longblob' : `varbinary(${column.length})`
      case 'time':
        return `time(${fraction})`
      case 'datetime2':
        return `datetime(${fraction})`
      case 'datetimeoffset':
        return `datetime(${fraction})`
      default:
        return FIXED[column.type] ?? 'longtext'
    }
  }

  async #write(text: string): Promise<void> {
    const out = this.#out
    if (!out) throw new Error('the MySQL script writer has not been started')
    if (!out.write(text)) await once(out, 'drain')
  }

  async begin(database: Database, tables: Table[]): Promise<void> {
    this.#tables = tables
    const names = tables.map((table) => table.name.toLowerCase())
    this.#flat = new Set(names).size === names.length
    // Accent-sensitive and case-insensitive is how most SQL Server databases compare.
    this.#collation =
      this.#options.collation ??
      (database.caseSensitive ? 'utf8mb4_0900_as_cs' : 'utf8mb4_0900_as_ci')
    this.#out = createWriteStream(this.#path, { encoding: 'utf8' })

    for (const column of tables.flatMap((table) => table.columns))
      if (column.type === 'datetimeoffset')
        this.warnings.push(
          `datetimeoffset ${column.name} became datetime; MySQL has no zoned timestamp, so the time is kept as it was written and the offset is dropped`,
        )

    let sql = '-- Converted from a SQL Server .bacpac by bacpac-importer.\n'
    sql += 'SET NAMES utf8mb4;\n'
    // Without this an identity column holding 0 would be given a fresh value.
    sql += "SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO';\n"
    sql += 'SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0;\n'
    sql += 'SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0;\n'
    const target = this.#options.database
    if (target !== undefined)
      sql +=
        `\nCREATE DATABASE IF NOT EXISTS ${quote(target)} ` +
        `CHARACTER SET utf8mb4 COLLATE ${this.#collation};\nUSE ${quote(target)};\n`
    for (const table of tables) sql += `\n${this.#createTable(table)}\n`
    await this.#write(sql)
  }

  /** What a column costs a key, and how short a prefix of it can be taken. */
  #keyPart(table: Table, name: string): KeyPart {
    const column = table.columns.find((other) => other.name === name)
    const type = column ? this.columnType(column) : ''
    // A long column can never be indexed whole, whatever the budget allows.
    if (type === 'longtext') return { name, bytes: Infinity, perCharacter: BYTES_PER_CHARACTER }
    if (type === 'longblob') return { name, bytes: Infinity, perCharacter: 1 }
    const width = WIDTH.exec(type)
    if (width) {
      const perCharacter = (width[1] as string).endsWith('binary') ? 1 : BYTES_PER_CHARACTER
      return { name, bytes: Number(width[2]) * perCharacter, perCharacter }
    }
    return { name, bytes: 8, perCharacter: 0 }
  }

  /**
   * A key's columns, each cut to a prefix where the whole of it would not fit.
   * InnoDB refuses a key past 3072 bytes outright, so the budget is shared out
   * so that a narrow column keeps all of itself and the wide ones split what is
   * left: the key fits with as little of it truncated as possible.
   */
  #key(table: Table, columns: string[], index: string, unique: boolean): string {
    const parts = columns.map((name) => this.#keyPart(table, name))
    const allowed = new Map<string, number>()

    if (parts.reduce((total, part) => total + part.bytes, 0) > MAX_KEY_BYTES) {
      let remaining = MAX_KEY_BYTES
      let left = parts.length
      for (const part of [...parts].sort((a, b) => a.bytes - b.bytes)) {
        const share = Math.floor(remaining / left--)
        const taken = part.bytes <= share || part.perCharacter === 0 ? part.bytes : share
        if (taken < part.bytes) allowed.set(part.name, taken)
        remaining -= taken
      }
      if (remaining < 0)
        this.warnings.push(
          `key ${index} on ${table.name} is wider than the ${MAX_KEY_BYTES} bytes MySQL indexes, and its fixed-width columns cannot be shortened`,
        )
    }

    return parts
      .map((part) => {
        const budget = allowed.get(part.name)
        if (budget === undefined) return quote(part.name)
        const characters = Math.max(1, Math.floor(budget / part.perCharacter))
        const at = `${table.name}.${part.name}`
        this.#prefixed.set(at, Math.min(this.#prefixed.get(at) ?? characters, characters))
        if (unique) this.#stricter.add(`${index} on ${table.name}`)
        return `${quote(part.name)}(${characters})`
      })
      .join(', ')
  }

  #createTable(table: Table): string {
    const key = table.primaryKey?.columns ?? []
    const identity = table.columns.find((column) => column.identity)
    // An auto-increment column has to be the first column of a key.
    const needsKey = identity !== undefined && identity.name !== key[0]
    const lines: string[] = []

    for (const column of table.columns) {
      const type = this.columnType(column)
      let line = `${quote(column.name)} ${type}`
      if (!column.nullable) line += ' NOT NULL'
      if (column.defaultExpression !== undefined && !column.identity) {
        const translated = renderDefault(column, type)
        if (translated !== undefined) line += ` DEFAULT ${translated}`
        else
          this.warnings.push(
            `default ${column.defaultExpression} on ${table.name}.${column.name} was not translated`,
          )
      }
      if (column === identity) line += ' AUTO_INCREMENT'
      else if (column.identity)
        this.warnings.push(
          `identity on ${table.name}.${column.name} was dropped; MySQL allows one auto-increment column per table`,
        )
      lines.push(line)
    }

    if (key.length > 0)
      lines.push(
        `PRIMARY KEY (${this.#key(table, key, table.primaryKey?.name ?? 'PRIMARY', true)})`,
      )
    if (needsKey) {
      lines.push(`KEY ${named(`IX_${table.name}_${identity.name}`)} (${quote(identity.name)})`)
      this.warnings.push(
        `an index was added on ${table.name}.${identity.name}; MySQL needs an auto-increment column to be the first column of a key`,
      )
    }

    return (
      `CREATE TABLE ${quote(this.tableName(table))} (\n  ${lines.join(',\n  ')}\n)` +
      ` ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=${this.#collation} ROW_FORMAT=DYNAMIC;`
    )
  }

  async beginTable(table: Table): Promise<void> {
    this.#renderers = table.columns.map((column) => {
      const type = this.columnType(column)
      if (type.startsWith('decimal(')) return numeric
      const fraction = FRACTION.exec(type)
      if (fraction) return temporal(Number(fraction[1]))
      return type === 'date' ? temporal(0) : generic
    })
    this.#insert =
      `INSERT INTO ${quote(this.tableName(table))} ` +
      `(${table.columns.map((column) => quote(column.name)).join(', ')}) VALUES\n`
    this.#values = []
    this.#bytes = 0
    await this.#write(`\n-- ${table.schema}.${table.name}\n`)
  }

  async writeRows(_table: Table, rows: Row[]): Promise<void> {
    const renderers = this.#renderers
    for (const row of rows) {
      let text = '('
      for (let i = 0; i < row.length; i++)
        text += (i === 0 ? '' : ',') + (renderers[i] ?? generic)(row[i] as Value)
      text += ')'
      this.#values.push(text)
      this.#bytes += text.length + 2
      if (this.#bytes >= this.#limit) await this.#flush()
    }
  }

  async #flush(): Promise<void> {
    if (this.#values.length === 0) return
    const sql = `${this.#insert}${this.#values.join(',\n')};\n`
    this.#values = []
    this.#bytes = 0
    await this.#write(sql)
  }

  async endTable(): Promise<void> {
    await this.#flush()
  }

  async end(): Promise<void> {
    let sql = '\n'
    // Index names are per table in MySQL, as they are in SQL Server, so they stand as they are.
    for (const table of this.#tables) {
      const name = quote(this.tableName(table))
      for (const unique of table.uniqueConstraints)
        sql +=
          `ALTER TABLE ${name} ADD CONSTRAINT ${named(unique.name)} ` +
          `UNIQUE (${this.#key(table, unique.columns, unique.name, true)});\n`
      for (const index of table.indexes)
        sql +=
          `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${named(index.name)} ON ${name} ` +
          `(${this.#key(table, index.columns, index.name, index.unique)});\n`
    }

    // Restored before the foreign keys, so adding one checks the data against it.
    sql += '\nSET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS;\n'
    if (!this.#options.skipForeignKeys) {
      // A foreign key's name is per database in MySQL and per schema in SQL Server.
      const used = new Set<string>()
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
          let constraint = foreign.name
          if (used.has(constraint.toLowerCase())) constraint = `${table.name}_${foreign.name}`
          used.add(constraint.toLowerCase())
          sql +=
            `ALTER TABLE ${quote(this.tableName(table))} ADD CONSTRAINT ${named(constraint)} ` +
            `FOREIGN KEY (${foreign.columns.map(quote).join(', ')}) ` +
            `REFERENCES ${quote(this.tableName(target))} (${foreign.foreignColumns.map(quote).join(', ')})` +
            this.#action('ON DELETE', foreign.onDelete, foreign.name) +
            this.#action('ON UPDATE', foreign.onUpdate, foreign.name) +
            ';\n'
        }
      }
    }

    for (const [column, characters] of this.#prefixed)
      this.warnings.push(
        `${column} is indexed by its first ${characters} characters; MySQL limits a key to ${MAX_KEY_BYTES} bytes`,
      )
    for (const index of this.#stricter)
      this.warnings.push(
        `unique key ${index} is enforced on a prefix of its text, which is stricter than the source`,
      )
    sql += '\nSET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS;\nSET SQL_MODE=@OLD_SQL_MODE;\n'
    await this.#write(sql)
    await this.#close()
  }

  /** InnoDB parses `SET DEFAULT` and then refuses it, so it is reported instead. */
  #action(clause: string, action: string | undefined, foreign: string): string {
    if (action === undefined) return ''
    if (action !== 'SET DEFAULT') return ` ${clause} ${action}`
    this.warnings.push(
      `${clause} SET DEFAULT on ${foreign} was dropped; InnoDB does not support it`,
    )
    return ''
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
