import { useCallback, useEffect, useState } from 'react'
import { App, Button, Modal, Popconfirm, Space, Spin, Tooltip } from 'antd'
import {
  DeleteOutlined,
  FolderOpenOutlined,
  HistoryOutlined,
  ImportOutlined,
  SaveOutlined,
  ShareAltOutlined
} from '@ant-design/icons'
import { formatBytes, formatDateTime } from '../utils/format'

/** 等待确认的恢复来源：库内备份记录，或用户自定义的文件路径 */
interface PendingRestore {
  id?: string
  path?: string
  record: BackupRecord
}

const COUNT_ITEMS: { key: keyof BackupCounts; label: string }[] = [
  { key: 'sites', label: '站点' },
  { key: 'siteCategories', label: '在线分类' },
  { key: 'categories', label: '本地分类' },
  { key: 'bindings', label: '绑定关系' }
]

const BACKUP_ERRORS: Record<string, string> = {
  EMPTY: '当前没有可备份的数据',
  WRITE_FAILED: '写入备份失败，请检查磁盘空间或权限',
  NOT_FOUND: '备份记录不存在，可能已被删除',
  INVALID: '该文件不是有效的映盒剧场备份',
  UNSUPPORTED: '备份文件来自更高版本，请先更新映盒剧场',
  READ_FAILED: '读取备份失败，请确认文件没有损坏'
}

function describeCounts(counts: BackupCounts): string {
  return `${counts.sites} 个站点 · ${counts.siteCategories} 个在线分类 · ${counts.categories} 个本地分类 · ${counts.bindings} 条绑定`
}

/**
 * 控制台「备份」分区：把站点、在线分类、本地分类与绑定关系存成一份 JSON 备份，
 * 恢复时可以选库内记录，也可以选任意备份文件。
 */
function BackupPanel({ title, desc }: { title: string; desc: string }): React.JSX.Element {
  const { message } = App.useApp()
  const [directory, setDirectory] = useState('')
  const [records, setRecords] = useState<BackupRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [picking, setPicking] = useState(false)
  /** 正在另存（分享）的记录 */
  const [exportingId, setExportingId] = useState<string | null>(null)
  const [pendingRestore, setPendingRestore] = useState<PendingRestore | null>(null)
  const [restoring, setRestoring] = useState(false)

  useEffect(() => {
    let alive = true
    void window.api.backup
      .list()
      .then((result) => {
        if (!alive) return
        setDirectory(result.directory)
        setRecords(result.records)
      })
      .catch(() => {
        if (alive) message.error('读取备份记录失败')
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [message])

  /** 操作成功后静默刷新列表：刷新失败不影响已经完成的备份 / 恢复结果 */
  const refresh = useCallback(async (): Promise<void> => {
    try {
      const result = await window.api.backup.list()
      setDirectory(result.directory)
      setRecords(result.records)
    } catch {
      // 列表读取失败时保留旧数据，下次进入分区会重新加载
    }
  }, [])

  const createBackup = (): void => {
    setCreating(true)
    void window.api.backup
      .create()
      .then(async (result) => {
        if (!result.ok) {
          message.warning(BACKUP_ERRORS[result.error ?? ''] ?? '备份失败，请重试')
          return
        }
        await refresh()
        message.success('备份完成')
      })
      .catch(() => message.error('备份失败，请重试'))
      .finally(() => setCreating(false))
  }

  /** 另存到用户选的位置：通过系统文件对话框导出，得到的文件可以直接分享 */
  const shareBackup = (record: BackupRecord): void => {
    setExportingId(record.id)
    void window.api.backup
      .export(record.id)
      .then((result) => {
        if (result.canceled) return
        if (!result.ok || !result.path) {
          message.error(BACKUP_ERRORS[result.error ?? ''] ?? '保存备份失败，请重试')
          return
        }
        message.success(`已保存到 ${result.path}`)
      })
      .catch(() => message.error('保存备份失败，请重试'))
      .finally(() => setExportingId(null))
  }

  const removeBackup = (record: BackupRecord): void => {
    void window.api.backup
      .remove(record.id)
      .then(async (result) => {
        if (!result.ok) {
          message.error('删除备份失败，请重试')
          return
        }
        await refresh()
        message.success('备份已删除')
      })
      .catch(() => message.error('删除备份失败，请重试'))
  }

  /** 选择自定义文件：先解析出数据量，确认弹窗里再决定是否覆盖 */
  const pickFile = (): void => {
    setPicking(true)
    void window.api.backup
      .pick()
      .then((result) => {
        if (result.canceled) return
        if (!result.ok || !result.record || !result.path) {
          message.error(BACKUP_ERRORS[result.error ?? ''] ?? '无法读取该备份文件')
          return
        }
        setPendingRestore({ path: result.path, record: result.record })
      })
      .catch(() => message.error('无法读取该备份文件'))
      .finally(() => setPicking(false))
  }

  const confirmRestore = (): void => {
    if (!pendingRestore) return
    const source: RestoreSource = pendingRestore.path
      ? { path: pendingRestore.path }
      : { id: pendingRestore.record.id }
    setRestoring(true)
    void window.api.backup
      .restore(source)
      .then(async (result) => {
        if (!result.ok) {
          message.error(BACKUP_ERRORS[result.error ?? ''] ?? '恢复失败，请重试')
          return
        }
        await refresh()
        setPendingRestore(null)
        const counts = result.counts
        message.success(
          counts
            ? `已恢复 ${counts.sites} 个站点、${counts.categories} 个本地分类、${counts.bindings} 条绑定${
                result.safety ? '，恢复前的数据已自动备份' : ''
              }`
            : '恢复完成'
        )
      })
      .catch(() => message.error('恢复失败，请重试'))
      .finally(() => setRestoring(false))
  }

  const openFolder = (): void => {
    void window.api.backup
      .openFolder()
      .then((ok) => {
        if (!ok) message.error('无法打开备份目录')
      })
      .catch(() => message.error('无法打开备份目录'))
  }

  return (
    <>
      <div className="settings-panel-head has-actions">
        <h2 className="settings-panel-title">{title}</h2>
        <span className="settings-panel-sep">·</span>
        <p className="settings-panel-desc">
          {desc}
          <span className="sites-count">共 {records.length} 份备份</span>
        </p>
        <div className="settings-panel-actions">
          <Tooltip title="从文件恢复">
            <Button
              icon={<ImportOutlined />}
              loading={picking}
              onClick={pickFile}
              aria-label="从文件恢复"
            />
          </Tooltip>
          <Button type="primary" icon={<SaveOutlined />} loading={creating} onClick={createBackup}>
            立即备份
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="sites-placeholder">
          <Spin size="small" />
          <span className="sites-empty-hint">正在读取备份记录…</span>
        </div>
      ) : records.length === 0 ? (
        <div className="sites-placeholder">
          <span className="sites-empty-title">还没有备份</span>
          <span className="sites-empty-hint">
            点击右上角「立即备份」保存当前的站点、分类与绑定关系
          </span>
        </div>
      ) : (
        <ul className="backup-list">
          {records.map((record) => (
            <li className="backup-row" key={record.id}>
              <div className="backup-main">
                <span className="backup-time">{formatDateTime(record.createdAt, true)}</span>
                <span className="backup-meta" title={record.id}>
                  {describeCounts(record.counts)} · {formatBytes(record.size)}
                  {record.auto ? ' · 恢复前自动备份' : ''}
                </span>
              </div>
              <div className="backup-actions">
                <Tooltip title="恢复这份备份">
                  <Button
                    type="text"
                    size="small"
                    icon={<HistoryOutlined />}
                    onClick={() => setPendingRestore({ id: record.id, record })}
                    aria-label={`从 ${formatDateTime(record.createdAt, true)} 的备份恢复`}
                  />
                </Tooltip>
                <Tooltip title="保存到…（用于分享）">
                  <Button
                    type="text"
                    size="small"
                    icon={<ShareAltOutlined />}
                    loading={exportingId === record.id}
                    onClick={() => shareBackup(record)}
                    aria-label={`分享 ${record.id}`}
                  />
                </Tooltip>
                <Popconfirm
                  title="删除备份"
                  description="只删除这份备份文件，不影响当前数据。"
                  okText="删除"
                  cancelText="取消"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => removeBackup(record)}
                >
                  <Button
                    type="text"
                    danger
                    size="small"
                    icon={<DeleteOutlined />}
                    aria-label={`删除 ${record.id}`}
                  />
                </Popconfirm>
              </div>
            </li>
          ))}
        </ul>
      )}

      {!loading && (
        <div className="backup-foot">
          <span>
            备份是明文 JSON 文件，包含站点、在线分类、本地分类与绑定关系，可以直接分享给别人导入。
          </span>
          <div className="backup-path">
            <span className="backup-path-label">备份目录</span>
            <code title={directory}>{directory || '—'}</code>
            <Tooltip title="打开备份目录">
              <Button
                type="text"
                size="small"
                icon={<FolderOpenOutlined />}
                onClick={openFolder}
                aria-label="打开备份目录"
              />
            </Tooltip>
          </div>
        </div>
      )}

      <Modal
        title="恢复备份"
        open={Boolean(pendingRestore)}
        width={520}
        onCancel={() => setPendingRestore(null)}
        footer={
          <Space>
            <Button onClick={() => setPendingRestore(null)} disabled={restoring}>
              取消
            </Button>
            <Button type="primary" danger loading={restoring} onClick={confirmRestore}>
              恢复并覆盖
            </Button>
          </Space>
        }
      >
        {pendingRestore && (
          <div className="backup-confirm">
            <div className="backup-source">
              <span className="backup-source-name" title={pendingRestore.record.id}>
                {pendingRestore.record.id}
              </span>
              <span className="backup-source-meta">
                备份于 {formatDateTime(pendingRestore.record.createdAt, true)} ·{' '}
                {formatBytes(pendingRestore.record.size)}
              </span>
            </div>
            <div className="backup-counts">
              {COUNT_ITEMS.map((item) => (
                <div className="backup-count" key={item.key}>
                  <span className="backup-count-value">
                    {pendingRestore.record.counts[item.key]}
                  </span>
                  <span className="backup-count-label">{item.label}</span>
                </div>
              ))}
            </div>
            <p className="backup-warning">
              恢复会用这份备份覆盖当前所有站点、在线分类、本地分类与绑定关系。恢复前会自动把当前数据备份一份，可在列表中找回。
            </p>
          </div>
        )}
      </Modal>
    </>
  )
}

export default BackupPanel
