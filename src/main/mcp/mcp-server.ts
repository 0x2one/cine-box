import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { hostHeaderValidation, originValidation, toNodeHandler } from '@modelcontextprotocol/node'
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import type { McpHttpHandler } from '@modelcontextprotocol/server'
import type { NodeMcpRequestHandler } from '@modelcontextprotocol/node'
import { listLanAddresses } from '../lan/lan-config'
import { LAN_ALL_INTERFACES } from '../lan/lan-types'
import { registerMcpTools } from './tools'
import {
  mcpUrls,
  normalizeMcpSettings,
  validateMcpListener,
  validateMcpSettings,
  type McpSettings,
  type McpSettingsStore
} from './mcp-settings'
import type {
  McpConfigureResult,
  McpError,
  McpServerOptions,
  McpSnapshot,
  McpState
} from './mcp-types'

const MCP_PATH = '/mcp'
/** 工具参数最多就是几 KB；给足余量，同时挡住异常大包 */
const MAX_BODY_BYTES = 8 * 1024 * 1024
/** 单来源每分钟请求上限：正常客户端远远用不到，异常循环能及时被拦住 */
const RATE_LIMIT = 600
const RATE_WINDOW_MS = 60_000
const SERVER_NAME = 'cine-box'

const INSTRUCTIONS = `本服务控制本机「映盒剧场」：站点、分类与绑定、采集、推荐、共享、备份、日志、网络、下载和下载中心。

使用提示：
- 所有 id 都是 32 位十六进制字符串（视频 id 是数字）。先用对应的 list / get 工具取 id。
- 写操作立即生效，没有二次确认；删除、清空、恢复备份等操作不可撤销。
- 备份恢复必须传 confirm=true；恢复前应用会自动备份当前数据。
- 管理类列表默认包含 18+ 与禁用站点的内容，和桌面控制台口径一致。`

const ERROR_MESSAGES: Record<McpError, string> = {
  INVALID_INPUT: '配置格式不正确',
  INVALID_HOST: '监听地址不可用，请选择本机地址或 0.0.0.0',
  INVALID_PORT: '端口需要是 1024–65535 之间的整数',
  TOKEN_REQUIRED: '监听局域网地址前，请先设置访问令牌',
  PORT_IN_USE: '这个端口已被占用，换一个再试',
  ADDRESS_UNAVAILABLE: '这个 IP 当前不在线，请刷新地址列表后重新选择',
  PERMISSION: '没有权限监听这个端口，请换一个 1024 以上的端口',
  START_FAILED: 'MCP 服务启动失败，请稍后再试'
}

export interface McpServerController {
  /** 应用启动时调用：按已保存的配置决定是否监听 */
  init: () => Promise<void>
  /** 设置面板读取的完整快照 */
  snapshot: () => McpSnapshot
  /** 保存并应用 enabled / host / port / token */
  configure: (patch: unknown) => Promise<McpConfigureResult>
  /** 应用退出时调用 */
  dispose: () => void
}

function messageFor(error: McpError): string {
  return ERROR_MESSAGES[error] ?? ERROR_MESSAGES.START_FAILED
}

function mapListenError(error: unknown): McpError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'EADDRINUSE') return 'PORT_IN_USE'
  if (code === 'EACCES') return 'PERMISSION'
  if (code === 'EADDRNOTAVAIL' || code === 'ENOTFOUND') return 'ADDRESS_UNAVAILABLE'
  return 'START_FAILED'
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): void {
  if (res.headersSent || res.writableEnded) return
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    ...headers
  })
  res.end(text)
}

/**
 * MCP 服务控制器：HTTP 监听、鉴权与 SDK handler 的启停。
 *
 * 不 import electron：配置、版本、网卡列表、工具调用入口都由 index.ts 注入，
 * 这样可以脱离 Electron 单独编译、单独起服务做协议烟测。
 */
export function createMcpServer(options: McpServerOptions): McpServerController {
  const settingsStore: McpSettingsStore = options.settings
  const listAddresses = options.listAddresses ?? listLanAddresses
  let httpServer: Server | null = null
  let listeningConfig: { host: string; port: number } | null = null
  let startedAt = ''
  let lastError: McpError | '' = ''
  let disposed = false
  /** 串行化 start / stop：连点保存时不会同时 listen 两个端口 */
  let transition: Promise<unknown> = Promise.resolve()
  let handler: McpHttpHandler | null = null
  let nodeHandler: NodeMcpRequestHandler | null = null

  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = transition.then(task, task)
    transition = next.catch(() => {})
    return next
  }

  function buildState(): McpState {
    const settings = settingsStore.get()
    const config = listeningConfig ?? settings
    const addresses = listAddresses()
    return {
      running: Boolean(httpServer?.listening),
      host: config.host,
      port: config.port,
      urls: mcpUrls(config.host, config.port, addresses),
      addresses,
      ...(lastError ? { error: lastError } : {}),
      startedAt
    }
  }

  function snapshot(): McpSnapshot {
    return { settings: settingsStore.get(), state: buildState() }
  }

  function notify(): void {
    options.onChange?.(snapshot())
  }

  function ensureHandler(): { handler: McpHttpHandler; nodeHandler: NodeMcpRequestHandler } {
    if (handler && nodeHandler) return { handler, nodeHandler }
    const mcpHandler = createMcpHandler(
      () => {
        const server = new McpServer(
          { name: SERVER_NAME, version: options.version },
          {
            instructions: INSTRUCTIONS,
            capabilities: { tools: { listChanged: false } }
          }
        )
        registerMcpTools(server, options.invoke)
        return server
      },
      {
        legacy: 'stateless',
        responseMode: 'json',
        maxRequestBodySize: MAX_BODY_BYTES,
        onerror: (error) => console.error('[mcp] handler error', error)
      }
    )
    const node = toNodeHandler(mcpHandler, {
      maxRequestBodySize: MAX_BODY_BYTES,
      onerror: (error) => console.error('[mcp] node adapter error', error)
    })
    handler = mcpHandler
    nodeHandler = node
    return { handler, nodeHandler }
  }

  function authorized(req: IncomingMessage, expectedToken: string): boolean {
    let provided = ''
    const header = req.headers.authorization
    if (typeof header === 'string' && /^Bearer\s+/i.test(header)) {
      provided = header.replace(/^Bearer\s+/i, '').trim()
    }
    if (!provided) {
      try {
        provided = new URL(req.url ?? MCP_PATH, 'http://127.0.0.1').searchParams.get('token') ?? ''
      } catch {
        provided = ''
      }
    }
    if (!provided) return false
    const expected = Buffer.from(expectedToken)
    const actual = Buffer.from(provided)
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  }

  /** 每来源滑动窗口；正常 MCP 客户端远低于这个量 */
  function rateLimited(
    req: IncomingMessage,
    hits: Map<string, { count: number; resetAt: number }>
  ): boolean {
    const key = req.socket.remoteAddress ?? 'unknown'
    const now = Date.now()
    const entry = hits.get(key)
    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS })
      if (hits.size > 512) {
        for (const [itemKey, item] of hits) {
          if (item.resetAt <= now) hits.delete(itemKey)
        }
      }
      return false
    }
    entry.count += 1
    return entry.count > RATE_LIMIT
  }

  async function start(settings: McpSettings): Promise<McpError | null> {
    let node: NodeMcpRequestHandler
    try {
      node = ensureHandler().nodeHandler
    } catch (error) {
      console.error('[mcp] 创建 MCP handler 失败', error)
      lastError = 'START_FAILED'
      return lastError
    }

    const addresses = listAddresses()
    const allowedHostnames = [
      ...new Set([
        'localhost',
        '127.0.0.1',
        '[::1]',
        ...addresses.map((item) => item.address),
        ...(settings.host !== LAN_ALL_INTERFACES ? [settings.host] : [])
      ])
    ]
    const validateHost = hostHeaderValidation(allowedHostnames)
    const validateOrigin = originValidation(allowedHostnames)
    const hits = new Map<string, { count: number; resetAt: number }>()

    async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
      res.setHeader('X-Content-Type-Options', 'nosniff')
      const pathname = (req.url ?? '/').split('?')[0]
      if (pathname !== MCP_PATH && pathname !== `${MCP_PATH}/`) {
        sendJson(res, 404, { ok: false, error: 'NOT_FOUND' })
        return
      }
      const length = Number(req.headers['content-length'] ?? 0)
      if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
        sendJson(res, 413, { ok: false, error: 'PAYLOAD_TOO_LARGE' })
        return
      }
      // SDK 的守卫会自己写 403，返回 false 时不能再碰 response
      if (!validateHost(req, res)) return
      if (!validateOrigin(req, res)) return
      if (rateLimited(req, hits)) {
        sendJson(res, 429, { ok: false, error: 'TOO_MANY_REQUESTS' }, { 'Retry-After': '60' })
        return
      }
      // token 每次请求都读当前配置：改 token 不需要重启服务
      const expectedToken = settingsStore.get().token
      if (expectedToken && !authorized(req, expectedToken)) {
        sendJson(res, 401, { ok: false, error: 'UNAUTHORIZED' }, { 'WWW-Authenticate': 'Bearer' })
        return
      }
      await node(req, res)
    }

    const candidate = createServer((req, res) => {
      void handleRequest(req, res).catch((error) => {
        console.error('[mcp] 请求处理失败', error)
        if (!res.headersSent) {
          sendJson(res, 500, { ok: false, error: 'SERVER_ERROR' })
        } else {
          res.destroy()
        }
      })
    })
    candidate.requestTimeout = 10 * 60 * 1000

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          candidate.off('listening', onListening)
          reject(error)
        }
        const onListening = (): void => {
          candidate.off('error', onError)
          resolve()
        }
        candidate.once('error', onError)
        candidate.once('listening', onListening)
        candidate.listen(settings.port, settings.host)
      })
    } catch (error) {
      lastError = mapListenError(error)
      try {
        candidate.close()
      } catch {
        // 没进入监听状态时 close 可能抛 ERR_SERVER_NOT_RUNNING
      }
      httpServer = null
      listeningConfig = null
      startedAt = ''
      return lastError
    }

    httpServer = candidate
    listeningConfig = { host: settings.host, port: settings.port }
    startedAt = new Date().toISOString()
    lastError = ''
    // 监听之后的错误（例如网卡被拔掉）：关掉服务并通知面板，不要留下假运行状态
    candidate.on('error', (error) => {
      if (httpServer !== candidate) return
      lastError = mapListenError(error)
      httpServer = null
      listeningConfig = null
      startedAt = ''
      try {
        candidate.closeAllConnections?.()
        candidate.close()
      } catch {
        // 已经关闭
      }
      notify()
    })
    return null
  }

  async function stopInternal(): Promise<void> {
    const active = httpServer
    httpServer = null
    listeningConfig = null
    startedAt = ''
    if (!active) return
    try {
      active.closeAllConnections?.()
    } catch {
      // 旧版 Node 没有这个方法时忽略
    }
    await new Promise<void>((resolve) => {
      try {
        active.close(() => resolve())
      } catch {
        resolve()
      }
    })
  }

  async function configure(patch: unknown): Promise<McpConfigureResult> {
    return serialize(async () => {
      const current = settingsStore.get()
      if (disposed) {
        return {
          ok: false,
          error: 'START_FAILED',
          message: '应用正在退出',
          settings: current,
          state: buildState()
        }
      }
      if (!patch || typeof patch !== 'object') {
        return {
          ok: false,
          error: 'INVALID_INPUT',
          message: messageFor('INVALID_INPUT'),
          settings: current,
          state: buildState()
        }
      }
      const source = patch as Record<string, unknown>
      const next: McpSettings = { ...current }
      if ('enabled' in source) {
        if (typeof source.enabled !== 'boolean') {
          return {
            ok: false,
            error: 'INVALID_INPUT',
            message: 'enabled 必须是布尔值',
            settings: current,
            state: buildState()
          }
        }
        next.enabled = source.enabled
      }
      if ('host' in source) {
        if (typeof source.host !== 'string') {
          return {
            ok: false,
            error: 'INVALID_HOST',
            message: messageFor('INVALID_HOST'),
            settings: current,
            state: buildState()
          }
        }
        next.host = source.host.trim()
      }
      if ('port' in source) {
        const port = Number(source.port)
        if (!Number.isInteger(port) || port < 1024 || port > 65535) {
          return {
            ok: false,
            error: 'INVALID_PORT',
            message: messageFor('INVALID_PORT'),
            settings: current,
            state: buildState()
          }
        }
        next.port = port
      }
      if ('token' in source) {
        if (typeof source.token !== 'string') {
          return {
            ok: false,
            error: 'INVALID_INPUT',
            message: 'token 必须是字符串',
            settings: current,
            state: buildState()
          }
        }
        next.token = source.token.trim().slice(0, 256)
      }

      const problem = next.enabled ? validateMcpSettings(next) : validateMcpListener(next)
      if (problem) {
        return {
          ok: false,
          error: problem,
          message: messageFor(problem),
          settings: current,
          state: buildState()
        }
      }

      const listenerChanged = next.host !== current.host || next.port !== current.port
      const saved = normalizeMcpSettings(settingsStore.save(next))

      if (!saved.enabled) {
        lastError = ''
        await stopInternal()
        notify()
        return { ok: true, settings: saved, state: buildState() }
      }

      // 已在运行且监听配置没变：token 等改动已经落盘，下一次请求立即生效
      if (httpServer?.listening && !listenerChanged) {
        lastError = ''
        notify()
        return { ok: true, settings: saved, state: buildState() }
      }

      if (httpServer) await stopInternal()
      lastError = ''
      const error = await start(saved)
      notify()
      if (error) {
        return {
          ok: false,
          error,
          message: messageFor(error),
          settings: saved,
          state: buildState()
        }
      }
      return { ok: true, settings: saved, state: buildState() }
    })
  }

  async function init(): Promise<void> {
    if (disposed) return
    const settings = settingsStore.get()
    if (!settings.enabled) {
      lastError = ''
      return
    }
    const problem = validateMcpSettings(settings)
    if (problem) {
      lastError = problem
      console.error('[mcp] 配置不合法：', messageFor(problem))
      notify()
      return
    }
    const error = await start(settings)
    if (error) console.error('[mcp] 启动失败：', messageFor(error))
    notify()
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    const active = httpServer
    httpServer = null
    listeningConfig = null
    startedAt = ''
    if (active) {
      try {
        active.closeAllConnections?.()
      } catch {
        // 忽略
      }
      try {
        active.close()
      } catch {
        // 忽略
      }
    }
    if (handler) {
      const activeHandler = handler
      handler = null
      nodeHandler = null
      void activeHandler.close().catch((error) => console.error('[mcp] 关闭 handler 失败', error))
    }
  }

  return { init, snapshot, configure, dispose }
}
