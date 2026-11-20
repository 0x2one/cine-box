import HomePicture from './HomePicture'
import '../assets/home.css'

/** 没有自定义裁剪时按 cover 铺满，和首页条目一致 */
const FULL_CROP: HomeCrop = { x: 0, y: 0, w: 1, h: 1 }

interface VideoCardProps {
  title: string
  pic: string
  note: string
  intro: string
  actors: string
  latestTime: string
  crop?: HomeCrop
  /** 是否使用自定义图片（决定要不要按 crop 裁剪） */
  customPic?: boolean
  /** 首页轨道复制第二份时用：屏幕阅读器忽略重复卡片 */
  ariaHidden?: boolean
  /** 有 id 时封面和片名都能点开独立播放窗口 */
  videoId?: number
}

/**
 * 展示端的视频卡片：首页轨道与视频列表页共用这一份结构，
 * 封面、更新角标、片名与简介的排版因此在两处完全一致。
 * 点封面或片名直接打开独立播放窗口，卡片不跳详情页。
 */
function VideoCard({
  title,
  pic,
  note,
  intro,
  actors,
  latestTime,
  crop,
  customPic = false,
  ariaHidden,
  videoId
}: VideoCardProps): React.JSX.Element {
  const openable = videoId !== undefined

  const open = (): void => {
    if (videoId === undefined) return
    void window.api.player.open({ videoId, title })
  }

  return (
    <article
      className={`home-item${openable ? ' is-openable' : ''}`}
      title={title}
      aria-hidden={ariaHidden || undefined}
    >
      <div className="home-item-poster">
        <HomePicture item={{ pic, crop: crop ?? FULL_CROP, customPic, title }} />
        {/* 更新进度压在封面右下角，卡片下方只留片名和简介 */}
        {(note || latestTime) && (
          <span className="home-item-badge">{note || `更新 ${latestTime}`}</span>
        )}
        {/* 透明按钮铺满封面：整张图都能点，键盘也能聚焦，且不用把 <div> 塞进 <button> */}
        {openable && (
          <button
            type="button"
            className="home-item-open"
            title={`播放《${title}》`}
            aria-label={`播放 ${title}`}
            onClick={open}
          />
        )}
      </div>
      {openable ? (
        <button
          type="button"
          className="home-item-title home-item-title-btn"
          title={title}
          onClick={open}
        >
          {title}
        </button>
      ) : (
        <p className="home-item-title" title={title}>
          {title}
        </p>
      )}
      <p className="home-item-sub">{intro || (actors ? `主演 ${actors}` : '')}</p>
    </article>
  )
}

export default VideoCard
