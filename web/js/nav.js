// Deck — навигация: переключение видов (setView), командная палитра (Ctrl/⌘+K) и поиск-дропдаун сессий.
// Вынесено из app.js; состояние — в store (S). Топбар-события (вкладки, поиск, фильтры, палитра) — top-level листенеры ниже.
import { S, JIRA_CACHE, MR_CACHE, SESSION_CACHE } from './store.js';
import { esc } from './util.js';
import { searchableText, cardStatus } from './columns.js';
import { renderBoard, isWorking } from './board.js';
import { openSession } from './session.js';
import { stopStream } from './stream.js';
import { pollSessions } from './notify.js';
import { renderSkills } from './skills.js';
import { renderMcp } from './mcp.js';
import { loadUnityInstances } from './unity.js';
import { renderAttention } from './attention.js';
import { renderWorkspace } from './workspace.js';

function palIndex(){
  const idx = [];
  idx.push({type:'Вид', label:'Статусы', sub:'по стадии workflow', act:()=>setView('status')});
  idx.push({type:'Вид', label:'Доска сессий', sub:'по свежести', act:()=>setView('board')});
  idx.push({type:'Вид', label:'Требует внимания', sub:'блокеры · упавшие сборки · проверка · незакоммиченное', act:()=>setView('attention')});
  idx.push({type:'Вид', label:'Скиллы', sub:'каталог', act:()=>setView('skills')});
  idx.push({type:'Вид', label:'MCP-инструменты', sub:'серверы', act:()=>setView('mcp')});
  S.SESSIONS.forEach(s=>idx.push({type:'Сессия', label:s.title, sub:s.project+(s.wo?' · '+s.wo:''), key:(s.title+' '+s.project+' '+(s.gitBranch||'')+' '+(s.lastPrompt||'')).toLowerCase(), act:()=>openSession(s.file)}));
  S.SKILLS.forEach(s=>idx.push({type:'Скилл', label:`/${s.cmd}`, sub:s.does||'', key:(s.cmd+' '+(s.does||'')+' '+(s.trig||'')).toLowerCase(), act:()=>{ setView('skills'); S.skillCat='all'; S.query=''; const q=document.getElementById('q'); if(q) q.value=''; const c=document.getElementById('qClear'); if(c) c.hidden=true; renderSkills(); }}));
  S.MCP_SERVERS.forEach(m=>idx.push({type:'MCP', label:m.name, sub:(m.scope||'')+(m.transport?' · '+m.transport:''), key:(m.name+' '+(m.desc||'')+' '+(m.command||'')).toLowerCase(), act:()=>setView('mcp')}));
  return idx;
}
const palShown = () => Math.min(S.palItems.length, 40);
export function openPal(){ document.getElementById('palBack').classList.add('open'); const i=document.getElementById('palInput'); i.value=''; renderPal(''); setTimeout(()=>i.focus(),40); }
function closePal(){ document.getElementById('palBack').classList.remove('open'); }
export function renderPal(q){
  const all = palIndex(); q = q.trim().toLowerCase();
  S.palItems = q ? all.filter(x=>(x.key||x.label.toLowerCase()).includes(q)) : all;
  S.palSel = 0;
  const list = document.getElementById('palList');
  list.innerHTML = S.palItems.length ? S.palItems.slice(0,40).map((x,i)=>`<div class="pal-item ${i===0?'sel':''}" data-i="${i}"><span class="pal-type">${x.type}</span><span class="pal-label">${esc(x.label)}</span><span class="pal-sub">${esc(x.sub||'')}</span></div>`).join('') : `<div class="pal-empty">Ничего не найдено</div>`;
  list.querySelectorAll('.pal-item').forEach(el=>{ el.addEventListener('click',()=>runPal(+el.dataset.i)); el.addEventListener('mousemove',()=>setSel(+el.dataset.i)); });
}
function setSel(i){ S.palSel=i; document.querySelectorAll('.pal-item').forEach((el,j)=>el.classList.toggle('sel',j===i)); const s=document.querySelector('.pal-item.sel'); if(s) s.scrollIntoView({block:'nearest'}); }
function runPal(i){ const it=S.palItems[i]; if(!it) return; closePal(); it.act(); }

// Справочники и каталоги (Скиллы/MCP) — НАКЛАДНЫЕ вкладки: открываются поверх того, где ты был, и не закрывают
// контекст. Раньше любой переход убивал открытую сессию (стрим рвался, лента стиралась) — заглянуть в MCP было нельзя.
// Именно function, а не const-множество: setView вызывается и из модуля, который грузится РАНЬШЕ тела nav.js
// (циклический импорт через app.load) — объявление функции поднимается, const в этот момент ещё в TDZ.
function isOverlayView(v){ return v === 'skills' || v === 'mcp'; }

export function setView(v){
  const keepSession = isOverlayView(v) && !!S.currentFile;   // сессия остаётся открытой «под» справочником: DOM цел, стрим жив, обратно — одним кликом
  const leavingSession = !!S.currentFile && !keepSession;   // уходим из открытой сессии → доску надо освежить сразу, не ждать поллинг
  if (!keepSession){ stopStream(); S.currentFile = null; }   // уходя из сессии — закрыть живой стрим
  S.activeView = v;
  const boardish = (v==='board' || v==='status');
  document.getElementById('viewBoard').style.display = boardish ? 'flex' : 'none';
  document.getElementById('viewSkills').style.display = v==='skills' ? 'flex' : 'none';
  document.getElementById('viewMcp').style.display = v==='mcp' ? 'flex' : 'none';
  document.getElementById('viewAttention').style.display = v==='attention' ? 'block' : 'none';
  const vw = document.getElementById('viewWorkspace'); if (vw) vw.style.display = v==='workspace' ? 'flex' : 'none';
  document.getElementById('viewSession').style.display = 'none';
  document.getElementById('q').placeholder = 'Поиск…';   // фильтр — на доске; поиск — единый
  document.querySelectorAll('.tab').forEach(t => t.setAttribute('aria-selected', String(t.dataset.v===v)));
  if (v==='skills') renderSkills(); else if (v==='mcp'){ renderMcp(); loadUnityInstances(); } else if (v==='attention') renderAttention(); else if (v==='workspace') renderWorkspace(); else renderBoard(true);
  renderCtxTabs();
  if (boardish && leavingSession) pollSessions(true);   // форс-рефреш: свежий список сессий + live MR/Jira сразу после выхода из контекста (не ждём 7с-поллинг)
}

// Возврат в уже открытый контекст без перезагрузки: только показываем его вид обратно. Перерисовка (openSession) здесь
// была бы вредна — она стёрла бы живую ленту и порвала стрим, ради которого сессию и держали открытой.
export function backToSession(){
  if (!S.currentFile) return;
  S.activeView = 'session';
  document.getElementById('viewBoard').style.display = 'none';
  document.getElementById('viewSkills').style.display = 'none';
  document.getElementById('viewMcp').style.display = 'none';
  document.getElementById('viewAttention').style.display = 'none';
  document.getElementById('viewSession').style.display = 'flex';
  document.querySelectorAll('.tab').forEach(t => t.setAttribute('aria-selected','false'));
  renderCtxTabs();
}

// Полоса открытых контекстов: одновременно открытых сессий может быть несколько, переключение между ними — один клик,
// а не «выйти на доску и найти карточку заново». Здесь же кнопка возврата из накладной вкладки туда, откуда её открыли.
// Открытые вкладки переживают перезагрузку окна (F5 / рестарт Deck): список файлов лежит в localStorage, восстановление —
// restoreOpenFiles() в app.load после загрузки списка сессий. Иначе после релоада полоса вкладок исчезала.
const OPEN_KEY = 'deckOpenFiles';
function persistOpenFiles(){ try { localStorage.setItem(OPEN_KEY, JSON.stringify(S.openFiles)); } catch {} }
export function restoreOpenFiles(){
  let arr = []; try { arr = JSON.parse(localStorage.getItem(OPEN_KEY) || '[]'); } catch {}
  if (Array.isArray(arr)) S.openFiles = arr.filter(f => typeof f === 'string' && S.SESSIONS.some(s => s.file === f));   // только ещё существующие сессии
  renderCtxTabs();
}

export function renderCtxTabs(){
  const bar = document.getElementById('ctxTabs'); if (!bar) return;
  S.openFiles = S.openFiles.filter(f => f === S.currentFile || S.SESSIONS.some(s => s.file === f) || SESSION_CACHE[f]);
  persistOpenFiles();
  const overlay = isOverlayView(S.activeView);
  if (!S.openFiles.length && !overlay){ bar.hidden = true; bar.innerHTML = ''; return; }
  const back = overlay
    ? `<button class="ct-back" type="button" data-back="1">← ${S.currentFile ? 'в контекст' : 'на доску'}</button>`
    : '';
  const tabs = S.openFiles.map(f => {
    const s = S.SESSIONS.find(x => x.file === f) || SESSION_CACHE[f] || {};
    const cur = f === S.currentFile;
    const dot = isWorking(s) ? '<span class="ct-dot"></span>' : '';
    const wait = s.awaitingInput ? '<span class="ct-wait" title="ждёт вашего ответа">✋</span>' : '';
    const title = s.title || 'сессия';
    return `<span class="ct-tab${cur ? ' on' : ''}${cur && overlay ? ' dim' : ''}" data-file="${esc(f)}" title="${esc(title)}">${dot}${wait}<span class="ct-title">${esc(title)}</span><button class="ct-x" type="button" data-close="${esc(f)}" title="Закрыть контекст">✕</button></span>`;
  }).join('');
  bar.hidden = false;
  bar.innerHTML = back + tabs;
  const bb = bar.querySelector('.ct-back');
  if (bb) bb.addEventListener('click', () => { if (S.currentFile) backToSession(); else setView(S.returnView === 'board' ? 'board' : 'status'); });
  bar.querySelectorAll('.ct-x').forEach(x => x.addEventListener('click', (e) => {
    e.stopPropagation();
    const f = x.dataset.close;
    S.openFiles = S.openFiles.filter(v => v !== f);
    if (S.currentFile === f) setView(S.returnView === 'board' ? 'board' : 'status'); else renderCtxTabs();
  }));
  bar.querySelectorAll('.ct-tab').forEach(el => el.addEventListener('click', () => {
    const f = el.dataset.file;
    if (f === S.currentFile){ if (S.activeView !== 'session') backToSession(); return; }
    openSession(f);
  }));
}

export function applySearchQuery(){                    // единый ре-рендер под текущий query (после ввода/очистки)
  renderSearchDrop();                          // дропдаун сессий — во всех видах, включая открытую сессию
  if (S.activeView==='skills') renderSkills(); else if (S.activeView==='mcp') renderMcp(); else if (S.activeView==='board'||S.activeView==='status') renderBoard();
}

export function ensureStatusTab(){
  if (document.querySelector('.tab[data-v="status"]')) return;
  const boardTab = document.querySelector('.tab[data-v="board"]');
  if (!boardTab) return;
  const b = document.createElement('button');
  b.className = 'tab'; b.dataset.v = 'status'; b.setAttribute('aria-selected','true');
  b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/></svg>Статусы';
  boardTab.before(b);
  boardTab.setAttribute('aria-selected','false');
}

function closeSearchDrop(){ const d = document.getElementById('qDrop'); if (d){ d.hidden = true; d.innerHTML = ''; } }
export function renderSearchDrop(){
  const drop = document.getElementById('qDrop'), inp = document.getElementById('q'); if (!drop || !inp) return;
  const q = inp.value.trim().toLowerCase();
  if (!q){ closeSearchDrop(); return; }
  const items = S.SESSIONS.filter(s => searchableText(s, JIRA_CACHE, MR_CACHE, isWorking(s)).includes(q)).slice(0, 12);
  drop.hidden = false;
  if (!items.length){ drop.innerHTML = `<div class="qd-empty">Ничего не найдено</div>`; return; }
  drop.innerHTML = items.map(s => {
    const st = cardStatus(s, JIRA_CACHE);
    return `<div class="qd-item" data-file="${esc(s.file)}"><div class="qd-main"><span class="qd-title">${esc(s.title||s.project||'—')}</span><span class="qd-sub">${esc(s.project||'')}${s.wo?' · '+esc(s.wo):''}</span></div><span class="qd-badge cs-${esc(st.col)}">${esc(st.blocked?'Заблок.':st.text)}</span></div>`;
  }).join('');
  drop.querySelectorAll('.qd-item').forEach(el => el.addEventListener('mousedown', e => {
    e.preventDefault();                          // до blur, чтобы клик сработал
    const f = el.dataset.file; closeSearchDrop();
    inp.value = ''; S.query = ''; const c = document.getElementById('qClear'); if (c) c.hidden = true;
    openSession(f);
  }));
}

setInterval(() => { if (S.activeView === 'mcp' && !S.mcpDetail) loadUnityInstances(); }, 15000);   // live-цикл авто-дискавери Unity-инстансов
document.getElementById('tabs').addEventListener('click', e => { const b = e.target.closest('.tab'); if (b) setView(b.dataset.v); });
document.getElementById('q').addEventListener('input', e => {
  S.query = e.target.value.trim().toLowerCase();
  document.getElementById('qClear').hidden = !e.target.value;   // крестик — только когда в поле есть текст
  applySearchQuery();
});
document.getElementById('qClear').addEventListener('click', () => {
  const inp = document.getElementById('q'); inp.value = ''; S.query = '';
  document.getElementById('qClear').hidden = true;
  closeSearchDrop(); applySearchQuery(); inp.focus();
});
document.getElementById('q').addEventListener('keydown', e => { if (e.key==='Escape'){ closeSearchDrop(); e.target.blur(); } });
document.addEventListener('mousedown', e => { if (!e.target.closest('.search')) closeSearchDrop(); });   // клик-вне закрывает
document.getElementById('filters').addEventListener('click', e => {
  const b = e.target.closest('.fchip'); if (!b) return;
  S.projFilter = b.dataset.f;
  document.querySelectorAll('.fchip').forEach(x => x.setAttribute('aria-pressed', String(x===b)));
  renderBoard();
});
document.getElementById('palTrigger').addEventListener('click', openPal);
document.getElementById('palInput').addEventListener('input', e => renderPal(e.target.value));
document.getElementById('palBack').addEventListener('click', e => { if (e.target.id==='palBack') closePal(); });
document.addEventListener('keydown', e => {
  if ((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='k') { e.preventDefault(); openPal(); return; }
  const palOpen = document.getElementById('palBack').classList.contains('open');
  if (palOpen) {
    if (e.key==='Escape') closePal();
    else if (e.key==='ArrowDown') { e.preventDefault(); setSel(Math.min(S.palSel+1, palShown()-1)); }
    else if (e.key==='ArrowUp') { e.preventDefault(); setSel(Math.max(S.palSel-1, 0)); }
    else if (e.key==='Enter') { e.preventDefault(); runPal(S.palSel); }
    return;
  }
  if (e.key!=='Escape') return;
  if (isOverlayView(S.activeView) && S.currentFile) backToSession();   // справочник поверх контекста — Esc возвращает в контекст, а не выкидывает на доску
  else if (S.currentFile) setView(S.returnView);
});
