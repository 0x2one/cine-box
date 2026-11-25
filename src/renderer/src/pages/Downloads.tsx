import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  App,
  Button,
  Dropdown,
  Pagination,
  Progress,
  Segmented,
  Spin,
  Tag,
  Tooltip,
  Typography
} from 'antd'
import {
  ArrowLeftOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  CloudDownloadOutlined,
  DeleteOutlined,
  ExportOutlined,
  FolderOpenOutlined,
  MinusCircleOutlined,
  MoreOutlined,
  PauseCircleOutlined,
  PauseOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  RightOutlined,
  StopOutlined
} from '@ant-design/icons'
import { formatBytes, formatDateTime, formatShortDateTime } from '../utils/format'
import '../assets/downloads.css'

const { Text } = Typography

type DownloadFilter = 'all' | 'active' | 'done' | 'failed'

const FILTERS: { value: DownloadFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'active', label: '进行中' },
  { value: 'done', label: '已完成' },
  { value: 'failed', label: '失败' }
]

const STATUS_META: Record<
  DownloadStatus,
  { text: string; color: string; icon: React.JSX.Element }
> = {
  waiting: { text: '等待中', color: 'default', icon: <ClockCircleOutlined /> },
  downloading: { text: '缓存中', color: 'processing', icon: <CloudDownloadOutlined /> },
  paused: { text: '已暂停', color: 'warning', icon: <PauseCircleOutlined /> },
  done: { text: '已完成', color: 'success', icon: <CheckCircleOutlined /> },
  failed: { text: '失败', color: 'error', icon: <CloseCircleOutlined /> },
  canceled: { text: '已取消', color: 'default', icon: <StopOutlined /> }
}

/** 分组详情每页多少集：批量缓存几千集时只渲染一页 */
const GROUP_PAGE_SIZE = 100

function isActive(record: DownloadRecordView): boolean {
  return (
    record.status === 'waiting' || record.status === 'downloading' || record.status === 'paused'
  )
}

function isFinished(record: DownloadRecordView): boolean {
  return record.status === 'done' || record.status === 'failed' || record.status === 'canceled'
}

function matchesFilter(record: DownloadRecordView, filter: DownloadFilter): boolean {
  if (filter === 'active') return isActive(record)
  if (filter === 'done') return record.status === 'done'
  if (filter === 'failed') return record.status === 'failed'
  return true
}

/** 正在跑的任务排前面，其余按创建时间倒序（和后端返回的顺序一致） */
function statusWeight(status: DownloadStatus): number {
  if (status === 'downloading') return 0
  if (status === 'waiting') return 1
  if (status === 'paused') return 2
  return 3
}

function progressText(record: DownloadRecordView): string {
  if (record.totalBytes > 0) {
    return `${formatBytes(record.receivedBytes)} / ${formatBytes(record.totalBytes)}`
  }
  return record.receivedBytes > 0 ? formatBytes(record.receivedBytes) : ''
}

/** 下载速度：字节 / 秒；0 表示还没测出来 / 已停下 */
function formatSpeed(bytes: number): string {
  return bytes > 0 ? `${formatBytes(bytes)}/s` : ''
}

function recordSize(record: DownloadRecordView): number {
  return record.exists ? record.size : record.receivedBytes
}

interface DownloadGroup {
  key: string
  title: string
  records: DownloadRecordView[]
  latestAt: string
  totalSize: number
  done: number
  active: number
  paused: number
  failed: number
  /** 已经导出 MP4 的集数（用来在卡片上显示） */
  mp4Done: number
  activeRecord: DownloadRecordView | null
  percent: number
}

function sortGroupRecords(records: DownloadRecordView[]): DownloadRecordView[] {
  return [...records].sort((a, b) => {
    const lineA = typeof a.lineIndex === 'number' ? a.lineIndex : Number.MAX_SAFE_INTEGER
    const lineB = typeof b.lineIndex === 'number' ? b.lineIndex : Number.MAX_SAFE_INTEGER
    if (lineA !== lineB) return lineA - lineB
    const episodeA = typeof a.episodeIndex === 'number' ? a.episodeIndex : Number.MAX_SAFE_INTEGER
    const episodeB = typeof b.episodeIndex === 'number' ? b.episodeIndex : Number.MAX_SAFE_INTEGER
    if (episodeA !== episodeB) return episodeA - episodeB
    return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0
  })
}

/**
 * 下载中心按视频聚合：
 * - 同一 videoId 只有 1 条记录 → 平铺单集行；
 * - 2 条及以上 → 一张分组卡，点进去看逐集记录。
 * 没有 videoId 的旧记录（纯文件）自己一组。
 */
function buildGroups(records: DownloadRecordView[]): DownloadGroup[] {
  const map = new Map<string, DownloadRecordView[]>()
  for (const record of records) {
    const key = typeof record.videoId === 'number' ? `v:${record.videoId}` : `r:${record.id}`
    const list = map.get(key) ?? []
    list.push(record)
    map.set(key, list)
  }
  const groups: DownloadGroup[] = []
  for (const [key, list] of map) {
    const sorted = sortGroupRecords(list)
    const done = sorted.filter((record) => record.status === 'done').length
    const active = sorted.filter(
      (record) => record.status === 'waiting' || record.status === 'downloading'
    ).length
    const paused = sorted.filter((record) => record.status === 'paused').length
    const failed = sorted.filter(
      (record) => record.status === 'failed' || record.status === 'canceled'
    ).length
    const mp4Done = sorted.filter(
      (record) => record.mp4Status === 'done' && record.mp4Exists
    ).length
    const latestAt = sorted.reduce(
      (latest, record) => (record.updatedAt > latest ? record.updatedAt : latest),
      sorted[0].updatedAt
    )
    const totalSize = sorted.reduce((sum, record) => sum + recordSize(record), 0)
    const percent =
      sorted.length === 0
        ? 0
        : Math.round(
            sorted.reduce(
              (sum, record) =>
                sum + (record.status === 'done' ? 100 : isActive(record) ? record.progress : 0),
              0
            ) / sorted.length
          )
    groups.push({
      key,
      title: sorted[0].title?.trim() || sorted[0].fileName || '未命名视频',
      records: sorted,
      latestAt,
      totalSize,
      done,
      active,
      paused,
      failed,
      mp4Done,
      activeRecord:
        sorted.find((record) => record.status === 'downloading') ??
        sorted.find((record) => record.status === 'waiting') ??
        sorted.find((record) => record.status === 'paused') ??
        null,
      percent
    })
  }
  return groups.sort((a, b) => {
    const activeDiff = Number(b.active > 0 || b.paused > 0) - Number(a.active > 0 || a.paused > 0)
    if (activeDiff !== 0) return activeDiff
    return a.latestAt < b.latestAt ? 1 : a.latestAt > b.latestAt ? -1 : 0
  })
}

function groupStatusText(group: DownloadGroup): string {
  const parts: string[] = []
  if (group.done > 0) parts.push(`已完成 ${group.done} 集`)
  if (group.active > 0) parts.push(`缓存中 ${group.active} 集`)
  if (group.paused > 0) parts.push(`已暂停 ${group.paused} 集`)
  if (group.failed > 0) parts.push(`失败 ${group.failed} 集`)
  return parts.join(' · ') || '等待开始'
}

function groupActiveText(group: DownloadGroup): string {
  const record = group.activeRecord
  if (!record) return ''
  if (record.status === 'paused') return `已暂停 ${Math.round(record.progress)}%`
  if (record.status === 'waiting') return '排队中'
  const speed = record.speed > 0 ? ` · ↓ ${formatSpeed(record.speed)}` : ''
  return `正在缓存 ${Math.round(record.progress)}%${speed}`
}

function retryErrorText(error?: string): string {
  if (error === 'NOT_RETRYABLE') return '这个任务正在运行，不用重试'
  if (error === 'NO_URL') return '没有保存播放地址，请回到播放页重新缓存'
  if (error === 'NOT_FOUND') return '记录已不存在'
  return '重新加入缓存失败'
}

/* ── 单集记录行 ── */

interface RecordRowProps {
  record: DownloadRecordView
  pending: boolean
  onPlay: (record: DownloadRecordView) => void
  onOpenFolder: (record: DownloadRecordView) => void
  onRemove: (record: DownloadRecordView, deleteFile: boolean) => void
  onPause: (record: DownloadRecordView) => void
  onResume: (record: DownloadRecordView) => void
  onCancel: (record: DownloadRecordView) => void
  onRetry: (record: DownloadRecordView) => void
  onExport: (record: DownloadRecordView) => void
  onCancelExport: (record: DownloadRecordView) => void
  onOpenMp4: (record: DownloadRecordView) => void
  onRemoveMp4: (record: DownloadRecordView) => void
}

function RecordRow({
  record,
  pending,
  onPlay,
  onOpenFolder,
  onRemove,
  onPause,
  onResume,
  onCancel,
  onRetry,
  onExport,
  onCancelExport,
  onOpenMp4,
  onRemoveMp4
}: RecordRowProps): React.JSX.Element {
  const meta = STATUS_META[record.status]
  const sizeText = record.exists ? formatBytes(record.size) : ''
  const active = isActive(record)
  const canPause = record.status === 'waiting' || record.status === 'downloading'
  const canRetry = record.status === 'failed' || record.status === 'canceled'
  return (
    <div className="download-record">
      <span className={`download-record-icon is-${record.status}`} aria-hidden="true">
        {meta.icon}
      </span>

      <div className="download-record-main">
        <div className="download-record-title">
          <span className="download-record-name" title={record.title}>
            {record.title}
          </span>
          {record.episodeName && <span className="download-record-ep">{record.episodeName}</span>}
          {record.sourceName && <span className="download-record-source">{record.sourceName}</span>}
        </div>

        <div className="download-record-meta">
          <Tag color={meta.color}>{meta.text}</Tag>
          {record.kind === 'hls' && <Tag>离线缓存</Tag>}
          {record.exists ? (
            <span>{sizeText}</span>
          ) : record.status === 'done' ? (
            <Text type="warning">文件已丢失</Text>
          ) : null}
          {active && record.receivedBytes > 0 && (
            <span>
              {progressText(record)}
              {record.receivedBytes > 0 ? ` · ${Math.round(record.progress)}%` : ''}
            </span>
          )}
          {record.status === 'downloading' && record.speed > 0 && (
            <span className="download-record-speed">↓ {formatSpeed(record.speed)}</span>
          )}
          {record.mp4Status === 'done' && record.mp4Exists && (
            <span className="download-record-mp4">MP4 已导出 · {formatBytes(record.mp4Size)}</span>
          )}
          {record.mp4Status === 'done' && record.mp4Exists && record.mp4Note && (
            <Tooltip title={record.mp4Note}>
              <span className="download-record-mp4-note">HEVC</span>
            </Tooltip>
          )}
          {record.mp4Status === 'done' && !record.mp4Exists && (
            <Text type="warning">MP4 已丢失</Text>
          )}
          {record.mp4Status === 'queued' && (
            <span className="download-record-mp4 is-active">MP4 排队中</span>
          )}
          {record.mp4Status === 'converting' && (
            <span className="download-record-mp4 is-active">
              MP4 转换中 {Math.round(record.mp4Progress)}%
            </span>
          )}
          {record.mp4Status === 'failed' && (
            <Tooltip title={record.mp4Error || 'MP4 转换失败'}>
              <Text type="warning">MP4 转换失败</Text>
            </Tooltip>
          )}
          {record.status === 'failed' && record.error && (
            <Tooltip title={record.error}>
              <Text type="warning">查看失败原因</Text>
            </Tooltip>
          )}
          <span className="download-record-file" title={record.path}>
            {record.fileName}
          </span>
          <span>
            {record.status === 'done' && record.completedAt
              ? `完成于 ${formatShortDateTime(record.completedAt)}`
              : formatDateTime(record.updatedAt)}
          </span>
        </div>

        {active && (
          <Progress
            className="download-record-progress"
            percent={Math.round(record.progress)}
            size="small"
            status={record.status === 'paused' ? 'normal' : 'active'}
            showInfo={false}
          />
        )}
        {record.mp4Status === 'converting' && (
          <Progress
            className="download-record-progress is-mp4"
            percent={Math.round(record.mp4Progress)}
            size="small"
            status="active"
            showInfo={false}
          />
        )}
      </div>

      <div className="download-record-actions">
        {record.status === 'done' && record.exists && (
          <Button size="small" icon={<PlayCircleOutlined />} onClick={() => onPlay(record)}>
            播放
          </Button>
        )}
        {record.kind === 'hls' &&
          record.status === 'done' &&
          record.exists &&
          (record.mp4Status === 'queued' || record.mp4Status === 'converting' ? (
            <Button
              size="small"
              type="text"
              loading={pending}
              onClick={() => onCancelExport(record)}
            >
              取消转换
            </Button>
          ) : (
            <Button
              size="small"
              icon={<ExportOutlined />}
              loading={pending}
              onClick={() => onExport(record)}
            >
              {record.mp4Status === 'done' && record.mp4Exists ? '重新导出' : '转 MP4'}
            </Button>
          ))}
        {canPause && (
          <Button
            size="small"
            icon={<PauseOutlined />}
            loading={pending}
            onClick={() => onPause(record)}
          >
            暂停
          </Button>
        )}
        {record.status === 'paused' && (
          <Button
            size="small"
            icon={<PlayCircleOutlined />}
            loading={pending}
            onClick={() => onResume(record)}
          >
            继续
          </Button>
        )}
        {active && (
          <Button size="small" type="text" loading={pending} onClick={() => onCancel(record)}>
            取消
          </Button>
        )}
        {canRetry && (
          <Button size="small" loading={pending} onClick={() => onRetry(record)}>
            重试
          </Button>
        )}
        <Dropdown
          trigger={['click']}
          placement="bottomRight"
          menu={{
            items: [
              {
                key: 'folder',
                icon: <FolderOpenOutlined />,
                label: '打开所在文件夹'
              },
              { type: 'divider' },
              {
                key: 'mp4-folder',
                icon: <FolderOpenOutlined />,
                label: '打开 MP4 所在文件夹',
                disabled: !record.mp4Exists
              },
              {
                key: 'mp4-remove',
                icon: <DeleteOutlined />,
                label: '删除 MP4',
                danger: true,
                disabled: !record.mp4Exists
              },
              { type: 'divider' },
              {
                key: 'remove',
                icon: <MinusCircleOutlined />,
                label: '移除记录'
              },
              {
                key: 'delete',
                icon: <DeleteOutlined />,
                label: record.kind === 'hls' ? '删除这一集缓存' : '删除文件',
                danger: true,
                // hls 可能只有部分缓存包（没有 playlist），也允许清理
                disabled: record.kind === 'hls' ? false : !record.exists
              }
            ],
            onClick: ({ key }) => {
              if (key === 'folder') {
                onOpenFolder(record)
                return
              }
              if (key === 'mp4-folder') {
                onOpenMp4(record)
                return
              }
              if (key === 'mp4-remove') {
                onRemoveMp4(record)
                return
              }
              onRemove(record, key === 'delete')
            }
          }}
        >
          <Button
            size="small"
            type="text"
            icon={<MoreOutlined />}
            aria-label={`更多操作：${record.title}`}
          />
        </Dropdown>
      </div>
    </div>
  )
}

/* ── 页面 ── */

/**
 * 下载中心：列离线缓存 / 下载记录。
 * 同一部视频只有一集时直接平铺；多集时聚合成一张分组卡，点进去逐集管理。
 * 保存位置与并发数在「设置 › 下载」里配置。
 */
function Downloads({ onBack }: { onBack: () => void }): React.JSX.Element {
  const { message, modal } = App.useApp()
  const [records, setRecords] = useState<DownloadRecordView[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<DownloadFilter>('all')
  const [refreshing, setRefreshing] = useState(false)
  const [openGroupKey, setOpenGroupKey] = useState<string | null>(null)
  const [groupPage, setGroupPage] = useState(1)
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set())

  const loadRecords = useCallback(async (): Promise<void> => {
    try {
      setRecords(await window.api.downloads.list())
    } catch {
      message.error('读取下载记录失败')
    } finally {
      setLoading(false)
    }
  }, [message])

  useEffect(() => {
    let alive = true
    // loadRecords 是异步函数，setState 在 await 之后执行；规则按调用点误报，这里显式关闭
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadRecords()
    // 结构变化（增 / 删 / 清空）重拉列表；进度走 onProgress 就地打补丁
    const offChanged = window.api.downloads.onChange(() => {
      if (alive) void loadRecords()
    })
    const offProgress = window.api.downloads.onProgress((record) => {
      if (!alive) return
      setRecords((prev) => {
        const index = prev.findIndex((item) => item.id === record.id)
        if (index < 0) return prev
        const next = [...prev]
        next[index] = record
        return next
      })
    })
    return () => {
      alive = false
      offChanged()
      offProgress()
    }
  }, [loadRecords])

  const sorted = useMemo(
    () =>
      [...records].sort(
        (a, b) =>
          statusWeight(a.status) - statusWeight(b.status) ||
          (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0)
      ),
    [records]
  )

  const counts = useMemo(
    () => ({
      all: sorted.length,
      active: sorted.filter(isActive).length,
      done: sorted.filter((record) => record.status === 'done').length,
      failed: sorted.filter((record) => record.status === 'failed').length,
      finished: sorted.filter(isFinished).length
    }),
    [sorted]
  )

  const groups = useMemo(() => buildGroups(sorted), [sorted])

  const visibleGroups = useMemo(
    () => groups.filter((group) => group.records.some((record) => matchesFilter(record, filter))),
    [groups, filter]
  )

  const openGroup = useMemo(
    () => (openGroupKey ? (groups.find((group) => group.key === openGroupKey) ?? null) : null),
    [groups, openGroupKey]
  )

  const groupRecords = useMemo(
    () => (openGroup ? openGroup.records.filter((record) => matchesFilter(record, filter)) : []),
    [openGroup, filter]
  )

  // 页码越界（记录变少 / 切筛选）时按当前总页数收敛，不靠 effect 回写 state
  const groupPageCount = Math.max(1, Math.ceil(groupRecords.length / GROUP_PAGE_SIZE))
  const safeGroupPage = Math.min(groupPage, groupPageCount)
  const groupPageRecords = useMemo(
    () =>
      groupRecords.slice((safeGroupPage - 1) * GROUP_PAGE_SIZE, safeGroupPage * GROUP_PAGE_SIZE),
    [groupRecords, safeGroupPage]
  )

  const openGroupDetail = useCallback((key: string): void => {
    setOpenGroupKey(key)
    setGroupPage(1)
  }, [])

  const closeGroupDetail = useCallback((): void => {
    setOpenGroupKey(null)
    setGroupPage(1)
  }, [])

  const markPending = (id: string, value: boolean): void => {
    setPendingIds((prev) => {
      const next = new Set(prev)
      if (value) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const refresh = async (): Promise<void> => {
    setRefreshing(true)
    try {
      await loadRecords()
    } finally {
      setRefreshing(false)
    }
  }

  const openDirectory = async (id?: string): Promise<void> => {
    const result = await window.api.downloads.openFolder(id)
    if (!result.ok) message.error('打开下载目录失败')
  }

  const play = async (record: DownloadRecordView): Promise<void> => {
    try {
      const result = await window.api.downloads.play(record.id)
      if (result.ok) return
      if (result.error === 'FILE_MISSING') {
        message.warning('文件已被删除或移动，可以重新缓存')
        await loadRecords()
      } else if (result.error === 'SERVICE_FAILED') {
        message.error('启动本机播放服务失败，稍后再试')
      } else {
        message.error('打开播放器失败')
      }
    } catch {
      message.error('打开播放器失败')
    }
  }

  const cancelRecord = async (record: DownloadRecordView): Promise<void> => {
    markPending(record.id, true)
    try {
      await window.api.downloads.cancel(record.id)
      message.success('已取消缓存')
    } catch {
      message.error('取消失败')
    } finally {
      markPending(record.id, false)
    }
  }

  const pauseRecord = async (record: DownloadRecordView): Promise<void> => {
    markPending(record.id, true)
    try {
      const result = await window.api.downloads.pause(record.id)
      if (!result.ok) {
        message.error(result.error === 'NOT_PAUSABLE' ? '当前任务不能暂停' : '暂停失败')
      } else {
        message.success('已暂停缓存')
      }
    } catch {
      message.error('暂停失败')
    } finally {
      markPending(record.id, false)
    }
  }

  const resumeRecord = async (record: DownloadRecordView): Promise<void> => {
    markPending(record.id, true)
    try {
      const result = await window.api.downloads.resume(record.id)
      if (!result.ok) {
        message.error(result.error === 'NOT_PAUSED' ? '这个任务没有暂停' : '继续缓存失败')
      } else {
        message.success('已继续缓存')
      }
    } catch {
      message.error('继续缓存失败')
    } finally {
      markPending(record.id, false)
    }
  }

  const retryRecord = async (record: DownloadRecordView): Promise<void> => {
    markPending(record.id, true)
    try {
      const result = await window.api.downloads.retry(record.id)
      if (!result.ok) message.error(retryErrorText(result.error))
      else message.success('已重新加入缓存队列')
    } catch {
      message.error('重新加入缓存失败')
    } finally {
      markPending(record.id, false)
    }
  }

  const exportRecord = async (record: DownloadRecordView): Promise<void> => {
    markPending(record.id, true)
    try {
      const force = record.mp4Status === 'done' && record.mp4Exists
      const result = await window.api.downloads.exportMp4({ ids: [record.id], force })
      if (result.queued > 0) {
        message.success(force ? '已开始重新导出 MP4' : '已加入 MP4 导出队列')
      } else if (result.existing > 0) {
        message.info('这一集已经导出过 MP4')
      } else {
        message.warning('缓存还没完成，不能导出 MP4')
      }
    } catch {
      message.error('导出 MP4 失败')
    } finally {
      markPending(record.id, false)
    }
  }

  const cancelExportRecord = async (record: DownloadRecordView): Promise<void> => {
    markPending(record.id, true)
    try {
      await window.api.downloads.cancelExport([record.id])
      message.success('已取消 MP4 转换')
    } catch {
      message.error('取消 MP4 转换失败')
    } finally {
      markPending(record.id, false)
    }
  }

  const openMp4 = async (record: DownloadRecordView): Promise<void> => {
    try {
      const result = await window.api.downloads.openMp4Folder(record.id)
      if (!result.ok) {
        message.warning('MP4 已被删除或移动')
        await loadRecords()
      }
    } catch {
      message.error('打开 MP4 所在文件夹失败')
    }
  }

  const removeMp4 = (record: DownloadRecordView): void => {
    modal.confirm({
      title: '删除导出的 MP4',
      content: `将删除「${record.title} ${record.episodeName}」的 MP4 文件，缓存包会保留，需要时可以重新导出。`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          const result = await window.api.downloads.removeMp4(record.id)
          if (!result.ok) {
            message.error('删除 MP4 失败')
            return
          }
          await loadRecords()
          message.success('已删除 MP4')
        } catch {
          message.error('删除 MP4 失败')
        }
      }
    })
  }

  const exportGroup = async (group: DownloadGroup): Promise<void> => {
    const ids = group.records
      .filter((record) => record.kind === 'hls' && record.status === 'done' && record.exists)
      .map((record) => record.id)
    if (ids.length === 0) {
      message.info('这组还没有可导出的缓存')
      return
    }
    try {
      const result = await window.api.downloads.exportMp4({ ids })
      if (result.queued > 0) {
        message.success(`已加入 ${result.queued} 集 MP4 导出队列`)
      } else if (result.existing > 0) {
        message.info('这些集已经导出过 MP4')
      } else {
        message.warning('没有可导出的集')
      }
    } catch {
      message.error('导出 MP4 失败')
    }
  }

  const removeRecord = (record: DownloadRecordView, deleteFile: boolean): void => {
    const run = async (): Promise<void> => {
      try {
        const result = await window.api.downloads.remove({
          ids: [record.id],
          deleteFiles: deleteFile
        })
        setRecords(result.records)
        if (!deleteFile) {
          message.success(
            record.mp4Exists
              ? '已移除记录，缓存和 MP4 文件仍保留在下载目录'
              : '已移除记录，缓存文件仍保留在下载目录'
          )
        } else if (result.keptFiles > 0) {
          message.warning('记录已移除，文件没能删除（不在当前下载目录或正被占用）')
        } else {
          message.success(record.kind === 'hls' ? '已删除这一集缓存' : '已删除记录和文件')
        }
      } catch {
        message.error('删除失败')
      }
    }

    if (!deleteFile) {
      void run()
      return
    }
    modal.confirm({
      title: record.kind === 'hls' ? '删除这一集缓存' : '删除文件',
      content:
        record.kind === 'hls'
          ? `将同时删除「${record.title} ${record.episodeName}」的缓存和记录${
              record.mp4Exists ? '，已导出的 MP4 也会一起删除' : ''
            }，删除后不可恢复。`
          : `将同时删除「${record.fileName}」和它的下载记录，删除后不可恢复。`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: run
    })
  }

  const removeGroup = (group: DownloadGroup): void => {
    modal.confirm({
      title: '删除整组缓存',
      content: `将删除「${group.title}」的 ${group.records.length} 集缓存和对应文件${
        group.mp4Done > 0 ? '（含已导出的 MP4）' : ''
      }${group.active > 0 ? '，正在缓存的会先取消' : ''}。删除后不可恢复。`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          const result = await window.api.downloads.remove({
            ids: group.records.map((record) => record.id),
            deleteFiles: true
          })
          setRecords(result.records)
          if (openGroupKey === group.key) setOpenGroupKey(null)
          if (result.keptFiles > 0) {
            message.warning(
              `已删除 ${result.deletedFiles} 集缓存，${result.keptFiles} 集文件没能删除（不在当前下载目录或正被占用）`
            )
          } else {
            message.success(`已删除 ${result.deletedFiles} 集缓存`)
          }
        } catch {
          message.error('删除缓存失败')
        }
      }
    })
  }

  const clearFinished = (): void => {
    if (counts.finished === 0) return
    modal.confirm({
      title: '清空已结束的记录',
      content: '已完成 / 失败 / 已取消的记录会从列表里清掉，已缓存的文件保留在下载目录。',
      okText: '清空',
      cancelText: '取消',
      onOk: async () => {
        try {
          const result = await window.api.downloads.clearFinished()
          setRecords(result.records)
          message.success('已清空已结束的记录')
        } catch {
          message.error('清空记录失败')
        }
      }
    })
  }

  const emptyTitle = filter === 'all' ? '还没有缓存记录' : '这个分类下没有记录'
  const emptyDesc =
    filter === 'all'
      ? '在播放页点「缓存本集」或多选剧集后，缓存会出现在这里；也可以从「设置 › 下载」调整保存位置与并发数。'
      : '切换上方的筛选条件看看。'

  const renderRow = (record: DownloadRecordView): React.JSX.Element => (
    <RecordRow
      key={record.id}
      record={record}
      pending={pendingIds.has(record.id)}
      onPlay={(item) => void play(item)}
      onOpenFolder={(item) => void openDirectory(item.id)}
      onRemove={removeRecord}
      onPause={(item) => void pauseRecord(item)}
      onResume={(item) => void resumeRecord(item)}
      onCancel={(item) => void cancelRecord(item)}
      onRetry={(item) => void retryRecord(item)}
      onExport={(item) => void exportRecord(item)}
      onCancelExport={(item) => void cancelExportRecord(item)}
      onOpenMp4={(item) => void openMp4(item)}
      onRemoveMp4={removeMp4}
    />
  )

  return (
    <div className="page-inner downloads-page">
      <div className="downloads-topbar">
        <button type="button" className="page-back" onClick={onBack}>
          <ArrowLeftOutlined />
          <span>返回</span>
        </button>
      </div>
      <h1 className="page-title">下载中心</h1>
      {/* 刷新 / 清空是页面级动作，放在简介这一行的右端，卡片头只留筛选 */}
      <div className="downloads-headline">
        <p className="page-subtitle">管理已缓存的视频；保存位置与并发数在「设置 › 下载」里调整</p>
        <div className="downloads-head-actions">
          <Tooltip title="重新读取下载记录">
            <Button icon={<ReloadOutlined />} loading={refreshing} onClick={() => void refresh()}>
              刷新
            </Button>
          </Tooltip>
          <Tooltip title="清空已结束（已完成 / 失败 / 已取消）的记录，缓存文件保留">
            <Button
              danger
              icon={<DeleteOutlined />}
              disabled={counts.finished === 0}
              onClick={clearFinished}
            >
              清空
            </Button>
          </Tooltip>
        </div>
      </div>

      <div className="downloads-body">
        <section className="settings-card downloads-records">
          <div className="downloads-records-head">
            <div className="downloads-records-title">
              <span className="settings-row-title">{openGroup ? openGroup.title : '下载记录'}</span>
              <span className="downloads-count">
                {openGroup ? `共 ${openGroup.records.length} 集` : `共 ${counts.all} 条`}
              </span>
            </div>
            <div className="downloads-records-tools">
              <Segmented
                size="small"
                value={filter}
                onChange={(value) => {
                  setFilter(value as DownloadFilter)
                  setGroupPage(1)
                }}
                options={FILTERS.map((item) => ({
                  value: item.value,
                  label: `${item.label} ${counts[item.value]}`
                }))}
              />
            </div>
          </div>

          {openGroup ? (
            <div className="downloads-group-view">
              <button type="button" className="downloads-group-back" onClick={closeGroupDetail}>
                <ArrowLeftOutlined />
                <span>返回下载中心</span>
              </button>

              <div className="downloads-group-head">
                <div className="downloads-group-head-main">
                  <h2 className="downloads-group-title">{openGroup.title}</h2>
                  <p className="downloads-group-sub">
                    <span>{groupStatusText(openGroup)}</span>
                    {openGroup.mp4Done > 0 && <span>已导出 {openGroup.mp4Done} 集 MP4</span>}
                    <span>{formatBytes(openGroup.totalSize)}</span>
                    <span>最近更新 {formatDateTime(openGroup.latestAt)}</span>
                  </p>
                </div>
                <div className="downloads-group-head-actions">
                  <Button
                    size="small"
                    icon={<ExportOutlined />}
                    disabled={
                      !openGroup.records.some(
                        (record) =>
                          record.kind === 'hls' && record.status === 'done' && record.exists
                      )
                    }
                    onClick={() => void exportGroup(openGroup)}
                  >
                    整组转 MP4
                  </Button>
                  <Button
                    danger
                    size="small"
                    icon={<DeleteOutlined />}
                    onClick={() => removeGroup(openGroup)}
                  >
                    删除整组
                  </Button>
                </div>
              </div>

              {groupRecords.length === 0 ? (
                <div className="downloads-empty is-inner">
                  <CloudDownloadOutlined className="downloads-empty-icon" />
                  <p className="downloads-empty-title">这个筛选下没有记录</p>
                  <p className="downloads-empty-desc">切换上方的筛选条件看看。</p>
                </div>
              ) : (
                <>
                  <div className="downloads-list">
                    {groupPageRecords.map((record) => renderRow(record))}
                  </div>
                  {groupRecords.length > GROUP_PAGE_SIZE && (
                    <div className="downloads-group-pager">
                      <Pagination
                        size="small"
                        current={safeGroupPage}
                        pageSize={GROUP_PAGE_SIZE}
                        total={groupRecords.length}
                        showSizeChanger={false}
                        showTotal={(total) => `共 ${total} 集`}
                        onChange={(page) => setGroupPage(page)}
                      />
                    </div>
                  )}
                </>
              )}
            </div>
          ) : loading ? (
            <div className="downloads-loading">
              <Spin size="small" />
              <span className="settings-row-desc">正在读取下载记录…</span>
            </div>
          ) : visibleGroups.length === 0 ? (
            <div className="downloads-empty">
              <CloudDownloadOutlined className="downloads-empty-icon" />
              <p className="downloads-empty-title">{emptyTitle}</p>
              <p className="downloads-empty-desc">{emptyDesc}</p>
            </div>
          ) : (
            <div className="downloads-list">
              {visibleGroups.map((group) => {
                if (group.records.length === 1) {
                  return renderRow(group.records[0])
                }
                const activeText = groupActiveText(group)
                return (
                  <div
                    key={group.key}
                    className="download-group"
                    role="button"
                    tabIndex={0}
                    onClick={() => openGroupDetail(group.key)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        openGroupDetail(group.key)
                      }
                    }}
                  >
                    <span className="download-group-icon" aria-hidden="true">
                      <CloudDownloadOutlined />
                    </span>
                    <div className="download-group-main">
                      <div className="download-group-title">
                        <span className="download-group-name" title={group.title}>
                          {group.title}
                        </span>
                        <Tag>{group.records.length} 集</Tag>
                        {group.failed > 0 && <Tag color="error">失败 {group.failed}</Tag>}
                      </div>
                      <div className="download-group-meta">
                        <span>{groupStatusText(group)}</span>
                        {group.mp4Done > 0 && <span>已导出 {group.mp4Done} 集 MP4</span>}
                        {activeText && <span>{activeText}</span>}
                        <span>{formatBytes(group.totalSize)}</span>
                        <span>{formatDateTime(group.latestAt)}</span>
                      </div>
                      {(group.active > 0 || group.paused > 0) && (
                        <Progress
                          className="download-group-progress"
                          percent={group.percent}
                          size="small"
                          status={group.active > 0 ? 'active' : 'normal'}
                          showInfo={false}
                        />
                      )}
                    </div>
                    <div className="download-group-actions">
                      <Tooltip title="删除整组缓存">
                        <Button
                          size="small"
                          type="text"
                          danger
                          icon={<DeleteOutlined />}
                          aria-label="删除整组缓存"
                          onClick={(event) => {
                            event.stopPropagation()
                            removeGroup(group)
                          }}
                        />
                      </Tooltip>
                      <RightOutlined className="download-group-arrow" />
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

export default Downloads
