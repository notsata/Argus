'use strict';

const { app, BrowserWindow, Menu, ipcMain, safeStorage } = require('electron/main');
const { shell } = require('electron/common');
const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');

let mainWindow = null;

app.whenReady().then(async () => {
  // Tell server.js where to store argus-holdings.json (Electron userData folder)
  const userData = app.getPath('userData');
  process.env.ARGUS_DATA_DIR = userData;

  // ── Encryption key setup (Windows DPAPI via safeStorage) ──────────────────
  // Generate a random 256-bit key once; store it encrypted with DPAPI so only
  // this Windows user account can decrypt Argus data files.
  if (safeStorage.isEncryptionAvailable()) {
    const keyFile = path.join(userData, '.argus-key');
    let hexKey;
    if (fs.existsSync(keyFile)) {
      const encryptedKey = fs.readFileSync(keyFile);
      hexKey = safeStorage.decryptString(encryptedKey);
    } else {
      hexKey = crypto.randomBytes(32).toString('hex');
      fs.writeFileSync(keyFile, safeStorage.encryptString(hexKey));
    }
    process.env.ARGUS_CRYPTO_KEY = hexKey;
  }
  // If safeStorage isn't available, server.js falls back to plain JSON.

  // Start the Express server inside this process
  require('./server.js');

  // Give Express a moment to bind to port 3000
  await new Promise(r => setTimeout(r, 800));

  createWindow();
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width:     1500,
    height:    920,
    minWidth:  1000,
    minHeight: 650,
    title:     'Argus',
    backgroundColor: '#21252b',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  Menu.setApplicationMenu(null);

  mainWindow.loadURL('http://localhost:3001');

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    // Only run auto-updater in a packaged (installed) build, not in dev
    if (app.isPackaged) startAutoUpdater();
  });

  mainWindow.webContents.on('did-fail-load', () => {
    setTimeout(() => { if (mainWindow) mainWindow.loadURL('http://localhost:3001'); }, 700);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Only open http/https URLs externally — block file://, javascript:, etc.
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── Auto-updater ──────────────────────────────────────────────────────────────
function startAutoUpdater() {
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload        = true;   // download silently in the background
    autoUpdater.autoInstallOnAppQuit = true;  // install if user closes without clicking Restart

    autoUpdater.on('update-available', info => {
      mainWindow?.webContents.send('update-status', { type: 'available', version: info.version });
    });
    autoUpdater.on('download-progress', p => {
      mainWindow?.webContents.send('update-status', { type: 'progress', percent: Math.round(p.percent) });
    });
    autoUpdater.on('update-downloaded', () => {
      mainWindow?.webContents.send('update-status', { type: 'ready' });
    });
    autoUpdater.on('update-not-available', () => {
      mainWindow?.webContents.send('update-status', { type: 'not-available' });
    });
    autoUpdater.on('error', err => {
      console.warn('[updater]', err.message);
      // Don't surface update errors to the user — fail silently
    });

    autoUpdater.checkForUpdates().catch(err => console.warn('[updater]', err.message));
  } catch (err) {
    // electron-updater not available or app-update.yml missing (e.g. portable build)
    console.warn('[updater] not available:', err.message);
  }
}

// "Check for Updates" button in Settings triggers this
ipcMain.on('check-for-updates', () => {
  if (!app.isPackaged) {
    mainWindow?.webContents.send('update-status', { type: 'not-available' });
    return;
  }
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.checkForUpdates().catch(err => console.warn('[updater]', err.message));
  } catch (err) {
    console.warn('[updater] check failed:', err.message);
  }
});

// "Restart Now" button in the renderer triggers this
ipcMain.on('install-update', () => {
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.quitAndInstall(/* isSilent */ false, /* isForceRunAfter */ true);
  } catch (err) {
    console.warn('[updater] install failed:', err.message);
  }
});

app.on('window-all-closed', () => app.quit());
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
