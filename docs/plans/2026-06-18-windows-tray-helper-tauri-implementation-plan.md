# Windows Tray Helper Tauri Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build V5 as a lightweight Tauri Windows tray helper that monitors the LAN PDF approval system, shows native reminders for reviewer tasks, and opens the existing Web workbench in the default browser.

**Architecture:** Keep the existing Express/React approval system as the source of truth. Add a small authenticated `/api/tray/summary` backend endpoint for tray polling, then add `apps/tray-helper` as a separate Tauri v2 sub-application with its own TypeScript front-end files and Rust `src-tauri` project. The tray helper stores local settings, polls HTTP APIs, deduplicates notifications by approval ID, and never reads SQLite, Nutstore folders, or PDF files directly.

**Tech Stack:** Node 24, TypeScript, Express, Vitest, Tauri v2, Rust stable `x86_64-pc-windows-msvc`, `@tauri-apps/api`, `@tauri-apps/plugin-notification`, `@tauri-apps/plugin-autostart`, `@tauri-apps/plugin-store`, `@tauri-apps/plugin-opener`.

---

## Current Environment Snapshot

Checked on 2026-06-18:

- `node --version`: `v24.15.0`
- `npm --version`: `11.12.1`
- `rustc --version`: `rustc 1.96.0`
- `cargo --version`: `cargo 1.96.0`
- Rust active toolchain: `stable-x86_64-pc-windows-msvc`
- Installed Rust target: `x86_64-pc-windows-msvc`
- WebView2 executable found: `C:\Program Files (x86)\Microsoft\EdgeWebView\Application\149.0.4022.69\msedgewebview2.exe`
- `cl` not found in current PowerShell PATH.
- `vswhere.exe` not found at `C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe`.

Implication: Node, Rust and WebView2 are present, but Microsoft C++ Build Tools are not confirmed. Before Tauri build work, install or repair Visual Studio Build Tools with the Desktop development with C++ workload, or open a Developer PowerShell that exposes `cl`.

This workspace is not currently a Git repository. Where a task says "commit", replace it with a checkpoint note unless the workspace is later placed under Git.

## Required References

- Design: `docs/plans/2026-06-18-windows-tray-helper-tauri-design.md`
- Research: `docs/plans/2026-06-18-windows-tray-helper-research.md`
- Deployment baseline: `docs/deploy-windows-lan.md`
- Tauri official system tray docs: `https://v2.tauri.app/learn/system-tray/`
- Tauri official notifications docs: `https://v2.tauri.app/plugin/notification/`
- Tauri official autostart docs: `https://v2.tauri.app/plugin/autostart/`
- Tauri official store docs: `https://v2.tauri.app/plugin/store/`
- Tauri official prerequisites docs: `https://v2.tauri.app/start/prerequisites/`

## Task 1: Add Tray Summary Service Tests

**Files:**
- Create: `src/server/services/traySummary.ts`
- Create: `src/server/services/traySummary.test.ts`
- Read: `src/server/repositories/approvals.ts`
- Read: `src/server/services/systemRisks.ts`

**Step 1: Write failing service tests**

Create `src/server/services/traySummary.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createDatabase } from "../db.ts";
import { ApprovalRepository } from "../repositories/approvals.ts";
import { SettingsRepository } from "../repositories/settings.ts";
import { SignatureAssetRepository } from "../repositories/signatureAssets.ts";
import { BackupRepository } from "../repositories/backups.ts";
import { getTraySummary } from "./traySummary.ts";

function context() {
  const db = createDatabase(":memory:");
  return {
    approvals: new ApprovalRepository(db),
    settings: new SettingsRepository(db),
    signatureAssets: new SignatureAssetRepository(db),
    backups: new BackupRepository(db)
  };
}

describe("getTraySummary", () => {
  it("returns only supervisor pending tasks for supervisor users", async () => {
    const deps = context();
    const first = deps.approvals.create({
      projectName: "300A",
      partName: "固定支持支架",
      version: "a0A0",
      minorVersion: "0",
      majorVersion: "A0",
      originalFilePath: "a.pdf",
      currentFilePath: "a.pdf",
      submittedBy: "designer"
    });
    deps.approvals.create({
      projectName: "300A",
      partName: "已审件",
      version: "a1A0",
      minorVersion: "1",
      majorVersion: "A0",
      originalFilePath: "b.pdf",
      currentFilePath: "b.pdf",
      submittedBy: "designer"
    });
    deps.approvals.review(first.id, { role: "supervisor", decision: "approved" });

    const summary = await getTraySummary({
      ...deps,
      user: { id: 2, username: "process", displayName: "工艺", role: "process" }
    });

    expect(summary.tasks.pendingCount).toBe(2);
    expect(summary.tasks.latestIds).toHaveLength(2);
    expect(summary.tasks.latest[0]).toMatchObject({ projectName: "300A", href: expect.stringMatching(/^#\/approvals\//) });
  });

  it("returns no reviewer tasks for designers", async () => {
    const deps = context();
    deps.approvals.create({
      projectName: "300A",
      partName: "固定支持支架",
      version: "a0A0",
      minorVersion: "0",
      majorVersion: "A0",
      originalFilePath: "a.pdf",
      currentFilePath: "a.pdf",
      submittedBy: "designer"
    });

    const summary = await getTraySummary({
      ...deps,
      user: { id: 3, username: "designer", displayName: "设计师", role: "designer" }
    });

    expect(summary.tasks.pendingCount).toBe(0);
    expect(summary.tasks.latestIds).toEqual([]);
  });

  it("includes admin risk summary for admins", async () => {
    const deps = context();
    const summary = await getTraySummary({
      ...deps,
      user: { id: 1, username: "admin", displayName: "管理员", role: "admin" }
    });

    expect(summary.admin).toEqual(expect.objectContaining({ riskCount: expect.any(Number), overallStatus: expect.any(String) }));
  });
});
```

**Step 2: Run the tests to verify they fail**

Run:

```powershell
npm test -- --run src/server/services/traySummary.test.ts
```

Expected: FAIL because `src/server/services/traySummary.ts` does not exist.

**Step 3: Implement the minimal tray summary service**

Create `src/server/services/traySummary.ts`:

```ts
import type { AuthUser } from "../auth.ts";
import type { ApprovalRepository } from "../repositories/approvals.ts";
import type { SettingsRepository } from "../repositories/settings.ts";
import type { SignatureAssetRepository } from "../repositories/signatureAssets.ts";
import type { BackupRepository } from "../repositories/backups.ts";
import { getSystemRisks } from "./systemRisks.ts";

type TraySummaryInput = {
  user: AuthUser;
  approvals: ApprovalRepository;
  settings: SettingsRepository;
  signatureAssets: SignatureAssetRepository;
  backups: BackupRepository;
};

export async function getTraySummary(input: TraySummaryInput) {
  const reviewerRole = input.user.role === "supervisor" || input.user.role === "process" ? input.user.role : undefined;
  const tasks = reviewerRole ? input.approvals.list({ reviewerRole }).slice(0, 5) : [];
  const risks = input.user.role === "admin"
    ? await getSystemRisks({
        approvals: input.approvals,
        settings: input.settings,
        backups: input.backups,
        signatureAssets: input.signatureAssets
      })
    : [];

  return {
    serverTime: new Date().toISOString(),
    user: input.user,
    tasks: {
      pendingCount: reviewerRole ? input.approvals.list({ reviewerRole }).length : 0,
      latestIds: tasks.map((approval) => approval.id),
      latest: tasks.map((approval) => ({
        id: approval.id,
        projectName: approval.projectName,
        partName: approval.partName,
        version: approval.version,
        submittedAt: approval.submittedAt,
        href: `#/approvals/${approval.id}`
      }))
    },
    admin: input.user.role === "admin"
      ? {
          overallStatus: risks.some((risk) => risk.level === "error") ? "error" : risks.some((risk) => risk.level === "warn") ? "warn" : "ok",
          riskCount: risks.length
        }
      : null
  };
}
```

**Step 4: Run the tests to verify they pass**

Run:

```powershell
npm test -- --run src/server/services/traySummary.test.ts
```

Expected: PASS.

**Step 5: Checkpoint**

If Git is available:

```powershell
git add src/server/services/traySummary.ts src/server/services/traySummary.test.ts
git commit -m "feat: add tray summary service"
```

Otherwise, record the passed command in the final verification notes.

## Task 2: Add Tray Summary API Route

**Files:**
- Create: `src/server/routes/tray.ts`
- Create: `src/server/routes/tray.test.ts`
- Modify: `src/server/server.ts`

**Step 1: Write failing route tests**

Create `src/server/routes/tray.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import request from "supertest";
import { createDatabase } from "../db.ts";
import { createServer } from "../server.ts";
import { UserRepository } from "../repositories/users.ts";
import { ApprovalRepository } from "../repositories/approvals.ts";
import { SettingsRepository } from "../repositories/settings.ts";
import { SignatureAssetRepository } from "../repositories/signatureAssets.ts";
import { BackupRepository } from "../repositories/backups.ts";

function appContext() {
  const db = createDatabase(":memory:");
  const users = new UserRepository(db);
  const approvals = new ApprovalRepository(db);
  const settings = new SettingsRepository(db);
  const signatureAssets = new SignatureAssetRepository(db);
  const backups = new BackupRepository(db);
  const app = createServer(
    { port: 0, dataDir: "data", databasePath: ":memory:", jwtSecret: "secret" },
    { db, users, approvals, settings, signatureAssets, backups }
  );
  return { app, users, approvals };
}

describe("tray routes", () => {
  it("requires authentication", async () => {
    const { app } = appContext();
    await request(app).get("/api/tray/summary").expect(401);
  });

  it("returns tray summary for authenticated users", async () => {
    const { app, approvals } = appContext();
    approvals.create({
      projectName: "300A",
      partName: "固定支持支架",
      version: "a0A0",
      minorVersion: "0",
      majorVersion: "A0",
      originalFilePath: "a.pdf",
      currentFilePath: "a.pdf",
      submittedBy: "designer"
    });

    const login = await request(app).post("/api/auth/login").send({ username: "supervisor", password: "123456" }).expect(200);
    const response = await request(app)
      .get("/api/tray/summary")
      .set("Authorization", `Bearer ${login.body.token}`)
      .expect(200);

    expect(response.body.tasks.pendingCount).toBe(1);
    expect(response.body.tasks.latest[0].href).toBe("#/approvals/1");
  });
});
```

**Step 2: Run the route tests to verify they fail**

Run:

```powershell
npm test -- --run src/server/routes/tray.test.ts
```

Expected: FAIL because `/api/tray/summary` is not registered.

**Step 3: Add the route**

Create `src/server/routes/tray.ts`:

```ts
import { Router } from "express";
import { requireAuth } from "../auth.ts";
import type { ApprovalRepository } from "../repositories/approvals.ts";
import type { SettingsRepository } from "../repositories/settings.ts";
import type { SignatureAssetRepository } from "../repositories/signatureAssets.ts";
import type { BackupRepository } from "../repositories/backups.ts";
import { getTraySummary } from "../services/traySummary.ts";

export function trayRoutes(deps: {
  approvals: ApprovalRepository;
  settings: SettingsRepository;
  signatureAssets: SignatureAssetRepository;
  backups: BackupRepository;
  jwtSecret: string;
}) {
  const router = Router();

  router.get("/summary", requireAuth(deps.jwtSecret), async (req, res) => {
    res.json(await getTraySummary({
      approvals: deps.approvals,
      settings: deps.settings,
      signatureAssets: deps.signatureAssets,
      backups: deps.backups,
      user: req.user!
    }));
  });

  return router;
}
```

Modify `src/server/server.ts`:

```ts
import { trayRoutes } from "./routes/tray.ts";
```

Register after auth and repository construction:

```ts
app.use("/api/tray", trayRoutes({
  approvals,
  settings,
  signatureAssets,
  backups,
  jwtSecret: config.jwtSecret
}));
```

**Step 4: Run tests**

Run:

```powershell
npm test -- --run src/server/services/traySummary.test.ts src/server/routes/tray.test.ts
```

Expected: PASS.

**Step 5: Checkpoint**

If Git is available:

```powershell
git add src/server/routes/tray.ts src/server/routes/tray.test.ts src/server/server.ts
git commit -m "feat: expose tray summary api"
```

## Task 3: Add Tauri Prerequisite Script and Documentation

**Files:**
- Create: `scripts/check-tauri-prereqs.ps1`
- Modify: `docs/deploy-windows-lan.md`
- Modify: `docs/verification.md`

**Step 1: Create a prerequisite script**

Create `scripts/check-tauri-prereqs.ps1`:

```powershell
$ErrorActionPreference = "Continue"

Write-Host "Node:"
node --version
npm --version

Write-Host "`nRust:"
rustc --version
cargo --version
rustup show active-toolchain
rustup target list --installed | Select-String "x86_64-pc-windows-msvc"

Write-Host "`nMSVC cl.exe:"
$cl = Get-Command cl -ErrorAction SilentlyContinue
if ($cl) { $cl.Source } else { "MISSING: cl.exe is not available on PATH. Install Visual Studio Build Tools or use Developer PowerShell." }

Write-Host "`nWebView2:"
$webview = Get-ChildItem -Path "C:\Program Files (x86)\Microsoft\EdgeWebView", "C:\Program Files\Microsoft\EdgeWebView" -Recurse -Filter msedgewebview2.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if ($webview) { $webview.FullName } else { "MISSING: WebView2 Runtime not found." }
```

**Step 2: Run the script**

Run:

```powershell
.\scripts\check-tauri-prereqs.ps1
```

Expected on current machine: Node, Rust and WebView2 found; `cl.exe` likely missing until Build Tools are installed or Developer PowerShell is used.

**Step 3: Document the requirement**

Append a V5 tray helper note to `docs/deploy-windows-lan.md`:

```md
## V5 Windows 托盘助手前置条件

Tauri 托盘助手需要：

- Node.js / npm
- Rust stable
- Microsoft C++ Build Tools，包含 Desktop development with C++ workload
- Microsoft Edge WebView2 Runtime

可运行：

```powershell
.\scripts\check-tauri-prereqs.ps1
```
```

**Step 4: Checkpoint**

If Git is available:

```powershell
git add scripts/check-tauri-prereqs.ps1 docs/deploy-windows-lan.md docs/verification.md
git commit -m "docs: add tauri prerequisite check"
```

## Task 4: Scaffold `apps/tray-helper`

**Files:**
- Create: `apps/tray-helper/package.json`
- Create: `apps/tray-helper/tsconfig.json`
- Create: `apps/tray-helper/index.html`
- Create: `apps/tray-helper/src/main.ts`
- Create: `apps/tray-helper/src/settings.ts`
- Create: `apps/tray-helper/src/types.ts`
- Create: `apps/tray-helper/src-tauri/Cargo.toml`
- Create: `apps/tray-helper/src-tauri/tauri.conf.json`
- Create: `apps/tray-helper/src-tauri/src/main.rs`
- Modify: root `package.json`

**Step 1: Add package scripts**

In root `package.json`, add:

```json
"tray:dev": "npm --prefix apps/tray-helper run tauri dev",
"tray:build": "npm --prefix apps/tray-helper run tauri build",
"tray:test": "npm --prefix apps/tray-helper test"
```

**Step 2: Create tray helper package**

Create `apps/tray-helper/package.json`:

```json
{
  "name": "pdf-approval-tray-helper",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "test": "vitest run",
    "tauri": "tauri"
  },
  "dependencies": {
    "@tauri-apps/api": "^2.0.0",
    "@tauri-apps/plugin-autostart": "^2.0.0",
    "@tauri-apps/plugin-notification": "^2.0.0",
    "@tauri-apps/plugin-opener": "^2.0.0",
    "@tauri-apps/plugin-store": "^2.0.0"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2.0.0",
    "typescript": "^5.7.3",
    "vite": "^6.0.7",
    "vitest": "^3.2.4"
  }
}
```

Before implementation, verify latest Tauri v2 package versions with:

```powershell
npm view @tauri-apps/cli version
npm view @tauri-apps/api version
npm view @tauri-apps/plugin-notification version
npm view @tauri-apps/plugin-autostart version
npm view @tauri-apps/plugin-store version
npm view @tauri-apps/plugin-opener version
```

**Step 3: Create minimal TypeScript entry**

Create `apps/tray-helper/src/main.ts`:

```ts
import "./settings.ts";
```

Create `apps/tray-helper/src/settings.ts`:

```ts
const root = document.querySelector<HTMLDivElement>("#app");

if (root) {
  root.innerHTML = `
    <main>
      <h1>PDF 图纸审批托盘助手</h1>
      <label>审批系统地址 <input id="server-url" placeholder="http://192.168.1.20:8080" /></label>
      <label>账号 <input id="username" /></label>
      <label>密码 <input id="password" type="password" /></label>
      <button id="login">登录</button>
    </main>
  `;
}
```

**Step 4: Create minimal Tauri Rust app**

Create `apps/tray-helper/src-tauri/src/main.rs`:

```rust
fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tray helper");
}
```

Create `apps/tray-helper/src-tauri/tauri.conf.json` with a hidden-by-default settings window only after tray setup is ready. During initial scaffold, keep one visible settings window so `tauri dev` can be verified.

**Step 5: Install dependencies and verify**

Run:

```powershell
npm install --registry=https://registry.npmmirror.com
npm --prefix apps/tray-helper install --registry=https://registry.npmmirror.com
npm run tray:test
npm --prefix apps/tray-helper run build
```

Expected: TypeScript and Vite build pass.

**Step 6: Tauri build smoke**

Run only after MSVC prerequisites are satisfied:

```powershell
npm run tray:dev
```

Expected: Tauri settings window opens.

## Task 5: Add Tray Helper Pure Logic Tests

**Files:**
- Create: `apps/tray-helper/src/apiClient.ts`
- Create: `apps/tray-helper/src/linkBuilder.ts`
- Create: `apps/tray-helper/src/notificationState.ts`
- Create: `apps/tray-helper/src/roles.ts`
- Create: `apps/tray-helper/src/*.test.ts`

**Step 1: Write failing tests**

Create `apps/tray-helper/src/linkBuilder.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { approvalUrl, routeUrl } from "./linkBuilder.ts";

describe("linkBuilder", () => {
  it("normalizes base urls and approval hashes", () => {
    expect(approvalUrl("http://192.168.1.20:8080/", 12)).toBe("http://192.168.1.20:8080/#/approvals/12");
    expect(routeUrl("http://192.168.1.20:8080", "#/settings")).toBe("http://192.168.1.20:8080/#/settings");
  });
});
```

Create `apps/tray-helper/src/notificationState.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { newNotificationIds, mergeNotifiedIds } from "./notificationState.ts";

describe("notificationState", () => {
  it("deduplicates notified approval ids", () => {
    expect(newNotificationIds([1, 2, 3], [1, 3])).toEqual([2]);
    expect(mergeNotifiedIds([1, 2], [2, 3])).toEqual([1, 2, 3]);
  });
});
```

Create `apps/tray-helper/src/roles.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { menuModeForRole } from "./roles.ts";

describe("menuModeForRole", () => {
  it("maps roles to menu modes", () => {
    expect(menuModeForRole("supervisor")).toBe("reviewer");
    expect(menuModeForRole("process")).toBe("reviewer");
    expect(menuModeForRole("designer")).toBe("designer");
    expect(menuModeForRole("admin")).toBe("admin");
  });
});
```

**Step 2: Run tests to verify they fail**

Run:

```powershell
npm run tray:test
```

Expected: FAIL because helper modules do not exist.

**Step 3: Implement pure logic modules**

Implement `linkBuilder.ts`, `notificationState.ts`, and `roles.ts` with no Tauri imports. Keep them easy to unit test.

**Step 4: Run tests**

Run:

```powershell
npm run tray:test
```

Expected: PASS.

## Task 6: Implement API Client and Login Flow

**Files:**
- Modify: `apps/tray-helper/src/apiClient.ts`
- Modify: `apps/tray-helper/src/settings.ts`
- Create: `apps/tray-helper/src/authStore.ts`
- Test: `apps/tray-helper/src/apiClient.test.ts`

**Step 1: Write API client tests**

Test cases:

- `login()` POSTs `/api/auth/login`.
- `fetchTraySummary()` GETs `/api/tray/summary` with `Bearer` token.
- `healthCheck()` treats HTTP 200 as online and network errors as offline.
- 401 is returned as a typed `auth_expired` error.

**Step 2: Implement API client**

Use `fetch` from the Tauri WebView context. Do not use Node APIs in browser-side modules.

**Step 3: Implement settings form login**

The settings window should:

- validate server URL;
- call `login`;
- store server URL, username, role and token;
- close or hide after success;
- show inline errors for invalid credentials or offline server.

**Step 4: Run tests**

Run:

```powershell
npm run tray:test
npm --prefix apps/tray-helper run build
```

Expected: PASS.

## Task 7: Implement Tauri Tray, Poller, and Notifications

**Files:**
- Modify: `apps/tray-helper/src-tauri/src/main.rs`
- Modify: `apps/tray-helper/src-tauri/Cargo.toml`
- Modify: `apps/tray-helper/src-tauri/tauri.conf.json`
- Modify: `apps/tray-helper/src/poller.ts`
- Modify: `apps/tray-helper/src/trayMenu.ts`
- Modify: `apps/tray-helper/src/notifications.ts`

**Step 1: Configure Tauri plugins**

In `Cargo.toml`, add corresponding Rust crates:

```toml
tauri = { version = "2", features = ["tray-icon"] }
tauri-plugin-notification = "2"
tauri-plugin-autostart = "2"
tauri-plugin-store = "2"
tauri-plugin-opener = "2"
```

Verify exact versions against the package lock and current Tauri docs before installation.

**Step 2: Add tray menu**

Use Tauri v2 tray APIs in Rust:

- build a tray icon;
- add menu items for role-dependent routes;
- emit menu events to the front-end or call opener commands;
- keep the settings window available from tray.

**Step 3: Add poller**

Poller rules:

- normal interval: 30 seconds;
- offline interval: 60 seconds;
- manual refresh triggers immediate poll;
- 401 stops polling authenticated endpoints until login;
- no repeated error notifications.

**Step 4: Add notification flow**

Use the notification plugin:

- request/check permission when needed;
- show one notification for one new task;
- show batch notification for multiple new tasks;
- store notified IDs after showing;
- clicking notification opens detail URL or task list.

**Step 5: Manual smoke**

Run:

```powershell
npm run tray:dev
```

Expected:

- tray icon appears;
- menu opens;
- settings window opens;
- after login, status changes to online;
- a known pending task triggers one notification.

## Task 8: Add Admin Actions in Tray Helper

**Files:**
- Modify: `apps/tray-helper/src/apiClient.ts`
- Modify: `apps/tray-helper/src/trayMenu.ts`
- Test: `apps/tray-helper/src/apiClient.test.ts`

**Step 1: Add tests**

Test:

- `scanNow()` POSTs `/api/system/scan-now`;
- `restartServer()` POSTs `/api/system/restart`;
- non-admin roles do not include admin menu actions.

**Step 2: Implement client calls**

Reuse existing backend endpoints. Do not call local shell commands from Tauri for restart or scan.

**Step 3: Manual smoke**

Login as admin and verify:

- "打开系统管理" opens `#/settings`;
- "打开服务日志" opens `#/settings` logs tab or system management route;
- "立即扫描" returns success;
- "重启服务" requests restart and then health polling recovers.

## Task 9: Packaging and Windows Deployment Notes

**Files:**
- Modify: `apps/tray-helper/src-tauri/tauri.conf.json`
- Create: `docs/tray-helper-user-guide.md`
- Create: `docs/tray-helper-admin-guide.md`
- Create: `docs/tray-helper-verification.md`
- Modify: `docs/deploy-windows-lan.md`

**Step 1: Add app metadata**

Set:

- product name: `PDF 图纸审批托盘助手`
- identifier: `local.pdf-approval.tray-helper`
- Windows icon path;
- bundle targets according to Tauri's current Windows bundling defaults.

**Step 2: Build package**

Run:

```powershell
npm run tray:build
```

Expected: Tauri build artifacts are created under `apps/tray-helper/src-tauri/target/release/bundle`.

**Step 3: Write user guide**

Cover:

- install;
- first login;
- server URL;
- enable open at login;
- notification behavior;
- re-login;
- clear notified IDs;
- uninstall.

**Step 4: Write admin guide**

Cover:

- prerequisites;
- installing on reviewer PCs;
- server URL convention;
- firewall and LAN address;
- update procedure;
- logs;
- rollback.

**Step 5: Write verification checklist**

Cover:

- online/offline state;
- login success/failure;
- token expiration;
- new pending task notification;
- deduplication;
- notification click URL;
- designer no review notifications;
- admin actions;
- startup behavior;
- uninstall cleanup.

## Task 10: Final Regression and Release Candidate Check

**Files:**
- Modify: `docs/verification.md`

**Step 1: Run backend tests**

Run:

```powershell
npm test
```

Expected: all existing and new backend tests pass.

**Step 2: Run backend build**

Run:

```powershell
npm run build
```

Expected: TypeScript and Vite production build pass.

**Step 3: Run tray tests and build**

Run:

```powershell
npm run tray:test
npm --prefix apps/tray-helper run build
npm run tray:build
```

Expected: tray unit tests pass, Tauri build succeeds.

**Step 4: Manual LAN smoke**

Use the local approval service:

1. Start or verify `http://127.0.0.1:8080/health`.
2. Login in tray helper as supervisor.
3. Add a test pending approval or use an existing pending item.
4. Confirm one notification appears.
5. Click notification and verify browser opens `#/approvals/:id`.
6. Restart tray helper and confirm the same approval does not notify again.
7. Stop server and confirm tray status changes to offline.
8. Restart server and confirm tray status recovers.

**Step 5: Record results**

Append a V5 section to `docs/verification.md` with:

- commands run;
- pass/fail results;
- Tauri build artifact path;
- manual smoke result;
- unresolved environment risks.

**Step 6: Release decision**

V5 can be marked release candidate only when:

- backend tests pass;
- Web build passes;
- tray tests pass;
- Tauri build succeeds on the target Windows build machine;
- manual notification smoke passes for supervisor and process roles;
- designer login produces no review notification;
- admin can open system management from tray.
