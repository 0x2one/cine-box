import { net } from 'electron'

export const COLLECT_TIMEOUT = 20_000
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

export type CollectHttpError = 'NETWORK' | 'HTTP' | 'ABORT'

export type CollectHttpResult =
  | { ok: true; text: string; status: number }
  | { ok: false; error: CollectHttpError; status?: number; message?: string }

export interface CollectHttpOptions {
  /** 单次请求超时，默认 20s；探测这类「拿不到就走默认值」的请求可以调短 */
  timeoutMs?: number
  /** 失败后的额外重试次数，默认 2 */
  retries?: number
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 采集站 GET：Chrome UA、默认 20s 超时，网络错误 / 429 / 5xx 最多重试 2 次 */
export async function fetchCollectText(
  url: string,
  signal?: AbortSignal,
  options: CollectHttpOptions = {}
): Promise<CollectHttpResult> {
  const timeoutMs = options.timeoutMs ?? COLLECT_TIMEOUT
  const retries = Math.max(0, options.retries ?? 2)
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (signal?.aborted) return { ok: false, error: 'ABORT' }
    const controller = new AbortController()
    let abortedByCaller = false
    const onAbort = (): void => {
      abortedByCaller = true
      controller.abort()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await net.fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: '*/*',
          'Accept-Language': 'zh-CN',
          'Cache-Control': 'max-age=0'
        },
        signal: controller.signal
      })
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500
        if (retryable && attempt < retries) {
          await wait(500 * (attempt + 1))
          continue
        }
        return {
          ok: false,
          error: 'HTTP',
          status: response.status,
          message: `HTTP ${response.status}`
        }
      }
      const text = await response.text()
      return { ok: true, text, status: response.status }
    } catch {
      if (abortedByCaller) return { ok: false, error: 'ABORT' }
      if (attempt < retries) {
        await wait(500 * (attempt + 1))
        continue
      }
      return { ok: false, error: 'NETWORK' }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }
  return { ok: false, error: 'NETWORK' }
}
