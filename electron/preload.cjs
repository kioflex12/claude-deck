// Минимальный безопасный мост (contextIsolation on). Deck-UI по-прежнему ходит в свой localhost-сервер;
// сюда вынесено только то, что требует нативных прав — открыть OAuth-URL логина в системном браузере
// и показать нативное уведомление через main (надёжно даже когда окно свёрнуто в трей).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('deckNative', {
  isElectron: true,
  openExternal: (url) => ipcRenderer.invoke('deck:openExternal', url),
  openUnity: (opts) => ipcRenderer.invoke('deck:open-unity', opts),   // запуск Unity инстанса по cu-тегу
  notify: (opts) => ipcRenderer.invoke('deck:notify', opts),
  // main шлёт 'open-session' по клику на уведомление → renderer открывает нужную сессию.
  onOpenSession: (cb) => ipcRenderer.on('open-session', (_e, file) => { try { cb(file); } catch {} }),
  // Автообновление из публичного GitHub Releases (без токена).
  appVersion: () => ipcRenderer.invoke('deck:appVersion'),
  updateInfo: () => ipcRenderer.invoke('deck:updateInfo'),
  checkForUpdates: () => ipcRenderer.invoke('deck:checkForUpdates'),
  quitAndInstall: () => ipcRenderer.invoke('deck:quitAndInstall'),   // установить загруженное обновление + перезапуск

  onOpenUpdates: (cb) => ipcRenderer.on('open-updates', () => { try { cb(); } catch {} }),
  onOpenPalette: (cb) => ipcRenderer.on('open-palette', () => { try { cb(); } catch {} }),
  onUpdateStatus: (cb) => ipcRenderer.on('update-status', (_e, s) => { try { cb(s); } catch {} }),
});
