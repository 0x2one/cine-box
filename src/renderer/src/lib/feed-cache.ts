/**
 * 推荐页 feed 的渲染层缓存：切回推荐页时先用它铺满，新数据到了再原地替换。
 * 主进程那边也缓存了同一份（推荐 ⇄ 找片看来回切时几乎不查库），这里再留一层
 * 是为了连「等 IPC 的那一帧」都不闪转圈。
 *
 * 18+ 内容开关切换后必须调 `clearLastFeed()`（`Settings.tsx` 的「内容分级」）：
 * 否则回到推荐页会先用旧 feed 铺一帧，已经该隐藏的海报 / 轨道会闪一下才被替换掉。
 */
let lastFeed: HomeFeed | null = null

export function readLastFeed(): HomeFeed | null {
  return lastFeed
}

export function writeLastFeed(feed: HomeFeed): void {
  lastFeed = feed
}

export function clearLastFeed(): void {
  lastFeed = null
}
