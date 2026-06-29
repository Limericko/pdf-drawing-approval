# PDF Drawing Annotation V6 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build V6 drawing annotations so reviewers can mark exact PDF locations, designers can resolve annotations, admins can trace them, and the system can generate a separate annotated review PDF without polluting the signed print PDF.

**Architecture:** Keep the current Node 24 + Express + React/Vite + SQLite system. Add a dedicated annotation repository/table, mount annotation routes under `/api/approvals`, render annotations as a PDF overlay in the approval detail page, and generate review-only annotated PDFs with `pdf-lib`.

**Tech Stack:** Node 24, TypeScript, Express, built-in `node:sqlite`, React/Vite, Vitest, Supertest, `pdf-lib`, existing PDF.js legacy renderer pattern.

---

## Ground Rules

- Use TDD for every production behavior change.
- Do not write annotations into the official signed PDF.
- Keep current signature placement and signed PDF generation untouched unless a test proves integration is needed.
- Keep all existing comment/issue APIs backward compatible.
- This workspace is not currently a Git repository. Skip commit steps and record verification in `docs/verification.md` when executing.
- Run targeted tests after each task, then `npm test` and `npm run build` before packaging.

## Phase 0: Baseline Check

### Task 0.1: Confirm Current Baseline

**Files:**
- Read: `docs/plans/2026-06-22-v6-drawing-annotations-design.md`
- Read: `src/server/schema.sql`
- Read: `src/client/pages/ApprovalDetailPage.tsx`
- Run only

**Step 1: Run full tests**

Run:

```powershell
npm test
```

Expected: all test files pass.

**Step 2: Run production build**

Run:

```powershell
npm run build
```

Expected: `tsc && vite build` completes with exit code 0.

## Phase 1: Annotation Data Model

### Task 1.1: Add Schema and Repository

**Files:**
- Modify: `src/server/schema.sql`
- Modify: `src/server/db.ts`
- Create: `src/server/repositories/approvalAnnotations.ts`
- Test: `src/server/repositories/approvalAnnotations.test.ts`

**Step 1: Write the failing repository test**

Cover:

- Creating `rect`, `arrow`, `circle`, `pin`, and `text` annotations.
- Listing annotations for an approval in creation order.
- Updating message and geometry.
- Resolving an annotation.
- Deleting annotations for an approval.
- Rejecting invalid geometry.

Run:

```powershell
npm test -- --run src/server/repositories/approvalAnnotations.test.ts
```

Expected: fail because the repository does not exist.

**Step 2: Add schema**

Add to `src/server/schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS approval_annotations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  approval_id INTEGER NOT NULL,
  author_user_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('pin', 'rect', 'arrow', 'circle', 'text')),
  message TEXT NOT NULL,
  page_number INTEGER NOT NULL,
  x_ratio REAL NOT NULL,
  y_ratio REAL NOT NULL,
  width_ratio REAL,
  height_ratio REAL,
  end_x_ratio REAL,
  end_y_ratio REAL,
  color TEXT NOT NULL DEFAULT 'red',
  resolved INTEGER NOT NULL DEFAULT 0,
  resolved_by_user_id INTEGER,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (approval_id) REFERENCES approvals(id),
  FOREIGN KEY (author_user_id) REFERENCES users(id),
  FOREIGN KEY (resolved_by_user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_approval_annotations_approval_id ON approval_annotations(approval_id, created_at);
CREATE INDEX IF NOT EXISTS idx_approval_annotations_resolved ON approval_annotations(approval_id, resolved);
```

Add `migrateApprovalAnnotations(db)` in `src/server/db.ts` and call it from `migrateDatabase(db)`.

**Step 3: Implement repository**

Export:

```ts
export type ApprovalAnnotationKind = "pin" | "rect" | "arrow" | "circle" | "text";

export type ApprovalAnnotation = {
  id: number;
  approvalId: number;
  authorUserId: number;
  authorUsername: string | null;
  authorDisplayName: string | null;
  authorRole: UserRole | null;
  kind: ApprovalAnnotationKind;
  message: string;
  pageNumber: number;
  xRatio: number;
  yRatio: number;
  widthRatio: number | null;
  heightRatio: number | null;
  endXRatio: number | null;
  endYRatio: number | null;
  color: "red" | "amber" | "blue" | "green";
  resolved: boolean;
  resolvedByUserId: number | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
};
```

Methods:

```ts
create(input)
listForApproval(approvalId)
countOpenForApproval(approvalId)
getById(id)
update(approvalId, annotationId, input)
resolve(approvalId, annotationId, resolvedByUserId)
delete(approvalId, annotationId)
deleteForApproval(approvalId)
```

Validation rules:

- `pageNumber >= 1`.
- `xRatio`, `yRatio`, optional size/end ratios are `0..1`.
- `message` is trimmed and `1..1000` characters.
- `rect`, `circle`, and `text` require `widthRatio` and `heightRatio`.
- `arrow` requires `endXRatio` and `endYRatio`.
- `pin` does not require width, height, or endpoint.

**Step 4: Run repository test**

Run:

```powershell
npm test -- --run src/server/repositories/approvalAnnotations.test.ts
```

Expected: pass.

### Task 1.2: Delete Annotations with Approval Deletion

**Files:**
- Modify: `src/server/repositories/approvals.ts`
- Test: `src/server/routes/approvals.test.ts`

**Step 1: Write failing test**

Add a route/repository test proving admin deletion of an approval also deletes `approval_annotations`.

Run:

```powershell
npm test -- --run src/server/routes/approvals.test.ts
```

Expected: fail because annotations remain.

**Step 2: Add deletion**

In `ApprovalRepository.delete(id)`, delete annotations before deleting approvals:

```ts
this.db.prepare("DELETE FROM approval_annotations WHERE approval_id = ?").run(id);
```

**Step 3: Run test**

Run:

```powershell
npm test -- --run src/server/routes/approvals.test.ts
```

Expected: pass.

## Phase 2: Annotation API

### Task 2.1: Add Routes

**Files:**
- Create: `src/server/routes/approvalAnnotations.ts`
- Modify: `src/server/server.ts`
- Test: `src/server/routes/approvalAnnotations.test.ts`

**Step 1: Write failing route tests**

Cover:

- Any authenticated user can list annotations.
- `supervisor`, `process`, and `admin` can create annotations.
- `designer` cannot create annotations.
- Author or admin can update/delete unresolved annotations.
- Designer, author, or admin can resolve annotations.
- Archived and voided approvals reject create/update/delete.

Run:

```powershell
npm test -- --run src/server/routes/approvalAnnotations.test.ts
```

Expected: fail because routes do not exist.

**Step 2: Implement route schema**

Use Zod:

```ts
const annotationSchema = z.object({
  kind: z.enum(["pin", "rect", "arrow", "circle", "text"]),
  message: z.string().trim().min(1).max(1000),
  pageNumber: z.number().int().min(1),
  xRatio: z.number().min(0).max(1),
  yRatio: z.number().min(0).max(1),
  widthRatio: z.number().min(0).max(1).optional().nullable(),
  heightRatio: z.number().min(0).max(1).optional().nullable(),
  endXRatio: z.number().min(0).max(1).optional().nullable(),
  endYRatio: z.number().min(0).max(1).optional().nullable(),
  color: z.enum(["red", "amber", "blue", "green"]).default("red")
});
```

**Step 3: Implement operation logs**

Create logs:

- `approval.annotation_created`
- `approval.annotation_updated`
- `approval.annotation_resolved`
- `approval.annotation_deleted`

Metadata should include `annotationId`, `kind`, and `pageNumber`.

**Step 4: Mount routes**

In `src/server/server.ts`, instantiate `ApprovalAnnotationRepository` and mount:

```ts
app.use(
  "/api/approvals",
  approvalAnnotationRoutes({ approvals, approvalAnnotations, operationLogs, jwtSecret: config.jwtSecret })
);
```

**Step 5: Run route test**

Run:

```powershell
npm test -- --run src/server/routes/approvalAnnotations.test.ts
```

Expected: pass.

### Task 2.2: Allow Rejection With Open Annotation

**Files:**
- Modify: `src/server/repositories/approvals.ts`
- Modify: `src/server/routes/approvals.ts`
- Test: `src/server/routes/approvals.test.ts`

**Step 1: Write failing tests**

Cover:

- Rejection with no comment and no open annotations still fails.
- Rejection with no comment but at least one open annotation succeeds.

Run:

```powershell
npm test -- --run src/server/routes/approvals.test.ts
```

Expected: second test fails because `ApprovalRepository.review` requires a comment.

**Step 2: Move rejection condition to route**

Keep repository validation simple by adding optional `allowEmptyRejectComment` to `ReviewInput`, or enforce in route before calling repository:

```ts
if (decision === "rejected" && !comment.trim() && approvalAnnotations.countOpenForApproval(approval.id) === 0) {
  return res.status(400).json({ error: "REJECT_REASON_REQUIRED" });
}
```

Then call repository with a system comment such as `"见图纸批注"` only if the repository still requires non-empty comment. Prefer changing repository input to support the explicit flag so stored reviewer comment can remain empty.

**Step 3: Run tests**

Run:

```powershell
npm test -- --run src/server/routes/approvals.test.ts src/server/routes/approvalAnnotations.test.ts
```

Expected: pass.

## Phase 3: Annotated Review PDF

### Task 3.1: Generate Annotated PDF Bytes

**Files:**
- Create: `src/server/pdf/annotatePdf.ts`
- Test: `src/server/pdf/annotatePdf.test.ts`

**Step 1: Write failing PDF tests**

Cover:

- Draws rectangle/circle/arrow/text/pin annotations onto a PDF.
- Rejects annotation page numbers outside the PDF page count.
- Leaves source PDF unchanged.

Run:

```powershell
npm test -- --run src/server/pdf/annotatePdf.test.ts
```

Expected: fail because service does not exist.

**Step 2: Implement service**

Use `pdf-lib`:

```ts
export async function generateAnnotatedPdf(input: {
  sourcePdfPath: string;
  annotations: ApprovalAnnotation[];
}): Promise<Uint8Array>
```

Coordinate conversion:

```ts
const x = pageWidth * annotation.xRatio;
const y = pageHeight - pageHeight * annotation.yRatio - pageHeight * (annotation.heightRatio ?? 0);
```

Draw:

- `rect`: `page.drawRectangle`
- `circle`: `page.drawEllipse`
- `arrow`: `page.drawLine` plus a small arrow head
- `text`: `page.drawRectangle` plus `page.drawText`
- `pin`: small filled circle plus annotation number

**Step 3: Run PDF tests**

Run:

```powershell
npm test -- --run src/server/pdf/annotatePdf.test.ts
```

Expected: pass.

### Task 3.2: Add Annotated File Endpoint

**Files:**
- Modify: `src/server/routes/approvalAnnotations.ts`
- Test: `src/server/routes/approvalAnnotations.test.ts`

**Step 1: Write failing endpoint tests**

Cover:

- `GET /api/approvals/:id/annotated-file?token=...` returns `application/pdf`.
- Missing source PDF returns `404`.
- Invalid source PDF returns `422 INVALID_PDF_FILE`.
- Operation log records `approval.annotated_pdf_opened`.

Run:

```powershell
npm test -- --run src/server/routes/approvalAnnotations.test.ts
```

Expected: fail because endpoint is missing.

**Step 2: Implement endpoint**

Use existing token auth pattern from approval file endpoints. Validate source file with `hasPdfHeader` before generating annotated bytes.

**Step 3: Run endpoint tests**

Run:

```powershell
npm test -- --run src/server/routes/approvalAnnotations.test.ts
```

Expected: pass.

## Phase 4: Client API and Logic

### Task 4.1: Add Client API Types and Helpers

**Files:**
- Modify: `src/client/api.ts`
- Test: `src/client/api.test.ts`

**Step 1: Write failing API tests**

Cover:

- Annotated file URL includes token and optional cache key.
- Create/update/resolve/delete helpers call expected URLs.

Run:

```powershell
npm test -- --run src/client/api.test.ts
```

Expected: fail.

**Step 2: Add types**

Add:

```ts
export type ApprovalAnnotationKind = "pin" | "rect" | "arrow" | "circle" | "text";
export type ApprovalAnnotation = { ... };
```

Add functions:

```ts
listApprovalAnnotations(approvalId)
createApprovalAnnotation(approvalId, input)
updateApprovalAnnotation(approvalId, annotationId, input)
resolveApprovalAnnotation(approvalId, annotationId)
deleteApprovalAnnotation(approvalId, annotationId)
getAnnotatedFileUrl(approvalId, cacheKey?)
```

**Step 3: Run API tests**

Run:

```powershell
npm test -- --run src/client/api.test.ts
```

Expected: pass.

### Task 4.2: Add Permission Helpers

**Files:**
- Modify: `src/client/pages/approvalDetailLogic.ts`
- Test: `src/client/pages/approvalDetailLogic.test.ts`

**Step 1: Write failing logic tests**

Cover:

- Reviewer/admin can create annotations on active approvals.
- Designer cannot create annotations.
- Everyone can view.
- Designer/admin/author can resolve.
- Archived/voided approvals are read-only.

Run:

```powershell
npm test -- --run src/client/pages/approvalDetailLogic.test.ts
```

Expected: fail.

**Step 2: Implement helpers**

Add:

```ts
canCreateAnnotation(user, approval)
canEditAnnotation(user, approval, annotation)
canResolveAnnotation(user, annotation)
canShowAnnotations(approval)
```

**Step 3: Run logic tests**

Run:

```powershell
npm test -- --run src/client/pages/approvalDetailLogic.test.ts
```

Expected: pass.

## Phase 5: PDF Annotation Workspace

### Task 5.1: Build Annotation Overlay Component

**Files:**
- Create: `src/client/widgets/PdfAnnotationWorkspace.tsx`
- Create: `src/client/widgets/PdfAnnotationLayer.tsx`
- Test: `src/client/widgets/PdfAnnotationWorkspace.test.ts`
- Modify: `src/client/styles.css`

**Step 1: Write failing component tests**

Cover pure helpers first:

- `annotationsForPage(annotations, pageNumber)`.
- `mergePageAnnotations(existing, pageNumber, nextPageAnnotations)`.
- `createAnnotationFromDrag(kind, start, end, pageNumber)`.
- Ratio clamping.

Run:

```powershell
npm test -- --run src/client/widgets/PdfAnnotationWorkspace.test.ts
```

Expected: fail because module does not exist.

**Step 2: Implement workspace**

Mirror the proven `PdfSignaturePlacementWorkspace` pattern:

- Dynamic import `pdfjs-dist/legacy/build/pdf.mjs`.
- Dynamic import `pdfjs-dist/legacy/build/pdf.worker.mjs?url`.
- Render every page as a canvas.
- Place an absolutely positioned annotation layer inside each page container.
- Use page-local `getBoundingClientRect()` for pointer-to-ratio conversion.

**Step 3: Implement tools**

Tool state:

```ts
type AnnotationTool = "select" | "pin" | "rect" | "arrow" | "circle" | "text";
```

When creating:

- `pin`: click to place.
- `rect` / `circle` / `arrow` / `text`: drag to create.
- After creation, call `onDraftAnnotation(next)` so the page can ask for message text and save.

**Step 4: Add CSS**

Add stable dimensions and avoid layout shift:

- `.pdf-annotation-workspace`
- `.pdf-annotation-page`
- `.annotation-layer`
- `.annotation-shape`
- `.annotation-toolbar`
- `.annotation-popover`

**Step 5: Run component tests**

Run:

```powershell
npm test -- --run src/client/widgets/PdfAnnotationWorkspace.test.ts
```

Expected: pass.

## Phase 6: Approval Detail Integration

### Task 6.1: Load and Display Annotations

**Files:**
- Modify: `src/client/pages/ApprovalDetailPage.tsx`
- Test: `src/client/pages/approvalDetailLayout.test.ts`

**Step 1: Write failing layout tests**

Cover:

- Page loads annotation list alongside approval/logs/comments/placements.
- Shows “批注” action in the right side action area.
- Shows annotated review PDF link when annotations exist.

Run:

```powershell
npm test -- --run src/client/pages/approvalDetailLayout.test.ts
```

Expected: fail.

**Step 2: Integrate API**

Load annotations in `reload`:

```ts
const [next, logs, comments, placements, annotations] = await Promise.all([...]);
```

Maintain:

```ts
const [annotations, setAnnotations] = useState<ApprovalAnnotation[]>([]);
const [annotationMode, setAnnotationMode] = useState(false);
```

**Step 3: Switch PDF renderer**

When `pdfState === "ready"`:

- If `placementEditing`, keep `PdfSignaturePlacementWorkspace`.
- Else render `PdfAnnotationWorkspace` in read-only or editing mode.
- Do not use plain `<iframe>` when annotations are visible, because iframe cannot host overlay shapes.

**Step 4: Run layout tests**

Run:

```powershell
npm test -- --run src/client/pages/approvalDetailLayout.test.ts
```

Expected: pass.

### Task 6.2: Create, Edit, Resolve, and Delete Annotations

**Files:**
- Modify: `src/client/pages/ApprovalDetailPage.tsx`
- Test: `src/client/pages/approvalDetailLogic.test.ts`
- Test: `src/client/pages/approvalDetailLayout.test.ts`

**Step 1: Write failing tests**

Cover:

- Reviewer can save a draft annotation with message.
- Designer can resolve an annotation.
- Non-author reviewer cannot edit/delete another user's annotation.
- Success/error messages are Chinese and actionable.

Run:

```powershell
npm test -- --run src/client/pages/approvalDetailLogic.test.ts src/client/pages/approvalDetailLayout.test.ts
```

Expected: fail.

**Step 2: Implement handlers**

Add:

```ts
async function saveAnnotationDraft(input) { ... }
async function updateAnnotation(annotationId, input) { ... }
async function resolveAnnotation(annotationId) { ... }
async function removeAnnotation(annotationId) { ... }
```

Refresh annotations and operation logs after each mutation.

**Step 3: Update review UX**

For reviewers, when clicking “驳回”:

- If no review comment and no open annotations, show “驳回时请填写意见，或先在图纸上添加批注。”
- If open annotations exist, allow submit.

**Step 4: Run tests**

Run:

```powershell
npm test -- --run src/client/pages/approvalDetailLogic.test.ts src/client/pages/approvalDetailLayout.test.ts
```

Expected: pass.

## Phase 7: Reports and Operations

### Task 7.1: Add Annotation Summary to CSV Report

**Files:**
- Modify: `src/server/routes/reports.ts`
- Test: `src/server/routes/reports.test.ts`

**Step 1: Write failing report test**

Expect CSV headers:

- `批注总数`
- `未处理批注数`
- `最近批注摘要`

Run:

```powershell
npm test -- --run src/server/routes/reports.test.ts
```

Expected: fail.

**Step 2: Extend SQL**

Add subqueries for:

```sql
annotation_count
open_annotation_count
annotation_summary
```

Summary format:

```text
批注: 第1页 标题栏尺寸需确认
```

**Step 3: Run report test**

Run:

```powershell
npm test -- --run src/server/routes/reports.test.ts
```

Expected: pass.

### Task 7.2: Update Deployment Docs

**Files:**
- Modify: `docs/deploy-windows-lan.md`
- Modify: `docs/desktop-client-user-guide.md`
- Modify: `docs/desktop-client-admin-guide.md`

**Step 1: Add V6 usage notes**

Document:

- How reviewers add annotations.
- How designers mark annotations resolved.
- Annotated review PDF is internal only.
- Official signed PDF remains clean.

**Step 2: Verify docs mention installer paths still correctly**

Search:

```powershell
rg -n "批注|审查版 PDF|签后 PDF|installers" docs
```

Expected: relevant docs mention V6 annotation behavior.

## Phase 8: Final Verification and Packaging

### Task 8.1: Full Regression

**Files:**
- Run only
- Optionally append: `docs/verification.md`

**Step 1: Run full tests**

Run:

```powershell
npm test
```

Expected: all tests pass.

**Step 2: Run production build**

Run:

```powershell
npm run build
```

Expected: build passes.

**Step 3: Package installers**

Run:

```powershell
npm run installer:package
```

Expected:

- Client installer generated in `dist/installers/client`.
- Server installer generated in `dist/installers/server`.

**Step 4: Smoke test manually**

Run service, then verify:

1. Reviewer creates a rectangle annotation and rejects without text comment.
2. Designer sees the annotation and marks it resolved.
3. Annotated review PDF opens and shows the mark.
4. Official signed PDF still has no annotation.
5. CSV contains annotation summary.

**Step 5: Record verification**

Append concise evidence to `docs/verification.md`:

```markdown
## 2026-06-22 V6 图纸批注验证

- `npm test`: pass
- `npm run build`: pass
- `npm run installer:package`: pass
- Manual smoke: pass / skipped with reason
```

## Suggested Batch Execution

1. Batch A: Phase 1 + Phase 2 data/API.
2. Batch B: Phase 3 annotated PDF output.
3. Batch C: Phase 4 + Phase 5 frontend API and annotation workspace.
4. Batch D: Phase 6 approval detail integration.
5. Batch E: Phase 7 + Phase 8 docs, full verification, packaging.
