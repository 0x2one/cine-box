/**
 * 投屏（DLNA / UPnP AV）的主进程内部类型。
 *
 * 渲染层看到的那一份手写在 `src/preload/api.d.ts`（项目约定：IPC 类型不跨进程导入）。
 * 设备描述里的控制地址、LOCATION 这类字段只留在主进程，不下发给界面。
 */

/** 局域网里发现的一台 MediaRenderer */
export interface CastDevice {
  /** UDN（没有时退回 LOCATION），界面用它记住上次投的设备 */
  id: string
  name: string
  model: string
  manufacturer: string
  /** 厂商自报的型号 / 产品名，通常比 modelName 更能说明是哪台设备 */
  modelDescription: string
  /** 设备地址里的 host，用来挑同网段的本机 IP */
  host: string
  /** 设备描述地址里的端口；设备没写端口（默认 80）时为 0 */
  port: number
  /** 设备描述 XML 的地址 */
  location: string
  avTransport: string
  renderingControl: string
  connectionManager: string
}

/** 给渲染层的设备信息：不带控制地址 */
export interface CastDeviceView {
  id: string
  name: string
  /** 副标题：厂商自报的型号 / 产品名；为空时副标题退回 host:port */
  modelDescription: string
  host: string
  port: number
}

export type CastStatus = 'idle' | 'starting' | 'playing' | 'paused' | 'error'

/** 当前投屏会话（渲染层据此画设备名、状态卡、暂停/继续/停止） */
export interface CastState {
  active: boolean
  status: CastStatus
  deviceId?: string
  deviceName?: string
  /** hls：在线集经本机代理；cache：本机缓存包 */
  mode?: 'hls' | 'cache'
  title?: string
  episodeName?: string
  /** 电视上报的播放位置（秒），未知为 0 */
  position: number
  /** 电视上报的时长（秒），未知为 0 */
  duration: number
  /** 最近一次失败的中文说明 */
  error?: string
}

export type CastStartInput =
  | {
      deviceId: string
      kind: 'remote'
      videoId: number
      /** 当前播放的 m3u8 地址，由主进程按 videoId 再校验一次归属 */
      url: string
      /** 本地当前进度（秒）：投屏开始后电视从相近位置续播 */
      position?: number
      title?: string
      episodeName?: string
    }
  | {
      deviceId: string
      kind: 'cache'
      /** 下载中心里已完成的 hls 记录 id */
      recordId: string
      /** 本地当前进度（秒） */
      position?: number
      title?: string
      episodeName?: string
    }

export type CastErrorCode =
  | 'INVALID_INPUT'
  | 'NO_DEVICE'
  | 'DEVICE_OFFLINE'
  | 'NOT_FOUND'
  | 'NOT_HLS'
  | 'ADULT_HIDDEN'
  | 'NO_LAN_ADDRESS'
  | 'SERVER_FAILED'
  | 'SOAP_FAILED'
  | 'TIMEOUT'
  | 'UNSUPPORTED'

export interface CastStartResult {
  ok: boolean
  error?: CastErrorCode
  message?: string
  state: CastState
}

export interface CastDeviceListResult {
  ok: boolean
  devices: CastDeviceView[]
  /** 发现失败时的中文说明（没有网卡 / 端口被占等） */
  error?: string
}

/** 主进程解析后的投屏片源：原始地址只在这里出现，不交给渲染层 / 电视 */
export interface CastMedia {
  mode: 'hls' | 'cache'
  title: string
  episodeName: string
  /** 在线集的原始 m3u8；缓存集为空 */
  url?: string
  /** 缓存集的下载记录 id；在线集为空 */
  recordId?: string
}

export interface CastResolveResult {
  ok: boolean
  media?: CastMedia
  error?: CastErrorCode
  message?: string
}

/** 主进程注入的 fetch：生产传 net.fetch，便于走统一的网络代理 */
export type CastFetch = (input: string, init?: RequestInit) => Promise<Response>
