import { isValidLanHost, isValidLanPort } from '../lan/lan-config'
import { LAN_ALL_INTERFACES, type LanAddress } from '../lan/lan-types'

/** MCP 默认监听端口：避开局域网影院的 8090，也不和常见开发端口冲突 */
export const MCP_DEFAULT_PORT = 3927
/** 只允许本机回环；越界由后面的 token 规则拦住 */
export const MCP_DEFAULT_HOST = '127.0.0.1'
/** token 只用于本机 MCP 客户端鉴权，长度不需要太长，但留足余量 */
export const MCP_MAX_TOKEN_LENGTH = 256

export interface McpSettings {
  /** 是否随应用启动 MCP 服务 */
  enabled: boolean
  /** 监听地址：127.0.0.1 / 0.0.0.0 / 本机 IPv4 */
  host: string
  /** 监听端口（1024–65535） */
  port: number
  /** 访问令牌；空串表示回环监听不鉴权，非回环监听必须非空 */
  token: string
}

export const DEFAULT_MCP_SETTINGS: McpSettings = {
  enabled: false,
  host: MCP_DEFAULT_HOST,
  port: MCP_DEFAULT_PORT,
  token: ''
}

/** 设置文件 / IPC 都可能拿到残缺对象：只收敛形状，不做业务校验 */
export function normalizeMcpSettings(value: unknown): McpSettings {
  const source = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const host =
    typeof source.host === 'string' && isValidLanHost(source.host.trim())
      ? source.host.trim()
      : DEFAULT_MCP_SETTINGS.host
  const rawPort = Number(source.port)
  const port =
    Number.isInteger(rawPort) && isValidLanPort(rawPort) ? Math.trunc(rawPort) : MCP_DEFAULT_PORT
  const token =
    typeof source.token === 'string'
      ? source.token.trim().slice(0, MCP_MAX_TOKEN_LENGTH)
      : DEFAULT_MCP_SETTINGS.token
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : DEFAULT_MCP_SETTINGS.enabled,
    host,
    port,
    token
  }
}

/**
 * 监听地址 / 端口校验：即使服务关闭也拒绝非法监听配置，
 * 但关闭时不强制 token，否则用户无法关掉一份残缺配置。
 */
export function validateMcpListener(settings: McpSettings): 'INVALID_HOST' | 'INVALID_PORT' | null {
  if (!isValidLanHost(settings.host)) return 'INVALID_HOST'
  if (!isValidLanPort(settings.port)) return 'INVALID_PORT'
  return null
}

/**
 * 业务校验：只在准备落盘 / 启动时调用。
 * 非回环监听必须设置令牌，避免把可以改写片库的 HTTP 服务裸奔在局域网里。
 */
export function validateMcpSettings(
  settings: McpSettings
): 'INVALID_HOST' | 'INVALID_PORT' | 'TOKEN_REQUIRED' | null {
  const listenerProblem = validateMcpListener(settings)
  if (listenerProblem) return listenerProblem
  if (settings.enabled && !isLoopbackHost(settings.host) && !settings.token) {
    return 'TOKEN_REQUIRED'
  }
  return null
}

export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
}

/** 绑定全部网卡时，给面板 / 客户端展示本机所有可用 IPv4 的 MCP 地址 */
export function mcpUrls(host: string, port: number, addresses: LanAddress[]): string[] {
  if (host !== LAN_ALL_INTERFACES) return [`http://${host}:${port}/mcp`]
  const lan = addresses.filter((item) => !item.loopback)
  const chosen = lan.length > 0 ? lan : addresses.filter((item) => item.loopback)
  const list = chosen.map((item) => `http://${item.address}:${port}/mcp`)
  return list.length > 0 ? list : [`http://${MCP_DEFAULT_HOST}:${port}/mcp`]
}

/** 生产环境由 index.ts 适配 appSettingsStore；单测可注入内存实现 */
export interface McpSettingsStore {
  get: () => McpSettings
  save: (settings: McpSettings) => McpSettings
}
