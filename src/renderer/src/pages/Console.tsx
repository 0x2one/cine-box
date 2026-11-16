import { useState } from 'react'
import {
  ArrowLeftOutlined,
  DashboardOutlined,
  FileTextOutlined,
  UnorderedListOutlined
} from '@ant-design/icons'

type ConsoleSection = 'overview' | 'tasks' | 'logs'

const NAV_ITEMS: { key: ConsoleSection; label: string; icon: typeof DashboardOutlined }[] = [
  { key: 'overview', label: '概览', icon: DashboardOutlined },
  { key: 'tasks', label: '任务', icon: UnorderedListOutlined },
  { key: 'logs', label: '日志', icon: FileTextOutlined }
]

const SECTION_META: Record<ConsoleSection, { title: string; desc: string; empty: string }> = {
  overview: { title: '概览', desc: '运行状态与统计', empty: '暂无数据' },
  tasks: { title: '任务', desc: '任务列表与执行进度', empty: '暂无任务' },
  logs: { title: '日志', desc: '运行日志', empty: '暂无日志' }
}

/**
 * 控制台：内容区尚未接入，先按设置页的「左侧导航 + 右侧面板」骨架占位。
 * 面板内容后续替换 `.console-empty` 即可。
 */
function Console({ onBack }: { onBack: () => void }): React.JSX.Element {
  const [section, setSection] = useState<ConsoleSection>('overview')
  const meta = SECTION_META[section]

  return (
    <div className="page-inner">
      <button type="button" className="page-back" onClick={onBack}>
        <ArrowLeftOutlined />
        <span>返回</span>
      </button>
      <h1 className="page-title">控制台</h1>
      <p className="page-subtitle">任务与运行状态</p>

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="控制台菜单">
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
          <section className="settings-card">
            <div className="console-empty">
              <span className="console-empty-title">{meta.empty}</span>
              <span className="console-empty-hint">控制台功能正在搭建，敬请期待</span>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

export default Console
