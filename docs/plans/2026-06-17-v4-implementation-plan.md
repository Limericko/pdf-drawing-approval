# PDF Approval V4 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build V4 so designers can reuse signature placement templates, submit multiple PDFs in one batch, process signed PDFs in bulk, and admins can see operational risks in one place.

**Architecture:** Keep the existing Node 24 + Express + React/Vite + SQLite architecture. Add small repositories and routes for templates, batch submissions, batch approval actions, and system risks; extend current pages instead of introducing a new workflow engine.

**Tech Stack:** Node 24, TypeScript, Express, built-in `node:sqlite`, React/Vite, Vitest, Supertest, `pdf-lib`, existing file/folder utilities.

---

## Ground Rules

- Use TDD for production behavior changes.
- Keep the V3 single-file upload and single approval detail flows working.
- Keep all file writes inside the configured `watch_root`.
- Prefer partial success responses for batch operations.
- Run `npm test` and `npm run build` before claiming a phase is complete.
- This workspace may not be a Git repository. If Git is not initialized, skip commit commands and record the verification result in `docs/verification.md`.

## Phase 0: Baseline Check

### Task 0.1: Verify Current Baseline

**Files:**
- Read: `docs/v3-implementation-summary.md`
- Read: `docs/plans/2026-06-17-v4-design.md`
- Run only

**Step 1: Run full tests**

Run:

```powershell
npm test
```

Expected:

```text
Test Files  42 passed
Tests       180 passed
```

**Step 2: Run production build**

Run:

```powershell
npm run build
```

Expected:

```text
tsc && vite build
✓ built
```

**Step 3: Check working service**

Run:

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:8080/health'
```

Expected:

```json
{"ok":true}
```

## Phase 1: Signature Placement Templates

### Task 1.1: Add Database Schema and Repository

**Files:**
- Modify: `src/server/schema.sql`
- Modify: `src/server/db.ts`
- Create: `src/server/repositories/signatureTemplates.ts`
- Test: `src/server/repositories/signatureTemplates.test.ts`

**Step 1: Write failing repository tests**

Create tests for:

- Creating a template with three placements.
- Listing templates visible to a project.
- Updating a template.
- Deleting a template.
- Rejecting templates that do not include designer, supervisor, and process placements.

Run:

```powershell
npm test -- --run src/server/repositories/signatureTemplates.test.ts
```

Expected: fail because repository does not exist.

**Step 2: Add schema**

Add:

```sql
CREATE TABLE IF NOT EXISTS signature_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  project_name TEXT,
  placements_json TEXT NOT NULL,
  created_by_user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_signature_templates_project_name ON signature_templates(project_name, updated_at);
```

Add idempotent migration in `src/server/db.ts` for existing databases.

**Step 3: Implement repository**

Implement typed methods:

```ts
create(input)
list(input?: { projectName?: string | null })
getById(id)
update(id, input)
delete(id)
```

Store placements as JSON but validate with the existing `SignaturePlacement` shape.

**Step 4: Run repository test**

Run:

```powershell
npm test -- --run src/server/repositories/signatureTemplates.test.ts
```

Expected: pass.

### Task 1.2: Add Signature Template API

**Files:**
- Create: `src/server/routes/signatureTemplates.ts`
- Modify: `src/server/server.ts`
- Test: `src/server/routes/signatureTemplates.test.ts`

**Step 1: Write failing route tests**

Cover:

- Designer/admin can list templates.
- Designer can create a template.
- Admin can update/delete any template.
- Designer cannot update/delete another user's template.
- Invalid placement roles return `400`.

Run:

```powershell
npm test -- --run src/server/routes/signatureTemplates.test.ts
```

Expected: fail because route is missing.

**Step 2: Implement routes**

Add:

```text
GET    /api/signature-templates
POST   /api/signature-templates
PUT    /api/signature-templates/:id
DELETE /api/signature-templates/:id
```

Use `requireAuth(deps.jwtSecret, ["designer", "admin"])` for list/create.

Use owner-or-admin checks for update/delete.

**Step 3: Wire route into server**

Instantiate `SignatureTemplateRepository` in `src/server/server.ts`.

Mount route:

```text
/api/signature-templates
```

**Step 4: Run route tests**

Run:

```powershell
npm test -- --run src/server/routes/signatureTemplates.test.ts
```

Expected: pass.

### Task 1.3: Save Template From Approval Placements

**Files:**
- Modify: `src/server/routes/approvals.ts`
- Test: `src/server/routes/approvals.test.ts`

**Step 1: Write failing test**

Add route test:

- Existing approval has three signature placements.
- Designer posts template name.
- Server creates a template with same placements.
- Missing placement returns `400`.

Run:

```powershell
npm test -- --run src/server/routes/approvals.test.ts
```

Expected: fail because endpoint is missing.

**Step 2: Implement endpoint**

Add:

```text
POST /api/approvals/:id/signature-templates
```

Body:

```json
{
  "name": "A3 标准图框",
  "projectName": "LS-300N"
}
```

Use current approval placements as source.

**Step 3: Run test**

Run:

```powershell
npm test -- --run src/server/routes/approvals.test.ts
```

Expected: pass.

### Task 1.4: Add Template Client API and UI

**Files:**
- Modify: `src/client/api.ts`
- Modify: `src/client/pages/SubmitDrawingPage.tsx`
- Modify: `src/client/pages/ApprovalDetailPage.tsx`
- Modify: `src/client/pages/SettingsPage.tsx`
- Test: `src/client/pages/submitDrawingLayout.test.ts`
- Test: `src/client/pages/approvalDetailLogic.test.ts`

**Step 1: Write failing frontend tests**

Test pure logic where possible:

- Applying a template replaces all three placements.
- Template selector is present on submit page.
- Approval detail exposes save-as-template action for designer/admin.

Run:

```powershell
npm test -- --run src/client/pages/submitDrawingLayout.test.ts src/client/pages/approvalDetailLogic.test.ts
```

Expected: fail.

**Step 2: Add API functions**

Add:

```ts
listSignatureTemplates(projectName?: string)
createSignatureTemplate(input)
updateSignatureTemplate(id, input)
deleteSignatureTemplate(id)
saveApprovalPlacementsAsTemplate(approvalId, input)
```

**Step 3: Add UI**

Submit page:

- Load templates after login.
- Provide template dropdown near project/version controls.
- Apply selected template to current placements.

Approval detail:

- Add "保存为模板" action near placement editor.
- Require template name.

Settings page:

- Add simple template management table for admins.

**Step 4: Run frontend tests**

Run:

```powershell
npm test -- --run src/client/pages/submitDrawingLayout.test.ts src/client/pages/approvalDetailLogic.test.ts
```

Expected: pass.

### Task 1.5: Phase 1 Integration Verification

**Files:**
- Modify: `docs/verification.md`

**Step 1: Run focused tests**

Run:

```powershell
npm test -- --run src/server/repositories/signatureTemplates.test.ts src/server/routes/signatureTemplates.test.ts src/server/routes/approvals.test.ts src/client/pages/submitDrawingLayout.test.ts src/client/pages/approvalDetailLogic.test.ts
```

Expected: pass.

**Step 2: Run full verification**

Run:

```powershell
npm test
npm run build
```

Expected: pass.

**Step 3: Record verification**

Append a short V4.1 verification section to `docs/verification.md`.

## Phase 2: Batch Upload

### Task 2.1: Add Batch Submission Tables and Repository

**Files:**
- Modify: `src/server/schema.sql`
- Modify: `src/server/db.ts`
- Create: `src/server/repositories/batchSubmissions.ts`
- Test: `src/server/repositories/batchSubmissions.test.ts`

**Step 1: Write failing tests**

Cover:

- Start batch.
- Add completed and failed items.
- Record each item's placement state as `template`, `manual`, or `missing`.
- Complete batch as `completed`, `partial`, or `failed`.
- List recent batches.

Run:

```powershell
npm test -- --run src/server/repositories/batchSubmissions.test.ts
```

Expected: fail.

**Step 2: Add schema**

Add `batch_submissions` and `batch_submission_items` from `docs/plans/2026-06-17-v4-design.md`.

**Step 3: Implement repository**

Methods:

```ts
start(input)
addItem(input)
complete(batchId)
fail(batchId, error)
listRecent(limit?)
getWithItems(batchId)
```

**Step 4: Run tests**

Run:

```powershell
npm test -- --run src/server/repositories/batchSubmissions.test.ts
```

Expected: pass.

### Task 2.2: Add Batch Upload API

**Files:**
- Modify: `src/server/routes/submissions.ts`
- Modify: `src/server/server.ts`
- Test: `src/server/routes/submissions.test.ts`

**Step 1: Write failing tests**

Add route tests:

- Batch upload accepts multiple valid PDFs.
- Invalid PDF item fails without blocking valid items.
- Duplicate project/part/version item fails.
- Each batch item must submit its own `placements`.
- Two files in the same batch can create approvals with different signature placement coordinates.
- An item with missing designer/supervisor/process placement fails without blocking other complete items.
- Batch result returns item-level statuses.

Run:

```powershell
npm test -- --run src/server/routes/submissions.test.ts
```

Expected: fail.

**Step 2: Implement endpoints**

Add:

```text
POST /api/submissions/batch-upload
POST /api/submissions/batch
GET  /api/submissions/batches
GET  /api/submissions/batches/:id
```

Keep single-file endpoints unchanged.

**Step 3: Reuse existing submission logic**

Extract shared helper if needed:

- validate PDF header.
- parse drawing filename.
- move/copy file to reviewing folder.
- validate each item's own placements.
- create approval with that item's placements.

Do not duplicate version parsing logic.
Do not store or apply one batch-level placement set as the final position for every file.

**Step 4: Run tests**

Run:

```powershell
npm test -- --run src/server/routes/submissions.test.ts
```

Expected: pass.

### Task 2.3: Update Submit Page for Multiple Files

**Files:**
- Modify: `src/client/api.ts`
- Modify: `src/client/pages/SubmitDrawingPage.tsx`
- Modify: `src/client/widgets/PdfSignaturePlacementWorkspace.tsx` if needed
- Test: `src/client/pages/submitDrawingLayout.test.ts`

**Step 1: Write failing tests**

Cover:

- Submit page allows multiple file selection.
- Batch list displays per-file status.
- Applying a template to the whole batch copies placements into each item independently.
- Applying a template to the selected item only updates that item.
- Editing signature boxes on one file does not change placements on another file in the same batch.
- Each file row displays placement status: missing, template, or manual.
- Failed item remains visible after submit.

Run:

```powershell
npm test -- --run src/client/pages/submitDrawingLayout.test.ts
```

Expected: fail.

**Step 2: Add API functions**

Add:

```ts
uploadBatchSubmission(files: File[])
confirmBatchSubmission(input)
listBatchSubmissions()
getBatchSubmission(id)
```

**Step 3: Update page state**

Represent batch items with:

```ts
{
  clientId: string;
  fileName: string;
  status: "ready" | "invalid" | "uploaded" | "submitting" | "completed" | "failed";
  projectName: string;
  partName: string;
  version: string;
  placements: SignaturePlacement[];
  placementState: "missing" | "template" | "manual";
  templateId?: number;
  error?: string;
}
```

**Step 4: Update UI**

- Keep the existing single-upload experience when one file is selected.
- For multiple files, show compact item list and preview selected item.
- Provide "批量套用模板" for initialization only.
- Provide per-file template selector or "套用到当前图纸".
- When switching selected item, preserve the current item's placements before rendering the next PDF preview.
- Disable submit for items whose placements are incomplete, or submit only complete items and show incomplete items as failed.
- Add batch result summary.

**Step 5: Run frontend test**

Run:

```powershell
npm test -- --run src/client/pages/submitDrawingLayout.test.ts
```

Expected: pass.

### Task 2.4: Phase 2 Integration Verification

**Files:**
- Modify: `docs/verification.md`

**Step 1: Run focused tests**

Run:

```powershell
npm test -- --run src/server/repositories/batchSubmissions.test.ts src/server/routes/submissions.test.ts src/client/pages/submitDrawingLayout.test.ts
```

Expected: pass.

**Step 2: Run full verification**

Run:

```powershell
npm test
npm run build
```

Expected: pass.

**Step 3: Browser smoke**

Open:

```text
http://127.0.0.1:8080/#/submit
```

Verify:

- Multiple file input is visible.
- Template selector is visible.
- Each selected PDF has its own placement state.
- Adjusting one file's signature boxes does not move another file's signature boxes.
- Existing single PDF upload still works.

## Phase 3: Batch Signed PDF Processing

### Task 3.1: Add Batch Approval Actions API

**Files:**
- Modify: `src/server/routes/approvals.ts`
- Test: `src/server/routes/approvals.test.ts`

**Step 1: Write failing tests**

Cover:

- Designer/admin can batch regenerate signed PDFs.
- Reviewer cannot batch regenerate.
- Batch result contains per-approval success/failure.
- Batch mark printed rejects approvals without signed PDF.
- Batch mark printed archives valid approvals.

Run:

```powershell
npm test -- --run src/server/routes/approvals.test.ts
```

Expected: fail.

**Step 2: Implement endpoints**

Add before `/:id` routes to avoid route conflicts:

```text
POST /api/approvals/batch/generate-signed-pdf
POST /api/approvals/batch/mark-printed
```

Body:

```json
{ "approvalIds": [1, 2, 3] }
```

**Step 3: Reuse existing single-item services**

For generation, call `tryGenerateSignedPdfForApproval`.

For mark printed, reuse `deps.approvals.markPrinted` and `moveApprovalFile`.

Collect item-level errors instead of failing entire request.

**Step 4: Run tests**

Run:

```powershell
npm test -- --run src/server/routes/approvals.test.ts
```

Expected: pass.

### Task 3.2: Add Batch Actions to Approvals Page

**Files:**
- Modify: `src/client/api.ts`
- Modify: `src/client/pages/ApprovalsPage.tsx`
- Modify: `src/client/widgets/ApprovalTable.tsx` if button placement needs row support
- Test: `src/client/pages/approvalListLogic.test.ts`

**Step 1: Write failing tests**

Cover pure logic:

- Only `approved_for_print` records are eligible for batch signed PDF generation.
- Batch print requires generated signature when signature is required.
- Selection reconciliation remains unchanged after batch action.

Run:

```powershell
npm test -- --run src/client/pages/approvalListLogic.test.ts
```

Expected: fail.

**Step 2: Add API functions**

Add:

```ts
batchGenerateSignedPdf(approvalIds: number[])
batchMarkPrinted(approvalIds: number[])
```

**Step 3: Update UI**

Add buttons to existing admin/designer batch action bar:

- 批量重新生成签后 PDF
- 批量标记打印归档

Show a modal or result panel with item-level results.

**Step 4: Run tests**

Run:

```powershell
npm test -- --run src/client/pages/approvalListLogic.test.ts
```

Expected: pass.

### Task 3.3: Phase 3 Integration Verification

**Files:**
- Modify: `docs/verification.md`

**Step 1: Run focused tests**

Run:

```powershell
npm test -- --run src/server/routes/approvals.test.ts src/client/pages/approvalListLogic.test.ts
```

Expected: pass.

**Step 2: Run full verification**

Run:

```powershell
npm test
npm run build
```

Expected: pass.

## Phase 4: Operational Risk Dashboard

### Task 4.1: Add Risk Service and API

**Files:**
- Create: `src/server/services/systemRisks.ts`
- Modify: `src/server/routes/system.ts`
- Test: `src/server/services/systemRisks.test.ts`
- Test: `src/server/routes/system.test.ts`

**Step 1: Write failing service tests**

Cover:

- Missing watch root creates abnormal risk.
- Missing standard directory creates abnormal risk.
- Backup older than threshold creates warning risk.
- File missing approvals create abnormal risk with count.
- Signature failed approvals create abnormal risk with count.
- Missing key signatures create warning risk.

Run:

```powershell
npm test -- --run src/server/services/systemRisks.test.ts
```

Expected: fail.

**Step 2: Implement risk service**

Return:

```ts
type SystemRisk = {
  key: string;
  level: "ok" | "warning" | "error";
  title: string;
  message: string;
  count?: number;
  href?: string;
};
```

Use existing repositories and settings.

**Step 3: Add route**

Add:

```text
GET /api/system/risks
```

Admin only.

**Step 4: Run route tests**

Run:

```powershell
npm test -- --run src/server/services/systemRisks.test.ts src/server/routes/system.test.ts
```

Expected: pass.

### Task 4.2: Add Risk Dashboard UI

**Files:**
- Modify: `src/client/api.ts`
- Modify: `src/client/pages/SettingsPage.tsx`
- Modify: `src/client/styles.css`
- Test: `src/client/pages/settingsDiagnostics.test.ts`

**Step 1: Write failing frontend test**

Cover:

- Normalizes risk response.
- Renders risk title and action href.
- Handles empty risk list.

Run:

```powershell
npm test -- --run src/client/pages/settingsDiagnostics.test.ts
```

Expected: fail.

**Step 2: Add API function**

Add:

```ts
getSystemRisks()
```

**Step 3: Add UI**

In Settings page `运维追溯` tab:

- Add risk dashboard above existing diagnostics.
- Use compact rows/cards.
- Add "去处理" link when `href` exists.

**Step 4: Run tests**

Run:

```powershell
npm test -- --run src/client/pages/settingsDiagnostics.test.ts
```

Expected: pass.

### Task 4.3: Phase 4 Verification

**Files:**
- Modify: `docs/verification.md`

**Step 1: Run focused tests**

Run:

```powershell
npm test -- --run src/server/services/systemRisks.test.ts src/server/routes/system.test.ts src/client/pages/settingsDiagnostics.test.ts
```

Expected: pass.

**Step 2: Run full verification**

Run:

```powershell
npm test
npm run build
```

Expected: pass.

## Phase 5: Lightweight Version Traceability

### Task 5.1: Add Version Lookup Repository Method

**Files:**
- Modify: `src/server/repositories/approvals.ts`
- Test: `src/server/repositories/approvals.test.ts`

**Step 1: Write failing tests**

Cover:

- Find approvals with same project and part.
- Exclude current approval when requested.
- Sort by submitted date descending.

Run:

```powershell
npm test -- --run src/server/repositories/approvals.test.ts
```

Expected: fail.

**Step 2: Implement method**

Add:

```ts
listVersions(projectName: string, partName: string, excludeId?: number): Approval[]
```

**Step 3: Run tests**

Run:

```powershell
npm test -- --run src/server/repositories/approvals.test.ts
```

Expected: pass.

### Task 5.2: Show Related Versions in Detail and Upload

**Files:**
- Modify: `src/server/routes/approvals.ts`
- Modify: `src/server/routes/submissions.ts`
- Modify: `src/client/api.ts`
- Modify: `src/client/pages/ApprovalDetailPage.tsx`
- Modify: `src/client/pages/SubmitDrawingPage.tsx`
- Test: `src/server/routes/approvals.test.ts`
- Test: `src/server/routes/submissions.test.ts`

**Step 1: Write failing route tests**

Cover:

- Approval detail returns related versions.
- Upload parse response includes existing versions for same project/part when known.

Run:

```powershell
npm test -- --run src/server/routes/approvals.test.ts src/server/routes/submissions.test.ts
```

Expected: fail.

**Step 2: Implement backend response fields**

Approval detail:

```json
{
  "approval": {},
  "history": [],
  "relatedVersions": []
}
```

Submission upload/confirm preview:

```json
{
  "existingVersions": []
}
```

**Step 3: Add UI**

Approval detail:

- Add compact "同零件其它版本" floating panel or right-side section.

Submit page:

- Show warning if existing versions are found.

**Step 4: Run tests**

Run:

```powershell
npm test -- --run src/server/routes/approvals.test.ts src/server/routes/submissions.test.ts
```

Expected: pass.

### Task 5.3: Add CSV Version Count

**Files:**
- Modify: `src/server/routes/reports.ts`
- Test: `src/server/routes/reports.test.ts`

**Step 1: Write failing test**

Assert CSV contains:

```text
同零件版本数
```

Run:

```powershell
npm test -- --run src/server/routes/reports.test.ts
```

Expected: fail.

**Step 2: Implement report field**

Add a subquery or precomputed map for same project + same part count.

**Step 3: Run tests**

Run:

```powershell
npm test -- --run src/server/routes/reports.test.ts
```

Expected: pass.

## Phase 6: Documentation and Release Verification

### Task 6.1: Update Documentation

**Files:**
- Modify: `docs/v3-implementation-summary.md` only if V3 references need final pointers
- Create: `docs/v4-implementation-summary.md`
- Modify: `docs/deploy-windows-lan.md`
- Modify: `docs/verification.md`

**Step 1: Update deployment docs**

Add:

- Signature template setup.
- Batch upload workflow.
- Batch signed PDF processing.
- Risk dashboard daily check.

**Step 2: Add V4 summary**

Create `docs/v4-implementation-summary.md` with:

- Version goal.
- Delivered features.
- Data model changes.
- Key files.
- Verification.
- Known limitations.

**Step 3: Run doc grep**

Run:

```powershell
rg -n "V4|第四版|签名框模板|批量上传|风险看板" docs
```

Expected: all new docs are discoverable.

### Task 6.2: Full Regression and Browser Smoke

**Files:**
- Run only

**Step 1: Full automated tests**

Run:

```powershell
npm test
```

Expected: all tests pass.

**Step 2: Production build**

Run:

```powershell
npm run build
```

Expected: build passes.

**Step 3: Restart service**

Use admin UI or:

```powershell
POST http://127.0.0.1:8080/api/system/restart
```

Then:

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:8080/health'
```

Expected:

```json
{"ok":true}
```

**Step 4: Browser smoke**

Open:

```text
http://127.0.0.1:8080/#/submit
http://127.0.0.1:8080/#/approvals
http://127.0.0.1:8080/#/settings
```

Verify:

- Submit page supports batch upload and templates.
- Approvals page shows batch signed PDF actions for eligible users.
- Settings page shows risk dashboard and template management.
- Browser console has no new errors.

## Suggested Execution Order

1. V4.1 signature templates.
2. V4.2 batch upload.
3. V4.3 batch signed PDF actions.
4. V4.4 risk dashboard.
5. Lightweight version traceability.
6. Documentation and release verification.

Each phase should be independently shippable.
