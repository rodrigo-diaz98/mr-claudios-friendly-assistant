const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('assistantWindow', {
  startDrag: () => ipcRenderer.send('drag-start'),
  endDrag: () => ipcRenderer.send('drag-end'),
});
