/**
 * 网络代理的设置形状、默认值与校验规则。
 *
 * 这一份是主进程的唯一来源：app-settings 负责落盘、network-manager 负责套用到
 * Chromium 网络栈与代理桥接、渲染层的表单只通过 IPC 读写。渲染层那份类型手写在
 * `src/preload/api.d.ts`（项目约定：IPC 类型不跨进程导入）。
 */

/** 代理验证的默认地址：能连通说明代理链路可用 */
export const DEFAULT_NETWORK_TEST_URL = 'https://www.google.com'

/** 自定义代理的默认地址：本机 Clash / Mihomo 一类的常见 HTTP 端口 */
export const DEFAULT_PROXY_HOST = '127.0.0.1'
export const DEFAULT_PROXY_PORT = 7897

export type NetworkProxyMode = 'off' | 'system' | 'custom'
export type NetworkProxyType = 'http' | 'socks5'

export interface NetworkSettings {
  /** 禁用（强制直连）/ 系统代理 / 自定义 */
  mode: NetworkProxyMode
  /** 自定义代理的协议：HTTP(S) 代理或 SOCKS5 代理 */
  type: NetworkProxyType
  /** 代理服务器地址（域名 / IPv4 / IPv6，不带协议前缀） */
  host: string
  /** 代理端口；缺失或 0 时用默认 7897 */
  port: number
  /** 是否启用代理身份验证（默认关闭） */
  authEnabled: boolean
  username: string
  password: string
  /** 代理验证使用的地址 */
  testUrl: string
}

export const DEFAULT_NETWORK_SETTINGS: NetworkSettings = {
  mode: 'off',
  type: 'http',
  host: DEFAULT_PROXY_HOST,
  port: DEFAULT_PROXY_PORT,
  authEnabled: false,
  username: '',
  password: '',
  testUrl: DEFAULT_NETWORK_TEST_URL
}

/** 落盘 / IPC 都可能拿到老版本或残缺的对象：这里收敛成合法形状，不做业务校验 */
export function normalizeNetworkSettings(value: unknown): NetworkSettings {
  const source = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const mode: NetworkProxyMode =
    source.mode === 'system' || source.mode === 'custom' ? source.mode : 'off'
  const type: NetworkProxyType =
    source.type === 'socks5' || source.type === 'socks' ? 'socks5' : 'http'
  const host =
    (typeof source.host === 'string' ? source.host.trim().replace(/^\[|\]$/g, '') : '') ||
    DEFAULT_PROXY_HOST
  const rawPort = Number(source.port)
  const port =
    Number.isInteger(rawPort) && rawPort > 0 && rawPort <= 65535
      ? Math.trunc(rawPort)
      : DEFAULT_PROXY_PORT
  const username = typeof source.username === 'string' ? source.username.trim() : ''
  const password = typeof source.password === 'string' ? source.password.slice(0, 1024) : ''
  const rawTestUrl = typeof source.testUrl === 'string' ? source.testUrl.trim() : ''
  return {
    mode,
    type,
    host,
    port,
    authEnabled: Boolean(source.authEnabled),
    username,
    password,
    testUrl: rawTestUrl || DEFAULT_NETWORK_TEST_URL
  }
}

/**
 * 地址只接受「域名 / IPv4 / IPv6」三种形状：不允许带协议、路径、空白或端口。
 * 端口单独一个字段，避免 host 里混进 `host:port` 之后拼接出双重端口。
 */
export function isValidProxyHost(host: string): boolean {
  const value = host.trim()
  if (!value || value.length > 253) return false
  if (/[\s/@?#]/.test(value)) return false
  // IPv6 可能带方括号，normalize 已经去掉；裸地址里允许冒号
  if (value.includes(':')) return /^[0-9a-f:.]+$/i.test(value) && value.split(':').length >= 3
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    return value.split('.').every((part) => Number(part) >= 0 && Number(part) <= 255)
  }
  return /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(
    value
  )
}

export function isValidProxyPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

/** 自定义代理是否填完整、能拿去连：只有 mode=custom 时才需要 */
export function isValidProxyEndpoint(settings: NetworkSettings): boolean {
  if (!isValidProxyHost(settings.host) || !isValidProxyPort(settings.port)) return false
  if (settings.authEnabled && !settings.username.trim()) return false
  return true
}

/** 代理验证的地址：只允许 http(s)，空串按默认地址处理 */
export function resolveTestUrl(value: string | null | undefined): string | null {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_NETWORK_TEST_URL
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.href
  } catch {
    return null
  }
}

/** 带方括号的 host:port，给提示文案和上游 CONNECT 用 */
export function proxyAddress(settings: NetworkSettings): string {
  if (!settings.host) return '未填写'
  const host = settings.host.includes(':') ? `[${settings.host}]` : settings.host
  return settings.port > 0 ? `${host}:${settings.port}` : host
}

/** 设置页「当前生效」与验证结果里的一段人话 */
export function describeNetwork(settings: NetworkSettings): string {
  if (settings.mode === 'system') return '跟随系统代理'
  if (settings.mode === 'off') return '直连（不使用代理）'
  const type = settings.type === 'socks5' ? 'SOCKS5' : 'HTTP'
  const auth = settings.authEnabled ? ' · 身份验证' : ''
  return `${type} 代理 ${proxyAddress(settings)}${auth}`
}

/** 只比较真正影响代理链路的字段：改验证地址不该触发重连 */
export function networkProxyKey(settings: NetworkSettings): string {
  return JSON.stringify([
    settings.mode,
    settings.type,
    settings.host,
    settings.port,
    settings.authEnabled,
    settings.username,
    settings.password
  ])
}
