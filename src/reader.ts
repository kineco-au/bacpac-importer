/** Opens a .bacpac: its schema, and each table's rows as a stream. */
import { type DecodeOptions, decodeRows, type Row } from './bcp.ts'
import { type Database, type Origin, parseModel, parseOrigin, type Table } from './schema.ts'
import { type ZipEntry, ZipFile } from './zip.ts'

export interface RowOptions extends DecodeOptions {
  batchSize?: number
}

const stripBom = (text: string) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)

export class Bacpac {
  readonly database: Database
  readonly origin: Origin
  readonly #zip: ZipFile
  readonly #data: Map<string, ZipEntry[]>

  private constructor(zip: ZipFile, database: Database, origin: Origin) {
    this.#zip = zip
    this.database = database
    this.origin = origin
    this.#data = new Map()
    for (const entry of zip.entries) {
      const match = /^Data\/([^/]+)\/[^/]+\.BCP$/i.exec(entry.name)
      if (!match) continue
      const key = decodeURIComponent(match[1] as string).toLowerCase()
      const files = this.#data.get(key) ?? []
      files.push(entry)
      this.#data.set(key, files)
    }
    for (const files of this.#data.values()) files.sort((a, b) => a.name.localeCompare(b.name))
  }

  static async open(path: string): Promise<Bacpac> {
    const zip = await ZipFile.open(path)
    try {
      const model = zip.entry('model.xml')
      if (!model) throw new Error('not a .bacpac: it has no model.xml')
      const origin = zip.entry('Origin.xml')
      return new Bacpac(
        zip,
        parseModel(stripBom((await zip.read(model)).toString('utf8'))),
        origin ? parseOrigin(stripBom((await zip.read(origin)).toString('utf8'))) : {},
      )
    } catch (error) {
      await zip.close()
      throw error
    }
  }

  get tables(): Table[] {
    return this.database.tables
  }

  table(name: string, schema?: string): Table | undefined {
    const wanted = name.toLowerCase()
    return this.database.tables.find(
      (table) =>
        table.name.toLowerCase() === wanted &&
        (schema === undefined || table.schema.toLowerCase() === schema.toLowerCase()),
    )
  }

  /** The data files that hold a table's rows; none for an empty table. */
  dataFiles(table: Table): ZipEntry[] {
    return this.#data.get(`${table.schema}.${table.name}`.toLowerCase()) ?? []
  }

  /** A table's rows, in batches, each row an array in column order. */
  async *rows(table: Table, options: RowOptions = {}): AsyncGenerator<Row[]> {
    for (const file of this.dataFiles(table)) {
      try {
        yield* decodeRows(this.#zip.stream(file), table.columns, options)
      } catch (error) {
        if (error instanceof Error) error.message = `${file.name}: ${error.message}`
        throw error
      }
    }
  }

  close(): Promise<void> {
    return this.#zip.close()
  }
}

export const openBacpac = (path: string): Promise<Bacpac> => Bacpac.open(path)
