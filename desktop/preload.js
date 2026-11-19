const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ocbridgeDesktop", {
  setTheme: (options) => ipcRenderer.send("theme", options || {}),
});
