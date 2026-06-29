# Annotation Reset Design

## Goal

Support reverting an annotated review PDF back to the initial unannotated view by clearing the approval's annotation records. The source approval PDF and signed PDF must remain unchanged.

## Design

- Add a backend reset action: `POST /api/approvals/:id/annotations/reset`.
- Allow only `admin`, `supervisor`, and `process` users to reset annotations.
- Reject reset on readonly approvals, including `printed_archived` and `voided`.
- Delete all annotation records for that approval and return `{ reset: true, deletedCount }`.
- Write an operation log action `approval.annotations_reset` with the actor and deleted count.
- Add a frontend API helper `resetApprovalAnnotations`.
- Add a detail-page button labeled `回退到初始版` in the annotation panel when annotations exist and the user can create/manage annotations.
- Confirm before resetting because this removes annotation records.
- After reset, refresh annotations, logs, and comments so the review PDF link disappears and the left preview remains the original PDF.

## Non-Goals

- Do not snapshot every annotation version.
- Do not modify, overwrite, or copy the original PDF.
- Do not change signed PDF generation.

## Verification

- Route tests cover supervisor/admin reset, designer rejection, readonly rejection, deletion count, and operation log.
- API tests cover the new endpoint path and method.
- Layout/source tests cover the detail-page reset entry.
- Run `npm test` and `npm run build`.
