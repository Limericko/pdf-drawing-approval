# PDF 图纸审批系统第三版 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build V3 so designers can upload drawings from the web, place visible signature boxes, have designer/supervisor/process signatures automatically stamped into a new signed PDF after approval, and give admins production operations plus traceability tools.

**Architecture:** Keep the existing Node 24 + Express + React/Vite + SQLite system. Add upload, signature assets, signature placement, signed-PDF generation, comments, reports, and diagnostics as modular extensions around the existing approval workflow instead of rewriting the watcher-based directory flow.

**Tech Stack:** Node 24 built-in `node:sqlite`, TypeScript, Express, React, Vite, chokidar v4, nodemailer, Vitest, Supertest. Prefer a pure JavaScript PDF library such as `pdf-lib` for visible PNG stamping to avoid Windows native build dependencies.

---

## Preconditions

- Work from `G:\Personal documents\code\PDF审批`.
- Read `docs/plans/2026-06-16-v3-design.md` before implementation.
- Do not reintroduce `better-sqlite3`.
- Keep `chokidar@4` root-watch plus code filtering and the 10-second fallback scan.
- Keep Windows server directory browser as the primary watch-root selection path.
- Preserve the fixed parallel supervisor + process review model.
- Use TDD for behavior changes.
- Run targeted tests after each task group.
- Run `npm test` and `npm run build` before final delivery.
- This workspace is not currently a Git repository. Treat commit steps as checkpoints only unless Git is initialized later.

## Phase 1: Data Model and Signature Domain

### Task 1: Extend Approval Schema for V3 Metadata

**Files:**
- Modify: `src/server/schema.sql`
- Modify: `src/server/db.ts`
- Modify: `src/server/domain/approvals.ts`
- Modify: `src/server/repositories/approvals.ts`
- Modify: `src/client/api.ts`
- Test: `src/server/repositories/approvals.test.ts`

**Step 1: Write failing repository tests**

Add tests that create approvals with the new V3 fields:

- `submitted_by_user_id`
- `source`
- `original_file_hash`
- `signed_file_path`
- `signed_file_hash`
- `signed_at`
- `signature_status`
- `signature_error`

Also test that old approvals still map with safe defaults:

- `source = "folder_watch"` when omitted.
- `signature_status = "not_required"` or `null` according to final implementation choice.

Run:

```powershell
npm test -- src/server/repositories/approvals.test.ts
```

Expected:

```text
FAIL because the schema and mapper do not expose V3 fields yet.
```

**Step 2: Implement schema extension**

Add nullable or defaulted columns to `approvals`:

```sql
submitted_by_user_id INTEGER,
source TEXT NOT NULL DEFAULT 'folder_watch' CHECK (source IN ('web_upload', 'folder_watch')),
original_file_hash TEXT,
signed_file_path TEXT,
signed_file_hash TEXT,
signed_at TEXT,
signature_status TEXT NOT NULL DEFAULT 'not_required' CHECK (signature_status IN ('not_required', 'placement_required', 'pending', 'ready', 'generated', 'failed')),
signature_error TEXT
```

Update migration logic in `src/server/db.ts` so existing V1/V2 databases receive these columns without losing data.

**Step 3: Update domain and repository mapping**

Extend `Approval` and `CreateApprovalInput` with V3 fields.

Add repository methods:

```ts
setSignatureStatus(id, status, error?)
setSignedFile(id, signedFilePath, signedFileHash)
```

**Step 4: Verify**

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

**Checkpoint:** `feat: extend approval metadata for v3 signatures`

### Task 2: Add Signature Asset Repository

**Files:**
- Modify: `src/server/schema.sql`
- Modify: `src/server/db.ts`
- Create: `src/server/repositories/signatureAssets.ts`
- Test: `src/server/repositories/signatureAssets.test.ts`

**Step 1: Write failing tests**

Cover:

- Creating a signature asset for a user.
- Fetching active signature for a user.
- Replacing an active signature deactivates older active signatures.
- Listing signature status for all users.

Run:

```powershell
npm test -- src/server/repositories/signatureAssets.test.ts
```

Expected:

```text
FAIL because table and repository do not exist.
```

**Step 2: Add schema**

Add:

```sql
CREATE TABLE IF NOT EXISTS signature_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('uploaded_png', 'drawn_png')),
  file_path TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_signature_assets_user_id ON signature_assets(user_id, active);
```

**Step 3: Implement repository**

Add methods:

```ts
createForUser(input)
getActiveForUser(userId)
replaceActiveForUser(input)
listUserSignatureStatus()
```

**Step 4: Verify**

Run:

```powershell
npm test -- src/server/repositories/signatureAssets.test.ts
```

Expected:

```text
PASS.
```

**Checkpoint:** `feat: add signature asset storage`

### Task 3: Add Signature Placement Repository

**Files:**
- Modify: `src/server/schema.sql`
- Create: `src/server/repositories/signaturePlacements.ts`
- Test: `src/server/repositories/signaturePlacements.test.ts`

**Step 1: Write failing tests**

Cover:

- Upserting designer/supervisor/process placements.
- Rejecting unsupported roles.
- Rejecting out-of-range ratios.
- Listing placements for an approval.
- Verifying all three required placements exist.

Run:

```powershell
npm test -- src/server/repositories/signaturePlacements.test.ts
```

Expected:

```text
FAIL because table and repository do not exist.
```

**Step 2: Add schema**

Add:

```sql
CREATE TABLE IF NOT EXISTS signature_placements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  approval_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('designer', 'supervisor', 'process')),
  page_number INTEGER NOT NULL,
  x_ratio REAL NOT NULL,
  y_ratio REAL NOT NULL,
  width_ratio REAL NOT NULL,
  height_ratio REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(approval_id, role),
  FOREIGN KEY (approval_id) REFERENCES approvals(id)
);
```

**Step 3: Implement repository**

Add:

```ts
upsertMany(approvalId, placements)
listForApproval(approvalId)
hasRequiredPlacements(approvalId)
```

Validate:

- `page_number >= 1`
- `0 <= x_ratio <= 1`
- `0 <= y_ratio <= 1`
- `0 < width_ratio <= 1`
- `0 < height_ratio <= 1`
- `x_ratio + width_ratio <= 1`
- `y_ratio + height_ratio <= 1`

**Step 4: Verify**

Run:

```powershell
npm test -- src/server/repositories/signaturePlacements.test.ts
```

Expected:

```text
PASS.
```

**Checkpoint:** `feat: add signature placement storage`

### Task 4: Add File Hash Utility

**Files:**
- Create: `src/server/files/fileHash.ts`
- Test: `src/server/files/fileHash.test.ts`

**Step 1: Write failing tests**

Cover:

- SHA-256 hash is stable for same content.
- Different content produces different hash.
- Missing file returns a controlled error.

Run:

```powershell
npm test -- src/server/files/fileHash.test.ts
```

Expected:

```text
FAIL because utility does not exist.
```

**Step 2: Implement utility**

Implement:

```ts
export async function sha256File(filePath: string): Promise<string>
```

Use `node:crypto` and `node:fs`.

**Step 3: Verify**

Run:

```powershell
npm test -- src/server/files/fileHash.test.ts
```

Expected:

```text
PASS.
```

**Checkpoint:** `feat: add file hashing utility`

## Phase 2: Web Upload Submission

### Task 5: Add Temporary Upload Storage

**Files:**
- Create: `src/server/uploads/tempUploads.ts`
- Test: `src/server/uploads/tempUploads.test.ts`

**Step 1: Write failing tests**

Cover:

- Save an uploaded PDF buffer to temp storage.
- Return a stable upload ID.
- Resolve upload ID to a temp path.
- Reject unknown upload IDs.
- Clean old temp uploads.

Run:

```powershell
npm test -- src/server/uploads/tempUploads.test.ts
```

Expected:

```text
FAIL because temp upload service does not exist.
```

**Step 2: Implement service**

Use a local temp folder under:

```text
data/uploads/tmp
```

Expose:

```ts
saveTempUpload(input)
getTempUpload(uploadId)
deleteTempUpload(uploadId)
cleanupTempUploads(maxAgeMs)
```

**Step 3: Verify**

Run:

```powershell
npm test -- src/server/uploads/tempUploads.test.ts
```

Expected:

```text
PASS.
```

**Checkpoint:** `feat: add temporary upload storage`

### Task 6: Add Submission Upload APIs

**Files:**
- Create: `src/server/routes/submissions.ts`
- Modify: `src/server/server.ts`
- Test: `src/server/routes/submissions.test.ts`

**Step 1: Write failing route tests**

Cover:

- Designer/admin can upload a valid PDF.
- Upload parses `零件名-a0A0.pdf`.
- Invalid PDF header is rejected.
- Non-PDF extension is rejected.
- Confirm submission creates approval with `source = "web_upload"`.
- Confirm submission writes file to `02-审批中\项目名\标准文件名.pdf`.
- Confirm submission saves all three signature placements.
- Confirm submission rejects duplicate project/part/version.
- Confirm submission rejects missing required placement roles.

Run:

```powershell
npm test -- src/server/routes/submissions.test.ts
```

Expected:

```text
FAIL because route does not exist.
```

**Step 2: Implement routes**

Routes:

```text
POST /api/submissions/upload
POST /api/submissions
```

Use JSON for confirmation and multipart for upload. If adding multipart dependency is needed, prefer a maintained pure JS package with no native build. Document the dependency choice before installing.

**Step 3: Add operation logs**

Write:

- `submission.uploaded`
- `approval.created`
- `signature.placements_saved`

**Step 4: Verify**

Run:

```powershell
npm test -- src/server/routes/submissions.test.ts
npm run build
```

Expected:

```text
Route tests pass.
Build passes.
```

**Checkpoint:** `feat: add web submission APIs`

### Task 7: Keep Folder Watch Compatibility

**Files:**
- Modify: `src/server/files/watchSubmissions.ts`
- Test: `src/server/files/watchSubmissions.test.ts`

**Step 1: Write failing tests**

Cover:

- Watcher-created approvals keep `source = "folder_watch"`.
- Valid watcher-created approvals get `signature_status = "placement_required"` if V3 signing is expected.
- Existing invalid PDF and file-missing behavior remains unchanged.

Run:

```powershell
npm test -- src/server/files/watchSubmissions.test.ts
```

Expected:

```text
FAIL if V3 source/signature fields are not set correctly.
```

**Step 2: Implement minimal updates**

When creating approvals from watcher:

- Set `source = "folder_watch"`.
- Set `signature_status = "placement_required"` for normal valid submissions.
- Keep existing abnormal statuses unchanged.

**Step 3: Verify**

Run:

```powershell
npm test -- src/server/files/watchSubmissions.test.ts
```

Expected:

```text
PASS.
```

**Checkpoint:** `feat: preserve folder submissions in v3`

## Phase 3: Signature Assets and PDF Stamping

### Task 8: Add Signature Asset APIs

**Files:**
- Create: `src/server/routes/signatures.ts`
- Modify: `src/server/server.ts`
- Test: `src/server/routes/signatures.test.ts`

**Step 1: Write failing route tests**

Cover:

- Authenticated user can fetch own signature status.
- Authenticated user can upload PNG signature.
- Authenticated user can save drawn PNG data URL.
- Non-PNG upload is rejected.
- Admin can list signature status for users.

Run:

```powershell
npm test -- src/server/routes/signatures.test.ts
```

Expected:

```text
FAIL because routes do not exist.
```

**Step 2: Implement routes**

Routes:

```text
GET /api/signatures/me
POST /api/signatures/me/upload
POST /api/signatures/me/draw
GET /api/signatures/status
```

Store files under:

```text
data/signatures/{userId}/signature-{timestamp}.png
```

**Step 3: Verify**

Run:

```powershell
npm test -- src/server/routes/signatures.test.ts
npm run build
```

Expected:

```text
Route tests pass.
Build passes.
```

**Checkpoint:** `feat: add signature asset APIs`

### Task 9: Add PDF Stamping Service

**Files:**
- Modify: `package.json`
- Create: `src/server/pdf/signPdf.ts`
- Test: `src/server/pdf/signPdf.test.ts`

**Step 1: Add dependency**

Install a pure JS PDF library:

```powershell
npm install pdf-lib --registry=https://registry.npmmirror.com
```

If install fails due to network, retry with the default registry only if acceptable for the environment. Do not add native PDF dependencies.

**Step 2: Write failing tests**

Use a small generated PDF fixture in the test. Cover:

- Stamping one PNG into a PDF creates a valid output PDF.
- Stamping three roles creates a larger non-empty PDF.
- Missing signature image returns a controlled error.
- Out-of-range page number returns a controlled error.

Run:

```powershell
npm test -- src/server/pdf/signPdf.test.ts
```

Expected:

```text
FAIL because service does not exist.
```

**Step 3: Implement service**

Implement:

```ts
export async function generateSignedPdf(input: {
  sourcePdfPath: string;
  outputPdfPath: string;
  stamps: Array<{
    imagePath: string;
    pageNumber: number;
    xRatio: number;
    yRatio: number;
    widthRatio: number;
    heightRatio: number;
  }>;
}): Promise<void>
```

Convert ratio coordinates to PDF page coordinates. Account for PDF coordinate origin being bottom-left.

**Step 4: Verify**

Run:

```powershell
npm test -- src/server/pdf/signPdf.test.ts
```

Expected:

```text
PASS.
```

**Checkpoint:** `feat: add signed pdf generation service`

### Task 10: Trigger Signing After Parallel Approval

**Files:**
- Modify: `src/server/routes/approvals.ts`
- Create: `src/server/services/signingWorkflow.ts`
- Test: `src/server/routes/approvals.test.ts`
- Test: `src/server/services/signingWorkflow.test.ts`

**Step 1: Write failing service tests**

Cover:

- Does nothing while only one reviewer approved.
- Generates signed PDF after supervisor and process both approve.
- Uses designer, supervisor, and process signature assets.
- Sets `signature_status = "generated"` on success.
- Sets `signature_status = "failed"` and records error if a signature asset is missing.
- Writes operation logs for success and failure.

Run:

```powershell
npm test -- src/server/services/signingWorkflow.test.ts src/server/routes/approvals.test.ts
```

Expected:

```text
FAIL because signing workflow does not exist.
```

**Step 2: Implement signing workflow**

Implement:

```ts
tryGenerateSignedPdfForApproval(approvalId, actor)
```

Flow:

1. Load approval.
2. Require `status = "approved_for_print"`.
3. Load placements.
4. Load designer, supervisor, process signature assets.
5. Generate conflict-safe output path under `04-已通过待打印\项目名\`.
6. Stamp PDF.
7. Hash output.
8. Update approval signed fields.
9. Write logs.

**Step 3: Wire after review**

In `POST /api/approvals/:id/review`, after both approvals cause `approved_for_print`, call signing workflow.

Important: preserve existing file movement behavior or adjust it so the original approval PDF is not overwritten by the signed output. If needed, split the existing move service into original-file movement and signed-file output.

**Step 4: Verify**

Run:

```powershell
npm test -- src/server/services/signingWorkflow.test.ts src/server/routes/approvals.test.ts
npm run build
```

Expected:

```text
Tests pass.
Build passes.
```

**Checkpoint:** `feat: generate signed pdf after approval`

### Task 11: Add Signed File and Retry APIs

**Files:**
- Modify: `src/server/routes/approvals.ts`
- Test: `src/server/routes/approvals.test.ts`

**Step 1: Write failing tests**

Cover:

- `GET /api/approvals/:id/signed-file` returns the signed PDF.
- Missing signed file returns 404.
- Admin can retry generation with `POST /api/approvals/:id/generate-signed-pdf`.
- Non-admin cannot retry generation.

Run:

```powershell
npm test -- src/server/routes/approvals.test.ts
```

Expected:

```text
FAIL because routes do not exist.
```

**Step 2: Implement routes**

Add:

```text
GET /api/approvals/:id/signed-file
POST /api/approvals/:id/generate-signed-pdf
```

**Step 3: Verify**

Run:

```powershell
npm test -- src/server/routes/approvals.test.ts
```

Expected:

```text
PASS.
```

**Checkpoint:** `feat: add signed pdf retry and download APIs`

## Phase 4: Frontend Upload, Placement, and Signature UI

### Task 12: Extend API Client

**Files:**
- Modify: `src/client/api.ts`
- Verify: `npm run build`

**Step 1: Add types**

Add:

- `SignatureAsset`
- `SignaturePlacement`
- `SubmissionUploadResult`
- `SignatureStatus`
- V3 fields on `Approval`

**Step 2: Add client functions**

Add:

```ts
uploadSubmissionPdf(file)
confirmSubmission(input)
getMySignature()
uploadMySignature(file)
saveDrawnSignature(dataUrl)
listSignatureStatuses()
getSignedFileUrl(approvalId)
retryGenerateSignedPdf(approvalId)
```

**Step 3: Verify**

Run:

```powershell
npm run build
```

Expected:

```text
Build passes.
```

**Checkpoint:** `feat: add v3 client api methods`

### Task 13: Build Submit Drawing Page

**Files:**
- Create: `src/client/pages/SubmitDrawingPage.tsx`
- Modify: `src/client/App.tsx`
- Modify: `src/client/styles.css`
- Verify: `npm run build`

**Step 1: Create page route**

Add a navigation entry visible to `designer` and `admin`.

**Step 2: Build upload form**

Fields:

- PDF file.
- Project name.
- Part name.
- Version.

Behavior:

- Upload file first.
- Show parsed result.
- Allow edits before confirm.

**Step 3: Add PDF preview placeholder**

Use existing file endpoint or a temporary preview endpoint from upload API. If temporary preview endpoint is missing, add it with route tests before wiring UI.

**Step 4: Add submit validation**

Block submit when:

- No upload.
- Missing project/part/version.
- Missing any of three signature boxes.

**Step 5: Verify**

Run:

```powershell
npm run build
```

Expected:

```text
Build passes.
```

Manual check:

- Login as designer.
- Page appears.
- Upload feedback and parsed filename render in Chinese.

**Checkpoint:** `feat: add drawing submission page`

### Task 14: Add Signature Box Placement UI

**Files:**
- Create: `src/client/widgets/SignaturePlacementEditor.tsx`
- Modify: `src/client/pages/SubmitDrawingPage.tsx`
- Modify: `src/client/styles.css`
- Verify: `npm run build`

**Step 1: Build editor component**

Props:

```ts
{
  placements: SignaturePlacement[];
  onChange: (placements: SignaturePlacement[]) => void;
}
```

Render three boxes:

- 设计
- 主管
- 工艺

**Step 2: Implement drag**

Use pointer events. Convert movement to ratios relative to preview container.

**Step 3: Implement resize**

Use a corner handle. Clamp ratios so the box remains inside the page.

**Step 4: Add reset defaults**

Provide a compact button to reset boxes to bottom-right default positions.

**Step 5: Verify**

Run:

```powershell
npm run build
```

Expected:

```text
Build passes.
```

Manual check:

- Drag each box.
- Resize each box.
- Submit payload contains three ratio placements.

**Checkpoint:** `feat: add signature placement editor`

### Task 15: Add My Signature UI

**Files:**
- Create: `src/client/pages/MySignaturePage.tsx`
- Modify: `src/client/App.tsx`
- Modify: `src/client/styles.css`
- Verify: `npm run build`

**Step 1: Add page route**

Visible to all authenticated users.

**Step 2: Add PNG upload**

Allow selecting a PNG and uploading it.

**Step 3: Add drawing canvas**

Use a plain `<canvas>` with pointer events.

Controls:

- Clear.
- Save.

**Step 4: Show current signature preview**

Show active signature if configured.

**Step 5: Verify**

Run:

```powershell
npm run build
```

Expected:

```text
Build passes.
```

Manual check:

- Upload PNG.
- Draw signature.
- Save.
- Refresh page and see current signature.

**Checkpoint:** `feat: add my signature page`

### Task 16: Update Approval Detail and Print Flow

**Files:**
- Modify: `src/client/pages/ApprovalDetailPage.tsx`
- Modify: `src/client/widgets/ApprovalTable.tsx`
- Modify: `src/client/widgets/status.ts`
- Modify: `src/client/styles.css`
- Verify: `npm run build`

**Step 1: Show signature status**

Add status label:

- 未启用签名
- 待放置签名
- 等待自动签名
- 签名已生成
- 签名失败

**Step 2: Add signed PDF actions**

If signed file exists:

- Show `打开签后 PDF`.
- Keep original PDF preview available.

If failed:

- Show error.
- Admin sees retry button.

**Step 3: Protect print flow**

On approved-for-print records:

- Prefer signed PDF.
- If signature required but missing, show warning instead of silently opening original PDF.

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

- Approved record with signed file opens signed PDF.
- Failed record shows retry.

**Checkpoint:** `feat: show signed pdf workflow in approval detail`

## Phase 5: Collaboration and Traceability

### Task 17: Add Approval Comments Repository and APIs

**Files:**
- Modify: `src/server/schema.sql`
- Create: `src/server/repositories/approvalComments.ts`
- Create: `src/server/routes/approvalComments.ts`
- Modify: `src/server/server.ts`
- Test: `src/server/repositories/approvalComments.test.ts`
- Test: `src/server/routes/approvalComments.test.ts`

**Step 1: Write failing tests**

Cover:

- Create comment.
- Create issue.
- List comments for approval.
- Resolve issue.
- Authenticated users can comment.
- Anonymous users cannot comment.

Run:

```powershell
npm test -- src/server/repositories/approvalComments.test.ts src/server/routes/approvalComments.test.ts
```

Expected:

```text
FAIL because comments do not exist.
```

**Step 2: Add schema**

Add:

```sql
CREATE TABLE IF NOT EXISTS approval_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  approval_id INTEGER NOT NULL,
  author_user_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('comment', 'issue')),
  message TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT,
  FOREIGN KEY (approval_id) REFERENCES approvals(id),
  FOREIGN KEY (author_user_id) REFERENCES users(id)
);
```

**Step 3: Implement APIs**

Routes:

```text
GET /api/approvals/:id/comments
POST /api/approvals/:id/comments
POST /api/approvals/:id/comments/:commentId/resolve
```

**Step 4: Verify**

Run:

```powershell
npm test -- src/server/repositories/approvalComments.test.ts src/server/routes/approvalComments.test.ts
```

Expected:

```text
PASS.
```

**Checkpoint:** `feat: add approval comments and issues`

### Task 18: Add Comments UI

**Files:**
- Modify: `src/client/api.ts`
- Modify: `src/client/pages/ApprovalDetailPage.tsx`
- Modify: `src/client/styles.css`
- Verify: `npm run build`

**Step 1: Extend API client**

Add:

```ts
listApprovalComments(approvalId)
createApprovalComment(approvalId, input)
resolveApprovalComment(approvalId, commentId)
```

**Step 2: Render comments panel**

In approval detail:

- List comments and issues.
- Add form with kind selector.
- Add resolve action for unresolved issues.

**Step 3: Verify**

Run:

```powershell
npm run build
```

Expected:

```text
Build passes.
```

Manual check:

- Add comment.
- Add issue.
- Resolve issue.

**Checkpoint:** `feat: add approval collaboration UI`

### Task 19: Add CSV Traceability Report

**Files:**
- Create: `src/server/routes/reports.ts`
- Modify: `src/server/server.ts`
- Test: `src/server/routes/reports.test.ts`
- Modify: `src/client/api.ts`
- Modify: `src/client/pages/SettingsPage.tsx`

**Step 1: Write failing route tests**

Cover:

- Admin can export CSV.
- Non-admin cannot export.
- CSV includes approval, reviewer, signature, hash, archive fields.
- Filters by project/status/date work.

Run:

```powershell
npm test -- src/server/routes/reports.test.ts
```

Expected:

```text
FAIL because report route does not exist.
```

**Step 2: Implement route**

Add:

```text
GET /api/reports/approvals.csv
```

Return `text/csv; charset=utf-8`.

**Step 3: Add admin UI entry**

In system management:

- Add project/status/date filters.
- Add export button.

**Step 4: Verify**

Run:

```powershell
npm test -- src/server/routes/reports.test.ts
npm run build
```

Expected:

```text
Tests pass.
Build passes.
```

**Checkpoint:** `feat: add traceability csv export`

## Phase 6: Production Operations

### Task 20: Add Diagnostics API

**Files:**
- Create: `src/server/services/diagnostics.ts`
- Modify: `src/server/routes/system.ts`
- Test: `src/server/services/diagnostics.test.ts`
- Test: `src/server/routes/system.test.ts`

**Step 1: Write failing tests**

Cover:

- Reports database read/write status.
- Reports watch root existence.
- Reports standard folder status.
- Reports write permissions for managed folders.
- Includes latest scan run.
- Includes latest backup when available.
- Admin-only route.

Run:

```powershell
npm test -- src/server/services/diagnostics.test.ts src/server/routes/system.test.ts
```

Expected:

```text
FAIL because diagnostics service does not exist.
```

**Step 2: Implement service**

Add:

```ts
getSystemDiagnostics(deps)
```

Return a JSON object with status and itemized checks.

**Step 3: Add route**

Add:

```text
GET /api/system/diagnostics
```

**Step 4: Verify**

Run:

```powershell
npm test -- src/server/services/diagnostics.test.ts src/server/routes/system.test.ts
```

Expected:

```text
PASS.
```

**Checkpoint:** `feat: add system diagnostics`

### Task 21: Add Backup Records and Admin Backup API

**Files:**
- Modify: `src/server/schema.sql`
- Create: `src/server/repositories/backups.ts`
- Create: `src/server/services/backupService.ts`
- Modify: `src/server/routes/system.ts`
- Test: `src/server/repositories/backups.test.ts`
- Test: `src/server/services/backupService.test.ts`
- Test: `src/server/routes/system.test.ts`

**Step 1: Write failing tests**

Cover:

- Backup service copies SQLite/WAL/SHM files.
- Backup record is created on success.
- Backup record captures failure.
- Admin can list backups.
- Admin can trigger backup.

Run:

```powershell
npm test -- src/server/repositories/backups.test.ts src/server/services/backupService.test.ts src/server/routes/system.test.ts
```

Expected:

```text
FAIL because backup records/API do not exist.
```

**Step 2: Add schema**

Add:

```sql
CREATE TABLE IF NOT EXISTS backup_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  backup_path TEXT,
  error_message TEXT,
  triggered_by TEXT NOT NULL
);
```

**Step 3: Implement service and routes**

Routes:

```text
POST /api/system/backup
GET /api/system/backups
```

Keep the existing PowerShell backup script and make the service match its folder naming convention.

**Step 4: Verify**

Run:

```powershell
npm test -- src/server/repositories/backups.test.ts src/server/services/backupService.test.ts src/server/routes/system.test.ts
```

Expected:

```text
PASS.
```

**Checkpoint:** `feat: add backup records and admin backup api`

### Task 22: Add Operations UI

**Files:**
- Modify: `src/client/api.ts`
- Modify: `src/client/pages/SettingsPage.tsx`
- Modify: `src/client/styles.css`
- Verify: `npm run build`

**Step 1: Extend API client**

Add:

```ts
getSystemDiagnostics()
runBackup()
listBackups()
listSignatureStatuses()
```

**Step 2: Add diagnostics panel**

Show:

- Overall status.
- Database.
- Watch root.
- Standard folders.
- Write permissions.
- Latest scan.
- Latest backup.

**Step 3: Add backup panel**

Show:

- Run backup button.
- Recent backup list.
- Failure message if any.

**Step 4: Add signature status panel**

Show:

- User.
- Role.
- Signature configured or missing.

**Step 5: Verify**

Run:

```powershell
npm run build
```

Expected:

```text
Build passes.
```

Manual check:

- Admin sees diagnostics.
- Backup button creates a backup.
- Missing signatures are visible.

**Checkpoint:** `feat: add production operations ui`

## Phase 7: Documentation and Verification

### Task 23: Update Documentation

**Files:**
- Create: `docs/v3-implementation-summary.md`
- Modify: `docs/deploy-windows-lan.md`
- Modify: `docs/verification.md`

**Step 1: Write V3 summary**

Document:

- Web upload.
- Signature asset setup.
- Signature placement.
- Automatic signed PDF generation.
- Comments/issues.
- CSV report.
- Diagnostics and backup.

**Step 2: Update deployment doc**

Add:

- V3 startup checks.
- Signature setup checklist.
- Backup/restore procedure.
- Windows service notes.
- Common failure handling.

**Step 3: Update verification doc**

Record:

- Test commands.
- Build command.
- Manual smoke checklist.
- Known limitations.

**Checkpoint:** `docs: document v3 operations and verification`

### Task 24: Full Regression and Smoke Test

**Files:**
- Modify only if bugs are found.
- Update: `docs/verification.md`

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

**Step 3: Start or restart latest service**

Run:

```powershell
npm run dev
```

or use the existing restart endpoint if the service is already running.

Expected:

```text
GET /health returns {"ok":true}
```

**Step 4: Manual smoke checklist**

Verify:

1. Login as admin.
2. Configure watch root.
3. Configure signatures for designer, supervisor, process.
4. Login as designer.
5. Upload valid PDF.
6. Confirm parsed part/version.
7. Place design/supervisor/process signature boxes.
8. Submit approval.
9. Login as supervisor and approve.
10. Login as process and approve.
11. Confirm signed PDF is generated.
12. Confirm original approval PDF is not overwritten.
13. Open signed PDF and visually verify three signatures.
14. Mark printed and confirm archive.
15. Add comment and issue.
16. Resolve issue.
17. Export CSV report.
18. Run diagnostics.
19. Run backup.
20. Submit missing-signature scenario and confirm failure state plus retry.

**Step 5: Record evidence**

Update `docs/verification.md` with:

- Test count.
- Build result.
- Manual smoke result.
- Any known risks or skipped checks.

## Final Delivery Checklist

- V3 design document exists.
- V3 implementation summary exists.
- `npm test` passes.
- `npm run build` passes.
- Web upload creates approvals and writes into standard directory.
- Signature placement is saved as ratios.
- Designer/supervisor/process signature assets can be configured.
- Parallel approval triggers signed PDF generation.
- Signed PDF is a new file and original PDF is not overwritten.
- Print flow uses signed PDF.
- Signature failure is visible and retryable.
- Comments/issues work.
- CSV traceability export works.
- Diagnostics and backup are visible in admin UI.
- Deployment and verification docs are updated.
