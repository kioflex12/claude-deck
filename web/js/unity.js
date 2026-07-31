// Deck — Unity-кластер: запуск/фокус редактора через Electron-мост + авто-обнаружение запущенных инстансов.
// Вынесено из app.js; состояние — в store (S). loadUnityInstances перерисовывает секцию MCP (renderMcp из mcp.js);
// цикл unity↔mcp безопасен (вызовы в рантайме).
import { S } from './store.js';
import { toast } from './ui.js';
import { renderMcp } from './mcp.js';

export async function launchUnity(cu, cwd){
  if (!(window.deckNative && window.deckNative.openUnity)){ toast('Запуск Unity доступен только в приложении'); return; }
  toast('Unity ' + cu + '…');
  try {
    const r = await window.deckNative.openUnity({ cu, cwd });
    if (r && r.ok) toast(r.focused ? ('Unity ' + cu + ' — окно на передний план') : ('Unity ' + cu + ' запускается' + (r.launched ? ' · ' + r.launched : '')));
    else toast('Unity не запущен: ' + ((r && r.error) || 'неизвестная ошибка'));
  } catch (e) { toast('Ошибка запуска Unity: ' + ((e && e.message) || e)); }
}
export async function loadUnityInstances(){
  // Источник истины — реальные процессы (Electron): показывает ВСЕ запущенные редакторы, не только те, где есть
  // pidfile MCP-for-Unity. Порт бриджа (если есть) добираем из /api/unity/instances по совпадению пути/cu.
  let procList = null;
  if (window.deckNative && window.deckNative.unityRunning){
    try { const r = await window.deckNative.unityRunning(); if (r && Array.isArray(r.instances)) procList = r.instances; } catch {}
  }
  let apiList = [];
  try { const d = await (await fetch('/api/unity/instances', { cache:'no-store' })).json(); apiList = Array.isArray(d.instances) ? d.instances : []; } catch {}
  if (procList){
    const portOf = (u) => { const m = apiList.find(a => (a.projectPath && u.projectPath && a.projectPath.toLowerCase() === u.projectPath.toLowerCase()) || (a.cu && u.cu && a.cu === u.cu)); return m ? m.port : null; };
    S.unityInstances = procList.map(u => ({ cu: u.cu || '', projectPath: u.projectPath || '', port: portOf(u), status: 'up' }));
  } else {
    S.unityInstances = apiList;
  }
  if (S.activeView === 'mcp' && !S.mcpDetail) renderMcp();   // появились/исчезли → перерисовать секцию
}
