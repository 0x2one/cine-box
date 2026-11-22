import { useFallbackPic } from '../hooks/useFallbackPic'
import '../assets/home.css'

/**
 * 首页图片的统一渲染：自定义图片按归一化裁剪框定位，其余按 cover 铺满。
 * 首页卡片、海报叠层与控制台的预览缩略图共用，保证三处看到的是同一块画面。
 * 当前封面加载失败时自动改试该视频其它来源的封面。
 */
function HomePicture({
  item,
  eager
}: {
  item: Pick<HomeItemView, 'pic' | 'crop' | 'customPic' | 'title'> & {
    picCandidates?: string[]
  }
  eager?: boolean
}): React.JSX.Element {
  const { src, onError, fallbackIndex } = useFallbackPic(item.pic, item.picCandidates ?? [])
  const crop = item.crop
  // 换源后不再套自定义裁剪框：裁剪坐标只属于用户选的那张图
  const cropped = item.customPic && fallbackIndex === 0 && crop.w > 0 && crop.h > 0
  const style = cropped
    ? {
        width: `${100 / crop.w}%`,
        height: `${100 / crop.h}%`,
        left: `${(-crop.x / crop.w) * 100}%`,
        top: `${(-crop.y / crop.h) * 100}%`
      }
    : undefined

  return (
    <div className="home-picture">
      <span className="home-picture-letter" aria-hidden="true">
        {item.title.trim().slice(0, 1) || '映'}
      </span>
      {src && (
        <img
          src={src}
          alt=""
          style={style}
          className={cropped ? 'is-crop' : undefined}
          loading={eager ? 'eager' : 'lazy'}
          decoding={eager ? 'sync' : 'async'}
          referrerPolicy="no-referrer"
          // 控制台推荐页配置里整行可拖动排序，图片自己不能变成拖动源
          draggable={false}
          onError={onError}
        />
      )}
    </div>
  )
}

export default HomePicture
