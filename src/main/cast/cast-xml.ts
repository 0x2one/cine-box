/**
 * 投屏用的一小组 XML 工具。
 *
 * 设备描述和 SOAP 响应都是「很扁」的 XML，只为几个字段引一个完整解析器不划算；
 * 这里用正则取标签，兼容命名空间前缀（`<s:Envelope>`）和 CDATA。如果以后遇到
 * 结构复杂的设备，再换成真正的解析器，调用点已经收在这一个文件里。
 */

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'"
}

export function escapeXml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => {
      try {
        return String.fromCodePoint(parseInt(hex, 16))
      } catch {
        return ''
      }
    })
    .replace(/&#(\d+);/g, (_, dec: string) => {
      try {
        return String.fromCodePoint(Number(dec))
      } catch {
        return ''
      }
    })
    .replace(/&([a-z]+);/gi, (whole, name: string) => ENTITIES[name.toLowerCase()] ?? whole)
}

function stripCdata(value: string): string {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 取第一个同名标签的文本；标签允许带命名空间前缀 */
export function xmlText(xml: string, tag: string): string {
  const name = escapeRegExp(tag)
  const pattern = new RegExp(
    `<(?:[\\w-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`,
    'i'
  )
  const match = pattern.exec(xml)
  return match ? decodeXml(stripCdata(match[1])).trim() : ''
}

/** 取所有同名标签的完整片段（含标签本身），用于 `<service>` 这类重复块 */
export function xmlBlocks(xml: string, tag: string): string[] {
  const name = escapeRegExp(tag)
  const pattern = new RegExp(
    `<(?:[\\w-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`,
    'gi'
  )
  const blocks: string[] = []
  let match: RegExpExecArray | null
  while ((match = pattern.exec(xml))) blocks.push(match[0])
  return blocks
}

/** 播放列表净化：投给某些电视前去掉 discontinuity 标记（当贝实测会因此跳段） */
export function stripDiscontinuity(playlist: string): string {
  return playlist
    .split(/\r?\n/)
    .filter(
      (line) =>
        !line.startsWith('#EXT-X-DISCONTINUITY') && !line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE')
    )
    .join('\n')
}
