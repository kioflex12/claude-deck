// Минимальный безопасный мост (contextIsolation on). Deck-UI по-прежнему ходит в свой localhost-сервер;
// сюда вынесено только то, что требует нативных прав — открыть OAuth-URL логина в системном браузере.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('deckNative', {
  isElectron: true,
  openExternal: (url) => ipcRenderer.invoke('deck:openExternal', url),
});
