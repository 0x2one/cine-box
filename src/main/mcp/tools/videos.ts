import * as z from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/server'
import { MCP_CHANNELS } from '../channels'
import type { McpInvoke } from '../mcp-types'
import type { VideoDetailResult, VideoListQuery } from '../../video-types'
import {
  ToolCallError,
  callTool,
  categoryIdSchema,
  runTool,
  videoIdSchema,
  videoUpdateSchema
} from './helpers'

export function registerVideoTools(server: McpServer, invoke: McpInvoke): void {
  server.registerTool(
    'video_list',
    {
      title: '搜索 / 列出视频',
      description:
        '按关键词、本地分类、显示状态分页列出视频。默认管理口径（含隐藏、18+、禁用站点）；可用 keyword 做本地片名检索。',
      inputSchema: z.object({
        keyword: z.string().optional().describe('片名关键词（走本地 FTS 检索）'),
        categoryId: z.string().optional().describe('单个本地分类 id（含子树）'),
        categoryIds: z
          .array(z.string())
          .optional()
          .describe('多个本地分类的并集（通常传一级分类）'),
        page: z.number().int().min(1).optional().describe('页码，从 1 开始，默认 1'),
        pageSize: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('每页条数，默认 20，最多 100'),
        visibility: z
          .enum(['all', 'shown', 'hidden'])
          .optional()
          .describe('按隐藏状态过滤，默认 all（管理口径）'),
        includeDisabledSites: z
          .boolean()
          .optional()
          .describe('是否包含只被禁用站点收录的视频，默认 true'),
        includeAdult: z.boolean().optional().describe('是否包含 18+ 视频，默认 true')
      }),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    (args) =>
      runTool(() => {
        const query: VideoListQuery = {
          ...(args.keyword ? { keyword: args.keyword } : {}),
          ...(args.categoryId ? { categoryId: args.categoryId } : {}),
          ...(args.categoryIds ? { categoryIds: args.categoryIds } : {}),
          page: args.page ?? 1,
          pageSize: args.pageSize ?? 20,
          visibility: args.visibility ?? 'all',
          includeDisabledSites: args.includeDisabledSites ?? true,
          includeAdult: args.includeAdult ?? true
        }
        return callTool(invoke, MCP_CHANNELS.videosList, query)
      })
  )

  server.registerTool(
    'video_get',
    {
      title: '获取视频详情',
      description:
        '获取视频详情：片名、封面、简介、来源站点、各线路与剧集、绑定分类路径等。详情缺失时默认会向来源站点抓取。',
      inputSchema: z.object({
        videoId: videoIdSchema,
        autoFetch: z
          .boolean()
          .optional()
          .describe('详情未缓存时是否主动抓取，默认 true；传 false 只看本地缓存'),
        includeAdult: z
          .boolean()
          .optional()
          .describe('是否允许返回 18+ 视频，默认 true（管理口径）')
      }),
      annotations: { readOnlyHint: true, openWorldHint: true }
    },
    (args) =>
      runTool(() =>
        callTool<VideoDetailResult>(invoke, MCP_CHANNELS.videosDetail, args.videoId, {
          autoFetch: args.autoFetch ?? true,
          includeAdult: args.includeAdult ?? true
        })
      )
  )

  server.registerTool(
    'video_update',
    {
      title: '编辑视频信息',
      description:
        '编辑视频的备注 / 简介 / 主演 / 类型 / 封面 / 隐藏 / 人工 18+ 标记；只传要改的字段。',
      inputSchema: z.object({
        videoId: videoIdSchema,
        ...videoUpdateSchema.shape
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    (args) =>
      runTool(() => {
        const { videoId, ...patch } = args
        return callTool(invoke, MCP_CHANNELS.videosUpdate, videoId, patch)
      })
  )

  server.registerTool(
    'video_set_hidden',
    {
      title: '隐藏 / 显示视频',
      description: '切换视频在展示端（推荐 / 找片看 / 搜索 / 播放页 / 共享页）的隐藏状态。',
      inputSchema: z.object({
        videoId: videoIdSchema,
        hidden: z.boolean().describe('true = 隐藏，false = 显示')
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    (args) =>
      runTool(() =>
        callTool(invoke, MCP_CHANNELS.videosUpdate, args.videoId, { hidden: args.hidden })
      )
  )

  server.registerTool(
    'video_set_adult',
    {
      title: '标记视频 18+',
      description: '切换视频的人工 18+ 标记；来源站点 / 绑定分类的 18+ 标记也会让视频按 18+ 处理。',
      inputSchema: z.object({
        videoId: videoIdSchema,
        adult: z.boolean().describe('true = 人工标记 18+，false = 取消人工标记')
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    (args) =>
      runTool(() =>
        callTool(invoke, MCP_CHANNELS.videosUpdate, args.videoId, { adult: args.adult })
      )
  )

  server.registerTool(
    'video_add_poster',
    {
      title: '添加到推荐海报',
      description: '把视频加入推荐页海报叠层；已存在返回 DUPLICATE，超过 24 张返回 FULL。',
      inputSchema: z.object({ videoId: videoIdSchema }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
    },
    (args) => runTool(() => callTool(invoke, MCP_CHANNELS.postersAdd, args.videoId))
  )

  server.registerTool(
    'video_add_section',
    {
      title: '添加到推荐页分类',
      description:
        '把视频加入某个一级分类的推荐轨道。视频必须通过绑定关系属于该一级分类，否则返回 NOT_BOUND。',
      inputSchema: z.object({
        videoId: videoIdSchema,
        categoryId: categoryIdSchema.describe('推荐页一级分类 id（32 位十六进制）')
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    (args) =>
      runTool(() => callTool(invoke, MCP_CHANNELS.sectionsAddItem, args.categoryId, args.videoId))
  )

  server.registerTool(
    'video_cache',
    {
      title: '触发视频缓存任务',
      description:
        '把指定视频的若干集加入离线缓存队列。省略 sourceId / lineIndex 时取第一个有线路的来源和第一条线路；' +
        'episodeIndexes 与 allEpisodes=true 二选一（一次最多 1000 集）。',
      inputSchema: z.object({
        videoId: videoIdSchema,
        sourceId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('来源 id（VideoDetailSource.id）；省略取第一个有线路的来源'),
        lineIndex: z.number().int().min(0).optional().describe('线路下标，默认 0'),
        episodeIndexes: z
          .array(z.number().int().min(0))
          .min(1)
          .optional()
          .describe('要缓存的集下标列表'),
        allEpisodes: z.boolean().optional().describe('缓存所选线路的全部剧集')
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
    },
    (args) =>
      runTool(async () => {
        const detail = await callTool<VideoDetailResult>(
          invoke,
          MCP_CHANNELS.videosDetail,
          args.videoId,
          {
            autoFetch: true,
            includeAdult: true
          }
        )
        if (!detail.ok || !detail.video) {
          throw new ToolCallError(detail.error ?? 'NOT_FOUND', '取不到视频详情')
        }
        const video = detail.video
        const source = args.sourceId
          ? video.sources.find((item) => item.id === args.sourceId)
          : video.sources.find((item) => (item.detail?.playLines?.length ?? 0) > 0)
        if (!source) throw new ToolCallError('NOT_FOUND', '没有找到可播放的来源')
        const lineIndex = args.lineIndex ?? 0
        const line = source.detail?.playLines?.[lineIndex]
        if (!line)
          throw new ToolCallError('INVALID_INPUT', `来源 ${source.id} 没有第 ${lineIndex} 条线路`)

        let indexes: number[]
        if (args.allEpisodes) {
          indexes = line.episodes.map((_, index) => index)
        } else if (args.episodeIndexes && args.episodeIndexes.length > 0) {
          indexes = [...new Set(args.episodeIndexes)]
        } else {
          throw new ToolCallError('INVALID_INPUT', '需要 episodeIndexes 或 allEpisodes=true')
        }
        if (indexes.length > 1000) throw new ToolCallError('INVALID_INPUT', '一次最多缓存 1000 集')
        if (indexes.length === 0)
          throw new ToolCallError('INVALID_INPUT', '这条线路没有可缓存的剧集')

        return callTool(invoke, MCP_CHANNELS.downloadsCache, {
          videoId: video.id,
          sourceId: source.id,
          lineIndex,
          episodeIndexes: indexes
        })
      })
  )
}
