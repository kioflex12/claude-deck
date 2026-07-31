import { esc, escHtml, ctxColor, pctOf, kTok, timeAgo, mdInline, mdToHtml, fmtTok } from './util.js';
import { WF_COLUMNS, WF_LABEL, effectiveColumn, cardStatus, searchableText } from './columns.js';
import { S, SESSION_CACHE, MR_CACHE, JIRA_CACHE, notifiedDone, promptQueue, attachDraft, SKILLS_CACHE, COLUMNS, MODE_ORDER, MODE_LABEL, LIVE_TTL, ATTACH_MAX_BYTES } from './store.js';
import { toast, openExternal, openWoJira, openLocalResource, openFileViewer } from './ui.js';
import { renderMcp, loadMcpCatalog } from './mcp.js';
import { renderSkills, loadSkillsCatalog } from './skills.js';
import { launchUnity, loadUnityInstances } from './unity.js';
import { loadUsage, renderUsageBar, openUsageModal } from './usage.js';
import { renderBoard, renderNow, renderFilters, isWorking } from './board.js';
import { loadBuilds, loadMrs, loadJira, hydrateMrs, hydrateJira, MR_TTL_RESET, wireTags, startAgentsPoll, stopAgentsPoll, agentBoxHTML, runningAgents } from './services.js';
import { openSession, stopStream, setStreamStatus, wireConsole, renderComposer, paintMode, loadSkills, runPrompt } from './session.js';
S.sessionModel = localStorage.getItem('deckModel') || '';
S.sessionEffort = localStorage.getItem('deckEffort') || '';

/* Deck — реальные сессии Claude Code. Данные: /api/sessions (список) + /api/session (транскрипт блоками) + /api/skills (скиллы по cwd). */
const UI_BUILD = '0.1.28';   // версия ИМЕННО статики (index.html/app.js). Показывается в «Обновлениях»; расхождение с версией asar = жива старая статика (побитое обновление)
const activeProjectPath = () => { const p = S.PROJECTS.find(x => x.id === S.ACTIVE_PROJECT); return p ? p.path : ''; };
export const jiraUrl = (wo) => S.JIRA_HOST_CFG ? ("https://" + S.JIRA_HOST_CFG + "/browse/" + wo) : "";
const GL = "https://gitlab.wo/";
const TC = "https://teamcity.wo/viewLog.html?buildId=";
const CONN = "https://claude.ai/settings/connectors";
const EI = '<svg class="ei" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6"><path d="M7 17 17 7M9 7h8v8"/></svg>';
export const aReal = (href, text, cls='') => `<a class="lnk ${cls}" href="${href}" target="_blank" rel="noopener" title="${href}">${text}${EI}</a>`;
const aStub = (href, text, cls='') => `<a class="lnk ${cls}" href="#" onclick="return false" title="${href}">${text}${EI}</a>`;



export async function loadModelsCatalog(){
  try { const d = await (await fetch('/api/models', { cache:'no-store' })).json(); S.MODELS = Array.isArray(d.models)?d.models:[]; S.EFFORTS = Array.isArray(d.efforts)?d.efforts:[]; }
  catch { S.MODELS = []; S.EFFORTS = []; }
}

const mcpExpanded = new Set();   // какие MCP-карточки развёрнуты

const BASE_BRANCHES = new Set(['preprod','preupdate','master','main','develop','dev','prod','release','head','']);
export function isBaseBranch(b){ return BASE_BRANCHES.has(String(b||'').trim().toLowerCase()); }

/* ---------- command palette ---------- */
function palIndex(){
  const idx = [];
  idx.push({type:'Вид', label:'Статусы', sub:'по стадии workflow', act:()=>setView('status')});
  idx.push({type:'Вид', label:'Доска сессий', sub:'по свежести', act:()=>setView('board')});
  idx.push({type:'Вид', label:'Скиллы', sub:'каталог', act:()=>setView('skills')});
  idx.push({type:'Вид', label:'MCP-инструменты', sub:'серверы', act:()=>setView('mcp')});
  S.SESSIONS.forEach(s=>idx.push({type:'Сессия', label:s.title, sub:s.project+(s.wo?' · '+s.wo:''), key:(s.title+' '+s.project+' '+(s.gitBranch||'')+' '+(s.lastPrompt||'')).toLowerCase(), act:()=>openSession(s.file)}));
  S.SKILLS.forEach(s=>idx.push({type:'Скилл', label:`/${s.cmd}`, sub:s.does||'', key:(s.cmd+' '+(s.does||'')+' '+(s.trig||'')).toLowerCase(), act:()=>{ setView('skills'); S.skillCat='all'; S.query=''; const q=document.getElementById('q'); if(q) q.value=''; const c=document.getElementById('qClear'); if(c) c.hidden=true; renderSkills(); }}));
  S.MCP_SERVERS.forEach(m=>idx.push({type:'MCP', label:m.name, sub:(m.scope||'')+(m.transport?' · '+m.transport:''), key:(m.name+' '+(m.desc||'')+' '+(m.command||'')).toLowerCase(), act:()=>setView('mcp')}));
  return idx;
}
const palShown = () => Math.min(S.palItems.length, 40);
function openPal(){ document.getElementById('palBack').classList.add('open'); const i=document.getElementById('palInput'); i.value=''; renderPal(''); setTimeout(()=>i.focus(),40); }
function closePal(){ document.getElementById('palBack').classList.remove('open'); }
function renderPal(q){
  const all = palIndex(); q = q.trim().toLowerCase();
  S.palItems = q ? all.filter(x=>(x.key||x.label.toLowerCase()).includes(q)) : all;
  S.palSel = 0;
  const list = document.getElementById('palList');
  list.innerHTML = S.palItems.length ? S.palItems.slice(0,40).map((x,i)=>`<div class="pal-item ${i===0?'sel':''}" data-i="${i}"><span class="pal-type">${x.type}</span><span class="pal-label">${esc(x.label)}</span><span class="pal-sub">${esc(x.sub||'')}</span></div>`).join('') : `<div class="pal-empty">Ничего не найдено</div>`;
  list.querySelectorAll('.pal-item').forEach(el=>{ el.addEventListener('click',()=>runPal(+el.dataset.i)); el.addEventListener('mousemove',()=>setSel(+el.dataset.i)); });
}
function setSel(i){ S.palSel=i; document.querySelectorAll('.pal-item').forEach((el,j)=>el.classList.toggle('sel',j===i)); const s=document.querySelector('.pal-item.sel'); if(s) s.scrollIntoView({block:'nearest'}); }
function runPal(i){ const it=S.palItems[i]; if(!it) return; closePal(); it.act(); }

/* ---------- view switch + events ---------- */
export function setView(v){
  stopStream();   // уходя из сессии — закрыть живой стрим
  S.activeView = v; S.currentFile = null;
  const boardish = (v==='board' || v==='status');
  document.getElementById('viewBoard').style.display = boardish ? 'flex' : 'none';
  document.getElementById('viewSkills').style.display = v==='skills' ? 'flex' : 'none';
  document.getElementById('viewMcp').style.display = v==='mcp' ? 'flex' : 'none';
  document.getElementById('viewSession').style.display = 'none';
  document.getElementById('q').placeholder = 'Поиск…';   // фильтр — на доске; поиск — единый
  document.querySelectorAll('.tab').forEach(t => t.setAttribute('aria-selected', String(t.dataset.v===v)));
  if (v==='skills') renderSkills(); else if (v==='mcp'){ renderMcp(); loadUnityInstances(); } else renderBoard(true);
}
setInterval(() => { if (S.activeView === 'mcp' && !S.mcpDetail) loadUnityInstances(); }, 15000);   // live-цикл авто-дискавери Unity-инстансов
document.getElementById('tabs').addEventListener('click', e => { const b = e.target.closest('.tab'); if (b) setView(b.dataset.v); });
function applySearchQuery(){                    // единый ре-рендер под текущий query (после ввода/очистки)
  renderSearchDrop();                          // дропдаун сессий — во всех видах, включая открытую сессию
  if (S.activeView==='skills') renderSkills(); else if (S.activeView==='mcp') renderMcp(); else if (S.activeView==='board'||S.activeView==='status') renderBoard();
}
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
document.addEventListener('mousedown', e => { if (!e.target.closest('#projSwitch')){ const m = document.getElementById('projMenu'); if (m) m.hidden = true; } });   // меню проектов — клик-вне закрывает
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
  if (e.key==='Escape' && S.currentFile) setView(S.returnView);
});

/* ---------- инъекция: вкладка «Статусы» (первой) + CSS консоли/markdown/«/» (новые правила, макет не трогаем) ---------- */
function ensureStatusTab(){
  if (document.querySelector('.tab[data-v="status"]')) return;
  const boardTab = document.querySelector('.tab[data-v="board"]');
  if (!boardTab) return;
  const b = document.createElement('button');
  b.className = 'tab'; b.dataset.v = 'status'; b.setAttribute('aria-selected','true');
  b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/></svg>Статусы';
  boardTab.before(b);
  boardTab.setAttribute('aria-selected','false');
}


/* ---------- «работает сейчас» + уведомления о завершении ---------- */
function workingSet(){ const set = new Set(); for (const s of S.SESSIONS) if (isWorking(s)) set.add(s.file); return set; }
export function titleOf(file){ const s = S.SESSIONS.find(x=>x.file===file); return s ? s.title : ''; }
function paintNotifyBtn(){
  const btn = document.getElementById('notifyBtn'); if (!btn) return;
  btn.textContent = S.notifyEnabled ? '🔔' : '🔕';
  btn.title = S.notifyEnabled ? 'Уведомления о завершении включены' : 'Уведомления о завершении выключены';
  btn.setAttribute('aria-pressed', String(S.notifyEnabled));
}
function initNotifyToggle(){
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
export function notifyDone(file, title, heading){       // одно уведомление на рабочий эпизод (дедуп по sessionId)
  if (notifiedDone.has(file)) return;            // и Deck-finish, и poll-переход — одно и то же завершение
  notifiedDone.add(file);
  if (!S.notifyEnabled) return;                    // уважаем выключатель уведомлений в приложении
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

// Сидим JIRA_CACHE из серверного payload сессий — чтобы effectiveColumn был верен уже на ПЕРВОМ рендере (без прыжков).
function seedJiraFromSessions(){
  const now = Date.now();
  for (const s of S.SESSIONS){ if (s.wo && s.jira && s.jira.available && s.jira.status) JIRA_CACHE[s.wo] = { ts: now, available:true, status:s.jira.status, category:s.jira.category }; }
}
/* ---------- живой поллинг доски: лёгкий тик ~7с (рендер) + тяжёлый re-fetch раз в ~30с ---------- */
// Один таймер. Лёгкий тик перерисовывает доску (пульс «работает», timeAgo) СОХРАНЯЯ скролл/фильтр/поиск.
// Тяжёлый тик (раз в ~30с) перечитывает /api/sessions + гидрирует MR/Jira, чтобы влитый MR сам стал «влит».
// Открытая session-view (лента/композер/стрим) НЕ трогается — рендерим только на доске «Статусы»/«Доска».
async function pollSessions(){
  if (S.polling) return; S.polling = true;
  const onBoard = (S.activeView === 'board' || S.activeView === 'status');
  const heavy = Date.now() - S._lastHeavy >= 29000;
  try {
    if (heavy){
      S._lastHeavy = Date.now();
      const r = await fetch('/api/sessions', { cache:'no-store' });
      const data = await r.json();
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
    }
  } catch { S.polling = false; return; }
  if (onBoard){ renderNow(); renderBoard(false); if (heavy){ hydrateMrs(); hydrateJira(); } }   // renderBoard(false) сохраняет colScroll; session-view не трогаем
  renderUsageBar();
  S.polling = false;
}
function startPolling(){ if (S.pollTimer) clearInterval(S.pollTimer); S.pollTimer = setInterval(pollSessions, 7000); }

export function modalBack(id){
  let back = document.getElementById(id);
  if (!back){ back = document.createElement('div'); back.id = id; back.className = 'deck-modal-back'; document.body.appendChild(back);
    back.addEventListener('click', e => { if (e.target === back) back.classList.remove('open'); }); }
  return back;
}

/* ---------- поиск-дропдаун сессий (работает во всех видах) ---------- */
function closeSearchDrop(){ const d = document.getElementById('qDrop'); if (d){ d.hidden = true; d.innerHTML = ''; } }
function renderSearchDrop(){
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

/* ---------- новая сессия ---------- */
export async function openNewSessionDialog(){
  if (!requireAuth()) return;                             // новая сессия требует логина в Claude
  if (!S.MODELS.length) await loadModelsCatalog();          // модели/эффорты для селектов
  const back = modalBack('nsBack');
  const ap = activeProjectPath();                                         // папка активного проекта — приоритетный дефолт
  const cwds = [...new Set([ap, ...S.SESSIONS.map(s=>s.cwd)].filter(Boolean))].sort();
  const preferred = ap || cwds[0] || '';
  const opts = cwds.map(c=>`<option value="${esc(c)}"${c===preferred?' selected':''}>${esc(c)}</option>`).join('');
  const modeOpts = MODE_ORDER.map(m=>`<option value="${m}"${m==='default'?' selected':''}>${MODE_LABEL[m]}</option>`).join('');
  const modelOpts = (S.MODELS.length?S.MODELS:[{value:'',label:'по умолчанию'}]).map(m=>`<option value="${esc(m.value)}"${m.value===S.sessionModel?' selected':''}>${esc(m.label)}</option>`).join('');
  const effOpts = (S.EFFORTS.length?S.EFFORTS:[{value:'',label:'по умолчанию'}]).map(e=>`<option value="${esc(e.value)}"${e.value===S.sessionEffort?' selected':''}>${esc(e.label)}</option>`).join('');
  back.innerHTML = `<div class="deck-modal"><div class="dm-head"><span>Новая сессия</span><button class="dm-x" type="button">✕</button></div>
    <div class="dm-body">
      <label class="ns-lbl">Рабочая папка (cwd)</label>
      <select id="nsCwd" class="ns-inp">${opts || '<option value="">нет известных папок</option>'}</select>
      <label class="ns-lbl">Имя сессии (так будет называться карточка)</label>
      <input id="nsName" class="ns-inp" type="text" placeholder="напр. Рефакторинг чата" autocomplete="off">
      <label class="ns-lbl">Модель</label>
      <select id="nsModel" class="ns-inp">${modelOpts}</select>
      <label class="ns-lbl">Reasoning effort</label>
      <select id="nsEffort" class="ns-inp">${effOpts}</select>
      <label class="ns-lbl">Режим разрешений</label>
      <select id="nsMode" class="ns-inp">${modeOpts}</select>
      <div class="um-note">Сессия откроется пустой — промты пишешь уже в ней. Настройки применятся к первому запросу.</div>
      <div class="ns-actions"><button id="nsStart" class="ns-start" type="button">Создать</button></div>
    </div></div>`;
  back.querySelector('.dm-x').addEventListener('click', ()=>back.classList.remove('open'));
  const submit = ()=>{
    const cwd = back.querySelector('#nsCwd').value;
    const name = back.querySelector('#nsName').value.trim();
    const mode = back.querySelector('#nsMode').value;
    const model = back.querySelector('#nsModel').value;
    const effort = back.querySelector('#nsEffort').value;
    if (!cwd || !name){ back.querySelector('#nsName').focus(); return; }
    back.classList.remove('open');
    openPendingNewSession(cwd, name, mode, model, effort);
  };
  back.querySelector('#nsStart').addEventListener('click', submit);
  back.querySelector('#nsName').addEventListener('keydown', e=>{ if (e.key==='Enter'){ e.preventDefault(); submit(); } });
  back.classList.add('open');
  setTimeout(()=>{ const p = back.querySelector('#nsName'); if (p) p.focus(); }, 60);
}
// Пустая именованная сессия: файла ещё нет — создастся первым промтом; имя закрепится в session-событии.
function openPendingNewSession(cwd, name, mode, model, effort){
  stopStream();
  S.currentFile = null;
  S.pendingNewSession = { cwd, name };
  S.sessionMode = mode || 'default'; S.sessionModel = model || ''; S.sessionEffort = effort || '';
  localStorage.setItem('deckModel', S.sessionModel); localStorage.setItem('deckEffort', S.sessionEffort);
  S.returnView = (S.activeView==='status'||S.activeView==='board') ? S.activeView : 'status';
  document.getElementById('viewBoard').style.display='none';
  document.getElementById('viewSkills').style.display='none';
  document.getElementById('viewMcp').style.display='none';
  document.getElementById('viewSession').style.display='flex';
  document.querySelectorAll('.tab').forEach(x=>x.setAttribute('aria-selected','false'));
  const proj = String(cwd).split(/[\\/]/).filter(Boolean).pop() || '';
  const backBtn = `<button class="back" id="backBtn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M15 18 9 12l6-6"/></svg> Назад</button>`;
  document.getElementById('sessionBar').innerHTML = backBtn + `<span class="sb-wo">${esc(proj)}</span><span class="sb-title">${esc(name)}</span>`;
  document.getElementById('backBtn').addEventListener('click', ()=>setView(S.returnView));
  document.getElementById('sessionSide').innerHTML = `<div class="sec"><div class="rail-hint">Новая сессия «${esc(name)}» — напишите первый промпт, и она создастся.</div></div>`;
  document.getElementById('thread').innerHTML = '<div class="cx-console"><div class="empty">Пустая сессия. Напишите первый промпт ниже.</div></div>';
  wireConsole();
  renderComposer({ cwd, model:'—', ctxPct:0, wo:'', title:name, project: proj });
  paintMode();
  loadSkills(cwd);     // «/»-скиллы для нового cwd
  setTimeout(()=>{ const ta = document.getElementById('composer-ta'); if (ta) ta.focus(); }, 60);
}
// Форк остаётся с промтом (продолжение контекста): создаём и сразу отправляем.
function openNewSession(cwd, prompt, mode, forkFile){
  stopStream();
  S.currentFile = null; S.pendingNewSession = null;
  S.returnView = (S.activeView==='status'||S.activeView==='board') ? S.activeView : 'status';
  document.getElementById('viewBoard').style.display='none';
  document.getElementById('viewSkills').style.display='none';
  document.getElementById('viewMcp').style.display='none';
  document.getElementById('viewSession').style.display='flex';
  document.querySelectorAll('.tab').forEach(x=>x.setAttribute('aria-selected','false'));
  const proj = String(cwd).split(/[\\/]/).filter(Boolean).pop() || '';
  const backBtn = `<button class="back" id="backBtn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M15 18 9 12l6-6"/></svg> Назад</button>`;
  document.getElementById('sessionBar').innerHTML = backBtn + `<span class="sb-wo">${esc(proj)}</span><span class="sb-title">${forkFile?'Форк сессии…':'Новая сессия…'}</span>`;
  document.getElementById('backBtn').addEventListener('click', ()=>setView(S.returnView));
  document.getElementById('sessionSide').innerHTML = '<div class="sec"><div class="rail-hint">Новая сессия создаётся…</div></div>';
  document.getElementById('thread').innerHTML = '<div class="cx-console"></div>';
  wireConsole();
  S.sessionMode = mode;
  renderComposer({ cwd, model:'—', ctxPct:0, wo:'', title:'Новая сессия', project: proj });
  paintMode();
  loadSkills(cwd);
  runPrompt(forkFile ? { text: prompt, mode, attachments: [], forkFile } : { text: prompt, mode, attachments: [], newSessionCwd: cwd });
}
/* ---------- обработчики действий рейла: форк + удаление ---------- */
export function wireSideActions(t){
  const del = document.getElementById('delSessionBtn');
  if (del) del.addEventListener('click', () => openDeleteDialog(t.file, t.title));
  const fork = document.getElementById('forkBtn');
  if (fork) fork.addEventListener('click', () => openForkDialog(t));
}
function openDeleteDialog(file, title){
  const back = modalBack('delBack');
  back.innerHTML = `<div class="deck-modal"><div class="dm-head"><span>Удалить сессию из Deck?</span><button class="dm-x" type="button">✕</button></div>
    <div class="dm-body">
      <div class="dm-text">«${esc(title||file)}»</div>
      <div class="um-note">Файл транскрипта переедет в <code>deck-trash/</code> — восстановимо (не удаляется безвозвратно).</div>
      <div class="ns-actions"><button class="btn-ghost dm-cancel" type="button">Отмена</button><button class="ns-start dm-danger" type="button">Удалить</button></div>
    </div></div>`;
  back.querySelector('.dm-x').addEventListener('click', ()=>back.classList.remove('open'));
  back.querySelector('.dm-cancel').addEventListener('click', ()=>back.classList.remove('open'));
  back.querySelector('.dm-danger').addEventListener('click', async ()=>{
    back.classList.remove('open');
    try {
      const r = await fetch('/api/delete-session', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ file }) });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d && d.error ? d.error : 'delete failed');
      S.SESSIONS = S.SESSIONS.filter(s=>s.file!==file); delete SESSION_CACHE[file];
      if (S.currentFile === file){ stopStream(); setView(S.returnView); } else renderBoard(false);
      toast('Перемещено в корзину (deck-trash)');
    } catch (e){ toast('Не удалось удалить: ' + (e.message||e)); }
  });
  back.classList.add('open');
}
function openForkDialog(t){
  const back = modalBack('forkBack');
  const modeOpts = MODE_ORDER.map(m=>`<option value="${m}"${m===S.sessionMode?' selected':''}>${MODE_LABEL[m]}</option>`).join('');
  back.innerHTML = `<div class="deck-modal"><div class="dm-head"><span>Форк сессии</span><button class="dm-x" type="button">✕</button></div>
    <div class="dm-body">
      <div class="um-note">Новая сессия продолжит контекст «${esc(t.title||t.file)}» (resume + fork). Оригинал не меняется.</div>
      <label class="ns-lbl">Первый промт продолжения</label>
      <textarea id="forkPrompt" class="ns-inp" rows="4" placeholder="Что делать в форке…"></textarea>
      <label class="ns-lbl">Режим разрешений</label>
      <select id="forkMode" class="ns-inp">${modeOpts}</select>
      <div class="ns-actions"><button id="forkStart" class="ns-start" type="button">Создать форк</button></div>
    </div></div>`;
  back.querySelector('.dm-x').addEventListener('click', ()=>back.classList.remove('open'));
  back.querySelector('#forkStart').addEventListener('click', ()=>{
    const prompt = back.querySelector('#forkPrompt').value.trim();
    const mode = back.querySelector('#forkMode').value;
    if (!prompt){ back.querySelector('#forkPrompt').focus(); return; }
    back.classList.remove('open');
    openNewSession(t.cwd, prompt, mode, t.file);   // forkFile = исходная сессия
  });
  back.classList.add('open');
  setTimeout(()=>{ const p = back.querySelector('#forkPrompt'); if (p) p.focus(); }, 60);
}

/* ---------- загрузка реальных сессий ---------- */
async function load(){
  // Мгновенный каркас ДО данных: топбар уже привязан (wireTopbar), сразу показываем борд и кнопки (пустыми) —
  // иначе на холодном старте после апдейта интерфейс «мёртв», пока грузится /api/sessions.
  renderFilters();
  renderNow();
  setView('status');
  try {
    const r = await fetch('/api/sessions', { cache:'no-store' });
    const data = await r.json();
    S.SESSIONS = Array.isArray(data.sessions) ? data.sessions : [];
  } catch (e) { S.SESSIONS = []; }
  seedJiraFromSessions();              // Jira уже в payload → колонки верны на первом рендере
  S.prevWorkingFiles = workingSet();     // базовая линия: на старте «завершения» не шлём
  renderFilters();
  renderNow();
  if (S.activeView === 'status' || S.activeView === 'board') renderBoard(true);   // дорисовать борд с данными (scroll сохраняется)
  startPolling();
  hydrateMrs(true);    // рефреш страницы (F5) → live-MR СРАЗУ, мимо кэшей (не ждать цикл поллинга)
  hydrateJira(true);   // рефреш страницы (F5) → live-статусы Jira СРАЗУ, мимо кэшей
  loadSkillsCatalog(); // TECH-2: реальные скиллы (для вкладки и палитры)
  // Тяжёлые SDK-пробы (spawn claude) — ПОСЛЕ подъёма борда, чтобы не конкурировать за старт и не морозить UI.
  setTimeout(() => {
    loadMcpCatalog();  // реальные MCP-серверы
    loadUsage();
    if (!S.usageTimer) S.usageTimer = setInterval(loadUsage, 30000);   // лимиты обновляем ~раз в 30с (сервер кэширует 45с)
  }, 1500);
}
function wireTopbar(){
  const u = document.getElementById('usageInd'); if (u) u.addEventListener('click', openUsageModal);
  const a = document.getElementById('authChip'); if (a) a.addEventListener('click', onAuthChip);
  const g = document.getElementById('authGateBtn'); if (g) g.addEventListener('click', startLogin);
  const s = document.getElementById('settingsBtn'); if (s) s.addEventListener('click', openSettingsModal);
  const sg = document.getElementById('svcGateBtn'); if (sg) sg.addEventListener('click', openSettingsModal);
  const pb = document.getElementById('projBtn'); if (pb) pb.addEventListener('click', (e) => { e.stopPropagation(); toggleProjMenu(); });
}

/* ---------- Переключатель проектов (workspaces): «Открыть папку» как в VS Code, доску скоупит сервер ---------- */
function renderProjSwitch(){
  const nameEl = document.getElementById('projName'); if (!nameEl) return;
  const active = S.PROJECTS.find((p) => p.id === S.ACTIVE_PROJECT);
  nameEl.textContent = active ? active.name : 'Все проекты';
}
function toggleProjMenu(){
  const menu = document.getElementById('projMenu'); if (!menu) return;
  if (!menu.hidden){ menu.hidden = true; return; }
  const rows = [`<div class="pm-item${S.ACTIVE_PROJECT ? '' : ' active'}" data-id=""><span class="pm-main"><span class="pm-name">Все проекты</span></span></div>`];
  for (const p of S.PROJECTS) rows.push(`<div class="pm-item${p.id === S.ACTIVE_PROJECT ? ' active' : ''}" data-id="${esc(p.id)}"><span class="pm-main"><span class="pm-name">${esc(p.name)}</span><span class="pm-path">${esc(p.path)}</span></span><button class="pm-x" data-rm="${esc(p.id)}" title="Убрать из списка">✕</button></div>`);
  rows.push('<div class="pm-sep"></div><div class="pm-item pm-add" data-add="1"><span class="pm-main"><span class="pm-name">＋ Открыть папку…</span></span></div>');
  menu.innerHTML = rows.join('');
  menu.hidden = false;
  menu.querySelectorAll('.pm-item').forEach((el) => el.addEventListener('click', (e) => {
    if (e.target.closest('.pm-x')) return;
    menu.hidden = true;
    if (el.dataset.add) addProject(); else switchProject(el.dataset.id || '');
  }));
  menu.querySelectorAll('.pm-x').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); removeProject(b.dataset.rm); }));
}
async function switchProject(id){
  if (id === S.ACTIVE_PROJECT) return;
  try { await fetch('/api/projects', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'select', id }) }); } catch {}
  S.ACTIVE_PROJECT = id; MR_TTL_RESET(); renderProjSwitch();
  await load();   // сервер отдаст сессии уже скоупнутые на активный проект
}
async function addProject(){
  if (!(window.deckNative && window.deckNative.pickPath)){ toast('Открытие папки доступно только в приложении'); return; }
  let r; try { r = await window.deckNative.pickPath({ title:'Открыть папку проекта' }); } catch { return; }
  if (!r || !r.ok || !r.path) return;
  let d; try { d = await (await fetch('/api/projects', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'add', path: r.path }) })).json(); } catch { toast('Не удалось добавить папку'); return; }
  S.PROJECTS = d.projects || []; S.ACTIVE_PROJECT = d.activeId || ''; MR_TTL_RESET(); renderProjSwitch(); await load();
}
async function removeProject(id){
  let d; try { d = await (await fetch('/api/projects', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'remove', id }) })).json(); } catch { return; }
  S.PROJECTS = d.projects || []; S.ACTIVE_PROJECT = d.activeId || ''; renderProjSwitch();
  const menu = document.getElementById('projMenu'); if (menu){ menu.hidden = true; toggleProjMenu(); }   // перерисовать открытое меню
  await load();
}

/* ---------- D1: авторизация Claude из приложения ---------- */
// Единый перехват кликов по ссылкам (вывод, рейл, везде): внешние http(s) → системный браузер; локальные/относительные
// (резолвятся в origin Deck) → открыть как файл, а не как страницу Deck. Capture — до дефолтной навигации/target=_blank.
document.addEventListener('click', (e) => {
  const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
  if (!a) return;
  const raw = a.getAttribute('href') || '';
  if (!raw || raw === '#' || raw[0] === '#') return;               // якорь/заглушка — свои обработчики
  if (/^(mailto:|tel:)/i.test(raw)) return;                        // почта/тел — системе
  const abs = a.href || '';
  const external = /^https?:\/\//i.test(raw) && !abs.startsWith(location.origin + '/') && abs !== location.origin;
  e.preventDefault();
  if (external) openExternal(abs);
  else openLocalResource(raw);
}, true);
// Копирование блока кода/преформатированного текста по кнопке справа сверху
document.addEventListener('click', (e) => {
  const b = e.target && e.target.closest ? e.target.closest('.code-copy') : null;
  if (!b) return;
  e.preventDefault(); e.stopPropagation();
  const pre = b.closest('pre'); const code = pre && pre.querySelector('code');
  const text = code ? code.textContent : (pre ? pre.textContent : '');
  const done = () => { b.classList.add('ok'); const o = b.textContent; b.textContent = '✓'; setTimeout(() => { b.classList.remove('ok'); b.textContent = o; }, 1200); };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done).catch(() => toast('Не удалось скопировать'));
  else { try { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); done(); } catch { toast('Не удалось скопировать'); } }
}, true);
async function loadAuth(){
  try { S.AUTH = await (await fetch('/api/auth', { cache:'no-store' })).json(); } catch { S.AUTH = { loggedIn:false, reason:'сеть' }; }
  renderAuth();
}
function renderAuth(){
  const chip = document.getElementById('authChip'), gate = document.getElementById('authGate');
  if (chip){
    chip.classList.toggle('in', !!S.AUTH.loggedIn);
    chip.textContent = S.AUTH.loggedIn ? (S.AUTH.email || 'Claude ✓') : 'Войти в Claude';
    chip.title = S.AUTH.loggedIn ? ('Claude: ' + (S.AUTH.email||'') + (S.AUTH.orgName?(' · '+S.AUTH.orgName):'') + ' — клик для выхода') : 'Войти в Claude';
  }
  if (gate) gate.hidden = !!S.AUTH.loggedIn;
}
/* ---------- Плашка неавторизованных интеграций (Jira/TeamCity/GitLab) — красная, если не авторизован хотя бы один ---------- */
export async function loadServicesGate(){
  try { S.SVC_CFG = await (await fetch('/api/config', { cache:'no-store' })).json(); } catch { S.SVC_CFG = null; }
  renderServicesGate();
}
function renderServicesGate(cfg){
  if (cfg) S.SVC_CFG = cfg;
  if (S.SVC_CFG && S.SVC_CFG.jira) S.JIRA_HOST_CFG = S.SVC_CFG.jira.host || '';   // хост Jira для ссылок берём из конфига
  if (S.SVC_CFG){ S.PROJECTS = Array.isArray(S.SVC_CFG.projects) ? S.SVC_CFG.projects : []; S.ACTIVE_PROJECT = S.SVC_CFG.activeProjectId || ''; renderProjSwitch(); }   // проекты в переключатель
  const gate = document.getElementById('svcGate'), msg = document.getElementById('svcGateMsg');
  if (!gate || !msg) return;
  const c = S.SVC_CFG || {};
  const missing = [];
  if (!(c.jira && c.jira.enabled)) missing.push('Jira');
  if (!(c.teamcity && c.teamcity.tokenSet && c.teamcity.host)) missing.push('TeamCity');
  if (!(c.gitlab && c.gitlab.tokenSet && c.gitlab.host)) missing.push('GitLab');
  if (!missing.length) { gate.hidden = true; return; }
  msg.textContent = 'Не авторизованы сервисы: ' + missing.join(', ') + ' — доска не получит статусы задач, сборки и MR. Подтяните токены или заполните настройки.';
  gate.hidden = false;
}
export function requireAuth(){   // гейт для chat/usage/новой сессии
  if (S.AUTH.loggedIn) return true;
  toast('Войдите в Claude — действие недоступно без авторизации');
  startLogin();
  return false;
}
function onAuthChip(){ if (S.AUTH.loggedIn) confirmLogout(); else startLogin(); }
async function confirmLogout(){
  const back = modalBack('logoutBack');
  back.innerHTML = `<div class="deck-modal"><div class="dm-head"><span>Выйти из Claude?</span><button class="dm-x" type="button">✕</button></div>
    <div class="dm-body"><div class="dm-text">${esc(S.AUTH.email||'')}</div><div class="um-note">После выхода чат/лимиты/новые сессии станут недоступны, пока не войдёте снова.</div>
    <div class="ns-actions"><button class="btn-ghost dm-cancel" type="button">Отмена</button><button class="ns-start dm-danger" type="button">Выйти</button></div></div></div>`;
  back.querySelector('.dm-x').addEventListener('click', ()=>back.classList.remove('open'));
  back.querySelector('.dm-cancel').addEventListener('click', ()=>back.classList.remove('open'));
  back.querySelector('.dm-danger').addEventListener('click', async ()=>{ back.classList.remove('open'); try { await fetch('/api/auth/logout', { method:'POST' }); } catch {} await loadAuth(); toast('Вы вышли из Claude'); });
  back.classList.add('open');
}
async function startLogin(){
  if (S.loginInProgress) return;   // логин уже идёт — не плодим второй процесс/окно браузера
  S.loginInProgress = true;
  const back = modalBack('loginBack');
  back.innerHTML = `<div class="deck-modal"><div class="dm-head"><span>Вход в Claude</span><button class="dm-x" type="button">✕</button></div>
    <div class="dm-body">
      <div class="um-note" id="loginStep">Открываю браузер для входа в Claude…</div>
      <a class="btn-ghost" id="loginOpen" href="#" style="display:none;margin:8px 0">Открыть страницу входа вручную</a>
      <label class="ns-lbl">Код авторизации (со страницы Claude)</label>
      <input id="loginCode" class="ns-inp" type="text" placeholder="вставь код и нажми Подтвердить" autocomplete="off">
      <div class="ns-actions"><button class="btn-ghost dm-cancel" type="button">Отмена</button><button class="ns-start" id="loginSubmit" type="button" disabled>Подтвердить</button></div>
    </div></div>`;
  const close = ()=>{ back.classList.remove('open'); S.loginInProgress = false; if (loginId) fetch('/api/auth/cancel?id='+encodeURIComponent(loginId)).catch(()=>{}); };
  back.querySelector('.dm-x').addEventListener('click', close);
  back.querySelector('.dm-cancel').addEventListener('click', close);
  back.classList.add('open');
  let loginId = null;
  try {
    const d = await (await fetch('/api/auth/login', { method:'POST' })).json();
    loginId = d.loginId;
    if (d.url){
      // Браузер открывает сам Claude CLI — Deck НЕ открывает URL повторно (иначе два окна). Ссылка ниже — ручной фолбэк.
      const link = back.querySelector('#loginOpen'); link.href = d.url; link.style.display = 'inline-flex';
      link.addEventListener('click', (e)=>{ e.preventDefault(); openExternal(d.url); });
      back.querySelector('#loginStep').textContent = 'Браузер открыт — подтверди доступ в Claude и вставь показанный код ниже. Если браузер не открылся — нажми ссылку.';
    } else {
      back.querySelector('#loginStep').textContent = 'Не удалось получить ссылку входа. Проверь, что установлен Claude CLI.';
    }
  } catch { back.querySelector('#loginStep').textContent = 'Ошибка запуска входа.'; }
  // Ловим успех по ЛЮБОМУ пути (в т.ч. когда браузер авторизовал сам, без кода): поллим /api/auth ~каждые 2с.
  const started = Date.now();
  const pollAuth = async () => {
    if (!S.loginInProgress || !back.classList.contains('open')) return;   // модалку закрыли/отменили — стоп
    await loadAuth();                                                    // обновляет S.AUTH + renderAuth: чип зелёный, красная плашка #authGate гаснет
    if (S.AUTH.loggedIn){ back.classList.remove('open'); S.loginInProgress = false; toast('Вход выполнен: ' + (S.AUTH.email || '')); return; }
    if (Date.now() - started > 180000) return;                          // таймаут ~3мин
    setTimeout(pollAuth, 2000);
  };
  if (loginId) setTimeout(pollAuth, 2000);
  const codeInp = back.querySelector('#loginCode'), submit = back.querySelector('#loginSubmit');
  codeInp.addEventListener('input', ()=>{ submit.disabled = !codeInp.value.trim() || !loginId; });
  submit.addEventListener('click', async ()=>{
    submit.disabled = true; submit.textContent = 'Проверяю…';
    try {
      const r = await (await fetch('/api/auth/code', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ loginId, code: codeInp.value.trim() }) })).json();
      if (r.ok){ back.classList.remove('open'); S.loginInProgress = false; await loadAuth(); toast('Вход выполнен: ' + (S.AUTH.email||'')); }
      else { back.querySelector('#loginStep').textContent = 'Код не принят — попробуй ещё раз.'; submit.disabled = false; submit.textContent = 'Подтвердить'; }
    } catch { submit.disabled = false; submit.textContent = 'Подтвердить'; }
  });
}

/* ---------- D3: обновления (только в Electron) — версия + PAT + проверка ---------- */
function renderUpdateStatus(s){
  if (!s) return;
  if (S.UPDATE_DOWNLOAD_EL){
    S.UPDATE_DOWNLOAD_EL.style.display = (s.state === 'available') ? '' : 'none';   // «Обновить» — только когда апдейт найден и загрузка ещё не начата
    if (s.state === 'available'){ S.UPDATE_DOWNLOAD_EL.textContent = '↓ Обновить до ' + (s.version||''); S.UPDATE_DOWNLOAD_EL.disabled = false; }
  }
  if (S.UPDATE_INSTALL_EL) S.UPDATE_INSTALL_EL.style.display = (s.state === 'downloaded') ? '' : 'none';   // «Перезапустить» — только когда загружено
  if (!S.UPDATE_STATUS_EL) return;
  const m = {
    checking:'Проверяю обновления…', 'not-available':'У вас последняя версия.',
    available:'Доступна версия '+(s.version||'')+'. Нажмите «Обновить».',
    downloading:'Загрузка… '+(s.percent||0)+'%',
    downloaded:'Обновление '+(s.version||'')+' загружено — нажмите «Перезапустить и установить».',
    error:'Ошибка обновления: '+(s.message||''), dev:'Обновления доступны только в установленном приложении.',
  };
  S.UPDATE_STATUS_EL.textContent = m[s.state] || s.state || '';
}
async function openUpdatesModal(){
  if (!(window.deckNative && window.deckNative.updateInfo)) return;   // только в Electron
  const info = await window.deckNative.updateInfo();
  const back = modalBack('updatesBack');
  back.innerHTML = `<div class="deck-modal"><div class="dm-head"><span>Обновления</span><button class="dm-x" type="button">✕</button></div>
    <div class="dm-body">
      <div class="dm-text">Текущая версия: <b>${esc(info.version||'?')}</b> · UI build: <b>${esc(UI_BUILD)}</b></div>
      ${String(info.version||'')!==UI_BUILD?'<div class="um-note" style="color:var(--warn)">⚠ Версия приложения и UI не совпали — обновление встало не полностью. Скачайте и запустите установщик заново (полная переустановка).</div>':''}
      <div class="um-note">Нажмите «Проверить» — если появилась новая версия, покажется кнопка «Обновить» (скачает и установит с перезапуском). Пока не нажмёте «Обновить», ничего не качается.</div>
      <div class="ns-actions" style="justify-content:flex-end"><button class="ns-start" id="updCheck" type="button">Проверить</button></div>
      <button class="ns-start" id="updDownload" type="button" style="display:none;width:100%;margin-top:10px">↓ Обновить</button>
      <button class="ns-start" id="updInstall" type="button" style="display:none;width:100%;margin-top:10px">↻ Перезапустить и установить</button>
      <div class="um-note" id="updStatus" style="margin-top:8px"></div>
      ${info.packaged?'':'<div class="um-note">Проверка обновлений работает только в установленном приложении (не в dev-режиме).</div>'}
    </div></div>`;
  back.querySelector('.dm-x').addEventListener('click', ()=>{ back.classList.remove('open'); S.UPDATE_STATUS_EL=null; S.UPDATE_INSTALL_EL=null; S.UPDATE_DOWNLOAD_EL=null; });
  back.classList.add('open');
  S.UPDATE_STATUS_EL = back.querySelector('#updStatus'); S.UPDATE_INSTALL_EL = back.querySelector('#updInstall'); S.UPDATE_DOWNLOAD_EL = back.querySelector('#updDownload');
  async function doUpdCheck(){
    S.UPDATE_STATUS_EL.textContent='Проверяю…';
    const r = await window.deckNative.checkForUpdates();
    if (!r.ok) renderUpdateStatus({ state: r.reason==='dev'?'dev':'error', message: r.reason });
  }
  back.querySelector('#updCheck').addEventListener('click', doUpdCheck);
  S.UPDATE_DOWNLOAD_EL.addEventListener('click', async ()=>{
    S.UPDATE_DOWNLOAD_EL.disabled = true; S.UPDATE_STATUS_EL.textContent='Загрузка…';
    const r = await window.deckNative.downloadUpdate();
    if (r && !r.ok) renderUpdateStatus({ state:'error', message: r.reason });
  });
  S.UPDATE_INSTALL_EL.addEventListener('click', async ()=>{
    S.UPDATE_STATUS_EL.textContent='Перезапуск и установка…';
    try { await window.deckNative.quitAndInstall(); } catch { S.UPDATE_STATUS_EL.textContent='Не удалось установить — попробуйте ещё раз.'; }
  });
  if (info.packaged) doUpdCheck();   // открыли окно → только ПРОВЕРКА (без загрузки); при наличии апдейта покажется кнопка «Обновить»
}

/* ---------- TECH-6: экран настроек (папки + Jira). Токен наружу не отдаётся, только флаг «задан». ---------- */
// Настройки: рендер строки поля. Типы: text (✓ прямо в инпуте), path (инпут + «Обзор…» + ✓/очистка),
// token (задан → «✓ задан» + «удалить» ВМЕСТО инпута; не задан → инпут для вставки). state={value}|{set}.
function nsFieldHtml(f, state, hasNative){
  state = state || {};
  if (f.type==='token' && state.set){
    return `<div class="ns-row" data-fid="${f.id}">
      <label class="ns-lbl">${esc(f.label)}</label>
      <div class="ns-tokset"><span class="tok-ok">✓ задан</span><button class="fld-del" type="button" data-fid="${f.id}">удалить</button></div>
    </div>`;
  }
  const filled = f.type!=='token' && !!String(state.value||'').trim();
  const browse = (f.type==='path' && hasNative) ? `<button class="ns-browse" type="button" data-fid="${f.id}">Обзор…</button>` : '';
  const clr = (f.type==='path' && filled) ? `<button class="ns-clr" type="button" data-fid="${f.id}" title="Очистить">✕</button>` : '';
  const inpType = f.type==='token' ? 'password' : 'text';
  const val = f.type==='token' ? '' : esc(state.value||'');
  const ro = (f.type==='path' && hasNative) ? ' readonly' : '';   // путь выбираем нативно — руками не редактируем
  return `<div class="ns-row" data-fid="${f.id}">
    <label class="ns-lbl" for="${f.id}">${esc(f.label)}</label>
    <div class="ns-fieldrow">
      <div class="ns-inpwrap${filled?' filled':''}"><input id="${f.id}" class="ns-inp" type="${inpType}" placeholder="${esc(f.ph||'')}" value="${val}"${ro} autocomplete="off"><span class="inp-ok">✓</span></div>
      ${browse}${clr}
    </div>
  </div>`;
}
async function openSettingsModal(){
  let cfg = {}; try { cfg = await (await fetch('/api/config', { cache:'no-store' })).json(); } catch {}
  const jira = cfg.jira || {}, tc = cfg.teamcity || {}, gl = cfg.gitlab || {}, unity = cfg.unity || {}, dfl = cfg.defaults || {};
  const tokHint = cfg.electron ? '<div class="um-note">Токены хранятся локально в зашифрованном виде (хранилище ОС). Вставьте значение и нажмите «Сохранить» — заданный токен можно удалить кнопкой рядом.</div>'
    : '<div class="um-note" style="color:#e79">Standalone: токены безопасно сохранить нельзя — задайте их в .env (JIRA_TOKEN / TEAMCITY_TOKEN / GITLAB_TOKEN) рядом с server.mjs. Хосты и Jira email сохранятся.</div>';
  const back = modalBack('settingsBack');
  const HAS_NATIVE = !!(window.deckNative && window.deckNative.pickPath);   // нативный выбор папки/файла есть только в Electron
  const st = {   // состояние полей: text/path → {value}; token → {set}
    setEnv:{value:cfg.secretsEnvPath||''}, setWo:{value:cfg.woStatesDir||''}, setProj:{value:cfg.claudeProjectsDir||''},
    setJh:{value:jira.host||''}, setJe:{value:jira.email||''}, setJt:{set:!!jira.tokenSet},
    setTh:{value:tc.host||''}, setTt:{set:!!tc.tokenSet},
    setGh:{value:gl.host||''}, setGt:{set:!!gl.tokenSet},
    setCup:{value:unity.clientUnityParent||''}, setUed:{value:unity.editorsDir||''}, setUhub:{value:unity.hubPath||''},
  };
  const FIELDS = {
    setEnv:{id:'setEnv',type:'path',pick:'file',label:'Путь к .env с токенами (для «Подтянуть» в установленном приложении)',ph:'напр. D:/claude-deck/.env'},
    setWo:{id:'setWo',type:'path',pick:'dir',label:'Папка состояний dev-workflow (WO_STATES_DIR)',ph:'пусто → колонка «Статусы» деградирует'},
    setProj:{id:'setProj',type:'path',pick:'dir',label:'Папка сессий Claude (CLAUDE_PROJECTS_DIR)',ph:dfl.claudeProjectsDir||'~/.claude/projects'},
    setJh:{id:'setJh',type:'text',label:'Jira host',ph:'your-org.atlassian.net'},
    setJe:{id:'setJe',type:'text',label:'Jira email',ph:'you@example.com'},
    setJt:{id:'setJt',type:'token',svc:'jira',label:'Jira API token',ph:'вставьте API-токен'},
    setTh:{id:'setTh',type:'text',label:'TeamCity host',ph:dfl.teamcityHost||'https://…'},
    setTt:{id:'setTt',type:'token',svc:'teamcity',label:'TeamCity token',ph:'вставьте bearer-токен'},
    setGh:{id:'setGh',type:'text',label:'GitLab host',ph:dfl.gitlabHost||'https://…'},
    setGt:{id:'setGt',type:'token',svc:'gitlab',label:'GitLab token',ph:'вставьте private-токен'},
    setCup:{id:'setCup',type:'path',pick:'dir',label:'Папка client-unity копий (родительская)',ph:'напр. D:/wo'},
    setUed:{id:'setUed',type:'path',pick:'dir',label:'Путь к редакторам Unity / Hub Editor dir (опц.)',ph:'дефолт C:/Program Files/Unity/Hub/Editor'},
    setUhub:{id:'setUhub',type:'path',pick:'file',label:'Путь к Unity Hub (опц., фолбэк)',ph:'дефолт …/Unity Hub.exe'},
  };
  const row = (id)=> nsFieldHtml(FIELDS[id], st[id], HAS_NATIVE);
  back.innerHTML = `<div class="deck-modal"><div class="dm-head"><span>Настройки</span><button class="dm-x" type="button">✕</button></div>
    <div class="dm-body">
      <div class="ns-summary" id="setSummary"></div>
      <div class="ns-actions" style="justify-content:flex-start;margin:2px 0 4px"><button class="btn-ghost" id="setImport" type="button" title="Автоимпорт из .env / ~/.claude.json / MCP-конфигов">⤵ Подтянуть токены</button></div>
      <div class="um-note" id="setImportRes" style="margin:0 0 8px"></div>
      ${row('setEnv')}${row('setWo')}${row('setProj')}
      <div class="ns-grouphd">Jira — колонка «Статусы» и живые статусы задач</div>
      ${row('setJh')}${row('setJe')}${row('setJt')}
      <div class="ns-grouphd">TeamCity — рейл «Сборки» (статус Android/iOS-билдов)</div>
      ${row('setTh')}${row('setTt')}
      <div class="ns-grouphd">GitLab — секция «Merge Requests» (живые MR по ветке)</div>
      ${row('setGh')}${row('setGt')}
      <div class="ns-grouphd">Unity — запуск инстанса по клику на cu-тег карточки (только в приложении)</div>
      ${row('setCup')}${row('setUed')}${row('setUhub')}
      ${tokHint}
      ${cfg.electron ? '<div class="um-note" style="margin-top:12px">Приложение — обновление одним кликом (проверить → скачать → перезапустить), без переустановки.</div><div class="ns-actions" style="justify-content:flex-start"><button class="btn-ghost" id="setUpdates" type="button">↻ Обновления и версия</button></div>' : ''}
      <div class="ns-actions"><button class="btn-ghost dm-cancel" type="button">Отмена</button><button class="ns-start" id="setSave" type="button">Сохранить</button></div>
      <div class="um-note" id="setStatus" style="margin-top:8px"></div>
    </div></div>`;
  const close = ()=>back.classList.remove('open');
  back.querySelector('.dm-x').addEventListener('click', close);
  back.querySelector('.dm-cancel').addEventListener('click', close);
  back.classList.add('open');
  const upd = back.querySelector('#setUpdates'); if (upd) upd.addEventListener('click', ()=>{ close(); openUpdatesModal(); });
  const status = back.querySelector('#setStatus');
  const rowEl = (id)=> back.querySelector('.ns-row[data-fid="'+id+'"]');
  const tokVal = (id)=>{ const i = back.querySelector('#'+id); return i ? i.value : ''; };
  const tokenPresent = (id)=> st[id].set || !!tokVal(id).trim();   // задан ИЛИ введён новый (ещё не сохранён)
  const updSummary = ()=>{
    const j = !!st.setJh.value.trim() && !!st.setJe.value.trim() && tokenPresent('setJt');
    const t = !!st.setTh.value.trim() && tokenPresent('setTt');
    const g = !!st.setGh.value.trim() && tokenPresent('setGt');
    const chip = (ok,l)=>`<span class="sum-chip ${ok?'ok':'no'}">${ok?'✓':'✗'} ${l}</span>`;
    const el = back.querySelector('#setSummary'); if (el) el.innerHTML = chip(j,'Jira')+chip(t,'TeamCity')+chip(g,'GitLab');
  };
  const repaint = (id)=>{ const el = rowEl(id); if (!el) return; el.outerHTML = nsFieldHtml(FIELDS[id], st[id], HAS_NATIVE); wireRow(id); updSummary(); };
  function wireRow(id){
    const f = FIELDS[id], el = rowEl(id); if (!el) return;
    const inp = el.querySelector('.ns-inp');
    if (inp) inp.addEventListener('input', ()=>{
      if (f.type!=='token') st[id].value = inp.value;
      const wrap = inp.closest('.ns-inpwrap'); if (wrap) wrap.classList.toggle('filled', !!inp.value.trim());
      updSummary();
    });
    const br = el.querySelector('.ns-browse');
    if (br) br.addEventListener('click', async ()=>{
      let r; try { r = await window.deckNative.pickPath({ file: f.pick==='file', current: st[id].value }); } catch { return; }
      if (r && r.ok){ st[id].value = r.path; repaint(id); }
    });
    const clr = el.querySelector('.ns-clr');
    if (clr) clr.addEventListener('click', ()=>{ st[id].value = ''; repaint(id); });
    const del = el.querySelector('.fld-del');
    if (del) del.addEventListener('click', async ()=>{
      const body = {}; body[f.svc+'Token'] = '';
      let r; try { r = await (await fetch('/api/config', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) })).json(); } catch { toast('Ошибка удаления'); return; }
      st[id].set = false; repaint(id);
      if (r && r.config) renderServicesGate(r.config);
      toast('Токен удалён: '+f.svc);
    });
  }
  Object.keys(FIELDS).forEach(wireRow);
  updSummary();
  // «Подтянуть токены» — автоимпорт из существующих секретов (.env / ~/.claude.json / MCP-конфиги).
  back.querySelector('#setImport').addEventListener('click', async ()=>{
    const box = back.querySelector('#setImportRes'); box.textContent = 'Ищу секреты…';
    const envPath = back.querySelector('#setEnv').value.trim();
    let r; try { r = await (await fetch('/api/config/import-tokens', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ secretsEnvPath: envPath }) })).json(); } catch { box.textContent = 'Ошибка импорта.'; return; }
    const res = r.result || {}, src = r.sources || {};
    const mark = (s)=> s==='imported'?'✓': s==='kept'?'≈ уже был': s==='standalone'?'⚠ .env (не сохранён без Electron)': '✗ не найдено';
    const srcShort = (s)=>{ if(!s) return ''; s=String(s); if(s==='process.env/.env') return 'env'; return s.split(/[\\/]/).slice(-2).join('/'); };
    const groups = [['Jira','jiraToken'],['TeamCity','teamcityToken'],['GitLab','gitlabToken'],['WO_STATES_DIR','woStatesDir'],['Папка сессий','claudeProjectsDir']];
    const any = Object.values(res).some(s=>s==='imported');
    const lines = groups.filter(([,k])=>k in res).map(([lbl,k])=>{ const st=res[k]; let t=lbl+': '+mark(st); if(st==='imported' && src[k]) t+=' ('+srcShort(src[k])+')'; return t; });
    box.innerHTML = (any ? 'Импортировано → ' : 'Ничего нового не импортировано → ') + esc(lines.join(' · '));
    if (!any && groups.every(([,k])=> res[k]==='notfound')) box.textContent = 'Источников с токенами не найдено — укажи путь к .env выше и жми снова, либо введи вручную.';
    toast(any ? 'Токены подтянуты' : 'Импорт: нового не найдено');
    // синхронизируем поля со свежим конфигом: токены → «✓ задан», хосты/пути → значения (перерисовкой строки)
    const c = r.config || {};
    const applyTok = (id, on)=>{ if (on && !st[id].set){ st[id].set = true; repaint(id); } };
    applyTok('setJt', c.jira && c.jira.tokenSet); applyTok('setTt', c.teamcity && c.teamcity.tokenSet); applyTok('setGt', c.gitlab && c.gitlab.tokenSet);
    const applyVal = (id, v)=>{ if (v==null) return; st[id].value = v; repaint(id); };
    applyVal('setWo', c.woStatesDir);
    if (c.jira){ applyVal('setJh', c.jira.host); applyVal('setJe', c.jira.email); }
    if (c.teamcity) applyVal('setTh', c.teamcity.host);
    if (c.gitlab) applyVal('setGh', c.gitlab.host);
    updSummary();
    renderServicesGate(c);   // красная плашка сервисов гаснет по мере авторизации
    if (typeof pollSessions === 'function') await pollSessions();   // подтянулся WO_STATES_DIR/Jira → доска получит стадии
    if (typeof loadUsage === 'function') loadUsage();
  });
  back.querySelector('#setSave').addEventListener('click', async ()=>{
    status.textContent = 'Сохраняю…';
    const payload = {
      secretsEnvPath: st.setEnv.value.trim(),
      woStatesDir: st.setWo.value.trim(),
      claudeProjectsDir: st.setProj.value.trim(),
      jiraHost: st.setJh.value.trim(),
      jiraEmail: st.setJe.value.trim(),
      teamcityHost: st.setTh.value.trim(),
      gitlabHost: st.setGh.value.trim(),
      clientUnityParent: st.setCup.value.trim(),
      unityEditorsDir: st.setUed.value.trim(),
      unityHubPath: st.setUhub.value.trim(),
    };
    const jt = tokVal('setJt'), tt = tokVal('setTt'), gt = tokVal('setGt');
    if (jt) payload.jiraToken = jt; if (tt) payload.teamcityToken = tt; if (gt) payload.gitlabToken = gt;
    let r; try { r = await (await fetch('/api/config', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) })).json(); } catch { status.textContent = 'Ошибка сохранения.'; return; }
    const standalone = r.tokenResult && Object.values(r.tokenResult).some(x => x && x.ok === false && x.standalone);
    // сохранённые токены → «✓ задан» (строка перерисуется в компактный вид с кнопкой «удалить»)
    [['setJt',jt],['setTt',tt],['setGt',gt]].forEach(([id,v])=>{ if (v && !standalone){ st[id].set = true; repaint(id); } });
    updSummary();
    let msg = 'Сохранено.' + (standalone ? ' Токены не сохранены (standalone) — используйте .env.' : '');
    status.textContent = msg + ' Обновляю доску…';
    MR_TTL_RESET();   // сбросить клиентские кэши MR/Jira, чтобы сборки/MR перечитались с новым токеном
    if (r.config) renderServicesGate(r.config);   // авторизовали сервис → красная плашка обновится
    if (typeof pollSessions === 'function') await pollSessions();
    if (typeof loadUsage === 'function') loadUsage();
    setTimeout(close, 900);
  });
}


ensureStatusTab();
initNotifyToggle();
wireTopbar();
loadAuth();
loadServicesGate();
// Electron: клик по нативному уведомлению приходит сюда мостом → открываем сессию.
if (window.deckNative && window.deckNative.onOpenSession) window.deckNative.onOpenSession((file)=>{ if (file) openSession(file); });
// Electron: открыть окно «Обновления» из меню/трея + принимать статусы автоапдейтера.
if (window.deckNative && window.deckNative.onOpenUpdates) window.deckNative.onOpenUpdates(openUpdatesModal);
// Electron: Ctrl/Cmd+K через нативный аксельратор меню (физическое сочетание может не дойти до document-listener).
if (window.deckNative && window.deckNative.onOpenPalette) window.deckNative.onOpenPalette(() => openPal());
if (window.deckNative && window.deckNative.onUpdateStatus) window.deckNative.onUpdateStatus(renderUpdateStatus);
load();


