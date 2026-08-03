// Deck — интеграции доски: живой статус сборок (TeamCity), MR (GitLab), Jira-статусы,
// пользовательские теги сессии и поллинг фоновых сабагентов. Вынесено из app.js; состояние — в store (S).
// hydrateMrs/hydrateJira зовут renderBoard (board.js) после гидрации; aReal/isBaseBranch — общие хелперы из app.js.
// Циклы app↔services и services↔board безопасны — импортированные вызовы срабатывают в рантайме.
import { S, MR_CACHE, JIRA_CACHE, SESSION_CACHE, LIVE_TTL } from './store.js';
import { esc, kTok } from './util.js';
import { aReal, isBaseBranch } from './app.js';
import { renderBoard } from './board.js';
import { mrKey } from './columns.js';

function buildDot(b){
  const state = String(b.state||'').toLowerCase(), status = String(b.status||'').toUpperCase();
  if (state==='queued')  return { cls:'run',  label:'в очереди', run:true };
  if (state==='running') return { cls:'run',  label:'идёт',      run:true };
  if (status==='SUCCESS') return { cls:'pass', label:'успех' };
  if (status==='FAILURE'||status==='ERROR') return { cls:'fail', label:'упал' };
  return { cls:'none', label: status || state || '—' };
}

export async function loadBuilds(t){
  if (S.buildTimer){ clearInterval(S.buildTimer); S.buildTimer = null; }
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
  if (running && !S.buildTimer){
    S.buildTimer = setInterval(async () => { const r = await render(); if (!r && S.buildTimer){ clearInterval(S.buildTimer); S.buildTimer = null; } }, 15000);
  }
}

function mrPillHTML(m){
  const cls = m.state==='merged' ? 'mr-merged' : m.state==='closed' ? 'mr-closed' : 'mr-open';
  const lbl = m.state==='merged' ? 'влит' : m.state==='closed' ? 'закрыт' : 'открыт';
  const dot = m.state==='merged' ? 'pass' : m.state==='closed' ? 'fail' : '';
  return `<span class="ri-badge pill ${cls}"><span class="d ${dot}"></span>${lbl}</span>`;
}

export async function loadMrs(t){
  const box = document.getElementById('mrBox'); if (!box) return;
  let d; try { const r = await fetch('/api/mrs?branch=' + encodeURIComponent(t.gitBranch||'') + '&wo=' + encodeURIComponent(t.wo||''), { cache:'no-store' }); d = await r.json(); } catch { return; }
  const box2 = document.getElementById('mrBox'); if (!box2) return;
  if (!d.available){ box2.insertAdjacentHTML('beforeend', `<div class="rail-hint">GitLab недоступен: ${esc(d.reason||'нет доступа')}</div>`); return; }
  if (t.gitBranch) MR_CACHE[mrKey(t)] = { ts: Date.now(), mrs: d.mrs||[] };
  if (!d.mrs || !d.mrs.length){ box2.innerHTML = `<div class="rail-empty">— MR нет —</div>`; return; }
  box2.innerHTML = d.mrs.map(m =>
    `<div class="row-item"><span class="ri-k">merge</span>${aReal(m.web_url, '!'+m.iid+' → '+esc(m.target_branch), 'plain')}${mrPillHTML(m)}</div>`
    + (m.project ? `<div class="rail-hint">${esc(m.project)}</div>` : '')
  ).join('');
  // ветка/база — авторитетно из MR (реальная source_branch и target_branch), а не из шумной истории gitBranch (там мелькает preprod)
  const m0 = d.mrs.find(x => x.state === 'opened') || d.mrs[0];
  if (m0){
    const repoBase = String(m0.web_url||'').replace(/\/-\/merge_requests\/.*$/,'').replace(/\/$/,'');
    const branchEl = document.getElementById('branchVal');
    if (branchEl && m0.source_branch) branchEl.innerHTML = repoBase ? aReal(repoBase+'/-/tree/'+encodeURIComponent(m0.source_branch), esc(m0.source_branch), 'plain') : `<span class="ri-v">${esc(m0.source_branch)}</span>`;
    const baseEl = document.querySelector('#sessionSide .sc-base');
    if (baseEl && m0.target_branch) baseEl.innerHTML = '⎇ ' + esc(m0.target_branch) + (m0.state === 'merged' ? ' ✓' : '');
  }
}

export async function hydrateMrs(fresh){   // фоновая подгрузка MR для карточек (клиент-кэш ~30с + серверный 30с → без спама). fresh — рефреш дашборда: мимо кэшей
  if (S.mrHydrating) return; S.mrHydrating = true;
  const now = Date.now();
  // Идентичность MR карточки — пара (ветка, wo), как серверный ключ. По одной ветке ключевать нельзя: preprod делят десятки
  // задач, и запрос по первой попавшейся размножал бы её MR по всем preprod-карточкам.
  const want = new Map();   // mrKey -> { branch, wo }
  for (const s of S.SESSIONS){ if (s.wo && s.gitBranch && !want.has(mrKey(s))) want.set(mrKey(s), { branch: s.gitBranch, wo: s.wo }); }
  let changed = false;
  for (const [k, { branch, wo }] of [...want].slice(0, 120)){
    const c = MR_CACHE[k];
    if (!fresh && c && now - c.ts < LIVE_TTL) continue;   // свежий клиент-кэш (в т.ч. негативный) — не дёргаем GitLab
    try {
      const r = await fetch('/api/mrs?branch=' + encodeURIComponent(branch) + '&wo=' + encodeURIComponent(wo) + (fresh ? '&refresh=1' : ''), { cache:'no-store' });
      const d = await r.json();
      if (d && d.available){ MR_CACHE[k] = { ts: Date.now(), mrs: d.mrs || [] }; changed = true; }
      else MR_CACHE[k] = { ts: Date.now(), mrs: [], unavailable: true };   // нет токена → кэшируем негатив на ~30с (без спама); MR_TTL_RESET снимет после ввода токена
    } catch {}
  }
  S.mrHydrating = false;
  if (changed && (S.activeView==='board' || S.activeView==='status')) renderBoard(false);
}

export function MR_TTL_RESET(){   // сброс клиентских кэшей MR/Jira (после смены токена в Настройках → сразу перечитать)
  for (const k of Object.keys(MR_CACHE)) delete MR_CACHE[k];
  for (const k of Object.keys(JIRA_CACHE)) delete JIRA_CACHE[k];
}

function jiraChipHTML(j){
  if (!j || !j.status) return '';
  const cat = j.category || '';
  return `<span class="chip jira-${esc(cat||'na')}">${esc(j.status)}</span>`;
}

export async function loadJira(t){
  const box = document.getElementById('jiraBox'); if (!box || !t.wo) return;
  let d; try { const r = await fetch('/api/jira?wo=' + encodeURIComponent(t.wo), { cache:'no-store' }); d = await r.json(); } catch { return; }
  const box2 = document.getElementById('jiraBox'); if (!box2) return;
  if (!d.available){ box2.innerHTML = `<div class="rail-hint">Jira недоступна: ${esc(d.reason||'нет токена')} — стадия из локального состояния</div>`; return; }
  JIRA_CACHE[t.wo] = { ts: Date.now(), available:true, status:d.status, category:d.category, summary:d.summary };
  if (!d.status){ box2.innerHTML = `<div class="rail-empty">— статус не получен —</div>`; return; }
  box2.innerHTML = `<div class="row-item"><span class="ri-k">статус</span>${jiraChipHTML(d)}</div>` + (d.summary?`<div class="rail-hint">${esc(d.summary)}</div>`:'');
}

function currentTags(){   // источник — кэш ЛИБО запись в списке (finish() удаляет SESSION_CACHE, теги нельзя терять)
  const t = (S.currentFile && SESSION_CACHE[S.currentFile]) || S.SESSIONS.find(s=>s.file===S.currentFile);
  return (t && Array.isArray(t.tags)) ? t.tags.slice() : [];
}

async function saveTags(next){
  if (!S.currentFile) return;
  const clean = [...new Set(next.map(x=>String(x).trim()).filter(Boolean))].slice(0,30);
  try {
    const r = await fetch('/api/tags', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ file: S.currentFile, tags: clean }) });
    const d = await r.json();
    const tags = Array.isArray(d.tags) ? d.tags : clean;
    if (SESSION_CACHE[S.currentFile]) SESSION_CACHE[S.currentFile].tags = tags;
    const se = S.SESSIONS.find(s=>s.file===S.currentFile); if (se) se.tags = tags;   // чтобы поиск/фильтр/карточка сразу видели
    renderTags();
  } catch {}
}

export function renderTags(){
  const wrap = document.getElementById('tagsWrap'); if (!wrap) return;
  const tags = currentTags();
  wrap.innerHTML = tags.length ? tags.map((x,i)=>`<span class="tag-chip" data-i="${i}"><span class="tag-txt" title="переименовать">#${esc(x)}</span><button class="tag-x" type="button" title="удалить">✕</button></span>`).join('') : `<span class="rail-empty">тегов нет</span>`;
  wrap.querySelectorAll('.tag-chip').forEach(chip=>{
    const i = +chip.dataset.i;
    chip.querySelector('.tag-x').addEventListener('click', e=>{ e.stopPropagation(); const t=currentTags(); t.splice(i,1); saveTags(t); });
    chip.querySelector('.tag-txt').addEventListener('click', ()=>{ const t=currentTags(); const v=prompt('Переименовать тег:', t[i]); if (v!=null && v.trim()!==t[i]){ t[i]=v.trim(); saveTags(t); } });
  });
}

export function wireTags(){
  renderTags();
  const inp = document.getElementById('tagsInput'); if (!inp) return;
  inp.addEventListener('keydown', e=>{ if (e.key==='Enter'){ e.preventDefault(); const v=inp.value.trim(); if (v){ const t=currentTags(); t.push(v); saveTags(t); inp.value=''; } } });
}

export function runningAgents(agents){ return (Array.isArray(agents)?agents:[]).filter(a=>a && a.running); }

export function agentBoxHTML(agents){   // ТОЛЬКО активные (running); завершённые/остановленные не показываем
  const live = runningAgents(agents);
  if (!live.length) return '';
  return live.map(a=>{
    const tok = a.tokensIn ? ' · ' + kTok(a.tokensIn) : '';
    return `<div class="ag-item live"><div class="ag-head"><span class="ag-label">${esc(a.label)}</span><span class="ag-status"><span class="ag-dot run"></span>работает${tok}</span></div>${a.activity?`<div class="ag-act">${esc(a.activity)}</div>`:''}</div>`;
  }).join('');
}

export function stopAgentsPoll(){ if (S.agentsTimer){ clearInterval(S.agentsTimer); S.agentsTimer = null; } }

async function pollAgents(file){
  if (S.currentFile !== file){ stopAgentsPoll(); return; }
  let d; try { d = await (await fetch('/api/agents?file=' + encodeURIComponent(file), { cache:'no-store' })).json(); } catch { return; }
  if (S.currentFile !== file || !d || d.error) return;
  const sec = document.getElementById('agentsSec'), box = document.getElementById('agentsBox');
  const agents = Array.isArray(d.agents) ? d.agents : [];
  const live = runningAgents(agents);
  if (sec && box){ if (live.length){ sec.hidden = false; box.innerHTML = agentBoxHTML(agents); } else { sec.hidden = true; box.innerHTML = ''; } }
  // отражаем в кэше/списке, чтобы признак «работает» на карточке/лейбле держался, пока агенты живы
  if (SESSION_CACHE[file]){ SESSION_CACHE[file].bgRunning = d.bgRunning; SESSION_CACHE[file].agents = agents; }
  const se = S.SESSIONS.find(s=>s.file===file); if (se){ se.bgRunning = d.bgRunning; if (d.bgRunning>0) se.working = true; }
}

export function startAgentsPoll(file){ stopAgentsPoll(); S.agentsTimer = setInterval(()=>pollAgents(file), 4000); pollAgents(file); }

export async function hydrateJira(fresh){   // фоновая подгрузка статусов Jira для карточек (клиент-кэш 60с + серверный 30с). fresh — рефреш дашборда: мимо кэшей
  if (S.jiraHydrating) return; S.jiraHydrating = true;
  const now = Date.now();
  const wos = [...new Set(S.SESSIONS.filter(s => s.wo).map(s => s.wo))].slice(0, 150);   // ВСЕ WO доски, не только 30 свежих: иначе у задач ниже топ-30 нет Jira-статуса → «Заблокировано» и прочие Jira-уточнения к ним не применяются
  let changed = false, done = 0;
  for (const wo of wos){
    const c = JIRA_CACHE[wo];
    if (!fresh && c && now - c.ts < LIVE_TTL) continue;
    try {
      const r = await fetch('/api/jira?wo=' + encodeURIComponent(wo) + (fresh ? '&refresh=1' : ''), { cache:'no-store' });
      const d = await r.json();
      if (!d.available){ break; }   // нет токена/Jira недоступна — не долбим по всем wo
      JIRA_CACHE[wo] = { ts: Date.now(), available:true, status:d.status, category:d.category, summary:d.summary };
      changed = true;
      if (++done % 12 === 0 && (S.activeView==='board' || S.activeView==='status')) renderBoard(false);   // прогрессивно: колонки заполняются по мере доставки, а не одним скачком в конце (при 150 wo это ~десятки секунд)
    } catch {}
  }
  S.jiraHydrating = false;
  if (changed && (S.activeView==='board' || S.activeView==='status')) renderBoard(false);
}
