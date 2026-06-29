# Server Exe Console Design

## Goal

Improve the Windows service executable window so a non-technical administrator can see service status, change the HTTP port, open the approval workspace, and find data/log directories without editing environment variables or command-line scripts.

## Scope

- Keep the service executable as a deployment console, not a second business-admin backend.
- Keep approval root, users, signatures, SMTP, reports, and operational tracing inside the Web management UI.
- Persist only local service startup settings in the exe package directory.

## Recommended Approach

Use the existing Electron service host and add a small testable CommonJS helper layer:

- `serverRuntimeConfig.cjs` loads/saves `server-config.json` next to the exe and validates the port.
- `serverConsoleView.cjs` renders a denser two-column service console HTML page.
- `main.cjs` wires Electron IPC actions to save settings, relaunch the app, open URLs, and open local directories.

## UI Direction

Purpose: server startup and deployment control for a Windows LAN approval system.

Audience: a mechanical design team administrator or designer who may not know Node.js, ports, or service logs.

Tone: utilitarian, calm, industrial, and scannable.

Memorable detail: a clear status rail with service state, addresses, and startup settings in one window, using restrained green/amber/red state cues instead of decorative visuals.

Constraints: no new UI framework, no browser storage dependency, no external service. The page is rendered inside Electron from local HTML and uses IPC for privileged actions.

## Data Flow

1. On app start, `main.cjs` reads `server-config.json` from the package root.
2. It computes the effective port using environment variable `PORT` first, then saved config, then default `8080`.
3. It starts Express with the effective port.
4. The console page displays the status and editable port field.
5. Saving port writes `server-config.json`; saving and restarting writes the file then relaunches Electron.

## Error Handling

- Invalid port input shows an inline validation message.
- Port occupied errors display a Chinese `端口 xxxx 已被占用` message in the service window.
- Directory open failures are logged to `logs/server.err.log`.

## Verification

- Unit test config normalization and persistence.
- Unit test rendered HTML contains the service status, port setting form, and directory actions.
- Run `npm test`, `npm run build`, `npm run server:exe`.
- Smoke start the packaged exe on a temporary port and check `/health`.
