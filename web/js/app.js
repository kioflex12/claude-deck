import { esc, escHtml, ctxColor, pctOf, kTok, timeAgo, mdInline, mdToHtml, fmtTok } from './util.js';
import { WF_COLUMNS, WF_LABEL, effectiveColumn, cardStatus, searchableText } from './columns.js';

/* Deck — реальные сессии Claude Code. Данные: /api/sessions (список) + /api/session (транскрипт блоками) + /api/skills (скиллы по cwd). */
const JIRA = "https://example.atlassian.net/browse/";
const GL = "https://gitlab.wo/";
const TC = "https://teamcity.wo/viewLog.html?buildId=";
const CONN = "https://claude.ai/settings/connectors";
const EI = '<svg class="ei" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6"><path d="M7 17 17 7M9 7h8v8"/></svg>';
const aReal = (href, text, cls='') => `<a class="lnk ${cls}" href="${href}" target="_blank" rel="noopener" title="${href}">${text}${EI}</a>`;
const aStub = (href, text, cls='') => `<a class="lnk ${cls}" href="#" onclick="return false" title="${href}">${text}${EI}</a>`;

/* доска по свежести */
const COLUMNS = [
  { key:'today', title:'Сегодня',           dot:'var(--accent)' },
  { key:'week',  title:'Последние 7 дней',   dot:'var(--info)' },
  { key:'older', title:'Раньше',             dot:'var(--text-faint)' },
];
/* доска по стадии workflow (основная) */


let SESSIONS = [];
const SESSION_CACHE = {}; // file -> полный транскрипт

/* ---------- helpers ---------- */


let activeView='status', filter='all', query='', skillCat='all', currentFile=null, returnView='status';
let SESSION_SKILLS = [], slashItems = [], slashSel = 0, slashOpen = false;   // «/» в композере
let streaming = false, currentES = null;   // живой стрим ответа в консоль
let liveFinish = null, streamTimer = null;  // обрыв стрима кнопкой СТОП + счётчик секунд
let currentStreamId = null;                 // id живого стрима (для гарантированного /api/stop)
// Обрыв стрима кнопкой Стоп — надёжно, независимо от детекта дисконнекта: /api/stop + локальный finish/hard-reset.
function userStop(){
  if (!streaming && !currentES){ clearQueue(); return; }
  if (currentStreamId) fetch('/api/stop?id=' + encodeURIComponent(currentStreamId), { cache:'no-store' }).catch(()=>{});
  if (liveFinish){ liveFinish('Остановлено пользователем', { silent:true, stopped:true }); return; }
  // стрим жив, но finish потерялся (перерисовка/edge) — жёстко обрываем сами
  if (currentES){ try { currentES.close(); } catch {} currentES = null; }
  if (streamTimer){ clearInterval(streamTimer); streamTimer = null; }
  document.querySelectorAll('.cx-run-chat').forEach(el => el.remove());
  streamingFile = null; currentStreamId = null; setComposerBusy(false); clearQueue();
}
let buildTimer = null;                      // live-опрос сборок TeamCity
let streamingFile = null;                   // файл сессии, которую Deck стримит сейчас (оверрайд working=true)
let notifyEnabled = false;                  // браузерные уведомления о завершении включены
let prevWorkingFiles = new Set();           // «работающие» сессии на прошлый опрос (детект working→idle)
const notifiedDone = new Set();             // файлы, за чей текущий рабочий эпизод уже уведомили (дедуп)
let pollTimer = null, polling = false;      // живой поллинг доски ~7с
let tailTimer = null, tailCount = 0;        // live-tail открытой активной сессии (курсор = число блоков)
let agentsTimer = null;                      // live-опрос фоновых сабагентов открытой сессии
const MR_CACHE = {};                        // branch -> { ts, mrs } живые MR из GitLab (кэш клиента ~30с)
const LIVE_TTL = 30000;                     // TTL клиентских кэшей MR/Jira — влитый MR перелистнётся в пределах ~30с
let mrHydrating = false;                    // идёт фоновая подгрузка MR для карточек
const JIRA_CACHE = {};                      // wo -> { ts, available, status, category, summary } живой статус Jira
let jiraHydrating = false;                  // идёт фоновая подгрузка статусов Jira
const promptQueue = [];                     // очередь промтов, отправленных во время активного стрима (FIFO)
let sessionMode = 'default';                 // P3: режим разрешений текущей сессии (shift-tab цикл)
const MODE_ORDER = ['default','acceptEdits','plan','bypassPermissions'];
const MODE_LABEL = { default:'Обычный', acceptEdits:'Авто-правки', plan:'План', bypassPermissions:'Байпас' };
const attachDraft = [];                      // P4: черновик вложений текущего сообщения [{name, mediaType, kind, dataB64|text, preview}]
const ATTACH_MAX_BYTES = 18 * 1024 * 1024;   // суммарный лимит вложений ~18МБ
const SKILLS_CACHE = {};

/* ---------- board = сессии ---------- */
// Единая searchable-строка из ВСЕХ отображаемых на карточке меток — чтобы «backend», «cu2»,
// «preupdate», «на qa», «merged», «chat-service» реально фильтровали.

function boardMatch(s){
  if (filter!=='all' && s.project!==filter) return false;
  if (query && !searchableText(s, JIRA_CACHE, MR_CACHE, isWorking(s)).includes(query)) return false;
  return true;
}
function ctxMini(s){
  const p = pctOf(s);
  return `<span class="mini-ctx"><span class="mini-bar"><i style="width:${p}%;background:${ctxColor(s.ctxPct)}"></i></span>${p}%</span>`;
}
function isWorking(s){ return !!s && (s.working === true || (s.bgRunning|0) > 0 || (!!streamingFile && s.file === streamingFile)); }
function scopeChipsHTML(s){   // скоуп: cuN · backend · статика · ЕДИНЫЙ тег базовой ветки (форк-источник ≈ таргет, ✓ если влито)
  const out = [];
  if (s.clientCu) out.push(`<span class="chip sc-cu sc-cu-run" data-cu="${esc(s.clientCu)}" data-cwd="${esc(s.cwd||'')}" title="Запустить Unity (${esc(s.clientCu)})">${esc(s.clientCu)}</span>`);
  if (s.backend)  out.push(`<span class="chip sc-be">backend</span>`);
  if (s.statics)  out.push(`<span class="chip sc-st">статика</span>`);
  if (s.baseBranch) out.push(`<span class="chip sc-base" title="базовая ветка (форк-источник ≈ таргет мерджа)">⎇ ${esc(s.baseBranch)}${s.merged?' ✓':''}</span>`);
  return out.join('');
}
function tagsChipsHTML(s){    // пользовательские теги
  const t = Array.isArray(s.tags) ? s.tags : [];
  return t.map(x=>`<span class="chip sc-tag">#${esc(x)}</span>`).join('');
}
// Единый резолв колонки/стадии (для keyOf и статус-бара): приоритет по уточнению коордиинатора.

function cardHTML(s){
  const wf = activeView === 'status';
  const working = isWorking(s);
  const st = cardStatus(s, JIRA_CACHE);
  const blocked = st.blocked;
  // Статусы: колонка = стадия → бар ТОЛЬКО для под-стадийного уточнения (без дубля названия колонки).
  // Доска (по свежести): колонок-стадий нет → бар всегда, полный локализованный ярлык.
  let statusBar = '';
  if (wf){
    if (st.sub) statusBar = `<div class="card-status cs-${esc(st.col)}">${esc(st.sub)}</div>`;
  } else {
    const txt = st.sub || WF_LABEL[st.col] || '';
    if (txt) statusBar = `<div class="card-status cs-${esc(st.col)}${blocked?' cs-blocked':''}">${esc(txt)}</div>`;
  }
  const stColor = blocked ? 'var(--bad)' : working ? 'var(--good)' : s.active ? 'var(--accent)' : '';   // blocked — красная полоса (виден и без бара)
  const stripe = stColor ? `class="card stripe" style="--st:${stColor}"` : 'class="card"';
  const pulse = working ? '<span class="pulse"></span>' : '';
  const wfChips = wf ? [
    (s.wfStep!=null ? `<span class="chip">шаг ${s.wfStep}</span>` : ''),
    (s.wfMr ? `<span class="chip">MR</span>` : ''),
  ].join('') : '';
  const chips = [
    s.gitBranch ? `<span class="chip repo">⎇ ${esc(s.gitBranch)}</span>` : '',
    `<span class="chip">${esc(s.model)}</span>`,
    `<span class="chip">${s.msgs} сообщ.</span>`,
    s.wo ? `<span class="chip">${esc(s.wo)}</span>` : '',
    scopeChipsHTML(s),
    tagsChipsHTML(s),
    wfChips,
  ].join('');
  const bg = (s.bgRunning|0) > 0 ? ` · ${s.bgRunning} ${s.bgRunning===1?'агент':'агента'} в фоне` : '';
  const flag = working
    ? `<div class="flag working"><span class="dot"></span>работает${bg}</div>`
    : s.active ? `<div class="flag attention"><span class="dot"></span>активна · ${timeAgo(s.mtime)}</div>` : '';
  const buildPill = s.buildActive
    ? `<span class="pill"><span class="d run"></span>билд</span>` : '';
  // MR — приоритет live-данным из GitLab (MR_CACHE), stale wfMrUrl лишь как фолбэк пока live не загрузилось
  const live = (s.gitBranch && MR_CACHE[s.gitBranch]) ? MR_CACHE[s.gitBranch].mrs : null;
  let mrPill = '';
  if (live && live.length){
    mrPill = live.slice(0,2).map(m=>{
      const cls = m.state==='merged'?'mr-merged':m.state==='closed'?'mr-closed':'mr-open';
      const dot = m.state==='merged'?'pass':m.state==='closed'?'fail':'';
      return `<a class="pill ${cls}" href="${esc(m.web_url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()"><span class="d ${dot}"></span>!${esc(String(m.iid))}</a>`;
    }).join('');
  } else if (!live && s.wfMrUrl){
    mrPill = `<a class="pill mr-${s.wfMrState}" href="${esc(s.wfMrUrl)}" target="_blank" rel="noopener" onclick="event.stopPropagation()"><span class="d ${s.wfMrState==='merged'?'pass':''}"></span>MR</a>`;
  }
  const foot = `<div class="card-foot">${buildPill}${mrPill}<span class="mini-ctx">${timeAgo(s.mtime)}</span><span class="foot-sep"></span>${ctxMini(s)}</div>`;
  return `<article ${stripe} tabindex="0" role="button" data-file="${esc(s.file)}">${statusBar}<div class="card-top">${pulse}<span class="wo">${esc(s.project)}</span></div><h3 class="card-title">${esc(s.title)}</h3><div class="chips">${chips}</div>${flag}${foot}</article>`;
}
function renderBoard(animate){
  const board = document.getElementById('board');
  const workflow = activeView==='status';
  const cols = workflow ? WF_COLUMNS : COLUMNS;
  const keyOf = s => workflow ? effectiveColumn(s, JIRA_CACHE).col : s.column;   // 7-колоночная логика — единый резолв
  // поллинг перерисовывает без анимации и с сохранением прокрутки — чтобы доска не «дёргалась»
  const sx = board.scrollLeft;
  const colScroll = [...board.querySelectorAll('.col-body')].map(el=>el.scrollTop);
  board.innerHTML = cols.map(c=>{
    const items = SESSIONS.filter(s=>keyOf(s)===c.key && boardMatch(s));
    const body = items.length ? items.map((s,i)=>{
      const styled = animate ? `<article style="animation-delay:${i*35}ms" ` : `<article style="animation:none" `;
      return cardHTML(s).replace('<article ', styled);
    }).join('') : `<div class="empty">— пусто —</div>`;
    return `<section class="col"><div class="col-head" style="--dot:${c.dot}"><span class="col-title">${c.title}</span><span class="col-count">${items.length}</span></div><div class="col-body">${body}</div></section>`;
  }).join('');
  board.scrollLeft = sx;
  const newCols = board.querySelectorAll('.col-body');
  colScroll.forEach((t,i)=>{ if (newCols[i]) newCols[i].scrollTop = t; });
  board.querySelectorAll('.card').forEach(el=>{
    el.addEventListener('click',()=>openSession(el.dataset.file));
    el.addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); openSession(el.dataset.file); } });
  });
  board.querySelectorAll('.sc-cu-run').forEach(el=>{
    el.addEventListener('click', e=>{ e.stopPropagation(); launchUnity(el.dataset.cu, el.dataset.cwd); });   // тап по cu-тегу → Unity, НЕ открывать карточку
  });
}
async function launchUnity(cu, cwd){
  if (!(window.deckNative && window.deckNative.openUnity)){ toast('Запуск Unity доступен только в приложении'); return; }
  toast('Запускаю Unity ' + cu + '…');
  try {
    const r = await window.deckNative.openUnity({ cu, cwd });
    if (r && r.ok) toast('Unity ' + cu + ' запускается' + (r.launched ? ' · ' + r.launched : ''));
    else toast('Unity не запущен: ' + ((r && r.error) || 'неизвестная ошибка'));
  } catch (e) { toast('Ошибка запуска Unity: ' + ((e && e.message) || e)); }
}
function renderNow(){
  const now = document.getElementById('now');
  // кнопка «Новая сессия» — ВСЕГДА (даже без активного контекста)
  const newBtn = `<button class="btn-resume now-btn" id="nowNewBtn" title="Создать новую сессию"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M12 5v14M5 12h14"/></svg> Новая сессия</button>`;
  const s = contextSession();
  if (!s){
    now.innerHTML = `<span class="now-label">нет открытого контекста</span><span class="spacer"></span>${newBtn}`;
    const nb = now.querySelector('#nowNewBtn'); if (nb) nb.addEventListener('click', openNewSessionDialog);
    return;
  }
  const p = pctOf(s);
  now.innerHTML = `
    <span class="now-label">${isWorking(s)?'<span class="pulse"></span>работает · ':''}текущий контекст</span>
    <a class="now-ctx-link" href="#" data-file="${esc(s.file)}" title="Открыть сессию в Deck"><span class="now-id">${esc(s.project)}</span><span class="now-title">${esc(s.title)}</span></a>
    <span class="now-meta hide-sm"><span>${esc(s.model)}</span><span><b>${s.msgs}</b> сообщ.</span><span>${timeAgo(s.mtime)}</span>
      <span style="display:flex;align-items:center;gap:8px">окно<span class="ctxbar" style="width:120px"><i style="width:${p}%;background:${ctxColor(s.ctxPct)}"></i></span><b style="font-family:var(--mono)">${p}%</b></span></span>
    ${newBtn}`;
  now.querySelector('.now-ctx-link').addEventListener('click', e => { e.preventDefault(); openSession(e.currentTarget.dataset.file); });
  const nb = now.querySelector('#nowNewBtn'); if (nb) nb.addEventListener('click', openNewSessionDialog);
}
function renderFilters(){
  const projects = [...new Set(SESSIONS.map(s=>s.project).filter(Boolean))].sort();
  document.getElementById('filters').innerHTML =
    `<button class="fchip" data-f="all" aria-pressed="${filter==='all'}">Все</button>` +
    projects.map(p=>`<button class="fchip" data-f="${esc(p)}" aria-pressed="${filter===p}">${esc(p)}</button>`).join('');
}

/* ---------- skills (статический контент макета вкладки) ---------- */
/* TECH-2: списки НЕ захардкожены — тянутся с сервера (реальные скиллы/MCP из файлов окружения). */
let SKILLS = [], MCP_SERVERS = [], skillsLoaded = false, mcpLoaded = false;
let MCP_STATUS = { available: false, live: false, servers: [] }, mcpLoading = false;
const mcpExpanded = new Set();   // какие MCP-карточки развёрнуты
const SCAT_LABEL = { user:'Пользователь', project:'Проект', 'прочее':'Прочее' };
async function loadSkillsCatalog(){
  try { const r = await fetch('/api/skills', { cache:'no-store' }); const d = await r.json(); SKILLS = Array.isArray(d.skills) ? d.skills : []; }
  catch { SKILLS = []; }
  skillsLoaded = true;
  if (activeView === 'skills') renderSkills();
}
async function loadMcpCatalog(refresh){
  // Живой статус через SDK-пробу (mcpServerStatus); refresh=1 = «реконнект» (свежая проба).
  mcpLoading = true; if (activeView === 'mcp') renderMcp();
  try { const r = await fetch('/api/mcp/status' + (refresh ? '?refresh=1' : ''), { cache:'no-store' }); const d = await r.json(); MCP_STATUS = d; MCP_SERVERS = Array.isArray(d.servers) ? d.servers : []; }
  catch { MCP_STATUS = { available:false, live:false, reason:'сеть', servers:[] }; MCP_SERVERS = []; }
  mcpLoaded = true; mcpLoading = false;
  if (activeView === 'mcp') renderMcp();
}
function skillMatch(sk){
  if (skillCat !== 'all' && sk.cat !== skillCat) return false;
  if (query && !((sk.cmd||'') + ' ' + (sk.does||'') + ' ' + (sk.trig||'')).toLowerCase().includes(query)) return false;
  return true;
}
function skillCats(){   // категории строятся динамически из того, что реально пришло
  const counts = {};
  for (const s of SKILLS){ const c = s.cat || 'прочее'; counts[c] = (counts[c]||0) + 1; }
  const keys = Object.keys(counts).sort((a,b)=>counts[b]-counts[a] || a.localeCompare(b));
  return [{ key:'all', label:'Все скиллы' }].concat(keys.map(k=>({ key:k, label: SCAT_LABEL[k] || k })));
}
function renderSkills(){
  if (!skillsLoaded){ loadSkillsCatalog(); }
  const cats = skillCats();
  const rail = document.getElementById('rail');
  rail.innerHTML = `<div class="rail-label">Категории</div>` + cats.map(c => {
    const n = c.key==='all' ? SKILLS.length : SKILLS.filter(s=>(s.cat||'прочее')===c.key).length;
    return `<button class="cat" data-c="${esc(c.key)}" aria-pressed="${c.key===skillCat}">${esc(c.label)}<span class="c-count">${n}</span></button>`;
  }).join('');
  rail.querySelectorAll('.cat').forEach(b => b.addEventListener('click', () => { skillCat = b.dataset.c; renderSkills(); }));
  const grid = document.getElementById('skillsGrid');
  const items = SKILLS.filter(skillMatch);
  const catLabel = k => { const c = cats.find(x=>x.key===k); return c ? c.label : (SCAT_LABEL[k]||k); };
  if (!skillsLoaded){ grid.innerHTML = `<div class="empty">Загрузка скиллов…</div>`; return; }
  grid.innerHTML = items.length ? items.map((s,i)=>`
    <div class="skill-card" style="animation-delay:${i*25}ms">
      <div class="skill-head"><span class="skill-cmd-tag">/${esc(s.cmd)}</span><span class="skill-cat-chip">${esc(catLabel(s.cat||'прочее'))}</span></div>
      <div class="skill-does">${esc(s.does||'')}</div>
      ${s.trig?`<div class="skill-trig"><b>когда зовётся</b>${esc(s.trig)}</div>`:''}
      <div class="skill-foot"><button class="skill-run" data-cmd="${esc(s.cmd)}"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M7 5v14l12-7z"/></svg> вставить /${esc(s.cmd)}</button></div>
    </div>`).join('') : `<div class="empty">${SKILLS.length?'Ничего не найдено':'Скиллы не найдены'}</div>`;
  grid.querySelectorAll('.skill-run').forEach(b => b.addEventListener('click', async () => {
    const cmd = '/' + b.dataset.cmd;
    if (currentFile){
      await openSession(currentFile);                       // переключаемся в сессию — композер становится видимым
      const ta = document.getElementById('composer-ta');
      if (ta){ ta.value = cmd + ' '; ta.dispatchEvent(new Event('input')); ta.focus(); }   // input → включает кнопку отправки/ресайз
      toast('Вставлено в композер: ' + cmd);
    } else if (navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(cmd).then(()=>toast('Скопировано: ' + cmd)).catch(()=>toast('Не удалось скопировать'));
    } else { toast('Открой сессию, чтобы вставить ' + cmd); }
  }));
}

/* ---------- mcp (живой статус через SDK + разворот деталей + реконнект) ---------- */
function mcpMatch(m){ return !query || ((m.name||'')+' '+(m.desc||'')+' '+(m.command||'')+' '+(m.scope||'')+' '+(m.status||'')).toLowerCase().includes(query); }
const MCP_ST = {
  connected:{c:'st-connected',t:'подключён'}, failed:{c:'st-failed',t:'ошибка'},
  'needs-auth':{c:'st-needs-auth',t:'нужна авторизация'}, pending:{c:'st-pending',t:'подключается'},
  unknown:{c:'st-unknown',t:'нет данных'},
};
function mcpBadge(s){ const m = MCP_ST[s] || MCP_ST.unknown; return `<span class="mcp-badge ${m.c}">${esc(m.t)}</span>`; }
function renderMcp(){
  if (!mcpLoaded && !mcpLoading){ loadMcpCatalog(); }
  const items = MCP_SERVERS.filter(mcpMatch);
  const note = mcpLoading ? 'опрос…'
    : (MCP_STATUS.live ? 'живой статус (SDK)'
      : (MCP_STATUS.available === false ? ('статус недоступен: ' + esc(MCP_STATUS.reason || '') + ' — показаны конфиги') : 'из конфигов'));
  const cards = items.map((m,i)=>{
    const exp = mcpExpanded.has(m.name);
    const needsAuth = m.status === 'needs-auth';
    const toolList = Array.isArray(m.tools) && m.tools.length ? `<div class="mcp-tools">${m.tools.map(t=>`<span class="mcp-tool">${esc(t)}</span>`).join('')}</div>` : '';
    return `<div class="mcp-card${exp?' open':''}" data-mcp="${esc(m.name)}" style="animation-delay:${i*20}ms">
      <div class="mcp-top"><span class="mcp-name">${esc(m.name)}</span>${mcpBadge(m.status)}<span class="mcp-scope">${esc(m.scope||'')}</span></div>
      ${m.desc?`<div class="mcp-desc">${esc(m.desc)}</div>`:''}
      <div class="mcp-foot"><span class="mcp-cat">${esc(m.transport||'')}</span>${m.toolCount!=null?`<span class="mcp-cat">${m.toolCount} tools</span>`:''}<span class="mcp-cmd" title="${esc(m.command||'')}">${esc((m.command||'').slice(0,60))}</span></div>
      ${exp?`<div class="mcp-detail">
        ${m.error?`<div class="mcp-err">${esc(m.error)}</div>`:''}
        ${needsAuth?`<div class="mcp-hint">Нужна авторизация. claude.ai-коннекторы — в настройках коннекторов claude.ai; остальные — через <code>claude mcp</code> или /mcp в интерактивной сессии. (Запуск OAuth прямо из Deck — отдельно.)</div>`:''}
        <div class="mcp-kv"><span>статус</span><b>${esc(m.status||'—')}</b></div>
        <div class="mcp-kv"><span>transport</span><b>${esc(m.transport||'—')}</b></div>
        <div class="mcp-kv"><span>scope</span><b>${esc(m.scope||'—')}</b></div>
        <div class="mcp-kv"><span>command</span><b>${esc(m.command||'—')}</b></div>
        ${toolList}
      </div>`:''}
    </div>`;
  }).join('');
  const body = (mcpLoading && !MCP_SERVERS.length) ? `<div class="empty">Опрашиваю MCP…</div>`
    : (items.length ? `<div class="mcp-grid">${cards}</div>` : `<div class="empty">${MCP_SERVERS.length?'Ничего не найдено':'MCP-серверы не найдены'}</div>`);
  document.getElementById('viewMcp').innerHTML = `<div class="mcp-main">
    <div class="mcp-head"><h2>MCP-инструменты</h2><span class="sub">${MCP_SERVERS.length} серверов · ${note}</span><button class="mcp-refresh" id="mcpRefresh"${mcpLoading?' disabled':''}>${mcpLoading?'опрос…':'Обновить'}</button></div>
    ${body}</div>`;
  const rb = document.getElementById('mcpRefresh'); if (rb) rb.addEventListener('click', ()=>{ if (!mcpLoading) loadMcpCatalog(true); });
  document.querySelectorAll('#viewMcp .mcp-card').forEach(c => c.addEventListener('click', ()=>{ const n = c.dataset.mcp; if (mcpExpanded.has(n)) mcpExpanded.delete(n); else mcpExpanded.add(n); renderMcp(); }));
}

/* ---------- session: правый рейл контекста (плотные секции на реальных данных + wf) ---------- */

// Локализация сырого Jira-статуса → русское под-стадийное уточнение (согласовано со словарём колонок).
// Возвращает '' когда статус = самой колонке (чтобы не дублировать её название).

function sideHTML(t){
  const p = Math.round((t.ctxPct||0)*100);
  const stateColor = t.active ? 'var(--good)' : 'var(--text-faint)';
  const stateLabel = t.active ? 'активна' : 'архив';

  // репозиторий выводим из URL MR (`…/-/merge_requests/NNNN`) — для ссылки на ветку в GitLab
  const repoBase = t.wfMrUrl ? String(t.wfMrUrl).replace(/\/-\/merge_requests\/.*$/,'').replace(/\/$/,'') : '';
  const branchTxt = esc(t.gitBranch||'—');
  const branchCell = (repoBase && t.gitBranch && t.wo)
    ? aReal(repoBase+'/-/tree/'+encodeURIComponent(t.gitBranch), branchTxt, 'plain')
    : `<span class="ri-v">${branchTxt}</span>`;

  // стадия dev-workflow
  const stage = t.wfColumn ? (WF_LABEL[t.wfColumn]||t.wfColumn) : '—';
  const stageMeta = `${esc(stage)}${t.wfStep!=null?' · шаг '+t.wfStep:''}`;

  // Merge Request
  const mrNum = t.wfMrUrl ? (String(t.wfMrUrl).match(/merge_requests\/(\d+)/)||[])[1] : '';
  const mrLabel = mrNum ? '!'+mrNum : 'MR';
  const mrStateCls = t.wfMrState==='merged' ? 'mr-merged' : 'mr-open';
  const mrStateLabel = t.wfMrState==='merged' ? 'влит' : 'открыт';
  const mrApprox = t.wfMrUrl
    ? `<div class="row-item"><span class="ri-k">merge</span>${aReal(t.wfMrUrl, mrLabel, 'plain')}<span class="ri-badge pill ${mrStateCls}"><span class="d ${t.wfMrState==='merged'?'pass':''}"></span>${mrStateLabel}</span></div>`
    : `<div class="rail-empty">— MR ещё нет —</div>`;
  const mrSection = `<div id="mrBox">${mrApprox}<div class="rail-hint">проверяю GitLab…</div></div>`;   // loadMrs заменит live-данными

  // Сборки: сперва приближение по wf (мигает пока running), затем loadBuilds заменит live-данными из TeamCity
  let buildApprox;
  if (t.buildActive) buildApprox = `<div class="build-row"><span class="plat">CI</span><span class="build-state"><span class="d run"></span>идёт</span></div>`;
  else if (t.wfBuildState==='done') buildApprox = `<div class="build-row"><span class="plat">CI</span><span class="build-state"><span class="d pass"></span>готово</span></div>`;
  else buildApprox = `<div class="rail-empty">— сборок нет —</div>`;
  const buildSection = `<div id="buildBox">${buildApprox}<div class="rail-hint">проверяю TeamCity…</div></div>`;

  // Заметки для возврата (userClarifications из dev-workflow)
  const notes = Array.isArray(t.notes) ? t.notes : [];
  const notesSection = notes.length
    ? `<div class="sec"><div class="sec-label">Заметки для возврата</div><ul class="notes">${notes.map(n=>`<li>${esc(n)}</li>`).join('')}</ul></div>`
    : '';

  const jiraBtn = t.wo ? `<a class="btn-ghost" href="${JIRA}${t.wo}" target="_blank" rel="noopener"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg> Открыть ${esc(t.wo)} в Jira</a>` : '';
  const forkBtn = `<button class="btn-ghost" id="forkBtn" type="button" title="Продолжить в новой сессии с контекстом этой"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="6" cy="6" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="12" cy="20" r="2"/><path d="M6 8v3a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V8M12 14v4"/></svg> Форкнуть сессию</button>`;
  const delBtn = `<button class="btn-ghost btn-danger" id="delSessionBtn" type="button" title="Убрать сессию из Deck (в корзину, восстановимо)"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M3 6h18M8 6V4h8v2M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14M10 11v6M14 11v6"/></svg> Удалить сессию</button>`;

  return `
    <div class="sec"><div class="sec-label">Описание</div><div class="desc">${esc(t.lastPrompt||t.title||'—')}</div></div>
    <div class="sec">
      <div class="sec-label"><span class="ll">Сессия Claude</span><span class="st-note" style="color:${stateColor}">${stateLabel}</span></div>
      <div class="stat-grid">
        <div class="stat"><div class="k">модель</div><div class="v">${esc(t.model)}</div></div>
        <div class="stat"><div class="k">сообщений</div><div class="v">${t.count}</div></div>
        <div class="stat"><div class="k">активность</div><div class="v">${timeAgo(t.mtime)}</div></div>
        <div class="stat"><div class="k">окно</div><div class="v">${kTok(t.winTokens)} / 1M</div></div>
      </div>
      <div class="ctx-row"><span class="k-line">контекст</span><span class="ctxbar"><i style="width:${p}%;background:${ctxColor(t.ctxPct)}"></i></span><span class="ctx-pct" style="color:${ctxColor(t.ctxPct)}">${p}%</span></div>
      <div class="row-item" style="margin-top:10px"><span class="ri-k">стадия</span><span class="ri-v">${stageMeta}</span></div>
    </div>
    <div class="sec"><div class="sec-label">Ветка</div>
      <div class="row-item"><span class="ri-k">${esc(t.project||'проект')}</span>${branchCell}${t.wo?`<span class="ri-badge chip">${esc(t.wo)}</span>`:''}</div>
      <div class="rail-hint"><code>${esc(t.cwd||'—')}</code></div>
    </div>
    ${t.wo?`<div class="sec"><div class="sec-label">Статус Jira</div><div id="jiraBox"><div class="rail-hint">проверяю Jira…</div></div></div>`:''}
    <div class="sec"><div class="sec-label">Скоуп</div>
      <div class="chips">
        ${t.wo?`<span class="chip">${esc(t.wo)}</span>`:''}
        ${t.clientCu?`<span class="chip sc-cu">${esc(t.clientCu)}</span>`:''}
        ${t.backend?`<span class="chip sc-be">backend</span>`:''}
        ${t.statics?`<span class="chip sc-st">статика</span>`:''}
        ${t.baseBranch?`<span class="chip sc-base" title="базовая ветка (форк-источник ≈ таргет мерджа)">⎇ ${esc(t.baseBranch)}${t.merged?' ✓':''}</span>`:''}
      </div>
      ${(t.backend && Array.isArray(t.changedServices) && t.changedServices.length)?`<div class="rail-hint">сервисы: ${t.changedServices.map(esc).join(', ')}</div>`:''}
    </div>
    <div class="sec" id="agentsSec"${runningAgents(t.agents).length?'':' hidden'}><div class="sec-label">Фоновые агенты</div><div id="agentsBox">${agentBoxHTML(t.agents||[])}</div></div>
    <div class="sec"><div class="sec-label">Теги</div>
      <div class="tags-wrap" id="tagsWrap"></div>
      <input class="tags-input" id="tagsInput" type="text" placeholder="добавить тег + Enter" autocomplete="off" spellcheck="false">
    </div>
    <div class="sec"><div class="sec-label">Merge Requests</div>${mrSection}</div>
    <div class="sec"><div class="sec-label">Сборки</div>${buildSection}</div>
    ${notesSection}
    <div class="sec"><div class="sec-label">Файл сессии</div><div class="rail-hint"><code>${esc(t.file)}</code></div>
      <div class="side-actions">${jiraBtn}${forkBtn}${delBtn}</div>
    </div>`;
}
/* ---------- live-статус сборок (TeamCity) в секции «Сборки» ---------- */
function buildDot(b){
  const state = String(b.state||'').toLowerCase(), status = String(b.status||'').toUpperCase();
  if (state==='queued')  return { cls:'run',  label:'в очереди', run:true };
  if (state==='running') return { cls:'run',  label:'идёт',      run:true };
  if (status==='SUCCESS') return { cls:'pass', label:'успех' };
  if (status==='FAILURE'||status==='ERROR') return { cls:'fail', label:'упал' };
  return { cls:'none', label: status || state || '—' };
}
const BASE_BRANCHES = new Set(['preprod','preupdate','master','main','develop','dev','prod','release','head','']);
function isBaseBranch(b){ return BASE_BRANCHES.has(String(b||'').trim().toLowerCase()); }
async function loadBuilds(t){
  if (buildTimer){ clearInterval(buildTimer); buildTimer = null; }
  const box0 = document.getElementById('buildBox'); if (!box0 || !t.gitBranch) return;
  // базовая ветка без WO не идентифицирует сборки контекста — сразу «нет», без мигания «проверяю…» и без фетча
  if (isBaseBranch(t.gitBranch) && !t.wo){ box0.innerHTML = `<div class="rail-empty">— сборок нет —</div>`; return; }
  const url = '/api/build?branch=' + encodeURIComponent(t.gitBranch) + '&wo=' + encodeURIComponent(t.wo||'');
  const render = async () => {
    let d; try { const r = await fetch(url, { cache:'no-store' }); d = await r.json(); } catch { return false; }
    const box = document.getElementById('buildBox'); if (!box) return false;
    if (!d.available){ box.insertAdjacentHTML('beforeend', `<div class="rail-hint">TeamCity недоступен: ${esc(d.reason||'нет доступа')}</div>`); return false; }
    if (!d.builds || !d.builds.length){ box.innerHTML = `<div class="rail-empty">— сборок для ветки нет —</div>`; return false; }
    let running = false;
    box.innerHTML = d.builds.map(b => {
      const s = buildDot(b); if (s.run) running = true;
      const link = b.webUrl ? aReal(b.webUrl, '#'+esc(b.number||'—'), 'plain') : `<span class="ri-v">#${esc(b.number||'—')}</span>`;
      return `<div class="build-row"><span class="plat">${esc(b.plat)}</span><span class="build-state"><span class="d ${s.cls}"></span>${s.label}</span><span class="bl-link">${link}</span></div>`;
    }).join('');
    return running;
  };
  const running = await render();
  if (running && !buildTimer){
    buildTimer = setInterval(async () => { const r = await render(); if (!r && buildTimer){ clearInterval(buildTimer); buildTimer = null; } }, 15000);
  }
}
/* ---------- live-MR (GitLab) в секции «Merge Requests» + на карточках ---------- */
function mrPillHTML(m){
  const cls = m.state==='merged' ? 'mr-merged' : m.state==='closed' ? 'mr-closed' : 'mr-open';
  const lbl = m.state==='merged' ? 'влит' : m.state==='closed' ? 'закрыт' : 'открыт';
  const dot = m.state==='merged' ? 'pass' : m.state==='closed' ? 'fail' : '';
  return `<span class="ri-badge pill ${cls}"><span class="d ${dot}"></span>${lbl}</span>`;
}
async function loadMrs(t){
  const box = document.getElementById('mrBox'); if (!box) return;
  let d; try { const r = await fetch('/api/mrs?branch=' + encodeURIComponent(t.gitBranch||'') + '&wo=' + encodeURIComponent(t.wo||''), { cache:'no-store' }); d = await r.json(); } catch { return; }
  const box2 = document.getElementById('mrBox'); if (!box2) return;
  if (!d.available){ box2.insertAdjacentHTML('beforeend', `<div class="rail-hint">GitLab недоступен: ${esc(d.reason||'нет доступа')}</div>`); return; }
  if (t.gitBranch) MR_CACHE[t.gitBranch] = { ts: Date.now(), mrs: d.mrs||[] };
  if (!d.mrs || !d.mrs.length){ box2.innerHTML = `<div class="rail-empty">— MR нет —</div>`; return; }
  box2.innerHTML = d.mrs.map(m =>
    `<div class="row-item"><span class="ri-k">merge</span>${aReal(m.web_url, '!'+m.iid+' → '+esc(m.target_branch), 'plain')}${mrPillHTML(m)}</div>`
    + (m.project ? `<div class="rail-hint">${esc(m.project)}</div>` : '')
  ).join('');
}
async function hydrateMrs(){   // фоновая подгрузка MR для карточек (клиент-кэш ~30с + серверный 30с → без спама)
  if (mrHydrating) return; mrHydrating = true;
  const now = Date.now();
  const branches = [...new Set(SESSIONS.filter(s => s.wo && s.gitBranch).map(s => s.gitBranch))].slice(0, 25);
  let changed = false;
  for (const br of branches){
    const c = MR_CACHE[br];
    if (c && now - c.ts < LIVE_TTL) continue;   // свежий клиент-кэш (в т.ч. негативный) — не дёргаем GitLab
    const s = SESSIONS.find(x => x.gitBranch === br);
    try {
      const r = await fetch('/api/mrs?branch=' + encodeURIComponent(br) + '&wo=' + encodeURIComponent((s && s.wo) || ''), { cache:'no-store' });
      const d = await r.json();
      if (d && d.available){ MR_CACHE[br] = { ts: Date.now(), mrs: d.mrs || [] }; changed = true; }
      else MR_CACHE[br] = { ts: Date.now(), mrs: [], unavailable: true };   // нет токена → кэшируем негатив на ~30с (без спама); MR_TTL_RESET снимет после ввода токена
    } catch {}
  }
  mrHydrating = false;
  if (changed && (activeView==='board' || activeView==='status')) renderBoard(false);
}
function MR_TTL_RESET(){   // сброс клиентских кэшей MR/Jira (после смены токена в Настройках → сразу перечитать)
  for (const k of Object.keys(MR_CACHE)) delete MR_CACHE[k];
  for (const k of Object.keys(JIRA_CACHE)) delete JIRA_CACHE[k];
}
/* ---------- live-статус Jira: маппинг в колонку + чип/секция ---------- */
// Маппинг Jira-статус → колонка (клиент, т.к. In Progress зависит от состояния билда). Возвращает {col, blocked}.

function jiraChipHTML(j){
  if (!j || !j.status) return '';
  const cat = j.category || '';
  return `<span class="chip jira-${esc(cat||'na')}">${esc(j.status)}</span>`;
}
async function loadJira(t){
  const box = document.getElementById('jiraBox'); if (!box || !t.wo) return;
  let d; try { const r = await fetch('/api/jira?wo=' + encodeURIComponent(t.wo), { cache:'no-store' }); d = await r.json(); } catch { return; }
  const box2 = document.getElementById('jiraBox'); if (!box2) return;
  if (!d.available){ box2.innerHTML = `<div class="rail-hint">Jira недоступна: ${esc(d.reason||'нет токена')} — стадия из локального состояния</div>`; return; }
  JIRA_CACHE[t.wo] = { ts: Date.now(), available:true, status:d.status, category:d.category, summary:d.summary };
  if (!d.status){ box2.innerHTML = `<div class="rail-empty">— статус не получен —</div>`; return; }
  box2.innerHTML = `<div class="row-item"><span class="ri-k">статус</span>${jiraChipHTML(d)}</div>` + (d.summary?`<div class="rail-hint">${esc(d.summary)}</div>`:'');
}
/* ---------- пользовательские теги сессии (add/edit/delete, Deck-side) ---------- */
function currentTags(){   // источник — кэш ЛИБО запись в списке (finish() удаляет SESSION_CACHE, теги нельзя терять)
  const t = (currentFile && SESSION_CACHE[currentFile]) || SESSIONS.find(s=>s.file===currentFile);
  return (t && Array.isArray(t.tags)) ? t.tags.slice() : [];
}
async function saveTags(next){
  if (!currentFile) return;
  const clean = [...new Set(next.map(x=>String(x).trim()).filter(Boolean))].slice(0,30);
  try {
    const r = await fetch('/api/tags', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ file: currentFile, tags: clean }) });
    const d = await r.json();
    const tags = Array.isArray(d.tags) ? d.tags : clean;
    if (SESSION_CACHE[currentFile]) SESSION_CACHE[currentFile].tags = tags;
    const se = SESSIONS.find(s=>s.file===currentFile); if (se) se.tags = tags;   // чтобы поиск/фильтр/карточка сразу видели
    renderTags();
  } catch {}
}
function renderTags(){
  const wrap = document.getElementById('tagsWrap'); if (!wrap) return;
  const tags = currentTags();
  wrap.innerHTML = tags.length ? tags.map((x,i)=>`<span class="tag-chip" data-i="${i}"><span class="tag-txt" title="переименовать">#${esc(x)}</span><button class="tag-x" type="button" title="удалить">✕</button></span>`).join('') : `<span class="rail-empty">тегов нет</span>`;
  wrap.querySelectorAll('.tag-chip').forEach(chip=>{
    const i = +chip.dataset.i;
    chip.querySelector('.tag-x').addEventListener('click', e=>{ e.stopPropagation(); const t=currentTags(); t.splice(i,1); saveTags(t); });
    chip.querySelector('.tag-txt').addEventListener('click', ()=>{ const t=currentTags(); const v=prompt('Переименовать тег:', t[i]); if (v!=null && v.trim()!==t[i]){ t[i]=v.trim(); saveTags(t); } });
  });
}
function wireTags(){
  renderTags();
  const inp = document.getElementById('tagsInput'); if (!inp) return;
  inp.addEventListener('keydown', e=>{ if (e.key==='Enter'){ e.preventDefault(); const v=inp.value.trim(); if (v){ const t=currentTags(); t.push(v); saveTags(t); inp.value=''; } } });
}
/* ---------- фоновые сабагенты открытой сессии ---------- */
function runningAgents(agents){ return (Array.isArray(agents)?agents:[]).filter(a=>a && a.running); }
function agentBoxHTML(agents){   // ТОЛЬКО активные (running); завершённые/остановленные не показываем
  const live = runningAgents(agents);
  if (!live.length) return '';
  return live.map(a=>{
    const tok = a.tokensIn ? ' · ' + kTok(a.tokensIn) : '';
    return `<div class="ag-item live"><div class="ag-head"><span class="ag-label">${esc(a.label)}</span><span class="ag-status"><span class="ag-dot run"></span>работает${tok}</span></div>${a.activity?`<div class="ag-act">${esc(a.activity)}</div>`:''}</div>`;
  }).join('');
}
function stopAgentsPoll(){ if (agentsTimer){ clearInterval(agentsTimer); agentsTimer = null; } }
async function pollAgents(file){
  if (currentFile !== file){ stopAgentsPoll(); return; }
  let d; try { d = await (await fetch('/api/agents?file=' + encodeURIComponent(file), { cache:'no-store' })).json(); } catch { return; }
  if (currentFile !== file || !d || d.error) return;
  const sec = document.getElementById('agentsSec'), box = document.getElementById('agentsBox');
  const agents = Array.isArray(d.agents) ? d.agents : [];
  const live = runningAgents(agents);
  if (sec && box){ if (live.length){ sec.hidden = false; box.innerHTML = agentBoxHTML(agents); } else { sec.hidden = true; box.innerHTML = ''; } }
  // отражаем в кэше/списке, чтобы признак «работает» на карточке/лейбле держался, пока агенты живы
  if (SESSION_CACHE[file]){ SESSION_CACHE[file].bgRunning = d.bgRunning; SESSION_CACHE[file].agents = agents; }
  const se = SESSIONS.find(s=>s.file===file); if (se){ se.bgRunning = d.bgRunning; if (d.bgRunning>0) se.working = true; }
}
function startAgentsPoll(file){ stopAgentsPoll(); agentsTimer = setInterval(()=>pollAgents(file), 4000); pollAgents(file); }
async function hydrateJira(){   // фоновая подгрузка статусов Jira для карточек (клиент-кэш 60с + серверный 30с)
  if (jiraHydrating) return; jiraHydrating = true;
  const now = Date.now();
  const wos = [...new Set(SESSIONS.filter(s => s.wo).map(s => s.wo))].slice(0, 30);
  let changed = false, gated = false;
  for (const wo of wos){
    const c = JIRA_CACHE[wo];
    if (c && now - c.ts < LIVE_TTL) continue;
    try {
      const r = await fetch('/api/jira?wo=' + encodeURIComponent(wo), { cache:'no-store' });
      const d = await r.json();
      if (!d.available){ gated = true; break; }   // нет токена — не долбим по всем wo
      JIRA_CACHE[wo] = { ts: Date.now(), available:true, status:d.status, category:d.category, summary:d.summary };
      changed = true;
    } catch {}
  }
  jiraHydrating = false;
  if (changed && (activeView==='board' || activeView==='status')) renderBoard(false);
  void gated;
}

function metaLine(m){
  if (!m) return '';
  return `<div class="cx-meta">↑ ${fmtTok(m.in)} · ↓ ${fmtTok(m.out)} · ctx ${Math.round((m.ctxPct||0)*100)}%</div>`;
}
function blockHTML(b){
  if (b.kind==='user') return `<div class="cx-msg cx-user"><div class="cx-role">Ты</div><div class="cx-md">${mdToHtml(b.text)}</div></div>`;
  if (b.kind==='assistant') {
    const full = b.text || '';
    const body = full.length > 1200
      ? `<div class="cx-md cx-short">${mdToHtml(full.slice(0,1200)+'…')}</div><div class="cx-md cx-fulltext" hidden>${mdToHtml(full)}</div><button class="cx-more" type="button">показать полностью</button>`
      : `<div class="cx-md">${mdToHtml(full)}</div>`;
    return `<div class="cx-msg cx-asst"><div class="cx-role">Claude</div>${body}${metaLine(b.meta)}</div>`;
  }
  if (b.kind==='thinking') {
    if (!b.text || !b.text.trim()) return '';   // пустое размышление (в истории thinking без текста) — не рендерим
    return `<div class="cx-msg cx-think"><button class="cx-think-h" type="button"><span class="cx-tw">▸</span>✻ Размышление</button><div class="cx-think-body cx-md" hidden>${mdToHtml(b.text)}</div>${metaLine(b.meta)}</div>`;
  }
  if (b.kind==='tool') {
    const arg = b.arg ? `<span class="cx-arg">(${esc(b.arg)})</span>` : '';
    const hasRes = !!b.result;
    const caret = `<span class="cx-tw">${hasRes ? '▸' : '·'}</span>`;
    const row = `<div class="cx-tool${hasRes?' cx-clk':''}">${caret}<span class="cx-mk">⏺</span><span class="cx-name">${esc(b.name)}</span>${arg}</div>`;
    const pre = hasRes ? `<pre class="cx-res" hidden>${esc(b.result)}</pre>` : '';
    return `<div class="cx-msg cx-twrap">${row}${pre}</div>`;
  }
  if (b.kind==='system') return `<div class="cx-msg cx-sys">${esc(b.text||'')}</div>`;         // служебное — приглушённо, не «Ты»
  if (b.kind==='command') return `<div class="cx-msg cx-cmd"><span class="cx-cmd-ico">⌘</span>${esc(b.text||'')}</div>`;   // вызов команды человеком
  return '';
}
function wireConsole(){
  const cons = document.querySelector('.cx-console');
  if (!cons) return;
  cons.addEventListener('click', e => {
    // тумблер thinking-блока
    const th = e.target.closest('.cx-think-h');
    if (th){
      const body = th.parentElement.querySelector('.cx-think-body'); if (!body) return;
      const tw = th.querySelector('.cx-tw'); const hidden = body.hasAttribute('hidden');
      if (hidden){ body.removeAttribute('hidden'); if (tw) tw.textContent='▾'; } else { body.setAttribute('hidden',''); if (tw) tw.textContent='▸'; }
      return;
    }
    // тумблер «показать полностью» ⇄ «свернуть» у длинного ответа
    const more = e.target.closest('.cx-more');
    if (more){
      const box = more.closest('.cx-asst');
      const short = box.querySelector('.cx-short'), full = box.querySelector('.cx-fulltext');
      const expanded = short.hasAttribute('hidden');
      if (expanded){ short.removeAttribute('hidden'); full.setAttribute('hidden',''); more.textContent='показать полностью'; }
      else { short.setAttribute('hidden',''); full.removeAttribute('hidden'); more.textContent='свернуть'; }
      return;
    }
    // тумблер результата tool-вызова
    const row = e.target.closest('.cx-tool.cx-clk');
    if (!row) return;
    const pre = row.parentElement.querySelector('.cx-res'); if (!pre) return;
    const hidden = pre.hasAttribute('hidden');
    if (hidden) pre.removeAttribute('hidden'); else pre.setAttribute('hidden','');
    const mk = row.querySelector('.cx-tw'); if (mk) mk.textContent = hidden ? '▾' : '▸';
  });
}

/* ---------- «/» — список скиллов в композере ---------- */
async function loadSkills(cwd){
  SESSION_SKILLS = [];
  if (!cwd){ updateSlash(); return; }
  if (SKILLS_CACHE[cwd]){ SESSION_SKILLS = SKILLS_CACHE[cwd]; updateSlash(); return; }
  try {
    const r = await fetch('/api/skills?cwd=' + encodeURIComponent(cwd), { cache:'no-store' });
    const d = await r.json();
    SESSION_SKILLS = Array.isArray(d.skills) ? d.skills : [];
    SKILLS_CACHE[cwd] = SESSION_SKILLS;
  } catch (e) { SESSION_SKILLS = []; }
  updateSlash();   // если «/» уже введён (гонка загрузки — особенно в новой сессии) — перефильтровать дропдаун
}
function slashFilter(q){
  q = q.toLowerCase();
  return SESSION_SKILLS.filter(s => !q || s.name.toLowerCase().includes(q) || (s.description||'').toLowerCase().includes(q));
}
function updateSlash(){
  const ta = document.getElementById('composer-ta');
  const box = document.getElementById('slashBox');
  if (!ta || !box) return;
  const v = ta.value;
  if (v[0] === '/' && !v.slice(1).includes(' ')) {
    slashItems = slashFilter(v.slice(1)).slice(0, 60);
    slashOpen = slashItems.length > 0;
    slashSel = 0;
    renderSlash();
  } else {
    slashOpen = false; box.hidden = true;
  }
}
function renderSlash(){
  const box = document.getElementById('slashBox');
  if (!box) return;
  if (!slashOpen){ box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = slashItems.map((s,i)=>`<div class="cx-sl-item ${i===slashSel?'sel':''}" data-i="${i}"><span class="cx-sl-name">/${esc(s.name)}</span><span class="cx-sl-src">${esc(s.source)}</span><span class="cx-sl-desc">${esc((s.description||'').slice(0,110))}</span></div>`).join('');
  box.querySelectorAll('.cx-sl-item').forEach(el=>{
    el.addEventListener('mousedown', e => { e.preventDefault(); chooseSlash(+el.dataset.i); });
    el.addEventListener('mousemove', () => { slashSel = +el.dataset.i; highlightSlash(); });
  });
}
function highlightSlash(){
  document.querySelectorAll('.cx-sl-item').forEach((el,j)=>el.classList.toggle('sel', j===slashSel));
  const s = document.querySelector('.cx-sl-item.sel'); if (s) s.scrollIntoView({ block:'nearest' });
}
function chooseSlash(i){
  const s = slashItems[i]; if (!s) return;
  const ta = document.getElementById('composer-ta'); if (!ta) return;
  ta.value = '/' + s.name + ' ';
  slashOpen = false; const box = document.getElementById('slashBox'); if (box) box.hidden = true;
  ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight,150) + 'px';
  const btn = document.getElementById('sendBtn'); if (btn) btn.disabled = !ta.value.trim();
  ta.focus();
}
function renderComposer(t){
  const c = document.getElementById('composer');
  const ICON = {
    attach:'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>',
    stop:'<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
    bolt:'<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 3 14h7l-1 8 10-12h-7z"/></svg>',
    send:'<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="m3 20 18-8L3 4v6l12 2-12 2z"/></svg>',
  };
  c.innerHTML = `
    <div class="archived-note" id="viewNote" style="max-width:820px;margin:0 auto 10px;display:none"><span></span></div>
    <div class="cx-slash" id="slashBox" hidden></div>
    <div class="composer-inner" id="composerInner">
      <div class="cx-attach" id="attachBox" hidden></div>
      <input type="file" id="attachInput" multiple hidden>
      <textarea id="composer-ta" rows="1" placeholder="Написать в сессию…  «/» — скиллы  ·  📎/вставка — файлы  ·  Enter — отправить"></textarea>
      <div class="composer-foot cx-foot">
        <div class="cx-foot-l">
          <button class="cx-ibtn" id="attachBtn" type="button" title="Прикрепить (скоро)">${ICON.attach}</button>
          <button class="cx-ibtn" id="skillBtn" type="button" title="Скиллы (/)">/</button>
          <button class="cx-ibtn cx-stop" id="stopBtn" type="button" title="Остановить">${ICON.stop}</button>
          <span class="cx-queue" id="queueInd" hidden></span>
        </div>
        <div class="cx-foot-r">
          <button class="cx-mode" id="modeBtn" type="button" title="Режим разрешений (Shift+Tab)">${ICON.bolt}<span id="modeLabel">Обычный</span></button>
          <button class="send-btn" id="sendBtn" type="button" disabled>${ICON.send}</button>
        </div>
      </div>
    </div>`;
  const ta = document.getElementById('composer-ta'), btn = document.getElementById('sendBtn');
  const grow = () => { ta.style.height='auto'; ta.style.height=Math.min(ta.scrollHeight,150)+'px'; btn.disabled = !(ta.value.trim() || attachDraft.length); };
  ta.addEventListener('input', () => { grow(); updateSlash(); });
  ta.addEventListener('keydown', e => {
    if (slashOpen) {
      if (e.key==='ArrowDown'){ e.preventDefault(); slashSel=Math.min(slashSel+1, slashItems.length-1); highlightSlash(); return; }
      if (e.key==='ArrowUp'){ e.preventDefault(); slashSel=Math.max(slashSel-1, 0); highlightSlash(); return; }
      if (e.key==='Enter'){ e.preventDefault(); chooseSlash(slashSel); return; }
      if (e.key==='Escape'){ e.preventDefault(); slashOpen=false; document.getElementById('slashBox').hidden=true; return; }
    }
    if (e.key==='Tab' && e.shiftKey) { e.preventDefault(); cycleMode(); return; }   // как в расширении — циклим режим
    if (e.key==='Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  btn.addEventListener('click', sendMessage);
  const stopBtn = document.getElementById('stopBtn');
  stopBtn.disabled = !streaming;   // состояние Стоп = чистая функция от факта живого стрима (переживает перерисовку)
  stopBtn.addEventListener('click', userStop);
  document.getElementById('skillBtn').addEventListener('click', () => { if (streaming) return; if (ta.value[0] !== '/') ta.value = '/' + ta.value; ta.focus(); updateSlash(); });
  document.getElementById('modeBtn').addEventListener('click', cycleMode);
  // P4: вложения — пикер, drag-drop, вставка скриншота
  const fileInput = document.getElementById('attachInput');
  document.getElementById('attachBtn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { if (fileInput.files && fileInput.files.length) addAttachments([...fileInput.files]); fileInput.value = ''; });
  const inner = document.getElementById('composerInner');
  inner.addEventListener('dragover', e => { e.preventDefault(); inner.classList.add('cx-drop'); });
  inner.addEventListener('dragleave', () => inner.classList.remove('cx-drop'));
  inner.addEventListener('drop', e => { e.preventDefault(); inner.classList.remove('cx-drop'); if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) addAttachments([...e.dataTransfer.files]); });
  ta.addEventListener('paste', e => {
    const items = e.clipboardData && e.clipboardData.items ? [...e.clipboardData.items] : [];
    const files = items.filter(it => it.kind === 'file').map(it => it.getAsFile()).filter(Boolean);
    if (files.length){ e.preventDefault(); addAttachments(files); }   // скриншот из буфера — главный сценарий
  });
  sessionMode = 'default'; paintMode();   // per-session: на открытии — обычный режим
  attachDraft.length = 0; renderAttachDraft();
  setTimeout(()=>ta.focus(), 60);
}

/* ---------- отправка запроса в сессию + живой стрим ответа (SSE + Agent SDK) ---------- */
function stopStream(){
  if (streamTimer){ clearInterval(streamTimer); streamTimer = null; }
  if (currentES){ try { currentES.close(); } catch {} currentES = null; }
  if (buildTimer){ clearInterval(buildTimer); buildTimer = null; }
  stopTail();
  stopAgentsPoll();
  streaming = false; liveFinish = null; streamingFile = null; currentStreamId = null;
  promptQueue.length = 0; updateQueueIndicator();        // уходя с сессии — очередь сбрасываем
  // жёсткий сброс UI стрима: убрать индикатор «работает» и снять недостроенный live-блок из чата
  document.querySelectorAll('.cx-run-chat').forEach(el => el.remove());
  document.querySelectorAll('.cx-asst.cx-live').forEach(el => el.classList.remove('cx-live'));
}
function setComposerBusy(on){
  streaming = on;
  const ta = document.getElementById('composer-ta'), send = document.getElementById('sendBtn'),
        stop = document.getElementById('stopBtn');
  if (ta) ta.disabled = false;                          // ввод НЕ блокируем — можно подкидывать промты в очередь
  if (send) send.disabled = !((ta && ta.value.trim()) || attachDraft.length);   // текст ИЛИ вложения
  if (stop) stop.disabled = !on;
}
function ensureConsole(){
  const thread = document.getElementById('thread');
  let cons = thread.querySelector('.cx-console');
  if (!cons){ thread.innerHTML = '<div class="cx-console"></div>'; cons = thread.querySelector('.cx-console'); wireConsole(); }
  return cons;
}
function scrollBottom(){ const tr = document.getElementById('transcript'); if (tr) tr.scrollTop = tr.scrollHeight; }
function isNearBottom(){ const tr = document.getElementById('transcript'); if (!tr) return true; return (tr.scrollHeight - tr.scrollTop - tr.clientHeight) < 90; }
function appendHTML(parent, html){ const t = document.createElement('div'); t.innerHTML = html.trim(); const el = t.firstElementChild; if (el) parent.appendChild(el); return el; }
function setStreamStatus(text, autoHideMs){
  const n = document.getElementById('viewNote'); if (!n) return;
  if (text){ n.style.display='flex'; n.querySelector('span').textContent = text; if (autoHideMs) setTimeout(()=>{ if (n.querySelector('span').textContent===text) n.style.display='none'; }, autoHideMs); }
  else { n.style.display='none'; }
}
/* ---------- P2: inline-карточка аппрува инструмента ---------- */
function approvalPreview(tool, input){
  input = input || {};
  if (tool==='Edit' || tool==='MultiEdit'){
    const fp = input.file_path || input.filePath || input.path || '';
    let body;
    if (tool==='MultiEdit' && Array.isArray(input.edits)){
      body = input.edits.map(e=>`<div class="ap-diff"><div class="ap-old">- ${esc(String(e.old_string||'').slice(0,600))}</div><div class="ap-new">+ ${esc(String(e.new_string||'').slice(0,600))}</div></div>`).join('');
    } else {
      body = `<div class="ap-diff"><div class="ap-old">- ${esc(String(input.old_string||'').slice(0,800))}</div><div class="ap-new">+ ${esc(String(input.new_string||'').slice(0,800))}</div></div>`;
    }
    return `<div class="ap-path">${esc(fp)}</div>${body}`;
  }
  if (tool==='Write'){
    const fp = input.file_path || input.path || '';
    const lines = String(input.content||'').split('\n');
    const shown = lines.slice(0,40).join('\n') + (lines.length>40 ? '\n…' : '');
    return `<div class="ap-path">${esc(fp)}</div><pre class="ap-code">${esc(shown)}</pre>`;
  }
  if (tool==='Bash'){
    const desc = input.description ? `<div class="ap-desc">${esc(input.description)}</div>` : '';
    return `${desc}<pre class="ap-code">${esc(String(input.command||''))}</pre>`;
  }
  return `<pre class="ap-code">${esc(JSON.stringify(input, null, 2).slice(0,1200))}</pre>`;
}
function approvalCardHTML(d){
  return `<div class="cx-msg cx-approval" data-id="${esc(d.id)}">
    <div class="ap-head"><span class="ap-icon">🔐</span>Разрешить инструмент <b>${esc(d.tool)}</b>?</div>
    <div class="ap-body">${approvalPreview(d.tool, d.input)}</div>
    <div class="ap-btns">
      <button class="ap-btn ap-allow" type="button" data-d="allow">Разрешить</button>
      <button class="ap-btn ap-always" type="button" data-d="always">Разрешить всё</button>
      <button class="ap-btn ap-deny" type="button" data-d="deny">Запретить</button>
    </div>
    <div class="ap-result" hidden></div>
  </div>`;
}
function wireApproval(el, d){
  if (!el) return;
  el.querySelectorAll('.ap-btn').forEach(b => b.addEventListener('click', async () => {
    const decision = b.dataset.d;
    el.querySelectorAll('.ap-btn').forEach(x => x.disabled = true);
    try { await fetch('/api/approve?id=' + encodeURIComponent(d.id) + '&decision=' + decision, { cache:'no-store' }); } catch {}
    const btns = el.querySelector('.ap-btns'); if (btns) btns.remove();
    const r = el.querySelector('.ap-result');
    if (r){ r.hidden = false; r.textContent = decision==='deny' ? 'запрещено ✗' : decision==='always' ? 'всегда ✓' : 'разрешено ✓'; r.classList.add(decision==='deny' ? 'ap-r-deny' : 'ap-r-allow'); }
    el.classList.add('ap-resolved');
  }));
}
function paintMode(){
  const btn = document.getElementById('modeBtn'); if (!btn) return;
  const lbl = btn.querySelector('#modeLabel'); if (lbl) lbl.textContent = MODE_LABEL[sessionMode] || 'Обычный';
  btn.classList.toggle('cx-mode-bypass', sessionMode === 'bypassPermissions');   // байпас — предупреждающе (красный)
  btn.title = 'Режим разрешений: ' + (MODE_LABEL[sessionMode] || 'Обычный') + ' (Shift+Tab)';
}
function cycleMode(){
  const i = MODE_ORDER.indexOf(sessionMode);
  sessionMode = MODE_ORDER[(i + 1) % MODE_ORDER.length];
  paintMode();
}
/* ---------- P4: вложения к промту ---------- */
const TEXT_EXT = /\.(txt|md|json|ya?ml|csv|log|cs|js|mjs|ts|tsx|jsx|html|css|py|sh|xml|sql|toml|ini|conf|cfg|gradle|kt|java|go|rs|rb|php|c|h|cpp|hpp)$/i;
function readAttachment(file){
  return new Promise((resolve, reject) => {
    const isImage = /^image\//.test(file.type);
    const isText = !isImage && (/^text\//.test(file.type) || TEXT_EXT.test(file.name) || file.type==='application/json');
    const fr = new FileReader();
    fr.onerror = () => reject(new Error('read fail: ' + file.name));
    if (isImage){
      fr.onload = () => { const s = String(fr.result); const b64 = s.slice(s.indexOf(',') + 1); resolve({ name:file.name, mediaType:file.type || 'image/png', kind:'image', dataB64:b64, preview:s }); };
      fr.readAsDataURL(file);
    } else if (isText){
      fr.onload = () => resolve({ name:file.name, mediaType:file.type || 'text/plain', kind:'text', text:String(fr.result) });
      fr.readAsText(file);
    } else {
      // прочее бинарное — вложим как base64-текстом упоминанием (Claude не «видит», но путь/имя есть)
      fr.onload = () => { const s = String(fr.result); const b64 = s.slice(s.indexOf(',') + 1); resolve({ name:file.name, mediaType:file.type || 'application/octet-stream', kind:'binary', dataB64:b64 }); };
      fr.readAsDataURL(file);
    }
  });
}
function attachBytes(a){ return a.kind==='text' ? (a.text ? a.text.length : 0) : (a.dataB64 ? Math.floor(a.dataB64.length * 3 / 4) : 0); }
async function addAttachments(files){
  for (const f of files){
    try {
      const a = await readAttachment(f);
      const total = attachDraft.reduce((s, x) => s + attachBytes(x), 0) + attachBytes(a);
      if (total > ATTACH_MAX_BYTES){ setStreamStatus('Вложения превышают лимит ~18МБ', 2200); continue; }
      attachDraft.push(a);
    } catch { setStreamStatus('Не удалось прочитать файл', 1800); }
  }
  renderAttachDraft();
}
function renderAttachDraft(){
  const box = document.getElementById('attachBox'); if (!box) return;
  if (!attachDraft.length){ box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = attachDraft.map((a, i) => {
    const thumb = a.kind==='image' && a.preview ? `<img class="at-thumb" src="${a.preview}" alt="">` : `<span class="at-ico">${a.kind==='text'?'📄':'📎'}</span>`;
    return `<span class="at-chip">${thumb}<span class="at-name">${esc(a.name)}</span><button class="at-x" type="button" data-i="${i}" title="Убрать">✕</button></span>`;
  }).join('');
  box.querySelectorAll('.at-x').forEach(b => b.addEventListener('click', () => { attachDraft.splice(+b.dataset.i, 1); renderAttachDraft(); const s=document.getElementById('sendBtn'); const ta=document.getElementById('composer-ta'); if(s&&ta) s.disabled = !(ta.value.trim()||attachDraft.length); }));
  const s = document.getElementById('sendBtn'), ta = document.getElementById('composer-ta');
  if (s && ta) s.disabled = !(ta.value.trim() || attachDraft.length);   // вложения без текста — тоже можно слать
}
function attachThumbsHTML(atts){   // мини-превью у отправленного user-блока в ленте
  if (!atts || !atts.length) return '';
  return '<div class="cx-att">' + atts.map(a =>
    a.kind==='image' && a.preview ? `<img class="cx-att-img" src="${a.preview}" alt="">` : `<span class="cx-att-file">${a.kind==='text'?'📄':'📎'} ${esc(a.name)}</span>`
  ).join('') + '</div>';
}
function updateQueueIndicator(){
  const el = document.getElementById('queueInd'); if (!el) return;
  if (promptQueue.length){ el.hidden = false; el.textContent = 'в очереди: ' + promptQueue.length; }
  else { el.hidden = true; el.textContent = ''; }
}
function clearQueue(){
  while (promptQueue.length){ const q = promptQueue.shift(); if (q.el && q.el.parentElement) q.el.remove(); }
  updateQueueIndicator();
}
function enqueuePrompt(payload){                          // отправлено во время стрима → в очередь (FIFO)
  const cons = ensureConsole();
  const el = appendHTML(cons, blockHTML({ kind:'user', text: payload.text }));
  if (el){
    if (payload.attachments && payload.attachments.length) el.insertAdjacentHTML('beforeend', attachThumbsHTML(payload.attachments));
    el.classList.add('cx-queued');
    el.insertAdjacentHTML('beforeend', '<div class="cx-queued-tag">в очереди</div>');
    const runEl = cons.querySelector('.cx-run-chat'); if (runEl) cons.insertBefore(el, runEl);
  }
  payload.el = el;
  promptQueue.push(payload);
  updateQueueIndicator();
  scrollBottom();
}
function drainQueue(){                                     // по завершении стрима — берём следующий из очереди
  if (!promptQueue.length) return;
  const next = promptQueue.shift();
  updateQueueIndicator();
  setTimeout(() => { if (currentFile) runPrompt(next); }, 60);
}
function sendMessage(){
  const ta = document.getElementById('composer-ta'); if (!ta) return;
  if (!requireAuth()) return;                             // чат требует логина в Claude
  const text = ta.value.trim();
  const attachments = attachDraft.slice();                // P4: приложенные файлы
  if ((!text && !attachments.length) || !currentFile) return;
  slashOpen = false; const box = document.getElementById('slashBox'); if (box) box.hidden = true;
  ta.value = ''; ta.style.height = 'auto';
  attachDraft.length = 0; renderAttachDraft();            // черновик вложений очищаем
  const btn = document.getElementById('sendBtn'); if (btn) btn.disabled = true;
  const payload = { text, mode: sessionMode, attachments };
  if (streaming){ enqueuePrompt(payload); return; }       // идёт стрим → в очередь
  runPrompt(payload);
}
async function runPrompt(payload){
  const text = payload.text || '', mode = payload.mode || 'default', attachments = payload.attachments || [];
  const queuedEl = payload.el;
  const cons = ensureConsole();
  if (queuedEl && queuedEl.parentElement){                // это был поставленный в очередь блок — снимаем метку
    queuedEl.classList.remove('cx-queued');
    const tag = queuedEl.querySelector('.cx-queued-tag'); if (tag) tag.remove();
  } else {
    const uEl = appendHTML(cons, blockHTML({ kind:'user', text }));   // запрос пользователя — сразу в консоль
    if (uEl && attachments.length) uEl.insertAdjacentHTML('beforeend', attachThumbsHTML(attachments));
  }
  scrollBottom();

  setComposerBusy(true);                                 // активируем СТОП (ввод НЕ блокируем — очередь разрешена)
  streamingFile = currentFile;                           // мгновенно метим сессию как «работает» (оверрайд для карточки)
  notifiedDone.delete(currentFile);                      // новый запуск — перевзвести дедуп завершения
  ensureNotifyPermission();                              // разрешение на уведомления — при первой отправке

  // индикатор процесса — В ЧАТЕ: спиннер + «Claude работает… Nс», закреплён внизу консоли,
  // существует только пока идёт ИМЕННО этот стрим (создаётся здесь, снимается в finish/stopStream).
  const runEl = appendHTML(cons, '<div class="cx-run-chat"><span class="cx-spin"></span><span class="cx-run-txt">Claude работает… 0с</span></div>');
  scrollBottom();
  const t0 = Date.now();
  streamTimer = setInterval(() => { const el = runEl.querySelector('.cx-run-txt'); if (el) el.textContent = 'Claude работает… ' + Math.round((Date.now()-t0)/1000) + 'с'; }, 1000);

  let liveMd = null, liveAccum = '';           // текущий текстовый блок ассистента (дельты text)
  let liveThink = null, liveThinkAccum = '';   // текущий блок размышления (дельты thinking)
  const addBlock = (html) => { const el = appendHTML(cons, html); if (el) cons.insertBefore(el, runEl); return el; };  // новый блок — перед индикатором
  const startNewMd = () => {
    const wrap = document.createElement('div'); wrap.className = 'cx-msg cx-asst cx-live';
    wrap.innerHTML = '<div class="cx-role">Claude</div>';
    const md = document.createElement('div'); md.className = 'cx-md';
    wrap.appendChild(md); cons.insertBefore(wrap, runEl);
    liveMd = md; liveAccum = '';
  };
  const startNewThink = () => {
    const wrap = document.createElement('div'); wrap.className = 'cx-msg cx-think cx-live';
    wrap.innerHTML = '<button class="cx-think-h" type="button"><span class="cx-tw">▾</span>✻ Размышление</button>';
    const body = document.createElement('div'); body.className = 'cx-think-body cx-md';
    wrap.appendChild(body); cons.insertBefore(wrap, runEl);
    liveThink = body; liveThinkAccum = '';
  };
  const clearLive = () => { if (liveMd && liveMd.parentElement) liveMd.parentElement.classList.remove('cx-live'); liveMd = null; };
  const finalizeThink = () => { if (liveThink && liveThink.parentElement) liveThink.parentElement.classList.remove('cx-live'); liveThink = null; };

  const isFork = !!payload.forkFile;
  const isNewRun = !!payload.newSessionCwd || isFork;   // и новая, и форк дают НОВЫЙ session_id (событие session → переключение)
  // URL потока: без вложений/новой/форка — обычный GET-query (+режим); иначе — POST-стадирование → token
  let streamUrl;
  if (attachments.length || isNewRun){
    try {
      const slim = attachments.map(a => ({ name:a.name, mediaType:a.mediaType, kind:a.kind, dataB64:a.dataB64, text:a.text }));
      const body = isFork
        ? { prompt: text, mode, fork: true, sessionFile: payload.forkFile, attachments: slim }
        : payload.newSessionCwd
        ? { prompt: text, mode, newSession: true, cwd: payload.newSessionCwd, attachments: slim }
        : { prompt: text, mode, sessionFile: currentFile, attachments: slim };
      const r = await fetch('/api/chat-prepare', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(body) });
      const d = await r.json();
      if (!r.ok || !d.token) throw new Error(d && d.error ? d.error : 'stage failed');
      streamUrl = '/api/chat?token=' + encodeURIComponent(d.token);
    } catch (e){
      appendHTML(cons, '<div class="cx-note">Ошибка запуска: ' + esc(String(e.message||e)) + '</div>');
      setComposerBusy(false); scrollBottom();
      if (streamTimer){ clearInterval(streamTimer); streamTimer = null; }
      const ridx = cons.querySelector('.cx-run-chat'); if (ridx) ridx.remove();
      streamingFile = null; drainQueue(); return;
    }
  } else {
    streamUrl = '/api/chat?file=' + encodeURIComponent(currentFile) + '&prompt=' + encodeURIComponent(text) + '&mode=' + encodeURIComponent(mode);
  }
  const es = new EventSource(streamUrl);
  currentES = es;
  let finished = false;
  const finish = (note, opts) => {
    if (finished) return; finished = true;
    if (streamTimer){ clearInterval(streamTimer); streamTimer = null; }
    try { es.close(); } catch {} currentES = null; liveFinish = null; currentStreamId = null;
    clearLive(); finalizeThink();
    runEl.remove();                      // снять индикатор «работает» из чата
    if (note) appendHTML(cons, '<div class="cx-note">' + esc(note) + '</div>');
    const doneFile = streamingFile || currentFile;
    const doneTitle = (SESSION_CACHE[currentFile] && SESSION_CACHE[currentFile].title) || titleOf(currentFile) || '';
    streamingFile = null;                // сессия больше не «работает» от Deck
    delete SESSION_CACHE[currentFile];   // транскрипт на диске обновился — перечитать при следующем заходе
    setComposerBusy(false);
    const ta2 = document.getElementById('composer-ta'); if (ta2) ta2.focus();
    scrollBottom();
    if (!(opts && opts.silent)) notifyDone(doneFile, doneTitle, 'Claude закончил');   // done/error → уведомление
    const f = doneFile;
    stopTail();
    if (isNewRun && currentFile){
      // новая сессия завершилась — .jsonl уже на диске: полноценно открываем её (рейл/сборки/tail)
      setTimeout(() => { if (currentFile === f) openSession(f); }, 700);
    } else {
      // синхронизируем курсор live-tail с диском БЕЗ перерисовки (сохраняем live-блоки, включая размышление)
      setTimeout(async () => {
        if (currentFile !== f || streaming) return;
        try { const r = await fetch('/api/session-tail?file=' + encodeURIComponent(f) + '&after=0', { cache:'no-store' }); const dd = await r.json(); if (typeof dd.count === 'number') tailCount = dd.count; if (dd.active) startTail(f); } catch {}
      }, 600);
    }
    if (opts && opts.stopped) clearQueue();          // Стоп → чистим очередь (не сыпем дальше)
    else if (opts && opts.done) drainQueue();        // штатное завершение → следующий из очереди
  };
  liveFinish = finish;                   // кнопка СТОП обрывает именно этот стрим (закрытие ES → abort на сервере)
  es.onmessage = (e) => {
    let d; try { d = JSON.parse(e.data); } catch { return; }
    const stick = isNearBottom();        // держим низ, только если пользователь уже внизу
    if (d.type === 'text'){
      finalizeThink();                   // размышление закончилось — начинается ответ
      if (!liveMd) startNewMd();
      liveAccum += d.delta;
      liveMd.innerHTML = mdToHtml(liveAccum);
      if (stick) scrollBottom();
    } else if (d.type === 'thinking'){
      const piece = d.delta || '';
      if (liveThink || piece.trim()){        // блок создаём только с первым НЕПУСТЫМ thinking_delta
        clearLive();
        if (!liveThink) startNewThink();
        liveThinkAccum += piece;
        liveThink.innerHTML = mdToHtml(liveThinkAccum);
        if (stick) scrollBottom();
      }
    } else if (d.type === 'tool'){
      clearLive(); finalizeThink();   // следующий текст пойдёт в новый блок
      addBlock('<div class="cx-msg cx-twrap"><div class="cx-tool"><span class="cx-tw">·</span><span class="cx-mk">⏺</span><span class="cx-name">' + esc(d.name) + '</span></div></div>');
      if (stick) scrollBottom();
    } else if (d.type === 'approval'){
      clearLive(); finalizeThink();   // карточка аппрува — новый элемент ленты
      const el = addBlock(approvalCardHTML(d));
      wireApproval(el, d);
      if (stick) scrollBottom();
    } else if (d.type === 'session'){   // Part 3: узнали файл новой сессии — с этого момента метим её
      currentFile = d.file; streamingFile = d.file; tailCount = 0;
      const bt = document.querySelector('#sessionBar .sb-title'); if (bt) bt.textContent = 'Новая сессия';
    } else if (d.type === 'start'){
      if (d.streamId) currentStreamId = d.streamId;   // для гарантированного /api/stop
    } else if (d.type === 'error'){
      finish('Ошибка: ' + (d.message || 'unknown'));   // ошибка стрима — очередь не двигаем
    } else if (d.type === 'done'){
      finish(d.isError ? 'Завершено с ошибкой' : null, { done:true });
    }
    // 'system' — в UI не показываем
  };
  es.onerror = () => { if (!finished) finish('Соединение прервано'); };
}
async function openSession(file){
  stopStream();   // закрыть стрим прошлой сессии, если был
  currentFile = file;
  returnView = (activeView==='status' || activeView==='board') ? activeView : 'status';
  document.getElementById('viewBoard').style.display = 'none';
  document.getElementById('viewSkills').style.display = 'none';
  document.getElementById('viewMcp').style.display = 'none';
  document.getElementById('viewSession').style.display = 'flex';
  document.querySelectorAll('.tab').forEach(x => x.setAttribute('aria-selected','false'));
  const bar = document.getElementById('sessionBar');
  const backBtn = `<button class="back" id="backBtn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M15 18 9 12l6-6"/></svg> Назад</button>`;
  bar.innerHTML = backBtn + `<span class="sb-title">Загрузка…</span>`;
  document.getElementById('backBtn').addEventListener('click', () => setView(returnView));
  document.getElementById('thread').innerHTML = `<div class="empty">Загрузка транскрипта…</div>`;
  document.getElementById('composer').innerHTML = '';
  document.getElementById('sessionSide').innerHTML = '';
  let t = SESSION_CACHE[file];
  if (!t){
    try {
      const r = await fetch('/api/session?file=' + encodeURIComponent(file), { cache:'no-store' });
      t = await r.json();
      if (t.error) throw new Error(t.error);
      SESSION_CACHE[file] = t;
    } catch (e){
      document.getElementById('thread').innerHTML = `<div class="empty">Не удалось загрузить сессию: ${esc(String(e.message||e))}</div>`;
      return;
    }
  }
  if (currentFile !== file) return;
  const woChip = t.wo ? `<span class="sb-jira">${aReal(JIRA+t.wo, 'Jira · '+t.wo, 'plain')}</span>` : '';
  bar.innerHTML = backBtn + `<span class="sb-wo">${esc(t.project)}</span><span class="sb-title">${esc(t.title)}</span>${woChip}`;
  document.getElementById('backBtn').addEventListener('click', () => setView(returnView));
  document.getElementById('sessionSide').innerHTML = sideHTML(t);
  wireTags();          // секция «Теги»: add/edit/delete
  wireSideActions(t);  // кнопки «Форкнуть» / «Удалить»
  startAgentsPoll(t.file);   // live-статус фоновых сабагентов
  renderThread(t);     // лента блоков + запуск live-tail для активной сессии
  renderComposer(t);
  loadSkills(t.cwd);   // грузим скиллы cwd один раз (для «/»)
  loadBuilds(t);       // live-статус сборок TeamCity в рейл
  loadMrs(t);          // live-MR из GitLab в рейл
  loadJira(t);         // live-статус Jira в рейл
}
/* ---------- лента блоков + live-tail активной сессии ---------- */
function renderThread(t){
  const blocks = t.blocks || [];
  document.getElementById('thread').innerHTML = blocks.length ? `<div class="cx-console">${blocks.map(blockHTML).join('')}</div>` : `<div class="empty">Сессия без текстовых сообщений.</div>`;
  wireConsole();
  tailCount = blocks.length;               // курсор live-tail = число уже показанных блоков
  scrollBottom();                          // открываем на последних сообщениях (актуальный контекст)
  requestAnimationFrame(scrollBottom);     // повтор после раскладки (шрифты/переносы могут сдвинуть высоту)
  stopTail();
  if (t.active) startTail(t.file);         // сессия свежая → тянем новые блоки вживую
}
function stopTail(){ if (tailTimer){ clearInterval(tailTimer); tailTimer = null; } const ind = document.getElementById('tailInd'); if (ind) ind.remove(); }
function startTail(file){ stopTail(); tailTimer = setInterval(() => tailTick(file), 4000); tailTick(file); }
function updateTailIndicator(on){
  const cons = document.querySelector('.cx-console'); if (!cons) return;
  let ind = document.getElementById('tailInd');
  if (on){
    if (!ind) appendHTML(cons, '<div class="cx-run-chat" id="tailInd"><span class="cx-spin"></span><span>✻ Claude работает…</span></div>');
    else cons.appendChild(ind);            // держим индикатор внизу
  } else if (ind){ ind.remove(); }
}
async function tailTick(file){
  if (currentFile !== file){ stopTail(); return; }
  if (streaming && streamingFile === file) return;   // Deck-стрим сам рендерит — не мешаем
  let d; try { const r = await fetch('/api/session-tail?file=' + encodeURIComponent(file) + '&after=' + tailCount, { cache:'no-store' }); d = await r.json(); } catch { return; }
  if (currentFile !== file || d.error) return;
  if (Array.isArray(d.blocks) && d.blocks.length){
    const cons = ensureConsole();
    const stick = isNearBottom();
    const ind = document.getElementById('tailInd');
    for (const b of d.blocks){ const el = appendHTML(cons, blockHTML(b)); if (el && ind) cons.insertBefore(el, ind); }
    if (typeof d.count === 'number') tailCount = d.count;
    if (stick) scrollBottom();
  } else if (typeof d.count === 'number') { tailCount = d.count; }
  updateTailIndicator(!!d.working);        // «работает» пока файл пишется (< 20с)
  if (!d.active) stopTail();                // сессия остыла — прекращаем tail
}

/* ---------- command palette ---------- */
function palIndex(){
  const idx = [];
  idx.push({type:'Вид', label:'Статусы', sub:'по стадии workflow', act:()=>setView('status')});
  idx.push({type:'Вид', label:'Доска сессий', sub:'по свежести', act:()=>setView('board')});
  idx.push({type:'Вид', label:'Скиллы', sub:'каталог', act:()=>setView('skills')});
  idx.push({type:'Вид', label:'MCP-инструменты', sub:'серверы', act:()=>setView('mcp')});
  SESSIONS.forEach(s=>idx.push({type:'Сессия', label:s.title, sub:s.project+(s.wo?' · '+s.wo:''), key:(s.title+' '+s.project+' '+(s.gitBranch||'')+' '+(s.lastPrompt||'')).toLowerCase(), act:()=>openSession(s.file)}));
  SKILLS.forEach(s=>idx.push({type:'Скилл', label:`/${s.cmd}`, sub:s.does||'', key:(s.cmd+' '+(s.does||'')+' '+(s.trig||'')).toLowerCase(), act:()=>{ setView('skills'); skillCat='all'; query=''; const q=document.getElementById('q'); if(q) q.value=''; renderSkills(); }}));
  MCP_SERVERS.forEach(m=>idx.push({type:'MCP', label:m.name, sub:(m.scope||'')+(m.transport?' · '+m.transport:''), key:(m.name+' '+(m.desc||'')+' '+(m.command||'')).toLowerCase(), act:()=>setView('mcp')}));
  return idx;
}
let palItems = [], palSel = 0;
const palShown = () => Math.min(palItems.length, 40);
function openPal(){ document.getElementById('palBack').classList.add('open'); const i=document.getElementById('palInput'); i.value=''; renderPal(''); setTimeout(()=>i.focus(),40); }
function closePal(){ document.getElementById('palBack').classList.remove('open'); }
function renderPal(q){
  const all = palIndex(); q = q.trim().toLowerCase();
  palItems = q ? all.filter(x=>(x.key||x.label.toLowerCase()).includes(q)) : all;
  palSel = 0;
  const list = document.getElementById('palList');
  list.innerHTML = palItems.length ? palItems.slice(0,40).map((x,i)=>`<div class="pal-item ${i===0?'sel':''}" data-i="${i}"><span class="pal-type">${x.type}</span><span class="pal-label">${esc(x.label)}</span><span class="pal-sub">${esc(x.sub||'')}</span></div>`).join('') : `<div class="pal-empty">Ничего не найдено</div>`;
  list.querySelectorAll('.pal-item').forEach(el=>{ el.addEventListener('click',()=>runPal(+el.dataset.i)); el.addEventListener('mousemove',()=>setSel(+el.dataset.i)); });
}
function setSel(i){ palSel=i; document.querySelectorAll('.pal-item').forEach((el,j)=>el.classList.toggle('sel',j===i)); const s=document.querySelector('.pal-item.sel'); if(s) s.scrollIntoView({block:'nearest'}); }
function runPal(i){ const it=palItems[i]; if(!it) return; closePal(); it.act(); }

/* ---------- view switch + events ---------- */
function setView(v){
  stopStream();   // уходя из сессии — закрыть живой стрим
  activeView = v; currentFile = null;
  const boardish = (v==='board' || v==='status');
  document.getElementById('viewBoard').style.display = boardish ? 'flex' : 'none';
  document.getElementById('viewSkills').style.display = v==='skills' ? 'flex' : 'none';
  document.getElementById('viewMcp').style.display = v==='mcp' ? 'flex' : 'none';
  document.getElementById('viewSession').style.display = 'none';
  document.getElementById('q').placeholder = 'Поиск…';   // фильтр — на доске; поиск — единый
  document.querySelectorAll('.tab').forEach(t => t.setAttribute('aria-selected', String(t.dataset.v===v)));
  if (v==='skills') renderSkills(); else if (v==='mcp') renderMcp(); else renderBoard(true);
}
document.getElementById('tabs').addEventListener('click', e => { const b = e.target.closest('.tab'); if (b) setView(b.dataset.v); });
document.getElementById('q').addEventListener('input', e => {
  query = e.target.value.trim().toLowerCase();
  renderSearchDrop();                          // дропдаун сессий — во всех видах, включая открытую сессию
  if (activeView==='skills') renderSkills(); else if (activeView==='mcp') renderMcp(); else if (activeView==='board'||activeView==='status') renderBoard();
});
document.getElementById('q').addEventListener('keydown', e => { if (e.key==='Escape'){ closeSearchDrop(); e.target.blur(); } });
document.addEventListener('mousedown', e => { if (!e.target.closest('.search')) closeSearchDrop(); });   // клик-вне закрывает
document.getElementById('filters').addEventListener('click', e => {
  const b = e.target.closest('.fchip'); if (!b) return;
  filter = b.dataset.f;
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
    else if (e.key==='ArrowDown') { e.preventDefault(); setSel(Math.min(palSel+1, palShown()-1)); }
    else if (e.key==='ArrowUp') { e.preventDefault(); setSel(Math.max(palSel-1, 0)); }
    else if (e.key==='Enter') { e.preventDefault(); runPal(palSel); }
    return;
  }
  if (e.key==='Escape' && currentFile) setView(returnView);
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
function workingSet(){ const set = new Set(); for (const s of SESSIONS) if (isWorking(s)) set.add(s.file); return set; }
function titleOf(file){ const s = SESSIONS.find(x=>x.file===file); return s ? s.title : ''; }
function paintNotifyBtn(){
  const btn = document.getElementById('notifyBtn'); if (!btn) return;
  btn.textContent = notifyEnabled ? '🔔' : '🔕';
  btn.title = notifyEnabled ? 'Уведомления о завершении включены' : 'Уведомления о завершении выключены';
  btn.setAttribute('aria-pressed', String(notifyEnabled));
}
function initNotifyToggle(){
  const btn = document.getElementById('notifyBtn'); if (!btn) return;
  const supported = 'Notification' in window;
  const nativeNotify = !!(window.deckNative && window.deckNative.notify);   // Electron: уведомления через main, разрешение браузера не нужно
  notifyEnabled = (nativeNotify || (supported && Notification.permission === 'granted')) && localStorage.getItem('deckNotify') !== 'off';
  paintNotifyBtn();
  btn.addEventListener('click', async () => {
    if (!supported){ setStreamStatus('Браузер не поддерживает уведомления', 1800); return; }
    if (!notifyEnabled){
      let perm = Notification.permission;
      if (perm !== 'granted') perm = await Notification.requestPermission();
      notifyEnabled = perm === 'granted';
      localStorage.setItem('deckNotify', notifyEnabled ? 'on' : 'off');
      if (!notifyEnabled) setStreamStatus('Разрешение на уведомления не выдано', 1800);
    } else {
      notifyEnabled = false; localStorage.setItem('deckNotify', 'off');
    }
    paintNotifyBtn();
  });
}
async function ensureNotifyPermission(){        // тихий запрос при первой отправке из композера
  if (!('Notification' in window) || Notification.permission !== 'default') return;
  const perm = await Notification.requestPermission();
  if (perm === 'granted' && localStorage.getItem('deckNotify') !== 'off') notifyEnabled = true;
  paintNotifyBtn();
}
function notifyDone(file, title, heading){       // одно уведомление на рабочий эпизод (дедуп по sessionId)
  if (notifiedDone.has(file)) return;            // и Deck-finish, и poll-переход — одно и то же завершение
  notifiedDone.add(file);
  if (!notifyEnabled) return;                    // уважаем выключатель уведомлений в приложении
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
  for (const s of SESSIONS){ if (s.wo && s.jira && s.jira.available && s.jira.status) JIRA_CACHE[s.wo] = { ts: now, available:true, status:s.jira.status, category:s.jira.category }; }
}
/* ---------- живой поллинг доски: лёгкий тик ~7с (рендер) + тяжёлый re-fetch раз в ~30с ---------- */
// Один таймер. Лёгкий тик перерисовывает доску (пульс «работает», timeAgo) СОХРАНЯЯ скролл/фильтр/поиск.
// Тяжёлый тик (раз в ~30с) перечитывает /api/sessions + гидрирует MR/Jira, чтобы влитый MR сам стал «влит».
// Открытая session-view (лента/композер/стрим) НЕ трогается — рендерим только на доске «Статусы»/«Доска».
let _lastHeavy = 0;
async function pollSessions(){
  if (polling) return; polling = true;
  const onBoard = (activeView === 'board' || activeView === 'status');
  const heavy = Date.now() - _lastHeavy >= 29000;
  try {
    if (heavy){
      _lastHeavy = Date.now();
      const r = await fetch('/api/sessions', { cache:'no-store' });
      const data = await r.json();
      if (Array.isArray(data.sessions)) SESSIONS = data.sessions;   // обновляем данные НА МЕСТЕ, приложение не пересоздаём
      seedJiraFromSessions();
      const nowSet = workingSet();
      for (const file of nowSet){ if (!prevWorkingFiles.has(file)) notifiedDone.delete(file); }   // снова «работает» → перевзвести дедуп
      for (const file of prevWorkingFiles){ if (!nowSet.has(file) && SESSIONS.some(s=>s.file===file)) notifyDone(file, titleOf(file)); }   // working→idle = завершила
      prevWorkingFiles = nowSet;
    }
  } catch { polling = false; return; }
  if (onBoard){ renderNow(); renderBoard(false); if (heavy){ hydrateMrs(); hydrateJira(); } }   // renderBoard(false) сохраняет colScroll; session-view не трогаем
  renderUsageBar();
  polling = false;
}
function startPolling(){ if (pollTimer) clearInterval(pollTimer); pollTimer = setInterval(pollSessions, 7000); }

/* ---------- аккаунт-лимиты Claude: индикатор в баре + окно usage ---------- */
let USAGE = null, usageTimer = null;
async function loadUsage(){
  try { const r = await fetch('/api/usage', { cache:'no-store' }); USAGE = await r.json(); }
  catch { USAGE = { available:false, reason:'сеть' }; }
  renderUsageBar();
}
function usageBarPct(){
  if (USAGE && USAGE.available){          // более узкое из 5ч/нед = более израсходованное
    const a = USAGE.fiveHour && USAGE.fiveHour.utilization!=null ? USAGE.fiveHour.utilization : 0;
    const b = USAGE.sevenDay && USAGE.sevenDay.utilization!=null ? USAGE.sevenDay.utilization : 0;
    return { pct: Math.max(a,b), src:'limits' };
  }
  const s = contextSession();             // фолбэк: контекст открытой/свежей сессии
  return { pct: s ? Math.round((s.ctxPct||0)*100) : 0, src:'context' };
}
function renderUsageBar(){
  const fill = document.getElementById('usageBarFill'), lbl = document.getElementById('usagePct'), ind = document.getElementById('usageInd');
  if (!fill || !lbl) return;
  const { pct, src } = usageBarPct();
  fill.style.width = Math.min(pct,100) + '%';
  fill.style.background = pct>=80?'var(--bad)':pct>=50?'var(--warn)':'var(--good)';
  lbl.textContent = pct + '%';
  if (ind) ind.title = src==='limits' ? 'Лимиты Claude (5ч/нед) — клик для деталей' : 'Контекст сессии (лимиты недоступны) — клик для деталей';
}
function fmtReset(iso){
  if (!iso) return '—';
  const d = new Date(iso); if (isNaN(+d)) return '—';
  const mins = Math.round((d - Date.now())/60000);
  if (mins <= 0) return 'скоро';
  if (mins < 60) return 'через ' + mins + ' мин';
  const h = Math.round(mins/60); if (h < 48) return 'через ' + h + ' ч';
  return d.toLocaleString('ru-RU', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' });
}
function modalBack(id){
  let back = document.getElementById(id);
  if (!back){ back = document.createElement('div'); back.id = id; back.className = 'deck-modal-back'; document.body.appendChild(back);
    back.addEventListener('click', e => { if (e.target === back) back.classList.remove('open'); }); }
  return back;
}
function openUsageModal(){
  const back = modalBack('usageBack');
  const u = USAGE || {};
  const win = (w, title) => {
    if (!w) return `<div class="um-row"><span class="um-k">${title}</span><span class="um-v">—</span></div>`;
    const p = w.utilization==null?0:w.utilization;
    return `<div class="um-win"><div class="um-row"><span class="um-k">${title}</span><span class="um-v">${p}% · сброс ${esc(fmtReset(w.resetsAt))}</span></div><div class="um-bar"><i style="width:${Math.min(p,100)}%;background:${p>=80?'var(--bad)':p>=50?'var(--warn)':'var(--good)'}"></i></div></div>`;
  };
  let body;
  if (u.available){
    const extra = u.extra ? `<div class="um-row"><span class="um-k">Доп. кредиты</span><span class="um-v">${esc(String(u.extra.usedCredits))}/${esc(String(u.extra.monthlyLimit))} ${esc(u.extra.currency||'')} · ${Math.round(u.extra.utilization||0)}%</span></div>` : '';
    body = `${win(u.fiveHour,'5-часовое окно')}${win(u.sevenDay,'Недельное окно')}${extra}<div class="um-note">Подписка: ${esc(u.subscriptionType||'—')} · источник: Claude usage (тот же логин)</div>`;
  } else {
    const top = [...SESSIONS].sort((a,b)=>(b.winTokens||0)-(a.winTokens||0)).slice(0,8);
    const rows = top.map(s=>`<div class="um-row"><span class="um-k um-ell">${esc(s.title||s.project||'—')}</span><span class="um-v">${kTok(s.winTokens)} · ${Math.round((s.ctxPct||0)*100)}%</span></div>`).join('');
    body = `<div class="um-warn">Аккаунт-лимиты недоступны из Deck: ${esc(u.reason||'нет данных')}</div><div class="um-sub">Контекст открытых сессий (то, что доступно):</div>${rows||'<div class="um-note">нет сессий</div>'}`;
  }
  back.innerHTML = `<div class="deck-modal"><div class="dm-head"><span>Использование и лимиты</span><button class="dm-x" type="button">✕</button></div><div class="dm-body">${body}</div></div>`;
  back.querySelector('.dm-x').addEventListener('click', ()=>back.classList.remove('open'));
  back.classList.add('open');
}

/* ---------- текущий контекст (для .now-лейбла и usage-фолбэка) ---------- */
function contextSession(){
  if (currentFile) return SESSION_CACHE[currentFile] || SESSIONS.find(s=>s.file===currentFile) || null;
  return SESSIONS.find(isWorking) || SESSIONS.find(s=>s.active) || SESSIONS[0] || null;
}

/* ---------- поиск-дропдаун сессий (работает во всех видах) ---------- */
function closeSearchDrop(){ const d = document.getElementById('qDrop'); if (d){ d.hidden = true; d.innerHTML = ''; } }
function renderSearchDrop(){
  const drop = document.getElementById('qDrop'), inp = document.getElementById('q'); if (!drop || !inp) return;
  const q = inp.value.trim().toLowerCase();
  if (!q){ closeSearchDrop(); return; }
  const items = SESSIONS.filter(s => searchableText(s, JIRA_CACHE, MR_CACHE, isWorking(s)).includes(q)).slice(0, 12);
  drop.hidden = false;
  if (!items.length){ drop.innerHTML = `<div class="qd-empty">Ничего не найдено</div>`; return; }
  drop.innerHTML = items.map(s => {
    const st = cardStatus(s, JIRA_CACHE);
    return `<div class="qd-item" data-file="${esc(s.file)}"><div class="qd-main"><span class="qd-title">${esc(s.title||s.project||'—')}</span><span class="qd-sub">${esc(s.project||'')}${s.wo?' · '+esc(s.wo):''}</span></div><span class="qd-badge cs-${esc(st.col)}">${esc(st.blocked?'Заблок.':st.text)}</span></div>`;
  }).join('');
  drop.querySelectorAll('.qd-item').forEach(el => el.addEventListener('mousedown', e => {
    e.preventDefault();                          // до blur, чтобы клик сработал
    const f = el.dataset.file; closeSearchDrop();
    inp.value = ''; query = '';
    openSession(f);
  }));
}

/* ---------- новая сессия ---------- */
function openNewSessionDialog(){
  if (!requireAuth()) return;                             // новая сессия требует логина в Claude
  const back = modalBack('nsBack');
  const cwds = [...new Set(SESSIONS.map(s=>s.cwd).filter(Boolean))].sort();
  const opts = cwds.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('');
  const modeOpts = MODE_ORDER.map(m=>`<option value="${m}"${m==='default'?' selected':''}>${MODE_LABEL[m]}</option>`).join('');
  back.innerHTML = `<div class="deck-modal"><div class="dm-head"><span>Новая сессия</span><button class="dm-x" type="button">✕</button></div>
    <div class="dm-body">
      <label class="ns-lbl">Рабочая папка (cwd)</label>
      <select id="nsCwd" class="ns-inp">${opts || '<option value="">нет известных папок</option>'}</select>
      <label class="ns-lbl">Первый промпт</label>
      <textarea id="nsPrompt" class="ns-inp" rows="4" placeholder="Что сделать в новой сессии…"></textarea>
      <label class="ns-lbl">Режим разрешений</label>
      <select id="nsMode" class="ns-inp">${modeOpts}</select>
      <div class="ns-actions"><button id="nsStart" class="ns-start" type="button">Создать и отправить</button></div>
    </div></div>`;
  back.querySelector('.dm-x').addEventListener('click', ()=>back.classList.remove('open'));
  back.querySelector('#nsStart').addEventListener('click', ()=>{
    const cwd = back.querySelector('#nsCwd').value;
    const prompt = back.querySelector('#nsPrompt').value.trim();
    const mode = back.querySelector('#nsMode').value;
    if (!cwd || !prompt){ back.querySelector('#nsPrompt').focus(); return; }
    back.classList.remove('open');
    openNewSession(cwd, prompt, mode);
  });
  back.classList.add('open');
  setTimeout(()=>{ const p = back.querySelector('#nsPrompt'); if (p) p.focus(); }, 60);
}
function openNewSession(cwd, prompt, mode, forkFile){
  stopStream();
  currentFile = null;
  returnView = (activeView==='status'||activeView==='board') ? activeView : 'status';
  document.getElementById('viewBoard').style.display='none';
  document.getElementById('viewSkills').style.display='none';
  document.getElementById('viewMcp').style.display='none';
  document.getElementById('viewSession').style.display='flex';
  document.querySelectorAll('.tab').forEach(x=>x.setAttribute('aria-selected','false'));
  const proj = String(cwd).split(/[\\/]/).filter(Boolean).pop() || '';
  const backBtn = `<button class="back" id="backBtn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M15 18 9 12l6-6"/></svg> Назад</button>`;
  document.getElementById('sessionBar').innerHTML = backBtn + `<span class="sb-wo">${esc(proj)}</span><span class="sb-title">${forkFile?'Форк сессии…':'Новая сессия…'}</span>`;
  document.getElementById('backBtn').addEventListener('click', ()=>setView(returnView));
  document.getElementById('sessionSide').innerHTML = '<div class="sec"><div class="rail-hint">Новая сессия создаётся…</div></div>';
  document.getElementById('thread').innerHTML = '<div class="cx-console"></div>';
  wireConsole();
  sessionMode = mode;
  renderComposer({ cwd, model:'—', ctxPct:0, wo:'', title:'Новая сессия', project: proj });
  paintMode();
  loadSkills(cwd);     // «/»-скиллы для нового cwd (перефильтрует дропдаун по готовности)
  runPrompt(forkFile ? { text: prompt, mode, attachments: [], forkFile } : { text: prompt, mode, attachments: [], newSessionCwd: cwd });
}
/* ---------- обработчики действий рейла: форк + удаление ---------- */
function wireSideActions(t){
  const del = document.getElementById('delSessionBtn');
  if (del) del.addEventListener('click', () => openDeleteDialog(t.file, t.title));
  const fork = document.getElementById('forkBtn');
  if (fork) fork.addEventListener('click', () => openForkDialog(t));
}
function toast(msg){
  let el = document.getElementById('deckToast');
  if (!el){ el = document.createElement('div'); el.id = 'deckToast'; el.className = 'deck-toast'; document.body.appendChild(el); }
  el.textContent = msg; el.classList.add('show');
  clearTimeout(el._t); el._t = setTimeout(()=>el.classList.remove('show'), 2600);
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
      SESSIONS = SESSIONS.filter(s=>s.file!==file); delete SESSION_CACHE[file];
      if (currentFile === file){ stopStream(); setView(returnView); } else renderBoard(false);
      toast('Перемещено в корзину (deck-trash)');
    } catch (e){ toast('Не удалось удалить: ' + (e.message||e)); }
  });
  back.classList.add('open');
}
function openForkDialog(t){
  const back = modalBack('forkBack');
  const modeOpts = MODE_ORDER.map(m=>`<option value="${m}"${m===sessionMode?' selected':''}>${MODE_LABEL[m]}</option>`).join('');
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
  try {
    const r = await fetch('/api/sessions', { cache:'no-store' });
    const data = await r.json();
    SESSIONS = Array.isArray(data.sessions) ? data.sessions : [];
  } catch (e) { SESSIONS = []; }
  seedJiraFromSessions();              // Jira уже в payload → колонки верны на первом рендере
  prevWorkingFiles = workingSet();     // базовая линия: на старте «завершения» не шлём
  renderFilters();
  renderNow();
  setView('status');
  startPolling();
  hydrateMrs();        // фоново подтянуть live-MR для карточек
  hydrateJira();       // фоново подтянуть live-статусы Jira
  loadSkillsCatalog(); // TECH-2: реальные скиллы (для вкладки и палитры)
  loadMcpCatalog();    // TECH-2: реальные MCP-серверы
  loadUsage();
  if (!usageTimer) usageTimer = setInterval(loadUsage, 30000);   // лимиты обновляем ~раз в 30с (сервер кэширует 45с)
}
function wireTopbar(){
  const u = document.getElementById('usageInd'); if (u) u.addEventListener('click', openUsageModal);
  const a = document.getElementById('authChip'); if (a) a.addEventListener('click', onAuthChip);
  const g = document.getElementById('authGateBtn'); if (g) g.addEventListener('click', startLogin);
  const s = document.getElementById('settingsBtn'); if (s) s.addEventListener('click', openSettingsModal);
}

/* ---------- D1: авторизация Claude из приложения ---------- */
let AUTH = { loggedIn: false };
function openExternal(url){   // системный браузер: в Electron — мост, в браузере — новая вкладка
  if (window.deckNative && window.deckNative.openExternal) window.deckNative.openExternal(url);
  else window.open(url, '_blank', 'noopener');
}
async function loadAuth(){
  try { AUTH = await (await fetch('/api/auth', { cache:'no-store' })).json(); } catch { AUTH = { loggedIn:false, reason:'сеть' }; }
  renderAuth();
}
function renderAuth(){
  const chip = document.getElementById('authChip'), gate = document.getElementById('authGate');
  if (chip){
    chip.classList.toggle('in', !!AUTH.loggedIn);
    chip.textContent = AUTH.loggedIn ? (AUTH.email || 'Claude ✓') : 'Войти в Claude';
    chip.title = AUTH.loggedIn ? ('Claude: ' + (AUTH.email||'') + (AUTH.orgName?(' · '+AUTH.orgName):'') + ' — клик для выхода') : 'Войти в Claude';
  }
  if (gate) gate.hidden = !!AUTH.loggedIn;
}
function requireAuth(){   // гейт для chat/usage/новой сессии
  if (AUTH.loggedIn) return true;
  toast('Войдите в Claude — действие недоступно без авторизации');
  startLogin();
  return false;
}
function onAuthChip(){ if (AUTH.loggedIn) confirmLogout(); else startLogin(); }
async function confirmLogout(){
  const back = modalBack('logoutBack');
  back.innerHTML = `<div class="deck-modal"><div class="dm-head"><span>Выйти из Claude?</span><button class="dm-x" type="button">✕</button></div>
    <div class="dm-body"><div class="dm-text">${esc(AUTH.email||'')}</div><div class="um-note">После выхода чат/лимиты/новые сессии станут недоступны, пока не войдёте снова.</div>
    <div class="ns-actions"><button class="btn-ghost dm-cancel" type="button">Отмена</button><button class="ns-start dm-danger" type="button">Выйти</button></div></div></div>`;
  back.querySelector('.dm-x').addEventListener('click', ()=>back.classList.remove('open'));
  back.querySelector('.dm-cancel').addEventListener('click', ()=>back.classList.remove('open'));
  back.querySelector('.dm-danger').addEventListener('click', async ()=>{ back.classList.remove('open'); try { await fetch('/api/auth/logout', { method:'POST' }); } catch {} await loadAuth(); toast('Вы вышли из Claude'); });
  back.classList.add('open');
}
let loginInProgress = false;   // single-flight на клиенте: повторный клик во время активного логина не запускает второй вход
async function startLogin(){
  if (loginInProgress) return;   // логин уже идёт — не плодим второй процесс/окно браузера
  loginInProgress = true;
  const back = modalBack('loginBack');
  back.innerHTML = `<div class="deck-modal"><div class="dm-head"><span>Вход в Claude</span><button class="dm-x" type="button">✕</button></div>
    <div class="dm-body">
      <div class="um-note" id="loginStep">Открываю браузер для входа в Claude…</div>
      <a class="btn-ghost" id="loginOpen" href="#" style="display:none;margin:8px 0">Открыть страницу входа вручную</a>
      <label class="ns-lbl">Код авторизации (со страницы Claude)</label>
      <input id="loginCode" class="ns-inp" type="text" placeholder="вставь код и нажми Подтвердить" autocomplete="off">
      <div class="ns-actions"><button class="btn-ghost dm-cancel" type="button">Отмена</button><button class="ns-start" id="loginSubmit" type="button" disabled>Подтвердить</button></div>
    </div></div>`;
  const close = ()=>{ back.classList.remove('open'); loginInProgress = false; if (loginId) fetch('/api/auth/cancel?id='+encodeURIComponent(loginId)).catch(()=>{}); };
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
    if (!loginInProgress || !back.classList.contains('open')) return;   // модалку закрыли/отменили — стоп
    await loadAuth();                                                    // обновляет AUTH + renderAuth: чип зелёный, красная плашка #authGate гаснет
    if (AUTH.loggedIn){ back.classList.remove('open'); loginInProgress = false; toast('Вход выполнен: ' + (AUTH.email || '')); return; }
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
      if (r.ok){ back.classList.remove('open'); loginInProgress = false; await loadAuth(); toast('Вход выполнен: ' + (AUTH.email||'')); }
      else { back.querySelector('#loginStep').textContent = 'Код не принят — попробуй ещё раз.'; submit.disabled = false; submit.textContent = 'Подтвердить'; }
    } catch { submit.disabled = false; submit.textContent = 'Подтвердить'; }
  });
}

/* ---------- D3: обновления (только в Electron) — версия + PAT + проверка ---------- */
let UPDATE_STATUS_EL = null;
function renderUpdateStatus(s){
  if (!UPDATE_STATUS_EL || !s) return;
  const m = {
    checking:'Проверяю обновления…', 'not-available':'У вас последняя версия.',
    available:'Доступна версия '+(s.version||'')+' — загружаю…',
    downloading:'Загрузка… '+(s.percent||0)+'%',
    downloaded:'Обновление '+(s.version||'')+' загружено — установится при перезапуске.',
    error:'Ошибка обновления: '+(s.message||''), 'no-token':'Добавьте токен для автообновления.', dev:'Обновления доступны только в установленном приложении.',
  };
  UPDATE_STATUS_EL.textContent = m[s.state] || s.state || '';
}
async function openUpdatesModal(){
  if (!(window.deckNative && window.deckNative.updateInfo)) return;   // только в Electron
  const info = await window.deckNative.updateInfo();
  const back = modalBack('updatesBack');
  back.innerHTML = `<div class="deck-modal"><div class="dm-head"><span>Обновления</span><button class="dm-x" type="button">✕</button></div>
    <div class="dm-body">
      <div class="dm-text">Текущая версия: <b>${esc(info.version||'?')}</b></div>
      <div class="um-note">Автообновление из приватного GitHub-репозитория. Нужен персональный токен GitHub (PAT) со scope <b>repo</b> (чтение релизов). Токен хранится локально в зашифрованном виде (хранилище ОС) и не покидает машину.</div>
      <label class="ns-lbl">GitHub Personal Access Token</label>
      <input id="updTok" class="ns-inp" type="password" placeholder="${info.hasToken?'токен сохранён — вставьте новый, чтобы заменить':'ghp_… / github_pat_…'}" autocomplete="off">
      <div class="ns-actions" style="justify-content:space-between">
        <div>${info.hasToken?'<button class="btn-ghost" id="updClear" type="button">Удалить токен</button>':''}</div>
        <div><button class="btn-ghost" id="updSave" type="button">Сохранить</button><button class="ns-start" id="updCheck" type="button">Проверить обновления</button></div>
      </div>
      <div class="um-note" id="updStatus" style="margin-top:8px"></div>
      ${info.encryptionAvailable?'':'<div class="um-note" style="color:#e79">Безопасное хранилище ОС недоступно — токен сохранить нельзя.</div>'}
      ${info.packaged?'':'<div class="um-note">Проверка обновлений работает только в установленном приложении (не в dev-режиме).</div>'}
    </div></div>`;
  back.querySelector('.dm-x').addEventListener('click', ()=>{ back.classList.remove('open'); UPDATE_STATUS_EL=null; });
  back.classList.add('open');
  const tok = back.querySelector('#updTok'); UPDATE_STATUS_EL = back.querySelector('#updStatus');
  back.querySelector('#updSave').addEventListener('click', async ()=>{
    const r = await window.deckNative.setUpdateToken(tok.value.trim());
    UPDATE_STATUS_EL.textContent = r.ok ? (r.cleared?'Токен удалён.':'Токен сохранён.') : ('Ошибка: '+(r.error||'')); tok.value='';
  });
  const clr = back.querySelector('#updClear');
  if (clr) clr.addEventListener('click', async ()=>{ await window.deckNative.setUpdateToken(''); UPDATE_STATUS_EL.textContent='Токен удалён.'; });
  back.querySelector('#updCheck').addEventListener('click', async ()=>{
    UPDATE_STATUS_EL.textContent='Проверяю…';
    const r = await window.deckNative.checkForUpdates();
    if (!r.ok) renderUpdateStatus({ state: r.reason==='no-token'?'no-token' : r.reason==='dev'?'dev' : 'error', message: r.reason });
  });
}

/* ---------- TECH-6: экран настроек (папки + Jira). Токен наружу не отдаётся, только флаг «задан». ---------- */
async function openSettingsModal(){
  let cfg = {}; try { cfg = await (await fetch('/api/config', { cache:'no-store' })).json(); } catch {}
  const jira = cfg.jira || {}, tc = cfg.teamcity || {}, gl = cfg.gitlab || {}, unity = cfg.unity || {};
  const tokHint = cfg.electron ? '<div class="um-note">Токены хранятся локально в зашифрованном виде (хранилище ОС).</div>'
    : '<div class="um-note" style="color:#e79">Standalone: токены безопасно сохранить нельзя — задайте их в .env (JIRA_TOKEN / TEAMCITY_TOKEN / GITLAB_TOKEN) рядом с server.mjs. Хосты и Jira email сохранятся.</div>';
  const back = modalBack('settingsBack');
  back.innerHTML = `<div class="deck-modal"><div class="dm-head"><span>Настройки</span><button class="dm-x" type="button">✕</button></div>
    <div class="dm-body">
      <div class="ns-actions" style="justify-content:flex-start;margin-bottom:4px"><button class="btn-ghost" id="setImport" type="button" title="Автоимпорт из .env / ~/.claude.json / MCP-конфигов">⤵ Подтянуть токены</button></div>
      <div class="um-note" id="setImportRes" style="margin:0 0 8px"></div>
      <label class="ns-lbl">Папка состояний dev-workflow (WO_STATES_DIR)</label>
      <input id="setWo" class="ns-inp" type="text" placeholder="пусто → колонка «Статусы» мягко деградирует" value="${esc(cfg.woStatesDir||'')}">
      <label class="ns-lbl">Папка сессий Claude (CLAUDE_PROJECTS_DIR)</label>
      <input id="setProj" class="ns-inp" type="text" placeholder="${esc((cfg.defaults&&cfg.defaults.claudeProjectsDir)||'~/.claude/projects')}" value="${esc(cfg.claudeProjectsDir||'')}">
      <div class="um-note" style="margin-top:12px">Jira — колонка «Статусы» и живые статусы задач.</div>
      <label class="ns-lbl">Jira host</label>
      <input id="setJh" class="ns-inp" type="text" placeholder="your-org.atlassian.net" value="${esc(jira.host||'')}">
      <label class="ns-lbl">Jira email</label>
      <input id="setJe" class="ns-inp" type="text" placeholder="you@example.com" value="${esc(jira.email||'')}">
      <label class="ns-lbl">Jira API token${jira.tokenSet?' — задан':''}</label>
      <input id="setJt" class="ns-inp" type="password" placeholder="${jira.tokenSet?'сохранён — вставьте новый, чтобы заменить':'вставьте API-токен'}" autocomplete="off">
      <div class="um-note" style="margin-top:12px">TeamCity — рейл «Сборки» (статус Android/iOS-билдов).</div>
      <label class="ns-lbl">TeamCity host</label>
      <input id="setTh" class="ns-inp" type="text" placeholder="${esc((cfg.defaults&&cfg.defaults.teamcityHost)||'https://…')}" value="${esc(tc.host||'')}">
      <label class="ns-lbl">TeamCity token${tc.tokenSet?' — задан':''}</label>
      <input id="setTt" class="ns-inp" type="password" placeholder="${tc.tokenSet?'сохранён — вставьте новый, чтобы заменить':'вставьте bearer-токен'}" autocomplete="off">
      <div class="um-note" style="margin-top:12px">GitLab — секция «Merge Requests» (живые MR по ветке).</div>
      <label class="ns-lbl">GitLab host</label>
      <input id="setGh" class="ns-inp" type="text" placeholder="${esc((cfg.defaults&&cfg.defaults.gitlabHost)||'https://…')}" value="${esc(gl.host||'')}">
      <label class="ns-lbl">GitLab token${gl.tokenSet?' — задан':''}</label>
      <input id="setGt" class="ns-inp" type="password" placeholder="${gl.tokenSet?'сохранён — вставьте новый, чтобы заменить':'вставьте private-токен'}" autocomplete="off">
      <div class="um-note" style="margin-top:12px">Unity — запуск инстанса по клику на cu-тег карточки (только в приложении).</div>
      <label class="ns-lbl">Папка client-unity копий (родительская)</label>
      <input id="setCup" class="ns-inp" type="text" placeholder="напр. D:/wo — тогда cu2 → D:/wo/client-unity-2 (если не выводится из cwd)" value="${esc(unity.clientUnityParent||'')}">
      <label class="ns-lbl">Путь к редакторам Unity / Unity Hub Editor dir (опц.)</label>
      <input id="setUed" class="ns-inp" type="text" placeholder="дефолт C:\\Program Files\\Unity\\Hub\\Editor" value="${esc(unity.editorsDir||'')}">
      <label class="ns-lbl">Путь к Unity Hub (опц., фолбэк)</label>
      <input id="setUhub" class="ns-inp" type="text" placeholder="дефолт C:\\Program Files\\Unity Hub\\Unity Hub.exe" value="${esc(unity.hubPath||'')}">
      ${tokHint}
      <div class="ns-actions"><button class="btn-ghost dm-cancel" type="button">Отмена</button><button class="ns-start" id="setSave" type="button">Сохранить</button></div>
      <div class="um-note" id="setStatus" style="margin-top:8px"></div>
    </div></div>`;
  const close = ()=>back.classList.remove('open');
  back.querySelector('.dm-x').addEventListener('click', close);
  back.querySelector('.dm-cancel').addEventListener('click', close);
  back.classList.add('open');
  const status = back.querySelector('#setStatus');
  // «Подтянуть токены» — автоимпорт из существующих секретов (.env / ~/.claude.json / MCP-конфиги).
  back.querySelector('#setImport').addEventListener('click', async ()=>{
    const box = back.querySelector('#setImportRes'); box.textContent = 'Ищу секреты…';
    let r; try { r = await (await fetch('/api/config/import-tokens', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' })).json(); } catch { box.textContent = 'Ошибка импорта.'; return; }
    const res = r.result || {};
    const mark = (s)=> s==='imported'?'✓': s==='kept'?'≈ уже был': s==='standalone'?'⚠ .env (не сохранён без Electron)': '✗ не найдено';
    const groups = [['Jira','jiraToken'],['TeamCity','teamcityToken'],['GitLab','gitlabToken'],['WO_STATES_DIR','woStatesDir'],['Папка сессий','claudeProjectsDir']];
    const any = Object.values(res).some(s=>s==='imported');
    const lines = groups.filter(([,k])=>k in res).map(([lbl,k])=>lbl+': '+mark(res[k]));
    box.innerHTML = (any ? 'Импортировано → ' : 'Ничего нового не импортировано → ') + esc(lines.join(' · '));
    if (!any && groups.every(([,k])=> res[k]==='notfound')) box.textContent = 'Источников с токенами не найдено — введи вручную.';
    toast(any ? 'Токены подтянуты' : 'Импорт: нового не найдено');
    // обновить флаги «задан» на полях по свежему конфигу
    const c = r.config || {};
    const setPh = (id, on, label)=>{ const el = back.querySelector(id); if (el && on){ el.placeholder = 'сохранён — вставьте новый, чтобы заменить'; } };
    setPh('#setJt', c.jira && c.jira.tokenSet); setPh('#setTt', c.teamcity && c.teamcity.tokenSet); setPh('#setGt', c.gitlab && c.gitlab.tokenSet);
    if (c.woStatesDir) back.querySelector('#setWo').value = c.woStatesDir;
    if (c.jira){ if (c.jira.host) back.querySelector('#setJh').value = c.jira.host; if (c.jira.email) back.querySelector('#setJe').value = c.jira.email; }
    if (c.teamcity && c.teamcity.host) back.querySelector('#setTh').value = c.teamcity.host;
    if (c.gitlab && c.gitlab.host) back.querySelector('#setGh').value = c.gitlab.host;
    if (typeof pollSessions === 'function') await pollSessions();   // подтянулся WO_STATES_DIR/Jira → доска получит стадии
    if (typeof loadUsage === 'function') loadUsage();
  });
  back.querySelector('#setSave').addEventListener('click', async ()=>{
    status.textContent = 'Сохраняю…';
    const payload = {
      woStatesDir: back.querySelector('#setWo').value.trim(),
      claudeProjectsDir: back.querySelector('#setProj').value.trim(),
      jiraHost: back.querySelector('#setJh').value.trim(),
      jiraEmail: back.querySelector('#setJe').value.trim(),
      teamcityHost: back.querySelector('#setTh').value.trim(),
      gitlabHost: back.querySelector('#setGh').value.trim(),
      clientUnityParent: back.querySelector('#setCup').value.trim(),
      unityEditorsDir: back.querySelector('#setUed').value.trim(),
      unityHubPath: back.querySelector('#setUhub').value.trim(),
    };
    const jt = back.querySelector('#setJt').value; if (jt) payload.jiraToken = jt;
    const tt = back.querySelector('#setTt').value; if (tt) payload.teamcityToken = tt;
    const gt = back.querySelector('#setGt').value; if (gt) payload.gitlabToken = gt;
    let r; try { r = await (await fetch('/api/config', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) })).json(); } catch { status.textContent = 'Ошибка сохранения.'; return; }
    const standalone = r.tokenResult && Object.values(r.tokenResult).some(x => x && x.ok === false && x.standalone);
    let msg = 'Сохранено.' + (standalone ? ' Токены не сохранены (standalone) — используйте .env.' : '');
    status.textContent = msg + ' Обновляю доску…';
    MR_TTL_RESET();   // сбросить клиентские кэши MR/Jira, чтобы сборки/MR перечитались с новым токеном
    if (typeof pollSessions === 'function') await pollSessions();
    if (typeof loadUsage === 'function') loadUsage();
    setTimeout(close, 900);
  });
}


ensureStatusTab();
initNotifyToggle();
wireTopbar();
loadAuth();
// Electron: клик по нативному уведомлению приходит сюда мостом → открываем сессию.
if (window.deckNative && window.deckNative.onOpenSession) window.deckNative.onOpenSession((file)=>{ if (file) openSession(file); });
// Electron: открыть окно «Обновления» из меню/трея + принимать статусы автоапдейтера.
if (window.deckNative && window.deckNative.onOpenUpdates) window.deckNative.onOpenUpdates(openUpdatesModal);
// Electron: Ctrl/Cmd+K через нативный аксельратор меню (физическое сочетание может не дойти до document-listener).
if (window.deckNative && window.deckNative.onOpenPalette) window.deckNative.onOpenPalette(() => openPal());
if (window.deckNative && window.deckNative.onUpdateStatus) window.deckNative.onUpdateStatus(renderUpdateStatus);
load();

