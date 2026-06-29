# Role Guide And Quality Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add role-specific login workflow guidance, remove the old printer role from current UI logic, fix the nodemailer audit issue, and reduce avoidable frontend request churn.

**Architecture:** Keep the existing React/Vite + Express + SQLite architecture. Add small pure frontend helpers for guide content and request planning, then wire them into the existing `App`, `SubmitDrawingPage`, and `ApprovalsPage` components. Treat `printer` as historical database compatibility only, not a current user role in the client.

**Tech Stack:** TypeScript, React 19, Vite, Vitest, Express, built-in `node:sqlite`, Nodemailer.

---

### Task 1: Remove Current-Flow Printer Role From Client Types

**Files:**
- Modify: `src/client/api.ts`
- Modify: `src/client/App.tsx`
- Modify: `src/client/roleAccess.ts`
- Modify: `src/client/roleAccess.test.ts`

**Step 1: Write the failing test**

Update `src/client/roleAccess.test.ts` so it no longer expects a printer navigation branch and verifies only `designer`, `supervisor`, `process`, and `admin`.

**Step 2: Run test to verify it fails**

Run: `npm test -- --run src/client/roleAccess.test.ts`

Expected: fail while old printer expectation still exists.

**Step 3: Write minimal implementation**

Remove `printer` from the client `User["role"]` union and from `roleLabel`. Keep allowed navigation for the four active roles only.

**Step 4: Run test to verify it passes**

Run: `npm test -- --run src/client/roleAccess.test.ts`

Expected: pass.

### Task 2: Add Role Guide Pure Model

**Files:**
- Create: `src/client/roleGuide.ts`
- Create: `src/client/roleGuide.test.ts`

**Step 1: Write the failing test**

Test that `roleGuideForRole("designer")`, `"supervisor"`, `"process"`, and `"admin"` return the expected title, steps, and primary route. Test that no guide exists for `"printer"`.

**Step 2: Run test to verify it fails**

Run: `npm test -- --run src/client/roleGuide.test.ts`

Expected: fail because `roleGuide.ts` does not exist.

**Step 3: Write minimal implementation**

Implement guide metadata as a pure map keyed by active role.

**Step 4: Run test to verify it passes**

Run: `npm test -- --run src/client/roleGuide.test.ts`

Expected: pass.

### Task 3: Render Dismissible Role Guide

**Files:**
- Create: `src/client/widgets/RoleFlowGuide.tsx`
- Create: `src/client/widgets/RoleFlowGuide.test.ts`
- Modify: `src/client/App.tsx`
- Modify: `src/client/styles.css`

**Step 1: Write the failing test**

Test pure helpers for localStorage key generation and collapsed-state decisions, without depending on a DOM renderer.

**Step 2: Run test to verify it fails**

Run: `npm test -- --run src/client/widgets/RoleFlowGuide.test.ts`

Expected: fail because component/helper does not exist.

**Step 3: Write minimal implementation**

Render a compact guide bar above routed pages. Include title, step chips, primary action link, and collapse/expand control. Persist collapsed state in localStorage by role.

**Step 4: Run focused tests**

Run: `npm test -- --run src/client/roleGuide.test.ts src/client/widgets/RoleFlowGuide.test.ts src/client/appRouting.test.ts`

Expected: pass.

### Task 4: Optimize Submission Version Lookup

**Files:**
- Modify: `src/client/pages/submitDrawingLayout.test.ts`
- Modify: `src/client/pages/SubmitDrawingPage.tsx`

**Step 1: Write the failing test**

Add a test for `buildExistingVersionLookupPlan(projectName, items)`:

- Empty project returns no requests.
- Empty part names return no requests.
- Duplicate part names produce one request with multiple `clientIds`.

**Step 2: Run test to verify it fails**

Run: `npm test -- --run src/client/pages/submitDrawingLayout.test.ts`

Expected: fail because helper is missing.

**Step 3: Write minimal implementation**

Add the helper and use it in the effect. Add a short debounce before firing lookup requests.

**Step 4: Run test to verify it passes**

Run: `npm test -- --run src/client/pages/submitDrawingLayout.test.ts`

Expected: pass.

### Task 5: Guard Stale Approval List Requests

**Files:**
- Modify: `src/client/pages/ApprovalsPage.tsx`

**Step 1: Implement low-risk guard**

Use the existing effect cleanup pattern to ignore stale `listApprovals` results after filters change.

**Step 2: Run relevant tests**

Run: `npm test -- --run src/client/pages/approvalListLogic.test.ts src/client/widgets/ApprovalTable.test.ts`

Expected: pass.

### Task 6: Upgrade Nodemailer

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

**Step 1: Upgrade dependency**

Run: `npm install nodemailer@^9.0.1 --registry=https://registry.npmmirror.com`

**Step 2: Verify email tests**

Run: `npm test -- --run src/server/notifications/email.test.ts`

Expected: pass.

**Step 3: Verify audit**

Run: `npm audit --omit=dev --audit-level=moderate --registry=https://registry.npmjs.org`

Expected: no production vulnerabilities at moderate or above.

### Task 7: Final Verification And Docs

**Files:**
- Modify: `docs/verification.md`

**Step 1: Run final commands**

Run:

```powershell
npm test
npm run build
npm run desktop:test
```

**Step 2: Record results**

Append a V5.13 section to `docs/verification.md` with quality findings, fixes, and verification outputs.
