import * as z from 'zod/v4'
import type { McpServer } from '@modelcontextprotocol/server'
import { MCP_CHANNELS } from '../channels'
import type { McpInvoke } from '../mcp-types'
import type { AppSettings } from '../../app-settings'
import type { DownloadKind, DownloadRecordView, DownloadStatus } from '../../download-store'
import type { DownloadUsage } from '../../download-usage'
import { callTool, runTool } from './helpers'

interface DownloadPathResult {
  ok: boolean
  error?: string
  settings: AppSettings
}

interface DownloadUsageResult {
  ok: boolean
  usage?: DownloadUsage
}

interface Mp4ExportResult {
  ok: boolean
  queued: number
  existing: number
  skipped: number
}

export function registerDownloadTools(server: McpServer, invoke: McpInvoke): void {
  server.registerTool(
    'download_usage',
    {
      title: '获取存储占用',
      description: '递归统计下载目录的文件数 / 总字节数，以及所在磁盘的总容量与剩余空间。',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    () =>
      runTool(async () => {
        const result = await callTool<DownloadUsageResult>(invoke, MCP_CHANNELS.downloadsUsage)
        return { ok: result.ok, usage: result.usage }
      })
  )

  server.registerTool(
    'download_get_path',
    {
      title: '获取下载保存位置',
      description: '返回当前下载目录的绝对路径。',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    () =>
      runTool(async () => {
        const settings = await callTool<AppSettings>(invoke, MCP_CHANNELS.settingsGet)
        return { downloadPath: settings.downloadPath }
      })
  )

  server.registerTool(
    'download_set_path',
    {
      title: '设置下载保存位置',
      description:
        '修改下载目录（必须是绝对路径）；目录不存在会自动创建，不可写返回 NOT_WRITABLE。',
      inputSchema: z.object({ path: z.string().min(1).describe('下载目录绝对路径') }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    (args) =>
      runTool(async () => {
        const result = await callTool<DownloadPathResult>(
          invoke,
          MCP_CHANNELS.downloadsSetPath,
          args.path
        )
        return { ok: result.ok, downloadPath: result.settings.downloadPath }
      })
  )

  server.registerTool(
    'download_get_concurrency',
    {
      title: '获取同时下载任务数',
      description: '返回同时下载的任务数（1–5）。',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    () =>
      runTool(async () => {
        const settings = await callTool<AppSettings>(invoke, MCP_CHANNELS.settingsGet)
        return { downloadConcurrency: settings.downloadConcurrency }
      })
  )

  server.registerTool(
    'download_set_concurrency',
    {
      title: '设置同时下载任务数',
      description: '设置同时下载的任务数（1–5）；下一次填槽生效，不打断正在下载的任务。',
      inputSchema: z.object({
        value: z.number().int().min(1).max(5).describe('同时下载任务数（1–5）')
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    (args) =>
      runTool(async () => {
        const settings = await callTool<AppSettings>(
          invoke,
          MCP_CHANNELS.downloadsSetConcurrency,
          args.value
        )
        return { downloadConcurrency: settings.downloadConcurrency }
      })
  )

  server.registerTool(
    'download_get_segment_concurrency',
    {
      title: '获取单集分片并发数',
      description: '返回单个缓存任务内部同时下载的分片数（1–6）。',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    () =>
      runTool(async () => {
        const settings = await callTool<AppSettings>(invoke, MCP_CHANNELS.settingsGet)
        return { downloadSegmentConcurrency: settings.downloadSegmentConcurrency }
      })
  )

  server.registerTool(
    'download_set_segment_concurrency',
    {
      title: '设置单集分片并发数',
      description: '设置单个缓存任务内部的分片并发（1–6）；对之后开始的缓存任务生效。',
      inputSchema: z.object({
        value: z.number().int().min(1).max(6).describe('单集分片并发数（1–6）')
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    (args) =>
      runTool(async () => {
        const settings = await callTool<AppSettings>(
          invoke,
          MCP_CHANNELS.downloadsSetSegmentConcurrency,
          args.value
        )
        return { downloadSegmentConcurrency: settings.downloadSegmentConcurrency }
      })
  )

  server.registerTool(
    'download_center_list',
    {
      title: '获取下载记录',
      description:
        '返回下载中心记录（含状态、进度、文件是否存在、MP4 导出状态），可按 id / 视频 / 状态 / 类型过滤。',
      inputSchema: z.object({
        id: z.string().optional().describe('下载记录 id'),
        videoId: z.number().int().positive().optional().describe('只看某部视频的记录'),
        status: z
          .enum(['waiting', 'downloading', 'paused', 'done', 'failed', 'canceled'])
          .optional()
          .describe('下载状态'),
        kind: z.enum(['file', 'hls']).optional().describe('记录类型：单文件 / HLS 缓存包'),
        limit: z.number().int().min(1).max(1000).optional().describe('最多返回条数，默认 100')
      }),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    (args) =>
      runTool(async () => {
        const records = await callTool<DownloadRecordView[]>(invoke, MCP_CHANNELS.downloadsList)
        const filtered = records.filter((record) => {
          if (args.id && record.id !== args.id) return false
          if (args.videoId !== undefined && record.videoId !== args.videoId) return false
          if (args.status && record.status !== (args.status as DownloadStatus)) return false
          if (args.kind && record.kind !== (args.kind as DownloadKind)) return false
          return true
        })
        const limit = args.limit ?? 100
        return {
          total: filtered.length,
          truncated: filtered.length > limit,
          items: filtered.slice(0, limit)
        }
      })
  )

  server.registerTool(
    'download_center_progress',
    {
      title: '获取下载进度 / 状态',
      description:
        '返回下载任务的进度、速度、字节数、文件是否存在与 MP4 导出状态；可用 ids 只查指定记录。',
      inputSchema: z.object({
        ids: z.array(z.string()).optional().describe('只查这些下载记录 id')
      }),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    (args) =>
      runTool(async () => {
        const records = await callTool<DownloadRecordView[]>(invoke, MCP_CHANNELS.downloadsList)
        const wanted = args.ids && args.ids.length > 0 ? new Set(args.ids) : null
        const items = records
          .filter((record) => (wanted ? wanted.has(record.id) : true))
          .map((record) => ({
            id: record.id,
            videoId: record.videoId,
            title: record.title,
            episodeName: record.episodeName,
            kind: record.kind,
            status: record.status,
            progress: record.progress,
            receivedBytes: record.receivedBytes,
            totalBytes: record.totalBytes,
            speed: record.speed,
            exists: record.exists,
            size: record.size,
            sourceName: record.sourceName,
            mp4Status: record.mp4Status,
            mp4Progress: record.mp4Progress,
            mp4Path: record.mp4Path,
            mp4Exists: record.mp4Exists,
            mp4Error: record.mp4Error
          }))
        return { total: items.length, items }
      })
  )

  server.registerTool(
    'download_center_export_mp4',
    {
      title: '缓存转 MP4',
      description:
        '把已完成的 HLS 缓存包导出为 MP4（只换容器、不重新编码）。串行执行；force=true 覆盖已有导出。',
      inputSchema: z.object({
        ids: z.array(z.string()).min(1).describe('要导出的下载记录 id 列表'),
        force: z.boolean().optional().describe('是否覆盖已导出的 MP4')
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    (args) =>
      runTool(() =>
        callTool<Mp4ExportResult>(invoke, MCP_CHANNELS.downloadsExportMp4, {
          ids: args.ids,
          force: args.force ?? false
        })
      )
  )
}
