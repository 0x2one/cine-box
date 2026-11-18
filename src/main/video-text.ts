/** 视频名称归一化、搜索文本与 FTS 查询构造：纯函数，便于单独验证 */

/** 汉字 / 假名 / 谚文：按单字切分，保证任意长度中文都能命中 */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/
/** 零宽字符：合并键里必须去掉，否则同名视频会被拆成两条 */
const ZERO_WIDTH = /[\u200b-\u200d\ufeff]/g

/** 合并键：NFKC + 小写 + 去空白 / 零宽字符 */
export function makeNameKey(name: string): string {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u3000]/g, '')
    .replace(ZERO_WIDTH, '')
}

interface Tokens {
  /** 逐字切开的 CJK 单字与拉丁/数字单词 */
  list: { text: string; cjk: boolean }[]
}

/** 把名称拆成 FTS 词元：CJK 单字 + 拉丁/数字单词，其它字符当分隔符 */
function tokenize(value: string): Tokens {
  const chars = Array.from(value.normalize('NFKC').toLowerCase())
  const list: Tokens['list'] = []
  let word = ''
  const flush = (): void => {
    if (!word) return
    list.push({ text: word, cjk: false })
    word = ''
  }
  for (const char of chars) {
    if (CJK.test(char)) {
      flush()
      list.push({ text: char, cjk: true })
      continue
    }
    if (/[\p{L}\p{N}]/u.test(char)) {
      word += char
      continue
    }
    flush()
  }
  flush()
  return { list }
}

/** FTS 专用文本：名侦探柯南 → `名 侦 探 柯 南`；Spider-Man → `spider man` */
export function makeSearchText(name: string): string {
  return tokenize(name)
    .list.map((token) => token.text)
    .join(' ')
}

/**
 * 把用户输入转成 FTS5 MATCH 表达式：
 * - 连续中文 → 短语 `"柯 南"`，保证相邻；
 * - 拉丁/数字 → 前缀词 `spider*`；
 * - 混合查询用空格连接，FTS 隐式 AND。
 * 只有标点 / 空白时返回空串，调用方直接返回空列表，不做全表扫描。
 */
export function makeFtsQuery(keyword: string): string {
  const tokens = tokenize(keyword).list
  if (tokens.length === 0) return ''
  const terms: string[] = []
  let run: string[] = []
  const flushRun = (): void => {
    if (run.length === 0) return
    terms.push(`"${run.join(' ')}"`)
    run = []
  }
  for (const token of tokens) {
    if (token.cjk) {
      run.push(token.text)
      continue
    }
    flushRun()
    // 词元只含字母 / 数字，不会带 FTS 语法字符，加 * 做前缀匹配
    terms.push(`${token.text}*`)
  }
  flushRun()
  return terms.join(' ')
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

/** 简介是纯文本：先解实体再去标签，避免把 HTML 原样存进列表 */
export function stripHtml(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(lt|gt|quot|#39|apos|nbsp|amp);/g, (match) => ENTITIES[match] ?? match)
    .replace(/\r\n?/g, '\n')
    .replace(/[\t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 列表摘要：最多 160 字，并返回是否被截断 */
export function makeExcerpt(value: string, max = 160): { text: string; truncated: boolean } {
  const text = stripHtml(value)
  if (text.length <= max) return { text, truncated: false }
  return { text: text.slice(0, max), truncated: true }
}

/** 按字符数截断，避免单条简介 / 演员文本把库撑大 */
export function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max)
}

/**
 * 站点时间解析成 epoch ms：
 * 支持 `2026-11-16 12:00:00`、ISO、纯数字秒/毫秒；解析失败返回 0，由调用方兜底。
 */
export function parseSourceTs(value: string): number {
  const text = value.trim()
  if (!text) return 0
  if (/^\d{10,13}$/.test(text)) {
    const numeric = Number(text)
    if (!Number.isFinite(numeric)) return 0
    return text.length === 13 ? numeric : numeric * 1000
  }
  const parsed = Date.parse(text.replace(' ', 'T'))
  return Number.isNaN(parsed) ? 0 : parsed
}
