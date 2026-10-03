/** Runs a conversion: every selected table of a .bacpac through a writer. */
import { VERIFIED_TYPES } from './bcp.ts'
import { Bacpac } from './reader.ts'
import type { Table } from './schema.ts'
import { type Manifest, type ManifestTable, sourceType, type Writer } from './writer.ts'

export interface Progress {
  table: string
  /** Rows written so far for this table. */
  rows: number
  done: boolean
}

export interface ConvertOptions {
  /** Convert only these tables, named `table` or `schema.table`, case-insensitively. */
  include?: string[]
  /** Leave these tables out. */
  exclude?: string[]
  batchSize?: number
  /** The encoding of `char`, `varchar` and `text` values. Defaults to windows-1252. */
  encoding?: string
  onProgress?: (progress: Progress) => void
}

function selector(names: string[] | undefined): ((table: Table) => boolean) | undefined {
  if (!names) return undefined
  const wanted = new Set(names.map((name) => name.toLowerCase()))
  return (table) =>
    wanted.has(table.name.toLowerCase()) ||
    wanted.has(`${table.schema}.${table.name}`.toLowerCase())
}

export async function convert(
  source: string | Bacpac,
  writer: Writer,
  options: ConvertOptions = {},
): Promise<Manifest> {
  const bacpac = typeof source === 'string' ? await Bacpac.open(source) : source
  try {
    const included = selector(options.include)
    const excluded = selector(options.exclude)
    const tables = bacpac.tables.filter(
      (table) => (included?.(table) ?? true) && !excluded?.(table),
    )
    const manifestTables: ManifestTable[] = []
    let total = 0

    try {
      await writer.begin(bacpac.database, tables)
      for (const table of tables) {
        const name = `${table.schema}.${table.name}`
        let rows = 0
        await writer.beginTable(table)
        for await (const batch of bacpac.rows(table, options)) {
          await writer.writeRows(table, batch)
          rows += batch.length
          options.onProgress?.({ table: name, rows, done: false })
        }
        await writer.endTable(table)
        options.onProgress?.({ table: name, rows, done: true })
        total += rows
        manifestTables.push({
          schema: table.schema,
          name: table.name,
          targetName: writer.tableName(table),
          rows,
          columns: table.columns.map((column) => ({
            name: column.name,
            sourceType: sourceType(column),
            targetType: writer.columnType(column),
            nullable: column.nullable,
          })),
        })
      }
      await writer.end()
    } catch (error) {
      await writer.abort?.()
      throw error
    }

    const types = new Set(tables.flatMap((table) => table.columns.map((column) => column.type)))
    return {
      source: {
        file: typeof source === 'string' ? source : '',
        exportedAt: bacpac.origin.exportedAt,
        serverVersion: bacpac.origin.serverVersion,
        collation: bacpac.database.collation,
        caseSensitive: bacpac.database.caseSensitive,
        declaredRows: bacpac.origin.rowCount,
      },
      target: writer.target,
      rows: total,
      tables: manifestTables,
      excluded: bacpac.tables
        .filter((table) => !tables.includes(table))
        .map((table) => `${table.schema}.${table.name}`),
      skipped: bacpac.database.skipped,
      unverifiedTypes: [...types].filter((type) => !VERIFIED_TYPES.has(type)).sort(),
      warnings: [...writer.warnings],
    }
  } finally {
    if (typeof source === 'string') await bacpac.close()
  }
}
