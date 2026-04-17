'use strict';

// Preload script: runs in the renderer context with Node access.
// contextBridge exposes a minimal, typed API to the renderer — nothing else
// from the main process or Node.js is reachable from the page.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Called by index.html to receive update status events from the main process
  onUpdateStatus: (callback) => {
    ipcRenderer.on('update-status', (_event, data) => callback(data));
  },

  // Called by the "Restart Now" button to trigger install-and-relaunch
  installUpdate: () => ipcRenderer.send('install-update'),

  // Called by the "Check for Updates" button in Settings
  checkForUpdates: () => ipcRenderer.send('check-for-updates'),
});
