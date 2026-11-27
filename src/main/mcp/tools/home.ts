import * as z from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/server'
import { MCP_CHANNELS } from '../channels'
import type { McpInvoke } from '../mcp-types'
import type {
  HomeFeedResult,
  HomeItemView,
  HomeSearchView,
  HomeSectionView
} from '../../home-types'
import {
  ToolCallError,
  callTool,
  categoryIdSchema,
  homeItemPatchSchema,
  homeSearchPatchSchema,
  homeSectionPatchSchema,
  runTool,
  videoIdSchema
} from './helpers'

const videoIdsSchema = z.array(z.number().int().positive()).describe('按展示顺序排列的视频 id 数组')

/** home:get 的完整 feed 可能十几万字符；默认只回管理需要的字段，full=true 才给原始数据 */
function compactItem(item: HomeItemView): Record<string, unknown> {
  return {
    videoId: item.videoId,
    title: item.title,
    hidden: item.hidden,
    pinned: item.pinned,
    missing: item.missing,
    videoHidden: item.videoHidden,
    customPic: item.customPic,
    note: item.note,
    actors: item.actors
  }
}

function compactSection(section: HomeSectionView): Record<string, unknown> {
  return {
    categoryId: section.categoryId,
    name: section.name,
    title: section.title,
    visible: section.visible,
    categoryVisible: section.categoryVisible,
    rule: section.rule,
    topN: section.topN,
    customized: section.customized,
    total: section.total,
    items: section.items.map(compactItem),
    removedItems: section.removedItems.map(compactItem)
  }
}

function compactSearch(search: HomeSearchView): Record<string, unknown> {
  return {
    rule: search.rule,
    topN: search.topN,
    customized: search.customized,
    total: search.total,
    items: search.items.map(compactItem),
    removedItems: search.removedItems.map(compactItem)
  }
}

export function registerHomeTools(server: McpServer, invoke: McpInvoke): void {
  server.registerTool(
    'home_get',
    {
      title: '获取推荐页配置与数据',
      description:
        '返回控制台口径的推荐配置：海报叠层、分类轨道（含隐藏轨道和已移除条目）、搜索页底部推荐位。' +
        '默认只回管理需要的字段；full=true 返回包含简介 / 封面候选的原始 feed。',
      inputSchema: z.object({
        full: z.boolean().optional().describe('是否返回原始完整 feed（默认 false，只回精简字段）')
      }),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    (args) =>
      runTool(async () => {
        const result = await callTool<HomeFeedResult>(invoke, MCP_CHANNELS.homeGet, {
          view: 'console'
        })
        if (!result.feed) throw new ToolCallError('EMPTY_FEED', '没有读到推荐配置')
        if (args.full) return result
        const feed = result.feed
        return {
          ok: true,
          feed: {
            posters: feed.posters.map(compactItem),
            sections: feed.sections.map(compactSection),
            ...(feed.search ? { search: compactSearch(feed.search) } : {})
          }
        }
      })
  )

  server.registerTool(
    'poster_reorder',
    {
      title: '排序海报叠层',
      description: '按 videoIds 的顺序重排海报叠层；数组里没有的现有海报会保留在末尾。',
      inputSchema: z.object({ videoIds: videoIdsSchema }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    (args) => runTool(() => callTool(invoke, MCP_CHANNELS.postersReorder, args.videoIds))
  )

  server.registerTool(
    'poster_remove',
    {
      title: '删除海报',
      description: '把视频从推荐页海报叠层移除；视频本身和推荐分类不受影响。',
      inputSchema: z.object({ videoId: videoIdSchema }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
    },
    (args) => runTool(() => callTool(invoke, MCP_CHANNELS.postersRemove, args.videoId))
  )

  server.registerTool(
    'poster_update',
    {
      title: '编辑海报',
      description: '编辑海报条目的展示片名 / 备注 / 主演 / 简介 / 自定义图片 / 裁剪 / 隐藏状态。',
      inputSchema: z.object({
        videoId: videoIdSchema,
        ...homeItemPatchSchema.shape
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    (args) =>
      runTool(() => {
        const { videoId, ...patch } = args
        return callTool(invoke, MCP_CHANNELS.postersUpdate, videoId, patch)
      })
  )

  server.registerTool(
    'poster_set_hidden',
    {
      title: '隐藏 / 显示海报',
      description: '切换海报条目在推荐页的隐藏状态；隐藏后配置仍保留，可随时恢复。',
      inputSchema: z.object({
        videoId: videoIdSchema,
        hidden: z.boolean().describe('true = 隐藏，false = 显示')
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    (args) =>
      runTool(() =>
        callTool(invoke, MCP_CHANNELS.postersUpdate, args.videoId, { hidden: args.hidden })
      )
  )

  server.registerTool(
    'section_configure',
    {
      title: '配置分类推荐',
      description:
        '配置一级分类在推荐页上的显示名、是否显示、推荐规则（manual / latest）与 latest 的 TOP N。',
      inputSchema: z.object({
        categoryId: categoryIdSchema,
        ...homeSectionPatchSchema.shape
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    (args) =>
      runTool(() => {
        const { categoryId, ...patch } = args
        return callTool(invoke, MCP_CHANNELS.sectionsSave, categoryId, patch)
      })
  )

  server.registerTool(
    'section_set_visible',
    {
      title: '显示 / 隐藏分类轨道',
      description: '切换某个一级分类轨道是否在推荐页显示；隐藏只影响这条轨道，不隐藏分类里的视频。',
      inputSchema: z.object({
        categoryId: categoryIdSchema,
        visible: z.boolean().describe('true = 显示，false = 隐藏')
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    (args) =>
      runTool(() =>
        callTool(invoke, MCP_CHANNELS.sectionsSave, args.categoryId, { visible: args.visible })
      )
  )

  server.registerTool(
    'section_reorder_categories',
    {
      title: '排序推荐分类',
      description: '按 categoryIds 的顺序排列推荐页上的一级分类轨道；未列出的分类接在后面。',
      inputSchema: z.object({
        categoryIds: z.array(z.string()).min(1).describe('一级分类 id，按展示顺序排列')
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    (args) =>
      runTool(() => callTool(invoke, MCP_CHANNELS.sectionsReorderCategories, args.categoryIds))
  )

  server.registerTool(
    'section_reorder_items',
    {
      title: '排序分类内视频',
      description:
        '按 videoIds 的顺序排列某个分类轨道里的视频；人工排序的条目会固定到自动列表前面。',
      inputSchema: z.object({
        categoryId: categoryIdSchema,
        videoIds: videoIdsSchema
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    (args) =>
      runTool(() => callTool(invoke, MCP_CHANNELS.sectionsReorder, args.categoryId, args.videoIds))
  )

  server.registerTool(
    'section_item_update',
    {
      title: '编辑分类推荐条目',
      description:
        '编辑某个分类轨道里一条视频的展示片名 / 备注 / 主演 / 简介 / 图片 / 裁剪 / 隐藏状态。',
      inputSchema: z.object({
        categoryId: categoryIdSchema,
        videoId: videoIdSchema,
        ...homeItemPatchSchema.shape
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    (args) =>
      runTool(() => {
        const { categoryId, videoId, ...patch } = args
        return callTool(invoke, MCP_CHANNELS.sectionsUpdateItem, categoryId, videoId, patch)
      })
  )

  server.registerTool(
    'section_item_remove',
    {
      title: '移除分类推荐条目',
      description:
        '把视频从分类轨道移除。latest 规则下写成排除记录（可恢复）；manual 规则下直接删条目。',
      inputSchema: z.object({
        categoryId: categoryIdSchema,
        videoId: videoIdSchema
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
    },
    (args) =>
      runTool(() =>
        callTool(invoke, MCP_CHANNELS.sectionsRemoveItem, args.categoryId, args.videoId)
      )
  )

  server.registerTool(
    'section_item_restore',
    {
      title: '恢复分类推荐条目',
      description: '恢复之前从分类轨道移除的视频（latest 规则的排除记录）。',
      inputSchema: z.object({
        categoryId: categoryIdSchema,
        videoId: videoIdSchema
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    (args) =>
      runTool(() =>
        callTool(invoke, MCP_CHANNELS.sectionsRestoreItem, args.categoryId, args.videoId)
      )
  )

  server.registerTool(
    'search_recommend_configure',
    {
      title: '配置搜索推荐',
      description: '配置搜索页底部推荐位的规则（manual / latest）与 latest 的 TOP N。',
      inputSchema: z.object(homeSearchPatchSchema.shape),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    (args) => runTool(() => callTool(invoke, MCP_CHANNELS.searchSave, args))
  )

  server.registerTool(
    'search_recommend_reorder',
    {
      title: '排序搜索推荐',
      description: '按 videoIds 的顺序排列搜索页底部推荐位。',
      inputSchema: z.object({ videoIds: videoIdsSchema }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    (args) => runTool(() => callTool(invoke, MCP_CHANNELS.searchReorder, args.videoIds))
  )

  server.registerTool(
    'search_recommend_item_update',
    {
      title: '编辑搜索推荐条目',
      description:
        '编辑搜索页推荐位里一条视频的展示片名 / 备注 / 主演 / 简介 / 图片 / 裁剪 / 隐藏状态。',
      inputSchema: z.object({
        videoId: videoIdSchema,
        ...homeItemPatchSchema.shape
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    (args) =>
      runTool(() => {
        const { videoId, ...patch } = args
        return callTool(invoke, MCP_CHANNELS.searchUpdateItem, videoId, patch)
      })
  )

  server.registerTool(
    'search_recommend_item_set_hidden',
    {
      title: '隐藏 / 显示搜索推荐条目',
      description: '切换搜索页推荐位条目的隐藏状态；隐藏后配置仍保留，可随时恢复。',
      inputSchema: z.object({
        videoId: videoIdSchema,
        hidden: z.boolean().describe('true = 隐藏，false = 显示')
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    (args) =>
      runTool(() =>
        callTool(invoke, MCP_CHANNELS.searchUpdateItem, args.videoId, { hidden: args.hidden })
      )
  )

  server.registerTool(
    'search_recommend_item_remove',
    {
      title: '移除搜索推荐条目',
      description: '把视频从搜索页推荐位移除；latest 规则下写成排除记录，manual 规则下删除条目。',
      inputSchema: z.object({ videoId: videoIdSchema }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
    },
    (args) => runTool(() => callTool(invoke, MCP_CHANNELS.searchRemoveItem, args.videoId))
  )

  server.registerTool(
    'search_recommend_item_restore',
    {
      title: '恢复搜索推荐条目',
      description: '恢复之前从搜索页推荐位移除的视频（latest 规则的排除记录）。',
      inputSchema: z.object({ videoId: videoIdSchema }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    (args) => runTool(() => callTool(invoke, MCP_CHANNELS.searchRestoreItem, args.videoId))
  )
}
