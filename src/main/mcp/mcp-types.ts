import type { LanAddress } from '../lan/lan-types'
import type { McpSettings, McpSettingsStore } from './mcp-settings'

/** MCP 服务启动 / 配置错误码：与设置面板的提示一一对应 */
export type McpError =
  | 'INVALID_INPUT'
  | 'INVALID_HOST'
  | 'INVALID_PORT'
  | 'TOKEN_REQUIRED'
  | 'PORT_IN_USE'
  | 'ADDRESS_UNAVAILABLE'
  | 'PERMISSION'
  | 'START_FAILED'

export interface McpState {
  running: boolean
  /** 运行中是实际监听配置；未运行时是最近一次保存的配置 */
  host: string
  port: number
  /** 形如 http://127.0.0.1:3927/mcp；绑定 0.0.0.0 时列出本机每个 IPv4 */
  urls: string[]
  /** 当前机器上的 IPv4 地址，面板的下拉框用 */
  addresses: LanAddress[]
  /** 最近一次启动失败的原因码；成功启动 / 停止后清空 */
  error?: McpError
  /** ISO 8601；服务没启动时为空串 */
  startedAt: string
}

export interface McpSnapshot {
  settings: McpSettings
  state: McpState
}

export interface McpConfigureResult {
  ok: boolean
  error?: McpError
  message?: string
  settings: McpSettings
  state: McpState
}

/** MCP 工具调用主进程 IPC handler 的统一入口 */
export type McpInvoke = (channel: string, ...args: unknown[]) => Promise<unknown>

export interface McpServerOptions {
  /** 由 app-settings 适配；MCP 模块不直接读 electron */
  settings: McpSettingsStore
  version: string
  invoke: McpInvoke
  /** 状态变化（启动 / 停止 / 启动失败）时回调；主进程用它推 mcp:changed */
  onChange?: (snapshot: McpSnapshot) => void
  /** 测试可注入固定网卡列表 */
  listAddresses?: () => LanAddress[]
}
