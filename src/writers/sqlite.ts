/** Writes a SQLite database file, through the runtime's own SQLite. */
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import type { Row, Value } from '../bcp.ts'
import type { Column, Database, Table } from '../schema.ts'
import { type DefaultValue, defaultIsTrue, parseDefault, type Writer } from '../writer.ts'

/** The slice of a SQLite binding this writer needs; `bun:sqlite` and `node:sqlite` both fit. */
export interface SqliteDatabase {
  exec(sql: string): unknown
  prepare(sql: string): { run(...parameters: never[]): unknown }
  close(): unknown
}

export interface SqliteWriterOptions {
  /** Replace the file if it exists. Without this an existing file is an error. */
  overwrite?: boolean
  /**
   * Give text columns `COLLATE NOCASE` when the source database is
   * case-insensitive, so comparisons and unique indexes behave as they did.
   * Defaults to true.
   */
  matchCaseSensitivity?: boolean
  /** Supplies the database, for a runtime this library does not detect. */
  open?: (path: string) => SqliteDatabase | Promise<SqliteDatabase>
}

const INTEGER_TYPES = new Set(['tinyint', 'smallint', 'int', 'bigint', 'bit'])
const REAL_TYPES = new Set(['real', 'float'])
const BLOB_TYPES = new Set(['binary', 'varbinary', 'image', 'timestamp', 'rowversion'])

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`

async function openDefault(path: string): Promise<SqliteDatabase> {
  if (typeof Bun !== 'undefined') {
    const { Database } = await import('bun:sqlite')
    return new Database(path) as unknown as SqliteDatabase
  }
  const sqlite = 'node:sqlite'
  const { DatabaseSync } = await import(sqlite)
  return new DatabaseSync(path) as SqliteDatabase
}

function renderDefault(column: Column): string | undefined {
  const value: DefaultValue | undefined = parseDefault(column.defaultExpression ?? '')
  switch (value?.kind) {
    case 'number':
    case 'string':
      if (column.type === 'bit') return defaultIsTrue(value) ? '1' : '0'
      return value.kind === 'number' ? value.text : `'${value.text.replaceAll("'", "''")}'`
    case 'now':
      return 'CURRENT_TIMESTAMP'
    default:
      return undefined
  }
}

const bind = (value: Value): Value => (typeof value === 'boolean' ? (value ? 1 : 0) : value)

export class SqliteWriter implements Writer {
  readonly target = 'sqlite'
  readonly warnings: string[] = []
  readonly #path: string
  readonly #options: SqliteWriterOptions
  #db: SqliteDatabase | undefined
  #insert: { run(...parameters: never[]): unknown } | undefined
  #nocase = false
  #flat = true
  #tables: Table[] = []

  constructor(path: string, options: SqliteWriterOptions = {}) {
    this.#path = path
    this.#options = options
  }

  tableName(table: Table): string {
    return this.#flat ? table.name : `${table.schema}.${table.name}`
  }

  columnType(column: Column): string {
    if (INTEGER_TYPES.has(column.type)) return 'INTEGER'
    if (REAL_TYPES.has(column.type)) return 'REAL'
    if (BLOB_TYPES.has(column.type)) return 'BLOB'
    return 'TEXT'
  }

  async begin(database: Database, tables: Table[]): Promise<void> {
    if (this.#options.overwrite) await rm(this.#path, { force: true })
    else if (existsSync(this.#path))
      throw new Error(`${this.#path} already exists; pass overwrite to replace it`)

    this.#tables = tables
    // SQLite has no schemas, so a table keeps its bare name unless two schemas share it.
    const names = tables.map((table) => table.name.toLowerCase())
    this.#flat = new Set(names).size === names.length
    this.#nocase = !database.caseSensitive && this.#options.matchCaseSensitivity !== false

    const db = await (this.#options.open ?? openDefault)(this.#path)
    this.#db = db
    db.exec('PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; PRAGMA foreign_keys = OFF;')
    for (const table of tables) db.exec(this.#createTable(table))
  }

  #createTable(table: Table): string {
    const key = table.primaryKey?.columns ?? []
    const keyColumn = table.columns.find((column) => column.name === key[0])
    // A single integer key is SQLite's rowid, which is what an identity column is.
    const rowid =
      key.length === 1 && keyColumn !== undefined && this.columnType(keyColumn) === 'INTEGER'
    const lines: string[] = []

    for (const column of table.columns) {
      const type = this.columnType(column)
      let line = `${quote(column.name)} ${type}`
      if (rowid && column === keyColumn) {
        line += ` PRIMARY KEY${column.identity ? ' AUTOINCREMENT' : ''}`
      } else {
        if (type === 'TEXT' && this.#nocase && column.type !== 'uniqueidentifier')
          line += ' COLLATE NOCASE'
        if (!column.nullable) line += ' NOT NULL'
      }
      if (column.defaultExpression !== undefined) {
        const translated = renderDefault(column)
        if (translated !== undefined) line += ` DEFAULT ${translated}`
        else
          this.warnings.push(
            `default ${column.defaultExpression} on ${table.name}.${column.name} was not translated`,
          )
      }
      lines.push(line)
    }
    if (!rowid && key.length > 0) lines.push(`PRIMARY KEY (${key.map(quote).join(', ')})`)
    for (const unique of table.uniqueConstraints)
      lines.push(
        `CONSTRAINT ${quote(unique.name)} UNIQUE (${unique.columns.map(quote).join(', ')})`,
      )
    for (const foreign of table.foreignKeys) {
      const target = this.#tables.find(
        (other) => other.schema === foreign.foreignSchema && other.name === foreign.foreignTable,
      )
      if (!target) {
        this.warnings.push(`foreign key ${foreign.name} points at a table that was not converted`)
        continue
      }
      lines.push(
        `CONSTRAINT ${quote(foreign.name)} FOREIGN KEY (${foreign.columns.map(quote).join(', ')}) ` +
          `REFERENCES ${quote(this.tableName(target))} (${foreign.foreignColumns.map(quote).join(', ')})` +
          (foreign.onDelete ? ` ON DELETE ${foreign.onDelete}` : '') +
          (foreign.onUpdate ? ` ON UPDATE ${foreign.onUpdate}` : ''),
      )
    }
    return `CREATE TABLE ${quote(this.tableName(table))} (\n  ${lines.join(',\n  ')}\n)`
  }

  async beginTable(table: Table): Promise<void> {
    const db = this.#require()
    const placeholders = table.columns.map(() => '?').join(', ')
    this.#insert = db.prepare(
      `INSERT INTO ${quote(this.tableName(table))} (${table.columns.map((c) => quote(c.name)).join(', ')}) VALUES (${placeholders})`,
    )
    db.exec('BEGIN')
  }

  async writeRows(_table: Table, rows: Row[]): Promise<void> {
    const insert = this.#insert
    if (!insert) throw new Error('writeRows called outside a table')
    for (const row of rows) {
      for (let i = 0; i < row.length; i++) row[i] = bind(row[i] as Value)
      insert.run(...(row as never[]))
    }
  }

  async endTable(): Promise<void> {
    this.#require().exec('COMMIT')
    this.#insert = undefined
  }

  async end(): Promise<void> {
    const db = this.#require()
    const used = new Set<string>()
    for (const table of this.#tables) {
      for (const index of table.indexes) {
        // Index names are per table in SQL Server and per database in SQLite.
        let name = index.name
        if (used.has(name.toLowerCase())) name = `${table.name}_${index.name}`
        used.add(name.toLowerCase())
        db.exec(
          `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${quote(name)} ON ${quote(this.tableName(table))} (${index.columns.map(quote).join(', ')})`,
        )
      }
    }
    db.close()
    this.#db = undefined
  }

  async abort(): Promise<void> {
    this.#db?.close()
    this.#db = undefined
  }

  #require(): SqliteDatabase {
    if (!this.#db) throw new Error('the SQLite writer has not been started')
    return this.#db
  }
}
