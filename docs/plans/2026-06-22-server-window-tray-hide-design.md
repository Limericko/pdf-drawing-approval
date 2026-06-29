# Server Window Tray Hide Design

## Goal

Let the Windows server application hide its console window without stopping the approval service, so the server can keep running quietly after deployment.

## Recommended Behavior

- The server console page shows a `隐藏窗口` action.
- Clicking the action hides the Electron `BrowserWindow`; the Express server keeps running.
- Clicking the window close button also hides the window instead of quitting.
- A Windows tray icon remains available while the app is running.
- The tray menu provides `显示服务端窗口`, `打开本机工作台`, `打开日志目录`, and `退出服务端`.
- Only the tray `退出服务端` action performs a real app quit and stops the server.

## Architecture

The feature belongs to `apps/server-exe/main.cjs`, because window lifecycle and tray behavior are Electron main-process responsibilities. `serverConsoleView.cjs` renders the button, and `preload.cjs` exposes a single `hideWindow()` IPC method to keep the renderer sandboxed.

## Error Handling

If the tray icon cannot show a native notification, the app still hides the window. The tray menu remains the primary recovery path. URLs and directories keep using existing validated IPC handlers.

## Verification

Use source-level tests for the Electron shell behavior and HTML rendering tests for the console action. Then run the existing package tests and installer packaging command so the shipped service installer includes the new behavior.
