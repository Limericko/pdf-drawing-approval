const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("serverConsole", {
  savePort: (port) => ipcRenderer.invoke("server-console:save-port", { port, restart: false }),
  savePortAndRestart: (port) => ipcRenderer.invoke("server-console:save-port", { port, restart: true }),
  openUrl: (url) => ipcRenderer.invoke("server-console:open-url", url),
  openDirectory: (key) => ipcRenderer.invoke("server-console:open-directory", key),
  copyText: (text) => ipcRenderer.invoke("server-console:copy-text", text),
  hideWindow: () => ipcRenderer.invoke("server-console:hide-window"),
  restart: () => ipcRenderer.invoke("server-console:restart")
});
