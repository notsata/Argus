// Electron main process — CommonJS so it works alongside ESM server.js
'use strict';

const { app, BrowserWindow, Menu, shell, ipcMain } = require('electron');
const path = require('path');

let mainWindow = null;

// ── Pass userData path to server so holdings.json goes in the right place ─────
// This runs before we import server.js so the env var is available to it
app.whenReady().then(async () => {
  process.env.PORTFOLIO_DATA_DIR = app.getPath('userData');

  // Start the Express server inside this process via dynamic ESM import
  await import('./server.js');

  // Give Express a moment to bind to the port
  await new Promise(r => setTimeout(r, 800));

  createWindow();
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width:     1500,
    height:    920,
    minWidth:  1000,
    minHeight: 650,
    title:     'Portfolio Terminal',
    backgroundColor: '#21252b',   // One Dark bg — no white flash on load
    show: false,                  // reveal only after page loads
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
    },
    // Use native OS title bar but hide the menu bar
    autoHideMenuBar: true,
  });

  // Remove the application menu entirely (no File/Edit/View/Help)
  Menu.setApplicationMenu(null);

  mainWindow.loadURL('http://localhost:3000');

  // Show window once the page is ready — no blank white flash
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // If server wasn't ready yet, retry
  mainWindow.webContents.on('did-fail-load', () => {
    setTimeout(() => {
      if (mainWindow) mainWindow.loadURL('http://localhost:3000');
    }, 600);
  });

  // Open external links in the default browser, not a new Electron window
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// Quit when all windows are closed
app.on('window-all-closed', () => app.quit());

// macOS: re-create window on dock icon click
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
