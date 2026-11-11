const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("nightdeckWindow", {
  minimize: () => ipcRenderer.send("nd-window", "minimize"),
  maximize: () => ipcRenderer.send("nd-window", "maximize"),
  close: () => ipcRenderer.send("nd-window", "close"),
  resetSize: () => ipcRenderer.send("nd-window", "resetSize"),
  toggleConsole: () => ipcRenderer.send("nd-window", "toggleConsole"),
  update: () => ipcRenderer.send("nd-window", "update"),
  log: (msg) => ipcRenderer.send("nd-log", String(msg)),
  clearLog: () => ipcRenderer.send("nd-log-clear"),
  onLog: (cb) => ipcRenderer.on("nd-log", (e, msg) => cb(msg))
});
