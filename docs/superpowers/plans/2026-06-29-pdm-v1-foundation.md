# PDM V1 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build PDM V1 foundation for part master data, drawing revision release, deferred material/document identifiers, and traceable links back to existing approvals.

**Architecture:** Keep the existing approval workflow intact. Add PDM parsing, schema, repositories, and release service behind the current approval lifecycle, then expose read and maintenance APIs and finally add UI entry points.

**Tech Stack:** Node 24, TypeScript, Express, built-in `node:sqlite`, React/Vite, Vitest/Supertest.

---

## Scope

This plan implements the approved design in `docs/plans/2026-06-29-pdm-v1-design.md`.

The implementation stays on `feature/pdm-foundation` and avoids changes to packaging or production runtime paths until a verified release is explicitly requested.

## File Map

- `src/server/files/parseDrawingFileName.ts`: extend filename parser to return PDM metadata when available and metadata-pending states when identifiers are missing.
- `src/server/schema.sql`: add PDM columns on `approvals` and new PDM tables.
- `src/server/repositories/pdmParts.ts`: own part, revision, usage, publish issue, and metadata repair persistence.
- `src/server/services/pdmReleaseService.ts`: publish eligible approvals into PDM in a transaction.
- `src/server/routes/pdm.ts`: expose PDM list/detail/repair/publish APIs.
- `src/server/server.ts`: wire PDM repository, service, and routes.
- `src/client/api.ts`: add PDM client API types and calls.
- `src/client/roleAccess.ts`: add the `pdm` route for all signed-in roles.
- `src/client/pages/PdmPartsPage.tsx`: list parts, current revisions, metadata-pending records.
- `src/client/pages/PdmPartDetailPage.tsx`: show current revision, history, usage projects, and approval links.
- `src/client/pages/ApprovalDetailPage.tsx`: show PDM metadata and repair entry.

## Task 1: Parser Foundation

**Files:**
- Modify: `src/server/files/parseDrawingFileName.ts`
- Modify: `src/server/files/parseDrawingFileName.test.ts`

- [ ] Add tests for full PDM filename:
  - Input: `MP300A000072 《0102A00700883 400A按键》 a0A0.pdf`
  - Expected: `documentCode = "MP300A000072"`, `materialCode = "0102A00700883"`, `drawingName = "400A按键"`, `version = "a0A0"`, `metadataStatus = "complete"`.
- [ ] Add tests for missing document code:
  - Input: `《0102A00700883 400A按键》 a0A0.pdf`
  - Expected: `materialCode` parsed, `documentCode = null`, `metadataStatus = "missing_document_code"`.
- [ ] Add tests for missing material code:
  - Input: `400A按键-a0A0.pdf`
  - Expected: legacy approval remains valid, `materialCode = null`, `metadataStatus = "missing_material_code"`.
- [ ] Run `npm test -- --run src/server/files/parseDrawingFileName.test.ts` and verify the new tests fail before implementation.
- [ ] Implement `parsePdmDrawingFileName()` and extend the existing parser result without breaking old `partName/version` consumers.
- [ ] Run the same parser test and verify it passes.
- [ ] Commit parser changes with `feat: parse PDM drawing filenames`.

## Task 2: PDM Schema And Repository

**Files:**
- Modify: `src/server/schema.sql`
- Create: `src/server/repositories/pdmParts.ts`
- Create: `src/server/repositories/pdmParts.test.ts`

- [ ] Add failing repository tests for creating/finding a part by `materialCode`.
- [ ] Add failing tests for publishing a revision with unique `materialCode + version`.
- [ ] Add failing tests for setting a new revision as current and superseding the previous current revision.
- [ ] Add failing tests for recording cross-project usage without duplicating the part.
- [ ] Add failing tests for pending metadata records based on approval PDM columns.
- [ ] Run `npm test -- --run src/server/repositories/pdmParts.test.ts` and verify failure.
- [ ] Add schema tables: `pdm_parts`, `pdm_drawing_revisions`, `pdm_part_usages`.
- [ ] Add approval columns: `document_code`, `material_code`, `drawing_name`, `pdm_revision_id`, `pdm_metadata_status`, `pdm_publish_status`, `pdm_publish_error`.
- [ ] Implement `PdmPartRepository` methods used by the tests.
- [ ] Run repository tests and `npm test -- --run src/server/dbIndexes.test.ts`.
- [ ] Commit schema and repository with `feat: add PDM repository foundation`.

## Task 3: PDM Release Service

**Files:**
- Create: `src/server/services/pdmReleaseService.ts`
- Create: `src/server/services/pdmReleaseService.test.ts`
- Modify: `src/server/repositories/approvals.ts` if helper methods are needed.

- [ ] Add failing tests for publishing an approved signed approval into PDM.
- [ ] Add failing tests for metadata-pending when `materialCode` is missing.
- [ ] Add failing tests for allowing missing `documentCode` while still publishing.
- [ ] Add failing tests for duplicate `materialCode + version` failing without overwriting the current version.
- [ ] Add failing tests for metadata repair followed by publish retry.
- [ ] Run `npm test -- --run src/server/services/pdmReleaseService.test.ts` and verify failure.
- [ ] Implement release service using a SQLite transaction.
- [ ] Ensure the service writes `operation_logs` for publish, repair, duplicate failure, and current-version switch.
- [ ] Run service tests and relevant approval repository tests.
- [ ] Commit with `feat: publish approvals into PDM revisions`.

## Task 4: API Integration

**Files:**
- Create: `src/server/routes/pdm.ts`
- Create: `src/server/routes/pdm.test.ts`
- Modify: `src/server/server.ts`
- Modify: `src/server/routes/approvals.ts`
- Modify: `src/server/routes/submissions.ts`

- [ ] Add route tests for `GET /api/pdm/parts` with keyword/project filters and paging.
- [ ] Add route tests for `GET /api/pdm/parts/:id` and revision history.
- [ ] Add route tests for `GET /api/pdm/pending-metadata`.
- [ ] Add route tests for metadata repair permissions: admin all records, designer own records only, reviewers denied.
- [ ] Add route tests for publish retry permissions.
- [ ] Add route tests that approval pass triggers PDM release when eligible.
- [ ] Run `npm test -- --run src/server/routes/pdm.test.ts src/server/routes/approvals.test.ts src/server/routes/submissions.test.ts` and verify new tests fail.
- [ ] Implement routes and wire dependencies in `createServer`.
- [ ] Update submission/watch parsing so approvals store PDM metadata at creation.
- [ ] Run route tests.
- [ ] Commit with `feat: expose PDM APIs`.

## Task 5: Client PDM Pages

**Files:**
- Modify: `src/client/api.ts`
- Modify: `src/client/roleAccess.ts`
- Modify: `src/client/App.tsx`
- Create: `src/client/pages/PdmPartsPage.tsx`
- Create: `src/client/pages/PdmPartDetailPage.tsx`
- Create: `src/client/pages/pdmPageLayout.test.ts`
- Modify: `src/client/styles.css`

- [ ] Add client logic/layout tests for the `零件库` route available to designer, supervisor, process, and admin.
- [ ] Add tests for list fields: material code, drawing name, current revision, document code, usage projects, status.
- [ ] Add tests for empty state and metadata-pending badge copy.
- [ ] Run `npm test -- --run src/client/roleAccess.test.ts src/client/pages/pdmPageLayout.test.ts`.
- [ ] Implement API types and page components.
- [ ] Add navigation item and route handling.
- [ ] Run client tests and `npm run build`.
- [ ] Commit with `feat: add PDM part library UI`.

## Task 6: Approval Detail Metadata Repair UI

**Files:**
- Modify: `src/client/pages/ApprovalDetailPage.tsx`
- Modify: `src/client/pages/approvalDetailLayout.test.ts`
- Modify: `src/client/api.ts`
- Modify: `src/client/styles.css`

- [ ] Add tests that approval detail displays document code, material code, drawing name, metadata status, publish status, and linked part.
- [ ] Add tests that designers see repair controls only for their own pending metadata records.
- [ ] Add tests that admins can repair any pending metadata record.
- [ ] Implement compact PDM panel without disturbing PDF review layout.
- [ ] Run focused approval detail tests.
- [ ] Commit with `feat: add PDM metadata repair UI`.

## Task 7: Migration And Verification

**Files:**
- Create: `src/server/services/pdmBackfillService.ts`
- Create: `src/server/services/pdmBackfillService.test.ts`
- Modify: `docs/verification.md`
- Modify: `CHANGELOG.md`

- [ ] Add backfill tests for published approvals with complete standard filenames.
- [ ] Add backfill tests that skip old filenames, missing files, invalid PDFs, and duplicate material-version records.
- [ ] Implement backfill service as an admin-invoked service or maintenance helper.
- [ ] Run full verification:
  - `npm test`
  - `npm run build`
  - `npm run desktop:test`
- [ ] Update docs with PDM V1 behavior and known limits.
- [ ] Commit with `feat: add PDM backfill and verification docs`.

## First Batch Cut Line

The first implementation batch stops after Task 3. At that point the backend has PDM parsing, persistence, and publish service tests, but no user-facing PDM pages yet.

## Execution Choice

Because this feature spans many files and user-facing flows, the recommended execution mode is inline batches in the current `feature/pdm-foundation` branch, with verification and commits after each batch.
