---
name: cine-box-release
description: Ships a cine-box (映盒剧场) GitHub Release — update CHANGELOG, bump version, push an annotated tag, wait for the four-platform draft build, then publish the draft. Use when the user asks to 发版, 发布, create a version like v1.0.1, 打 tag, or fix GitHub Release notes.
---

# cine-box（映盒剧场）发版

CI 只上传**草稿**（`electron-builder --publish always`，GitHub 的 `publish.releaseType` 保持默认 `draft`）。
`electron-updater` 只读已发布的 Release，所以正式发布必须在四平台全绿后手动执行
`gh release edit --draft=false`。草稿状态也让四个并发 job 始终更新同一条 Release。

默认下一版本：当前 [`package.json`](package.json) `version` 的 patch +1（如 `1.0.0` → `1.0.1`），除非用户指定。

## 流程

复制并勾选：

```
- [ ] CHANGELOG 顶部新增 ## 映盒剧场 vX.Y.Z
- [ ] package.json version 与标签一致（如 1.0.1 / v1.0.1）
- [ ] 提交并 push origin master
- [ ] annotated tag 推到 origin（触发 Release 工作流）
- [ ] Actions：Windows + macOS Intel + macOS Apple Silicon + Linux 全绿，`mac-index` job 也成功
- [ ] 核对产物文件名（见下方清单）与 latest*.yml
- [ ] `latest-mac.yml` 的 files 同时含 `mac-x64.zip` 和 `mac-arm64.zip`
- [ ] gh release edit vX.Y.Z --draft=false
```

**1. CHANGELOG** — [`CHANGELOG.md`](CHANGELOG.md)

- 没有 `## Unreleased`。在 `# Changelog` 导语之后、上一版本之前插入 `## 映盒剧场 vX.Y.Z`，
  与上一版本之间保留 `---` 分隔；紧跟一行 `> 发布时间：YYYY-MM-DD`。
- 内容取上次 tag 以来的**用户可见**改动，不要写 skills / AGENTS / 内部文档类改动。
- 结构：一句话摘要，然后 `### ✨ 新功能` / `### 🐛 修复`，按需再加 `### ⚙️ 构建与发布`。
- CI 会用这个版本的正文作为草稿 Release 说明；`electron-updater` 再把它当作客户端更新说明展示，
  所以这里不要写「内部重构」这类对用户无意义的内容。

**2. 版本号** — 只改根目录 [`package.json`](package.json) 的 `version`，标签与之对应。

**3. 提交** — 一条 commit，消息对齐仓库：`chore: release vX.Y.Z`。先看 `git status` / `git diff` / `git log`。

**4. 推送** — 用户说「发版 / 发布 vX.Y.Z」即授权 push `master` + 新 tag：

```bash
git push origin master
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

**5. 等 CI** — `gh run watch`，工作流名 `Release`（[`.github/workflows/release.yml`](.github/workflows/release.yml)）。
guard job 会校验 tag 与 `package.json` 版本、CHANGELOG 小节是否都存在；四个平台 job 都成功再发布。

**6. 发布草稿** — 标题与 notes 已由 CI 写入草稿，这里只放开草稿状态：

```bash
gh release edit vX.Y.Z --draft=false -R 0x2one/cine-box
```

若 CI 的 notes job 失败，用本地 notes 文件补一次（PowerShell 下 `--notes` 中文易乱码）：

```bash
gh release edit vX.Y.Z --draft=false --title "映盒剧场 vX.Y.Z" --notes-file <notes.md> -R 0x2one/cine-box
```

发完删掉临时文件，核对 `isDraft=false` 且产物齐全。

## 期望产物

| 文件                                                 | 说明                             |
| ---------------------------------------------------- | -------------------------------- |
| `cine-box-<ver>-win-x64.exe`                         | Windows NSIS 安装包              |
| `cine-box-<ver>-mac-x64.dmg` / `.zip`                | Intel，`macos-15-intel` 原生     |
| `cine-box-<ver>-mac-arm64.dmg` / `.zip`              | Apple Silicon，`macos-15` 原生   |
| `cine-box-<ver>-linux-x86_64.AppImage`               | Linux                            |
| `cine-box-<ver>-linux-amd64.deb`                     | Linux                            |
| `latest.yml` / `latest-mac.yml` / `latest-linux.yml` | 自动更新索引（名字固定，不要改） |

缺 Intel 或 arm64 的 dmg、两个 dmg 同名、缺 `latest*.yml`，视为失败，不要发布。

`latest-mac.yml` 由 `mac-index` job 把两个架构的索引合出来，`files` 里必须同时有
`mac-x64.zip` 和 `mac-arm64.zip`：只有 x64 时，`MacUpdater.filterFilesForArch` 会让
Apple Silicon 拿到 Intel 包（能装，但架构不对）。

## 禁止

- 不要把 [`electron-builder.yml`](electron-builder.yml) 的 `publish.releaseType` 改成 `release`：
  四平台并发上传会拆成多条同 tag Release。
- 不要在 workflow 里自动 `gh release edit --draft=false`。
- 不要在单个 macOS job 里跑 `--mac --x64 --arm64`（交叉编译且 dmg 的 arch 会互相覆盖）。
- 不要让两个 macOS job 直接把 `latest-mac.yml` 传上去：后上传的会覆盖前一个，索引里只剩一个架构；
  必须保留 `mac-index` job（合并脚本见 `scripts/merge-mac-update-index.mjs`）。
- 不要重写已有 tag，除非用户明确说清空旧 Release 并重打同一版本。
- 不要改 `latest*.yml` / `*.blockmap` 的文件名（`electron-updater` 依赖固定名字）。

## 配置锚点

- Workflow：[`.github/workflows/release.yml`](.github/workflows/release.yml) — tag `v*` 触发；
  matrix 四平台各跑 `electron-builder --publish always`（草稿）；两个 macOS job 另外把自己的
  `latest-mac.yml` 按架构存成 artifact，`mac-index` job 合并后覆盖回草稿 Release；
  末尾 notes job 用 CHANGELOG 填草稿；[`ci.yml`](.github/workflows/ci.yml) 在 push / PR 上跑 lint、typecheck、构建。
- 产物名：`nsis` / `mac` / `dmg` / `linux` 的 `artifactName` 统一为 `${name}-${version}-<platform>-${arch}.${ext}`。
- 发布源：`0x2one/cine-box`，仓库需为公开仓库；Electron 二进制走 `npmmirror`（`electronDownload.mirror`）。
- 本地联调更新：`CINEBOX_DEV_UPDATE=1 pnpm dev`，此时「关于 → 软件更新」会真实请求 GitHub Releases。
