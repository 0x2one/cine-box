import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { isIPv4 } from 'net'
import { networkInterfaces } from 'os'
import { dirname, join } from 'path'
import {
  LAN_ALL_INTERFACES,
  LAN_DEFAULT_PORT,
  LAN_MAX_PORT,
  LAN_MIN_PORT,
  type LanAddress
} from './lan-types'

export interface LanConfig {
  host: string
  port: number
}

const DEFAULT_CONFIG: LanConfig = { host: LAN_ALL_INTERFACES, port: LAN_DEFAULT_PORT }
const CONFIG_FILE = 'config.json'

/** 网卡排序：家用网段优先，其次是其它 IPv4，最后才是回环 */
function addressRank(address: string, loopback: boolean): number {
  if (loopback) return 100
  if (address.startsWith('192.168.')) return 0
  if (address.startsWith('10.')) return 1
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return 2
  return 10
}

/**
 * 虚拟网卡的地址（WSL / Hyper-V / VirtualBox / 手机热点共享的「本地连接*」等）
 * 通常不是手机能访问的那一个，排到最后；真实无线 / 有线网卡排最前。
 */
function interfaceRank(name: string): number {
  const lower = name.toLowerCase()
  if (
    /(vethernet|vmware|virtualbox|hyper-v|wsl|docker|veth|br-|bridge|utun|awdl|llw|tailscale|zerotier|radmin|tap|tun|ppp|bluetooth|本地连接\*|loopback)/i.test(
      name
    )
  ) {
    return 20
  }
  if (
    /^(en|eth|wlan|wlp|wl|enp|eno)\d/i.test(name) ||
    /(wlan|wi-?fi|wireless|ethernet|以太网|无线)/i.test(lower)
  ) {
    return 0
  }
  return 10
}

function compareAddress(left: LanAddress, right: LanAddress): number {
  const byInterface = interfaceRank(left.name) - interfaceRank(right.name)
  if (byInterface !== 0) return byInterface
  const rank = addressRank(left.address, left.loopback) - addressRank(right.address, right.loopback)
  if (rank !== 0) return rank
  return left.address.localeCompare(right.address, 'en', { numeric: true })
}

/**
 * 当前机器的 IPv4 地址：不暴露 IPv6（手机输地址太麻烦，服务也只监听 IPv4）。
 * 没有局域网地址时仍会返回回环地址，方便在本机浏览器里验证。
 */
export function listLanAddresses(): LanAddress[] {
  const seen = new Set<string>()
  const addresses: LanAddress[] = []
  try {
    for (const [name, entries] of Object.entries(networkInterfaces())) {
      for (const entry of entries ?? []) {
        if (entry.internal) continue
        if (entry.family !== 'IPv4') continue
        if (seen.has(entry.address)) continue
        seen.add(entry.address)
        addresses.push({ name, address: entry.address, loopback: false })
      }
    }
  } catch {
    // 拿不到网卡列表时至少还有回环地址
  }
  addresses.sort(compareAddress)
  if (!seen.has('127.0.0.1')) {
    addresses.push({ name: '本机', address: '127.0.0.1', loopback: true })
  }
  return addresses
}

export function isValidLanHost(host: string): boolean {
  return host === LAN_ALL_INTERFACES || isIPv4(host)
}

export function isValidLanPort(port: number): boolean {
  return Number.isInteger(port) && port >= LAN_MIN_PORT && port <= LAN_MAX_PORT
}

/**
 * 控制台里显示的访问地址：
 * - 绑定了具体 IP 时就是那一个；
 * - 绑定全部网卡时列出所有局域网地址（第一项给二维码用），没有局域网地址才退回回环。
 */
export function urlsFor(host: string, port: number, addresses: LanAddress[]): string[] {
  if (host !== LAN_ALL_INTERFACES) return [`http://${host}:${port}/`]
  const lan = addresses.filter((item) => !item.loopback)
  const chosen = lan.length > 0 ? lan : addresses.filter((item) => item.loopback)
  return chosen.map((item) => `http://${item.address}:${port}/`)
}

/** 读配置时宽松一点：文件坏了 / 值非法都退回默认值，不影响应用启动 */
export function createLanConfigStore(dataDir: string): {
  get: () => LanConfig
  save: (config: LanConfig) => LanConfig
  file: string
} {
  const file = join(dataDir, 'Lan', CONFIG_FILE)
  let cached: LanConfig | null = null

  const readFile = (): LanConfig => {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<LanConfig>
      const host = typeof parsed.host === 'string' ? parsed.host.trim() : ''
      const port = Number(parsed.port)
      return {
        host: isValidLanHost(host) ? host : DEFAULT_CONFIG.host,
        port: isValidLanPort(port) ? port : DEFAULT_CONFIG.port
      }
    } catch {
      return { ...DEFAULT_CONFIG }
    }
  }

  return {
    get: () => {
      if (!cached) cached = readFile()
      return { ...cached }
    },
    save: (config) => {
      cached = { host: config.host, port: config.port }
      try {
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, `${JSON.stringify(cached, null, 2)}\n`, 'utf-8')
      } catch (error) {
        console.error('保存局域网服务配置失败', error)
      }
      return { ...cached }
    },
    file
  }
}
