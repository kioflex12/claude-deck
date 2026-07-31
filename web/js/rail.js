// Deck — правый контекст-рейл открытой сессии: карточка состояния (модель/контекст/стадия/ветка/скоуп),
// секции MR/сборок/Jira/тегов/агентов и кнопки действий. Рендер разметки; живые данные подставляют services/stream.
import { esc, timeAgo, kTok, ctxColor } from './util.js';
import { WF_LABEL } from './columns.js';
import { aReal, jiraUrl } from './app.js';
import { runningAgents, agentBoxHTML } from './services.js';

export function sideHTML(t){
  const p = Math.round((t.ctxPct||0)*100);
  const stateColor = t.active ? 'var(--good)' : 'var(--text-faint)';
  const stateLabel = t.active ? 'активна' : 'архив';

  // репозиторий выводим из URL MR (`…/-/merge_requests/NNNN`) — для ссылки на ветку в GitLab
  const repoBase = t.wfMrUrl ? String(t.wfMrUrl).replace(/\/-\/merge_requests\/.*$/,'').replace(/\/$/,'') : '';
  // ветка ЗАДАЧИ: wfBranch из dev-workflow (реальная), иначе gitBranch cwd-репо (часто preprod у основного репо)
  const workBranch = t.wfBranch || t.gitBranch || '';
  const branchTxt = esc(workBranch||'—');
  const branchCell = (repoBase && workBranch && t.wo)
    ? aReal(repoBase+'/-/tree/'+encodeURIComponent(workBranch), branchTxt, 'plain')
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

  const jiraBtn = (t.wo && jiraUrl(t.wo)) ? `<a class="btn-ghost" href="${jiraUrl(t.wo)}" target="_blank" rel="noopener"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg> Открыть ${esc(t.wo)} в Jira</a>` : '';
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
        <div class="stat"><div class="k">окно</div><div class="v stat-win">${kTok(t.winTokens)} / 1M</div></div>
      </div>
      <div class="ctx-row"><span class="k-line">контекст</span><span class="ctxbar"><i style="width:${p}%;background:${ctxColor(t.ctxPct)}"></i></span><span class="ctx-pct" style="color:${ctxColor(t.ctxPct)}">${p}%</span></div>
      <div class="row-item" style="margin-top:10px"><span class="ri-k">стадия</span><span class="ri-v">${stageMeta}</span></div>
    </div>
    <div class="sec"><div class="sec-label">Ветка</div>
      <div class="row-item"><span class="ri-k">${esc(t.project||'проект')}</span><span id="branchVal">${branchCell}</span></div>
      <div class="rail-hint"><code>${esc(t.cwd||'—')}</code></div>
    </div>
    ${t.wo?`<div class="sec"><div class="sec-label">Статус Jira</div><div id="jiraBox"><div class="rail-hint">проверяю Jira…</div></div></div>`:''}
    <div class="sec"><div class="sec-label">Скоуп</div>
      <div class="chips">
        ${t.clientCu?`<span class="chip sc-cu sc-cu-run" data-cu="${esc(t.clientCu)}" data-cwd="${esc(t.cwd||'')}" title="Открыть/запустить Unity (${esc(t.clientCu)})">${esc(t.clientCu)}</span>`:''}
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
