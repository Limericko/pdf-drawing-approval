# PDF 图纸审批系统第二版 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the second version of the PDF approval system so administrators can repair abnormal approvals, audit key actions, manually scan folders, test email settings, and maintain the LAN deployment without editing the database.

**Architecture:** Keep the current Node 24 + Express + React/Vite + SQLite architecture. Add durable audit and scan tables, extend approval statuses, then expose small admin-only APIs and focused management UI sections. Preserve the first-version folder workflow and fixed parallel supervisor/process review model.

**Tech Stack:** Node 24 built-in `node:sqlite`, TypeScript, Express, React, Vite, chokidar v4, bcryptjs, jsonwebtoken, nodemailer, Vitest, Supertest.

---

## Preconditions

- Work from `G:\Personal documents\code\PDF审批`.
- Do not reintroduce `better-sqlite3`.
- Keep `chokidar@4` root-watch plus code filtering; do not use old glob watch patterns.
- Keep Windows server directory browser as the primary folder selection path.
- Use TDD for behavior changes.
- Run `npm test` and `npm run build` before final delivery.
- This workspace is currently not a Git repository, so commit steps are documented as checkpoints only. If Git is initialized later, commit after each task group.

## Phase 1: Data Model and Audit Foundation

### Task 1: Extend Approval Statuses

**Files:**
- Modify: `src/server/domain/approvals.ts`
- Modify: `src/server/schema.sql`
- Modify: `src/server/db.ts`
- Modify: `src/client/api.ts`
- Modify: `src/client/widgets/status.ts`
- Modify: `src/client/widgets/StatusChip.tsx`
- Test: `src/server/repositories/approvals.test.ts`

**Step 1: Write failing repository tests**

Add tests for:

- `invalid_pdf` can be stored and listed.
- `voided` can be stored and listed.
- `invalid_pdf` and `voided` do not appear in reviewer task queues.

Run:

```powershell
npm test -- src/server/repositories/approvals.test.ts
```

Expected:

```text
FAIL because invalid_pdf/voided are not accepted by the current status type or DB CHECK constraint.
```

**Step 2: Implement minimal status extension**

Update `ApprovalStatus` to include:

```ts
"invalid_pdf" | "voided"
```

Update `schema.sql` approvals CHECK constraint to include:

```sql
'invalid_pdf', 'voided'
```

Update migration logic in `src/server/db.ts` so existing databases are rebuilt when the approvals CHECK constraint does not include both statuses.

Update client status types and labels:

```text
invalid_pdf -> PDF 无效
voided -> 已作废
```

Use invalid/error chip styling for `invalid_pdf`, archived/quiet styling for `voided`.

**Step 3: Verify**

Run:

```powershell
npm test -- src/server/repositories/approvals.test.ts
npm run build
```

Expected:

```text
Repository tests pass.
Build passes.
```

### Task 2: Add Operation Logs

**Files:**
- Modify: `src/server/schema.sql`
- Modify: `src/server/db.ts`
- Create: `src/server/repositories/operationLogs.ts`
- Test: `src/server/repositories/operationLogs.test.ts`

**Step 1: Write failing tests**

Create tests for:

- Creating an operation log.
- Listing recent global logs.
- Listing logs for one approval by `target_type = 'approval'` and `target_id`.
- Storing metadata JSON.

Run:

```powershell
npm test -- src/server/repositories/operationLogs.test.ts
```

Expected:

```text
FAIL because repository/table does not exist.
```

**Step 2: Implement schema and repository**

Add table:

```sql
CREATE TABLE IF NOT EXISTS operation_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER,
  actor_username TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id INTEGER,
  message TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

Add indexes:

```sql
CREATE INDEX IF NOT EXISTS idx_operation_logs_target ON operation_logs(target_type, target_id, created_at);
CREATE INDEX IF NOT EXISTS idx_operation_logs_created_at ON operation_logs(created_at);
```

Repository methods:

- `create(input)`
- `listRecent(limit = 100)`
- `listForTarget(targetType, targetId)`

**Step 3: Verify**

Run:

```powershell
npm test -- src/server/repositories/operationLogs.test.ts
```

Expected:

```text
PASS.
```

### Task 3: Add Scan Run Records

**Files:**
- Modify: `src/server/schema.sql`
- Create: `src/server/repositories/scanRuns.ts`
- Test: `src/server/repositories/scanRuns.test.ts`

**Step 1: Write failing tests**

Cover:

- Start a scan run.
- Complete a scan run with counts.
- Mark a scan run failed.
- List recent scan runs.

Run:

```powershell
npm test -- src/server/repositories/scanRuns.test.ts
```

Expected:

```text
FAIL because repository/table does not exist.
```

**Step 2: Implement**

Add table:

```sql
CREATE TABLE IF NOT EXISTS scan_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  processed_count INTEGER NOT NULL DEFAULT 0,
  missing_count INTEGER NOT NULL DEFAULT 0,
  invalid_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  triggered_by TEXT NOT NULL
);
```

Repository methods:

- `start(triggeredBy)`
- `complete(id, counts)`
- `fail(id, errorMessage)`
- `listRecent(limit = 20)`

**Step 3: Verify**

Run:

```powershell
npm test -- src/server/repositories/scanRuns.test.ts
```

Expected:

```text
PASS.
```

## Phase 2: Backend Repair and Scan APIs

### Task 4: Record Audit Logs from Existing Core Actions

**Files:**
- Modify: `src/server/server.ts`
- Modify: `src/server/routes/approvals.ts`
- Modify: `src/server/routes/system.ts`
- Modify: `src/server/routes/users.ts`
- Modify: `src/server/files/watchSubmissions.ts`
- Test: `src/server/routes/approvals.test.ts`
- Test: `src/server/routes/users.test.ts`
- Test: `src/server/routes/system.test.ts`

**Step 1: Write failing tests**

Add API tests that assert operation logs are written when:

- A review is submitted.
- A file is marked printed.
- A user is created.
- A password is reset.
- Restart is requested.

Run:

```powershell
npm test -- src/server/routes/approvals.test.ts src/server/routes/users.test.ts src/server/routes/system.test.ts
```

Expected:

```text
FAIL because routes do not write operation logs.
```

**Step 2: Wire repository into server dependencies**

Create `OperationLogRepository` in `createServer`.

Pass it to relevant routes and watcher dependencies.

Use `req.user` for actor:

```ts
{
  actorUserId: req.user?.id ?? null,
  actorUsername: req.user?.username ?? null
}
```

**Step 3: Add log writes**

Minimum action coverage:

- `approval.reviewed`
- `approval.printed`
- `user.created`
- `user.updated`
- `user.password_reset`
- `system.restart_requested`
- `approval.created`
- `approval.file_missing`

**Step 4: Verify**

Run:

```powershell
npm test -- src/server/routes/approvals.test.ts src/server/routes/users.test.ts src/server/routes/system.test.ts
```

Expected:

```text
PASS.
```

### Task 5: Create Operation Log Routes

**Files:**
- Create: `src/server/routes/operationLogs.ts`
- Modify: `src/server/server.ts`
- Test: `src/server/routes/operationLogs.test.ts`

**Step 1: Write failing route tests**

Cover:

- Admin can list recent operation logs.
- Admin can list logs for an approval.
- Non-admin cannot list global logs.

Run:

```powershell
npm test -- src/server/routes/operationLogs.test.ts
```

Expected:

```text
FAIL because route does not exist.
```

**Step 2: Implement routes**

Routes:

```text
GET /api/operation-logs
GET /api/approvals/:id/operation-logs
```

Auth:

- `/api/operation-logs`: admin only.
- `/api/approvals/:id/operation-logs`: authenticated users can read for visible approval.

**Step 3: Verify**

Run:

```powershell
npm test -- src/server/routes/operationLogs.test.ts
```

Expected:

```text
PASS.
```

### Task 6: Add Approval Void API

**Files:**
- Modify: `src/server/repositories/approvals.ts`
- Modify: `src/server/routes/approvals.ts`
- Test: `src/server/routes/approvals.test.ts`

**Step 1: Write failing tests**

Cover:

- Admin can void an approval with a reason.
- Voided approval is not in reviewer queues.
- Non-admin cannot void.
- Empty reason is rejected.
- Operation log `approval.voided` is written.

Run:

```powershell
npm test -- src/server/routes/approvals.test.ts
```

Expected:

```text
FAIL because void API does not exist.
```

**Step 2: Implement repository method**

Add:

```ts
voidApproval(id: number): Approval
```

This sets status to `voided`.

**Step 3: Implement route**

Route:

```text
POST /api/approvals/:id/void
```

Body:

```json
{ "reason": "提交错版本" }
```

**Step 4: Verify**

Run:

```powershell
npm test -- src/server/routes/approvals.test.ts
```

Expected:

```text
PASS.
```

### Task 7: Add Rebind File and Retry Validation APIs

**Files:**
- Modify: `src/server/repositories/approvals.ts`
- Modify: `src/server/routes/approvals.ts`
- Modify: `src/server/files/pdfValidation.ts`
- Test: `src/server/routes/approvals.test.ts`

**Step 1: Write failing tests**

Cover:

- Admin can rebind a `file_missing` approval to an existing valid PDF.
- Rebind rejects missing path.
- Rebind rejects invalid PDF.
- Rebind restores status to `pending`.
- Retry validation converts invalid PDF to `pending` when file becomes valid.
- Operation logs are written.

Run:

```powershell
npm test -- src/server/routes/approvals.test.ts
```

Expected:

```text
FAIL because APIs do not exist.
```

**Step 2: Implement repository methods**

Add:

```ts
rebindFile(id: number, currentFilePath: string, status: ApprovalStatus = "pending"): Approval
markInvalidPdf(id: number): Approval
```

**Step 3: Implement routes**

Routes:

```text
POST /api/approvals/:id/rebind-file
POST /api/approvals/:id/retry-validation
```

Body for rebind:

```json
{ "filePath": "G:\\Nutstore\\图纸审批\\02-审批中\\项目A\\零件-a0A0.pdf" }
```

Security rule:

- For v2, require the file to exist and be readable.
- Prefer limiting to current `watch_root`; if outside `watch_root`, return `FILE_OUTSIDE_WATCH_ROOT`.

**Step 4: Verify**

Run:

```powershell
npm test -- src/server/routes/approvals.test.ts
```

Expected:

```text
PASS.
```

### Task 8: Mark Invalid PDF During Submission

**Files:**
- Modify: `src/server/files/watchSubmissions.ts`
- Modify: `src/server/files/watchSubmissions.test.ts`

**Step 1: Write failing tests**

Cover:

- A `.pdf` file without `%PDF-` creates an `invalid_pdf` approval.
- Invalid PDF does not enter reviewer task queue.
- Invalid PDF remains discoverable in all approvals.

Run:

```powershell
npm test -- src/server/files/watchSubmissions.test.ts
```

Expected:

```text
FAIL because invalid file content is not categorized at submission time.
```

**Step 2: Implement**

In `processSubmittedFile` after filename parsing and before moving to reviewing:

- Call `hasPdfHeader(filePath)`.
- If false, create approval with `status: "invalid_pdf"`.
- Do not move to `02-审批中` unless that behavior is explicitly needed later.
- Write operation log if repository is available in deps.

**Step 3: Verify**

Run:

```powershell
npm test -- src/server/files/watchSubmissions.test.ts
```

Expected:

```text
PASS.
```

### Task 9: Add Manual Scan API and Scan Records

**Files:**
- Modify: `src/server/files/watchSubmissions.ts`
- Modify: `src/server/routes/system.ts`
- Modify: `src/server/server.ts`
- Test: `src/server/routes/system.test.ts`

**Step 1: Write failing tests**

Cover:

- Admin can call `POST /api/system/scan-now`.
- Scan creates a `scan_runs` row.
- Scan returns processed/missing/invalid counts.
- Non-admin cannot scan.
- `GET /api/system/scan-runs` returns recent scans.

Run:

```powershell
npm test -- src/server/routes/system.test.ts
```

Expected:

```text
FAIL because scan routes do not exist.
```

**Step 2: Implement scan service**

Create a function that wraps:

- `scanSubmittedFiles`
- `scanMissingApprovalFiles`
- invalid PDF counts if available

Persist start/complete/failure in `scan_runs`.

**Step 3: Implement routes**

Routes:

```text
POST /api/system/scan-now
GET /api/system/scan-runs
```

**Step 4: Verify**

Run:

```powershell
npm test -- src/server/routes/system.test.ts
```

Expected:

```text
PASS.
```

### Task 10: Add SMTP Test API

**Files:**
- Modify: `src/server/routes/settings.ts`
- Modify: `src/server/notifications/email.ts`
- Test: `src/server/routes/settings.test.ts`
- Test: `src/server/notifications/email.test.ts`

**Step 1: Write failing tests**

Cover:

- Admin can send SMTP test with a recipient.
- Missing recipient is rejected.
- SMTP failure returns readable error.
- Operation log is written for success/failure.

Run:

```powershell
npm test -- src/server/routes/settings.test.ts src/server/notifications/email.test.ts
```

Expected:

```text
FAIL because test endpoint does not exist.
```

**Step 2: Implement email test helper**

Add helper:

```ts
sendTestEmail(settings, to)
```

Use existing SMTP settings and transport creation patterns.

**Step 3: Implement route**

Route:

```text
POST /api/settings/test-smtp
```

Body:

```json
{ "to": "test@example.com" }
```

**Step 4: Verify**

Run:

```powershell
npm test -- src/server/routes/settings.test.ts src/server/notifications/email.test.ts
```

Expected:

```text
PASS.
```

## Phase 3: Frontend Management UI

### Task 11: Extend API Client

**Files:**
- Modify: `src/client/api.ts`
- Test: Build check via `npm run build`

**Step 1: Add API client types and functions**

Add types:

- `OperationLog`
- `ScanRun`
- Extended `Approval.status`

Add functions:

- `voidApproval(id, reason)`
- `rebindApprovalFile(id, filePath)`
- `retryApprovalValidation(id)`
- `scanNow()`
- `listScanRuns()`
- `listOperationLogs()`
- `listApprovalOperationLogs(id)`
- `testSmtp(to)`

**Step 2: Verify**

Run:

```powershell
npm run build
```

Expected:

```text
Build passes.
```

### Task 12: Add Abnormal Status Filters to All Approvals

**Files:**
- Modify: `src/client/pages/ApprovalsPage.tsx`
- Modify: `src/client/widgets/ApprovalTable.tsx`
- Modify: `src/client/widgets/StatusChip.tsx`

**Step 1: Implement filters**

Add filter options:

- PDF 无效
- 文件丢失
- 文件名异常
- 已作废

Keep table dense and scannable.

**Step 2: Verify**

Run:

```powershell
npm run build
```

Expected:

```text
Build passes.
```

Manual check:

- Open all approvals.
- Filter by each abnormal status.

### Task 13: Add Detail Page Repair Panel and Timeline

**Files:**
- Modify: `src/client/pages/ApprovalDetailPage.tsx`
- Modify: `src/client/styles.css`

**Step 1: Add operation log loading**

Load:

```ts
listApprovalOperationLogs(id)
```

Render as a compact timeline in the side panel or below the status panel.

**Step 2: Add repair actions**

For `file_missing`:

- Input for server PDF path.
- Button: `重新绑定文件`
- Button: `作废`

For `invalid_pdf`:

- Input for server PDF path.
- Button: `替换 PDF`
- Button: `重新校验`
- Button: `作废`

For `filename_invalid`:

- Button: `作废`

**Step 3: Add error and success feedback**

Use existing error/success styling.

**Step 4: Verify**

Run:

```powershell
npm run build
```

Expected:

```text
Build passes.
```

Manual check:

- Detail page shows timeline.
- Abnormal states show correct repair controls.

### Task 14: Add Scan and Email Management UI

**Files:**
- Modify: `src/client/pages/SettingsPage.tsx`
- Modify: `src/client/styles.css`

**Step 1: Add scan section**

In System Management:

- Show recent scan runs.
- Add `立即重新扫描` button.
- Show processed/missing/invalid counts.

**Step 2: Add email test section**

Add:

- Test recipient input.
- `发送测试邮件` button.
- Success/failure message.

**Step 3: Add notification reset**

Add:

- `清除本机通知记录` button.
- It removes `pdf_approval_notified_task_ids` from `localStorage`.

**Step 4: Verify**

Run:

```powershell
npm run build
```

Expected:

```text
Build passes.
```

Manual check:

- Scan button returns visible result.
- Email test shows a clear response.
- Notification reset clears local storage key.

### Task 15: Add Global Operation Log UI

**Files:**
- Modify: `src/client/pages/SettingsPage.tsx`
- Modify: `src/client/styles.css`

**Step 1: Add operation log tab**

Render recent logs:

- Time
- Actor
- Action
- Target
- Message

Keep rows compact and readable.

**Step 2: Verify**

Run:

```powershell
npm run build
```

Expected:

```text
Build passes.
```

Manual check:

- Logs show after review, scan, user action, restart, or repair.

## Phase 4: Backup, Documentation, and Full Verification

### Task 16: Add Database Backup

**Files:**
- Create: `scripts/backup-database.ps1`
- Modify: `docs/deploy-windows-lan.md`
- Optional Modify: `src/server/routes/system.ts`
- Optional Modify: `src/client/pages/SettingsPage.tsx`

**Step 1: Add script**

Create a PowerShell script that:

- Reads `data/pdf-approval.sqlite`.
- Creates `backups` directory.
- Copies sqlite, wal, and shm files when present.
- Names backup with timestamp.

Example output:

```text
Backup created: backups\pdf-approval-20260616-150000
```

**Step 2: Decide route scope**

Minimum v2:

- Script and docs are enough.

Optional:

- Add admin endpoint `POST /api/system/backup`.
- Add UI button.

**Step 3: Verify**

Run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\backup-database.ps1
```

Expected:

```text
Backup files created under backups.
```

### Task 17: Update Documentation

**Files:**
- Modify: `docs/v1-implementation-summary.md` or create `docs/v2-implementation-summary.md`
- Modify: `docs/verification.md`
- Modify: `docs/deploy-windows-lan.md`

**Step 1: Create v2 summary**

Document:

- New statuses.
- Repair workflow.
- Audit logs.
- Manual scan.
- SMTP test.
- Backup script.

**Step 2: Update verification log**

Record:

- Test command results.
- Build result.
- Manual smoke result.

**Step 3: Update deploy doc**

Add:

- Backup procedure.
- Scan troubleshooting.
- SMTP test procedure.
- Common abnormal states and repair steps.

### Task 18: Full Regression and Manual Smoke

**Files:**
- No code files unless bugs are found.
- Modify: `docs/verification.md`

**Step 1: Run full tests**

Run:

```powershell
npm test
```

Expected:

```text
All test files pass.
```

**Step 2: Run production build**

Run:

```powershell
npm run build
```

Expected:

```text
Build passes.
```

**Step 3: Restart service**

Run or use UI:

```text
POST /api/system/restart
```

Expected:

```text
GET /health returns {"ok":true}
```

**Step 4: Manual smoke checklist**

Verify:

1. Normal PDF submission creates pending approval.
2. Supervisor approves.
3. Process approves.
4. Approval moves to待打印.
5. Printer/admin marks printed.
6. Invalid PDF creates `invalid_pdf`.
7. Invalid PDF can be rebound to valid PDF and returns to `pending`.
8. Deleting a pending file creates `file_missing`.
9. `file_missing` can be rebound.
10. Wrong approval can be voided with reason.
11. Operation timeline shows actions.
12. Manual scan creates a scan run.
13. SMTP test gives visible success or failure.
14. Backup script creates backup files.

**Step 5: Record evidence**

Update `docs/verification.md` with:

- Test count.
- Build result.
- Manual smoke result.
- Known remaining limitations.

## Final Delivery Checklist

- `npm test` passes.
- `npm run build` passes.
- Service restarts and `/health` is OK.
- Abnormal approval repair works.
- Operation logs are visible in detail and admin pages.
- Manual scan works.
- SMTP test endpoint works.
- Backup script works.
- Documentation updated.

## Suggested Checkpoint Order

If Git is initialized later, use these commit checkpoints:

1. `feat: add v2 audit and scan data model`
2. `feat: add approval repair APIs`
3. `feat: add manual scan and smtp test APIs`
4. `feat: add v2 admin repair UI`
5. `feat: add operation log UI`
6. `docs: document v2 operations and verification`
