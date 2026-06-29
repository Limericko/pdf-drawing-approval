# Sidebar Copy Performance Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a collapsible sidebar, polish first-batch UI copy, and reduce low-risk frontend render churn.

**Architecture:** Keep the existing React/Vite single-page frontend. Add pure sidebar state helpers in `App.tsx`, wire them into sidebar markup and CSS classes, and update page text in-place. Avoid backend or database changes.

**Tech Stack:** React 19, TypeScript, Vite, Vitest, CSS variables in `src/client/styles.css`.

---

### Task 1: Sidebar Collapse Helpers

**Files:**
- Modify: `src/client/App.tsx`
- Modify: `src/client/appRouting.test.ts`

**Steps:**
1. Add failing tests for sidebar storage key, read/write fallback, and collapsed class expectation.
2. Run `npm test -- --run src/client/appRouting.test.ts` and verify failure.
3. Export pure helpers from `App.tsx`.
4. Run the focused test and verify pass.

### Task 2: Sidebar Markup And Styles

**Files:**
- Modify: `src/client/App.tsx`
- Modify: `src/client/styles.css`
- Modify: `src/client/styles.test.ts`

**Steps:**
1. Add source/style tests for toggle button, collapsed class, narrow grid width, and compact nav labels.
2. Run focused tests and verify failure.
3. Implement sidebar state, toggle button, compact labels, and CSS.
4. Run focused tests and verify pass.

### Task 3: First-Batch Copy Polish

**Files:**
- Modify: `src/client/pages/LoginPage.tsx`
- Modify: `src/client/pages/MyTasksPage.tsx`
- Modify: `src/client/pages/ApprovalsPage.tsx`
- Modify: `src/client/pages/SubmitDrawingPage.tsx`
- Modify: `src/client/pages/MySignaturePage.tsx`
- Modify: `src/client/pages/ServerConnectionPage.tsx`
- Modify: `src/client/widgets/ApprovalTable.tsx`

**Steps:**
1. Add lightweight source assertions for key text where tests already exist.
2. Run focused tests and verify failure.
3. Update headings, helper text, empty text, and button text.
4. Run focused tests and verify pass.

### Task 4: Low-Risk Render Cleanup

**Files:**
- Modify: `src/client/App.tsx`

**Steps:**
1. Reuse a single `routeAllowed` boolean in render.
2. Avoid repeated `routeAllowedForRole(user, route.name)` calls in JSX.
3. Run `npm run build` to catch type regressions.

### Task 5: Verification

**Commands:**
- `npm test`
- `npm run build`

**Expected:**
- All tests pass.
- Production build completes.
