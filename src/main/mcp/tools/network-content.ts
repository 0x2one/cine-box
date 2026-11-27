import * as z from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/server'
import { MCP_CHANNELS } from '../channels'
import type { McpInvoke } from '../mcp-types'
import type { AppSettings } from '../../app-settings'
import type { NetworkSettings } from '../../network/network-types'
import type { NetworkTestResult } from '../../network/network-manager'
import { callTool, networkPatchSchema, runTool } from './helpers'

/** 代理密码只回显占位符；Agent 不需要知道真实值 */
function redactNetwork(network: NetworkSettings): NetworkSettings {
  return { ...network, password: network.password ? '***' : '' }
}

/** password 传 *** 表示保留原密码；省略也保留 */
function mergeNetwork(current: NetworkSettings, patch: Partial<NetworkSettings>): NetworkSettings {
  const password =
    patch.password === undefined || patch.password === '***' ? current.password : patch.password
  return { ...current, ...patch, password }
}

interface SetNetworkResult {
  ok: boolean
  error?: string
  message?: string
  settings: AppSettings
}

export function registerNetworkContentTools(server: McpServer, invoke: McpInvoke): void {
  server.registerTool(
    'network_get',
    {
      title: '获取网络代理配置',
      description: '返回当前代理模式、协议、地址、端口、身份验证与验证地址；密码以 *** 脱敏。',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    () =>
      runTool(async () => {
        const settings = await callTool<AppSettings>(invoke, MCP_CHANNELS.settingsGet)
        return { network: redactNetwork(settings.network) }
      })
  )

  server.registerTool(
    'network_set',
    {
      title: '配置网络代理',
      description:
        '修改代理配置，只传要改的字段。保存后立即套用到 Chromium 网络栈；自定义模式地址 / 端口不完整会返回 INVALID_PROXY。' +
        'password 传 *** 表示保留原密码，省略也保留。',
      inputSchema: networkPatchSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    (args) =>
      runTool(async () => {
        const settings = await callTool<AppSettings>(invoke, MCP_CHANNELS.settingsGet)
        const next = mergeNetwork(settings.network, args)
        const result = await callTool<SetNetworkResult>(
          invoke,
          MCP_CHANNELS.settingsSetNetwork,
          next
        )
        return {
          ok: result.ok,
          ...(result.error ? { error: result.error } : {}),
          ...(result.message ? { message: result.message } : {}),
          network: redactNetwork(result.settings.network)
        }
      })
  )

  server.registerTool(
    'network_test',
    {
      title: '验证代理 / 网络',
      description:
        '用当前或草稿代理配置访问验证地址，返回耗时、HTTP 状态与失败原因码（未保存的草稿也可以验证）。',
      inputSchema: z.object({
        settings: networkPatchSchema.optional().describe('草稿代理配置；省略使用当前已保存配置'),
        url: z.string().optional().describe('验证地址；省略使用配置里的 testUrl')
      }),
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    (args) =>
      runTool(async () => {
        const settings = await callTool<AppSettings>(invoke, MCP_CHANNELS.settingsGet)
        const draft = args.settings
          ? mergeNetwork(settings.network, args.settings)
          : settings.network
        return callTool<NetworkTestResult>(invoke, MCP_CHANNELS.settingsTestNetwork, {
          settings: draft,
          ...(args.url ? { url: args.url } : {})
        })
      })
  )

  server.registerTool(
    'content_get_adult',
    {
      title: '获取 18+ 开关',
      description: '返回「设置 › 内容」里的 18+ 内容总开关。',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    () =>
      runTool(async () => {
        const settings = await callTool<AppSettings>(invoke, MCP_CHANNELS.settingsGet)
        return { allowAdult: settings.allowAdult }
      })
  )

  server.registerTool(
    'content_set_adult',
    {
      title: '设置 18+ 开关',
      description:
        '打开 / 关闭 18+ 内容总开关。关闭后标记为 18+ 的站点、分类与视频在展示端与共享页不可见，控制台仍可见。',
      inputSchema: z.object({
        enabled: z.boolean().describe('true = 显示 18+ 内容，false = 隐藏')
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    (args) =>
      runTool(async () => {
        const settings = await callTool<AppSettings>(
          invoke,
          MCP_CHANNELS.settingsSetAllowAdult,
          args.enabled
        )
        return { allowAdult: settings.allowAdult }
      })
  )
}
