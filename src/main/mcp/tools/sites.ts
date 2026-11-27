import * as z from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/server'
import { MCP_CHANNELS } from '../channels'
import type { McpInvoke } from '../mcp-types'
import type { Site, SiteInput } from '../../site-store'
import { ToolCallError, callTool, runTool, siteIdSchema } from './helpers'

const siteFormatSchema = z.enum(['xml', 'json']).describe('采集接口格式：xml 或 json')

const siteFields = {
  name: z.string().min(1).describe('站点名称'),
  display: z.string().optional().describe('显示名称，留空沿用名称'),
  address: z.string().min(1).describe('采集接口地址（http/https URL）'),
  format: siteFormatSchema.optional(),
  remark: z.string().optional().describe('备注'),
  onlineSearch: z.boolean().optional().describe('是否支持在线检索（wd 参数）'),
  disabled: z.boolean().optional().describe('是否禁用该站点'),
  adult: z.boolean().optional().describe('是否 18+ 站点')
}

export function registerSiteTools(server: McpServer, invoke: McpInvoke): void {
  server.registerTool(
    'site_list',
    {
      title: '列出站点',
      description: '返回全部采集站点（含禁用 / 18+ 站点），可直接拿 id 供其它工具使用。',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    () => runTool(() => callTool(invoke, MCP_CHANNELS.sitesList))
  )

  server.registerTool(
    'site_add',
    {
      title: '添加站点',
      description:
        '新增一个采集站点。name / address 必填；新站点默认启用、非 18+，除非显式传 disabled / adult。',
      inputSchema: z.object(siteFields),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
    },
    (args) =>
      runTool(() => {
        const input: SiteInput = {
          name: args.name,
          address: args.address,
          format: args.format ?? 'xml',
          display: args.display ?? '',
          remark: args.remark ?? '',
          onlineSearch: args.onlineSearch ?? false,
          disabled: args.disabled ?? false,
          adult: args.adult ?? false
        }
        return callTool(invoke, MCP_CHANNELS.sitesAdd, input)
      })
  )

  server.registerTool(
    'site_update',
    {
      title: '编辑站点',
      description:
        '编辑站点，只传要改的字段，未传字段沿用当前值。改地址 / 格式会触发该站点旧视频缓存的后台清理。',
      inputSchema: z.object({
        id: siteIdSchema,
        name: z.string().min(1).optional().describe('站点名称'),
        display: z.string().optional().describe('显示名称'),
        address: z.string().min(1).optional().describe('采集接口地址'),
        format: siteFormatSchema.optional(),
        remark: z.string().optional().describe('备注'),
        onlineSearch: z.boolean().optional().describe('是否支持在线检索'),
        disabled: z.boolean().optional().describe('是否禁用'),
        adult: z.boolean().optional().describe('是否 18+ 站点')
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
    },
    (args) =>
      runTool(async () => {
        const sites = await callTool<Site[]>(invoke, MCP_CHANNELS.sitesList)
        const current = sites.find((site) => site.id === args.id)
        if (!current) throw new ToolCallError('NOT_FOUND', `站点 ${args.id} 不存在`)
        const input: SiteInput = {
          name: args.name ?? current.name,
          display: args.display ?? current.display,
          address: args.address ?? current.address,
          format: args.format ?? current.format,
          remark: args.remark ?? current.remark,
          onlineSearch: args.onlineSearch ?? current.onlineSearch,
          disabled: args.disabled ?? current.disabled,
          adult: args.adult ?? current.adult
        }
        return callTool(invoke, MCP_CHANNELS.sitesUpdate, args.id, input)
      })
  )

  server.registerTool(
    'site_test_search',
    {
      title: '测试站点在线检索',
      description:
        '用关键词真实请求一次站点采集接口，只解析、不写缓存库，返回是否支持按片名检索及前几条命中。',
      inputSchema: z.object({
        siteId: siteIdSchema,
        keyword: z.string().min(1).describe('要测试的片名关键词')
      }),
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    (args) =>
      runTool(() =>
        callTool(invoke, MCP_CHANNELS.sitesSearchTest, {
          siteId: args.siteId,
          keyword: args.keyword
        })
      )
  )

  server.registerTool(
    'site_online_categories',
    {
      title: '获取站点在线分类',
      description:
        '返回站点已入库的在线分类（id 为绑定用的 siteCategoryId）；库里没有时会先向站点抓取一次。',
      inputSchema: z.object({ siteId: siteIdSchema }),
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    (args) => runTool(() => callTool(invoke, MCP_CHANNELS.sitesCategories, args.siteId))
  )
}
