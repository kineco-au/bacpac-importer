/** The schema of a .bacpac, read from its `model.xml`. */
import { childNamed, childrenNamed, parseXml, type XmlNode } from './xml.ts'

export interface Column {
  name: string
  /** The SQL Server type name, lower case: `int`, `nvarchar`, `datetime2`. */
  type: string
  /** Declared length in characters or bytes; undefined for `(max)` and for types without one. */
  length?: number
  isMax: boolean
  precision?: number
  scale?: number
  nullable: boolean
  identity: boolean
  /** The default constraint's T-SQL expression, as written. */
  defaultExpression?: string
}

export interface Index {
  name: string
  unique: boolean
  columns: string[]
}

export interface ForeignKey {
  name: string
  columns: string[]
  foreignSchema: string
  foreignTable: string
  foreignColumns: string[]
  onDelete?: string
  onUpdate?: string
}

export interface Table {
  schema: string
  name: string
  columns: Column[]
  primaryKey?: { name: string; columns: string[] }
  uniqueConstraints: Index[]
  indexes: Index[]
  foreignKeys: ForeignKey[]
}

/** Something in the model this library does not convert, kept so it can be reported. */
export interface SkippedObject {
  kind: string
  name: string
}

export interface Database {
  collation?: string
  caseSensitive: boolean
  tables: Table[]
  skipped: SkippedObject[]
}

/** `[dbo].[my]]table].[col]` → `['dbo', 'my]table', 'col']`. */
export function parseIdentifier(name: string): string[] {
  const parts: string[] = []
  let p = 0
  while (p < name.length) {
    if (name[p] === '[') {
      let part = ''
      p++
      while (p < name.length) {
        if (name[p] === ']') {
          if (name[p + 1] === ']') {
            part += ']'
            p += 2
            continue
          }
          p++
          break
        }
        part += name[p]
        p++
      }
      parts.push(part)
    } else if (name[p] === '.') {
      p++
    } else {
      const end = name.indexOf('.', p)
      parts.push(name.slice(p, end < 0 ? name.length : end))
      p = end < 0 ? name.length : end
    }
  }
  return parts
}

const property = (element: XmlNode, name: string): string | undefined => {
  const node = childrenNamed(element, 'Property').find((p) => p.attributes.Name === name)
  if (!node) return undefined
  return node.attributes.Value ?? childNamed(node, 'Value')?.text
}

const relationship = (element: XmlNode, name: string): XmlNode[] => {
  const node = childrenNamed(element, 'Relationship').find((r) => r.attributes.Name === name)
  return node ? childrenNamed(node, 'Entry') : []
}

const references = (element: XmlNode, name: string): string[] =>
  relationship(element, name).flatMap(
    (entry) => childNamed(entry, 'References')?.attributes.Name ?? [],
  )

const elements = (element: XmlNode, name: string): XmlNode[] =>
  relationship(element, name).flatMap((entry) => childNamed(entry, 'Element') ?? [])

const last = (name: string): string => parseIdentifier(name).at(-1) ?? name

const ACTIONS: Record<string, string> = {
  '1': 'CASCADE',
  '2': 'SET NULL',
  '3': 'SET DEFAULT',
}

/** Object kinds that are part of a database but carry nothing this library converts. */
const IGNORED = new Set([
  'SqlDatabaseOptions',
  'SqlRoleMembership',
  'SqlLogin',
  'SqlUser',
  'SqlRole',
  'SqlPermissionStatement',
  'SqlSchema',
  'SqlFilegroup',
  'SqlFile',
  'SqlExtendedProperty',
])

function parseColumn(element: XmlNode): Column {
  const specifier = elements(element, 'TypeSpecifier')[0]
  const typeName = specifier ? references(specifier, 'Type')[0] : undefined
  if (!specifier || !typeName)
    throw new Error(`column ${element.attributes.Name} has no type in model.xml`)
  const number = (name: string) => {
    const value = property(specifier, name)
    return value === undefined ? undefined : Number(value)
  }
  return {
    name: last(element.attributes.Name ?? ''),
    type: last(typeName).toLowerCase(),
    length: number('Length'),
    isMax: property(specifier, 'IsMax') === 'True',
    precision: number('Precision'),
    scale: number('Scale'),
    nullable: property(element, 'IsNullable') !== 'False',
    identity: property(element, 'IsIdentity') === 'True',
  }
}

const indexedColumns = (element: XmlNode): string[] =>
  elements(element, 'ColumnSpecifications').flatMap((spec) => references(spec, 'Column').map(last))

export function parseModel(xml: string): Database {
  const document = parseXml(xml)
  const root = childNamed(document, 'DataSchemaModel')
  const model = root && childNamed(root, 'Model')
  if (!root || !model) throw new Error('model.xml has no DataSchemaModel/Model')

  const tables = new Map<string, Table>()
  const skipped: SkippedObject[] = []
  const all = childrenNamed(model, 'Element')
  const key = (name: string | undefined) =>
    parseIdentifier(name ?? '')
      .slice(0, 2)
      .join('.')
  const owner = (element: XmlNode, relation: string) =>
    tables.get(key(references(element, relation)[0]))

  for (const element of all) {
    if (element.attributes.Type !== 'SqlTable') continue
    const [schema = 'dbo', name = ''] = parseIdentifier(element.attributes.Name ?? '')
    const columns: Column[] = []
    for (const column of elements(element, 'Columns')) {
      if (column.attributes.Type === 'SqlSimpleColumn') columns.push(parseColumn(column))
      else
        skipped.push({
          kind: column.attributes.Type ?? 'column',
          name: column.attributes.Name ?? '',
        })
    }
    tables.set(`${schema}.${name}`, {
      schema,
      name,
      columns,
      uniqueConstraints: [],
      indexes: [],
      foreignKeys: [],
    })
  }

  for (const element of all) {
    const type = element.attributes.Type ?? ''
    const name = element.attributes.Name ?? ''
    switch (type) {
      case 'SqlTable':
        break
      case 'SqlPrimaryKeyConstraint': {
        const table = owner(element, 'DefiningTable')
        if (table) table.primaryKey = { name: last(name), columns: indexedColumns(element) }
        break
      }
      case 'SqlUniqueConstraint': {
        const table = owner(element, 'DefiningTable')
        table?.uniqueConstraints.push({
          name: last(name),
          unique: true,
          columns: indexedColumns(element),
        })
        break
      }
      case 'SqlIndex': {
        const table = owner(element, 'IndexedObject')
        table?.indexes.push({
          name: last(name),
          unique: property(element, 'IsUnique') === 'True',
          columns: indexedColumns(element),
        })
        break
      }
      case 'SqlForeignKeyConstraint': {
        const table = owner(element, 'DefiningTable')
        const [foreignSchema = 'dbo', foreignTable = ''] = parseIdentifier(
          references(element, 'ForeignTable')[0] ?? '',
        )
        table?.foreignKeys.push({
          name: last(name),
          columns: references(element, 'Columns').map(last),
          foreignSchema,
          foreignTable,
          foreignColumns: references(element, 'ForeignColumns').map(last),
          onDelete: ACTIONS[property(element, 'DeleteAction') ?? ''],
          onUpdate: ACTIONS[property(element, 'UpdateAction') ?? ''],
        })
        break
      }
      case 'SqlDefaultConstraint': {
        const table = owner(element, 'DefiningTable')
        const columnName = last(references(element, 'ForColumn')[0] ?? '')
        const column = table?.columns.find((c) => c.name === columnName)
        if (column) column.defaultExpression = property(element, 'DefaultExpressionScript')
        break
      }
      default:
        if (!IGNORED.has(type)) skipped.push({ kind: type, name })
    }
  }

  const options = all.find((element) => element.attributes.Type === 'SqlDatabaseOptions')
  return {
    collation: options && property(options, 'Collation'),
    caseSensitive: root.attributes.CollationCaseSensitive === 'True',
    tables: [...tables.values()],
    skipped,
  }
}

export interface Origin {
  /** The total number of rows the export says it holds, when it says. */
  rowCount?: number
  serverVersion?: string
  exportedAt?: string
}

export function parseOrigin(xml: string): Origin {
  const root = childNamed(parseXml(xml), 'DacOrigin')
  if (!root) return {}
  const find = (node: XmlNode, path: string[]): XmlNode | undefined =>
    path.reduce<XmlNode | undefined>((at, name) => at && childNamed(at, name), node)
  const count = find(root, ['ExportStatistics', 'TableRowCountTotalTag'])?.text.trim()
  return {
    rowCount: count ? Number(count) : undefined,
    serverVersion: find(root, ['Server', 'ServerVersion'])?.text.trim().split('\n')[0]?.trim(),
    exportedAt: find(root, ['Operation', 'Start'])?.text.trim(),
  }
}
