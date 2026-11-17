import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { App, Button, Popconfirm, Progress, Segmented, Spin, Switch, Tooltip } from 'antd'
import {
  ArrowLeftOutlined,
  CheckOutlined,
  DeleteOutlined,
  HddOutlined,
  InfoCircleOutlined,
  LaptopOutlined,
  MoonOutlined,
  ReloadOutlined,
  SettingOutlined,
  SunOutlined,
  ThunderboltOutlined,
  UndoOutlined
} from '@ant-design/icons'
import { ACCENTS } from '../theme/appearance'
import { useTheme } from '../theme/theme-context'
import type { ThemeMode } from '../theme/appearance'
import { formatBytes } from '../utils/format'
import { AboutPanel } from './About'

type SettingsSection = 'preferences' | 'shortcut' | 'storage' | 'about'

const NAV_ITEMS: {
  key: SettingsSection
  label: string
  icon: typeof SettingOutlined
}[] = [
  { key: 'preferences', label: '偏好设置', icon: SettingOutlined },
  { key: 'shortcut', label: '快捷键', icon: ThunderboltOutlined },
  { key: 'storage', label: '存储', icon: HddOutlined },
  { key: 'about', label: '关于', icon: InfoCircleOutlined }
]

const SECTION_META: Record<SettingsSection, { title: string; desc: string }> = {
  preferences: { title: '偏好设置', desc: '启动、关闭、更新与外观' },
  shortcut: { title: '快捷键', desc: '在任何应用中唤起映盒剧场' },
  storage: { title: '存储', desc: '本地缓存占用与清理' },
  about: { title: '关于', desc: '应用介绍与软件更新' }
}

const IS_MAC = window.electron?.process?.platform === 'darwin'
const DEFAULT_SHORTCUT = 'Ctrl+Shift+Space'

function SettingRow({
  title,
  description,
  children,
  stacked = false
}: {
  title: string
  description?: string
  children: ReactNode
  stacked?: boolean
}): React.JSX.Element {
  return (
    <div className={`settings-row${stacked ? ' settings-row--stack' : ''}`}>
      <div className="settings-row-text">
        <span className="settings-row-title">{title}</span>
        {description && <span className="settings-row-desc">{description}</span>}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  )
}

function SettingsCard({ children }: { children: ReactNode }): React.JSX.Element {
  return <section className="settings-card">{children}</section>
}

/* ── 偏好设置 ── */

function ToggleRow({
  field,
  title,
  description
}: {
  field: 'openAtLogin' | 'closeToTray' | 'autoDownload'
  title: string
  description: string
}): React.JSX.Element {
  const [checked, setChecked] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    void window.api.settings.get().then((settings) => {
      if (!alive) return
      setChecked(settings[field])
      setLoading(false)
    })
    return () => {
      alive = false
    }
  }, [field])

  const onChange = (value: boolean): void => {
    setChecked(value)
    const request =
      field === 'openAtLogin'
        ? window.api.settings.setOpenAtLogin(value)
        : field === 'closeToTray'
          ? window.api.settings.setCloseToTray(value)
          : window.api.settings.setAutoDownload(value)
    void request.then((settings) => setChecked(settings[field]))
  }

  return (
    <SettingRow title={title} description={description}>
      <Switch checked={checked} loading={loading} onChange={onChange} />
    </SettingRow>
  )
}

function PreferencesPanel(): React.JSX.Element {
  const { mode, setMode, accent, setAccent } = useTheme()

  return (
    <>
      {/* 外观合并进偏好设置：主题、主题色、界面语言排在启动 / 关闭等开关之前 */}
      <SettingsCard>
        <SettingRow title="主题" description="跟随系统时，明暗会随操作系统自动切换">
          <Segmented
            value={mode}
            onChange={(value) => setMode(value as ThemeMode)}
            options={[
              { value: 'system', label: '跟随系统', icon: <LaptopOutlined /> },
              { value: 'light', label: '浅色', icon: <SunOutlined /> },
              { value: 'dark', label: '深色', icon: <MoonOutlined /> }
            ]}
          />
        </SettingRow>
        <SettingRow stacked title="强调色" description="按钮、选中态与链接使用的主色">
          <div className="accent-swatches">
            {ACCENTS.map((item) => {
              const selected = item.key === accent.key
              return (
                <button
                  key={item.key}
                  type="button"
                  className={`accent-swatch${selected ? ' is-active' : ''}`}
                  style={{ background: item.light }}
                  title={item.name}
                  aria-label={item.name}
                  aria-pressed={selected}
                  onClick={() => setAccent(item.key)}
                >
                  {selected && <CheckOutlined />}
                </button>
              )
            })}
          </div>
        </SettingRow>
        <SettingRow title="界面语言" description="映盒剧场仅提供简体中文界面">
          <span className="settings-static">简体中文</span>
        </SettingRow>
      </SettingsCard>

      <SettingsCard>
        <ToggleRow field="openAtLogin" title="开机自启" description="登录系统后自动启动映盒剧场" />
        <ToggleRow
          field="closeToTray"
          title="关闭时最小化到托盘"
          description="点击关闭按钮时隐藏到托盘，可从托盘图标重新打开"
        />
        <ToggleRow
          field="autoDownload"
          title="自动下载更新"
          description="检测到新版本后自动下载，安装前仍会征求你的确认"
        />
      </SettingsCard>
    </>
  )
}

/* ── 快捷键 ── */

const KEY_ALIASES: Record<string, string> = {
  ' ': 'Space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Escape: 'Esc',
  Enter: 'Return',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  CapsLock: 'Capslock',
  ',': ',',
  '.': '.',
  '/': '/',
  '\\': '\\',
  ';': ';',
  "'": "'",
  '[': '[',
  ']': ']',
  '-': '-',
  '=': '=',
  '`': '`',
  '+': 'Plus'
}

function buildAccelerator(event: React.KeyboardEvent): string | null {
  const { key, ctrlKey, altKey, shiftKey, metaKey } = event
  const mods: string[] = []
  if (ctrlKey) mods.push('Ctrl')
  if (altKey) mods.push('Alt')
  if (shiftKey) mods.push('Shift')
  if (metaKey) mods.push(IS_MAC ? 'Command' : 'Super')

  let main = KEY_ALIASES[key]
  if (!main) {
    if (/^F\d{1,2}$/.test(key)) main = key
    else if (/^[a-zA-Z0-9]$/.test(key)) main = key.toUpperCase()
  }
  if (!main) return null

  const isFunctionKey = /^F\d{1,2}$/.test(main)
  // 单字母 / 数字必须带修饰键，避免抢走正常输入
  if (mods.length === 0 && !isFunctionKey) return null
  return isFunctionKey && mods.length === 0 ? main : [...mods, main].join('+')
}

function ShortcutPanel(): React.JSX.Element {
  const { message } = App.useApp()
  const [loading, setLoading] = useState(true)
  const [enabled, setEnabled] = useState(false)
  const [value, setValue] = useState(DEFAULT_SHORTCUT)
  const [recording, setRecording] = useState(false)
  const captureRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    void window.api.settings.get().then((settings) => {
      if (!alive) return
      setEnabled(Boolean(settings.showShortcut))
      if (settings.showShortcut) setValue(settings.showShortcut)
      setLoading(false)
    })
    return () => {
      alive = false
    }
  }, [])

  const apply = (accelerator: string): void => {
    void window.api.settings.setShowShortcut(accelerator).then((result) => {
      if (!result.ok) {
        message.error(
          result.error === 'CONFLICT'
            ? '该组合键已被其它程序占用，请换一个'
            : '无法识别的组合键，请重新录制'
        )
        return
      }
      if (result.shortcut) {
        setValue(result.shortcut)
        setEnabled(true)
      } else {
        setEnabled(false)
      }
      message.success('快捷键已保存')
    })
  }

  const toggle = (checked: boolean): void => {
    apply(checked ? value || DEFAULT_SHORTCUT : '')
  }

  const reset = (): void => {
    void window.api.settings.resetShowShortcut().then((result) => {
      if (!result.ok) {
        message.error(result.error === 'CONFLICT' ? '该组合键已被其它程序占用' : '无法识别的组合键')
        return
      }
      setValue(result.shortcut || DEFAULT_SHORTCUT)
      setEnabled(Boolean(result.shortcut))
      message.success('已恢复默认快捷键')
    })
  }

  const startRecording = (): void => {
    if (!enabled) return
    setRecording(true)
    requestAnimationFrame(() => captureRef.current?.focus())
  }

  const handleKeyDown = (event: React.KeyboardEvent): void => {
    if (!recording) return
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Escape') {
      setRecording(false)
      return
    }
    const accelerator = buildAccelerator(event)
    if (accelerator) {
      setRecording(false)
      apply(accelerator)
    }
  }

  return (
    <SettingsCard>
      <SettingRow title="全局快捷键" description="在任何应用中唤起或收起主窗口">
        <Switch checked={enabled} loading={loading} onChange={toggle} />
      </SettingRow>
      {enabled && (
        <>
          <SettingRow
            stacked
            title="当前组合键"
            description="点击下方组合键后直接按下新的按键，Esc 取消录制"
          >
            <div className="shortcut-line">
              <div
                ref={captureRef}
                role="button"
                tabIndex={0}
                className={`shortcut-chip${recording ? ' is-recording' : ''}`}
                onClick={startRecording}
                onKeyDown={handleKeyDown}
                onBlur={() => setRecording(false)}
              >
                <ThunderboltOutlined />
                <kbd>{recording ? '请按下组合键…' : value || '未设置'}</kbd>
              </div>
              <Tooltip title="恢复默认快捷键">
                <button
                  type="button"
                  className="shortcut-reset"
                  onClick={reset}
                  aria-label="恢复默认快捷键"
                >
                  <UndoOutlined />
                </button>
              </Tooltip>
            </div>
          </SettingRow>
          <div className="settings-note">
            快捷键需要在系统中独占注册，若被其它程序占用会提示保存失败。
          </div>
        </>
      )}
    </SettingsCard>
  )
}

/* ── 存储 / 清理缓存 ── */

/** 自动扫描（进入面板时）：超过这个时长才显示进度，很快出结果就不露状态 */
const AUTO_SCAN_BUSY_DELAY = 220
/** 自动扫描露出状态后的最短展示时长（从开始扫描算起），避免刚出现就消失 */
const AUTO_SCAN_BUSY_MIN_TIME = 500
/** 手动重新扫描的最短状态展示时长，让反馈稳定可见 */
const MANUAL_SCAN_BUSY_MIN_TIME = 1000

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function formatClock(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '刚刚'
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

/** 跨面板挂载保留上次结果：再次打开时先显示旧值，扫描完成再静默刷新，不闪占位符 */
let lastCacheSummary: CacheSummary | null = null

function StoragePanel(): React.JSX.Element {
  const { message } = App.useApp()
  const [summary, setSummary] = useState<CacheSummary | null>(lastCacheSummary)
  const [progress, setProgress] = useState<CacheProgress | null>(null)
  const [scanning, setScanning] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [showBusy, setShowBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [lockedDirs, setLockedDirs] = useState(0)
  const aliveRef = useRef(true)
  const scanStartedRef = useRef(false)
  const busyTimerRef = useRef<number | null>(null)
  const busyShownRef = useRef(false)
  const busy = scanning || clearing
  /** 界面上是否展示扫描 / 清理状态：自动扫描很快时保持原样，手动扫描与清理始终展示 */
  const busyUI = clearing || showBusy

  const runScan = useCallback(async (manual: boolean): Promise<void> => {
    const startedAt = Date.now()
    setScanning(true)
    setFailed(false)
    setProgress(null)
    if (manual) {
      // 手动点「重新扫描」：立即给反馈
      busyShownRef.current = true
      setShowBusy(true)
    } else {
      // 进入面板自动扫描：先等一小会儿，真的很快就不显示状态
      busyTimerRef.current = window.setTimeout(() => {
        busyTimerRef.current = null
        busyShownRef.current = true
        if (aliveRef.current) setShowBusy(true)
      }, AUTO_SCAN_BUSY_DELAY)
    }
    try {
      const result = await window.api.cache.scan()
      if (!aliveRef.current) return
      lastCacheSummary = result
      setSummary(result)
      setLockedDirs(0)
    } catch {
      if (aliveRef.current) setFailed(true)
    } finally {
      if (busyTimerRef.current !== null) {
        window.clearTimeout(busyTimerRef.current)
        busyTimerRef.current = null
      }
      // 已经露出状态时保证最短展示时长，避免进度条闪一下；手动扫描停留更久
      if (busyShownRef.current) {
        const minTime = manual ? MANUAL_SCAN_BUSY_MIN_TIME : AUTO_SCAN_BUSY_MIN_TIME
        const remain = minTime - (Date.now() - startedAt)
        if (remain > 0) await delay(remain)
      }
      busyShownRef.current = false
      if (aliveRef.current) {
        setShowBusy(false)
        setScanning(false)
        setProgress(null)
      }
    }
  }, [])

  useEffect(() => {
    aliveRef.current = true
    const off = window.api.cache.onProgress((value) => {
      if (aliveRef.current) setProgress(value)
    })
    // StrictMode 下 effect 会执行两次，这里只让首次挂载真正发起扫描
    if (!scanStartedRef.current) {
      scanStartedRef.current = true
      void runScan(false)
    }
    return () => {
      aliveRef.current = false
      off()
    }
  }, [runScan])

  const runClear = async (): Promise<void> => {
    setClearing(true)
    setProgress(null)
    try {
      const result = await window.api.cache.clear()
      if (!aliveRef.current) return
      lastCacheSummary = result
      setSummary(result)
      setLockedDirs(result.locked)
      setFailed(false)
      if (result.freed > 0) message.success(`已清理 ${formatBytes(result.freed)} 缓存`)
      else if (result.size > 0) message.warning('部分缓存正被占用，重启应用后再清理')
      else message.info('没有可清理的缓存')
    } catch {
      if (aliveRef.current) message.error('清理缓存失败，请稍后重试')
    } finally {
      if (aliveRef.current) {
        setClearing(false)
        setProgress(null)
      }
    }
  }

  // 扫描进度：先统计文件数量（此时没有总量，显示状态文案），再按文件比例显示进度条
  let statusText = ''
  let statusPercent: number | null = null
  if (busyUI && progress) {
    if (progress.phase === 'enumerate') {
      statusText = `正在统计缓存文件…已发现 ${progress.files.toLocaleString('zh-CN')} 个`
    } else if (progress.phase === 'measure') {
      statusPercent = progress.percent
      statusText = `正在计算缓存大小…${formatBytes(progress.bytes)}${
        progress.current ? ` · ${progress.current}` : ''
      }`
    } else {
      statusPercent = progress.percent
      statusText = `${progress.current || '正在清理缓存'}…`
    }
  } else if (busyUI) {
    statusText = clearing ? '正在清理缓存…' : '正在扫描缓存…'
  }

  const sizeText = busyUI
    ? clearing
      ? '清理中…'
      : '扫描中…'
    : summary
      ? formatBytes(summary.size)
      : '—'
  const metaText = busyUI
    ? clearing
      ? '正在删除缓存文件…'
      : '正在统计缓存占用…'
    : failed
      ? '读取缓存大小失败，点击「重新扫描」重试'
      : summary
        ? summary.files > 0
          ? `共 ${summary.files.toLocaleString('zh-CN')} 个文件 · 更新于 ${formatClock(summary.scannedAt)}`
          : '当前没有缓存文件'
        : '正在读取缓存占用…'
  const canClear = Boolean(summary && summary.size > 0) && !busy

  return (
    <SettingsCard>
      <div className="cache-overview">
        <div className="cache-overview-text">
          <span className="settings-row-title">缓存大小</span>
          <span className="cache-size">{sizeText}</span>
          <span className="settings-row-desc">{metaText}</span>
        </div>
        <Tooltip title="重新扫描">
          <Button
            icon={<ReloadOutlined />}
            aria-label="重新扫描"
            onClick={() => void runScan(true)}
            loading={scanning && showBusy}
            disabled={busy}
          />
        </Tooltip>
      </div>

      {busyUI && (
        <div className="cache-progress">
          <div className="cache-progress-head">
            <Spin size="small" />
            <span className="settings-row-desc">{statusText}</span>
          </div>
          {statusPercent !== null && (
            <Progress percent={statusPercent} size="small" status="active" showInfo={false} />
          )}
        </div>
      )}

      <SettingRow
        stacked
        title="清理缓存"
        description="删除网页请求、脚本与图形运行时产生的临时文件；不会影响采集站点、设置和数据。"
      >
        <div className="cache-actions">
          <Popconfirm
            title="清理缓存"
            description={
              summary && summary.size > 0
                ? `将删除约 ${formatBytes(summary.size)} 的缓存文件，采集站点与设置不受影响。`
                : '确定清理缓存？'
            }
            okText="清理"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            disabled={!canClear}
            onConfirm={() => void runClear()}
          >
            <Button danger icon={<DeleteOutlined />} loading={clearing} disabled={!canClear}>
              清理缓存
            </Button>
          </Popconfirm>
          <span className="settings-row-desc">
            {summary && summary.size === 0 ? '当前没有可清理的缓存' : '清理后缓存会随使用重新生成'}
          </span>
        </div>
      </SettingRow>
      {lockedDirs > 0 && summary && summary.size > 1024 * 1024 && (
        <div className="settings-note">
          有部分缓存文件正被应用占用，重启映盒剧场后再清理一次即可释放。
        </div>
      )}
    </SettingsCard>
  )
}

/* ── 设置页 ── */

function Settings({ onBack }: { onBack: () => void }): React.JSX.Element {
  const [section, setSection] = useState<SettingsSection>('preferences')
  const meta = SECTION_META[section]

  return (
    <div className="page-inner page-inner--rail">
      {/* 视觉上不再显示页面大标题，保留给屏幕阅读器 */}
      <h1 className="visually-hidden">设置</h1>

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="设置分类">
          <button type="button" className="settings-back" onClick={onBack}>
            <ArrowLeftOutlined />
            <span>返回</span>
          </button>
          <div className="settings-nav-divider" />

          {NAV_ITEMS.map((item) => {
            const Icon = item.icon
            const active = item.key === section
            return (
              <button
                key={item.key}
                type="button"
                className={`settings-nav-item${active ? ' is-active' : ''}`}
                onClick={() => setSection(item.key)}
              >
                <Icon />
                <span>{item.label}</span>
              </button>
            )
          })}
        </nav>

        <div className="settings-panel">
          <div className="settings-panel-head">
            <h2 className="settings-panel-title">{meta.title}</h2>
            <span className="settings-panel-sep">·</span>
            <p className="settings-panel-desc">{meta.desc}</p>
          </div>
          {section === 'preferences' && <PreferencesPanel />}
          {section === 'shortcut' && <ShortcutPanel />}
          {section === 'storage' && <StoragePanel />}
          {section === 'about' && <AboutPanel />}
        </div>
      </div>
    </div>
  )
}

export default Settings
