# Server Exe Console Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Upgrade the service executable window into a practical Windows deployment console with persistent port settings.

**Architecture:** Keep Electron as the service host. Extract configuration and HTML rendering into small CommonJS modules that can be tested from Vitest, while `main.cjs` handles Electron IPC, filesystem actions, and server startup.

**Tech Stack:** Electron 42, Node 24, Express, built-in `node:sqlite`, Vitest, CommonJS helper modules.

---

### Task 1: Runtime Config

**Files:**
- Create: `apps/server-exe/serverRuntimeConfig.cjs`
- Test: `src/server/serverExeRuntimeConfig.test.ts`

**Steps:**
1. Write failing tests for default port, saved port, environment override, invalid ports, and save output.
2. Run `npm test -- --run src/server/serverExeRuntimeConfig.test.ts` and confirm failure.
3. Implement config load/save helpers.
4. Re-run the focused test and confirm pass.

### Task 2: Console HTML View

**Files:**
- Create: `apps/server-exe/serverConsoleView.cjs`
- Test: `src/server/serverExeConsoleView.test.ts`

**Steps:**
1. Write failing tests that the HTML contains service status, port input, restart button, URL actions, and directory actions.
2. Run focused test and confirm failure.
3. Implement HTML renderer with inline CSS and client-side IPC calls.
4. Re-run focused test and confirm pass.

### Task 3: Electron Main Integration

**Files:**
- Modify: `apps/server-exe/main.cjs`

**Steps:**
1. Wire config helpers into startup so saved port controls `process.env.PORT`.
2. Add IPC handlers for saving port, saving and restarting, opening URLs, and opening directories.
3. Preserve existing data/backups/logs behavior and service restart behavior.
4. Re-run focused tests.

### Task 4: Package Script and Docs

**Files:**
- Modify: `scripts/serverExePackage.mjs`
- Modify: `src/server/serverExePackage.test.ts`
- Modify: `docs/deploy-windows-lan.md`
- Modify: `docs/desktop-client-admin-guide.md`
- Modify: `docs/verification.md`

**Steps:**
1. Update package layout test to include new helper files.
2. Copy helper files into `resources/app`.
3. Update docs for `server-config.json`, port setting, and save/restart behavior.
4. Run package layout test.

### Task 5: Verification

**Commands:**
- `npm test`
- `npm run build`
- `npm run server:exe`
- Start packaged exe on temporary port and check `http://127.0.0.1:<port>/health`

**Expected:** all commands pass and no temporary exe process remains.
