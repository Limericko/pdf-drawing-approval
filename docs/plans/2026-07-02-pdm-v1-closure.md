# PDM V1 Closure Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close the remaining PDM V1 gaps so the lightweight drawing PDM can be used directly from the part ledger and detail pages, then package a verified release.

**Architecture:** Keep approval records as the source of file serving and review timeline data. Add PDM-specific revision maintenance APIs only where the PDM object owns the behavior, especially revision voiding and part trace aggregation. Frontend changes stay inside the existing PDM pages and approval detail repair flow.

**Tech Stack:** Node 24, TypeScript, Express, built-in `node:sqlite`, React/Vite, Vitest/Supertest, Electron packaging scripts.

---

## Scope

- Add direct original, signed, and annotated PDF file entry points on the PDM part detail page.
- Add PDM drawing revision voiding for admins, including current-version fallback and operation logs.
- Show PDM part trace records directly in part detail, based on related approval operation logs.
- Add inline repair controls to the PDM pending metadata list.
- Correct outdated verification notes for the PDM backfill admin UI.
- Bump version, build installers, sync release files to `E:\PDF服务端\pdf-approval\releases`, and run browser smoke checks.

## Task 1: PDM Revision Maintenance API

**Files:**
- Modify: `src/server/repositories/pdmParts.ts`
- Modify: `src/server/routes/pdm.ts`
- Modify: `src/server/routes/pdm.test.ts`
- Modify: `src/client/api.ts`

Steps:

1. Add failing route/repository tests for `POST /api/pdm/revisions/:id/void`.
2. Verify non-admin roles get `403`.
3. Verify admin void requires a non-empty reason and writes an operation log.
4. Verify voiding the current revision selects the newest non-voided historical revision as current, or clears current if none remain.
5. Implement repository methods for voiding and current revision recomputation.
6. Add API client functions and types.

## Task 2: PDM Part Trace API

**Files:**
- Modify: `src/server/routes/pdm.ts`
- Modify: `src/server/routes/pdm.test.ts`
- Modify: `src/client/api.ts`

Steps:

1. Add failing test that part detail returns recent trace logs from all revisions' approval IDs.
2. Include PDM publish, repair, backfill, print, signature, and review-related logs without exposing unrelated approvals.
3. Implement trace aggregation in `GET /api/pdm/parts/:id`.
4. Add client-side type fields.

## Task 3: PDM Detail UI

**Files:**
- Modify: `src/client/pages/PdmPartDetailPage.tsx`
- Modify: `src/client/pages/pdmPageLayout.test.ts`
- Modify: `src/client/styles.css`

Steps:

1. Add failing layout tests for file actions, trace timeline, and admin void controls.
2. Add direct actions for original PDF, signed PDF, annotated PDF, and approval detail per revision.
3. Add trace timeline tab/content in the part detail page.
4. Add admin-only void form for each revision, with confirmation and refresh.
5. Keep narrow-window layout card based and scan-friendly.

## Task 4: Pending Metadata Inline Repair

**Files:**
- Modify: `src/client/pages/PdmPendingMetadataPage.tsx`
- Modify: `src/client/pages/pdmPageLayout.test.ts`
- Modify: `src/client/styles.css`

Steps:

1. Add failing layout tests for inline repair controls and publish retry.
2. Add editable row state for document code, material code, and drawing name.
3. Save repair through the existing repair API and reload the queue.
4. Add publish retry button per row.
5. Keep open approval detail as a secondary action.

## Task 5: Docs, Version, Packaging, And Verification

**Files:**
- Modify: `docs/verification.md`
- Modify: `CHANGELOG.md`
- Modify version files discovered from existing release tests.
- Update generated release artifacts only through existing package scripts.

Steps:

1. Fix the outdated note that PDM historical backfill lacks an admin button.
2. Bump version for this release.
3. Run focused tests, full tests, build, and desktop tests.
4. Run browser smoke against the PDM list/detail/pending pages.
5. Build client and server installers.
6. Sync update manifest, changelog, and installers to `E:\PDF服务端\pdf-approval\releases`.
7. Record the verification results.
