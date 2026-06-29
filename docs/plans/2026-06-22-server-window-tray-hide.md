# Server Window Tray Hide Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Windows tray hiding behavior to the packaged service application.

**Architecture:** The Electron main process owns the tray icon, close interception, restore, and real quit path. The renderer only exposes a `隐藏窗口` button through preload IPC.

**Tech Stack:** Electron main/preload CommonJS, generated HTML console view, Vitest source and render tests, existing installer packaging scripts.

---

### Task 1: Console UI Entry

**Files:**
- Modify: `apps/server-exe/serverConsoleView.cjs`
- Test: `src/server/serverExeConsoleView.test.ts`

**Steps:**
- Add a failing test that expects `隐藏窗口`, `data-hide-window`, and `window.serverConsole.hideWindow()`.
- Run `npm test -- --run src/server/serverExeConsoleView.test.ts` and confirm failure.
- Add a `隐藏窗口` button to the service-status action row.
- Wire `[data-hide-window]` to `window.serverConsole.hideWindow()`.
- Re-run the test and confirm it passes.

### Task 2: Preload IPC

**Files:**
- Modify: `apps/server-exe/preload.cjs`
- Test: `src/server/serverExeMainWindow.test.ts`

**Steps:**
- Add source-level assertions that preload exposes `hideWindow`.
- Run the targeted test and confirm failure.
- Add `hideWindow: () => ipcRenderer.invoke("server-console:hide-window")`.
- Re-run the targeted test and confirm it passes.

### Task 3: Main-Process Tray Lifecycle

**Files:**
- Modify: `apps/server-exe/main.cjs`
- Test: `src/server/serverExeMainWindow.test.ts`

**Steps:**
- Add source-level assertions for `Tray`, `Menu`, close `preventDefault`, `mainWindow.hide()`, `isQuitting`, `显示服务端窗口`, `打开本机工作台`, `打开日志目录`, and `退出服务端`.
- Run the targeted test and confirm failure.
- Import `Tray`, `Menu`, and `nativeImage`.
- Create a tray icon during app startup.
- Intercept window `close` and hide unless `isQuitting` is true.
- Add `showMainWindow()`, `hideMainWindow()`, `quitFromTray()`, and `refreshTrayMenu()`.
- Register `server-console:hide-window`.
- Keep `window-all-closed` from quitting implicitly.
- Re-run the targeted test and confirm it passes.

### Task 4: Packaging Verification

**Files:**
- No source files.

**Steps:**
- Run `npm test -- --run src/server/serverExeConsoleView.test.ts src/server/serverExeMainWindow.test.ts src/server/serverExePackage.test.ts`.
- Run `npm run build`.
- Run `npm run installer:package`.
- List the new client/server installer paths, sizes, timestamps, and SHA256 hashes.
