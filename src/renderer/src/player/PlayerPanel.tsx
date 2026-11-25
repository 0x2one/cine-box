import EpisodePanel from './EpisodePanel'
import PlayerInfo from './PlayerInfo'
import type { EpisodeNaming, PlayerLine } from './player-data'

export type PlayerPanelTab = 'episodes' | 'info'

const TABS: { value: PlayerPanelTab; label: string }[] = [
  { value: 'episodes', label: '剧集' },
  { value: 'info', label: '简介' }
]

interface PlayerPanelProps {
  tab: PlayerPanelTab
  onTab: (tab: PlayerPanelTab) => void
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
  /** 当前线路的集名风格 */
  naming: EpisodeNaming
  /** 视频分类（综艺 / 剧情片…） */
  category: string
  /** 头部 / 简介里的集数文案：「共 12 期」「单集」「共 2 个版本」 */
  countLabel: string
  /** 当前线路每一集的缓存状态（原始 episodes 下标） */
  cacheStates: Map<number, 'done' | 'active' | 'paused' | 'failed'>
  /** 批量入队请求进行中 */
  cacheBusy: boolean
  /** 多选批量缓存：一次提交当前线路的若干集 */
  onCacheEpisodes: (indexes: number[]) => void
}

/**
 * 播放器右侧的停靠面板：剧集 / 简介两个 tab。
 * 面板本身不滚动，剧集用内部的网格滚，简介整体滚；头部固定。
 * 头部只有这两个 tab：收起 / 展开统一走播放器右缘那颗 `.player-panel-toggle`。
 */
function PlayerPanel({
  tab,
  onTab,
  lines,
  line,
  onLine,
  episodeIndex,
  onEpisode,
  autoNext,
  onAutoNext,
  detail,
  lineLabel,
  naming,
  category,
  countLabel,
  cacheStates,
  cacheBusy,
  onCacheEpisodes
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
            naming={naming}
            category={category}
            cacheStates={cacheStates}
            cacheBusy={cacheBusy}
            onCacheEpisodes={onCacheEpisodes}
          />
        ) : (
          <PlayerInfo detail={detail} line={line} lineLabel={lineLabel} countLabel={countLabel} />
        )}
      </div>
    </aside>
  )
}

export default PlayerPanel
