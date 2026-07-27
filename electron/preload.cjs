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
});
