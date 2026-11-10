const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('assistantWindow', {
  startDrag: () => ipcRenderer.send('drag-start'),
  endDrag: () => ipcRenderer.send('drag-end'),
  isCollapsed: () => ipcRenderer.invoke('is-collapsed'),
  setCollapsedHeight: (height, animate) => ipcRenderer.send('set-collapsed-height', height, animate),
  openPopover: (sessionId, cardCenterY) => ipcRenderer.send('popover-open', sessionId, cardCenterY),
  resizePopover: (height) => ipcRenderer.send('popover-resize', height),
  closePopover: () => ipcRenderer.send('popover-close'),
  onPopoverLayout: (listener) => ipcRenderer.on('popover-layout', (_event, layout) => listener(layout)),
  onPopoverClosed: (listener) => ipcRenderer.on('popover-closed', () => listener()),
});
