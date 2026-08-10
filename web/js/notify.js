// Deck — «работает сейчас», уведомления о завершении хода Claude и живой поллинг доски (лёгкий тик 7с + тяжёлый re-fetch 30с).
// Вынесено из app.js; состояние — в store (S).
import { S, notifiedDone, notifiedInput, JIRA_CACHE } from './store.js';
import { isWorking, renderNow, renderBoard } from './board.js';
import { openSession } from './session.js';
import { setStreamStatus } from './stream.js';
import { renderCtxTabs } from './nav.js';
import { hydrateMrs, hydrateJira } from './services.js';
import { renderUsageBar } from './usage.js';
import { updateAttentionBadge, renderAttention } from './attention.js';

export function workingSet(){ const set = new Set(); for (const s of S.SESSIONS) if (isWorking(s)) set.add(s.file); return set; }
export function titleOf(file){ const s = S.SESSIONS.find(x=>x.file===file); return s ? s.title : ''; }
export function paintNotifyBtn(){
  const btn = document.getElementById('notifyBtn'); if (!btn) return;
  btn.textContent = S.notifyEnabled ? '🔔' : '🔕';
  btn.title = S.notifyEnabled ? 'Уведомления о завершении включены' : 'Уведомления о завершении выключены';
  btn.setAttribute('aria-pressed', String(S.notifyEnabled));
}
export function initNotifyToggle(){
  const btn = document.getElementById('notifyBtn'); if (!btn) return;
  const supported = 'Notification' in window;
  const nativeNotify = !!(window.deckNative && window.deckNative.notify);   // Electron: уведомления через main, разрешение браузера не нужно
  S.notifyEnabled = (nativeNotify || (supported && Notification.permission === 'granted')) && localStorage.getItem('deckNotify') !== 'off';
  paintNotifyBtn();
  btn.addEventListener('click', async () => {
    if (!supported){ setStreamStatus('Браузер не поддерживает уведомления', 1800); return; }
    if (!S.notifyEnabled){
      let perm = Notification.permission;
      if (perm !== 'granted') perm = await Notification.requestPermission();
      S.notifyEnabled = perm === 'granted';
      localStorage.setItem('deckNotify', S.notifyEnabled ? 'on' : 'off');
      if (!S.notifyEnabled) setStreamStatus('Разрешение на уведомления не выдано', 1800);
    } else {
      S.notifyEnabled = false; localStorage.setItem('deckNotify', 'off');
    }
    paintNotifyBtn();
  });
}
export async function ensureNotifyPermission(){        // тихий запрос при первой отправке из композера
  if (!('Notification' in window) || Notification.permission !== 'default') return;
  const perm = await Notification.requestPermission();
  if (perm === 'granted' && localStorage.getItem('deckNotify') !== 'off') S.notifyEnabled = true;
  paintNotifyBtn();
}
function postParent(m){ try { if (window.parent && window.parent !== window) window.parent.postMessage(m, location.origin); } catch {} }
export function notifyDone(file, title, heading){       // одно уведомление на рабочий эпизод (дедуп по sessionId)
  // Сессия работает в iframe-пане (notifyEnabled там выкл, чтобы не дублировать) — форвардим событие в ВЕРХНЕЕ окно,
  // оно и шлёт нативное уведомление (и когда Deck свёрнут/в фоне). Дедуп/подавление применяет уже родитель.
  if (S.paneMode){ postParent({ type:'deck-notify-done', file, title, heading }); return; }
  if (notifiedDone.has(file)) return;            // и Deck-finish, и poll-переход — одно и то же завершение
  notifiedDone.add(file);
  if (!S.notifyEnabled) return;                    // уважаем выключатель уведомлений в приложении
  // Подавляем ТОЛЬКО когда Deck прямо сейчас активен (окно в фокусе И видимо) — тогда пользователь всё видит сам.
  // Свёрнут/в фоне/на другом приложении → уведомляем ВСЕГДА (это и есть просьба «присылай, когда работа завершена»).
  const focused = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
  if (focused && !document.hidden) return;
  const head = (heading || 'Claude завершил') + (title ? ' · ' + title : '');
  if (window.deckNative && window.deckNative.notify){   // Electron: через main — сработает и из свёрнутого в трей окна, клик сфокусит + откроет сессию
    window.deckNative.notify({ title: head, body: 'Открыть сессию в Deck', file });
    return;
  }
  if (!('Notification' in window) || Notification.permission !== 'granted') return;   // standalone-браузер: web-fallback
  try {
    const n = new Notification(head, { body: 'Открыть сессию в Deck', tag: 'deck-'+file });
    n.onclick = () => { window.focus(); openSession(file); n.close(); };
  } catch {}
}
// Уведомление «требуется ответ» (вопрос/аппрув повис). Дедуп по id вопроса; помечаем ТОЛЬКО когда реально шлём —
// если сейчас выключено/юзер смотрит, id не помечаем, чтобы уведомить позже, когда он отойдёт.
export function notifyInput(file, id, title){
  if (S.paneMode){ postParent({ type:'deck-notify-input', file, id, title }); return; }   // из пани — в верхнее окно (см. notifyDone)
  if (!id || notifiedInput.has(id)) return;
  if (!S.notifyEnabled) return;
  const focused = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
  if (focused && !document.hidden) return;   // Deck активен на переднем плане — карточку вопроса видно; иначе уведомляем (в т.ч. в фоне)
  notifiedInput.add(id);
  const head = 'Требуется ответ' + (title ? ' · ' + title : '');
  if (window.deckNative && window.deckNative.notify){ window.deckNative.notify({ title: head, body: 'Claude ждёт вашего ответа', file }); return; }
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try { const n = new Notification(head, { body: 'Claude ждёт вашего ответа', tag: 'deck-input-'+file }); n.onclick = () => { window.focus(); openSession(file); n.close(); }; } catch {}
}

// Сидим JIRA_CACHE из серверного payload сессий — чтобы effectiveColumn был верен уже на ПЕРВОМ рендере (без прыжков).
export function seedJiraFromSessions(){
  const now = Date.now();
  for (const s of S.SESSIONS){ if (s.wo && s.jira && s.jira.available && s.jira.status) JIRA_CACHE[s.wo] = { ts: now, available:true, status:s.jira.status, category:s.jira.category }; }
}

// Один таймер. Лёгкий тик перерисовывает доску (пульс «работает», timeAgo) СОХРАНЯЯ скролл/фильтр/поиск.
// Тяжёлый тик (раз в ~30с) перечитывает /api/sessions + гидрирует MR/Jira, чтобы влитый MR сам стал «влит».
// Открытая session-view (лента/композер/стрим) НЕ трогается — рендерим только на доске «Статусы»/«Доска».
export async function pollSessions(force){
  if (S.polling) return; S.polling = true;
  // ВЕСЬ цикл под try/finally: любое исключение в рендере (борд/вкладки/usage) обязано сбросить S.polling — иначе флаг
  // застревает true, все следующие опросы early-return'ят, и фоновые завершения перестают детектиться (нет уведомлений).
  try {
    const onBoard = (S.activeView === 'board' || S.activeView === 'status');
    const heavy = force || (Date.now() - S._lastHeavy >= 29000);   // force — немедленный рефреш (выход из сессии): обойти 29с-гейт
    if (heavy){
      S._lastHeavy = Date.now();
      let data; try { data = await (await fetch('/api/sessions', { cache:'no-store' })).json(); } catch { return; }   // сеть моргнула — пропускаем цикл (finally снимет polling)
      if (Array.isArray(data.sessions)) S.SESSIONS = data.sessions;   // обновляем данные НА МЕСТЕ, приложение не пересоздаём
      seedJiraFromSessions();
      const nowSet = workingSet();
      // Уведомляем только при ПОДТВЕРЖДЁННОМ завершении: сессия должна простаивать два опроса подряд (иначе долгий
      // tool-call, который не пишет .jsonl >20с, ложно выглядит «готово»). isWorking учитывает и фоновых сабагентов,
      // так что «ничего не работает» = ни генерации, ни bgRunning. Форграунд-финиш (finish()) шлёт сразу — там конец точный.
      for (const file of nowSet){ notifiedDone.delete(file); S.pendingDone.delete(file); }   // снова «работает» → сброс дедупа и кандидата
      for (const file of [...S.pendingDone]){                                                 // простаивал прошлый опрос и всё ещё простаивает → подтверждено
        if (S.SESSIONS.some(s=>s.file===file)) notifyDone(file, titleOf(file));
        S.pendingDone.delete(file);
      }
      for (const file of S.prevWorkingFiles){ if (!nowSet.has(file)) S.pendingDone.add(file); }  // только что ушёл в простой → кандидат, проверим на следующем опросе
      S.prevWorkingFiles = nowSet;
      if (onBoard){ renderNow(); renderBoard(false); hydrateMrs(!!force); hydrateJira(!!force); }   // renderBoard(false) сохраняет colScroll; force → гидрация мимо кэшей
      renderCtxTabs();                              // вкладки открытых контекстов: имя/работает/ждёт ответа — из свежих SESSIONS
    } else if (onBoard){ renderNow(); renderBoard(false); }
    renderUsageBar();
    updateAttentionBadge();                                  // счётчик «Требует внимания» — из свежих SESSIONS (блокеры/упавшие сборки/проверка)
    if (S.activeView === 'attention') renderAttention();
  } finally { S.polling = false; }
}
export function startPolling(){ if (S.pollTimer) clearInterval(S.pollTimer); S.pollTimer = setInterval(pollSessions, 7000); }
