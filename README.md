# 映盒剧场（cine-box）

一款用 Electron 构建的桌面影音应用。界面**仅提供简体中文**，无多语言切换。

技术栈：Electron 44 + React 19 + TypeScript 5.9 + antd 6 + Tailwind CSS 4，构建用 electron-vite 6 / Vite 8，打包用 electron-builder 26，自动更新用 electron-updater 6。

## 功能

- **展示端**：推荐页（海报叠层 + 分类轨道 + 最新收录）、找片看（两级分类浏览）与搜索（本地全文 + 在线检索、历史记录），卡片或片名直接打开独立播放窗。
- **播放窗口**：独立无边框窗口，ArtPlayer + hls.js 播放 m3u8；右侧面板切换剧集 / 简介，集名自动解析成集号、日期与「上 / 下 / 加更」等标记，支持线路切换、倍速、画中画、自动连播与原生全屏；固定深色、跟随主窗口强调色。
- **控制台**：概览、站点、分类、采集、进度、视频、推荐、封面、共享、容量、备份、日志十二个分区。
- **站点与分类**：站点支持 XML / JSON、显示名、备注、在线检索开关与禁用；本地分类支持多级层级、拖动排序与显示隐藏，在线分类可拖拽绑定到本地分类。
- **采集**：全量 / 增量 / 检索三种模式，可手动、定时（按间隔或每天固定时间）或由在线检索触发；跨站并发 1–4，同一站点串行，暂停后可继续；可选同时缓存详情。
- **推荐与封面**：海报、分类轨道与搜索推荐分开配置，轨道可选 TOP N 或自定义列表并支持拖动排序；封面可设默认来源、预览同步前后对比并批量重写。
- **视频库**：按分类、关键词、显示状态筛选；片名 / 备注 / 主演 / 简介 / 封面可人工编辑，也可隐藏或加入推荐位。
- **局域网影院**：一键把片库发布到局域网，手机或电脑浏览器直接浏览、搜索与播放。
- **MCP 服务**：在「设置 › MCP」开启后，Claude、Cursor 等 AI 客户端可通过 Streamable HTTP 管理站点、分类、采集、推荐、共享、备份、网络、下载等 78 项操作；默认只监听本机，监听局域网需设置访问令牌。
- **数据与备份**：站点、分类、绑定与计划存 SQLite，视频缓存独立存放；支持 JSON 备份、导出、校验与整库恢复。
- **应用外壳**：无边框窗口与自绘操作栏、托盘、全局快捷键、深浅主题与 9 种强调色、启动偏好（默认首页 / 窗口大小）与应用内更新。

## 快速开始

环境要求：Node.js 22+、pnpm 12（仓库只有 `pnpm-lock.yaml`，请勿混用 npm / yarn）。

```bash
pnpm install   # postinstall 会下载 Electron 并重建应用依赖
pnpm dev       # 启动开发环境（主进程 / 预加载改动会自动重启）
```

## 常用命令

| 命令                | 作用                                                                        |
| ------------------- | --------------------------------------------------------------------------- |
| `pnpm dev`          | 开发模式，HMR                                                               |
| `pnpm lint`         | ESLint（`eslint --cache .`）                                                |
| `pnpm typecheck`    | 主进程 / 预加载 + 渲染层两套 tsconfig 类型检查                              |
| `pnpm build`        | typecheck 后执行 `electron-vite build`，产物在 `out/`                       |
| `pnpm build:win`    | 出 Windows 安装包（`pnpm build:mac` / `build:linux` 同理）                  |
| `pnpm build:unpack` | 只出免安装目录（`dist/win-unpacked`、`dist/mac`、`dist/linux-unpacked` 等） |
| `pnpm format`       | Prettier 格式化                                                             |

没有测试套件；验证门槛是 `pnpm lint && pnpm build`（CI 在 Node 22 / pnpm 12.15.0 上先 lint 再 build）。

`build:win` / `build:mac` / `build:linux` 需要在本机对应系统上执行（安装包不能跨平台出）；CI 的 Release 工作流已经按平台拆成四个 job。

## 目录结构

```
src/main        主进程：窗口、托盘、快捷键、站点 / 分类 / 推荐 / 备份存储、视频缓存与采集、局域网服务、MCP 服务、自动更新
src/main/mcp    MCP Streamable HTTP 服务、配置校验与按域分组的工具注册
src/preload     contextBridge 暴露的 API，渲染层类型见 src/preload/api.d.ts
src/renderer    React 应用（@renderer/* 指向 src/renderer/src）
src/lanweb      局域网影院的网页端（纯浏览器 JS，由主进程内联提供）
build/          打包资源：图标源文件与各平台图标
resources/      运行时窗口 / 托盘图标
docs/           采集接口、视频缓存、MCP 与播放器调研文档
out/            electron-vite 产物（git 忽略）
dist/           electron-builder 产物（git 忽略）
```

IPC 接口新增要改三处：主进程 `handleIpc`（内部会同时注册到 `ipcMain`，MCP 工具复用同一份 handler）、`src/preload/index.ts` 的 `ipcRenderer.invoke`、`src/preload/api.d.ts` 里手写的 `Api` 类型。渲染层只允许通过 `window.api` / `window.electron` 访问。

## 设置与本地数据

- 应用设置存 `app.getPath('userData')/app-settings.json`（Windows 为 `%APPDATA%\cine-box\app-settings.json`），明文 JSON，没有用 electron-store。

| 字段                 | 含义                                                                | 默认值                 |
| -------------------- | ------------------------------------------------------------------- | ---------------------- |
| `openAtLogin`        | 开机自启，以系统登录项为准，每次读取都回读系统                      | `false`                |
| `closeToTray`        | 关闭窗口时最小化到托盘，而不是退出                                  | `false`                |
| `autoDownload`       | 检测到新版本后自动下载                                              | `true`                 |
| `showShortcut`       | 全局快捷键，空字符串表示未启用                                      | `Ctrl+Shift+Space`     |
| `startView`          | 默认首页：`home`（推荐）/ `search`（搜索视频）                      | `home`                 |
| `windowSize`         | 启动时窗口大小：`medium` / `large` / `xlarge`（适中 / 大屏 / 超大） | `large`                |
| `defaultPicSiteId`   | 采集时优先用哪个站点的封面，空串表示不指定                          | `''`                   |
| `collectConcurrency` | 同时采集的站点数，1–4                                               | `2`                    |
| `mcp`                | MCP 服务：`enabled` / `host` / `port` / `token`                     | 关闭，`127.0.0.1:3927` |

- 外观偏好存在渲染层 `localStorage`：`theme`（`system` / `light` / `dark`）与 `accent`（强调色 key）。
- 控制台站点存 `app.getPath('userData')/Data/cine-box.db`（SQLite，`sites` 表，WAL 模式），新增时由主进程生成 32 位 UUID（UUID 去掉横线）与 ISO 8601 创建 / 更新时间；字段缺失或手工改坏时按默认值兜底。在线分类存 `site_categories` 表，通过 `site_id` 关联站点，同样带 32 位 ID 与创建 / 更新时间；打开分类弹窗直接读库（没有数据时才抓取 `ac=list` 并入库），「重新获取」会对比出新增 / 改名 / 消失的分类，由用户选择增量（保留消失项）或全量（以本次结果为准）更新。
- 本地视频分类存同一个库的 `video_categories` 表（`parent_id` 自引用表达层级，`sort_order` 表示同级顺序，`visible` 表示是否在展示端显示），与站点数据共用一个连接（`src/main/database.ts`）。旧库启动时会自动补 `visible` 列（默认 1）。删除分类会连带删除整棵子树，同级不允许重名；拖拽移动时主进程负责换算新的上级与位置，并拒绝把分类移到自己的子孙下面。隐藏只影响展示端，管理页始终能管理全部分类；父分类隐藏时后代在展示端一并隐藏，但各自的 `visible` 值不变，父分类重新显示后各自恢复。
- 在线分类与本地分类的绑定存 `category_bindings` 表，唯一键是 `(site_id, site_category_id)`：一个站点的某个在线分类最多归到一个本地分类，一个本地分类可以收多个站点、多个在线分类。表里不存在线分类名，读取时 join `site_categories` / `video_categories` 拿最新名称与路径；删站点、全量更新删掉在线分类、删本地分类（含子树）都会通过外键级联清掉绑定（连接上开了 `PRAGMA foreign_keys = ON`）。
- 视频缓存单独存 `userData/Data/video-cache.db`（`videos` / `video_sources` / `videos_fts` / `collect_progress` / `collect_logs` / `cache_sites` 等表），详情 JSON 落在 `userData/Data/videos/<siteId>/`；推荐配置存 `userData/Data/Home/home.json`，备份文件在 `userData/Data/Backups`，局域网配置在 `userData/Data/Lan/config.json`。

## 自动更新

应用内更新走 `electron-updater`，更新源是 `electron-builder.yml` 里 `publish` 指向的 GitHub Releases（`0x2one/cine-box`）。

- 启动 5 秒后检查一次，之后每 4 小时轮询；只有**已发布**的 Release 会被检测到，草稿对客户端不可见。
- 是否自动下载由「偏好设置 - 自动下载更新」控制；下载完成后可立即重启安装，正常退出时也会自动安装。

开发模式下更新检查默认关闭，需要联调时：

```bash
# Windows PowerShell
$env:CINEBOX_DEV_UPDATE='1'; pnpm dev
# macOS / Linux
CINEBOX_DEV_UPDATE=1 pnpm dev
```

此时「关于 → 软件更新」会真实请求 GitHub Releases（配置见 `dev-app-update.yml`）。

平台限制：

- **Windows**：NSIS 安装包支持增量更新；安装包未签名，首次运行会触发 SmartScreen 提示。
- **macOS**：自动更新需要 `zip` 产物 + 代码签名；当前 `notarize: false`，可以打包但 Squirrel.Mac 无法自动安装更新。
- **Linux**：只有 AppImage 支持自更新，deb 需手动升级。

国内网络打包时若卡在下载 Electron / electron-builder 二进制资源，可补镜像环境变量：

```bash
# Windows PowerShell
$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'
```

## 发布流程

打包与发布由 GitHub Actions 完成：

| 工作流                                                           | 触发                       | 作用                                                                           |
| ---------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------ |
| [`.github/workflows/ci.yml`](.github/workflows/ci.yml)           | push 到 `master`、PR、手动 | 安装依赖、lint、typecheck + 生产构建                                           |
| [`.github/workflows/release.yml`](.github/workflows/release.yml) | 推送 `v*` 标签、手动       | 四平台打包并上传到 GitHub Releases **草稿**，再用 CHANGELOG 填好草稿标题与说明 |

发版（完整清单见 [`.agents/skills/cine-box-release/SKILL.md`](.agents/skills/cine-box-release/SKILL.md)）：

1. 在 [`CHANGELOG.md`](CHANGELOG.md) 顶部新增 `## 映盒剧场 vX.Y.Z` 小节；
2. 把 `package.json` 的 `version` 改成同一版本；
3. 提交后打标签：`git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z`；
4. CI 的 guard job 校验「标签 = `package.json` 版本」且 CHANGELOG 小节存在，四平台全绿后生成草稿 Release；
5. 确认产物齐全后人工发布：`gh release edit vX.Y.Z --draft=false -R 0x2one/cine-box`。

草稿是有意为之：四个平台并发上传时，`publish.releaseType: release` 会被拆成多条同 tag 的 Release。

产物命名统一为 `cine-box-<version>-<platform>-<arch>.<ext>`：

| 文件                                                 | 说明                                      |
| ---------------------------------------------------- | ----------------------------------------- |
| `cine-box-<ver>-win-x64.exe`                         | Windows NSIS 安装包                       |
| `cine-box-<ver>-mac-x64.dmg` / `.zip`                | Intel                                     |
| `cine-box-<ver>-mac-arm64.dmg` / `.zip`              | Apple Silicon（`zip` 是自动更新必需产物） |
| `cine-box-<ver>-linux-x86_64.AppImage`               | Linux                                     |
| `cine-box-<ver>-linux-amd64.deb`                     | Linux                                     |
| `latest.yml` / `latest-mac.yml` / `latest-linux.yml` | 自动更新索引，文件名固定不可改            |

## 品牌资源

Logo 源文件为 [`build/icon.svg`](build/icon.svg)，`src/renderer/src/assets/logo.svg` 是同一份副本，供界面直接引用；改 Logo 时两者与下面的图标要一起更新。

| 文件                               | 用途                                                 |
| ---------------------------------- | ---------------------------------------------------- |
| `build/icon.png`                   | 1024×1024 母版 PNG                                   |
| `build/icon.ico`                   | Windows 窗口 / 任务栏 / 安装包图标，含 16–256 多尺寸 |
| `build/icon.icns`                  | macOS 应用图标，含 16–1024                           |
| `resources/icon.png`               | 运行时窗口与托盘图标（512×512）                      |
| `src/renderer/src/assets/logo.svg` | 渲染进程内的 Logo（`index.html` 站点图标也用它）     |

图形结构：蓝色圆角方框（`#1296db`）+ 白色实心六边形（`#ffffff`）+ 蓝色 `TV` 字标，四角透明。换色时改 SVG 里的 `fill`（第一个 `path` 是白色六边形底衬，后两个是蓝框和字标）。

出图留白：Windows / Linux 用的 `icon.png`、`icon.ico` 和 `resources/icon.png` 按满幅渲染（四周约 0.5% 留白），避免在任务栏、标题栏里比别的图标显小；macOS 的 `icon.icns` 保留约 6% 留白，符合 Dock 观感。

## 其它文档

- [`AGENTS.md`](AGENTS.md)：工程约定（命令、目录、IPC、窗口与主题的坑、发版约束）。
- [`CHANGELOG.md`](CHANGELOG.md)：版本变更记录，同时作为 Release 说明与客户端更新说明。
- [`docs/采集接口参数说明.md`](docs/采集接口参数说明.md)：XML 采集接口的参数说明，解析与采集实现在 `src/main/video-collect-parser.ts`、`video-collector.ts`。
- [`docs/MCP.md`](docs/MCP.md)：MCP 服务的开启、客户端配置、安全说明与 78 个工具的参数目录。
- [`docs/迭代待办计划.md`](docs/迭代待办计划.md)：迭代方向、任务拆分、优先级、验收标准与决策记录。

## License

[MIT](LICENSE)
