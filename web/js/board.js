// Deck — вид «Доска»: карточки сессий (cardHTML), колонки/фильтры и лейбл «текущий контекст».
// Вынесено из app.js; состояние — в store (S). Чистую доска-логику (колонки, searchableText) даёт columns.js.
// Клик по карточке → openSession (session.js), по cu-тегу → launchUnity (unity.js), по тегу задачи → openWoJira (ui.js).
// Циклы board↔dialogs, board↔session и board↔usage безопасны — импортированные вызовы срабатывают в рантайме.
import { S, JIRA_CACHE, MR_CACHE, COLUMNS } from './store.js';
import { esc, ctxColor, pctOf, timeAgo } from './util.js';
import { searchableText, effectiveColumn, cardStatus, WF_COLUMNS, WF_LABEL } from './columns.js';
import { openWoJira } from './ui.js';
import { launchUnity } from './unity.js';
import { contextSession } from './usage.js';
import { openNewSessionDialog } from './dialogs.js';
import { openSession } from './session.js';

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
  // тег задачи — в правый верхний угол карточки, кликабельный (→ Jira); из общего ряда чипов убран
  const woTag = s.wo ? `<span class="card-wo" data-wo="${esc(s.wo)}" title="Открыть ${esc(s.wo)} в Jira">${esc(s.wo)}<span class="ext">↗</span></span>` : '';
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
  });
  board.querySelectorAll('.sc-cu-run').forEach(el=>{
    el.addEventListener('click', e=>{ e.stopPropagation(); launchUnity(el.dataset.cu, el.dataset.cwd); });   // тап по cu-тегу → Unity, НЕ открывать карточку
  });
  board.querySelectorAll('.card-wo').forEach(el=>{
    el.addEventListener('click', e=>{ e.stopPropagation(); openWoJira(el.dataset.wo); });   // тап по тегу задачи → Jira, НЕ открывать карточку
  });
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
