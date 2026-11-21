import { CloseOutlined } from '@ant-design/icons'
import EpisodePanel from './EpisodePanel'
import PlayerInfo from './PlayerInfo'
import type { PlayerLine } from './player-data'

export type PlayerPanelTab = 'episodes' | 'info'

const TABS: { value: PlayerPanelTab; label: string }[] = [
  { value: 'episodes', label: '剧集' },
  { value: 'info', label: '简介' }
]

interface PlayerPanelProps {
  tab: PlayerPanelTab
  onTab: (tab: PlayerPanelTab) => void
  onClose: () => void
  lines: PlayerLine[]
  line: PlayerLine
  onLine: (line: PlayerLine) => void
  episodeIndex: number
  onEpisode: (index: number) => void
  autoNext: boolean
  onAutoNext: (value: boolean) => void
  detail: VideoDetail | null
  /** 当前线路名，简介里显示在元信息里 */
  lineLabel: string
}

/**
 * 播放器右侧的停靠面板：剧集 / 简介两个 tab。
 * 面板本身不滚动，剧集用内部的网格滚，简介整体滚；头部固定。
 */
function PlayerPanel({
  tab,
  onTab,
  onClose,
  lines,
  line,
  onLine,
  episodeIndex,
  onEpisode,
  autoNext,
  onAutoNext,
  detail,
  lineLabel
}: PlayerPanelProps): React.JSX.Element {
  return (
    <aside className="player-panel" aria-label="剧集与简介">
      <div className="player-panel-head">
        <div className="player-panel-tabs" role="tablist" aria-label="播放信息">
          {TABS.map((item) => (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={tab === item.value}
              className={`player-panel-tab${tab === item.value ? ' is-active' : ''}`}
              onClick={() => onTab(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="player-panel-close"
          onClick={onClose}
          title="收起面板"
          aria-label="收起面板"
        >
          <CloseOutlined />
        </button>
      </div>

      <div className={`player-panel-body is-${tab}`} role="tabpanel">
        {tab === 'episodes' ? (
          <EpisodePanel
            lines={lines}
            line={line}
            onLine={onLine}
            episodeIndex={episodeIndex}
            onEpisode={onEpisode}
            autoNext={autoNext}
            onAutoNext={onAutoNext}
          />
        ) : (
          <PlayerInfo detail={detail} line={line} lineLabel={lineLabel} />
        )}
      </div>
    </aside>
  )
}

export default PlayerPanel
