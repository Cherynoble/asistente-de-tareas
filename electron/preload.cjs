// Exposes a tiny, safe updater API to the dashboard's renderer. Only these three
// methods cross the bridge; everything else stays in the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('updater', {
  check: () => ipcRenderer.invoke('updater:check'),
  apply: (zipUrl) => ipcRenderer.invoke('updater:apply', zipUrl),
  version: () => ipcRenderer.invoke('updater:version'),
});
