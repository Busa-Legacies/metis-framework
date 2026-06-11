const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('aw', {
  openExternal: (url) => ipcRenderer.invoke('aw:open-external', url),
  getConfig: () => ipcRenderer.invoke('aw:get-config'),
  capturePreview: (rect) => ipcRenderer.invoke('aw:capture-preview', rect),
  isElectron: true,
})
