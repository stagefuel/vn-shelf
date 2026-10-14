'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('vns', {
  call: (method, ...args) => ipcRenderer.invoke('api', method, ...args),
  on: (channel, cb) => {
    if (!['game-state', 'games-changed', 'saveonce-result', 'import-progress', 'update-available', 'update-progress'].includes(channel)) return () => {};
    const fn = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, fn);
    return () => ipcRenderer.removeListener(channel, fn);
  },
  // Electron 32+ removed File.path; this gives the real path of a dropped file.
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return null; }
  },
});
