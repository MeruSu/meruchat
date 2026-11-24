'use strict';

// MeruChat Electron preload — empty shell.
// contextBridge is reserved here for future, explicitly-scoped IPC exposures.
//
// Example (kept commented so the surface stays empty for now):
//   const { contextBridge, ipcRenderer } = require('electron');
//   contextBridge.exposeInMainWorld('meruchat', {
//     // ping: () => ipcRenderer.invoke('meruchat:ping'),
//   });

const { contextBridge } = require('electron');

// No APIs exposed yet. Intentionally empty.
contextBridge.exposeInMainWorld('meruchat', {});
