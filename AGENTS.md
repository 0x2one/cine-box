# AGENTS.md

映盒剧场 (cine-box) — Electron desktop app built with electron-vite, React 19, TypeScript, antd 6 and Tailwind v4. The UI is Simplified Chinese only; comments and UI strings are Chinese.

## Commands

pnpm only (`pnpm-lock.yaml`, CI runs `--frozen-lockfile`):

```bash
pnpm install     # postinstall downloads Electron and rebuilds app deps
pnpm dev
pnpm lint        # eslint --cache .
pnpm typecheck   # typecheck:node + typecheck:web
pnpm build       # typecheck, then electron-vite build → out/
pnpm format      # prettier --write .
pnpm build:win   # also build:mac / build:linux → dist/
```

There is no test suite or test runner. The verification gate is `pnpm lint && pnpm build` (CI does lint, then build, on Node 22 / pnpm 12.15.0).

## Layout

- `src/main` — main process: window, tray, global shortcut, settings, site store, updater; entry `src/main/index.ts`.
- `src/preload` — contextBridge API; renderer-facing types in `src/preload/api.d.ts`.
- `src/renderer/src` — React app; `@renderer/*` alias points here (also configured in `tsconfig.web.json`).
- `out/` is electron-vite output, `dist/` is electron-builder output; neither is source.

Typechecking is split: `tsconfig.node.json` covers `src/main` + `src/preload`, `tsconfig.web.json` covers the renderer plus `src/preload/*.d.ts`. The root `tsconfig.json` only references those two, so `tsc` alone proves nothing.

## IPC contract

Adding a channel takes three edits: `ipcMain.handle` in main, `ipcRenderer.invoke` in `src/preload/index.ts`, and the hand-written global `Api` types in `src/preload/api.d.ts`. Renderer code only ever uses `window.api` / `window.electron`.

## Window and renderer gotchas

- Frameless (`frame: false`) on Windows/Linux, `hiddenInset` + traffic lights on macOS; `TitleBar.tsx` draws its own window buttons only off macOS.
- Windows double-click-to-maximize is implemented in main with `hookWindowMessage` (drag regions don't emit DOM dblclick). Its hit test hard-codes a 44px title bar, 150px brand zone and 222px actions zone — keep those in sync with any `TitleBar` layout change.
- Theme is dual-track: `applyAppearance()` in `theme/appearance.ts` writes `data-theme` and CSS vars on `<html>` before first paint, and `ThemeProvider.tsx` maps the same palette into antd tokens. Style with the existing `--bg` / `--surface` / `--text` / `--accent` vars, not hard-coded colors, or one theme will break.
- Tailwind's `dark:` variant is rebound to `[data-theme='dark']` in `assets/main.css`, not the default `.dark` class.
- CSP in `src/renderer/index.html` is `default-src 'self'`; do remote HTTP in the main process over IPC, not `fetch` in the renderer. The one exception is `img-src`, which also allows `https:` / `http:` so the 视频 page can paint source cover images directly (with `referrerPolicy="no-referrer"` and a letter placeholder when a cover fails).
- Closing the window only quits when `isQuitting` is set; `closeToTray` also controls the tray icon and the `window-all-closed` behavior.

## Persistence and updates

- Settings are a plain JSON file at `app.getPath('userData')/app-settings.json` handled by `src/main/app-settings.ts` (no electron-store). `openAtLogin` is re-read from the OS on every read because users can change it outside the app.
- Console sites live in a SQLite database at `app.getPath('userData')/Data/cine-box.db` (the `sites` and `site_categories` tables), opened with Node's built-in `node:sqlite` (`DatabaseSync`, WAL mode) in `src/main/site-store.ts`. The main process assigns the id (`randomUUID()` with dashes stripped) and the ISO timestamps; the renderer only submits name/display/address/format/remark for add/update, and `updatedAt` is refreshed only by `sites:update`. Opening the category dialog returns stored rows and only fetches `ac=list` when the site has none; 「重新获取」 diffs the response against the DB and, after the user picks a mode, applies it incrementally (add/rename only) or fully (also deletes rows missing from the response). Rows are unique per `site_id` + `source_id`, and deleting a site deletes its categories. Back up `-wal` / `-shm` sidecar files together with the `.db`.
- Local video categories live in the same database (`video_categories`: self-referencing `parent_id`, `sort_order` for sibling order, `visible` for whether the category shows on the display side) and are handled by `src/main/category-store.ts`. Both stores share one connection through `src/main/database.ts` (`openDatabase` / `closeDatabase` / `inTransaction`) — do not open a second `DatabaseSync` for the same file. Sibling names must be unique, deleting a category deletes its whole subtree, and `categories:move` takes `(id, targetId, placement)` so the main process — not the renderer — works out the new parent and index; moving a category under its own descendant is rejected (`CYCLE`). Databases created before `visible` existed are migrated in `init()` via `pragma_table_info` + `ALTER TABLE ... ADD COLUMN visible INTEGER NOT NULL DEFAULT 1`, so keep that migration idempotent. `categories:setVisible` only flips the category's own flag and bumps `updated_at` when the value actually changes; hiding is display-side only: the management tree always lists every category, and a hidden parent hides its descendants at read time (renderer `visibleCategoryIds`) without rewriting the children's flags, so re-showing the parent restores each child's own state. Binding and parent selection intentionally ignore `visible`.
- Bindings live in `category_bindings` (`src/main/binding-store.ts`), keyed by `UNIQUE (site_id, site_category_id)` — N:1, so one online category belongs to at most one local category. No names are denormalised: reads join `site_categories` / `video_categories`. The connection sets `PRAGMA foreign_keys = ON`, and cleanup relies on `ON DELETE CASCADE` from `sites`, `site_categories` and `video_categories`, so any new table referencing those must declare cascades or deleting a site/category will leave orphans. `bindings:bind` re-derives `site_id` from `site_categories` and rejects a mismatched pair (`INVALID_INPUT`); binding is upserted so rebinding keeps the row id and only bumps `updated_at` when the target changes.
- Backups live next to the database in `userData/Data/Backups`, written as plain JSON by `src/main/backup-store.ts` (format marker `cine-box-backup`, version 2; version 1 files are still readable and restore with no schedules, camelCase copies of all five business tables). `backup:create` snapshots the DB and refuses to write an empty file; `backup:export` copies a record out through the save dialog so it can be shared; `backup:pick` parses a custom file and returns counts without writing, and `backup:restore` accepts either `{ id }` or `{ path }`. Restore is a full replace in one transaction — it validates every row and reference (ids unique, `site_categories.site_id` and bindings' `site_category_id`/`video_category_id` resolvable, category parents acyclic, schedule sites present), deletes the five tables in FK order, then inserts sites → site categories → categories sorted by depth → bindings → schedules, and it always writes a `-auto` safety backup of the current data first. Any new table must be added to `readState` / `parseBackup` / `applyState` and to `BackupCounts`, or backups silently lose it.
- The binding UI is renderer-only: `Console.tsx` lifts `bindingSite` and switches to 分类, `Categories.tsx` renders two columns (`BindingWorkspace.tsx` on the right) and binds on drop. rc-tree's `TreeNode` calls `preventDefault()` + `stopPropagation()` on `dragover` / `drop`, so an external drag (the online category list) must be handled by native capture-phase listeners on the wrapper — React `onDragOver` on the wrapper never fires. Bind targets are resolved from `data-category-id` on the row, and the internal reorder drag is left to rc-tree (its `onDrop` bails when `dragNode` is missing). In binding mode `.category-body.is-binding` is exactly `calc(100vh - 144px)` tall (标题栏 + `settings-panel-head`, then the page's 44px bottom padding) with `grid-template-rows: minmax(0, 1fr)`, so both columns are always the same height and scroll inside themselves while the page never scrolls: the left tree card fills its column (`.category-body-main` is a flex column) and the right column is a flex column with a non-scrolling `.workspace-head` whose description doubles as the drag hint, `.workspace-groups` being the scroller whose group titles are `position: sticky`. The local category tree starts collapsed and auto-expands only while binding mode is on (an `expandedMode` ref re-applies the policy only when the mode flips, so manual toggles survive normal edits).
- `electron-updater` is disabled unless packaged. To exercise it in dev: PowerShell `$env:CINEBOX_DEV_UPDATE='1'; pnpm dev` (else `CINEBOX_DEV_UPDATE=1 pnpm dev`), which reads `dev-app-update.yml`. Draft releases are invisible to the updater.

## Release

Use the `.agents/skills/cine-box-release` skill for 发版. Constraints the CI `guard` job enforces:

- Git tag `vX.Y.Z` must equal `package.json` `version`.
- `CHANGELOG.md` must contain the exact heading `## 映盒剧场 vX.Y.Z`; that section becomes both the GitHub release notes and the in-app update notes.

Tag push builds four platforms and uploads to a **draft** Release; publishing is a manual `gh release edit vX.Y.Z --draft=false`. Do not set `publish.releaseType: release`, rename `latest*.yml` / `*.blockmap`, or build both macOS arches in one job (see the skill for why).

Both macOS jobs write the same `latest-mac.yml`, so they hand their copy to the `mac-index` job, which merges both arches into one `files` list (`scripts/merge-mac-update-index.mjs`) and replaces the file on the draft. Without that step `latest-mac.yml` lists only the arch that finished last, and `MacUpdater.filterFilesForArch` makes Apple Silicon install the Intel build. Keep the merged index in mind when changing the macOS matrix.

## Conventions

- Branch `master`; Conventional Commits, e.g. `feat(updater): ...`, `fix(renderer): ...`, `chore: release v1.0.1`.
- Prettier: no semicolons, single quotes, print width 100.
- `build/icon.svg` is the brand source; keep `src/renderer/src/assets/logo.svg`, `build/icon.{png,ico,icns}` and `resources/icon.png` in sync when it changes.
- `docs/采集接口参数说明.md` documents an external XML collection API; `src/main/video-collect-parser.ts` and `src/main/video-collector.ts` implement it.
- Video cache is a separate `userData/Data/video-cache.db` (never the business DB): `videos` / `video_sources` / `videos_fts` / `collect_progress` / `collect_logs` / `cache_sites`. Detail bodies are JSON files under `userData/Data/videos/<siteId>/<safeSourceVideoId>.json`; SQLite only stores the `video_sources.detail_*` index. `src/main/video-cache-store.ts` owns the connection, `video-detail-cache.ts` reads index-first and fetches on miss, and `video-collector.ts` runs a single in-memory queue shared by manual and scheduled runs. `collect_schedules` lives in the business DB so `videos:clear` keeps schedules; `collect_logs` and progress are cleared with the cache. Adding/removing a site cancels its collection and removes its cache rows and detail directory. Collection only writes the list index unless `cacheDetail` is set (manual 采集 or the schedule's `cache_detail`): the collector then calls `details.warm()` per page, which fills missing/stale detail files and never fails the run. `cache_detail` is a later addition to `collect_schedules`, migrated idempotently in `collect-schedule-store.init()` via `pragma_table_info`; backups without the field restore as off. 控制台「视频」页 (`Videos.tsx`) is an antd `List` (`itemLayout="vertical"`, cover in `extra`) over that cache: `videos:list` takes `page`/`pageSize` (10 per page, total from a second COUNT query) plus `keyword` and `visibility` (`all` / `shown` / `hidden`), and `videos:detail` fills the drawer (sources + play lines) and the edit modal's cover choices. The list handler enriches every row with `localCategoryPaths`, resolved from `category_bindings` via `bindingStore.pathsForSourceCategories()` plus `videoStore.listSourceCategories()`, so the meta line can show the bound local category alongside the raw `vod_class`. Row spacing is overridden in `main.css` with `.video-list .ant-list-items .ant-list-item …` selectors: antd's `.ant-list-vertical .ant-list-item .ant-list-item-meta` is three classes deep and sets a 16px bottom margin plus a 16px/1.5 title, which otherwise leaves the 来源 line floating far from both the title and the intro. Edits live in `video_edits` (same cache DB, one row per video): NULL columns mean "use the collected value", `hidden` defaults to 0 = visible on the display side. `videos:update` only writes the fields it is given, rejects a `pic` that is not one of that video's source pics (`INVALID_PIC`), and an empty string clears the override; the name is a merge key and is intentionally not editable. `listVideos` / `getVideoDetail` read through `COALESCE(e.*, v.*)` so overrides survive collection (`recomputeVideo` only touches `videos`). A `video_edits` row is deleted when the video is deleted, and `videos:clear` rebuilds the cache DB, which drops edits along with the rest of the cache.
