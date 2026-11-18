import { fetchCollectText } from './collect-http'
import type { Site } from './site-store'
import { parseCollectPage } from './video-collect-parser'

/** 每页条数上限：官方 `min(pagesize, 100)` */
export const MAX_PAGE_SIZE = 100
/** 未探测 / 探测失败时的默认每页条数 */
export const DEFAULT_PAGE_SIZE = 100
/** 探测用的超时与重试：拿不到就按默认值走，别让创建任务卡在网络上 */
const PROBE_TIMEOUT_MS = 6000
const PROBE_RETRIES = 1

export interface PageSizeProbe {
  ok: boolean
  /** 站点实际生效的每页条数（1–100）；探测失败为 0 */
  pageSize: number
}

/** 把任意输入收成 0（未知）或 1–100 的整数 */
export function clampPageSize(value: unknown): number {
  const numeric = Math.floor(Number(value))
  if (!Number.isFinite(numeric) || numeric <= 0) return 0
  return Math.min(numeric, MAX_PAGE_SIZE)
}

/**
 * 用「列表模式 + pagesize=100」试抓第一页，读响应里的真实每页条数。
 * 站点部署版本不同，`pagesize` 可能被静默忽略（仍按后台配置的 20 条返回），
 * 这时任务必须按真实值翻页，进度里的「每页 N 条」才是真的。
 * 请求或解析失败不算错：调用方保持原来的默认值，采集器仍会按响应里的页大小自愈。
 */
export async function probePageSize(site: Site): Promise<PageSizeProbe> {
  try {
    const url = new URL(site.address)
    url.searchParams.set('ac', 'list')
    url.searchParams.set('pg', '1')
    url.searchParams.set('pagesize', String(MAX_PAGE_SIZE))
    // 站点地址里若残留按 id 查询的参数，会让探测只返回那几条
    url.searchParams.delete('ids')
    if (site.format === 'xml') url.searchParams.set('at', 'xml')
    else url.searchParams.delete('at')
    const response = await fetchCollectText(url.toString(), undefined, {
      timeoutMs: PROBE_TIMEOUT_MS,
      retries: PROBE_RETRIES
    })
    if (!response.ok) return { ok: false, pageSize: 0 }
    const page = parseCollectPage(response.text, site.format)
    const pageSize = clampPageSize(page.pageSize)
    return pageSize > 0 ? { ok: true, pageSize } : { ok: false, pageSize: 0 }
  } catch {
    return { ok: false, pageSize: 0 }
  }
}
