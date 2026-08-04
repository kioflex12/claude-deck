// Deck — вид «Доска»: карточки сессий (cardHTML), колонки/фильтры и лейбл «текущий контекст».
// Вынесено из app.js; состояние — в store (S). Чистую доска-логику (колонки, searchableText) даёт columns.js.
// Клик по карточке → openSession (session.js), по cu-тегу → launchUnity (unity.js), по тегу задачи → openWoJira (ui.js).
// Циклы board↔dialogs, board↔session и board↔usage безопасны — импортированные вызовы срабатывают в рантайме.
import { S, JIRA_CACHE, MR_CACHE, SESSION_CACHE, COLUMNS } from './store.js';
import { esc, ctxColor, pctOf, timeAgo } from './util.js';
import { searchableText, effectiveColumn, cardStatus, WF_COLUMNS, WF_LABEL, mrKey } from './columns.js';
import { openWoJira, toast } from './ui.js';
import { launchUnity } from './unity.js';
import { contextSession } from './usage.js';
import { openNewSessionDialog, openRenameDialog, openDeleteDialog, openForkDialog, openQuickJiraDialog, openCreateMrDialog, openDeployDialog } from './dialogs.js';
import { openSession } from './session.js';
import { isBaseBranch } from './app.js';

export function boardMatch(s){
  if (S.projFilter!=='all' && s.project!==S.projFilter) return false;
  if (S.query && !searchableText(s, JIRA_CACHE, MR_CACHE, isWorking(s)).includes(S.query)) return false;
  return true;
}

function ctxMini(s){
  const p = pctOf(s);
  return `<span class="mini-ctx"><span class="mini-bar"><i style="width:${p}%;background:${ctxColor(s.ctxPct)}"></i></span>${p}%</span>`;
}

export function isWorking(s){ return !!s && (s.working === true || (s.bgRunning|0) > 0 || (!!S.streamingFile && s.file === S.streamingFile)); }

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

export function cardHTML(s){
  const wf = S.activeView === 'status';
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
    scopeChipsHTML(s),
    tagsChipsHTML(s),
    wfChips,
  ].join('');
  // тег задачи — в правый верхний угол, кликабельный (→ Jira); цвет привязан к статусу (та же палитра, что точки колонок)
  const woColor = (WF_COLUMNS.find(c => c.key === st.col) || {}).dot || 'var(--accent)';
  const woTag = s.wo ? `<span class="card-wo" data-wo="${esc(s.wo)}" title="Открыть ${esc(s.wo)} в Jira · ${esc(WF_LABEL[st.col] || '')}" style="--wo-c:${woColor}">${esc(s.wo)}<span class="ext">↗</span></span>` : '';
  const bg = (s.bgRunning|0) > 0 ? ` · ${s.bgRunning} ${s.bgRunning===1?'агент':'агента'} в фоне` : '';
  const flag = working
    ? `<div class="flag working"><span class="dot"></span>работает${bg}</div>`
    : s.active ? `<div class="flag attention"><span class="dot"></span>активна · ${timeAgo(s.mtime)}</div>` : '';
  const buildPill = s.buildActive
    ? `<span class="pill"><span class="d run"></span>билд</span>` : '';
  // MR — приоритет live-данным из GitLab (MR_CACHE), stale wfMrUrl лишь как фолбэк пока live не загрузилось
  const mk = mrKey(s); const live = MR_CACHE[mk] ? MR_CACHE[mk].mrs : null;
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
  return `<article ${stripe} tabindex="0" role="button" data-file="${esc(s.file)}">${statusBar}<div class="card-top">${pulse}<span class="wo">${esc(s.project)}</span>${woTag}</div><h3 class="card-title">${esc(s.title)}</h3><div class="chips">${chips}</div>${flag}${foot}</article>`;
}

export function renderBoard(animate){
  const board = document.getElementById('board');
  const workflow = S.activeView==='status';
  const cols = workflow ? WF_COLUMNS : COLUMNS;
  const keyOf = s => workflow ? effectiveColumn(s, JIRA_CACHE).col : s.column;   // 7-колоночная логика — единый резолв
  // поллинг перерисовывает без анимации и с сохранением прокрутки — чтобы доска не «дёргалась»
  const sx = board.scrollLeft;
  const colScroll = [...board.querySelectorAll('.col-body')].map(el=>el.scrollTop);
  board.innerHTML = cols.map(c=>{
    const items = S.SESSIONS.filter(s=>keyOf(s)===c.key && boardMatch(s));
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
    el.addEventListener('contextmenu',e=>{ e.preventDefault(); openCardMenu(e, el.dataset.file); });
  });
  board.querySelectorAll('.sc-cu-run').forEach(el=>{
    el.addEventListener('click', e=>{ e.stopPropagation(); launchUnity(el.dataset.cu, el.dataset.cwd); });   // тап по cu-тегу → Unity, НЕ открывать карточку
  });
  board.querySelectorAll('.card-wo').forEach(el=>{
    el.addEventListener('click', e=>{ e.stopPropagation(); openWoJira(el.dataset.wo); });   // тап по тегу задачи → Jira, НЕ открывать карточку
  });
}

let _cardMenu = null;   // одно открытое контекстное меню за раз: { el, cleanup }
function closeCardMenu(){
  if (!_cardMenu) return;
  const m = _cardMenu; _cardMenu = null;
  m.cleanup(); m.el.remove();
}
export function openCardMenu(e, file){
  closeCardMenu();
  const s = S.SESSIONS.find(x=>x.file===file);
  const items = [{ label:'Открыть', act:()=>openSession(file) }];
  if (s && s.cwd) items.push({ label:'Форкнуть', act:()=>openForkDialog(s) });
  if (s && s.wo) items.push({ label:'Отчёт в Jira', act:()=>openQuickJiraDialog(s) });
  if (s && s.gitBranch && !isBaseBranch(s.gitBranch)){
    items.push({ label:'Создать MR', act:()=>openCreateMrDialog(s) });
    items.push({ label:'Деплой (сборка)', act:()=>openDeployDialog(s) });
  }
  items.push({ label:'Изменить имя', act:()=>openRenameDialog(file) });
  items.push({ label:'Обновить',     act:()=>refreshCard(file) });
  items.push({ label:'Удалить',      danger:true, act:()=>openDeleteDialog(file, s && s.title) });
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.innerHTML = items.map((it,i)=>`<button type="button" data-i="${i}"${it.danger?' class="danger"':''}>${esc(it.label)}</button>`).join('');
  document.body.appendChild(menu);
  // держим меню в пределах экрана — у правого/нижнего края сдвигаем внутрь
  const vw = window.innerWidth || 1920, vh = window.innerHeight || 1080;
  const mw = menu.offsetWidth || 190, mh = menu.offsetHeight || 170;
  menu.style.left = Math.max(6, Math.min(e.clientX, vw - mw - 6)) + 'px';
  menu.style.top  = Math.max(6, Math.min(e.clientY, vh - mh - 6)) + 'px';
  menu.querySelectorAll('button').forEach(b=>{
    b.addEventListener('click', ()=>{ const it = items[+b.dataset.i]; closeCardMenu(); it.act(); });
  });
  const onDown = ev => { if (!menu.contains(ev.target)) closeCardMenu(); };
  const onKey  = ev => { if (ev.key === 'Escape') closeCardMenu(); };
  const onScroll = () => closeCardMenu();
  // scroll не всплывает — вешаем в фазе перехвата, чтобы ловить прокрутку любой колонки; contextmenu в перехвате гасит меню до открытия нового
  const wire = add => {
    document[add]('mousedown', onDown, true);
    document[add]('contextmenu', onDown, true);
    document[add]('scroll', onScroll, true);
    document[add]('keydown', onKey, true);
  };
  setTimeout(()=>wire('addEventListener'), 0);   // не ловим текущий contextmenu-евент, что открыл меню
  _cardMenu = { el: menu, cleanup: ()=>wire('removeEventListener') };
}
export async function refreshCard(file){
  const s = S.SESSIONS.find(x=>x.file===file);
  delete SESSION_CACHE[file];   // транскрипт перечитается при следующем открытии — на колонку не влияет
  // Рефрешим live-данные ИМЕННО этой карточки в кэше НА МЕСТЕ. НЕ удаляем записи Jira/MR до ре-фетча: колонка
  // «Заблокировано» (и др. Jira-колонки) вычисляется из JIRA_CACHE[wo] — удалив его, карточка мгновенно выпадала
  // из своей колонки и «исчезала» до асинхронного re-hydrate (а тот ещё и no-op, если общий цикл уже идёт).
  if (s){
    const tasks = [];
    if (s.wo) tasks.push(fetch('/api/jira?wo=' + encodeURIComponent(s.wo) + '&refresh=1', { cache:'no-store' }).then(r=>r.json())
      .then(d=>{ if (d && d.available && d.status) JIRA_CACHE[s.wo] = { ts: Date.now(), available:true, status:d.status, category:d.category, summary:d.summary }; }).catch(()=>{}));
    if (s.gitBranch) tasks.push(fetch('/api/mrs?branch=' + encodeURIComponent(s.gitBranch) + '&wo=' + encodeURIComponent(s.wo||'') + '&refresh=1', { cache:'no-store' }).then(r=>r.json())
      .then(d=>{ if (d && d.available) MR_CACHE[mrKey(s)] = { ts: Date.now(), mrs: d.mrs || [] }; }).catch(()=>{}));
    await Promise.all(tasks);
  }
  renderBoard(false);
  toast('Обновлено');
}

export function renderNow(){
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

export function renderFilters(){
  const projects = [...new Set(S.SESSIONS.map(s=>s.project).filter(Boolean))].sort();
  document.getElementById('filters').innerHTML =
    `<button class="fchip" data-f="all" aria-pressed="${S.projFilter==='all'}">Все</button>` +
    projects.map(p=>`<button class="fchip" data-f="${esc(p)}" aria-pressed="${S.projFilter===p}">${esc(p)}</button>`).join('');
}
