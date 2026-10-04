/** What a conversion target implements, and what a conversion reports. */
import { createHash } from 'node:crypto'
import type { Row } from './bcp.ts'
import type { Column, Database, SkippedObject, Table } from './schema.ts'

export interface Writer {
  /** A short name for the target, recorded in the manifest. */
  readonly target: string
  /** Things the target could not represent, gathered as the conversion runs. */
  readonly warnings: string[]
  /** The name a table has in the target. */
  tableName(table: Table): string
  /** The type a column has in the target. */
  columnType(column: Column): string
  begin(database: Database, tables: Table[]): Promise<void>
  beginTable(table: Table): Promise<void>
  writeRows(table: Table, rows: Row[]): Promise<void>
  endTable(table: Table): Promise<void>
  /** Everything that waits for the data: indexes, foreign keys, sequences. */
  end(): Promise<void>
  /** Releases the target after a failure, without finishing it. */
  abort?(): Promise<void>
}

export interface ManifestColumn {
  name: string
  sourceType: string
  targetType: string
  nullable: boolean
}

export interface ManifestTable {
  schema: string
  name: string
  targetName: string
  rows: number
  columns: ManifestColumn[]
}

export interface Manifest {
  source: {
    file: string
    exportedAt?: string
    serverVersion?: string
    collation?: string
    caseSensitive: boolean
    /** The row total the export declares, to compare against `rows`. */
    declaredRows?: number
  }
  target: string
  rows: number
  tables: ManifestTable[]
  /** Tables left out by the include and exclude options. */
  excluded: string[]
  /** Objects in the source this library does not convert: views, procedures, triggers. */
  skipped: SkippedObject[]
  /** Column types present whose decoding has not been confirmed against real exports. */
  unverifiedTypes: string[]
  warnings: string[]
}

/**
 * A name cut to a target's identifier limit. A database that truncates silently
 * can turn two long names into one, so the cut keeps a hash of the whole name:
 * the result stays distinct and is the same on every run.
 */
export function fitIdentifier(name: string, maxBytes: number): string {
  if (Buffer.byteLength(name) <= maxBytes) return name
  const hash = createHash('sha1').update(name).digest('hex').slice(0, 8)
  let head = name
  while (Buffer.byteLength(head) > maxBytes - 9) head = head.slice(0, -1)
  return `${head}_${hash}`
}

/** A column's type as SQL Server would declare it: `nvarchar(255)`, `decimal(38,6)`. */
export function sourceType(column: Column): string {
  if (column.isMax) return `${column.type}(max)`
  if (column.precision !== undefined)
    return `${column.type}(${column.precision},${column.scale ?? 0})`
  if (column.length !== undefined) return `${column.type}(${column.length})`
  if (column.scale !== undefined) return `${column.type}(${column.scale})`
  return column.type
}

/** A default constraint, reduced to what any target can render. */
export type DefaultValue =
  | { kind: 'number'; text: string }
  /** `text` is the string's content, unquoted and unescaped. */
  | { kind: 'string'; text: string }
  | { kind: 'now' }
  | { kind: 'newGuid' }

const NOW = /^(getdate|getutcdate|sysdatetime|sysutcdatetime|current_timestamp)(\(\))?$/i

/**
 * Reads a default constraint's T-SQL, for the expressions that mean the same
 * thing everywhere: literals, the current time, a new GUID. Anything else is
 * undefined, and the writer reports it. Rendering is the writer's, so a new
 * target needs nothing from here.
 */
export function parseDefault(expression: string): DefaultValue | undefined {
  let text = expression.trim()
  while (text.startsWith('(') && text.endsWith(')')) text = text.slice(1, -1).trim()

  if (/^[-+]?\d+(\.\d+)?$/.test(text)) return { kind: 'number', text }
  const string = /^N?'((?:[^']|'')*)'$/.exec(text)
  if (string) return { kind: 'string', text: (string[1] as string).replaceAll("''", "'") }
  if (NOW.test(text)) return { kind: 'now' }
  if (/^newid\(\)$/i.test(text)) return { kind: 'newGuid' }
  return undefined
}

/** Whether a literal default on a `bit` column means true. */
export const defaultIsTrue = (value: DefaultValue): boolean =>
  (value.kind === 'number' || value.kind === 'string') && Number(value.text) !== 0
