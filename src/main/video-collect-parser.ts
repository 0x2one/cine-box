import type { SiteFormat } from './site-store'
import type { VideoPlayLine } from './video-types'
import { parseSourceTs, stripHtml } from './video-text'

/** 采集响应里的一条视频：列表字段 + 详情专属字段都解析，写库时各取所需 */
export interface CollectedVideo {
  sourceVideoId: string
  name: string
  pic: string
  note: string
  intro: string
  state: string
  year: string
  area: string
  lang: string
  actor: string
  vodClass: string
  director: string
  categoryId: string
  categoryName: string
  sourceTime: string
  sourceTs: number
  playLines: VideoPlayLine[]
}

export interface CollectedPage {
  page: number
  pageCount: number
  recordCount: number
  pageSize: number
  items: CollectedVideo[]
}

export type CollectParseErrorCode = 'PARSE' | 'CLOSED' | 'AUTH'

export class CollectParseError extends Error {
  readonly code: CollectParseErrorCode

  constructor(code: CollectParseErrorCode, message = code) {
    super(message)
    this.name = 'CollectParseError'
    this.code = code
  }
}

const ENTITIES: Record<string, string> = {
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
  '&amp;': '&'
}

function decodeEntities(value: string): string {
  return value.replace(/&(lt|gt|quot|#39|apos|nbsp|amp);/g, (match) => ENTITIES[match] ?? match)
}

function unwrapCdata(value: string): string {
  const match = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(value)
  return match ? match[1] : value
}

function xmlText(source: string, tag: string): string {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i')
  const match = pattern.exec(source)
  if (!match) return ''
  return decodeEntities(unwrapCdata(match[1])).trim()
}

function attrValue(source: string, name: string): string {
  const pattern = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i')
  const match = pattern.exec(source)
  return match ? decodeEntities(match[1]).trim() : ''
}

function parseXmlPlayLines(videoXml: string): VideoPlayLine[] {
  const lines: VideoPlayLine[] = []
  const dd = /<dd\b([^>]*)>([\s\S]*?)<\/dd>/gi
  let match = dd.exec(videoXml)
  while (match) {
    const flag = attrValue(match[1], 'flag') || '默认'
    const content = decodeEntities(unwrapCdata(match[2]))
    const episodes = parseEpisodes(content)
    if (episodes.length > 0) lines.push({ flag, episodes })
    match = dd.exec(videoXml)
  }
  return lines
}

/** 站点约定 `第1集$url#第2集$url`：`#` 分集、`$` 分标题与地址 */
function parseEpisodes(raw: string): { name: string; url: string }[] {
  const episodes: { name: string; url: string }[] = []
  for (const piece of raw.split('#')) {
    const text = piece.trim()
    if (!text) continue
    const index = text.indexOf('$')
    const name = (index >= 0 ? text.slice(0, index) : `第${episodes.length + 1}集`).trim()
    const url = (index >= 0 ? text.slice(index + 1) : text).trim()
    if (!url) continue
    episodes.push({ name: name || `第${episodes.length + 1}集`, url })
  }
  return episodes
}

function parseXmlVideo(itemXml: string): CollectedVideo {
  const sourceTime = xmlText(itemXml, 'last')
  return {
    sourceVideoId: xmlText(itemXml, 'id'),
    name: stripHtml(xmlText(itemXml, 'name')),
    pic: xmlText(itemXml, 'pic'),
    note: stripHtml(xmlText(itemXml, 'note')),
    intro: stripHtml(xmlText(itemXml, 'des')),
    state: xmlText(itemXml, 'state'),
    year: xmlText(itemXml, 'year'),
    area: xmlText(itemXml, 'area'),
    lang: xmlText(itemXml, 'lang'),
    actor: xmlText(itemXml, 'actor'),
    vodClass: '',
    director: xmlText(itemXml, 'director'),
    categoryId: xmlText(itemXml, 'tid'),
    categoryName: xmlText(itemXml, 'type'),
    sourceTime,
    sourceTs: parseSourceTs(sourceTime),
    playLines: parseXmlPlayLines(itemXml)
  }
}

function parseXml(raw: string): CollectedPage {
  const listMatch = /<list\b([^>]*)>/i.exec(raw)
  if (!listMatch) throw new CollectParseError('PARSE')
  const attrs = listMatch[1]
  const items: CollectedVideo[] = []
  const videoPattern = /<video\b[^>]*>([\s\S]*?)<\/video>/gi
  let match = videoPattern.exec(raw)
  while (match) {
    items.push(parseXmlVideo(match[1]))
    match = videoPattern.exec(raw)
  }
  return {
    page: Number(attrValue(attrs, 'page')) || 0,
    pageCount: Number(attrValue(attrs, 'pagecount')) || 0,
    recordCount: Number(attrValue(attrs, 'recordcount')) || 0,
    pageSize: Number(attrValue(attrs, 'pagesize')) || 0,
    items
  }
}

interface JsonRecord {
  [key: string]: unknown
}

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null
}

function valueText(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (Array.isArray(value)) {
    return value
      .map((item) => valueText(item))
      .filter(Boolean)
      .join(',')
  }
  return ''
}

function parseJsonPlayLines(item: JsonRecord): VideoPlayLine[] {
  const from = valueText(item.vod_play_from)
  const url = valueText(item.vod_play_url)
  if (!url) return []
  const flags = from ? from.split('$$$') : []
  const groups = url.split('$$$')
  const lines: VideoPlayLine[] = []
  groups.forEach((group, index) => {
    const episodes = parseEpisodes(group)
    if (episodes.length > 0) {
      lines.push({ flag: flags[index]?.trim() || `线路${index + 1}`, episodes })
    }
  })
  return lines
}

function parseJsonVideo(item: JsonRecord): CollectedVideo {
  const sourceTime = valueText(item.vod_time ?? item.last ?? item.time)
  return {
    sourceVideoId: valueText(item.vod_id ?? item.id),
    name: stripHtml(valueText(item.vod_name ?? item.name)),
    pic: valueText(item.vod_pic ?? item.pic),
    note: stripHtml(valueText(item.vod_remarks ?? item.vod_note ?? item.note)),
    intro: stripHtml(valueText(item.vod_content ?? item.vod_blurb ?? item.des ?? item.intro)),
    state: valueText(item.vod_serial ?? item.state),
    year: valueText(item.vod_year ?? item.year),
    area: valueText(item.vod_area ?? item.area),
    lang: valueText(item.vod_lang ?? item.lang),
    actor: valueText(item.vod_actor ?? item.actor),
    vodClass: valueText(item.vod_class),
    director: valueText(item.vod_director ?? item.director),
    categoryId: valueText(item.type_id ?? item.tid ?? item.category_id),
    categoryName: valueText(item.type_name ?? item.type ?? item.category_name),
    sourceTime,
    sourceTs: parseSourceTs(sourceTime),
    playLines: parseJsonPlayLines(item)
  }
}

/** 18 位 ID 直接 JSON.parse 会丢精度：先把超长纯数字 ID 包成字符串 */
function quoteLargeIds(raw: string): string {
  return raw.replace(/("(?:vod_)?id"\s*:\s*)(\d{15,})/g, '$1"$2"')
}

function parseJson(raw: string): CollectedPage {
  let data: unknown
  try {
    data = JSON.parse(quoteLargeIds(raw))
  } catch {
    throw new CollectParseError('PARSE')
  }
  const root = asRecord(data)
  if (!root) throw new CollectParseError('PARSE')
  const body = asRecord(root.data) ?? root
  const listValue = Array.isArray(root.data) ? root.data : (body.list ?? body.videos ?? root.list)
  if (!Array.isArray(listValue)) throw new CollectParseError('PARSE')
  return {
    page: Number(body.page ?? root.page) || 0,
    pageCount: Number(body.pagecount ?? body.page_count ?? root.pagecount) || 0,
    recordCount: Number(body.total ?? body.recordcount ?? root.total) || 0,
    pageSize: Number(body.limit ?? body.pagesize ?? root.limit) || 0,
    items: listValue
      .map((item) => asRecord(item))
      .filter((item): item is JsonRecord => item !== null)
      .map(parseJsonVideo)
  }
}

/**
 * 解析采集接口的一页数据（`ac=detail` 或 `ac=list`）。
 * 站点关闭 / 鉴权时抛 `CLOSED` / `AUTH`，格式不符抛 `PARSE`。
 */
export function parseCollectPage(raw: string, format: SiteFormat): CollectedPage {
  const textBody = raw.replace(/^\uFEFF/, '').trim()
  if (!textBody) throw new CollectParseError('PARSE')
  const lower = textBody.toLowerCase()
  if (lower === 'closed') throw new CollectParseError('CLOSED')
  if (lower.includes('鉴权') || lower.includes('无权限') || lower.startsWith('auth')) {
    throw new CollectParseError('AUTH')
  }
  if (format === 'xml') {
    if (!textBody.startsWith('<')) {
      throw new CollectParseError('CLOSED')
    }
    return parseXml(textBody)
  }
  if (!textBody.startsWith('{') && !textBody.startsWith('[')) {
    throw new CollectParseError('CLOSED')
  }
  return parseJson(textBody)
}
