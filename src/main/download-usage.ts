import { promises as fsp } from 'fs'
import { join } from 'path'

/** 下载目录的占用情况 + 所在磁盘的容量，给「设置 › 下载」的概览用 */
export interface DownloadUsage {
  /** 实际扫描的目录 */
  path: string
  /** 目录里的文件数（递归） */
  files: number
  /** 目录里所有文件的总字节数 */
  size: number
  /** 所在磁盘总容量 */
  total: number
  /** 所在磁盘剩余可用空间 */
  free: number
}

/** 最多往下看几层：下载目录是平的，设个上限防止异常目录把扫描拖长 */
const MAX_DEPTH = 8

/**
 * 递归累加目录里的文件。读不到的条目直接跳过：
 * 下载中的文件可能刚被改名 / 删掉，不能因为个别文件让整份统计失败。
 * 只统计普通文件（不跟符号链接），所以不会绕进环。
 */
async function walk(
  dir: string,
  acc: { files: number; size: number },
  depth: number
): Promise<void> {
  if (depth > MAX_DEPTH) return
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      await walk(full, acc, depth + 1)
      continue
    }
    if (!entry.isFile()) continue
    try {
      const info = await fsp.stat(full)
      acc.files += 1
      acc.size += info.size
    } catch {
      // 文件刚好被删掉 / 没权限，跳过
    }
  }
}

/** 扫描下载目录并读取所在磁盘的容量；磁盘信息拿不到时只返回目录占用 */
export async function readDownloadUsage(dir: string): Promise<DownloadUsage> {
  const acc = { files: 0, size: 0 }
  await walk(dir, acc, 0)

  let total = 0
  let free = 0
  try {
    const info = await fsp.statfs(dir)
    total = info.bsize * info.blocks
    // bavail 是普通用户可用的空间（Windows 上和 bfree 相同）
    free = info.bsize * info.bavail
  } catch {
    // 目录所在磁盘读不到：只是没有容量数据，目录占用照样返回
  }

  return { path: dir, files: acc.files, size: acc.size, total, free }
}
