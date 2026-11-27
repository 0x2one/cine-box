import * as z from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/server'
import { MCP_CHANNELS } from '../channels'
import type { McpInvoke } from '../mcp-types'
import type { BackupListResult, RestoreSource } from '../../backup-store'
import { ToolCallError, callTool, runTool, siteIdSchema } from './helpers'

export function registerBackupLogTools(server: McpServer, invoke: McpInvoke): void {
  server.registerTool(
    'backup_create',
    {
      title: '立即创建备份',
      description:
        '把当前站点、在线分类、本地分类、绑定与定时计划写成一份备份，保存到备份目录。空库会拒绝创建。',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
    },
    () => runTool(() => callTool(invoke, MCP_CHANNELS.backupCreate))
  )

  server.registerTool(
    'backup_restore',
    {
      title: '恢复备份',
      description:
        '用备份覆盖当前站点 / 分类 / 绑定 / 定时计划。恢复前会自动备份当前数据；必须传 confirm=true。' +
        'id 与 path 只能传一个：id 是 backup_list 里的记录 id，path 是外部备份文件的绝对路径。',
      inputSchema: z.object({
        id: z.string().optional().describe('备份记录 id（backup_list 返回）'),
        path: z.string().optional().describe('外部备份文件的绝对路径'),
        confirm: z.boolean().describe('必须为 true；恢复会覆盖当前数据，操作不可撤销')
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
    },
    (args) =>
      runTool(() => {
        if (args.confirm !== true) {
          throw new ToolCallError('INVALID_INPUT', '恢复备份必须传 confirm=true')
        }
        const id = typeof args.id === 'string' ? args.id.trim() : ''
        const path = typeof args.path === 'string' ? args.path.trim() : ''
        const hasId = id !== ''
        const hasPath = path !== ''
        if (hasId === hasPath) {
          throw new ToolCallError('INVALID_INPUT', 'id 与 path 必须且只能传一个')
        }
        const source: RestoreSource = hasId ? { id } : { path }
        return callTool(invoke, MCP_CHANNELS.backupRestore, source)
      })
  )

  server.registerTool(
    'backup_list',
    {
      title: '列出备份',
      description: '返回备份目录与全部备份记录（含自动安全备份、数据量与创建时间）。',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    () => runTool(() => callTool(invoke, MCP_CHANNELS.backupList))
  )

  server.registerTool(
    'backup_directory',
    {
      title: '获取备份目录',
      description: '返回本机备份文件的存放目录绝对路径。',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    () =>
      runTool(async () => {
        const list = await callTool<BackupListResult>(invoke, MCP_CHANNELS.backupList)
        return { directory: list.directory }
      })
  )

  server.registerTool(
    'log_list',
    {
      title: '获取日志',
      description: '读取采集日志（可按站点、级别、时间过滤，默认最新在前）。',
      inputSchema: z.object({
        siteId: siteIdSchema.optional().describe('只查这个站点'),
        level: z.enum(['info', 'warn', 'error']).optional().describe('日志级别'),
        since: z.string().optional().describe('只返回这个 ISO 时间之后的日志'),
        order: z.enum(['newest', 'oldest']).optional().describe('排序，默认 newest'),
        limit: z.number().int().min(1).max(1000).optional().describe('最多返回条数')
      }),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    (args) => runTool(() => callTool(invoke, MCP_CHANNELS.logsList, args))
  )

  server.registerTool(
    'log_clear',
    {
      title: '清空日志',
      description: '清空采集日志；传 siteId 只清这个站点，省略则清空全部。',
      inputSchema: z.object({ siteId: siteIdSchema.optional().describe('只清这个站点的日志') }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
    },
    (args) =>
      runTool(() =>
        callTool(invoke, MCP_CHANNELS.logsClear, args.siteId ? { siteId: args.siteId } : undefined)
      )
  )
}
