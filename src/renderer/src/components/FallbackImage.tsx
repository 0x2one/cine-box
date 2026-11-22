import type { ImgHTMLAttributes } from 'react'
import { useFallbackPic } from '../hooks/useFallbackPic'

type FallbackImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'onError'> & {
  src: string
  /** 当前 src 加载失败时依次尝试的其它地址 */
  candidates?: string[]
}

/**
 * 通用封面图片：加载失败时自动换到下一个候选，全部失败则不渲染，
 * 由外层的首字占位兜底。调用方照常传 className / loading / alt 等属性。
 */
function FallbackImage({
  src,
  candidates = [],
  ...rest
}: FallbackImageProps): React.JSX.Element | null {
  const { src: resolved, onError } = useFallbackPic(src, candidates)
  if (!resolved) return null
  return <img referrerPolicy="no-referrer" {...rest} src={resolved} onError={onError} />
}

export default FallbackImage
