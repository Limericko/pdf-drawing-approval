# PDF approval UI redesign plan

## Design read

This is a LAN-only drawing approval workbench for a Windows mechanical design team. The interface should feel like a focused industrial operations tool: clear, compact, stable, and easy to scan during repeated daily use.

## Scope

- Preserve the current React, Vite, Express, and vanilla CSS stack.
- Preserve all routes, navigation labels, roles, approval flows, upload flows, signature flows, and PDF positioning behavior.
- Rework the visual system with existing CSS: tokens, app shell, sidebar, buttons, forms, tables, status chips, panels, floating panels, PDF preview, and signature placement surfaces.
- Avoid marketing-page patterns, decorative imagery, strong animation, new UI frameworks, or nonessential dependencies.

## Direction

- Theme: light operational workspace with a dark navigation rail.
- Accent: one restrained teal-blue primary color, with semantic success, warning, and danger colors only where state requires them.
- Density: daily workbench density, not landing-page spacing.
- Shape: 8px containers, 6px controls, small radius for PDF pages and signature handles.
- Motion: hover, active, and focus feedback only; no scroll choreography.

## Verification

- Run focused CSS and routing tests after styling changes.
- Run the full test suite if focused tests expose broader risk.
- Run `npm run build`.
- Restart or verify the local service and smoke test key routes in the browser when practical.
