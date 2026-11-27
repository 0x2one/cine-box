import * as z from 'zod/v4'
import type { CallToolResult } from '@modelcontextprotocol/server'
import type { McpInvoke } from '../mcp-types'

/** 业务失败（handler 返回 { ok:false } 或抛错）统一抛这个，外层 runTool 转成 isError 结果 */
export class ToolCallError extends Error {
  code: string
  detail: unknown

  constructor(code: string, message: string, detail?: unknown) {
    super(message)
    this.name = 'ToolCallError'
    this.code = code
    this.detail = detail
  }
}

function isFailure(value: unknown): value is { ok: false; error?: string; message?: string } {
  return typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === false
}

function stringify(value: unknown): string {
  if (value === undefined) return '{"ok":true}'
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function textResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: stringify(value) }] }
}

export function failureResult(code: string, message: string, detail?: unknown): CallToolResult {
  const payload: Record<string, unknown> = { ok: false, error: code }
  if (message) payload.message = message
  // 业务错误可能带着 state / progress 之类的上下文；只放体积可控的附加信息
  if (detail !== undefined) payload.detail = detail
  return {
    isError: true,
    content: [{ type: 'text', text: stringify(payload) }]
  }
}

/**
 * 调既有 IPC handler：成功返回值原样返回；{ok:false} / 抛错转成 ToolCallError。
 * 工具实现里用 runTool 包一层，最终给客户端 isError + JSON。
 */
export async function callTool<T>(
  invoke: McpInvoke,
  channel: string,
  ...args: unknown[]
): Promise<T> {
  let result: unknown
  try {
    result = await invoke(channel, ...args)
  } catch (error) {
    throw new ToolCallError('INTERNAL', error instanceof Error ? error.message : String(error))
  }
  if (isFailure(result)) {
    throw new ToolCallError(result.error ?? 'TOOL_ERROR', result.message ?? '', result)
  }
  return result as T
}

export async function runTool(task: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return textResult(await task())
  } catch (error) {
    if (error instanceof ToolCallError) {
      return failureResult(error.code, error.message, error.detail)
    }
    console.error('[mcp] 工具执行失败', error)
    return failureResult('INTERNAL', error instanceof Error ? error.message : String(error))
  }
}

/* ── 共用 schema ── */

export const siteIdSchema = z
  .string()
  .min(1)
  .describe('站点 id（32 位十六进制，先用 site_list 获取）')
export const categoryIdSchema = z
  .string()
  .min(1)
  .describe('本地视频分类 id（32 位十六进制，先用 category_list 获取）')
export const videoIdSchema = z
  .number()
  .int()
  .positive()
  .describe('视频 id（数字，先用 video_list 获取）')

export const cropSchema = z.object({
  x: z.number().describe('裁剪左上角 x，按原图宽归一化到 0–1'),
  y: z.number().describe('裁剪左上角 y，按原图高归一化到 0–1'),
  w: z.number().describe('裁剪宽度，按原图宽归一化到 0–1'),
  h: z.number().describe('裁剪高度，按原图高归一化到 0–1')
})

export const homeItemPatchSchema = z.object({
  title: z.string().optional().describe('展示片名；空串表示沿用视频名'),
  note: z.string().optional().describe('一句话备注 / 更新进度'),
  actors: z.string().optional().describe('主演文案'),
  intro: z.string().optional().describe('简介文案'),
  pic: z
    .string()
    .optional()
    .describe('自定义图片地址：http(s) 或 cine-img://home/<文件名>；空串表示用视频封面'),
  crop: cropSchema.optional().describe('自定义图片裁剪区域'),
  hidden: z.boolean().optional().describe('是否在该推荐位隐藏（配置仍保留）')
})

export const homeSectionPatchSchema = z.object({
  visible: z.boolean().optional().describe('这条分类轨道是否在推荐页显示'),
  title: z.string().optional().describe('推荐页上的显示名；空串沿用分类名'),
  rule: z
    .enum(['manual', 'latest'])
    .optional()
    .describe('manual = 人工推荐列表；latest = 按更新时间取前 N 部'),
  topN: z.number().int().min(1).max(50).optional().describe('latest 规则下取多少部（1–50）')
})

export const homeSearchPatchSchema = z.object({
  rule: z
    .enum(['manual', 'latest'])
    .optional()
    .describe('manual = 人工推荐列表；latest = 按更新时间取前 N 部'),
  topN: z.number().int().min(1).max(24).optional().describe('latest 规则下取多少部（1–24）')
})

export const videoUpdateSchema = z.object({
  note: z.string().optional().describe('备注 / 更新进度'),
  intro: z.string().optional().describe('简介'),
  vodActor: z.string().optional().describe('主演'),
  vodClass: z.string().optional().describe('类型'),
  pic: z.string().optional().describe('封面地址（必须来自该视频的某个来源；空串恢复主来源封面）'),
  picSiteId: z.string().optional().describe('封面来源站点 id，仅用于回显'),
  hidden: z.boolean().optional().describe('是否在展示端隐藏'),
  adult: z.boolean().optional().describe('人工标记 18+')
})

export const networkSettingsSchema = z.object({
  mode: z.enum(['off', 'system', 'custom']).describe('代理模式'),
  type: z.enum(['http', 'socks5']).describe('自定义代理协议'),
  host: z.string().describe('代理服务器地址（域名 / IPv4 / IPv6，不带协议）'),
  port: z.number().int().min(1).max(65535).describe('代理端口'),
  authEnabled: z.boolean().describe('是否启用代理身份验证'),
  username: z.string().describe('代理用户名'),
  password: z.string().describe('代理密码；传 *** 表示保留原密码'),
  testUrl: z.string().describe('代理验证地址')
})

export const networkPatchSchema = networkSettingsSchema.partial()

export const collectModeSchema = z
  .enum(['incremental', 'full', 'search'])
  .describe('采集模式：incremental 增量 / full 全量 / search 按关键词检索')
export const fetchRangeSchema = z
  .enum(['all', '24h', '48h'])
  .describe('采集范围：all 全部 / 24h 最近一天 / 48h 最近两天')
export const scheduleModeSchema = z
  .enum(['incremental', 'full'])
  .describe('定时采集模式（不支持检索）')
export const scheduleTimingSchema = z
  .enum(['interval', 'daily'])
  .describe('定时方式：interval 按间隔 / daily 每天固定时间')
