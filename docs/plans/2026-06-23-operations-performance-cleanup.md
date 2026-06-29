# Operations, Performance, and Cleanup Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Complete risk email triggering, approval list pagination, PDF module lazy loading, self-service email testing, and conservative cleanup operations.

**Architecture:** Add a system-level notification path for non-approval risks, keep existing approval notifications unchanged, and expose admin-only cleanup operations with dry-run support. Approval list paging is added as an opt-in API shape so older callers that expect arrays keep working.

**Tech Stack:** TypeScript, Express, React/Vite, Vitest, built-in node:sqlite, Node filesystem APIs.

---

### Task 1: System Risk Notifications and Self Test Email

**Files:**
- Create: `src/server/notifications/systemRiskNotifications.ts`
- Modify: `src/server/routes/profile.ts`
- Modify: `src/server/routes/system.ts`
- Modify: `src/server/server.ts`
- Test: `src/server/notifications/approvalNotifications.test.ts`
- Test: `src/server/routes/profile.test.ts`
- Test: `src/server/routes/system.test.ts`

**Steps:**
1. Write failing tests for admin `systemRisk` recipients and self-service test email.
2. Implement system risk email formatting, preference checks, missing email checks, SMTP skip handling, and operation logs.
3. Trigger it after manual scans and backup attempts using current risk data.
4. Run targeted notification/profile/system route tests.

### Task 2: Approval List Pagination and Keyword Search

**Files:**
- Modify: `src/server/repositories/approvals.ts`
- Modify: `src/server/routes/approvals.ts`
- Modify: `src/client/api.ts`
- Modify: `src/client/pages/ApprovalsPage.tsx`
- Test: `src/server/repositories/approvals.test.ts`
- Test: `src/server/routes/approvals.test.ts`
- Test: `src/client/api.test.ts`

**Steps:**
1. Write failing tests for paged repository and route response.
2. Add `listPaged` with status, signature status, reviewer role, keyword, page, and page size.
3. Keep legacy array response when paging is not requested.
4. Update the full approval ledger page to request server-side pages and reset selection on page/filter changes.

### Task 3: Lazy PDF Workspaces

**Files:**
- Modify: `src/client/pages/ApprovalDetailPage.tsx`
- Modify: `src/client/pages/SubmitDrawingPage.tsx`
- Test: `src/client/pages/approvalDetailLayout.test.ts`
- Test: `src/client/pages/submitDrawingLayout.test.ts`

**Steps:**
1. Write source-level tests for `React.lazy` and `Suspense`.
2. Lazy load PDF annotation and signature placement workspaces.
3. Keep lightweight type imports and default placement helpers synchronous.
4. Verify build output.

### Task 4: Cleanup Operations

**Files:**
- Create: `src/server/services/cleanupService.ts`
- Modify: `src/server/repositories/batchSubmissions.ts`
- Modify: `src/server/routes/system.ts`
- Modify: `src/server/server.ts`
- Modify: `src/client/api.ts`
- Modify: `src/client/pages/SettingsPage.tsx`
- Test: `src/server/services/cleanupService.test.ts`
- Test: `src/server/routes/system.test.ts`
- Test: `src/client/api.test.ts`

**Steps:**
1. Write failing tests for dry-run and execute cleanup behavior.
2. Clean temp uploads older than 24 hours using the existing temp upload cleanup helper.
3. Delete failed or partial batch submission records older than 30 days.
4. Delete only unreferenced signed PDF derivatives under managed approved/archive folders.
5. Add admin UI to preview and run cleanup.

### Task 5: Verification

**Commands:**
- `npm test`
- `npm run build`

**Expected:** Tests pass. Build passes; PDF code may remain a large async chunk but should no longer be pulled into ordinary page entry code.
