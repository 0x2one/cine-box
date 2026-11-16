import { useEffect, useRef, useState, type ReactNode } from 'react'
import { App, Button, Segmented, Switch } from 'antd'
import {
  ArrowLeftOutlined,
  BgColorsOutlined,
  CheckOutlined,
  InfoCircleOutlined,
  LaptopOutlined,
  MoonOutlined,
  SettingOutlined,
  SunOutlined,
  ThunderboltOutlined,
  UndoOutlined
} from '@ant-design/icons'
import { ACCENTS } from '../theme/appearance'
import { useTheme } from '../theme/theme-context'
import type { ThemeMode } from '../theme/appearance'
import { AboutPanel } from './About'

type SettingsSection = 'preferences' | 'shortcut' | 'appearance' | 'about'

const NAV_ITEMS: {
  key: SettingsSection
  label: string
  icon: typeof SettingOutlined
}[] = [
  { key: 'preferences', label: '偏好设置', icon: SettingOutlined },
  { key: 'shortcut', label: '快捷键', icon: ThunderboltOutlined },
  { key: 'appearance', label: '外观', icon: BgColorsOutlined },
  { key: 'about', label: '关于', icon: InfoCircleOutlined }
]

const SECTION_META: Record<SettingsSection, { title: string; desc: string }> = {
  preferences: { title: '偏好设置', desc: '启动、关闭与更新行为' },
  shortcut: { title: '快捷键', desc: '在任何应用中唤起映盒剧场' },
  appearance: { title: '外观', desc: '明暗主题与强调色' },
  about: { title: '关于', desc: '版本信息与软件更新' }
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
  return (
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
              <Button size="small" icon={<UndoOutlined />} onClick={reset}>
                恢复默认
              </Button>
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

/* ── 外观 ── */

function AppearancePanel(): React.JSX.Element {
  const { mode, setMode, accent, setAccent } = useTheme()

  return (
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
      <SettingRow stacked title="主题色" description="默认使用 Logo 的蓝色，可切换为其它强调色">
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
  )
}

/* ── 设置页 ── */

function Settings({ onBack }: { onBack: () => void }): React.JSX.Element {
  const [section, setSection] = useState<SettingsSection>('preferences')
  const meta = SECTION_META[section]

  return (
    <div className="page-inner">
      <button type="button" className="page-back" onClick={onBack}>
        <ArrowLeftOutlined />
        <span>返回</span>
      </button>
      <h1 className="page-title">设置</h1>
      <p className="page-subtitle">偏好设置、快捷键与外观</p>

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="设置分类">
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
            <p className="settings-panel-desc">{meta.desc}</p>
          </div>
          {section === 'preferences' && <PreferencesPanel />}
          {section === 'shortcut' && <ShortcutPanel />}
          {section === 'appearance' && <AppearancePanel />}
          {section === 'about' && <AboutPanel />}
        </div>
      </div>
    </div>
  )
}

export default Settings
