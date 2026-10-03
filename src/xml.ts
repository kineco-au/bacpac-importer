/** A small XML parser, enough for the documents inside a .bacpac. */

export interface XmlNode {
  name: string
  attributes: Record<string, string>
  children: XmlNode[]
  text: string
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

export function decodeEntities(value: string): string {
  if (!value.includes('&')) return value
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (match, body: string) => {
    if (body.startsWith('#x')) return String.fromCodePoint(Number.parseInt(body.slice(2), 16))
    if (body.startsWith('#')) return String.fromCodePoint(Number.parseInt(body.slice(1), 10))
    return ENTITIES[body] ?? match
  })
}

const ATTRIBUTE = /([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g

export function parseXml(source: string): XmlNode {
  const root: XmlNode = { name: '#document', attributes: {}, children: [], text: '' }
  const stack: XmlNode[] = [root]
  let p = 0

  const top = () => stack[stack.length - 1] as XmlNode

  while (p < source.length) {
    const open = source.indexOf('<', p)
    if (open < 0) break
    if (open > p) top().text += decodeEntities(source.slice(p, open))

    if (source.startsWith('<!--', open)) {
      const end = source.indexOf('-->', open)
      if (end < 0) throw new Error('unterminated XML comment')
      p = end + 3
    } else if (source.startsWith('<![CDATA[', open)) {
      const end = source.indexOf(']]>', open)
      if (end < 0) throw new Error('unterminated CDATA section')
      top().text += source.slice(open + 9, end)
      p = end + 3
    } else if (source.startsWith('<?', open)) {
      const end = source.indexOf('?>', open)
      if (end < 0) throw new Error('unterminated XML declaration')
      p = end + 2
    } else if (source.startsWith('<!', open)) {
      const end = source.indexOf('>', open)
      if (end < 0) throw new Error('unterminated XML declaration')
      p = end + 1
    } else {
      const end = source.indexOf('>', open)
      if (end < 0) throw new Error('unterminated XML tag')
      const body = source.slice(open + 1, end)
      if (body.startsWith('/')) {
        const name = body.slice(1).trim()
        if (stack.length < 2 || top().name !== name)
          throw new Error(`unexpected closing tag </${name}>`)
        stack.pop()
      } else {
        const selfClosing = body.endsWith('/')
        const inner = selfClosing ? body.slice(0, -1) : body
        const space = inner.search(/\s/)
        const node: XmlNode = {
          name: space < 0 ? inner : inner.slice(0, space),
          attributes: {},
          children: [],
          text: '',
        }
        if (space >= 0) {
          for (const match of inner.slice(space).matchAll(ATTRIBUTE))
            node.attributes[match[1] as string] = decodeEntities(match[2] ?? match[3] ?? '')
        }
        top().children.push(node)
        if (!selfClosing) stack.push(node)
      }
      p = end + 1
    }
  }
  if (stack.length !== 1) throw new Error(`unclosed XML element <${top().name}>`)
  return root
}

export const childrenNamed = (node: XmlNode, name: string): XmlNode[] =>
  node.children.filter((child) => child.name === name)

export const childNamed = (node: XmlNode, name: string): XmlNode | undefined =>
  node.children.find((child) => child.name === name)
