# Windows Installers Design

## Goal

Generate Windows installation packages for both the PDF approval service app and the desktop client so non-technical users can install from a setup wizard instead of copying portable folders manually.

## Scope

- Build one NSIS installer for the server app.
- Build one NSIS installer for the client app.
- Create desktop and Start Menu shortcuts.
- Keep the existing portable packages as the verified runtime source.
- Do not add auto-update, code signing, MSI, or Windows Service mode in this batch.

## Recommended Approach

Use `electron-builder` with `--prepackaged`:

1. Keep `scripts/desktopPackage.mjs` and `scripts/serverExePackage.mjs` as the source of the final runtime layout.
2. Generate portable folders first.
3. Run `electron-builder` against each prepackaged folder to create NSIS installers.

This keeps installer creation separate from the runtime packaging logic. The current portable packages have already been smoke-tested, so the installer is only responsible for installation, shortcuts, and uninstall entries.

## Products

### Server

- Product name: `PDF图纸审批服务端`
- App ID: `local.pdf-approval.server`
- Installer output: `dist/installers/server`
- Default install mode: per-user, no elevation.
- User can choose install directory.
- Runtime remains window-based; no Windows Service in this batch.

### Client

- Product name: `PDF图纸审批客户端`
- App ID: `local.pdf-approval.desktop-client`
- Installer output: `dist/installers/client`
- Default install mode: per-user, no elevation.
- User can choose install directory.
- First launch still asks for the server URL.

## Data and Configuration

The server executable still stores:

- `data`
- `backups`
- `logs`
- `server-config.json`

next to the installed server exe. Because the installer is per-user and no-elevation, the default install directory is user-writable.

## Verification

- Unit test generated installer configs and command arguments.
- `npm test`.
- `npm run build`.
- `npm run installer:package`.
- Confirm installer files exist under `dist/installers/client` and `dist/installers/server`.
- If possible, unpack or run the generated installers only on a disposable test machine later; this batch verifies packaging artifacts locally.
