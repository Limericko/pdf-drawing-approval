# Sidebar, Copy, and Performance Design

## Goal

Improve daily usability without changing approval, signing, folder watching, database, or deployment behavior.

## Scope

- Add a collapsible application sidebar for users who need more PDF and table workspace.
- Refresh the first batch of page copy so it tells users status, next action, and operational intent more clearly.
- Apply low-risk frontend performance improvements by reducing repeated route permission checks and keeping state helpers small and testable.

## Design Direction

The product remains a LAN-first Windows approval workbench for mechanical drawings. The UI should stay dense, quiet, and scannable. The collapsed sidebar should preserve orientation through short labels and `title` text, not hide navigation completely.

## Behavior

- Sidebar collapse state is stored in `localStorage`.
- Expanded width stays around the current 260px; collapsed width becomes a narrow rail.
- The toggle button is always visible in the sidebar.
- In collapsed mode:
  - Brand text compresses to a short product mark.
  - Navigation keeps short labels and hover titles.
  - User identity shows a compact role/name hint.
- Mobile keeps the existing single-column behavior; collapse is mainly for desktop and wider tablet use.

## Copy Rules

- Headings should name the work area.
- Helper text should answer what to do next.
- Empty states should explain why the area is empty and where records will appear.
- Error text remains concrete and operational.

## Performance Rules

- Compute route permission once per render and reuse it.
- Keep sidebar collapse helpers pure so they can be tested without rendering React.
- Avoid broad Settings-page data-flow changes in this batch; defer heavier tab-specific loading to a later focused pass.

## Validation

- Unit/source tests for sidebar storage helpers and structure.
- Existing routing, role access, style, and build checks.
- Full `npm test` and `npm run build` before delivery.
