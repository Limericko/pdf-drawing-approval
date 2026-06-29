# Sidebar Icons Visual Refresh Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add icon-based navigation, make the collapsed sidebar show icons only, and reuse the packaged app icon as the in-app logo.

**Architecture:** Keep route permission data unchanged in `roleAccess.ts`. Add a local route-to-icon mapping in `App.tsx`, then adjust CSS so expanded navigation shows icon plus text and collapsed navigation shows a narrow icon rail. Use the existing `src/client/public/app-icon.png` asset for the brand mark.

**Tech Stack:** React, TypeScript, Vite, vanilla CSS, existing `lucide-react` dependency.

---

### Task 1: App Shell Markup

**Files:**
- Modify: `src/client/App.tsx`
- Test: `src/client/appLayout.test.ts`

**Steps:**
1. Import navigation icons from `lucide-react`.
2. Replace the text brand mark with `/app-icon.png`.
3. Render one icon per navigation route and keep text available in expanded mode.
4. Replace text chevrons with icon buttons for collapse and logout.
5. Update source tests to assert icon navigation and packaged logo usage.

### Task 2: Sidebar Styling

**Files:**
- Modify: `src/client/styles.css`
- Test: `src/client/styles.test.ts`

**Steps:**
1. Add icon slot sizing, hover states, and active icon treatment.
2. Make collapsed sidebar width a stable icon rail.
3. Hide text labels in collapsed mode and show only navigation icons.
4. Keep focus, title, and aria labels for accessibility.
5. Update CSS tests for icon-only collapsed behavior.

### Task 3: Verification

**Commands:**
- `npm test -- --run src/client/appLayout.test.ts src/client/styles.test.ts`
- `npm test`
- `npm run build`

**Expected:** Focused tests pass, full regression passes, and production build succeeds.
