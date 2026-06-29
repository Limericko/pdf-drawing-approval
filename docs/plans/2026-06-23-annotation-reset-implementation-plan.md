# Annotation Reset Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a safe "return review PDF to initial version" action by clearing annotations while preserving original and signed PDFs.

**Architecture:** Keep annotations as database records and keep review PDFs dynamically generated from the source PDF plus current annotations. Add one repository reset helper, one admin/reviewer route, one frontend API helper, and one detail-page button. Operation logs provide traceability for the destructive action.

**Tech Stack:** TypeScript, Express, React/Vite, Vitest, node:sqlite.

---

### Task 1: Backend Reset

**Files:**
- Modify: `src/server/repositories/approvalAnnotations.ts`
- Modify: `src/server/routes/approvalAnnotations.ts`
- Test: `src/server/routes/approvalAnnotations.test.ts`

**Steps:**
1. Add failing route tests for reset success, designer rejection, and readonly rejection.
2. Add `deleteForApproval` return count.
3. Add `POST /:id/annotations/reset` with auth roles `supervisor`, `process`, `admin`.
4. Log `approval.annotations_reset` with `deletedCount`.
5. Run `npm test -- --run src/server/routes/approvalAnnotations.test.ts`.

### Task 2: Frontend API and Detail Page

**Files:**
- Modify: `src/client/api.ts`
- Modify: `src/client/pages/ApprovalDetailPage.tsx`
- Test: `src/client/api.test.ts`
- Test: `src/client/pages/approvalDetailLayout.test.ts`

**Steps:**
1. Add failing API/source tests for `resetApprovalAnnotations` and `resetAnnotations`.
2. Add `resetApprovalAnnotations(approvalId)` API helper.
3. Add `resetAnnotations()` in detail page with `window.confirm`.
4. Render `回退到初始版` next to `审查版 PDF` when annotations exist and user can create annotations.
5. Refresh annotation trace after reset.
6. Run focused frontend tests.

### Task 3: Verification

**Commands:**
- `npm test -- --run src/server/routes/approvalAnnotations.test.ts src/client/api.test.ts src/client/pages/approvalDetailLayout.test.ts`
- `npm test`
- `npm run build`

**Expected:** Focused tests pass, full regression passes, production build succeeds. Existing PDF async chunk warning may remain.
