# PDF Viewport Controls Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add reusable PDF zoom, fit-width, and pan controls to drawing annotation and signature placement previews.

**Architecture:** Keep the existing PDF.js canvas renderers and ratio-based overlay layers. Add a shared client widget for viewport state, toolbar rendering, page width calculation, wheel zoom, and drag-to-pan behavior, then wire it into both existing workspaces.

**Tech Stack:** React 19, TypeScript, Vite, Vitest, PDF.js legacy renderer, lucide-react.

---

## Task 1: Viewport Helpers

**Files:**
- Create: `src/client/widgets/PdfViewportControls.tsx`
- Create: `src/client/widgets/PdfViewportControls.test.ts`

**Steps:**
1. Write failing tests for zoom clamping, zoom labels, manual page width, fit-width page width, and `Ctrl + wheel` zoom.
2. Run `npm test -- --run src/client/widgets/PdfViewportControls.test.ts` and confirm it fails because the module is missing.
3. Implement the pure helper functions and toolbar component.
4. Re-run the focused test and confirm it passes.

## Task 2: Workspace Integration

**Files:**
- Modify: `src/client/widgets/PdfAnnotationWorkspace.tsx`
- Modify: `src/client/widgets/PdfSignaturePlacementWorkspace.tsx`
- Modify: `src/client/widgets/PdfAnnotationWorkspace.test.ts`
- Modify: `src/client/widgets/PdfSignaturePlacementWorkspace.test.ts`

**Steps:**
1. Write failing source/behavior tests proving both workspaces import and render `PdfViewportToolbar`, apply `pdfPageWidthStyle`, and wire pan/wheel handlers.
2. Run the two focused workspace tests and confirm they fail.
3. Integrate the shared controls into both workspaces.
4. Re-run the focused tests and confirm they pass.

## Task 3: Styling

**Files:**
- Modify: `src/client/styles.css`
- Modify: `src/client/styles.test.ts`

**Steps:**
1. Write failing style tests for the viewport toolbar, scroll container, pan cursor, and manual page width CSS variable.
2. Run `npm test -- --run src/client/styles.test.ts` and confirm it fails.
3. Add focused CSS for the new toolbar and scroll/pan states.
4. Re-run the style test and confirm it passes.

## Task 4: Verification

**Commands:**
- `npm test -- --run src/client/widgets/PdfViewportControls.test.ts src/client/widgets/PdfAnnotationWorkspace.test.ts src/client/widgets/PdfSignaturePlacementWorkspace.test.ts src/client/styles.test.ts`
- `npm run build`
- `npm test`

Expected: all commands exit 0. The existing PDF chunk size warning may remain.
