# cine-box

An Electron application with React and TypeScript

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)

## Project Setup

### Install

```bash
$ pnpm install
```

### Development

```bash
$ pnpm dev
```

### Build

```bash
# For windows
$ pnpm build:win

# For macOS
$ pnpm build:mac

# For Linux
$ pnpm build:linux
```

## 品牌资源（Logo / 图标）

Logo 源文件为 `build/icon.svg`，同一份副本放在 `src/renderer/src/assets/logo.svg`，供界面内直接引用。

| 文件                               | 用途                                                 |
| ---------------------------------- | ---------------------------------------------------- |
| `build/icon.png`                   | 1024×1024 母版 PNG                                   |
| `build/icon.ico`                   | Windows 窗口 / 任务栏 / 安装包图标，含 16–256 多尺寸 |
| `build/icon.icns`                  | macOS 应用图标，含 16–1024                           |
| `resources/icon.png`               | 运行时窗口图标（512×512），开发模式与 Linux 使用     |
| `src/renderer/src/assets/logo.svg` | 渲染进程内的 Logo（`index.html` 站点图标也用它）     |

图形结构：蓝色圆角方框（`#1296db`）+ **白色实心六边形**（`#ffffff`）+ 蓝色 `TV` 字标，四角透明。
换色时改 SVG 里的 `fill` 即可（第一个 `path` 是白色六边形底衬，后两个是蓝框和字标）。

出图留白：Windows / Linux 用的 `icon.png`、`icon.ico` 和 `resources/icon.png` 按满幅渲染（四周约 0.5% 留白），
避免在任务栏、标题栏里比别的图标显小；macOS 的 `icon.icns` 保留约 6% 留白，符合 Dock 的观感。

## 发布与自动更新

打包与发布交给 GitHub Actions：

| 工作流                          | 触发                                | 作用                                                                           |
| ------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------ |
| `.github/workflows/ci.yml`      | push 到 `master` / `main`、PR、手动 | 安装依赖、lint、typecheck + 生产构建                                           |
| `.github/workflows/release.yml` | 推送 `v*` 标签、手动                | 四平台打包并上传到 GitHub Releases **草稿**，再用 CHANGELOG 填好草稿标题与说明 |

发版步骤（完整清单见 [`.agents/skills/cine-box-release/SKILL.md`](.agents/skills/cine-box-release/SKILL.md)）：

1. 在 [`CHANGELOG.md`](CHANGELOG.md) 顶部新增 `## 映盒剧场 vX.Y.Z` 小节；
2. 修改 `package.json` 的 `version` 为同一版本；
3. 提交后 `git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z`；
4. 工作流先校验「标签 = package.json 版本」且 CHANGELOG 小节存在，四平台全绿后产出草稿 Release；
5. 人工确认产物齐全后发布：`gh release edit vX.Y.Z --draft=false -R 0x2one/cine-box`。

产物命名统一为 `cine-box-<version>-<platform>-<arch>.<ext>`：

| 文件                                                 | 说明                                      |
| ---------------------------------------------------- | ----------------------------------------- |
| `cine-box-<ver>-win-x64.exe`                         | Windows NSIS 安装包                       |
| `cine-box-<ver>-mac-x64.dmg` / `.zip`                | Intel                                     |
| `cine-box-<ver>-mac-arm64.dmg` / `.zip`              | Apple Silicon（`zip` 是自动更新必需产物） |
| `cine-box-<ver>-linux-x86_64.AppImage`               | Linux                                     |
| `cine-box-<ver>-linux-amd64.deb`                     | Linux                                     |
| `latest.yml` / `latest-mac.yml` / `latest-linux.yml` | 自动更新索引，文件名固定不可改            |

应用内更新由 `electron-updater` 读取 `electron-builder.yml` 的 `publish`（GitHub `0x2one/cine-box`），
因此 Release 必须是**已发布**状态（草稿检测不到），且仓库为公开仓库。草稿是有意为之：
四个平台并发上传时，`releaseType: release` 会被拆成多条同 tag 的 Release。

本地联调更新流程（开发模式默认禁用更新检查）：

```bash
# Windows PowerShell
$env:CINEBOX_DEV_UPDATE='1'; pnpm dev
# macOS / Linux
CINEBOX_DEV_UPDATE=1 pnpm dev
```

此时「关于 → 软件更新」会真实请求 GitHub Releases（配置见 `dev-app-update.yml`）。

国内网络打包时，若卡在下载 Electron 或 electron-builder 的二进制资源，可补一个镜像环境变量：

```bash
# Windows PowerShell
$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'
```

平台说明：

- Windows：NSIS 安装包支持增量更新；未签名会触发 SmartScreen 提示。
- macOS：自动更新需要 `zip` 产物 + 代码签名；当前未配置证书（`notarize: false`），可以打包但 Squirrel.Mac 无法自动安装。
- Linux：只有 AppImage 支持自更新，deb 需手动升级。
