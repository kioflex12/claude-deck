// Deck — лента «Требует внимания» (Фаза-4): агрегирует сигналы, требующие действия разработчика.
// Сессионные сигналы (блокер Jira, упавшая сборка, ожидание проверки) считаются на месте из S.SESSIONS —
// они уже приезжают в /api/sessions, поэтому обновляются вместе с обычным поллингом доски. Незакоммиченные
// рабочие копии тянутся отдельно из /api/git-dirty (git на сервере) с более редким циклом.
import { S, JIRA_CACHE } from './store.js';
import { esc, timeAgo } from './util.js';
import { attentionReasons } from './columns.js';
import { openSession } from './session.js';
import { openWoJira } from './ui.js';

function attentionSessions(){
  const out = [];
  for (const s of S.SESSIONS){
    const reasons = attentionReasons(s, JIRA_CACHE);
    if (reasons.length) out.push({ s, reasons, sev: Math.max(...reasons.map(r=>r.sev)) });
  }
  out.sort((a,b)=> b.sev - a.sev || b.s.mtime - a.s.mtime);
  return out;
}

export function attentionCount(){ return attentionSessions().length + (S.ATTENTION_GIT ? S.ATTENTION_GIT.length : 0); }

// Бейдж-счётчик на вкладке «Внимание» — чтобы сигнал был виден без открытия вкладки.
export function updateAttentionBadge(){
  const tab = document.querySelector('.tab[data-v="attention"]'); if (!tab) return;
  let b = tab.querySelector('.tab-badge');
  const n = attentionCount();
  if (!n){ if (b) b.remove(); return; }
  if (!b){ b = document.createElement('span'); b.className = 'tab-badge'; tab.appendChild(b); }
  b.textContent = n > 99 ? '99+' : String(n);
}

const RK = { blocked:'🚫', build:'🔴', verify:'📱', git:'✎' };
function reasonChip(r){
  return `<span class="attn-chip rk-${r.kind}">${RK[r.kind]||''} ${esc(r.label)}${r.detail?` · ${esc(r.detail)}`:''}</span>`;
}
function sessionCardHTML(item){
  const s = item.s;
  const chips = item.reasons.map(reasonChip).join('');
  const wo = s.wo ? `<span class="attn-wo" data-wo="${esc(s.wo)}" title="Открыть ${esc(s.wo)} в Jira">${esc(s.wo)} ↗</span>` : '';
  const branch = s.gitBranch ? `<span class="attn-branch">⎇ ${esc(s.gitBranch)}</span>` : '';
  return `<article class="attn-card sev-${item.sev}" data-file="${esc(s.file)}" tabindex="0" role="button">
    <div class="attn-head"><span class="attn-proj">${esc(s.project||'—')}</span>${wo}</div>
    <h4 class="attn-title">${esc(s.title||'(без заголовка)')}</h4>
    <div class="attn-reasons">${chips}</div>
    <div class="attn-foot">${branch}<span class="attn-time">${timeAgo(s.mtime)}</span></div>
  </article>`;
}
function repoCardHTML(r){
  return `<article class="attn-card sev-git" data-dir="${esc(r.dir)}" tabindex="0" role="button" title="Открыть папку: ${esc(r.dir)}">
    <div class="attn-head"><span class="attn-proj">📁 ${esc(r.name)}</span>${r.branch?`<span class="attn-branch">⎇ ${esc(r.branch)}</span>`:''}</div>
    <div class="attn-reasons"><span class="attn-chip rk-git">${RK.git} ${r.count} ${r.count===1?'незакоммиченный файл':'незакоммиченных файлов'}</span></div>
    <div class="attn-foot"><span class="attn-path">${esc(r.dir)}</span></div>
  </article>`;
}

export function renderAttention(){
  const view = document.getElementById('viewAttention'); if (!view) return;
  const sess = attentionSessions();
  const repos = S.ATTENTION_GIT || [];
  if (!sess.length && !repos.length){
    view.innerHTML = `<div class="attn-empty"><div class="attn-empty-emoji">✅</div><div>Ничего не требует внимания</div><div class="attn-empty-sub">Нет блокеров, упавших сборок, задач на проверку и незакоммиченных копий.</div></div>`;
    return;
  }
  const sections = [];
  if (sess.length) sections.push(`<div class="attn-sec-title">Задачи <span class="attn-sec-n">${sess.length}</span></div><div class="attn-grid">${sess.map(sessionCardHTML).join('')}</div>`);
  if (repos.length) sections.push(`<div class="attn-sec-title">Незакоммиченные копии <span class="attn-sec-n">${repos.length}</span></div><div class="attn-grid">${repos.map(repoCardHTML).join('')}</div>`);
  view.innerHTML = `<div class="attn-wrap">${sections.join('')}</div>`;
  view.querySelectorAll('.attn-card[data-file]').forEach(el=>{
    el.addEventListener('click', e=>{ if (e.target.closest('.attn-wo')) return; openSession(el.dataset.file); });
    el.addEventListener('keydown', e=>{ if (e.key==='Enter'||e.key===' '){ e.preventDefault(); openSession(el.dataset.file); } });
  });
  view.querySelectorAll('.attn-wo').forEach(el=>{
    el.addEventListener('click', e=>{ e.stopPropagation(); openWoJira(el.dataset.wo); });
  });
  view.querySelectorAll('.attn-card[data-dir]').forEach(el=>{
    const open = ()=>{ const dir = el.dataset.dir; if (window.deckNative && window.deckNative.openPath) window.deckNative.openPath({ path: dir, cwd: dir }); };
    el.addEventListener('click', open);
    el.addEventListener('keydown', e=>{ if (e.key==='Enter'||e.key===' '){ e.preventDefault(); open(); } });
  });
}

export async function loadGitDirty(){
  try {
    const d = await (await fetch('/api/git-dirty', { cache:'no-store' })).json();
    S.ATTENTION_GIT = Array.isArray(d.repos) ? d.repos : [];
  } catch { S.ATTENTION_GIT = []; }
  updateAttentionBadge();
  if (S.activeView === 'attention') renderAttention();
}
export function startAttentionPoll(){
  if (S.attnGitTimer) clearInterval(S.attnGitTimer);
  loadGitDirty();
  S.attnGitTimer = setInterval(loadGitDirty, 45000);   // git-скан рабочих копий — редкий цикл (сервер кэширует 45с)
}
