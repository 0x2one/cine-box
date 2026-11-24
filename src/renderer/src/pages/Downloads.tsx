import { useCallback, useEffect, useMemo, useState } from 'react'
import { App, Button, Dropdown, Progress, Segmented, Spin, Tag, Tooltip, Typography } from 'antd'
import {
  ArrowLeftOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  CloudDownloadOutlined,
  DeleteOutlined,
  FolderOpenOutlined,
  MinusCircleOutlined,
  MoreOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
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
  downloading: { text: '下载中', color: 'processing', icon: <CloudDownloadOutlined /> },
  paused: { text: '已暂停', color: 'warning', icon: <PauseCircleOutlined /> },
  done: { text: '已完成', color: 'success', icon: <CheckCircleOutlined /> },
  failed: { text: '失败', color: 'error', icon: <CloseCircleOutlined /> },
  canceled: { text: '已取消', color: 'default', icon: <StopOutlined /> }
}

function isActive(record: DownloadRecordView): boolean {
  return (
    record.status === 'waiting' || record.status === 'downloading' || record.status === 'paused'
  )
}

function isFinished(record: DownloadRecordView): boolean {
  return record.status === 'done' || record.status === 'failed' || record.status === 'canceled'
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

/** 下载中心：只列下载记录（播放本机文件、定位文件、删除）；保存位置与并发数在 设置 › 下载 */
function Downloads({ onBack }: { onBack: () => void }): React.JSX.Element {
  const { message, modal } = App.useApp()
  const [records, setRecords] = useState<DownloadRecordView[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<DownloadFilter>('all')
  const [refreshing, setRefreshing] = useState(false)

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
    // 记录有增删改时主进程会推一次，刷新列表（进度不推，避免高频重排）
    const off = window.api.downloads.onChange(() => {
      if (alive) void loadRecords()
    })
    return () => {
      alive = false
      off()
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

  const visible = useMemo(() => {
    if (filter === 'active') return sorted.filter(isActive)
    if (filter === 'done') return sorted.filter((record) => record.status === 'done')
    if (filter === 'failed') return sorted.filter((record) => record.status === 'failed')
    return sorted
  }, [sorted, filter])

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
        message.warning('文件已被删除或移动，可以重新下载')
        await loadRecords()
      } else {
        message.error('打开播放器失败')
      }
    } catch {
      message.error('打开播放器失败')
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
          message.success('已移除记录，文件仍保留在下载目录')
        } else if (result.keptFiles > 0) {
          message.warning('记录已移除，文件没能删除（不在当前下载目录或正被占用）')
        } else {
          message.success('已删除记录和文件')
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
      title: '删除文件',
      content: `将同时删除「${record.fileName}」和它的下载记录，删除后不可恢复。`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: run
    })
  }

  const clearFinished = (): void => {
    if (counts.finished === 0) return
    modal.confirm({
      title: '清空已结束的记录',
      content: '已完成 / 失败 / 已取消的记录会从列表里清掉，已下载的文件保留在下载目录。',
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

  const emptyTitle = filter === 'all' ? '还没有下载记录' : '这个分类下没有记录'
  const emptyDesc =
    filter === 'all'
      ? '下载的视频会保存到设置里指定的目录，完成后可以在这里直接播放或打开所在文件夹。'
      : '切换上方的筛选条件看看。'

  return (
    <div className="page-inner downloads-page">
      <div className="downloads-topbar">
        <button type="button" className="page-back" onClick={onBack}>
          <ArrowLeftOutlined />
          <span>返回</span>
        </button>
      </div>
      <h1 className="page-title">下载中心</h1>
      <p className="page-subtitle">管理已下载的视频；保存位置与并发数在「设置 › 下载」里调整</p>

      <div className="downloads-body">
        <section className="settings-card downloads-records">
          <div className="downloads-records-head">
            <div className="downloads-records-title">
              <span className="settings-row-title">下载记录</span>
              <span className="downloads-count">共 {counts.all} 条</span>
            </div>
            <div className="downloads-records-tools">
              <Segmented
                size="small"
                value={filter}
                onChange={(value) => setFilter(value as DownloadFilter)}
                options={FILTERS.map((item) => ({
                  value: item.value,
                  label: `${item.label} ${counts[item.value]}`
                }))}
              />
              <Tooltip title="刷新记录">
                <Button
                  size="small"
                  type="text"
                  icon={<ReloadOutlined />}
                  aria-label="刷新记录"
                  loading={refreshing}
                  onClick={() => void refresh()}
                />
              </Tooltip>
              <Tooltip title="清空已结束的记录">
                <Button
                  size="small"
                  type="text"
                  icon={<DeleteOutlined />}
                  aria-label="清空已结束的记录"
                  onClick={clearFinished}
                  disabled={counts.finished === 0}
                />
              </Tooltip>
            </div>
          </div>

          {loading ? (
            <div className="downloads-loading">
              <Spin size="small" />
              <span className="settings-row-desc">正在读取下载记录…</span>
            </div>
          ) : visible.length === 0 ? (
            <div className="downloads-empty">
              <CloudDownloadOutlined className="downloads-empty-icon" />
              <p className="downloads-empty-title">{emptyTitle}</p>
              <p className="downloads-empty-desc">{emptyDesc}</p>
            </div>
          ) : (
            <div className="downloads-list">
              {visible.map((record) => {
                const meta = STATUS_META[record.status]
                const sizeText = record.exists ? formatBytes(record.size) : ''
                const active = isActive(record)
                return (
                  <div className="download-record" key={record.id}>
                    <span className={`download-record-icon is-${record.status}`} aria-hidden="true">
                      {meta.icon}
                    </span>

                    <div className="download-record-main">
                      <div className="download-record-title">
                        <span className="download-record-name" title={record.title}>
                          {record.title}
                        </span>
                        {record.episodeName && (
                          <span className="download-record-ep">{record.episodeName}</span>
                        )}
                      </div>

                      <div className="download-record-meta">
                        <Tag color={meta.color}>{meta.text}</Tag>
                        {record.exists ? (
                          <span>{sizeText}</span>
                        ) : (
                          <Text type="warning">文件已丢失</Text>
                        )}
                        {active && record.totalBytes > 0 && (
                          <span>
                            {progressText(record)} · {Math.round(record.progress)}%
                          </span>
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
                    </div>

                    <div className="download-record-actions">
                      {record.status === 'done' && record.exists && (
                        <Button
                          size="small"
                          icon={<PlayCircleOutlined />}
                          onClick={() => void play(record)}
                        >
                          播放
                        </Button>
                      )}
                      <Tooltip title="打开所在文件夹">
                        <Button
                          size="small"
                          type="text"
                          icon={<FolderOpenOutlined />}
                          aria-label="打开所在文件夹"
                          onClick={() => void openDirectory(record.id)}
                        />
                      </Tooltip>
                      <Dropdown
                        trigger={['click']}
                        placement="bottomRight"
                        menu={{
                          items: [
                            {
                              key: 'remove',
                              icon: <MinusCircleOutlined />,
                              label: '移除记录'
                            },
                            {
                              key: 'delete',
                              icon: <DeleteOutlined />,
                              label: '删除文件',
                              danger: true,
                              disabled: !record.exists
                            }
                          ],
                          onClick: ({ key }) => removeRecord(record, key === 'delete')
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
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

export default Downloads
