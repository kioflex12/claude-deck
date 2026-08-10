// Deck — Electron main process (Node). Поднимает встроенный localhost-сервер Deck на свободном порту
// и грузит его в BrowserWindow. Весь UI/логика — переиспользованный server.mjs + index.html.
'use strict';
const { app, BrowserWindow, Menu, Tray, shell, ipcMain, nativeImage, Notification, screen, dialog } = require('electron');
const { autoUpdater, CancellationToken } = require('electron-updater');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const { pathToFileURL } = require('node:url');

// Автообновление читает релизы из ПУБЛИЧНОГО repo claude-deck (и исходники, и релизы в одном месте).
// Публичный → токен не нужен, любой обновляется в один клик.
const GH_OWNER = 'kioflex12';
const GH_REPO = 'claude-deck';

// AppUserModelID нужен Windows, иначе нативные уведомления идут без имени/иконки приложения.
app.setAppUserModelId('com.kioflex.deck');

let mainWindow = null;
let tray = null;
let serverHandle = null;   // { port, url, close }
app.isQuitting = false;    // true только при реальном выходе (не при сворачивании в трей)

// Настройки + геометрия окна, переживающие перезапуск. Живут в userData (доступно после ready).
let deckState = { minimizeToTray: true, bounds: null, isMaximized: false, autostart: false, port: null };
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
  // СТАБИЛЬНЫЙ порт (переиспользуем прошлый, дефолт 4317): origin = localhost:<порт> постоянен → localStorage
  // (режим/модель/effort/уведомления) переживает перезапуск. Раньше был listen(0) → новый порт каждый раз →
  // новый origin → пустой localStorage → настройки «сбрасывались». Порт занят → startServer падает на свободный.
  serverHandle = await mod.startServer(deckState.port || 4317);
  if (serverHandle.port !== deckState.port) { deckState.port = serverHandle.port; saveState(); }   // запомнить фактический (для следующего запуска)

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
      nodeIntegrationInSubFrames: true,   // preload (window.deckNative) должен работать и в iframe-панях воркспейса — открыть файл/ссылку, путь файла для вложений
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

  const deckOrigin = (() => { try { return new URL(serverHandle.url).origin; } catch { return ''; } })();
  const isExternalHttp = (url) => { try { const u = new URL(url); return (u.protocol === 'http:' || u.protocol === 'https:') && u.origin !== deckOrigin; } catch { return false; } };
  // Внешние ссылки (Jira/GitLab/OAuth) — в системный браузер. ЛОКАЛЬНЫЕ/относительные ссылки резолвятся в deckOrigin/<путь>:
  // их НЕ открываем как веб (иначе в браузере откроется страница Deck) — рендерер сам обработает их как файлы.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { if (isExternalHttp(url)) shell.openExternal(url); return { action: 'deny' }; });
  // Окно Deck не должно уходить с приложения: любой переход на не-корневой URL (клик по ссылке на файл) — отменяем;
  // внешний http — в браузер. Так тап по ссылке на .md и т.п. больше не подменяет окно страницей Deck.
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (url === serverHandle.url || url === deckOrigin + '/') return;   // сам app / reload — разрешаем
    e.preventDefault();
    if (isExternalHttp(url)) shell.openExternal(url);
  });

  // Масштаб — только через before-input-event, а не аксельраторы меню. Роль zoomIn слушает Ctrl+Plus, но на многих
  // раскладках «+» физически приходит как Ctrl+Shift+= (или Ctrl+= без Shift) — сочетание до роли не доходило, и
  // увеличение работало лишь кнопкой меню, тогда как Ctrl+Minus работал. Здесь ловим все варианты клавиши сами.
  mainWindow.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return;
    const k = String(input.key || '');
    if (k === '+' || k === '=' || k === 'Add') { zoomStep(1); e.preventDefault(); }
    else if (k === '-' || k === '_' || k === 'Subtract') { zoomStep(-1); e.preventDefault(); }
    else if (k === '0') { zoomStep(0); e.preventDefault(); }
  });

  mainWindow.on('resize', () => { captureBounds(); saveStateDebounced(); });
  mainWindow.on('move', () => { captureBounds(); saveStateDebounced(); });
  mainWindow.on('close', (e) => {
    captureBounds(); saveState();
    // ✕ по умолчанию прячет в трей; реальный выход — только через «Выход» или app.quit().
    if (deckState.minimizeToTray && !app.isQuitting) { e.preventDefault(); mainWindow.hide(); }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

// Шаг масштаба (0 — сброс). Уровни, а не zoomFactor: шаг 0.5 совпадает с шагом штатных ролей zoomIn/zoomOut.
function zoomStep(dir) {
  if (!mainWindow) return;
  const wc = mainWindow.webContents;
  wc.setZoomLevel(dir === 0 ? 0 : Math.max(-6, Math.min(7, wc.getZoomLevel() + dir * 0.5)));
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
// Открыть ЛОКАЛЬНЫЙ ресурс (клик по ссылке на .md и т.п. в выводе). Относительный путь резолвим от cwd сессии,
// снимаем :line-суффикс. Открывается в дефолтном приложении ОС (shell.openPath), а не в окне Deck.
ipcMain.handle('deck:openPath', async (_e, opts) => {
  opts = opts || {};
  let p = String(opts.path || '').trim(); const cwd = String(opts.cwd || '');
  if (!p) return { ok: false, error: 'empty' };
  p = p.replace(/:\d+(?::\d+)?$/, '');                                   // file.md:42[:col] → file.md
  // C8: не отдаём в shell.openPath исполняемые/скриптовые расширения — иначе крафтнутая в транскрипте ссылка на .exe/.bat
  // открылась бы = запустилась дефолтным приложением ОС. Ссылки в выводе — это доки (.md/.json/…), не бинарники.
  if (/\.(exe|bat|cmd|com|scr|msi|ps1|vbs|vbe|js|jse|wsf|wsh|sh|command|app|jar|reg|lnk|hta|cpl|msc|pif|gadget)$/i.test(p)) return { ok: false, error: 'исполняемые файлы через Deck не открываются' };
  const isAbs = /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(p);
  let full = isAbs ? p : (cwd ? path.join(cwd, p) : p);
  try { if (!fs.existsSync(full)) return { ok: false, error: 'not found: ' + full }; } catch {}
  try { const err = await shell.openPath(full); return { ok: !err, error: err || '' }; }
  catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});

// --- Запуск Unity инстанса по клику на cu-тег карточки. Пути машинно-зависимые → из cwd/настроек, не хардкод. ---
function readDeckConfig() { try { return JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'deck-config.json'), 'utf8')) || {}; } catch { return {}; } }
// Папка Unity-проекта: (1) из cwd, если в нём есть сегмент client-unity-<N> — берём путь ДО и включая его;
// (2) иначе <clientUnityParent из настроек>/client-unity-<N> (N из cu).
function resolveUnityProject(cu, cwd, cfg) {
  const segs = String(cwd || '').split(/[\\/]/);
  const idx = segs.findIndex((s) => /^client-unity-\d+$/i.test(s));
  if (idx >= 0) return segs.slice(0, idx + 1).join(path.sep);
  const n = String(cu || '').match(/\d+/);
  if (cfg.clientUnityParent && n) return path.join(cfg.clientUnityParent, 'client-unity-' + n[0]);
  return null;
}
// Кандидаты редактора Unity под версию проекта: override из настроек + Unity Hub secondaryInstallPath + дефолт по ОС.
function unityEditorCandidates(version, cfg) {
  const dirs = [];
  if (cfg.unityEditorsDir) dirs.push(cfg.unityEditorsDir);
  try { const sp = fs.readFileSync(path.join(app.getPath('appData'), 'UnityHub', 'secondaryInstallPath.json'), 'utf8').trim().replace(/^"|"$/g, ''); if (sp) dirs.push(sp); } catch {}
  if (process.platform === 'win32') dirs.push('C:\\Program Files\\Unity\\Hub\\Editor');
  else if (process.platform === 'darwin') dirs.push('/Applications/Unity/Hub/Editor');
  else dirs.push(path.join(os.homedir(), 'Unity', 'Hub', 'Editor'));
  const tail = process.platform === 'win32' ? ['Editor', 'Unity.exe']
    : process.platform === 'darwin' ? ['Unity.app', 'Contents', 'MacOS', 'Unity']
    : ['Editor', 'Unity'];
  return dirs.filter(Boolean).map((d) => path.join(d, version || '', ...tail));
}
function launchDetached(cmd, args) { spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref(); }
// Фокус уже открытого редактора. Сопоставляем по ИМЕНИ проекта (заголовок окна Unity = "<Имя проекта> - <Сцена> - …"),
// без хардкода схемы client-unity-N: name = имя папки резолвнутого проекта. cuNum — запасной матч для WO, если папка не резолвится.
function focusUnity(name, cuNum) {
  if (process.platform === 'win32') return focusUnityWin(name, cuNum);
  if (process.platform === 'darwin') return focusUnityMac(name, cuNum);
  return Promise.resolve('NOTRUNNING');
}
function focusUnityWin(name, cuNum) {
  return new Promise((resolve) => {
    const ps = [
      'param([string]$name="",[string]$cuNum="")',
      '$ErrorActionPreference="SilentlyContinue"',
      'Add-Type @"',
      'using System;using System.Runtime.InteropServices;',
      'public class DeckWin{[DllImport("user32.dll")]public static extern bool SetForegroundWindow(IntPtr h);[DllImport("user32.dll")]public static extern bool ShowWindowAsync(IntPtr h,int n);}',
      '"@',
      '$cand=Get-Process -Name Unity -ErrorAction SilentlyContinue|Where-Object{$_.MainWindowHandle -ne 0}',
      '$match=$null',
      'if($name -ne ""){foreach($p in $cand){$t="$($p.MainWindowTitle)".ToLower();if($t.StartsWith($name.ToLower()+" ") -or $t -eq $name.ToLower()){$match=$p;break}}}',
      'if($match -eq $null -and $cuNum -ne ""){foreach($p in $cand){if("$($p.MainWindowTitle)" -match "^client-unity-$cuNum(?!\\d)"){$match=$p;break}}}',
      'if($match -ne $null){[DeckWin]::ShowWindowAsync($match.MainWindowHandle,9)|Out-Null;[DeckWin]::SetForegroundWindow($match.MainWindowHandle)|Out-Null;Write-Output "FOCUSED"}else{Write-Output "NOTRUNNING"}',
    ].join('\n');
    const ps1 = path.join(app.getPath('userData'), 'deck-focus-unity.ps1');
    try { fs.writeFileSync(ps1, ps, 'utf8'); } catch { return resolve('ERR'); }
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-name', name || '', '-cuNum', cuNum || ''],
      { windowsHide: true, timeout: 9000 },
      (err, stdout) => resolve(/FOCUSED/.test(String(stdout || '')) ? 'FOCUSED' : (err ? 'ERR' : 'NOTRUNNING')));
  });
}
function focusUnityMac(name) {
  return new Promise((resolve) => {
    if (!name) return resolve('NOTRUNNING');
    execFile('/bin/sh', ['-c', 'ps -ax -o command | grep -i "Unity" | grep -iF "' + name.replace(/"/g, '') + '" | grep -v grep | head -1'],
      { timeout: 6000 }, (_e, out) => {
        if (!String(out || '').trim()) return resolve('NOTRUNNING');
        execFile('osascript', ['-e', 'tell application "Unity" to activate'], { timeout: 5000 }, () => resolve('FOCUSED'));
      });
  });
}
async function openUnity({ cu, cwd } = {}) {
  try {
    const cfg = readDeckConfig();
    const dir = resolveUnityProject(cu, cwd, cfg);
    const cuNum = (String(cu || '').match(/\d+/) || [''])[0];
    const projName = dir ? path.basename(dir) : '';
    // 1) редактор уже открыт → просто вывести окно на передний план (по имени проекта; cuNum — запасной матч для WO)
    try { if ((await focusUnity(projName, cuNum)) === 'FOCUSED') return { ok: true, focused: true }; } catch {}
    // 2) не открыт → запустить (для запуска нужна папка проекта)
    if (!dir) return { ok: false, error: 'Редактор не запущен, и папка проекта не определена — укажи «Папка client-unity копий» в ⚙ Настройки' };
    const verFile = path.join(dir, 'ProjectSettings', 'ProjectVersion.txt');
    if (!fs.existsSync(verFile)) return { ok: false, error: 'Не Unity-проект: ' + dir + ' — проверь путь в ⚙ Настройки' };
    let version = '';
    try { const m = fs.readFileSync(verFile, 'utf8').match(/m_EditorVersion:\s*(\S+)/); version = m ? m[1] : ''; } catch {}
    for (const exe of unityEditorCandidates(version, cfg)) {
      if (!fs.existsSync(exe)) continue;
      if (process.platform === 'darwin') { const appPath = exe.replace(/\/Contents\/MacOS\/Unity$/, ''); launchDetached('open', ['-a', appPath, '--args', '-projectPath', dir]); }
      else launchDetached(exe, ['-projectPath', dir]);
      return { ok: true, launched: 'Unity ' + version };
    }
    // Фолбэк — Unity Hub.
    if (process.platform === 'win32') {
      const hub = cfg.unityHubPath || 'C:\\Program Files\\Unity Hub\\Unity Hub.exe';
      if (fs.existsSync(hub)) { launchDetached(hub, ['--', '--projectPath', dir]); return { ok: true, launched: 'Unity Hub' }; }
    } else if (process.platform === 'darwin') {
      const hub = cfg.unityHubPath || '/Applications/Unity Hub.app';
      if (fs.existsSync(hub)) { launchDetached('open', ['-a', hub, '--args', '--', '--projectPath', dir]); return { ok: true, launched: 'Unity Hub' }; }
    } else {
      const hub = cfg.unityHubPath || '';
      if (hub && fs.existsSync(hub)) { launchDetached(hub, ['--', '--projectPath', dir]); return { ok: true, launched: 'Unity Hub' }; }
    }
    return { ok: false, error: 'Unity ' + (version || '') + ' / Hub не найден — укажи путь в ⚙ Настройки' };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}
ipcMain.handle('deck:open-unity', (_e, opts) => openUnity(opts || {}));

// --- автообновление из ПУБЛИЧНОГО GitHub Releases (claude-deck-releases). Токен не нужен: релизы читаются анонимно. ---

function sendUpdateStatus(state, extra) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-status', { state, ...(extra || {}) });
}
let updaterWired = false;
let lastAvailableVersion = '';   // версия найденного апдейта — чтобы после отмены загрузки вернуть кнопку «Обновить»
let downloadCancel = null;       // CancellationToken текущей загрузки (для крестика «отменить»)
function wireUpdater() {
  if (updaterWired) return; updaterWired = true;
  autoUpdater.autoDownload = false;            // НЕ качаем сами: загрузка только по кнопке «Обновить» (deck:downloadUpdate)
  // S2: НЕ ставим молча при выходе. Сборка не подписана (нет сертификата) — установку разрешаем ТОЛЬКО явной кнопкой
  // «Перезапустить и установить» (deck:quitAndInstall), чтобы неподписанный апдейт не применялся без согласия. Скачанное
  // ждёт кнопки; повторный запуск заново предложит установку. Целостность — sha512 из latest.yml по HTTPS (см. SECURITY.md).
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.disableDifferentialDownload = true;   // ОДНА полная загрузка. Delta давала ДВЕ загрузки на глазах у юзера:
                                                    // быстрый delta-проход по блокам, а когда diff не сходится (bundle-asar
                                                    // меняется каждый билд — timestamps и т.п.) — медленный полный fallback.
                                                    // Это путало и по итогу медленнее чистого full. Реальное ускорение —
                                                    // урезать пакет (154МБ, из них ~248МБ распакованного неиспользуемого
                                                    // claude-бинаря SDK), а не delta поверх толстого инсталлятора.
  // Подпись убрана (self-signed сертификата больше нет) → штатная проверка Authenticode отклоняла бы неподписанную
  // сборку («not signed by the application owner»). Отключаем её: целостность обеспечивает sha512 из latest.yml
  // (HTTPS + хэш из GitHub-релиза). Только Windows — verifyUpdateCodeSignature есть лишь у NsisUpdater.
  if (process.platform === 'win32') autoUpdater.verifyUpdateCodeSignature = () => Promise.resolve(null);
  autoUpdater.on('checking-for-update', () => sendUpdateStatus('checking'));
  autoUpdater.on('update-available', (i) => { lastAvailableVersion = (i && i.version) || ''; sendUpdateStatus('available', { version: lastAvailableVersion }); notifyUpdate(i); });
  autoUpdater.on('update-not-available', () => sendUpdateStatus('not-available'));
  autoUpdater.on('download-progress', (p) => sendUpdateStatus('downloading', { percent: Math.round(p && p.percent || 0) }));
  autoUpdater.on('update-downloaded', (i) => sendUpdateStatus('downloaded', { version: i && i.version }));   // без нативного попапа — ставит in-app кнопка «Перезапустить и установить» (тихий oneClick)
  autoUpdater.on('error', (e) => sendUpdateStatus('error', { message: String((e && e.message) || e) }));
}
// Возвращает {ok, reason?}: 'dev' — не упакован (обновления только в установленном приложении).
async function checkForUpdates() {
  if (!app.isPackaged) { sendUpdateStatus('dev'); return { ok: false, reason: 'dev' }; }
  wireUpdater();
  autoUpdater.setFeedURL({ provider: 'github', owner: GH_OWNER, repo: GH_REPO });   // публичный repo → без токена
  try { await autoUpdater.checkForUpdates(); return { ok: true }; }
  catch (e) { const reason = String((e && e.message) || e); sendUpdateStatus('error', { message: reason }); return { ok: false, reason }; }
}
function notifyUpdate(info) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: 'Доступно обновление Deck', body: 'Версия ' + ((info && info.version) || '') + ' — откройте Deck и нажмите «Обновить».' });
  n.on('click', showWindow); n.show();
}
function showAbout() {
  dialog.showMessageBox(mainWindow, {
    type: 'info', title: 'О программе Deck', message: 'Deck ' + app.getVersion(),
    detail: 'Локальный менеджер контекстов Claude Code:\nдоска сессий + рабочая консоль.\n\n© 2026 kioflex',
    buttons: ['OK'],
  });
}
function openUpdatesUI() { showWindow(); if (mainWindow) mainWindow.webContents.send('open-updates'); }
// Ctrl/Cmd+K через нативный аксельратор: в Electron физическое сочетание может не дойти до document-listener рендерера —
// меню-аксельратор гарантированно ловит его и шлёт в renderer открыть командную палитру. Web/standalone — свой keydown.
function openPaletteUI() { showWindow(); if (mainWindow) mainWindow.webContents.send('open-palette'); }

ipcMain.handle('deck:appVersion', () => app.getVersion());
ipcMain.handle('deck:updateInfo', () => ({ version: app.getVersion(), packaged: app.isPackaged }));
ipcMain.handle('deck:checkForUpdates', async () => await checkForUpdates());
// Явная загрузка обновления (кнопка «Обновить»). Фид/подписки уже подняты предшествующим checkForUpdates.
ipcMain.handle('deck:downloadUpdate', async () => {
  if (!app.isPackaged) return { ok: false, reason: 'dev' };
  wireUpdater();
  const token = new CancellationToken();
  downloadCancel = token;
  try { await autoUpdater.downloadUpdate(token); return { ok: true }; }
  catch (e) {
    const reason = String((e && e.message) || e);
    if (token.cancelled || /cancel/i.test(reason)) { sendUpdateStatus('available', { version: lastAvailableVersion }); return { ok: false, cancelled: true }; }   // отмена — не ошибка: вернуть кнопку «Обновить»
    sendUpdateStatus('error', { message: reason }); return { ok: false, reason };
  } finally { if (downloadCancel === token) downloadCancel = null; }
});
// Отмена текущей загрузки (крестик). Токен рвёт скачивание → downloadUpdate реджектится cancellation → статус 'available'.
ipcMain.handle('deck:cancelUpdate', () => {
  if (downloadCancel) { try { downloadCancel.cancel(); } catch {} downloadCancel = null; sendUpdateStatus('available', { version: lastAvailableVersion }); return { ok: true }; }
  return { ok: false };
});
// Нативный выбор папки/файла для полей путей в Настройках (opts.file=true → файл, иначе папка).
// Все ЗАПУЩЕННЫЕ Unity-редакторы из списка процессов (надёжнее pidfile'ов MCP-for-Unity: их пишет не каждый проект).
ipcMain.handle('deck:unity-running', () => {
  if (process.platform !== 'win32') return { instances: [] };   // пока только Windows; иначе — фолбэк на /api/unity/instances
  return new Promise((resolve) => {
    const ps = [
      '$ErrorActionPreference="SilentlyContinue"',
      '$procs=Get-CimInstance Win32_Process -Filter "Name=\'Unity.exe\'"',
      '$seen=@{};$out=@()',
      'foreach($p in $procs){',
      '  $cl="$($p.CommandLine)"; if([string]::IsNullOrEmpty($cl)){continue}',
      '  $proj=""',
      '  $m=[regex]::Match($cl,\'-projectPath\\s+"([^"]+)"\'); if(-not $m.Success){$m=[regex]::Match($cl,\'-projectPath\\s+(\\S+)\')}',
      '  if($m.Success){$proj=$m.Groups[1].Value}',
      '  if($proj -eq ""){$cm=[regex]::Match($cl,\'([A-Za-z]:[\\\\/][^"]*?client-unity-\\d+)\'); if($cm.Success){$proj=$cm.Groups[1].Value}}',
      '  if($proj -eq ""){continue}',
      '  $key=$proj.ToLower().Replace("/","\\")',
      '  $win=(Get-Process -Id $p.ProcessId).MainWindowHandle; $hasWin=($win -ne $null -and $win -ne 0)',
      '  if($seen.ContainsKey($key)){ if($hasWin){$seen[$key].hasWindow=$true}; continue }',
      '  $cu=""; $cm=[regex]::Match($proj,\'client-unity-(\\d+)\'); if($cm.Success){$cu="cu"+$cm.Groups[1].Value}',
      '  $o=[pscustomobject]@{cu=$cu;projectPath=$proj;hasWindow=$hasWin}; $seen[$key]=$o; $out+=$o',
      '}',
      '@($out)|ConvertTo-Json -Compress',
    ].join('\n');
    const ps1 = path.join(app.getPath('userData'), 'deck-unity-running.ps1');
    try { fs.writeFileSync(ps1, ps, 'utf8'); } catch { return resolve({ instances: [] }); }
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], { windowsHide: true, timeout: 9000 }, (_err, stdout) => {
      let arr = [];
      try { const j = JSON.parse(String(stdout || '').trim() || '[]'); arr = Array.isArray(j) ? j : [j]; } catch {}
      resolve({ instances: arr.filter((x) => x && x.projectPath) });
    });
  });
});
ipcMain.handle('deck:pickPath', async (_e, opts) => {
  opts = opts || {};
  try {
    const r = await dialog.showOpenDialog(mainWindow, {
      properties: [opts.file ? 'openFile' : 'openDirectory'],
      title: opts.title || (opts.file ? 'Выберите файл' : 'Выберите папку'),
      defaultPath: opts.current || undefined,
    });
    if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false };
    return { ok: true, path: r.filePaths[0] };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});
// Установить загруженное обновление и перезапуститься — кнопка «Перезапустить и установить» из окна обновлений.
ipcMain.handle('deck:quitAndInstall', () => {
  // (true,true): isSilent — ставим апдейт БЕЗ мастера (assisted-инсталлятор oneClick:false иначе показал бы окно выбора
  // папки на КАЖДОМ обновлении); isForceRunAfter — перезапустить приложение после. Мастер с выбором папки остаётся только
  // при ПЕРВОЙ ручной установке (пользователь сам запускает .exe без /S).
  try { app.isQuitting = true; setImmediate(() => autoUpdater.quitAndInstall(true, true)); return { ok: true }; }
  catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});

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
    // Масштаб: свои пункты вместо ролей zoomIn/zoomOut/resetZoom. registerAccelerator:false — сочетание в меню лишь
    // подписано, а нажатие обрабатывает before-input-event (иначе роль и он сработали бы оба = двойной шаг).
    { label: 'Вид', submenu: [ { label: 'Командная палитра', accelerator: 'CommandOrControl+K', click: openPaletteUI }, { type: 'separator' }, { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' },
      { label: 'Обычный масштаб', accelerator: 'CommandOrControl+0', registerAccelerator: false, click: () => zoomStep(0) },
      { label: 'Увеличить', accelerator: 'CommandOrControl+Plus', registerAccelerator: false, click: () => zoomStep(1) },
      { label: 'Уменьшить', accelerator: 'CommandOrControl+-', registerAccelerator: false, click: () => zoomStep(-1) },
      { type: 'separator' }, { role: 'togglefullscreen' } ] },
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
