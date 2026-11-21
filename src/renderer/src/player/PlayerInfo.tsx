import { useState } from 'react'
import type { PlayerLine } from './player-data'

interface PlayerInfoProps {
  detail: VideoDetail | null
  line: PlayerLine | null
  /** 当前线路名，显示在元信息里 */
  lineLabel: string
}

/**
 * 面板里的简介页：封面 + 片名 + 元信息 + 主演 / 导演 + 简介。
 * 简介默认收六行，长文可以展开；整页由面板的滚动容器负责滚动。
 */
function PlayerInfo({ detail, line, lineLabel }: PlayerInfoProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)

  const source = detail?.sources.find((item) => item.id === line?.sourceId) ?? detail?.sources[0]
  const meta = source?.detail
  const title = detail?.name?.trim() ?? ''
  const intro = (meta?.intro?.trim() || detail?.introExcerpt?.trim() || '').trim()
  const actors = (detail?.vodActor?.trim() || meta?.actor?.trim() || '').trim()
  const director = meta?.director?.trim() ?? ''

  const chips = [
    meta?.year?.trim(),
    meta?.area?.trim(),
    source?.categoryName?.trim(),
    detail?.note?.trim(),
    line ? `共 ${line.episodes.length} 集` : '',
    lineLabel ? `线路 ${lineLabel}` : '',
    source ? `来源 ${source.siteName}` : ''
  ].filter((item): item is string => Boolean(item))

  const expandable = intro.length > 140

  return (
    <section className="player-info">
      <div className="player-info-hero">
        <div className="player-poster">
          <span className="player-poster-letter">{title.slice(0, 1) || '映'}</span>
          {detail?.pic && (
            <img
              src={detail.pic}
              alt=""
              referrerPolicy="no-referrer"
              onError={(event) => {
                event.currentTarget.style.visibility = 'hidden'
              }}
            />
          )}
        </div>

        <div className="player-info-head">
          <h2 className="player-info-title" title={title}>
            {title || '正在播放'}
          </h2>
          {chips.length > 0 && (
            <p className="player-info-meta">
              {chips.map((item, index) => (
                <span key={`${item}-${index}`}>{item}</span>
              ))}
            </p>
          )}
        </div>
      </div>

      {actors && (
        <p className="player-info-actor">
          <span className="player-info-label">主演</span>
          {actors}
        </p>
      )}
      {director && (
        <p className="player-info-actor">
          <span className="player-info-label">导演</span>
          {director}
        </p>
      )}

      <div className="player-info-intro-block">
        <span className="player-info-section">简介</span>
        {intro ? (
          <div className={`player-info-intro${expanded ? ' is-open' : ''}`}>
            <p>{intro}</p>
            {expandable && (
              <button
                type="button"
                className="player-info-more"
                onClick={() => setExpanded(!expanded)}
              >
                {expanded ? '收起' : '展开简介'}
              </button>
            )}
          </div>
        ) : (
          <p className="player-info-empty">这部视频还没有简介</p>
        )}
      </div>
    </section>
  )
}

export default PlayerInfo
