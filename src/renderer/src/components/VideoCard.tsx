import { CaretRightOutlined } from '@ant-design/icons'
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
  /** 传了就在封面上浮出播放按钮，点开独立播放窗口 */
  videoId?: number
}

/**
 * 展示端的视频卡片：首页轨道与视频列表页共用这一份结构，
 * 封面、更新角标、片名与简介的排版因此在两处完全一致。
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
  return (
    <article className="home-item" title={title} aria-hidden={ariaHidden || undefined}>
      <div className="home-item-poster">
        <HomePicture item={{ pic, crop: crop ?? FULL_CROP, customPic, title }} />
        {/* 更新进度压在封面右下角，卡片下方只留片名和简介 */}
        {(note || latestTime) && (
          <span className="home-item-badge">{note || `更新 ${latestTime}`}</span>
        )}
        {videoId !== undefined && (
          <button
            type="button"
            className="home-item-play"
            title={`播放《${title}》`}
            aria-label={`播放 ${title}`}
            // 叠层里的非首张卡片整张是「翻页」，别让播放按钮把点击冒泡上去
            onClick={(event) => {
              event.stopPropagation()
              void window.api.player.open({ videoId, title })
            }}
          >
            <CaretRightOutlined />
          </button>
        )}
      </div>
      <p className="home-item-title" title={title}>
        {title}
      </p>
      <p className="home-item-sub">{intro || (actors ? `主演 ${actors}` : '')}</p>
    </article>
  )
}

export default VideoCard
