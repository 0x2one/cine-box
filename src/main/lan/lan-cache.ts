/**
 * 局域网影院的「本机缓存」：把下载中心里已完成的缓存包暴露给网页端。
 *
 * 缓存包是 HLS 目录（index.m3u8 + 分片 / 密钥 / init），playlist 里的地址都已经改写成
 * 包内相对路径，所以网页端只要按 `/api/cached/<记录 id>/<包内相对路径>` 取，相对地址
 * 会自然落到同一个目录下，不需要再改写播放列表。
 *
 * 只放行 download-store 里 `done` 且 playlist 还在的 hls 记录：删除缓存后旧地址立即失效，
 * 也不会变成可以读任意文件的静态服务器。
 */

import { stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import type { DownloadStore } from '../download-store'
import type { LanCacheFile, LanCacheItem } from './lan-types'

export interface LanCache {
  /** 已完成的缓存记录；传 videoId 只取这一部 */
  list: (videoId?: number) => LanCacheItem[]
  /** 解析包内文件，非法路径 / 记录不可播时返回 null */
  resolveFile: (recordId: string, relativePath: string) => Promise<LanCacheFile | null>
}

const RECORD_ID = /^[0-9a-f]{32}$/i

/** 缓存包里的文件名都是 hls-download 生成的 ASCII 名字，白名单足够宽松也不会允许穿越 */
const RELATIVE_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/

const CONTENT_TYPES: Record<string, string> = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.m4s': 'video/iso.segment',
  '.mp4': 'video/mp4',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.vtt': 'text/vtt',
  '.webvtt': 'text/vtt',
  '.key': 'application/octet-stream',
  '.bin': 'application/octet-stream'
}

function contentTypeOf(file: string): string {
  return CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream'
}

function isValidRelativePath(value: string): boolean {
  if (!value || value.length > 512) return false
  if (!RELATIVE_PATH.test(value)) return false
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

export function createLanCache(store: Pick<DownloadStore, 'list' | 'find'>): LanCache {
  const list = (videoId?: number): LanCacheItem[] => {
    const items: LanCacheItem[] = []
    for (const record of store.list()) {
      if (record.kind !== 'hls' || record.status !== 'done' || !record.exists) continue
      // 没有 videoId 的记录没法在网页端按视频聚合，也没有可靠的片名，直接不暴露
      if (typeof record.videoId !== 'number' || record.videoId <= 0) continue
      if (videoId && record.videoId !== videoId) continue
      items.push({
        id: record.id,
        videoId: record.videoId,
        title: record.title,
        episodeName: record.episodeName,
        sourceName: record.sourceName,
        lineIndex: typeof record.lineIndex === 'number' ? record.lineIndex : 0,
        episodeIndex: typeof record.episodeIndex === 'number' ? record.episodeIndex : 0,
        size: record.size,
        updatedAt: record.updatedAt,
        playUrl: `/api/cached/${record.id}/index.m3u8`
      })
    }
    return items
  }

  const resolveFile = async (
    recordId: string,
    relativePath: string
  ): Promise<LanCacheFile | null> => {
    if (!RECORD_ID.test(recordId) || !isValidRelativePath(relativePath)) return null
    const record = store.find(recordId)
    if (!record || record.kind !== 'hls' || record.status !== 'done') return null
    if (!record.packageDir) return null
    const root = resolve(record.packageDir)
    const file = resolve(root, ...relativePath.split('/'))
    // 双保险：白名单已经挡掉 ../，这里再确认没有跳出包目录（大小写不敏感的文件系统也稳妥）
    if (file !== root && !file.startsWith(root + sep)) return null
    try {
      const info = await stat(file)
      if (!info.isFile()) return null
      return { file, contentType: contentTypeOf(file), size: info.size }
    } catch {
      return null
    }
  }

  return { list, resolveFile }
}
