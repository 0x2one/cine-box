import { createServer, connect, type AddressInfo, type Server, type Socket } from 'node:net'

/**
 * 本机代理桥接。
 *
 * Chromium 的 `session.setProxy` 能配 HTTP / SOCKS5 代理，但：
 * - SOCKS5 只支持无认证（只提供一个 0x00 方法），带用户名密码会直接
 *   `ERR_NO_SUPPORTED_PROXIES`；
 * - 主进程 `net.fetch` 的代理认证只在 `app.on('login')` 这条路上，无法保证
 *   无 webContents 的请求也能拿到凭据。
 *
 * 所以自定义代理统一走这里：本机起一个「无认证 SOCKS5」入口（只监听
 * 127.0.0.1），Chromium 把整条 TCP 连接交给它，再由它按配置连上游 HTTP / SOCKS5
 * 代理（带 Basic / 用户名密码认证）并双向转发。HTTPS、HTTP、视频分片都只是
 * TCP 隧道，不需要解析 HTTP 报文，长连接 / 流式传输天然支持。
 */

const HANDSHAKE_TIMEOUT = 15_000
const MAX_PROXY_HEAD = 32 * 1024

export type ProxyBridgeErrorCode =
  'UNREACHABLE' | 'AUTH' | 'CONNECT_FAILED' | 'PROTOCOL' | 'TIMEOUT'

export interface ProxyBridgeError {
  code: ProxyBridgeErrorCode
  message: string
}

export interface ProxyBridgeConfig {
  type: 'http' | 'socks5'
  host: string
  port: number
  authEnabled: boolean
  username: string
  password: string
}

export interface ProxyBridge {
  /** 本机 SOCKS5 入口端口（固定 127.0.0.1） */
  port: number
  /** 最近一次失败原因：代理验证据此给出「认证失败 / 连不上」这类具体提示 */
  lastError: () => ProxyBridgeError | null
  dispose: () => Promise<void>
}

class BridgeFailure extends Error {
  readonly code: ProxyBridgeErrorCode

  constructor(code: ProxyBridgeErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

/** 顺序读 socket：先读固定字节数，握手完成后把剩余字节原样交还给隧道 */
class SocketReader {
  private buffer: Buffer = Buffer.alloc(0)
  private waiters: Array<() => void> = []
  private failure: Error | null = null
  private readonly onData: (chunk: Buffer) => void
  private readonly onClose: () => void

  constructor(private readonly socket: Socket) {
    this.onData = (chunk) => {
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
      this.releaseWaiters()
    }
    this.onClose = (): void => {
      this.failure = this.failure ?? new Error('SOCKET_CLOSED')
      this.releaseWaiters()
    }
    socket.on('data', this.onData)
    socket.on('end', this.onClose)
    socket.on('close', this.onClose)
    socket.on('error', this.onClose)
  }

  async read(length: number): Promise<Buffer> {
    while (this.buffer.length < length) {
      if (this.failure) throw this.failure
      if (this.socket.destroyed) throw new Error('SOCKET_CLOSED')
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    }
    const value = this.buffer.subarray(0, length)
    this.buffer = this.buffer.subarray(length)
    return value
  }

  /** 解除数据监听，返回还没消费的字节（握手后的第一批业务数据） */
  release(): Buffer {
    this.socket.off('data', this.onData)
    const rest = this.buffer
    this.buffer = Buffer.alloc(0)
    return rest
  }

  private releaseWaiters(): void {
    const waiters = this.waiters
    this.waiters = []
    for (const waiter of waiters) waiter()
  }
}

function socksReply(code: number): Buffer {
  // VER REP RSV ATYP BND.ADDR BND.PORT（IPv4 0.0.0.0:0）
  return Buffer.from([0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
}

function formatAuthority(host: string, port: number): string {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`
}

function describeError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code || (error instanceof Error ? error.message : 'UNKNOWN')
}

function connectToProxy(host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new BridgeFailure('TIMEOUT', '连接代理服务器超时'))
    }, HANDSHAKE_TIMEOUT)
    socket.once('connect', () => {
      clearTimeout(timer)
      resolve(socket)
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(new BridgeFailure('UNREACHABLE', `无法连接代理服务器（${describeError(error)}）`))
    })
  })
}

/** 读上游 HTTP 代理的 CONNECT 应答头，返回状态码与头之后的剩余字节 */
async function readHttpHead(socket: Socket): Promise<{ status: number; rest: Buffer }> {
  socket.setTimeout(HANDSHAKE_TIMEOUT)
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0)
    let settled = false
    const finish = (error: Error | null, status = 0, rest = Buffer.alloc(0)): void => {
      if (settled) return
      settled = true
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
      socket.off('timeout', onTimeout)
      socket.setTimeout(0)
      if (error) reject(error)
      else resolve({ status, rest })
    }
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk])
      const end = buffered.indexOf('\r\n\r\n')
      if (end < 0) {
        if (buffered.length > MAX_PROXY_HEAD) {
          finish(new BridgeFailure('PROTOCOL', '代理返回的响应头过长'))
        }
        return
      }
      const head = buffered.subarray(0, end).toString('latin1')
      const first = head.split('\r\n')[0] ?? ''
      const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(first)
      if (!match) {
        finish(new BridgeFailure('PROTOCOL', `代理返回了无法识别的响应：${first.slice(0, 80)}`))
        return
      }
      finish(null, Number(match[1]), buffered.subarray(end + 4))
    }
    const onError = (error: Error): void => {
      finish(new BridgeFailure('UNREACHABLE', `代理连接中断（${describeError(error)}）`))
    }
    const onClose = (): void => finish(new BridgeFailure('PROTOCOL', '代理提前关闭了连接'))
    const onTimeout = (): void => finish(new BridgeFailure('TIMEOUT', '等待代理响应超时'))
    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('close', onClose)
    socket.once('timeout', onTimeout)
  })
}

/** 通过上游 HTTP 代理开一条 CONNECT 隧道 */
async function openHttpTunnel(
  config: ProxyBridgeConfig,
  host: string,
  port: number
): Promise<{ socket: Socket; rest: Buffer }> {
  const socket = await connectToProxy(config.host, config.port)
  const authority = formatAuthority(host, port)
  const lines = [
    `CONNECT ${authority} HTTP/1.1`,
    `Host: ${authority}`,
    'Proxy-Connection: Keep-Alive',
    'Connection: keep-alive'
  ]
  if (config.authEnabled) {
    const token = Buffer.from(`${config.username}:${config.password}`, 'utf8').toString('base64')
    lines.push(`Proxy-Authorization: Basic ${token}`)
  }
  socket.write(`${lines.join('\r\n')}\r\n\r\n`)
  const { status, rest } = await readHttpHead(socket)
  if (status === 407) {
    socket.destroy()
    throw new BridgeFailure(
      'AUTH',
      config.authEnabled
        ? '代理认证失败，请检查用户名和密码'
        : '代理要求身份验证，请打开身份验证并填写账号'
    )
  }
  if (status < 200 || status >= 300) {
    socket.destroy()
    throw new BridgeFailure('CONNECT_FAILED', `代理拒绝连接目标站点（HTTP ${status}）`)
  }
  return { socket, rest }
}

function socksAddress(host: string): Buffer {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const parts = host.split('.').map((part) => Number(part))
    if (parts.every((part) => part >= 0 && part <= 255)) {
      return Buffer.concat([Buffer.from([0x01]), Buffer.from(parts)])
    }
  }
  if (host.includes(':') && /^[0-9a-f:.]+$/i.test(host)) {
    // IPv6：把 :: 展开成 8 组 16 位
    const expanded = expandIpv6(host)
    if (expanded) return Buffer.concat([Buffer.from([0x04]), expanded])
  }
  const name = Buffer.from(host, 'utf8')
  if (name.length === 0 || name.length > 255) {
    throw new BridgeFailure('PROTOCOL', '目标地址不合法')
  }
  return Buffer.concat([Buffer.from([0x03, name.length]), name])
}

function expandIpv6(host: string): Buffer | null {
  const halves = host.split('::')
  if (halves.length > 2) return null
  const parse = (value: string): number[] | null => {
    if (!value) return []
    const groups = value.split(':')
    const result: number[] = []
    for (const group of groups) {
      if (!/^[0-9a-f]{1,4}$/i.test(group)) return null
      result.push(Number.parseInt(group, 16))
    }
    return result
  }
  const left = parse(halves[0] ?? '')
  const right = halves.length === 2 ? parse(halves[1] ?? '') : []
  if (!left || !right) return null
  const missing = 8 - left.length - right.length
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null
  const groups = [...left, ...new Array(halves.length === 2 ? missing : 0).fill(0), ...right]
  if (groups.length !== 8) return null
  const buffer = Buffer.alloc(16)
  groups.forEach((group, index) => buffer.writeUInt16BE(group, index * 2))
  return buffer
}

const SOCKS_REPLY_TEXT: Record<number, string> = {
  1: '代理服务器内部错误',
  2: '代理规则不允许该连接',
  3: '网络不可达',
  4: '目标主机不可达',
  5: '目标拒绝连接',
  6: 'TTL 过期',
  7: '代理不支持 CONNECT',
  8: '代理不支持该地址类型'
}

/** 通过上游 SOCKS5 代理开一条 CONNECT 隧道（支持用户名密码认证） */
async function openSocksTunnel(
  config: ProxyBridgeConfig,
  host: string,
  port: number
): Promise<{ socket: Socket; rest: Buffer }> {
  const socket = await connectToProxy(config.host, config.port)
  const reader = new SocketReader(socket)
  try {
    const methods = config.authEnabled ? [0x00, 0x02] : [0x00]
    socket.write(Buffer.from([0x05, methods.length, ...methods]))
    const greeting = await reader.read(2)
    if (greeting[0] !== 0x05) throw new BridgeFailure('PROTOCOL', '上游不是 SOCKS5 代理')
    const method = greeting[1]
    if (method === 0xff) {
      throw new BridgeFailure(
        'AUTH',
        config.authEnabled ? '代理拒绝了提供的认证方式' : '代理要求用户名密码认证'
      )
    }
    if (method === 0x02) {
      if (!config.authEnabled) throw new BridgeFailure('AUTH', '代理要求用户名密码认证')
      const username = Buffer.from(config.username, 'utf8')
      const password = Buffer.from(config.password, 'utf8')
      if (username.length > 255 || password.length > 255) {
        throw new BridgeFailure('AUTH', '代理用户名或密码过长')
      }
      socket.write(
        Buffer.concat([
          Buffer.from([0x01, username.length]),
          username,
          Buffer.from([password.length]),
          password
        ])
      )
      const auth = await reader.read(2)
      if (auth[0] !== 0x01 || auth[1] !== 0x00) {
        throw new BridgeFailure('AUTH', '代理认证失败，请检查用户名和密码')
      }
    } else if (method !== 0x00) {
      throw new BridgeFailure('PROTOCOL', `代理选择了不支持的认证方式（${method}）`)
    }

    const portBuffer = Buffer.alloc(2)
    portBuffer.writeUInt16BE(port, 0)
    socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), socksAddress(host), portBuffer]))
    const reply = await reader.read(4)
    if (reply[0] !== 0x05) throw new BridgeFailure('PROTOCOL', '代理返回了无法识别的 SOCKS 应答')
    if (reply[1] !== 0x00) {
      throw new BridgeFailure(
        'CONNECT_FAILED',
        `代理无法连接目标站点：${SOCKS_REPLY_TEXT[reply[1]] ?? `错误码 ${reply[1]}`}`
      )
    }
    // 消费 BND.ADDR / BND.PORT，避免把地址字节当成隧道数据
    const atyp = reply[3]
    if (atyp === 0x01) await reader.read(4)
    else if (atyp === 0x04) await reader.read(16)
    else if (atyp === 0x03) {
      const length = (await reader.read(1))[0]
      await reader.read(length)
    } else {
      throw new BridgeFailure('PROTOCOL', '代理返回了不支持的地址类型')
    }
    await reader.read(2)
    return { socket, rest: reader.release() }
  } catch (error) {
    socket.destroy()
    throw error
  }
}

interface TargetAddress {
  host: string
  port: number
}

async function readTarget(reader: SocketReader, atyp: number): Promise<TargetAddress> {
  let host: string
  if (atyp === 0x01) {
    const address = await reader.read(4)
    host = Array.from(address).join('.')
  } else if (atyp === 0x03) {
    const length = (await reader.read(1))[0]
    if (length === 0) throw new BridgeFailure('PROTOCOL', '目标域名为空')
    host = (await reader.read(length)).toString('utf8')
  } else if (atyp === 0x04) {
    const address = await reader.read(16)
    const groups: string[] = []
    for (let index = 0; index < 16; index += 2) {
      groups.push(address.readUInt16BE(index).toString(16))
    }
    host = groups.join(':')
  } else {
    throw new BridgeFailure('PROTOCOL', '不支持的 SOCKS 地址类型')
  }
  const port = (await reader.read(2)).readUInt16BE(0)
  if (!host || port <= 0) throw new BridgeFailure('PROTOCOL', '目标地址不合法')
  return { host, port }
}

function attachTunnel(client: Socket, upstream: Socket, rest: Buffer): void {
  client.setTimeout(0)
  client.write(socksReply(0x00))
  if (rest.length) upstream.write(rest)
  client.pipe(upstream)
  upstream.pipe(client)
  const closeBoth = (): void => {
    client.destroy()
    upstream.destroy()
  }
  client.on('close', closeBoth)
  upstream.on('close', closeBoth)
  client.on('error', closeBoth)
  upstream.on('error', closeBoth)
}

export async function startProxyBridge(config: ProxyBridgeConfig): Promise<ProxyBridge> {
  let lastError: ProxyBridgeError | null = null
  const clients = new Set<Socket>()

  const record = (error: unknown): BridgeFailure => {
    const failure =
      error instanceof BridgeFailure
        ? error
        : new BridgeFailure('PROTOCOL', error instanceof Error ? error.message : '代理连接失败')
    lastError = { code: failure.code, message: failure.message }
    return failure
  }

  const handleClient = async (client: Socket): Promise<void> => {
    const reader = new SocketReader(client)
    let opened = false
    try {
      const greeting = await reader.read(2)
      if (greeting[0] !== 0x05) throw new BridgeFailure('PROTOCOL', '不是 SOCKS5 请求')
      const methods = await reader.read(greeting[1])
      if (!methods.includes(0x00)) {
        client.end(Buffer.from([0x05, 0xff]))
        return
      }
      client.write(Buffer.from([0x05, 0x00]))
      const head = await reader.read(4)
      if (head[0] !== 0x05) throw new BridgeFailure('PROTOCOL', 'SOCKS 版本不匹配')
      if (head[1] !== 0x01) {
        client.end(socksReply(0x07))
        return
      }
      const target = await readTarget(reader, head[3])
      // 握手结束：先把客户端暂停并摘掉读监听，等隧道打通再恢复，
      // 否则 Chromium 抢先发来的 TLS ClientHello 会被缓冲丢在 reader 里
      client.pause()
      const early = reader.release()
      const tunnel =
        config.type === 'socks5'
          ? await openSocksTunnel(config, target.host, target.port)
          : await openHttpTunnel(config, target.host, target.port)
      if (client.destroyed) {
        tunnel.socket.destroy()
        return
      }
      opened = true
      lastError = null
      attachTunnel(client, tunnel.socket, Buffer.concat([early, tunnel.rest]))
      client.resume()
    } catch (error) {
      const failure = record(error)
      const replyCode =
        failure.code === 'AUTH'
          ? 0x02
          : failure.code === 'TIMEOUT'
            ? 0x06
            : failure.code === 'CONNECT_FAILED'
              ? 0x05
              : 0x01
      if (!client.destroyed && !opened) {
        try {
          client.end(socksReply(replyCode))
        } catch {
          client.destroy()
        }
      } else {
        client.destroy()
      }
    } finally {
      // 隧道建立后 SocketReader 已经解除 data 监听；失败时这里只做清理
      if (!opened) {
        try {
          reader.release()
        } catch {
          // 已关闭
        }
      }
    }
  }

  const server: Server = createServer((client) => {
    clients.add(client)
    client.on('close', () => clients.delete(client))
    client.on('error', () => client.destroy())
    client.setTimeout(HANDSHAKE_TIMEOUT, () => {
      lastError = { code: 'TIMEOUT', message: '代理握手超时' }
      client.destroy()
    })
    void handleClient(client)
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(0, '127.0.0.1')
  })

  const port = (server.address() as AddressInfo).port
  // 监听成功之后再出错（例如系统回收端口）：记下原因，别让进程因为未处理的 error 崩掉
  server.on('error', (error) => {
    lastError = { code: 'PROTOCOL', message: `本机代理入口异常（${describeError(error)}）` }
  })

  return {
    port,
    lastError: () => lastError,
    dispose: async () => {
      for (const client of clients) client.destroy()
      clients.clear()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
    }
  }
}
