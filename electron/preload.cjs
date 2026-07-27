// Минимальный безопасный мост (contextIsolation on). Deck-UI по-прежнему ходит в свой localhost-сервер;
// сюда вынесено только то, что требует нативных прав — открыть OAuth-URL логина в системном браузере
// и показать нативное уведомление через main (надёжно даже когда окно свёрнуто в трей).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('deckNative', {
  isElectron: true,
  openExternal: (url) => ipcRenderer.invoke('deck:openExternal', url),
  notify: (opts) => ipcRenderer.invoke('deck:notify', opts),
  // main шлёт 'open-session' по клику на уведомление → renderer открывает нужную сессию.
  onOpenSession: (cb) => ipcRenderer.on('open-session', (_e, file) => { try { cb(file); } catch {} }),
  // D3: версия + автообновление из приватного GitHub по личному токену.
  appVersion: () => ipcRenderer.invoke('deck:appVersion'),
  updateInfo: () => ipcRenderer.invoke('deck:updateInfo'),
  setUpdateToken: (pat) => ipcRenderer.invoke('deck:setUpdateToken', pat),
  checkForUpdates: () => ipcRenderer.invoke('deck:checkForUpdates'),
  onOpenUpdates: (cb) => ipcRenderer.on('open-updates', () => { try { cb(); } catch {} }),
  onOpenPalette: (cb) => ipcRenderer.on('open-palette', () => { try { cb(); } catch {} }),
  onUpdateStatus: (cb) => ipcRenderer.on('update-status', (_e, s) => { try { cb(s); } catch {} }),
});
