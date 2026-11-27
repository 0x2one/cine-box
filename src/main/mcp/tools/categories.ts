import * as z from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/server'
import { MCP_CHANNELS } from '../channels'
import type { McpInvoke } from '../mcp-types'
import type { CategoryPlacement, VideoCategory, VideoCategoryInput } from '../../category-store'
import type { BindingTarget } from '../../binding-store'
import { ToolCallError, callTool, categoryIdSchema, runTool, siteIdSchema } from './helpers'

const bindingTargetSchema = z.object({
  siteId: siteIdSchema,
  siteCategoryId: z
    .string()
    .min(1)
    .describe('站点在线分类 id（site_online_categories 返回的 id，不是 sourceId）')
})

const placementSchema = z
  .enum(['before', 'after', 'inside'])
  .describe('before / after：放到目标同级的前后；inside：成为目标的子分类')

export function registerCategoryTools(server: McpServer, invoke: McpInvoke): void {
  server.registerTool(
    'category_list',
    {
      title: '列出视频分类',
      description:
        '返回本地视频分类树（扁平列表，按同级 sortOrder 排好）。默认包含 18+ 分类；分类 id 用于其它分类 / 视频工具。',
      inputSchema: z.object({
        includeAdult: z
          .boolean()
          .optional()
          .describe('是否包含 18+ 分类，默认 true（管理口径）；传 false 查看展示端口径')
      }),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    (args) =>
      runTool(() =>
        callTool(invoke, MCP_CHANNELS.categoriesList, {
          includeAdult: args.includeAdult ?? true
        })
      )
  )

  server.registerTool(
    'category_create',
    {
      title: '创建视频分类',
      description:
        '创建本地视频分类；parentId 为空或省略时创建一级分类，传 parentId 即创建子分类。',
      inputSchema: z.object({
        name: z.string().min(1).describe('分类名称（同级不能重名）'),
        parentId: z.string().nullable().optional().describe('上级分类 id；不传 = 一级分类'),
        adult: z.boolean().optional().describe('是否标记为 18+ 分类（整棵子树继承）')
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
    },
    (args) =>
      runTool(() => {
        const input: VideoCategoryInput = {
          name: args.name,
          ...(args.parentId !== undefined ? { parentId: args.parentId } : {}),
          ...(args.adult !== undefined ? { adult: args.adult } : {})
        }
        return callTool(invoke, MCP_CHANNELS.categoriesCreate, input)
      })
  )

  server.registerTool(
    'category_create_child',
    {
      title: '创建子分类',
      description: '在指定分类下创建子分类（category_create 的显式版本，parentId 必填）。',
      inputSchema: z.object({
        parentId: categoryIdSchema.describe('上级分类 id（32 位十六进制）'),
        name: z.string().min(1).describe('子分类名称（同级不能重名）'),
        adult: z.boolean().optional().describe('是否标记为 18+ 分类')
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
    },
    (args) =>
      runTool(() => {
        const input: VideoCategoryInput = {
          name: args.name,
          parentId: args.parentId,
          ...(args.adult !== undefined ? { adult: args.adult } : {})
        }
        return callTool(invoke, MCP_CHANNELS.categoriesCreate, input)
      })
  )

  server.registerTool(
    'category_update',
    {
      title: '编辑视频分类',
      description:
        '编辑分类；只传要改的字段，name 缺省沿用原名。传 parentId:null 移到一级分类，传 adult 切换 18+ 标记。',
      inputSchema: z.object({
        id: categoryIdSchema,
        name: z.string().min(1).optional().describe('新名称'),
        parentId: z
          .string()
          .nullable()
          .optional()
          .describe('新上级分类 id；null = 移到一级分类；不传 = 保持原上级'),
        adult: z.boolean().optional().describe('是否标记为 18+ 分类')
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    (args) =>
      runTool(async () => {
        const rows = await callTool<VideoCategory[]>(invoke, MCP_CHANNELS.categoriesList, {
          includeAdult: true
        })
        const current = rows.find((row) => row.id === args.id)
        if (!current) throw new ToolCallError('NOT_FOUND', `分类 ${args.id} 不存在`)
        const input: VideoCategoryInput = {
          name: args.name ?? current.name,
          ...(args.parentId !== undefined ? { parentId: args.parentId } : {}),
          ...(args.adult !== undefined ? { adult: args.adult } : {})
        }
        return callTool(invoke, MCP_CHANNELS.categoriesUpdate, args.id, input)
      })
  )

  server.registerTool(
    'category_move',
    {
      title: '排序 / 移动分类',
      description:
        '把分类移动到目标位置：before / after 与目标同级，inside 成为目标的子分类；targetId 为 null 时移到一级分类末尾。',
      inputSchema: z.object({
        id: categoryIdSchema,
        targetId: z.string().nullable().optional().describe('目标分类 id；null = 一级分类末尾'),
        placement: placementSchema
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    (args) =>
      runTool(() =>
        callTool(
          invoke,
          MCP_CHANNELS.categoriesMove,
          args.id,
          args.targetId ?? null,
          args.placement as CategoryPlacement
        )
      )
  )

  server.registerTool(
    'category_set_adult',
    {
      title: '标记分类 18+',
      description: '切换分类的 18+ 标记；父分类标记后整棵子树都按 18+ 处理。',
      inputSchema: z.object({
        id: categoryIdSchema,
        adult: z.boolean().describe('true = 标记 18+，false = 取消')
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    (args) => runTool(() => callTool(invoke, MCP_CHANNELS.categoriesSetAdult, args.id, args.adult))
  )

  server.registerTool(
    'category_set_visible',
    {
      title: '显示 / 隐藏分类',
      description: '切换分类在展示端的显示状态；隐藏父分类会连带隐藏整棵子树，管理页仍能看到。',
      inputSchema: z.object({
        id: categoryIdSchema,
        visible: z.boolean().describe('true = 显示，false = 隐藏')
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    (args) =>
      runTool(() => callTool(invoke, MCP_CHANNELS.categoriesSetVisible, args.id, args.visible))
  )

  server.registerTool(
    'category_bindings',
    {
      title: '获取分类绑定信息',
      description: '返回某个本地分类已绑定的在线分类列表（站点名、在线分类名、绑定时间）。',
      inputSchema: z.object({ categoryId: categoryIdSchema }),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    (args) => runTool(() => callTool(invoke, MCP_CHANNELS.bindingsForCategory, args.categoryId))
  )

  server.registerTool(
    'binding_counts',
    {
      title: '统计各分类绑定数',
      description: '返回每个本地分类已绑定的在线分类数量（未绑定的分类不出现）。',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    () => runTool(() => callTool(invoke, MCP_CHANNELS.bindingsCounts))
  )

  server.registerTool(
    'site_bindings',
    {
      title: '获取站点分类绑定',
      description: '返回某个站点的在线分类分别绑定到哪个本地分类（含本地分类完整路径）。',
      inputSchema: z.object({ siteId: siteIdSchema }),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    (args) => runTool(() => callTool(invoke, MCP_CHANNELS.bindingsForSite, args.siteId))
  )

  server.registerTool(
    'binding_bind',
    {
      title: '绑定在线分类',
      description:
        '把一批站点在线分类绑定到指定本地视频分类；已绑定的会直接改绑。items 里的 siteCategoryId 来自 site_online_categories。',
      inputSchema: z.object({
        items: z.array(bindingTargetSchema).min(1).describe('要绑定的（站点, 在线分类）列表'),
        categoryId: categoryIdSchema
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    (args) =>
      runTool(() =>
        callTool(invoke, MCP_CHANNELS.bindingsBind, args.items as BindingTarget[], args.categoryId)
      )
  )

  server.registerTool(
    'binding_unbind',
    {
      title: '解除在线分类绑定',
      description: '解除一批（站点, 在线分类）的绑定关系；解绑后视频不再归属原来的本地分类。',
      inputSchema: z.object({
        items: z.array(bindingTargetSchema).min(1).describe('要解绑的（站点, 在线分类）列表')
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    (args) =>
      runTool(() => callTool(invoke, MCP_CHANNELS.bindingsUnbind, args.items as BindingTarget[]))
  )
}
