# Electron Client Server Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build V5 as an Electron desktop client that packages the existing React approval workbench and connects to the existing LAN Express server through a configurable server URL.

**Architecture:** Keep the server as the single source of truth for SQLite, Nutstore watching, PDF signing, permissions, logs and backup. Add a small client configuration layer to the React app so web mode uses same-origin relative URLs while Electron mode uses a saved LAN server base URL. Add `apps/desktop-client` as a thin Electron shell with a safe preload bridge and no direct business-data access.

**Tech Stack:** Node 24, TypeScript, React/Vite, Express, Vitest, Electron.

---

## Current Facts

- Workspace is not a Git repository; skip commit steps and record verification instead.
- Existing Tauri tray helper is not V5 mainline.
- Backend already exposes `/api/tray/summary` and desktop CORS for local app origins.
- Existing frontend API calls use relative URLs and must be made configurable for Electron.

## Task 1: Add Client API Base Configuration

**Files:**
- Create: `src/client/clientConfig.ts`
- Create: `src/client/clientConfig.test.ts`
- Modify: `src/client/api.ts`
- Modify: `src/client/api.test.ts`
- Modify: `src/client/pages/ApprovalDetailPage.tsx`
- Modify: `src/client/pages/SettingsPage.tsx`

**Steps:**

1. Write tests for normalizing server URLs and converting API paths to either relative paths or absolute server URLs.
2. Verify those tests fail because the module does not exist.
3. Implement `normalizeServerBaseUrl`, `setServerBaseUrl`, `getServerBaseUrl`, `apiUrl`, and `isDesktopClient`.
4. Update `api.ts` request helpers and file URL helpers to use `apiUrl`.
5. Replace direct `fetch("/health")` and direct approval file URL construction with `apiUrl`.
6. Run targeted tests.

## Task 2: Add Connection Setup UI

**Files:**
- Create: `src/client/pages/ServerConnectionPage.tsx`
- Create: `src/client/pages/ServerConnectionPage.test.ts`
- Modify: `src/client/App.tsx`
- Modify: `src/client/pages/LoginPage.tsx`
- Modify: `src/client/styles.css`

**Steps:**

1. Write tests for connection state behavior where desktop mode without a saved server URL shows setup instead of login.
2. Verify tests fail.
3. Add a small connection setup page with server URL input, health check, save, and retry.
4. In `App`, gate unauthenticated desktop mode through the setup page before login.
5. Add a compact server address editor to the login page for later changes.
6. Run targeted tests and build.

## Task 3: Add Electron Desktop Client Shell

**Files:**
- Create: `apps/desktop-client/package.json`
- Create: `apps/desktop-client/main.cjs`
- Create: `apps/desktop-client/preload.cjs`
- Create: `apps/desktop-client/desktopConfig.cjs`
- Create: `apps/desktop-client/desktopConfig.test.cjs`
- Modify: `package.json`

**Steps:**

1. Write tests for `normalizeServerUrl`, config read/write, and renderer URL resolution.
2. Verify tests fail.
3. Implement config helpers using `app.getPath("userData")` through dependency injection for tests.
4. Implement Electron `BrowserWindow` with `contextIsolation: true`, `nodeIntegration: false`, and preload.
5. Preload exposes `getServerUrl`, `setServerUrl`, `clearServerUrl`, and `getAppVersion`.
6. Add scripts: `desktop:dev`, `desktop:test`, `desktop:build`, `desktop:package`.

## Task 4: Install Electron Dependency and Verify

**Files:**
- Modify: root `package.json`
- Modify: root `package-lock.json`

**Steps:**

1. Install Electron as a dev dependency with the mirror registry if needed.
2. Run `npm run desktop:test`.
3. Run `npm test`.
4. Run `npm run build`.
5. Run `npm run desktop:dev` to verify the Electron window opens.

## Task 5: Update Deployment Documents

**Files:**
- Modify: `docs/deploy-windows-lan.md`
- Create: `docs/desktop-client-user-guide.md`
- Create: `docs/desktop-client-admin-guide.md`
- Modify: `docs/verification.md`

**Steps:**

1. Document Electron as the V5 mainline.
2. Mark the Tauri tray helper as deprecated or optional.
3. Add first-run server URL setup instructions.
4. Add deployment and rollback notes.
5. Record test/build/manual verification results.
