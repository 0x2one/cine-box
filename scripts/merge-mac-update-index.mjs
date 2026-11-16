// 合并两个 macOS 架构各自生成的 latest-mac.yml。
//
// 两个 macOS job 各跑一次 electron-builder，都会产出同名的 latest-mac.yml，谁后上传谁覆盖，
// 于是索引里只剩一个架构。而 electron-updater 下载 mac 更新时只读索引的 files 列表：
// MacUpdater.filterFilesForArch 优先选带 arm64 的条目，列表里没有 arm64 就退回 x64 包，
// 结果 Apple Silicon 机器会被更新成 Intel 版。所以这里把两份索引合成一份再上传。
//
// 两份索引都来自 electron-builder，结构固定（顶层标量 + files 列表），故不引入 YAML 依赖。
//
// 用法：node scripts/merge-mac-update-index.mjs <索引目录> <输出文件> [期望版本]

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const ARCH_ORDER = ['x64', 'arm64']
const INDEX_FILE_PATTERN = /^latest-mac-[\w-]+\.yml$/
const ARCH_IN_URL_PATTERN = /-(x64|arm64)\.(?:dmg|zip)$/

function unquote(value) {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
      return value.slice(1, -1)
    }
  }
  return value
}

// 只解析 electron-builder 会写出的那几个键，其它顶层键忽略（如 stagingPercentage）
function parseIndex(text, source) {
  const index = { version: null, releaseDate: null, files: [] }
  let inFiles = false
  let entry = null

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd()
    if (line === '' || line.trimStart().startsWith('#')) continue

    const topLevel = /^([A-Za-z0-9_]+):(.*)$/.exec(line)
    if (topLevel != null) {
      const [, key, rest] = topLevel
      const value = rest.trim()
      inFiles = key === 'files' && value === ''
      entry = null
      if (!inFiles && (key === 'version' || key === 'releaseDate')) index[key] = unquote(value)
      continue
    }

    if (!inFiles) throw new Error(`${source}: 无法解析的行 ${JSON.stringify(line)}`)

    const url = /^\s*-\s+url:\s*(.+)$/.exec(line)
    if (url != null) {
      entry = { url: unquote(url[1].trim()) }
      index.files.push(entry)
      continue
    }

    const field = /^\s{2,}([A-Za-z0-9_]+):\s*(.+)$/.exec(line)
    if (field != null && entry != null) {
      entry[field[1]] = unquote(field[2].trim())
      continue
    }

    throw new Error(`${source}: 无法解析的行 ${JSON.stringify(line)}`)
  }

  return index
}

function archOfFile(file) {
  const match = ARCH_IN_URL_PATTERN.exec(file.url)
  if (match == null) throw new Error(`无法从产物名判断架构：${file.url}`)
  return match[1]
}

function merge(inputDir, expectedVersion) {
  const sources = readdirSync(inputDir)
    .filter((name) => INDEX_FILE_PATTERN.test(name))
    .sort()
  if (sources.length === 0) throw new Error(`${inputDir} 里没有 latest-mac-<arch>.yml`)

  const groups = new Map()
  const seenUrls = new Set()
  let version = null
  let releaseDate = null

  for (const name of sources) {
    const index = parseIndex(readFileSync(join(inputDir, name), 'utf8'), name)
    if (index.version == null) throw new Error(`${name}: 缺少 version`)

    if (version == null) {
      version = index.version
    } else if (version !== index.version) {
      throw new Error(`两份索引的版本不一致：${version} vs ${index.version}（${name}）`)
    }

    if (index.releaseDate != null && (releaseDate == null || index.releaseDate > releaseDate)) {
      releaseDate = index.releaseDate
    }

    for (const file of index.files) {
      if (file.sha512 == null) throw new Error(`${name}: ${file.url} 缺少 sha512`)
      if (seenUrls.has(file.url)) continue
      seenUrls.add(file.url)
      const arch = archOfFile(file)
      if (!groups.has(arch)) groups.set(arch, [])
      groups.get(arch).push(file)
    }
  }

  // arm64 设备拿不到 arm64 条目会静默退回 x64 包，宁可直接失败也不要上传坏索引
  for (const arch of ARCH_ORDER) {
    const files = groups.get(arch)
    if (files == null || files.length === 0) {
      throw new Error(`索引里缺少 mac-${arch} 的产物，客户端会挑到错误的架构`)
    }
    if (!files.some((file) => file.url.endsWith('.zip'))) {
      throw new Error(`mac-${arch} 缺少 zip 产物，electron-updater 只下载 zip`)
    }
  }

  if (expectedVersion != null) {
    const expected = expectedVersion.replace(/^v/, '')
    if (expected !== version) {
      throw new Error(`索引版本 ${version} 与标签 ${expectedVersion} 不一致`)
    }
  }

  const restArches = [...groups.keys()].filter((arch) => !ARCH_ORDER.includes(arch)).sort()
  const files = [...ARCH_ORDER, ...restArches].flatMap((arch) => groups.get(arch) ?? [])
  const primary = files.find((file) => file.url.endsWith('.zip')) ?? files[0]

  const lines = [`version: ${version}`, 'files:']
  for (const file of files) {
    lines.push(`  - url: ${file.url}`)
    for (const [key, value] of Object.entries(file)) {
      if (key === 'url') continue
      lines.push(`    ${key}: ${value}`)
    }
  }
  // 顶层 path/sha512 是旧格式兜底，Provider 有 files 时不读它，保持指向主产物即可
  lines.push(`path: ${primary.url}`, `sha512: ${primary.sha512}`)
  if (releaseDate != null) lines.push(`releaseDate: '${releaseDate}'`)

  return { text: `${lines.join('\n')}\n`, sources, arches: [...ARCH_ORDER, ...restArches] }
}

function main() {
  const [inputDir, outputFile, expectedVersion] = process.argv.slice(2)
  if (inputDir == null || outputFile == null) {
    throw new Error(
      '用法：node scripts/merge-mac-update-index.mjs <索引目录> <输出文件> [期望版本]'
    )
  }

  const { text, sources, arches } = merge(inputDir, expectedVersion)
  mkdirSync(dirname(outputFile), { recursive: true })
  writeFileSync(outputFile, text)

  console.log(`已合并 ${sources.join(', ')} → ${outputFile}（架构：${arches.join(', ')}）`)
  console.log(text)
}

try {
  main()
} catch (error) {
  // CI 里只需要一眼能看懂的原因，不打整段栈
  console.error(`合并 latest-mac.yml 失败：${error.message}`)
  process.exit(1)
}
