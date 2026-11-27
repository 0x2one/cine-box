import * as z from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/server'
import { MCP_CHANNELS } from '../channels'
import type { McpInvoke } from '../mcp-types'
import type {
  CollectMode,
  FetchRange,
  VideoCollectProgress,
  VideoCollectStartInput,
  VideoScheduleInput
} from '../../video-types'
import type { AppSettings } from '../../app-settings'
import {
  ToolCallError,
  callTool,
  collectModeSchema,
  fetchRangeSchema,
  runTool,
  scheduleModeSchema,
  scheduleTimingSchema,
  siteIdSchema
} from './helpers'

const dateTimePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/

/** 检索任务的词从进度里补：继续 / 重采都不要求调用方重新列一遍 */
async function searchWordsFromProgress(
  invoke: McpInvoke,
  siteId: string,
  onlyPending: boolean
): Promise<string[]> {
  const rows = await callTool<VideoCollectProgress[]>(invoke, MCP_CHANNELS.progress, siteId)
  const row = rows.find((item) => item.mode === 'search' && item.fetchRange === 'all')
  const words = row?.words ?? []
  const chosen = onlyPending ? words.filter((word) => word.status !== 'done') : words
  return chosen.map((word) => word.word)
}

export function registerCollectTools(server: McpServer, invoke: McpInvoke): void {
  server.registerTool(
    'collect_start',
    {
      title: '创建采集任务',
      description:
        '为站点创建采集任务并入队。incremental 增量 / full 全量 / search 按关键词检索；检索模式必须提供 words，full 的范围固定 all。',
      inputSchema: z.object({
        siteId: siteIdSchema,
        mode: collectModeSchema.default('incremental'),
        fetchRange: fetchRangeSchema.default('all'),
        restart: z.boolean().optional().describe('是否从头重采（默认 false，按已有进度继续）'),
        maxPages: z.number().int().min(1).optional().describe('本次最多翻多少页'),
        allowEmpty: z.boolean().optional().describe('允许全量任务抓到 0 条也不报错'),
        cacheDetail: z.boolean().optional().describe('是否同时抓取详情缓存'),
        pageSize: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('每页条数；省略时自动探测 / 复用历史值'),
        words: z.array(z.string()).optional().describe('检索关键词（只有 mode=search 时使用）')
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
    },
    (args) =>
      runTool(() => {
        const mode = args.mode as CollectMode
        const fetchRange =
          mode === 'full' || mode === 'search' ? 'all' : (args.fetchRange as FetchRange)
        if (mode === 'search' && (!args.words || args.words.length === 0)) {
          throw new ToolCallError('INVALID_INPUT', '检索模式需要至少一个关键词')
        }
        const input: VideoCollectStartInput = {
          siteId: args.siteId,
          mode,
          fetchRange,
          ...(args.restart !== undefined ? { restart: args.restart } : {}),
          ...(args.maxPages !== undefined ? { maxPages: args.maxPages } : {}),
          ...(args.allowEmpty !== undefined ? { allowEmpty: args.allowEmpty } : {}),
          ...(args.cacheDetail !== undefined ? { cacheDetail: args.cacheDetail } : {}),
          ...(args.pageSize !== undefined ? { pageSize: args.pageSize } : {}),
          ...(mode === 'search' ? { words: args.words } : {})
        }
        return callTool(invoke, MCP_CHANNELS.collectStart, input)
      })
  )

  server.registerTool(
    'collect_pause',
    {
      title: '暂停采集',
      description:
        '暂停该站点正在跑 / 排队中的采集任务（取消是幂等的）。已采集的数据与断点保留，可用 collect_resume 继续。',
      inputSchema: z.object({
        siteId: siteIdSchema,
        mode: collectModeSchema.optional(),
        fetchRange: fetchRangeSchema.optional()
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    (args) =>
      runTool(() =>
        callTool(invoke, MCP_CHANNELS.collectCancel, {
          siteId: args.siteId,
          ...(args.mode !== undefined ? { mode: args.mode } : {}),
          ...(args.fetchRange !== undefined ? { fetchRange: args.fetchRange } : {})
        })
      )
  )

  server.registerTool(
    'collect_resume',
    {
      title: '继续采集',
      description:
        '按现有断点继续采集，不重置进度。检索模式会自动带上未完成的关键词；没有进度 / 没有未完成关键词时报错。',
      inputSchema: z.object({
        siteId: siteIdSchema,
        mode: collectModeSchema,
        fetchRange: fetchRangeSchema,
        cacheDetail: z.boolean().optional().describe('是否同时抓取详情缓存')
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
    },
    (args) =>
      runTool(async () => {
        const rows = await callTool<VideoCollectProgress[]>(
          invoke,
          MCP_CHANNELS.progress,
          args.siteId
        )
        const range = args.mode === 'search' ? 'all' : args.fetchRange
        const row = rows.find((item) => item.mode === args.mode && item.fetchRange === range)
        if (!row) throw new ToolCallError('NO_PROGRESS', '没有找到可继续的采集进度')
        const input: VideoCollectStartInput = {
          siteId: args.siteId,
          mode: args.mode as CollectMode,
          fetchRange: range as FetchRange,
          ...(args.cacheDetail !== undefined ? { cacheDetail: args.cacheDetail } : {})
        }
        if (args.mode === 'search') {
          const words = await searchWordsFromProgress(invoke, args.siteId, true)
          if (words.length === 0)
            throw new ToolCallError('NO_PENDING_WORDS', '没有未完成的检索关键词')
          input.words = words
        }
        return callTool(invoke, MCP_CHANNELS.collectStart, input)
      })
  )

  server.registerTool(
    'collect_restart',
    {
      title: '重新采集',
      description:
        '从头重新采集（restart=true），会重置该任务的页进度。检索模式会重新采进度里已有的全部关键词；也可以显式传 words。',
      inputSchema: z.object({
        siteId: siteIdSchema,
        mode: collectModeSchema,
        fetchRange: fetchRangeSchema,
        cacheDetail: z.boolean().optional().describe('是否同时抓取详情缓存'),
        words: z.array(z.string()).optional().describe('检索关键词；省略时用进度里已有的词')
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
    },
    (args) =>
      runTool(async () => {
        const range = args.mode === 'search' ? 'all' : args.fetchRange
        const input: VideoCollectStartInput = {
          siteId: args.siteId,
          mode: args.mode as CollectMode,
          fetchRange: range as FetchRange,
          restart: true,
          ...(args.cacheDetail !== undefined ? { cacheDetail: args.cacheDetail } : {})
        }
        if (args.mode === 'search') {
          const words =
            args.words && args.words.length > 0
              ? args.words
              : await searchWordsFromProgress(invoke, args.siteId, false)
          if (words.length === 0)
            throw new ToolCallError('INVALID_INPUT', '检索模式需要至少一个关键词')
          input.words = words
        }
        return callTool(invoke, MCP_CHANNELS.collectStart, input)
      })
  )

  server.registerTool(
    'collect_progress',
    {
      title: '获取采集进度',
      description:
        '返回采集进度列表（可按站点过滤），包含页数、抓取 / 新增 / 更新数、状态与检索关键词。',
      inputSchema: z.object({
        siteId: siteIdSchema.optional().describe('只查这个站点；省略 = 全部站点')
      }),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    (args) => runTool(() => callTool(invoke, MCP_CHANNELS.progress, args.siteId))
  )

  server.registerTool(
    'collect_set_concurrency',
    {
      title: '配置采集并发',
      description:
        '设置同时采集的站点数（1–4）。调大后立刻把排队任务填进槽位；调小不打断正在跑的任务。',
      inputSchema: z.object({
        value: z.number().int().min(1).max(4).describe('并发站点数（1–4）')
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    (args) =>
      runTool(async () => {
        const settings = await callTool<AppSettings>(
          invoke,
          MCP_CHANNELS.setCollectConcurrency,
          args.value
        )
        return { collectConcurrency: settings.collectConcurrency }
      })
  )

  server.registerTool(
    'collect_clear_progress',
    {
      title: '清空采集进度',
      description:
        '一键清空采集进度（含检索关键词），不动已采集的视频、详情与日志。有任务在跑 / 排队时返回 BUSY。',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
    },
    () => runTool(() => callTool(invoke, MCP_CHANNELS.progressClear))
  )

  server.registerTool(
    'collect_schedule_list',
    {
      title: '列出定时计划',
      description: '返回全部定时采集计划（含下次运行时间与上次运行时间）。',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    () => runTool(() => callTool(invoke, MCP_CHANNELS.schedulesList))
  )

  server.registerTool(
    'collect_schedule_save',
    {
      title: '创建 / 更新定时计划',
      description:
        '为站点创建或更新定时采集计划。timing=interval 用 intervalMinutes，timing=daily 用 dailyTime（HH:mm）；每个站点一条计划。',
      inputSchema: z.object({
        siteId: siteIdSchema,
        enabled: z.boolean().default(true).describe('是否启用计划'),
        timing: scheduleTimingSchema.default('interval'),
        intervalMinutes: z
          .number()
          .int()
          .min(1)
          .max(10080)
          .optional()
          .describe('间隔分钟数（timing=interval 时使用，默认 60）'),
        dailyTime: z
          .string()
          .optional()
          .describe('每天运行时间 HH:mm（timing=daily 时使用，默认 08:00）'),
        mode: scheduleModeSchema.default('incremental'),
        fetchRange: fetchRangeSchema.default('all'),
        cacheDetail: z.boolean().optional().describe('是否同时抓取详情缓存（默认 true）')
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    (args) =>
      runTool(() => {
        const timing = args.timing
        const dailyTime = args.dailyTime ?? '08:00'
        if (timing === 'daily' && !dateTimePattern.test(dailyTime)) {
          throw new ToolCallError('INVALID_INPUT', 'dailyTime 需要是 HH:mm 格式')
        }
        const input: VideoScheduleInput = {
          siteId: args.siteId,
          enabled: args.enabled,
          timing,
          intervalMinutes: timing === 'interval' ? (args.intervalMinutes ?? 60) : 0,
          dailyTime: timing === 'daily' ? dailyTime : '',
          mode: args.mode,
          fetchRange: args.fetchRange,
          cacheDetail: args.cacheDetail ?? true
        }
        return callTool(invoke, MCP_CHANNELS.schedulesSave, input)
      })
  )

  server.registerTool(
    'collect_schedule_remove',
    {
      title: '删除定时计划',
      description: '删除某个站点的定时采集计划；不影响正在跑的手动采集。',
      inputSchema: z.object({ siteId: siteIdSchema }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
    },
    (args) => runTool(() => callTool(invoke, MCP_CHANNELS.schedulesRemove, args.siteId))
  )
}
