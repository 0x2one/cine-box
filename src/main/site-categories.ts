import { net } from 'electron'
import type { Site } from './site-store'
import {
  parseJsonCategories,
  parseXmlCategories,
  type SiteCategory
} from './site-category-parser'

export type SiteCategoriesError = 'NOT_FOUND' | 'NETWORK' | 'HTTP' | 'PARSE'

export type SiteCategoriesResult =
  | { ok: true; categories: SiteCategory[] }
  | { ok: false; error: SiteCategoriesError; message?: string }

const REQUEST_TIMEOUT = 15000
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** 在站点地址上补 ac=list；XML 站点再补 at=xml，JSON 站点去掉 at 走默认输出 */
function buildUrl(site: Site): string {
  const url = new URL(site.address)
  url.searchParams.set('ac', 'list')
  if (site.format === 'xml') url.searchParams.set('at', 'xml')
  else url.searchParams.delete('at')
  return url.toString()
}

/** 按站点保存的格式请求 ac=list，并解析出分类列表 */
export async function fetchSiteCategories(site: Site): Promise<SiteCategoriesResult> {
  let response: Response
  try {
    response = await net.fetch(buildUrl(site), {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: '*/*',
        'Accept-Language': 'zh-CN'
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT)
    })
  } catch {
    return { ok: false, error: 'NETWORK' }
  }

  if (!response.ok) return { ok: false, error: 'HTTP', message: `HTTP ${response.status}` }

  let raw: string
  try {
    raw = await response.text()
  } catch {
    return { ok: false, error: 'NETWORK' }
  }

  try {
    const categories = site.format === 'xml' ? parseXmlCategories(raw) : parseJsonCategories(raw)
    return { ok: true, categories }
  } catch {
    return { ok: false, error: 'PARSE' }
  }
}
