const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('assistantWindow', {
  startDrag: () => ipcRenderer.send('drag-start'),
  endDrag: () => ipcRenderer.send('drag-end'),
  isCollapsed: () => ipcRenderer.invoke('is-collapsed'),
  setCollapsedHeight: (height, animate) => ipcRenderer.send('set-collapsed-height', height, animate),
});
