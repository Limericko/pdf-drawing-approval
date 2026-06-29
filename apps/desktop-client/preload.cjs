const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("pdfApprovalDesktop", {
  getServerUrl: () => ipcRenderer.invoke("desktop:get-server-url"),
  setServerUrl: (serverUrl) => ipcRenderer.invoke("desktop:set-server-url", serverUrl),
  clearServerUrl: () => ipcRenderer.invoke("desktop:clear-server-url"),
  getAppVersion: () => ipcRenderer.invoke("desktop:get-app-version"),
  getUpdateStatus: () => ipcRenderer.invoke("desktop:get-update-status"),
  checkForUpdates: () => ipcRenderer.invoke("desktop:check-for-updates"),
  openDownloadedUpdateInstaller: () => ipcRenderer.invoke("desktop:open-downloaded-update-installer"),
  onUpdateStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("desktop:update-status", listener);
    return () => ipcRenderer.removeListener("desktop:update-status", listener);
  },
  listPrinters: () => ipcRenderer.invoke("desktop:list-printers"),
  getPrintSettings: () => ipcRenderer.invoke("desktop:get-print-settings"),
  setPrintSettings: (printSettings) => ipcRenderer.invoke("desktop:set-print-settings", printSettings),
  printSignedPdf: (signedPdfUrl, printOptions) => ipcRenderer.invoke("desktop:print-signed-pdf", signedPdfUrl, printOptions)
});
