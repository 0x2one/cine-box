import * as z from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/server'
import { MCP_CHANNELS } from '../channels'
import type { McpInvoke } from '../mcp-types'
import type { LanServiceState } from '../../lan/lan-types'
import { callTool, runTool } from './helpers'

export function registerLanCapacityTools(server: McpServer, invoke: McpInvoke): void {
  server.registerTool(
    'lan_state',
    {
      title: '获取共享服务状态',
      description:
        '返回局域网影院的运行状态、监听地址、全部可访问 URL 与本机 IPv4 列表（含未启动时的预览地址）。',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    () => runTool(() => callTool(invoke, MCP_CHANNELS.lanState))
  )

  server.registerTool(
    'lan_start',
    {
      title: '启动共享服务 / 设置监听',
      description:
        '启动局域网影院；host / port 即监听设置，省略时沿用当前保存值。换地址或端口会重启服务，成功后配置落盘。',
      inputSchema: z.object({
        host: z
          .string()
          .optional()
          .describe('监听地址：0.0.0.0（全部网卡）或本机 IPv4；省略沿用当前值'),
        port: z.number().int().min(1024).max(65535).optional().describe('监听端口；省略沿用当前值')
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
    },
    (args) =>
      runTool(async () => {
        const state = await callTool<LanServiceState>(invoke, MCP_CHANNELS.lanState)
        return callTool(invoke, MCP_CHANNELS.lanStart, {
          host: args.host ?? state.host,
          port: args.port ?? state.port
        })
      })
  )

  server.registerTool(
    'lan_stop',
    {
      title: '停止共享服务',
      description: '关闭局域网影院的 HTTP 监听；已打开的网页请求会失败。',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    () => runTool(() => callTool(invoke, MCP_CHANNELS.lanStop))
  )

  server.registerTool(
    'capacity_get',
    {
      title: '查看缓存容量',
      description:
        '查看视频缓存详情：数据库 / 详情文件体积、视频与来源数、日志数、按站点的明细。只读，不提供清理。',
      inputSchema: z.object({
        sites: z.boolean().optional().describe('是否返回按站点的明细，默认 true；传 false 更快')
      }),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    (args) =>
      runTool(() => callTool(invoke, MCP_CHANNELS.videosCapacity, { sites: args.sites ?? true }))
  )
}
