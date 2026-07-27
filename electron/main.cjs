// Deck — Electron main process (Node). Поднимает встроенный localhost-сервер Deck на свободном порту
// и грузит его в BrowserWindow. Весь UI/логика — переиспользованный server.mjs + index.html.
'use strict';
const { app, BrowserWindow, Menu, Tray, shell, ipcMain, nativeImage, Notification, screen, dialog, safeStorage } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

// Приватный GitHub-репозиторий с релизами (автообновление). Токен НЕ вшит — вводится пользователем, хранится через safeStorage.
const GH_OWNER = 'kioflex12';
const GH_REPO = 'claude-deck';

// AppUserModelID нужен Windows, иначе нативные уведомления идут без имени/иконки приложения.
app.setAppUserModelId('com.kioflex.deck');

let mainWindow = null;
let tray = null;
let serverHandle = null;   // { port, url, close }
app.isQuitting = false;    // true только при реальном выходе (не при сворачивании в трей)

// Настройки + геометрия окна, переживающие перезапуск. Живут в userData (доступно после ready).
let deckState = { minimizeToTray: true, bounds: null, isMaximized: false, autostart: false };
const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');

function loadState() {
  try { deckState = { ...deckState, ...JSON.parse(fs.readFileSync(stateFile(), 'utf8')) }; } catch {}
}
function saveState() {
  try {
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify(deckState, null, 2));
  } catch {}
}
let saveTimer = null;
function saveStateDebounced() { clearTimeout(saveTimer); saveTimer = setTimeout(saveState, 400); }

// Окно считается видимым, если его прямоугольник пересекается хоть с одним подключённым дисплеем
// (иначе восстановленная позиция могла остаться на отключённом мониторе — тогда открываем по центру).
function boundsVisible(b) {
  if (!b || typeof b.x !== 'number' || typeof b.width !== 'number') return false;
  return screen.getAllDisplays().some(d => {
    const w = d.workArea;
    return b.x < w.x + w.width && b.x + b.width > w.x && b.y < w.y + w.height && b.y + b.height > w.y;
  });
}
function captureBounds() {
  if (!mainWindow) return;
  deckState.isMaximized = mainWindow.isMaximized();
  const nb = mainWindow.getNormalBounds ? mainWindow.getNormalBounds() : mainWindow.getBounds();
  if (nb && nb.width > 0) deckState.bounds = nb;
}

// Одно-инстанс лок: второй запуск фокусирует уже открытое окно, а не поднимает второе.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { showWindow(); });
  app.whenReady().then(start);
}

async function start() {
  loadState();
  // server.mjs — ESM; грузим динамическим import() из CommonJS-main.
  const mod = await import(pathToFileURL(path.join(__dirname, '..', 'server.mjs')).href);
  serverHandle = await mod.startServer();   // listen(0) → свободный порт

  const iconPng = path.join(__dirname, 'icon.png');
  const useBounds = boundsVisible(deckState.bounds);
  const b = deckState.bounds;
  mainWindow = new BrowserWindow({
    width: useBounds ? b.width : 1440,
    height: useBounds ? b.height : 900,
    ...(useBounds ? { x: b.x, y: b.y } : {}),
    minWidth: 900, minHeight: 600,
    backgroundColor: '#0e1116',
    title: 'Deck',
    icon: iconPng,
    show: false,   // покажем после ready-to-show, чтобы не мигало белым
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  if (deckState.isMaximized) mainWindow.maximize();
  mainWindow.once('ready-to-show', () => mainWindow.show());

  refreshMenus();
  createTray();
  mainWindow.loadURL(serverHandle.url);
  // Тихая проверка обновлений на старте (в dev / без токена — молча выходит).
  mainWindow.webContents.once('did-finish-load', () => { checkForUpdates(); });

  // Внешние ссылки (Jira/GitLab/OAuth) — в системный браузер, не в новое окно приложения.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });

  mainWindow.on('resize', () => { captureBounds(); saveStateDebounced(); });
  mainWindow.on('move', () => { captureBounds(); saveStateDebounced(); });
  mainWindow.on('close', (e) => {
    captureBounds(); saveState();
    // ✕ по умолчанию прячет в трей; реальный выход — только через «Выход» или app.quit().
    if (deckState.minimizeToTray && !app.isQuitting) { e.preventDefault(); mainWindow.hide(); }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

// --- показ/скрытие окна ---
function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}
function toggleWindow() {
  if (!mainWindow) return;
  if (mainWindow.isVisible() && !mainWindow.isMinimized()) mainWindow.hide();
  else showWindow();
}

// --- автозапуск при входе в систему (источник истины — ОС) ---
function getAutostart() { try { return app.getLoginItemSettings().openAtLogin; } catch { return false; } }
function setAutostart(on) {
  try { app.setLoginItemSettings({ openAtLogin: !!on }); } catch {}
  deckState.autostart = !!on; saveState();
  refreshMenus();
}

// --- трей ---
function createTray() {
  if (tray) return;
  let img = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
  if (!img.isEmpty()) img = img.resize({ width: 16, height: 16 });   // трею Windows нужна мелкая иконка
  tray = new Tray(img);
  tray.setToolTip('Deck — доска сессий Claude Code');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', toggleWindow);
}
function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Открыть Deck', click: showWindow },
    { type: 'separator' },
    { label: 'Автозапуск при входе', type: 'checkbox', checked: getAutostart(), click: (mi) => setAutostart(mi.checked) },
    { label: 'Сворачивать в трей', type: 'checkbox', checked: deckState.minimizeToTray, click: (mi) => { deckState.minimizeToTray = mi.checked; saveState(); refreshMenus(); } },
    { type: 'separator' },
    { label: 'Проверить обновления…', click: openUpdatesUI },
    { label: 'О программе', click: showAbout },
    { type: 'separator' },
    { label: 'Выход', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
}

// --- нативные уведомления через main (надёжно даже когда окно свёрнуто в трей) ---
ipcMain.handle('deck:notify', (_e, opts) => {
  try {
    if (!Notification.isSupported()) return false;
    const { title, body, file } = opts || {};
    const n = new Notification({ title: String(title || 'Deck'), body: String(body || '') });
    n.on('click', () => {
      showWindow();
      if (file && mainWindow) mainWindow.webContents.send('open-session', String(file));
    });
    n.show();
    return true;
  } catch { return false; }
});

// Мост для UI: открыть URL в системном браузере (для OAuth-логина Claude).
ipcMain.handle('deck:openExternal', (_e, url) => { if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url); return true; });

// --- автообновление из приватного GitHub Releases по личному токену пользователя (D3) ---
// Токен шифруется safeStorage (OS keychain/DPAPI) и лежит в userData; в бандл НЕ вшивается.
const tokenFile = () => path.join(app.getPath('userData'), 'update-token.bin');
function encryptionOk() { try { return safeStorage.isEncryptionAvailable(); } catch { return false; } }
function readToken() {
  try { if (!encryptionOk()) return null; return safeStorage.decryptString(fs.readFileSync(tokenFile())) || null; } catch { return null; }
}
function writeToken(pat) {
  if (!encryptionOk()) throw new Error('OS-хранилище недоступно');
  fs.mkdirSync(path.dirname(tokenFile()), { recursive: true });
  fs.writeFileSync(tokenFile(), safeStorage.encryptString(String(pat)));
}
function clearToken() { try { fs.unlinkSync(tokenFile()); } catch {} }
function hasToken() { try { return fs.existsSync(tokenFile()); } catch { return false; } }

function sendUpdateStatus(state, extra) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-status', { state, ...(extra || {}) });
}
let updaterWired = false;
function wireUpdater() {
  if (updaterWired) return; updaterWired = true;
  autoUpdater.autoDownload = true;             // update-available → сразу качаем
  autoUpdater.autoInstallOnAppQuit = true;     // установка при выходе
  autoUpdater.on('checking-for-update', () => sendUpdateStatus('checking'));
  autoUpdater.on('update-available', (i) => { sendUpdateStatus('available', { version: i && i.version }); notifyUpdate(i); });
  autoUpdater.on('update-not-available', () => sendUpdateStatus('not-available'));
  autoUpdater.on('download-progress', (p) => sendUpdateStatus('downloading', { percent: Math.round(p && p.percent || 0) }));
  autoUpdater.on('update-downloaded', (i) => { sendUpdateStatus('downloaded', { version: i && i.version }); promptInstall(i); });
  autoUpdater.on('error', (e) => sendUpdateStatus('error', { message: String((e && e.message) || e) }));
}
// Возвращает {ok, reason?}: 'dev' — не упакован; 'no-token' — токен не задан.
async function checkForUpdates() {
  if (!app.isPackaged) { sendUpdateStatus('dev'); return { ok: false, reason: 'dev' }; }
  const pat = readToken();
  if (!pat) { sendUpdateStatus('no-token'); return { ok: false, reason: 'no-token' }; }
  wireUpdater();
  autoUpdater.setFeedURL({ provider: 'github', owner: GH_OWNER, repo: GH_REPO, private: true, token: pat });
  try { await autoUpdater.checkForUpdates(); return { ok: true }; }
  catch (e) { const reason = String((e && e.message) || e); sendUpdateStatus('error', { message: reason }); return { ok: false, reason }; }
}
function notifyUpdate(info) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: 'Доступно обновление Deck', body: 'Версия ' + ((info && info.version) || '') + ' загружается…' });
  n.on('click', showWindow); n.show();
}
async function promptInstall(info) {
  const r = await dialog.showMessageBox(mainWindow, {
    type: 'info', buttons: ['Перезапустить и обновить', 'Позже'], defaultId: 0, cancelId: 1,
    title: 'Обновление готово', message: 'Deck ' + ((info && info.version) || '') + ' загружено',
    detail: 'Установить сейчас? Приложение перезапустится.',
  });
  if (r.response === 0) { app.isQuitting = true; autoUpdater.quitAndInstall(); }
}
function showAbout() {
  dialog.showMessageBox(mainWindow, {
    type: 'info', title: 'О программе Deck', message: 'Deck ' + app.getVersion(),
    detail: 'Локальный менеджер контекстов Claude Code:\nдоска сессий + рабочая консоль.\n\n© 2026 kioflex',
    buttons: ['OK'],
  });
}
function openUpdatesUI() { showWindow(); if (mainWindow) mainWindow.webContents.send('open-updates'); }

ipcMain.handle('deck:appVersion', () => app.getVersion());
ipcMain.handle('deck:updateInfo', () => ({ version: app.getVersion(), hasToken: hasToken(), encryptionAvailable: encryptionOk(), packaged: app.isPackaged }));
ipcMain.handle('deck:setUpdateToken', (_e, pat) => {
  try {
    const v = pat != null ? String(pat).trim() : '';
    if (v) { writeToken(v); return { ok: true }; }
    clearToken(); return { ok: true, cleared: true };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});
ipcMain.handle('deck:checkForUpdates', async () => await checkForUpdates());

function refreshMenus() {
  Menu.setApplicationMenu(buildMenu());
  if (tray) tray.setContextMenu(buildTrayMenu());
}
function buildMenu() {
  const isMac = process.platform === 'darwin';
  return Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { label: 'Файл', submenu: [
      { label: 'Открыть Deck', click: showWindow },
      { type: 'separator' },
      { label: 'Автозапуск при входе', type: 'checkbox', checked: getAutostart(), click: (mi) => setAutostart(mi.checked) },
      { label: 'Сворачивать в трей', type: 'checkbox', checked: deckState.minimizeToTray, click: (mi) => { deckState.minimizeToTray = mi.checked; saveState(); refreshMenus(); } },
      { type: 'separator' },
      isMac ? { role: 'close' } : { label: 'Выход', click: () => { app.isQuitting = true; app.quit(); } },
    ] },
    { label: 'Правка', submenu: [ { role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' } ] },
    { label: 'Вид', submenu: [ { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' } ] },
    { label: 'Окно', submenu: [ { role: 'minimize' }, { role: 'zoom' } ] },
    { label: 'Помощь', role: 'help', submenu: [
      { label: 'Проверить обновления…', click: openUpdatesUI },
      { type: 'separator' },
      { label: 'О программе', click: showAbout },
    ] },
  ]);
}

app.on('window-all-closed', async () => {
  // Сюда попадаем только при реальном закрытии окна (minimizeToTray выкл или app.quit) — гасим сервер и выходим.
  try { if (serverHandle) await serverHandle.close(); } catch {}
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && serverHandle) start();
  else showWindow();
});
app.on('before-quit', async () => { app.isQuitting = true; try { if (serverHandle) await serverHandle.close(); } catch {} });
