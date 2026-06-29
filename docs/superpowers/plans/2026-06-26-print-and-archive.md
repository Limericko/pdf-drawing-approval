# Print And Archive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Electron client print settings flow that prints the signed PDF and archives the approval only after the OS print callback succeeds.

**Architecture:** Keep the existing server archive API unchanged. Add a narrow Electron preload bridge for printer discovery, print settings persistence, and signed-PDF printing; add client-side helpers and an approval-detail print dialog that calls `markPrinted` only after the bridge reports success.

**Tech Stack:** Electron `webContents.getPrintersAsync` / `webContents.print`, React/Vite, TypeScript, Vitest, existing Express approval APIs.

---

### Task 1: Print Settings Model And Tests

**Files:**
- Create: `src/client/printSettings.ts`
- Create: `src/client/printSettings.test.ts`

- [x] **Step 1: Write failing tests for default settings, page-range parsing, and Electron print options.**

Run: `npm test -- --run src/client/printSettings.test.ts`  
Expected before implementation: FAIL because `printSettings.ts` does not exist.

- [x] **Step 2: Implement `defaultPrintSettings`, `parsePageRanges`, and `toDesktopPrintOptions`.**

The helper must convert `1,3,5-8` to Electron ranges, clamp copies and scale, and omit `pageSize` when using printer default paper.

- [x] **Step 3: Re-run the focused test.**

Run: `npm test -- --run src/client/printSettings.test.ts`  
Expected after implementation: PASS.

### Task 2: Electron Bridge

**Files:**
- Modify: `apps/desktop-client/main.cjs`
- Modify: `apps/desktop-client/preload.cjs`
- Modify: `apps/desktop-client/electronShell.test.mjs`
- Modify: `src/client/clientConfig.ts`
- Modify: `src/client/clientConfig.test.ts`

- [x] **Step 1: Write failing tests that the preload exposes printer APIs and the typed client bridge can call them.**

Run: `npm run desktop:test -- --run apps/desktop-client/electronShell.test.mjs` and `npm test -- --run src/client/clientConfig.test.ts`  
Expected before implementation: FAIL because printer bridge methods are missing.

- [x] **Step 2: Implement IPC handlers.**

Handlers:
- `desktop:list-printers`: return `{ name, displayName, description, isDefault }[]`.
- `desktop:get-print-settings`: read persisted client settings.
- `desktop:set-print-settings`: persist client settings.
- `desktop:print-signed-pdf`: load a signed-PDF URL in a hidden window and call `webContents.print`.

- [x] **Step 3: Return structured print results.**

Successful callback returns `{ success: true }`; failed/cancelled callback returns `{ success: false, failureReason }`; unexpected exceptions return a rejected IPC call with a readable message.

- [x] **Step 4: Re-run bridge tests.**

Expected: focused Electron and client-config tests pass.

### Task 3: Approval Detail UI

**Files:**
- Modify: `src/client/pages/ApprovalDetailPage.tsx`
- Modify: `src/client/styles.css`
- Create: `src/client/pages/approvalDetailPrint.test.ts`

- [x] **Step 1: Write failing tests for print availability and success/failure flow helpers.**

Run: `npm test -- --run src/client/pages/approvalDetailPrint.test.ts`  
Expected before implementation: FAIL because helper functions do not exist.

- [x] **Step 2: Implement print settings state and dialog.**

The dialog must support printer, copies, page range, paper, orientation, color, duplex, margins, scale, background, and a clear note that auto-archive happens only after successful print submission.

- [x] **Step 3: Implement `打印并归档`.**

Flow:
1. Open settings dialog.
2. Save chosen settings to Electron client.
3. Call `printSignedPdf(getSignedFileUrl(id, signedPdfCacheKey), options)`.
4. If success, call `markPrinted(id)` and refresh detail state.
5. If failure, show message and do not archive.

- [x] **Step 4: Keep browser fallback.**

When not running in Electron, show “打开签后 PDF” and manual “标记已打印归档”; do not show native printer settings controls.

- [x] **Step 5: Re-run focused UI helper tests.**

Expected: focused test passes.

### Task 4: Documentation And Verification

**Files:**
- Modify: `docs/user-manual.md`
- Modify: `docs/desktop-client-user-guide.md`
- Modify: `docs/verification.md`

- [x] **Step 1: Update docs.**

Document that Electron can print signed PDFs with parameters and then auto-archive on successful OS print callback; browser access remains manual.

- [x] **Step 2: Run focused and full verification.**

Run:
- `npm run desktop:test`
- `npm test -- --run src/client/printSettings.test.ts src/client/clientConfig.test.ts src/client/pages/approvalDetailPrint.test.ts`
- `npm run build`

Expected: all commands pass.
