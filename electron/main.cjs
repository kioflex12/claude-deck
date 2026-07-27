// Deck — Electron main process (Node). Поднимает встроенный localhost-сервер Deck на свободном порту
// и грузит его в BrowserWindow. Весь UI/логика — переиспользованный server.mjs + index.html.
'use strict';
const { app, BrowserWindow, Menu, shell, ipcMain } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let mainWindow = null;
let serverHandle = null;   // { port, url, close }

// Одно-инстанс лок: второй запуск фокусирует уже открытое окно.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });
  app.whenReady().then(start);
}

async function start() {
  // server.mjs — ESM; грузим динамическим import() из CommonJS-main.
  const mod = await import(pathToFileURL(path.join(__dirname, '..', 'server.mjs')).href);
  serverHandle = await mod.startServer();   // listen(0) → свободный порт

  const iconPng = path.join(__dirname, 'icon.png');
  mainWindow = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 600,
    backgroundColor: '#0e1116',
    title: 'Deck',
    icon: iconPng,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  Menu.setApplicationMenu(buildMenu());
  mainWindow.loadURL(serverHandle.url);

  // Внешние ссылки (Jira/GitLab/OAuth) — в системный браузер, не в новое окно приложения.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  mainWindow.on('closed', () => { mainWindow = null; });
}

// Мост для UI: открыть URL в системном браузере (для OAuth-логина Claude).
ipcMain.handle('deck:openExternal', (_e, url) => { if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url); return true; });

function buildMenu() {
  const isMac = process.platform === 'darwin';
  return Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { label: 'Файл', submenu: [ isMac ? { role: 'close' } : { role: 'quit' } ] },
    { label: 'Правка', submenu: [ { role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' } ] },
    { label: 'Вид', submenu: [ { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' } ] },
    { label: 'Окно', submenu: [ { role: 'minimize' }, { role: 'zoom' } ] },
  ]);
}

app.on('window-all-closed', async () => {
  try { if (serverHandle) await serverHandle.close(); } catch {}
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0 && serverHandle) start(); });
app.on('before-quit', async () => { try { if (serverHandle) await serverHandle.close(); } catch {} });
