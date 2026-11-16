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

- `src/main` — main process: window, tray, global shortcut, settings, updater; entry `src/main/index.ts`.
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
- CSP in `src/renderer/index.html` is `default-src 'self'`; do remote HTTP in the main process over IPC, not `fetch` in the renderer.
- Closing the window only quits when `isQuitting` is set; `closeToTray` also controls the tray icon and the `window-all-closed` behavior.

## Persistence and updates

- Settings are a plain JSON file at `app.getPath('userData')/app-settings.json` handled by `src/main/app-settings.ts` (no electron-store). `openAtLogin` is re-read from the OS on every read because users can change it outside the app.
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
- `docs/采集接口参数说明.md` documents an external XML collection API; no code consumes it yet.
