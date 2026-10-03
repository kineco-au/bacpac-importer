import { describe, expect, test } from 'bun:test'
import { childNamed, childrenNamed, decodeEntities, parseXml } from '../../src/xml.ts'

describe('parseXml', () => {
  test('reads elements, attributes and nesting', () => {
    const root = parseXml(`<?xml version="1.0"?><a x="1" y='two'><b/><b z="3">text</b></a>`)
    const a = childNamed(root, 'a')
    expect(a?.attributes).toEqual({ x: '1', y: 'two' })
    expect(childrenNamed(a as never, 'b').map((b) => b.text)).toEqual(['', 'text'])
    expect(childrenNamed(a as never, 'b')[1]?.attributes.z).toBe('3')
  })

  test('keeps CDATA verbatim and decodes entities elsewhere', () => {
    const root = parseXml(`<v a="&lt;&amp;&#65;&#x42;"><![CDATA[('<a> & b')]]> &gt;</v>`)
    const v = childNamed(root, 'v')
    expect(v?.attributes.a).toBe('<&AB')
    expect(v?.text).toBe("('<a> & b') >")
  })

  test('skips comments and declarations', () => {
    const root = parseXml('<!DOCTYPE x><!-- <not/> --><a><!-- c --><b/></a>')
    expect(childNamed(root, 'a')?.children.map((c) => c.name)).toEqual(['b'])
  })

  test('refuses a document that does not close', () => {
    expect(() => parseXml('<a><b></a>')).toThrow('unexpected closing tag')
    expect(() => parseXml('<a><b/>')).toThrow('unclosed XML element <a>')
  })

  test('leaves an unknown entity alone', () => {
    expect(decodeEntities('&nbsp;&quot;')).toBe('&nbsp;"')
  })
})
