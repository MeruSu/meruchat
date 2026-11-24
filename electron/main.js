'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('node:path');

/**
 * MeruChat Electron main process.
 * Loads the local static UI (index.html in the project root) into a BrowserWindow.
 */
function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      // Secure defaults: context isolation on, no node integration in renderer.
      contextIsolation: true,
      nodeIntegration: false,
      // webSecurity stays default (true) — do not disable.
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // The static app lives one level up from electron/ (project root = webDir ".").
  win.loadFile(path.join(__dirname, '..', 'index.html'));

  return win;
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    // macOS: re-create a window when the dock icon is clicked and none are open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // Quit on all platforms except macOS (standard macOS behavior).
  if (process.platform !== 'darwin') app.quit();
});
