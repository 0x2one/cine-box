import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  App,
  Button,
  Input,
  InputNumber,
  Popconfirm,
  Progress,
  Segmented,
  Spin,
  Switch,
  Tooltip
} from 'antd'
import {
  ArrowLeftOutlined,
  CheckCircleFilled,
  CheckOutlined,
  CloudDownloadOutlined,
  CompassOutlined,
  CompressOutlined,
  DeleteOutlined,
  DesktopOutlined,
  EditOutlined,
  ExclamationCircleFilled,
  ExpandOutlined,
  FolderOpenOutlined,
  GlobalOutlined,
  HddOutlined,
  InfoCircleOutlined,
  LaptopOutlined,
  LinkOutlined,
  MoonOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  SaveOutlined,
  SearchOutlined,
  SettingOutlined,
  SunOutlined,
  ThunderboltOutlined,
  UndoOutlined
} from '@ant-design/icons'
import { ACCENTS } from '../theme/appearance'
import { useTheme } from '../theme/theme-context'
import type { ThemeMode } from '../theme/appearance'
import { clearLastFeed } from '../lib/feed-cache'
import { formatBytes } from '../utils/format'
import { AboutPanel } from './About'

type SettingsSection =
  'preferences' | 'content' | 'network' | 'shortcut' | 'download' | 'storage' | 'about'

const NAV_ITEMS: {
  key: SettingsSection
  label: string
  icon: typeof SettingOutlined
}[] = [
  // 顺序：通用偏好 → 操作方式 → 网络 → 下载 → 存储 → 内容 → 关于，
  // 从「怎么用这个应用」一路收到「它从哪来」，最不常改的放在最后。
  { key: 'preferences', label: '偏好设置', icon: SettingOutlined },
  { key: 'shortcut', label: '快捷键', icon: ThunderboltOutlined },
  { key: 'network', label: '网络', icon: GlobalOutlined },
  { key: 'download', label: '下载', icon: CloudDownloadOutlined },
  { key: 'storage', label: '存储', icon: HddOutlined },
  { key: 'content', label: '内容', icon: SafetyCertificateOutlined },
  { key: 'about', label: '关于', icon: InfoCircleOutlined }
]

const SECTION_META: Record<SettingsSection, { title: string; desc: string }> = {
  preferences: { title: '偏好设置', desc: '启动、关闭、更新与外观' },
  content: { title: '内容', desc: '18+ 内容是否在展示端出现' },
  network: { title: '网络', desc: '代理与网络连接' },
  shortcut: { title: '快捷键', desc: '在任何应用中唤起映盒剧场' },
  download: { title: '下载', desc: '保存位置与同时下载任务数' },
  storage: { title: '存储', desc: '本地缓存占用与清理' },
  about: { title: '关于', desc: '应用介绍与软件更新' }
}

const IS_MAC = window.electron?.process?.platform === 'darwin'
const DEFAULT_SHORTCUT = 'Ctrl+Shift+Space'

const WINDOW_SIZE_LABELS: Record<AppWindowSize, string> = {
  medium: '适中',
  large: '大屏',
  xlarge: '超大'
}

/** 每档的目标尺寸（与 src/main/window-size.ts 的预设保持一致），主进程还会按主显示器工作区收缩 */
const WINDOW_SIZE_HINTS: Record<AppWindowSize, string> = {
  medium: '约 1200 × 780，适合笔记本与小屏',
  large: '约 1400 × 880，适合 1080p 及以上的大屏',
  xlarge: '约 1600 × 1000，适合 2K / 4K 显示器'
}

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

/** 默认首页：启动时直接打开推荐页还是搜索页 */
function StartViewRow(): React.JSX.Element {
  const { message } = App.useApp()
  const [value, setValue] = useState<AppStartView>('home')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    void window.api.settings.get().then((settings) => {
      if (!alive) return
      setValue(settings.startView)
      setLoading(false)
    })
    return () => {
      alive = false
    }
  }, [])

  const onChange = (next: string | number): void => {
    const startView: AppStartView = next === 'search' ? 'search' : 'home'
    setValue(startView)
    void window.api.settings.setStartView(startView).then((settings) => {
      setValue(settings.startView)
      message.success(
        `默认首页已设为「${settings.startView === 'search' ? '搜索视频' : '推荐'}」，下次启动生效`
      )
    })
  }

  return (
    <SettingRow title="默认首页" description="启动映盒剧场时直接打开的页面，下次启动生效">
      <Segmented
        value={value}
        disabled={loading}
        onChange={onChange}
        options={[
          { value: 'home', label: '推荐', icon: <CompassOutlined /> },
          { value: 'search', label: '搜索视频', icon: <SearchOutlined /> }
        ]}
      />
    </SettingRow>
  )
}

/** 启动时默认大小：窗口初始尺寸分三档，屏幕放不下时主进程按工作区收缩 */
function WindowSizeRow(): React.JSX.Element {
  const { message } = App.useApp()
  const [value, setValue] = useState<AppWindowSize>('large')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    void window.api.settings.get().then((settings) => {
      if (!alive) return
      setValue(settings.windowSize)
      setLoading(false)
    })
    return () => {
      alive = false
    }
  }, [])

  const onChange = (next: string | number): void => {
    const windowSize: AppWindowSize = next === 'medium' || next === 'xlarge' ? next : 'large'
    setValue(windowSize)
    void window.api.settings.setWindowSize(windowSize).then((settings) => {
      setValue(settings.windowSize)
      message.success(`启动大小已设为「${WINDOW_SIZE_LABELS[settings.windowSize]}」，下次启动生效`)
    })
  }

  return (
    <SettingRow
      title="启动时默认大小"
      description={`${WINDOW_SIZE_HINTS[value]}，屏幕放不下时自动收缩，下次启动生效`}
    >
      <Segmented
        value={value}
        disabled={loading}
        onChange={onChange}
        options={[
          { value: 'medium', label: '适中', icon: <CompressOutlined /> },
          { value: 'large', label: '大屏', icon: <DesktopOutlined /> },
          { value: 'xlarge', label: '超大', icon: <ExpandOutlined /> }
        ]}
      />
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

      {/* 默认首页与启动大小都是「下次启动生效」的启动偏好，单独一张卡片，不和开机自启 / 托盘 / 更新混在一起 */}
      <SettingsCard>
        <StartViewRow />
        <WindowSizeRow />
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

/* ── 内容 ── */

/**
 * 18+ 内容总开关：关掉之后，标记过的站点 / 分类 / 视频在推荐、找片看、搜索视频、
 * 播放页和局域网共享页里全部不可见；控制台不受影响，仍然能看到并管理。
 */
function ContentPanel(): React.JSX.Element {
  const { message } = App.useApp()
  const [allowAdult, setAllowAdult] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let alive = true
    void window.api.settings
      .get()
      .then((settings) => {
        if (!alive) return
        setAllowAdult(settings.allowAdult)
        setLoading(false)
      })
      .catch(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [])

  const toggle = async (value: boolean): Promise<void> => {
    setAllowAdult(value)
    setSaving(true)
    try {
      const settings = await window.api.settings.setAllowAdult(value)
      setAllowAdult(settings.allowAdult)
      // 推荐页那一层渲染缓存也一起作废：回推荐页不能先闪一帧已经该隐藏的内容
      clearLastFeed()
      message.success(settings.allowAdult ? '已显示 18+ 内容' : '已隐藏全部 18+ 内容')
    } catch {
      message.error('保存失败，请重试')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <SettingsCard>
        <SettingRow
          title="显示 18+ 内容"
          description="关闭后，标记为 18+ 的站点、分类与视频在推荐、找片看、搜索视频、播放页和局域网共享页里都不再出现。"
        >
          <Switch
            checked={allowAdult}
            loading={loading}
            disabled={saving}
            onChange={(value) => void toggle(value)}
          />
        </SettingRow>
        <p className="settings-note">
          打开后这些内容会照常出现在展示端，不额外提示。开关只影响展示端与共享页，控制台始终能看到全部视频，方便继续采集和整理。
        </p>
      </SettingsCard>

      <SettingsCard>
        <SettingRow
          title="在哪里标记 18+"
          description="控制台的「站点」「分类」「视频」各自有一个 18+ 开关；站点或分类标记之后，它们下面的视频都按 18+ 处理。"
        >
          <span className="settings-static">站点 · 分类 · 视频</span>
        </SettingRow>
      </SettingsCard>
    </>
  )
}

/* ── 网络 ── */

const NETWORK_MODE_OPTIONS: { value: NetworkProxyMode; label: string }[] = [
  { value: 'off', label: '禁用' },
  { value: 'system', label: '系统代理' },
  { value: 'custom', label: '自定义' }
]

const NETWORK_MODE_DESC: Record<NetworkProxyMode, string> = {
  off: '所有远程请求直连，即使操作系统设置了代理也不使用',
  system: '跟随操作系统的代理设置（Windows「Internet 选项」/ macOS「网络」）',
  custom: '使用下方填写的 HTTP 或 SOCKS5 代理服务器'
}

const DEFAULT_NETWORK_TEST_URL = 'https://www.google.com'

/** 设置页里的一段人话，和主进程 describeNetwork 保持一致 */
function describeNetworkSettings(settings: NetworkSettings): string {
  if (settings.mode === 'system') return '跟随系统代理'
  if (settings.mode === 'off') return '直连（不使用代理）'
  const type = settings.type === 'socks5' ? 'SOCKS5' : 'HTTP'
  const host = settings.host
    ? `${
        settings.host.includes(':') ? `[${settings.host}]` : settings.host
      }${settings.port > 0 ? `:${settings.port}` : ''}`
    : '未填写'
  return `${type} 代理 ${host}${settings.authEnabled ? ' · 身份验证' : ''}`
}

/** 与主进程 isValidProxyHost 对齐的轻量校验：域名 / IPv4 / IPv6 */
function isNetworkHostShape(host: string): boolean {
  if (host.includes(':')) return /^[0-9a-f:.]+$/i.test(host)
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return host.split('.').every((part) => Number(part) >= 0 && Number(part) <= 255)
  }
  return /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(
    host
  )
}

/** 表单的即时校验：只覆盖「填没填对」，代理能不能连由「验证」按钮回答 */
function networkDraftProblem(settings: NetworkSettings): string | null {
  if (settings.mode !== 'custom') return null
  const host = settings.host.trim()
  if (!host) return '请填写代理服务器地址'
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) return '代理服务器地址不要带 http:// 或 socks5:// 前缀'
  if (/[\s/]/.test(host)) return '代理服务器地址不能包含空格或路径'
  if (!isNetworkHostShape(host)) return '代理服务器地址只支持域名、IPv4 或 IPv6'
  if (!Number.isInteger(settings.port) || settings.port < 1 || settings.port > 65535) {
    return '端口需要是 1–65535 之间的整数'
  }
  if (settings.authEnabled && !settings.username.trim()) return '启用身份验证后需要填写用户名'
  return null
}

function NetworkPanel(): React.JSX.Element {
  const { message } = App.useApp()
  const [saved, setSaved] = useState<NetworkSettings | null>(null)
  const [draft, setDraft] = useState<NetworkSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<NetworkTestResult | null>(null)
  const [saveError, setSaveError] = useState('')

  useEffect(() => {
    let alive = true
    void window.api.settings
      .get()
      .then((settings) => {
        if (!alive) return
        setSaved(settings.network)
        setDraft(settings.network)
        setLoading(false)
      })
      .catch(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [])

  const patch = (value: Partial<NetworkSettings>): void => {
    setDraft((current) => (current ? { ...current, ...value } : current))
    setTestResult(null)
    setSaveError('')
  }

  if (!draft || !saved) {
    return (
      <SettingsCard>
        <div className="settings-row">
          <span className="settings-row-desc">
            {loading ? '正在读取网络设置…' : '读取网络设置失败'}
          </span>
        </div>
      </SettingsCard>
    )
  }

  const problem = networkDraftProblem(draft)
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)
  // 套用失败（例如本机桥接没起来）时配置已经落盘，需要允许原样重试
  const canSave = (dirty || Boolean(saveError)) && !problem && !saving

  const save = async (): Promise<void> => {
    const invalid = networkDraftProblem(draft)
    if (invalid) {
      message.error(invalid)
      return
    }
    setSaving(true)
    try {
      const result = await window.api.settings.setNetwork(draft)
      setSaved(result.settings.network)
      if (result.ok) {
        setDraft(result.settings.network)
        setSaveError('')
        message.success('网络设置已保存并生效')
      } else {
        setSaveError(result.message || '网络设置保存失败')
        message.error(result.message || '网络设置保存失败')
      }
    } catch {
      message.error('保存网络设置失败，请稍后重试')
    } finally {
      setSaving(false)
    }
  }

  const test = async (): Promise<void> => {
    const invalid = networkDraftProblem(draft)
    if (invalid) {
      message.error(invalid)
      return
    }
    setTesting(true)
    setTestResult(null)
    try {
      const result = await window.api.settings.testNetwork({
        settings: draft,
        url: draft.testUrl
      })
      setTestResult(result)
      if (result.ok) message.success(result.message)
      else message.error(result.message)
    } catch {
      message.error('代理验证失败，请稍后重试')
    } finally {
      setTesting(false)
    }
  }

  return (
    <>
      <SettingsCard>
        <SettingRow stacked title="代理模式" description={NETWORK_MODE_DESC[draft.mode]}>
          <Segmented
            value={draft.mode}
            disabled={loading}
            onChange={(value) => patch({ mode: value as NetworkProxyMode })}
            options={NETWORK_MODE_OPTIONS}
          />
        </SettingRow>
        <div className="settings-note">
          代理开启后，预览图、播放视频、站点接口数据以及局域网共享页里的远程封面与视频都由代理转发；
          本地缓存、本机播放服务与局域网地址始终直连。
        </div>
      </SettingsCard>

      {draft.mode === 'custom' && (
        <SettingsCard>
          <SettingRow
            title="代理协议"
            description="HTTP 代理走 CONNECT 隧道，SOCKS5 由代理端解析域名"
          >
            <Segmented
              value={draft.type}
              onChange={(value) => patch({ type: value as NetworkProxyType })}
              options={[
                { value: 'http', label: 'HTTP' },
                { value: 'socks5', label: 'SOCKS5' }
              ]}
            />
          </SettingRow>
          <SettingRow
            stacked
            title="代理服务器"
            description="只填地址和端口；支持域名、IPv4 与 IPv6，不要带协议前缀"
          >
            <div className="network-field">
              <div className="network-endpoint">
                <Input
                  value={draft.host}
                  placeholder="127.0.0.1 或 proxy.example.com"
                  allowClear
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(event) => patch({ host: event.target.value })}
                />
                <InputNumber
                  value={draft.port > 0 ? draft.port : null}
                  min={1}
                  max={65535}
                  precision={0}
                  placeholder="端口"
                  onChange={(value) => patch({ port: Number(value) || 0 })}
                />
              </div>
              {problem && <span className="network-hint is-error">{problem}</span>}
            </div>
          </SettingRow>
          <SettingRow title="身份验证" description="代理服务器要求用户名密码时打开，默认关闭">
            <Switch
              checked={draft.authEnabled}
              onChange={(checked) => patch({ authEnabled: checked })}
            />
          </SettingRow>
          {draft.authEnabled && (
            <SettingRow
              stacked
              title="代理账号"
              description="HTTP 代理使用 Basic 认证；SOCKS5 使用用户名密码认证，凭据只保存在本机设置文件里"
            >
              <div className="network-auth">
                <Input
                  value={draft.username}
                  placeholder="用户名"
                  autoComplete="off"
                  onChange={(event) => patch({ username: event.target.value })}
                />
                <Input.Password
                  value={draft.password}
                  placeholder="密码"
                  autoComplete="new-password"
                  onChange={(event) => patch({ password: event.target.value })}
                />
              </div>
            </SettingRow>
          )}
        </SettingsCard>
      )}

      <SettingsCard>
        <SettingRow
          stacked
          title="代理验证"
          description="用当前填写的配置访问目标地址，未保存的修改也可以先验证"
        >
          <div className="network-field">
            <div className="network-test">
              <Input
                value={draft.testUrl}
                placeholder={DEFAULT_NETWORK_TEST_URL}
                prefix={<LinkOutlined />}
                allowClear
                spellCheck={false}
                onChange={(event) => patch({ testUrl: event.target.value })}
              />
              <Button
                icon={<SafetyCertificateOutlined />}
                loading={testing}
                disabled={Boolean(problem)}
                onClick={() => void test()}
              >
                验证
              </Button>
            </div>
            {testing && (
              <span className="network-hint">
                正在通过代理请求 {draft.testUrl || DEFAULT_NETWORK_TEST_URL}…
              </span>
            )}
            {!testing && testResult && (
              <div className={`network-result${testResult.ok ? ' is-ok' : ' is-error'}`}>
                {testResult.ok ? <CheckCircleFilled /> : <ExclamationCircleFilled />}
                <div className="network-result-text">
                  <span>{testResult.message}</span>
                  <span className="network-result-meta">
                    {testResult.proxy}
                    {testResult.status > 0 ? ` · HTTP ${testResult.status}` : ''} ·{' '}
                    {testResult.elapsedMs} ms
                  </span>
                </div>
              </div>
            )}
          </div>
        </SettingRow>
        <div className="settings-note">
          默认验证地址是 {DEFAULT_NETWORK_TEST_URL}，也可以换成任意 http(s) 地址；返回任意 HTTP
          状态码都表示代理链路已经连通。
        </div>
      </SettingsCard>

      <div className="network-savebar">
        <div className="settings-row-text">
          <span className="settings-row-title">
            {dirty ? '有未保存的更改' : saveError ? '修改已保存，但未生效' : '网络设置已保存'}
          </span>
          <span className="settings-row-desc">
            {dirty
              ? `保存后生效：${describeNetworkSettings(draft)}`
              : `当前配置：${describeNetworkSettings(saved)}`}
          </span>
          {saveError && <span className="network-hint is-error">{saveError}</span>}
        </div>
        <Button
          type="primary"
          icon={<SaveOutlined />}
          disabled={!canSave}
          loading={saving}
          onClick={() => void save()}
        >
          保存
        </Button>
      </div>
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

/* ── 下载 ── */

/** 下载占磁盘的比例：很小的比例写成「<0.1%」，不要一律显示 0.0% */
function formatShare(size: number, total: number): string {
  if (total <= 0) return '—'
  const percent = (size / total) * 100
  if (percent === 0) return '0%'
  if (percent < 0.1) return '<0.1%'
  return `${percent.toFixed(percent >= 10 ? 0 : 1)}%`
}

/**
 * 下载相关设置：存储占用概览 + 保存位置 + 同时下载任务数 + 单集分片并发。
 * 下载中心页只保留记录列表，这几项单独占一个设置分区，路径可以整行铺开。
 */
function DownloadPanel(): React.JSX.Element {
  const { message } = App.useApp()
  const [path, setPath] = useState('')
  const [concurrency, setConcurrency] = useState(2)
  const [segmentConcurrency, setSegmentConcurrency] = useState(3)
  const [usage, setUsage] = useState<DownloadUsage | null>(null)
  const [loading, setLoading] = useState(true)
  const [picking, setPicking] = useState(false)
  const [scanning, setScanning] = useState(true)

  const refreshUsage = useCallback(async (): Promise<void> => {
    setScanning(true)
    try {
      const result = await window.api.downloads.usage()
      setUsage(result.ok && result.usage ? result.usage : null)
    } catch {
      setUsage(null)
    } finally {
      setScanning(false)
    }
  }, [])

  useEffect(() => {
    let alive = true
    void window.api.settings.get().then((settings) => {
      if (!alive) return
      setPath(settings.downloadPath)
      setConcurrency(settings.downloadConcurrency)
      setSegmentConcurrency(settings.downloadSegmentConcurrency)
      setLoading(false)
    })
    return () => {
      alive = false
    }
  }, [])

  // 进入分区就统计一次；改下载目录后目录变了，重新扫。
  // refreshUsage 会先同步置 scanning，规则按调用点误报，这里显式关闭
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshUsage()
  }, [refreshUsage])

  const changePath = async (): Promise<void> => {
    setPicking(true)
    try {
      const picked = await window.api.downloads.pickPath()
      if (!picked.ok || !picked.path) return
      const result = await window.api.downloads.setPath(picked.path)
      if (!result.ok) {
        message.error(
          result.error === 'NOT_WRITABLE' ? '这个目录不可写，换一个位置试试' : '目录路径无效'
        )
        return
      }
      setPath(result.settings.downloadPath)
      void refreshUsage()
      message.success('下载目录已更新')
    } catch {
      message.error('更改下载目录失败')
    } finally {
      setPicking(false)
    }
  }

  const changeConcurrency = (next: string | number): void => {
    const value = Number(next)
    void window.api.downloads
      .setConcurrency(value)
      .then((saved) => {
        setConcurrency(saved.downloadConcurrency)
        message.success(`同时下载任务数已设为 ${saved.downloadConcurrency}`)
      })
      .catch(() => message.error('保存并发设置失败'))
  }

  const changeSegmentConcurrency = (next: string | number): void => {
    const value = Number(next)
    void window.api.downloads
      .setSegmentConcurrency(value)
      .then((saved) => {
        setSegmentConcurrency(saved.downloadSegmentConcurrency)
        message.success(`单集分片并发已设为 ${saved.downloadSegmentConcurrency}`)
      })
      .catch(() => message.error('保存分片并发设置失败'))
  }

  const openDirectory = async (): Promise<void> => {
    const result = await window.api.downloads.openFolder()
    if (!result.ok) message.error('打开下载目录失败')
  }

  const used = usage && usage.total > 0 ? usage.total - usage.free : 0
  const usedPercent =
    usage && usage.total > 0 ? Math.min(100, Math.round((used / usage.total) * 100)) : 0
  const downloadPercent = usage && usage.total > 0 ? (usage.size / usage.total) * 100 : 0

  return (
    <>
      <SettingsCard>
        <div className="settings-usage">
          <div className="settings-usage-head">
            <span className="settings-row-title">存储占用</span>
            <Tooltip title="重新统计">
              <Button
                size="small"
                type="text"
                icon={<ReloadOutlined />}
                aria-label="重新统计下载占用"
                loading={scanning}
                onClick={() => void refreshUsage()}
              />
            </Tooltip>
          </div>

          <div className="settings-usage-stats">
            <div className="settings-usage-stat">
              <span className="settings-usage-label">下载占用</span>
              <span className="settings-usage-value">{usage ? formatBytes(usage.size) : '—'}</span>
              <span className="settings-usage-sub">
                {usage ? `${usage.files.toLocaleString('zh-CN')} 个文件` : '正在统计…'}
              </span>
            </div>
            <div className="settings-usage-stat">
              <span className="settings-usage-label">磁盘剩余</span>
              <span className="settings-usage-value">
                {usage && usage.total > 0 ? formatBytes(usage.free) : '—'}
              </span>
              <span className="settings-usage-sub">
                {usage && usage.total > 0 ? `已用 ${formatBytes(used)}` : '读取不到磁盘信息'}
              </span>
            </div>
            <div className="settings-usage-stat">
              <span className="settings-usage-label">磁盘总容量</span>
              <span className="settings-usage-value">
                {usage && usage.total > 0 ? formatBytes(usage.total) : '—'}
              </span>
              <span className="settings-usage-sub">
                {usage && usage.total > 0 ? `下载占 ${formatShare(usage.size, usage.total)}` : '—'}
              </span>
            </div>
          </div>

          <div className="settings-usage-bar">
            <div
              className="settings-usage-track"
              role="img"
              aria-label={`磁盘已用 ${usedPercent}%`}
            >
              <span className="settings-usage-used" style={{ width: `${usedPercent}%` }} />
              <span
                className="settings-usage-download"
                style={{ width: `${Math.min(100, downloadPercent)}%` }}
              />
            </div>
            <span className="settings-usage-caption">
              {usage && usage.total > 0 ? `磁盘已用 ${usedPercent}%` : '—'}
            </span>
          </div>
        </div>
      </SettingsCard>

      <SettingsCard>
        <SettingRow
          stacked
          title="保存位置"
          description="新下载 / 缓存的视频保存到这个目录；更改后已有文件与记录不受影响"
        >
          <div className="settings-path-row">
            <span className="settings-path" title={path || undefined}>
              {loading ? '正在读取…' : path || '—'}
            </span>
            <Tooltip title="更改下载目录">
              <Button
                size="small"
                icon={<EditOutlined />}
                aria-label="更改下载目录"
                loading={picking}
                disabled={loading}
                onClick={() => void changePath()}
              />
            </Tooltip>
            <Tooltip title="打开下载目录">
              <Button
                size="small"
                type="text"
                icon={<FolderOpenOutlined />}
                aria-label="打开下载目录"
                onClick={() => void openDirectory()}
              />
            </Tooltip>
          </div>
        </SettingRow>

        <SettingRow
          title="同时下载任务数"
          description="同时进行的下载数量，太多容易占满带宽；调小不会中断正在下载的任务"
        >
          <Segmented
            value={concurrency}
            disabled={loading}
            onChange={changeConcurrency}
            options={[1, 2, 3, 4, 5].map((value) => ({
              value,
              label: `${value}`
            }))}
          />
        </SettingRow>

        <SettingRow
          title="单集分片并发数"
          description="同一集内部同时下载的分片数，调高能加快单集缓存，但更容易被站点限流；对之后开始的缓存任务生效"
        >
          <Segmented
            value={segmentConcurrency}
            disabled={loading}
            onChange={changeSegmentConcurrency}
            options={[1, 2, 3, 4, 5, 6].map((value) => ({
              value,
              label: `${value}`
            }))}
          />
        </SettingRow>
      </SettingsCard>
    </>
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
          {section === 'content' && <ContentPanel />}
          {section === 'network' && <NetworkPanel />}
          {section === 'shortcut' && <ShortcutPanel />}
          {section === 'download' && <DownloadPanel />}
          {section === 'storage' && <StoragePanel />}
          {section === 'about' && <AboutPanel />}
        </div>
      </div>
    </div>
  )
}

export default Settings
