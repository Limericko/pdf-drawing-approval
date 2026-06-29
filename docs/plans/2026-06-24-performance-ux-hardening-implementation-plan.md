# Performance UX Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Improve app performance and daily usability across frontend routing, list interactions, detail refreshes, UI rendering, and backend observability.

**Architecture:** Keep the current React/Vite + Express + SQLite architecture. Use route-level dynamic imports for large pages, debounced/deferred inputs for search, small helper functions for testable UI state, CSS rendering hints for growing lists, and lightweight Express middleware for slow request logging.

**Tech Stack:** TypeScript, React 19, Vite, Express, built-in node:sqlite, Vitest, Electron packaging.

---

### Task 1: Route-Level Lazy Loading

**Files:**
- Modify: `src/client/App.tsx`
- Test: `src/client/appLayout.test.ts`

**Steps:**
1. Add a failing source test that expects `React.lazy`, `Suspense`, page loader functions, and route preloading in `App.tsx`.
2. Run `npm test -- --run src/client/appLayout.test.ts` and verify the new test fails because route-level lazy loading is not implemented.
3. Replace synchronous business page imports with lazy loaders for `MyTasksPage`, `ApprovalsPage`, `ApprovalDetailPage`, `SettingsPage`, `SubmitDrawingPage`, `MySignaturePage`, and `ProfilePage`.
4. Add a compact page loading fallback and prefetch route modules from sidebar hover/focus.
5. Re-run `npm test -- --run src/client/appLayout.test.ts` and verify it passes.

### Task 2: Approval Ledger Search Responsiveness

**Files:**
- Modify: `src/client/pages/approvalListLogic.ts`
- Modify: `src/client/pages/ApprovalsPage.tsx`
- Test: `src/client/pages/approvalListLogic.test.ts`

**Steps:**
1. Add failing tests for a reusable `normalizeSearchKeyword` and `shouldResetPageForLedgerFilters` helper.
2. Run `npm test -- --run src/client/pages/approvalListLogic.test.ts` and verify the new tests fail.
3. Implement the helpers and use them in `ApprovalsPage.tsx`.
4. Add local keyword draft state, `useDeferredValue`, and a debounce timer so requests only use the committed keyword.
5. Show a small stale-results indicator while the input is ahead of the committed query.
6. Re-run the approval list tests.

### Task 3: Detail Page Refresh Reduction

**Files:**
- Modify: `src/client/pages/approvalDetailLogic.ts`
- Modify: `src/client/pages/ApprovalDetailPage.tsx`
- Test: `src/client/pages/approvalDetailLogic.test.ts`

**Steps:**
1. Add tests for `shouldRefreshPdfState` and `detailReloadErrorMessage`.
2. Run `npm test -- --run src/client/pages/approvalDetailLogic.test.ts` and verify the new tests fail.
3. Implement helper functions.
4. Use the helpers so detail actions only re-check the PDF when status, path, signed file, signature status, or archive state changes.
5. Add a visible retry action for PDF check failures.
6. Re-run the detail logic tests.

### Task 4: UI Rendering and Feedback Polish

**Files:**
- Modify: `src/client/styles.css`
- Modify: `src/client/pages/ApprovalsPage.tsx`
- Modify: `src/client/pages/settings/OperationsTab.tsx`
- Test: `src/client/styles.test.ts`
- Test: `src/client/pages/settingsDiagnostics.test.ts`

**Steps:**
1. Add failing source/style tests for `content-visibility`, stale result feedback, and operation list rendering hints.
2. Run the targeted tests and verify failure.
3. Add `content-visibility: auto` and `contain-intrinsic-size` to long rows/cards including operation logs, batch history rows, risk rows, table rows, and annotation rows where safe.
4. Tighten loading, empty, and batch result copy in the affected components.
5. Re-run targeted tests.

### Task 5: Backend Slow Request Observability and Index Review

**Files:**
- Modify: `src/server/server.ts`
- Modify: `src/server/schema.sql`
- Test: `src/server/server.test.ts`
- Test: `src/server/dbIndexes.test.ts`

**Steps:**
1. Add failing tests that assert a slow API request is logged without request body data, and expected indexes exist in `schema.sql`.
2. Run `npm test -- --run src/server/server.test.ts src/server/dbIndexes.test.ts` and verify failure.
3. Add Express middleware that logs API requests slower than a configurable threshold.
4. Add missing idempotent SQLite indexes for current high-traffic read paths.
5. Re-run targeted server tests.

### Task 6: Verification and Release Notes

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `src/shared/releaseNotes.ts`
- Modify: `src/shared/appVersion.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `apps/desktop-client/package.json`
- Modify: `apps/server-exe/package.json`
- Modify: `src/server/releaseVersion.test.ts`
- Modify: `docs/verification.md`

**Steps:**
1. Bump the app version to the next patch release.
2. Add concise release notes for performance and UX hardening.
3. Run targeted tests for changed areas.
4. Run `npm run build`.
5. Run `npm test`.
6. Run `npm run desktop:test`.
7. If all pass, run `npm run installer:package` to sync the real runtime release directory.
8. Append verification evidence to `docs/verification.md`.
