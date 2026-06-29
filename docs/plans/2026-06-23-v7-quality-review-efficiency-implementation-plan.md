# V7 Quality And Review Efficiency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve production readiness and drawing review efficiency without changing the fixed LAN approval workflow.

**Architecture:** Keep Express, React/Vite, Electron client, Electron server exe, and SQLite. Add small contracts for version/health diagnostics, extend existing PDF viewport and annotation modules, add conservative SQLite indexes and maintenance services, then split large pages only after behavior is covered by tests.

**Tech Stack:** Node 24, TypeScript, Express, React 19, Vite, Electron, SQLite through `node:sqlite`, Vitest.

---

## Scope And Order

Implement V7 in this order:

1. Connection and version diagnostics.
2. Database indexes.
3. PDF navigation and annotation filtering.
4. Automatic maintenance and backup validation.
5. Component extraction for the largest pages.
6. Packaging and documentation refresh.

Do not implement project-level reviewer routing, external chat notifications, CA signatures, or a new PDF viewer in this version.

## File Structure

New files:

- `src/shared/appVersion.ts`：single source for app version and API compatibility version.
- `src/server/services/publicHealth.ts`：builds safe unauthenticated health payload.
- `src/server/services/publicHealth.test.ts`：verifies health payload does not leak sensitive paths.
- `src/server/dbIndexes.test.ts`：verifies V7 indexes exist after migration.
- `src/client/connectionCheck.ts`：pure helpers for client-side connection diagnostics.
- `src/client/connectionCheck.test.ts`：tests address advice and version compatibility.
- `src/server/services/maintenanceScheduler.ts`：in-process daily maintenance scheduler.
- `src/server/services/maintenanceScheduler.test.ts`：tests schedule calculation and locking.
- `src/server/services/backupValidation.ts`：validates backup folders without restoring them.
- `src/server/services/backupValidation.test.ts`：tests valid, incomplete, and unreadable backups.
- `src/client/pages/approvalDetail/AnnotationSidePanel.tsx`：annotation list, filtering, selected annotation editing.
- `src/client/pages/approvalDetail/FloatingSupportPanel.tsx`：comments, timeline, history floating dialog.
- `src/client/pages/approvalDetail/SignaturePanel.tsx`：signature placement and signed PDF actions.
- `src/client/pages/settings/OperationsTab.tsx`：risk, diagnostics, backups, cleanup, maintenance.

Modified files:

- `src/server/schema.sql`
- `src/server/db.ts`
- `src/server/server.ts`
- `src/server/routes/system.ts`
- `src/server/routes/system.test.ts`
- `apps/server-exe/serverConsoleView.cjs`
- `src/server/serverExeConsoleView.test.ts`
- `src/client/api.ts`
- `src/client/api.test.ts`
- `src/client/pages/LoginPage.tsx`
- `src/client/pages/ServerConnectionPage.test.ts`
- `src/client/widgets/PdfViewportControls.tsx`
- `src/client/widgets/PdfViewportControls.test.ts`
- `src/client/widgets/PdfAnnotationWorkspace.tsx`
- `src/client/widgets/PdfAnnotationWorkspace.test.ts`
- `src/client/widgets/PdfSignaturePlacementWorkspace.tsx`
- `src/client/widgets/PdfSignaturePlacementWorkspace.test.ts`
- `src/client/pages/ApprovalDetailPage.tsx`
- `src/client/pages/approvalDetailLayout.test.ts`
- `src/client/pages/SettingsPage.tsx`
- `src/client/pages/settingsDiagnostics.test.ts`
- `docs/deploy-windows-lan.md`
- `docs/desktop-client-admin-guide.md`
- `docs/desktop-client-user-guide.md`
- `docs/verification.md`

---

## Task 1: Public Health And Version Contract

**Files:**
- Create: `src/shared/appVersion.ts`
- Create: `src/server/services/publicHealth.ts`
- Create: `src/server/services/publicHealth.test.ts`
- Modify: `src/server/server.ts`
- Modify: `src/server/server.test.ts`

- [ ] **Step 1: Write failing tests for public health payload**

Create `src/server/services/publicHealth.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildPublicHealth } from "./publicHealth.ts";

describe("buildPublicHealth", () => {
  it("returns safe version and address metadata without sensitive paths", () => {
    const health = buildPublicHealth({
      port: 8080,
      lanAddresses: ["192.168.1.20"],
      startedAt: "2026-06-23T00:00:00.000Z"
    });

    expect(health).toEqual({
      ok: true,
      appName: "PDF图纸审批",
      version: expect.stringMatching(/^\d+\.\d+\.\d+$/),
      apiCompatVersion: 1,
      port: 8080,
      lanUrls: ["http://192.168.1.20:8080"],
      startedAt: "2026-06-23T00:00:00.000Z"
    });
    expect(JSON.stringify(health)).not.toContain("smtp");
    expect(JSON.stringify(health)).not.toContain("database");
    expect(JSON.stringify(health)).not.toContain("watch_root");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm test -- --run src/server/services/publicHealth.test.ts
```

Expected: fail because `publicHealth.ts` does not exist.

- [ ] **Step 3: Add shared version constants**

Create `src/shared/appVersion.ts`:

```ts
export const appName = "PDF图纸审批";
export const appVersion = "0.1.0";
export const apiCompatVersion = 1;
```

- [ ] **Step 4: Implement public health builder**

Create `src/server/services/publicHealth.ts`:

```ts
import { apiCompatVersion, appName, appVersion } from "../../shared/appVersion.ts";

export type PublicHealthInput = {
  port: number;
  lanAddresses: string[];
  startedAt: string;
};

export function buildPublicHealth(input: PublicHealthInput) {
  return {
    ok: true,
    appName,
    version: appVersion,
    apiCompatVersion,
    port: input.port,
    lanUrls: input.lanAddresses.map((address) => `http://${address}:${input.port}`),
    startedAt: input.startedAt
  };
}
```

- [ ] **Step 5: Wire `/health` to return the extended payload**

Modify `src/server/server.ts` so the existing `/health` response includes `buildPublicHealth(...)`. Preserve `ok: true` so existing callers still pass.

Use the existing LAN address helper if already available to the server process. If not, return an empty `lanUrls` array from the Express process and fill LAN URLs in the server exe UI separately.

- [ ] **Step 6: Verify focused tests**

Run:

```powershell
npm test -- --run src/server/services/publicHealth.test.ts src/server/server.test.ts
```

Expected: all tests pass.

---

## Task 2: Client Connection Self-Check

**Files:**
- Create: `src/client/connectionCheck.ts`
- Create: `src/client/connectionCheck.test.ts`
- Modify: `src/client/api.ts`
- Modify: `src/client/api.test.ts`
- Modify: `src/client/pages/LoginPage.tsx`
- Modify: `src/client/pages/ServerConnectionPage.test.ts`

- [ ] **Step 1: Write failing tests for connection diagnostics**

Create `src/client/connectionCheck.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { analyzeServerAddress, isApiCompatible } from "./connectionCheck.ts";

describe("connectionCheck", () => {
  it("warns when a teammate client uses a local-only address", () => {
    expect(analyzeServerAddress("http://127.0.0.1:8080")).toEqual({
      normalizedUrl: "http://127.0.0.1:8080",
      level: "warning",
      message: "127.0.0.1 只代表当前电脑，同事电脑请填写服务端显示的局域网地址。"
    });
  });

  it("accepts LAN addresses", () => {
    expect(analyzeServerAddress("http://192.168.1.20:8080")).toEqual({
      normalizedUrl: "http://192.168.1.20:8080",
      level: "ok",
      message: "服务器地址格式正常。"
    });
  });

  it("checks API compatibility", () => {
    expect(isApiCompatible({ clientApiCompatVersion: 1, serverApiCompatVersion: 1 })).toBe(true);
    expect(isApiCompatible({ clientApiCompatVersion: 1, serverApiCompatVersion: 2 })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm test -- --run src/client/connectionCheck.test.ts
```

Expected: fail because `connectionCheck.ts` does not exist.

- [ ] **Step 3: Implement pure helpers**

Create `src/client/connectionCheck.ts`:

```ts
export type AddressAdvice = {
  normalizedUrl: string;
  level: "ok" | "warning" | "error";
  message: string;
};

export function analyzeServerAddress(input: string): AddressAdvice {
  const normalizedUrl = input.trim().replace(/\/+$/, "");
  if (!normalizedUrl) {
    return { normalizedUrl, level: "error", message: "请先填写审批服务器地址。" };
  }
  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(normalizedUrl)) {
    return {
      normalizedUrl,
      level: "warning",
      message: "127.0.0.1 只代表当前电脑，同事电脑请填写服务端显示的局域网地址。"
    };
  }
  if (!/^https?:\/\/[^/]+(:\d+)?$/i.test(normalizedUrl)) {
    return { normalizedUrl, level: "error", message: "服务器地址格式不正确，应类似 http://192.168.1.20:8080。" };
  }
  return { normalizedUrl, level: "ok", message: "服务器地址格式正常。" };
}

export function isApiCompatible(input: { clientApiCompatVersion: number; serverApiCompatVersion: number }) {
  return input.clientApiCompatVersion === input.serverApiCompatVersion;
}
```

- [ ] **Step 4: Add API helper for health checks**

Modify `src/client/api.ts` with a `checkServerHealth(baseUrl?: string)` helper that fetches `/health`, returns parsed JSON, and throws a typed message when fetch fails.

- [ ] **Step 5: Add UI entry points**

In `LoginPage.tsx`, add a small “连接自检” action in the desktop server box. It should display:

- service reachable
- server version
- API compatibility result
- address advice from `analyzeServerAddress`

In `ServerConnectionPage` if present, show the same result before saving.

- [ ] **Step 6: Verify focused tests**

Run:

```powershell
npm test -- --run src/client/connectionCheck.test.ts src/client/api.test.ts src/client/pages/ServerConnectionPage.test.ts
```

Expected: all tests pass.

---

## Task 3: Server Exe Address Copy And Clear LAN Display

**Files:**
- Modify: `apps/server-exe/serverConsoleView.cjs`
- Modify: `apps/server-exe/main.cjs`
- Modify: `src/server/serverExeConsoleView.test.ts`
- Modify: `src/server/serverExeLanAddress.test.ts`

- [ ] **Step 1: Add failing UI source tests**

Extend `src/server/serverExeConsoleView.test.ts` to assert the generated console view contains:

```ts
expect(html).toContain("复制客户端地址");
expect(html).toContain("给同事填写");
expect(html).toContain("局域网地址");
```

- [ ] **Step 2: Run focused tests**

Run:

```powershell
npm test -- --run src/server/serverExeConsoleView.test.ts src/server/serverExeLanAddress.test.ts
```

Expected: fail until the copy UI is added.

- [ ] **Step 3: Add copy action in server console view**

Modify `apps/server-exe/serverConsoleView.cjs` so the LAN URL row renders a copy button. The button should call a preload method such as `window.serverConsole.copyText(lanUrl)`.

- [ ] **Step 4: Expose safe clipboard bridge**

Modify `apps/server-exe/preload.cjs` and `apps/server-exe/main.cjs` to expose a narrowly scoped clipboard write action. Do not expose arbitrary shell execution.

- [ ] **Step 5: Verify focused tests**

Run:

```powershell
npm test -- --run src/server/serverExeConsoleView.test.ts src/server/serverExeLanAddress.test.ts
```

Expected: all tests pass.

---

## Task 4: SQLite Indexes For Long-Term Use

**Files:**
- Create: `src/server/dbIndexes.test.ts`
- Modify: `src/server/schema.sql`
- Modify: `src/server/db.ts`

- [ ] **Step 1: Write failing index migration test**

Create `src/server/dbIndexes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createDatabase } from "./db.ts";

describe("database indexes", () => {
  it("creates approval indexes used by V7 list, risk, and version queries", () => {
    const db = createDatabase(":memory:");
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
      .all() as Array<{ name: string }>;

    expect(indexes.map((item) => item.name)).toEqual(
      expect.arrayContaining([
        "idx_approvals_status_submitted",
        "idx_approvals_signature_status_submitted",
        "idx_approvals_project_part_submitted",
        "idx_approvals_current_file_path",
        "idx_approvals_submitted_by_user"
      ])
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm test -- --run src/server/dbIndexes.test.ts
```

Expected: fail because the indexes are not created.

- [ ] **Step 3: Add indexes to schema**

Add to `src/server/schema.sql` after the `approvals` table:

```sql
CREATE INDEX IF NOT EXISTS idx_approvals_status_submitted ON approvals(status, submitted_at, id);
CREATE INDEX IF NOT EXISTS idx_approvals_signature_status_submitted ON approvals(signature_status, submitted_at, id);
CREATE INDEX IF NOT EXISTS idx_approvals_project_part_submitted ON approvals(project_name, part_name, submitted_at, id);
CREATE INDEX IF NOT EXISTS idx_approvals_current_file_path ON approvals(current_file_path);
CREATE INDEX IF NOT EXISTS idx_approvals_submitted_by_user ON approvals(submitted_by_user_id, submitted_at, id);
```

- [ ] **Step 4: Add migration safety to `db.ts`**

Add an idempotent `migrateApprovalIndexes(db)` function and call it from `migrateDatabase(db)` after approval column migrations. This protects databases created before the schema update.

- [ ] **Step 5: Verify index and approval tests**

Run:

```powershell
npm test -- --run src/server/dbIndexes.test.ts src/server/repositories/approvals.test.ts src/server/routes/approvals.test.ts
```

Expected: all tests pass.

---

## Task 5: PDF Page Navigation And Fit Height

**Files:**
- Modify: `src/client/widgets/PdfViewportControls.tsx`
- Modify: `src/client/widgets/PdfViewportControls.test.ts`
- Modify: `src/client/widgets/PdfAnnotationWorkspace.tsx`
- Modify: `src/client/widgets/PdfAnnotationWorkspace.test.ts`
- Modify: `src/client/widgets/PdfSignaturePlacementWorkspace.tsx`
- Modify: `src/client/widgets/PdfSignaturePlacementWorkspace.test.ts`
- Modify: `src/client/styles.css`
- Modify: `src/client/styles.test.ts`

- [ ] **Step 1: Extend viewport state tests**

Add tests in `PdfViewportControls.test.ts` for:

```ts
expect(updatePdfViewportZoom(createPdfViewportState(), "fit-height")).toEqual({
  mode: "fit-height",
  zoom: 1,
  panMode: false
});
```

Also assert `pdfViewportZoomLabel({ mode: "fit-height", zoom: 1, panMode: false })` returns `适高`.

- [ ] **Step 2: Run focused test**

Run:

```powershell
npm test -- --run src/client/widgets/PdfViewportControls.test.ts
```

Expected: fail until `fit-height` is supported.

- [ ] **Step 3: Implement `fit-height` state**

Extend `PdfViewportMode` to include `"fit-height"` and add a toolbar button with a clear icon and title `适配高度`.

- [ ] **Step 4: Add page navigation contract**

In both PDF workspaces, keep page refs in an array or map and add a compact page control:

- previous page
- current page input
- next page
- page count label

Use `scrollIntoView({ block: "start" })` for page jumps. Keep scroll container as the source of truth.

- [ ] **Step 5: Add source-level tests**

Extend workspace tests to assert the source contains page navigation functions and does not remove existing wheel and pan wiring.

- [ ] **Step 6: Verify focused tests**

Run:

```powershell
npm test -- --run src/client/widgets/PdfViewportControls.test.ts src/client/widgets/PdfAnnotationWorkspace.test.ts src/client/widgets/PdfSignaturePlacementWorkspace.test.ts src/client/styles.test.ts
```

Expected: all tests pass.

---

## Task 6: Annotation Filters And Continuous Marking

**Files:**
- Modify: `src/client/pages/approvalDetailLogic.ts`
- Modify: `src/client/pages/approvalDetailLogic.test.ts`
- Modify: `src/client/pages/ApprovalDetailPage.tsx`
- Modify: `src/client/pages/approvalDetailLayout.test.ts`
- Modify: `src/client/styles.css`

- [ ] **Step 1: Add pure filter tests**

Add tests in `approvalDetailLogic.test.ts` for a helper:

```ts
filterAnnotations(annotations, {
  status: "open",
  author: "mine",
  kind: "arrow",
  currentUserId: 2
});
```

Expected: only unresolved arrow annotations authored by user `2` are returned.

- [ ] **Step 2: Run focused test**

Run:

```powershell
npm test -- --run src/client/pages/approvalDetailLogic.test.ts
```

Expected: fail until `filterAnnotations` exists.

- [ ] **Step 3: Implement filter helper**

Add typed filters:

```ts
export type AnnotationFilterState = {
  status: "all" | "open" | "resolved";
  author: "all" | "mine";
  kind: "all" | ApprovalAnnotation["kind"];
  currentUserId: number;
};
```

The helper should be pure and stable for tests.

- [ ] **Step 4: Add UI controls**

In `ApprovalDetailPage.tsx`, add compact filter controls above the annotation list:

- status segmented control
- author select
- type select
- continuous marking toggle

When continuous marking is enabled, `onConfirmDraftAnnotation` should not force `setAnnotationTool("select")`.

- [ ] **Step 5: Verify focused tests**

Run:

```powershell
npm test -- --run src/client/pages/approvalDetailLogic.test.ts src/client/pages/approvalDetailLayout.test.ts
```

Expected: all tests pass.

---

## Task 7: Automatic Maintenance And Backup Validation

**Files:**
- Create: `src/server/services/maintenanceScheduler.ts`
- Create: `src/server/services/maintenanceScheduler.test.ts`
- Create: `src/server/services/backupValidation.ts`
- Create: `src/server/services/backupValidation.test.ts`
- Modify: `src/server/schema.sql`
- Modify: `src/server/db.ts`
- Modify: `src/server/routes/system.ts`
- Modify: `src/server/routes/system.test.ts`
- Modify: `src/client/api.ts`
- Modify: `src/client/api.test.ts`
- Modify: `src/client/pages/SettingsPage.tsx`
- Modify: `src/client/pages/settingsDiagnostics.test.ts`

- [ ] **Step 1: Write scheduler tests**

Create `maintenanceScheduler.test.ts` to cover:

- disabled schedule does not run.
- enabled daily schedule calculates next run.
- a running task blocks a second run.
- failed task returns a failed result instead of throwing out of the scheduler loop.

- [ ] **Step 2: Write backup validation tests**

Create `backupValidation.test.ts`:

```ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateBackupDirectory } from "./backupValidation.ts";

describe("validateBackupDirectory", () => {
  it("accepts a backup with a readable sqlite file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-approval-backup-valid-"));
    await fs.writeFile(path.join(root, "pdf-approval.sqlite"), "SQLite format 3\u0000");

    await expect(validateBackupDirectory(root)).resolves.toEqual({
      ok: true,
      files: ["pdf-approval.sqlite"],
      message: "备份目录可读取。"
    });
  });
});
```

- [ ] **Step 3: Run focused tests**

Run:

```powershell
npm test -- --run src/server/services/maintenanceScheduler.test.ts src/server/services/backupValidation.test.ts
```

Expected: fail until services exist.

- [ ] **Step 4: Add maintenance settings and routes**

Use existing `settings` table for:

- `maintenance_auto_backup_enabled`
- `maintenance_auto_backup_time`
- `maintenance_auto_cleanup_enabled`
- `maintenance_auto_cleanup_time`

Add administrator routes:

- `GET /api/system/maintenance`
- `PUT /api/system/maintenance`
- `POST /api/system/backups/validate`

- [ ] **Step 5: Add management UI**

In Settings operations tab, add a “自动维护” panel with:

- auto backup toggle and time input
- auto cleanup toggle and time input
- save button
- backup validation path input
- validate button

- [ ] **Step 6: Verify focused tests**

Run:

```powershell
npm test -- --run src/server/routes/system.test.ts src/client/api.test.ts src/client/pages/settingsDiagnostics.test.ts
```

Expected: all tests pass.

---

## Task 8: Split Approval Detail Panels

**Files:**
- Create: `src/client/pages/approvalDetail/AnnotationSidePanel.tsx`
- Create: `src/client/pages/approvalDetail/FloatingSupportPanel.tsx`
- Create: `src/client/pages/approvalDetail/SignaturePanel.tsx`
- Modify: `src/client/pages/ApprovalDetailPage.tsx`
- Modify: `src/client/pages/approvalDetailLayout.test.ts`

- [ ] **Step 1: Add source-level guard tests**

Extend `approvalDetailLayout.test.ts` to assert:

```ts
expect(source).toContain("AnnotationSidePanel");
expect(source).toContain("FloatingSupportPanel");
expect(source).toContain("SignaturePanel");
```

- [ ] **Step 2: Run focused test**

Run:

```powershell
npm test -- --run src/client/pages/approvalDetailLayout.test.ts
```

Expected: fail until components are extracted.

- [ ] **Step 3: Extract `FloatingSupportPanel` first**

Move only the floating comments/timeline/history dialog markup and its props into `FloatingSupportPanel.tsx`. Keep state in `ApprovalDetailPage.tsx` for this first extraction.

- [ ] **Step 4: Extract `AnnotationSidePanel`**

Move annotation list, selected annotation editing controls, resolve/delete buttons, and filters into `AnnotationSidePanel.tsx`. Keep API calls in the parent and pass callbacks as props.

- [ ] **Step 5: Extract `SignaturePanel`**

Move signature status, placement editor entry, save placement, save template, retry signing, signed PDF link, and mark printed warning into `SignaturePanel.tsx`.

- [ ] **Step 6: Verify focused and full tests**

Run:

```powershell
npm test -- --run src/client/pages/approvalDetailLayout.test.ts src/client/pages/approvalDetailLogic.test.ts
npm test
```

Expected: all tests pass.

---

## Task 9: Split Settings Operations Tab

**Files:**
- Create: `src/client/pages/settings/OperationsTab.tsx`
- Modify: `src/client/pages/SettingsPage.tsx`
- Modify: `src/client/pages/settingsDiagnostics.test.ts`

- [ ] **Step 1: Add source-level guard test**

Extend `settingsDiagnostics.test.ts`:

```ts
const source = fs.readFileSync(path.resolve("src/client/pages/SettingsPage.tsx"), "utf8");
expect(source).toContain("OperationsTab");
```

- [ ] **Step 2: Run focused test**

Run:

```powershell
npm test -- --run src/client/pages/settingsDiagnostics.test.ts
```

Expected: fail until `OperationsTab` is extracted.

- [ ] **Step 3: Extract operations tab**

Move risk dashboard, diagnostics panel, backup list, batch submission history, cleanup panel, signature status panel, report export, and operation log table into `OperationsTab.tsx`.

Keep refresh functions in `SettingsPage.tsx` first. Pass data and handlers as props. Do not change the tab names or route hash behavior.

- [ ] **Step 4: Verify focused tests**

Run:

```powershell
npm test -- --run src/client/pages/settingsDiagnostics.test.ts
```

Expected: all tests pass.

---

## Task 10: Documentation, Packaging, And Full Verification

**Files:**
- Modify: `docs/deploy-windows-lan.md`
- Modify: `docs/desktop-client-admin-guide.md`
- Modify: `docs/desktop-client-user-guide.md`
- Modify: `docs/verification.md`

- [ ] **Step 1: Update deployment docs**

Document:

- connection self-check
- version compatibility message
- service exe address copy
- automatic maintenance settings
- backup validation
- Tauri tray helper as historical experiment only

- [ ] **Step 2: Run regression**

Run:

```powershell
npm test
npm run build
npm run desktop:test
npm run installer:test
```

Expected: all commands exit 0. The existing PDF async chunk warning may remain if ordinary entry chunk is not regressed.

- [ ] **Step 3: Package installers**

Run:

```powershell
npm run installer:package
```

Expected:

- client installer exists under `dist\installers\client`
- server installer exists under `dist\installers\server`

- [ ] **Step 4: Record verification**

Append a V7 section to `docs/verification.md` containing:

- focused test commands
- full regression commands
- package output paths
- manual smoke items not executed locally

---

## Self-Review Checklist

- Every V7 design goal maps to at least one task.
- Tasks do not require changing the fixed supervisor plus process parallel approval model.
- Tasks do not require external services.
- Tasks preserve SQLite through `node:sqlite`.
- The first four tasks are useful even if later UI refactors are deferred.
- Full verification includes tests, build, desktop tests, installer tests, and installer packaging.
