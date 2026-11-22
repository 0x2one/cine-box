import { useState } from 'react'

/**
 * 封面加载失败时依次尝试该视频的其它来源封面。
 *
 * 第一项永远是当前的 pic（可能是人工换的封面），后面接视频各来源的 pic；
 * 去重去空。全部失败后返回空 src，界面自然露出首字占位。
 */
export function useFallbackPic(
  pic: string,
  candidates: string[] = []
): { src: string; onError: () => void; fallbackIndex: number } {
  const current = pic.trim()
  const extras = candidates.map((item) => item.trim()).filter((item) => item && item !== current)
  const urls = [...new Set([current, ...extras].filter(Boolean))]
  // 候选数组每次渲染都是新对象，所以用内容当 key；换视频 / 换封面时自动从第一张重来
  const key = urls.join('\u0000')
  const [state, setState] = useState<{ key: string; index: number }>({ key, index: 0 })
  const index = state.key === key ? state.index : 0

  return {
    src: index < urls.length ? urls[index] : '',
    onError: () => setState({ key, index: index + 1 }),
    fallbackIndex: index
  }
}
