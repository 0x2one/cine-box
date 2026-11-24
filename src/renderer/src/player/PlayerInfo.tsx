import { useState } from 'react'
import FallbackImage from '../components/FallbackImage'
import type { PlayerLine } from './player-data'

interface PlayerInfoProps {
  detail: VideoDetail | null
  line: PlayerLine | null
  /** 当前播放源名：「{资源站名}」，同站有多条 m3u8 时带 ① ② */
  lineLabel: string
  /** 集数文案：「共 12 期」/「单集」/「共 2 个版本」，量词跟着集名风格走 */
  countLabel: string
}

/**
 * 面板里的简介页：封面 + 片名 + 元信息 + 主演 / 导演 + 简介。
 * 简介默认收六行，长文可以展开；整页由面板的滚动容器负责滚动。
 */
function PlayerInfo({ detail, line, lineLabel, countLabel }: PlayerInfoProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)

  const source = detail?.sources.find((item) => item.id === line?.sourceId) ?? detail?.sources[0]
  const meta = source?.detail
  const title = detail?.name?.trim() ?? ''
  const intro = (meta?.intro?.trim() || detail?.introExcerpt?.trim() || '').trim()
  const actors = (detail?.vodActor?.trim() || meta?.actor?.trim() || '').trim()
  const director = meta?.director?.trim() ?? ''

  const sourceName = lineLabel || source?.siteName?.trim() || ''

  const chips = [
    meta?.year?.trim(),
    meta?.area?.trim(),
    source?.categoryName?.trim(),
    detail?.note?.trim(),
    countLabel,
    // 播放页只播 m3u8，不再标注「线路 xxx」这种播放类型，只写资源站名
    sourceName ? `来源 ${sourceName}` : ''
  ].filter((item): item is string => Boolean(item))

  const expandable = intro.length > 140

  return (
    <section className="player-info">
      <div className="player-info-hero">
        <div className="player-poster">
          <span className="player-poster-letter">{title.slice(0, 1) || '映'}</span>
          <FallbackImage src={detail?.pic ?? ''} candidates={detail?.picCandidates ?? []} alt="" />
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
