# V6.1 Annotation Experience Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Upgrade the existing drawing annotation workflow into a smoother in-system PDF annotation editor with draw-then-comment, selection handles, freehand ink, revision clouds, and review-PDF export support.

**Architecture:** Keep the current Express + SQLite + React/Vite annotation architecture. Extend the existing `approval_annotations` model and routes, then evolve `PdfAnnotationWorkspace` and `PdfAnnotationLayer` into a lightweight editor instead of replacing them with a third-party annotation library.

**Tech Stack:** Node 24, TypeScript, Express, built-in `node:sqlite`, React 19, Vite, Vitest, Supertest, PDF.js legacy renderer, `pdf-lib`.

---

## Ground Rules

- Use TDD for every production behavior change.
- Do not write annotations into the official signed PDF.
- Preserve existing annotation API compatibility for `pin`, `rect`, `arrow`, `circle`, and `text`.
- Keep old approvals and old annotation records readable without migration data loss.
- This workspace currently has no `.git` directory. Skip commit steps unless a Git repository is restored.
- Run targeted tests after each task, then `npm test` and `npm run build` before calling the work complete.

## Phase 0: Baseline

### Task 0.1: Confirm Current Baseline

**Files:**
- Read: `docs/plans/2026-06-22-v6-drawing-annotations-design.md`
- Read: `docs/plans/2026-06-22-v6-1-annotation-experience-design.md`
- Read: `src/client/widgets/PdfAnnotationWorkspace.tsx`
- Read: `src/client/widgets/PdfAnnotationLayer.tsx`
- Read: `src/server/repositories/approvalAnnotations.ts`
- Run only

**Step 1: Run current annotation tests**

Run:

```powershell
npm test -- --run src/client/widgets/PdfAnnotationWorkspace.test.ts src/server/repositories/approvalAnnotations.test.ts src/server/routes/approvalAnnotations.test.ts src/server/pdf/annotatePdf.test.ts
```

Expected: all selected tests pass.

**Step 2: Run build**

Run:

```powershell
npm run build
```

Expected: `tsc && vite build` exits 0.

## Phase 1: Data Model Extensions

### Task 1.1: Add Ink and Cloud Annotation Types

**Files:**
- Modify: `src/client/api.ts`
- Modify: `src/server/schema.sql`
- Modify: `src/server/db.ts`
- Modify: `src/server/repositories/approvalAnnotations.ts`
- Test: `src/server/repositories/approvalAnnotations.test.ts`
- Test: `src/client/api.test.ts`

**Step 1: Write failing repository tests**

Add cases proving:

- `kind: "ink"` accepts a valid normalized point array in `pointsJson`.
- `kind: "cloud"` accepts rectangle geometry.
- `ink` rejects empty or invalid point arrays.
- Existing `rect`, `arrow`, `circle`, `pin`, and `text` records still create and list correctly.

Run:

```powershell
npm test -- --run src/server/repositories/approvalAnnotations.test.ts
```

Expected: fail because `ink`, `cloud`, and `points_json` are not supported yet.

**Step 2: Extend schema**

Add nullable columns:

```sql
points_json TEXT,
style_json TEXT
```

Update both:

- `src/server/schema.sql`
- migration logic in `src/server/db.ts`

Update the `kind` check to include:

```sql
'ink', 'cloud'
```

**Step 3: Extend repository types**

Update `ApprovalAnnotationKind`:

```ts
export type ApprovalAnnotationKind = "pin" | "rect" | "arrow" | "circle" | "text" | "ink" | "cloud";
```

Add fields:

```ts
pointsJson: string | null;
styleJson: string | null;
```

Validate `pointsJson` as an array of normalized points:

```ts
type AnnotationPoint = { xRatio: number; yRatio: number };
```

Rules:

- `ink` requires at least 2 valid points.
- `cloud` requires `widthRatio` and `heightRatio`.
- All point ratios must be between `0` and `1`.

**Step 4: Extend client API types**

Add `ink` and `cloud` to `ApprovalAnnotationKind`.

Add optional input fields:

```ts
pointsJson?: string | null;
styleJson?: string | null;
```

**Step 5: Verify**

Run:

```powershell
npm test -- --run src/server/repositories/approvalAnnotations.test.ts src/client/api.test.ts
```

Expected: pass.

## Phase 2: Annotation Geometry Helpers

### Task 2.1: Add Pure Helpers for Drafts, Movement, Resize, and Ink

**Files:**
- Modify: `src/client/widgets/PdfAnnotationWorkspace.tsx`
- Test: `src/client/widgets/PdfAnnotationWorkspace.test.ts`

**Step 1: Write failing helper tests**

Cover:

- `createAnnotationFromDrag("cloud", ...)` creates rectangle-style geometry.
- `createInkAnnotationFromPoints(points, pageNumber, options)` clamps and serializes points.
- `moveAnnotation(annotation, delta)` keeps geometry inside page bounds.
- `resizeAnnotation(annotation, handle, point)` keeps minimum size and page bounds.

Run:

```powershell
npm test -- --run src/client/widgets/PdfAnnotationWorkspace.test.ts
```

Expected: fail because helpers do not exist.

**Step 2: Implement helpers**

Add pure exported helpers before changing React behavior:

```ts
export function createInkAnnotationFromPoints(...)
export function moveAnnotation(...)
export function resizeAnnotation(...)
export function annotationBounds(...)
```

Keep all math ratio-based.

**Step 3: Verify**

Run:

```powershell
npm test -- --run src/client/widgets/PdfAnnotationWorkspace.test.ts
```

Expected: pass.

## Phase 3: Draw-Then-Comment UX

### Task 3.1: Add Draft Popover Flow

**Files:**
- Modify: `src/client/widgets/PdfAnnotationLayer.tsx`
- Modify: `src/client/widgets/PdfAnnotationWorkspace.tsx`
- Modify: `src/client/pages/ApprovalDetailPage.tsx`
- Modify: `src/client/styles.css`
- Test: `src/client/pages/approvalDetailLayout.test.ts`
- Test: `src/client/styles.test.ts`

**Step 1: Write failing layout/style tests**

Check source contains:

- `AnnotationDraftPopover`
- `onConfirmDraftAnnotation`
- `annotation-toolbar`
- `annotation-popover`
- Chinese copy for "填写批注内容"

Run:

```powershell
npm test -- --run src/client/pages/approvalDetailLayout.test.ts src/client/styles.test.ts
```

Expected: fail because the popover flow is not implemented.

**Step 2: Implement draft lifecycle**

Change page flow from "right side message first" to:

1. Layer creates a local draft.
2. Workspace shows popover near draft.
3. User inputs content.
4. Confirm calls `createApprovalAnnotation`.
5. Cancel discards local draft.

Keep the old right-side textarea temporarily as fallback if needed, but do not require it for creation.

**Step 3: Add styles**

Add:

```css
.annotation-toolbar
.annotation-popover
.annotation-popover textarea
.annotation-popover__actions
```

**Step 4: Verify**

Run:

```powershell
npm test -- --run src/client/pages/approvalDetailLayout.test.ts src/client/styles.test.ts
```

Expected: pass.

## Phase 4: Toolbar and Selection Editing

### Task 4.1: Add PDF-Local Annotation Toolbar

**Files:**
- Modify: `src/client/pages/ApprovalDetailPage.tsx`
- Modify: `src/client/styles.css`
- Test: `src/client/pages/approvalDetailLayout.test.ts`
- Test: `src/client/styles.test.ts`

**Step 1: Write failing tests**

Assert the page includes toolbar actions for:

- 选择
- 定位
- 箭头
- 矩形
- 圆形
- 文字
- 画笔
- 云线
- 删除

Run:

```powershell
npm test -- --run src/client/pages/approvalDetailLayout.test.ts src/client/styles.test.ts
```

Expected: fail for missing toolbar entries.

**Step 2: Implement toolbar**

Move drawing controls from the side panel to a PDF-local toolbar above the PDF stage.

Keep the side panel/list for:

- annotation count
- unresolved count
- selected annotation details
- resolve/delete actions
- review PDF link

**Step 3: Verify**

Run:

```powershell
npm test -- --run src/client/pages/approvalDetailLayout.test.ts src/client/styles.test.ts
```

Expected: pass.

### Task 4.2: Add Selection Handles, Move, Resize, and Color Update

**Files:**
- Modify: `src/client/widgets/PdfAnnotationLayer.tsx`
- Modify: `src/client/widgets/PdfAnnotationWorkspace.tsx`
- Modify: `src/client/pages/ApprovalDetailPage.tsx`
- Modify: `src/client/styles.css`
- Test: `src/client/widgets/PdfAnnotationWorkspace.test.ts`
- Test: `src/client/styles.test.ts`

**Step 1: Write failing tests**

Pure helper tests should cover movement and resize. Style tests should assert:

- `.pdf-annotation-marker--selected`
- `.pdf-annotation-resize-handle`
- `.pdf-annotation-toolbar`

Run:

```powershell
npm test -- --run src/client/widgets/PdfAnnotationWorkspace.test.ts src/client/styles.test.ts
```

Expected: fail until selection UI exists.

**Step 2: Implement selected marker rendering**

For selected rectangle-style annotations:

- render selection border
- render corner handles
- stop event propagation from handles
- use pointer capture for resize/move

For arrow:

- render endpoint handles

For pin:

- allow drag move only

**Step 3: Persist edits**

On pointer release after move/resize:

- call existing `updateApprovalAnnotation`
- refresh annotations and logs
- show a concise success/error message

**Step 4: Verify**

Run:

```powershell
npm test -- --run src/client/widgets/PdfAnnotationWorkspace.test.ts src/client/styles.test.ts src/client/pages/approvalDetailLayout.test.ts
```

Expected: pass.

## Phase 5: Ink and Cloud Rendering

### Task 5.1: Add Frontend Ink Tool

**Files:**
- Modify: `src/client/widgets/PdfAnnotationLayer.tsx`
- Modify: `src/client/widgets/PdfAnnotationWorkspace.tsx`
- Modify: `src/client/styles.css`
- Test: `src/client/widgets/PdfAnnotationWorkspace.test.ts`

**Step 1: Write failing tests**

Test point serialization and clamping:

```ts
expect(JSON.parse(created.pointsJson ?? "[]")).toEqual([
  { xRatio: 0, yRatio: 0.2 },
  { xRatio: 0.4, yRatio: 1 }
]);
```

Run:

```powershell
npm test -- --run src/client/widgets/PdfAnnotationWorkspace.test.ts
```

Expected: fail until ink helper exists.

**Step 2: Implement ink drawing**

Pointer behavior:

- pointer down starts `ink` point array.
- pointer move appends points if distance threshold is met.
- pointer up creates local draft and opens popover.

Render with SVG polyline over the PDF page.

**Step 3: Verify**

Run:

```powershell
npm test -- --run src/client/widgets/PdfAnnotationWorkspace.test.ts
```

Expected: pass.

### Task 5.2: Add Frontend Cloud Tool

**Files:**
- Modify: `src/client/widgets/PdfAnnotationLayer.tsx`
- Modify: `src/client/widgets/PdfAnnotationWorkspace.tsx`
- Modify: `src/client/styles.css`
- Test: `src/client/widgets/PdfAnnotationWorkspace.test.ts`

**Step 1: Write failing tests**

Cover:

- `cloud` geometry behaves like rectangle geometry.
- minimum cloud size remains usable.

Run:

```powershell
npm test -- --run src/client/widgets/PdfAnnotationWorkspace.test.ts
```

Expected: fail until `cloud` is accepted.

**Step 2: Implement cloud render**

Render cloud as an SVG path generated from the annotation rectangle.

First implementation can use repeated quadratic curves around the rectangle.

**Step 3: Verify**

Run:

```powershell
npm test -- --run src/client/widgets/PdfAnnotationWorkspace.test.ts
```

Expected: pass.

## Phase 6: Review PDF Export

### Task 6.1: Draw Ink and Cloud in Annotated Review PDF

**Files:**
- Modify: `src/server/pdf/annotatePdf.ts`
- Test: `src/server/pdf/annotatePdf.test.ts`

**Step 1: Write failing PDF tests**

Add annotations:

- `kind: "ink"` with `pointsJson`.
- `kind: "cloud"` with rectangle geometry.

Assert generated PDF remains valid and source file is unchanged.

Run:

```powershell
npm test -- --run src/server/pdf/annotatePdf.test.ts
```

Expected: fail until PDF export supports the new types.

**Step 2: Implement PDF drawing**

For `ink`:

- parse `pointsJson`
- convert ratios to PDF page coordinates
- draw connected line segments

For `cloud`:

- draw a simplified cloud border around the rectangle
- draw annotation number and message as with other shapes

**Step 3: Verify**

Run:

```powershell
npm test -- --run src/server/pdf/annotatePdf.test.ts src/server/routes/approvalAnnotations.test.ts
```

Expected: pass.

## Phase 7: List定位 and Usability Polish

### Task 7.1: List Click Selects and Scrolls to Annotation

**Files:**
- Modify: `src/client/pages/ApprovalDetailPage.tsx`
- Modify: `src/client/widgets/PdfAnnotationWorkspace.tsx`
- Test: `src/client/pages/approvalDetailLayout.test.ts`

**Step 1: Write failing layout test**

Assert code contains a scroll/select contract, such as:

```ts
selectedAnnotationId
scrollAnnotationIntoView
```

Run:

```powershell
npm test -- --run src/client/pages/approvalDetailLayout.test.ts
```

Expected: fail until the list-to-PDF link is implemented.

**Step 2: Implement refs**

In the workspace:

- attach data attributes to annotation markers
- expose or react to selected ID by scrolling the page container to the marker

In the page:

- list click sets selected annotation ID
- selected marker receives selected styling

**Step 3: Verify**

Run:

```powershell
npm test -- --run src/client/pages/approvalDetailLayout.test.ts
```

Expected: pass.

### Task 7.2: Add Empty, Readonly, and Error State Copy

**Files:**
- Modify: `src/client/pages/ApprovalDetailPage.tsx`
- Modify: `src/client/styles.css`
- Test: `src/client/pages/approvalDetailLayout.test.ts`

**Step 1: Write failing tests**

Assert clear Chinese copy exists for:

- read-only archived approvals
- designer view-only mode
- failed annotation save
- no annotations

Run:

```powershell
npm test -- --run src/client/pages/approvalDetailLayout.test.ts
```

Expected: fail until copy is present.

**Step 2: Implement copy**

Keep text short and operational. Avoid long usage instructions inside the app.

**Step 3: Verify**

Run:

```powershell
npm test -- --run src/client/pages/approvalDetailLayout.test.ts
```

Expected: pass.

## Phase 8: Documentation and Regression

### Task 8.1: Update User and Admin Docs

**Files:**
- Modify: `docs/deploy-windows-lan.md`
- Modify: `docs/desktop-client-user-guide.md`
- Modify: `docs/desktop-client-admin-guide.md`
- Modify: `docs/verification.md`

**Step 1: Add V6.1 usage notes**

Document:

- draw-then-comment flow
- how reviewers edit annotations
- how designers mark resolved
- review PDF includes annotations
- official signed PDF remains clean

**Step 2: Verify docs**

Run:

```powershell
rg -n "V6.1|画笔|云线|批注|审查版 PDF|签后 PDF" docs
```

Expected: relevant documentation contains V6.1 notes.

### Task 8.2: Full Regression

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

Expected: build passes. Existing Vite PDF chunk-size warning is acceptable if unchanged.

**Step 3: Manual smoke**

Using the running dev app or packaged client:

1. Log in as supervisor or process reviewer.
2. Open a pending approval.
3. Create rectangle, arrow, text, ink, and cloud annotations.
4. Edit one annotation position and color.
5. Reject without text comment when an open annotation exists.
6. Log in as designer and mark one annotation resolved.
7. Open annotated review PDF and confirm new annotation types are visible.
8. Confirm signed PDF stays clean.

**Step 4: Record verification**

Append concise evidence to `docs/verification.md`:

```markdown
## 2026-06-22 V6.1 批注体验优化验证

- `npm test`: pass
- `npm run build`: pass
- Manual smoke: pass / skipped with reason
```

## Suggested Batch Execution

1. Batch A: Phase 1 + Phase 2 data model and geometry helpers.
2. Batch B: Phase 3 + Phase 4 draw-then-comment, toolbar, selection editing.
3. Batch C: Phase 5 + Phase 6 ink/cloud rendering and review PDF export.
4. Batch D: Phase 7 + Phase 8 usability polish, docs, full verification.
