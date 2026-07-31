// Deck — сессия/чат: правый рейл контекста, композер с «/»-скиллами, живой стрим ответа (SSE + Agent SDK),
// inline-аппрувы инструментов, вложения, live-tail ленты. Крупнейший кластер, вынесен из app.js; состояние — в store (S).
import { S, SESSION_CACHE, SKILLS_CACHE, notifiedDone, promptQueue, attachDraft, MODE_ORDER, MODE_LABEL, ATTACH_MAX_BYTES } from './store.js';
import { esc, mdToHtml, fmtTok, timeAgo, kTok, ctxColor } from './util.js';
import { WF_LABEL } from './columns.js';
import { toast, openWoJira } from './ui.js';
import { isWorking } from './board.js';
import { runningAgents, agentBoxHTML, wireTags, loadBuilds, loadMrs, loadJira, startAgentsPoll, stopAgentsPoll } from './services.js';
import { launchUnity } from './unity.js';
import { aReal, jiraUrl, loadModelsCatalog } from './app.js';
import { requireAuth } from './auth.js';
import { ensureNotifyPermission, titleOf, notifyDone } from './notify.js';
import { wireSideActions } from './dialogs.js';
import { setView } from './nav.js';

// Обрыв стрима кнопкой Стоп — надёжно, независимо от детекта дисконнекта: /api/stop + локальный finish/hard-reset.
export function userStop(){
  if (!S.streaming && !S.currentES){ clearQueue(); return; }
  if (S.currentStreamId) fetch('/api/stop?id=' + encodeURIComponent(S.currentStreamId), { cache:'no-store' }).catch(()=>{});
  if (S.liveFinish){ S.liveFinish('Остановлено пользователем', { silent:true, stopped:true }); return; }
  // стрим жив, но finish потерялся (перерисовка/edge) — жёстко обрываем сами
  if (S.currentES){ try { S.currentES.close(); } catch {} S.currentES = null; }
  if (S.streamTimer){ clearInterval(S.streamTimer); S.streamTimer = null; }
  document.querySelectorAll('.cx-run-chat').forEach(el => el.remove());
  S.streamingFile = null; S.currentStreamId = null; setComposerBusy(false); clearQueue();
}

function sideHTML(t){
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
export function wireConsole(){
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

export async function loadSkills(cwd){
  S.SESSION_SKILLS = [];
  if (!cwd){ updateSlash(); return; }
  if (SKILLS_CACHE[cwd]){ S.SESSION_SKILLS = SKILLS_CACHE[cwd]; updateSlash(); return; }
  try {
    const r = await fetch('/api/skills?cwd=' + encodeURIComponent(cwd), { cache:'no-store' });
    const d = await r.json();
    S.SESSION_SKILLS = Array.isArray(d.skills) ? d.skills : [];
    SKILLS_CACHE[cwd] = S.SESSION_SKILLS;
  } catch (e) { S.SESSION_SKILLS = []; }
  updateSlash();   // если «/» уже введён (гонка загрузки — особенно в новой сессии) — перефильтровать дропдаун
}
function slashFilter(q){
  q = q.toLowerCase();
  return S.SESSION_SKILLS.filter(s => !q || s.name.toLowerCase().includes(q) || (s.description||'').toLowerCase().includes(q));
}
function updateSlash(){
  const ta = document.getElementById('composer-ta');
  const box = document.getElementById('slashBox');
  if (!ta || !box) return;
  const v = ta.value;
  if (v[0] === '/' && !v.slice(1).includes(' ')) {
    S.slashItems = slashFilter(v.slice(1)).slice(0, 60);
    S.slashOpen = S.slashItems.length > 0;
    S.slashSel = 0;
    renderSlash();
  } else {
    S.slashOpen = false; box.hidden = true;
  }
}
function renderSlash(){
  const box = document.getElementById('slashBox');
  if (!box) return;
  if (!S.slashOpen){ box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = S.slashItems.map((s,i)=>`<div class="cx-sl-item ${i===S.slashSel?'sel':''}" data-i="${i}"><span class="cx-sl-name">/${esc(s.name)}</span><span class="cx-sl-src">${esc(s.source)}</span><span class="cx-sl-desc">${esc((s.description||'').slice(0,110))}</span></div>`).join('');
  box.querySelectorAll('.cx-sl-item').forEach(el=>{
    el.addEventListener('mousedown', e => { e.preventDefault(); chooseSlash(+el.dataset.i); });
    el.addEventListener('mousemove', () => { S.slashSel = +el.dataset.i; highlightSlash(); });
  });
}
function highlightSlash(){
  document.querySelectorAll('.cx-sl-item').forEach((el,j)=>el.classList.toggle('sel', j===S.slashSel));
  const s = document.querySelector('.cx-sl-item.sel'); if (s) s.scrollIntoView({ block:'nearest' });
}
function chooseSlash(i){
  const s = S.slashItems[i]; if (!s) return;
  const ta = document.getElementById('composer-ta'); if (!ta) return;
  ta.value = '/' + s.name + ' ';
  S.slashOpen = false; const box = document.getElementById('slashBox'); if (box) box.hidden = true;
  ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight,150) + 'px';
  const btn = document.getElementById('sendBtn'); if (btn) btn.disabled = !ta.value.trim();
  ta.focus();
}

export function renderComposer(t){
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
          <button class="cx-ibtn" id="compactBtn" type="button" title="Сжать контекст сессии (/compact)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3v5H3M16 3v5h5M8 21v-5H3M16 21v-5h5"/></svg></button>
          <button class="cx-ibtn cx-stop" id="stopBtn" type="button" title="Остановить">${ICON.stop}</button>
          <span class="cx-queue" id="queueInd" hidden></span>
        </div>
        <div class="cx-foot-r">
          <div class="cx-modepop" id="modePop" hidden></div>
          <button class="cx-mode" id="modeBtn" type="button" title="Режим / модель / effort">${ICON.bolt}<span id="modeLabel">Обычный</span></button>
          <button class="send-btn" id="sendBtn" type="button" disabled>${ICON.send}</button>
        </div>
      </div>
    </div>`;
  const ta = document.getElementById('composer-ta'), btn = document.getElementById('sendBtn');
  const grow = () => { ta.style.height='auto'; ta.style.height=Math.min(ta.scrollHeight,150)+'px'; btn.disabled = !(ta.value.trim() || attachDraft.length); };
  ta.addEventListener('input', () => { grow(); updateSlash(); });
  ta.addEventListener('keydown', e => {
    if (S.slashOpen) {
      if (e.key==='ArrowDown'){ e.preventDefault(); S.slashSel=Math.min(S.slashSel+1, S.slashItems.length-1); highlightSlash(); return; }
      if (e.key==='ArrowUp'){ e.preventDefault(); S.slashSel=Math.max(S.slashSel-1, 0); highlightSlash(); return; }
      if (e.key==='Enter'){ e.preventDefault(); chooseSlash(S.slashSel); return; }
      if (e.key==='Escape'){ e.preventDefault(); S.slashOpen=false; document.getElementById('slashBox').hidden=true; return; }
    }
    if (e.key==='Tab' && e.shiftKey) { e.preventDefault(); cycleMode(); return; }   // как в расширении — циклим режим
    if (e.key==='Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  btn.addEventListener('click', sendMessage);
  const stopBtn = document.getElementById('stopBtn');
  stopBtn.disabled = !S.streaming;   // состояние Стоп = чистая функция от факта живого стрима (переживает перерисовку)
  stopBtn.addEventListener('click', userStop);
  document.getElementById('skillBtn').addEventListener('click', () => { if (S.streaming) return; if (ta.value[0] !== '/') ta.value = '/' + ta.value; ta.focus(); updateSlash(); });
  document.getElementById('compactBtn').addEventListener('click', () => {   // /compact — сжать контекст текущей сессии
    if (!S.currentFile || !requireAuth()) return;
    const payload = { text: '/compact', mode: S.sessionMode, model: S.sessionModel, effort: S.sessionEffort, attachments: [] };
    if (S.streaming){ enqueuePrompt(payload); toast('/compact добавлен в очередь'); return; }
    toast('Сжимаю контекст сессии…'); runPrompt(payload);
  });
  document.getElementById('modeBtn').addEventListener('click', toggleModePop);   // поповер: режим + модель + effort-ползунок
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
  paintMode();   // режим/модель/effort задаёт вызывающий (openSession сбрасывает на default; new/fork — выбранное в окне)
  if (!S.MODELS.length) loadModelsCatalog();   // данные для поповера «Режимы» (модели/эффорты подтягиваются)
  attachDraft.length = 0; renderAttachDraft();
  setTimeout(()=>ta.focus(), 60);
}

export function stopStream(){
  if (S.streamTimer){ clearInterval(S.streamTimer); S.streamTimer = null; }
  if (S.currentES){ try { S.currentES.close(); } catch {} S.currentES = null; }
  if (S.buildTimer){ clearInterval(S.buildTimer); S.buildTimer = null; }
  stopTail();
  stopRailRefresh();
  stopAgentsPoll();
  S.streaming = false; S.liveFinish = null; S.streamingFile = null; S.currentStreamId = null;
  promptQueue.length = 0; updateQueueIndicator();        // уходя с сессии — очередь сбрасываем
  // жёсткий сброс UI стрима: убрать индикатор «работает» и снять недостроенный live-блок из чата
  document.querySelectorAll('.cx-run-chat').forEach(el => el.remove());
  document.querySelectorAll('.cx-asst.cx-live').forEach(el => el.classList.remove('cx-live'));
}
function setComposerBusy(on){
  S.streaming = on;
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
export function setStreamStatus(text, autoHideMs){
  const n = document.getElementById('viewNote'); if (!n) return;
  if (text){ n.style.display='flex'; n.querySelector('span').textContent = text; if (autoHideMs) setTimeout(()=>{ if (n.querySelector('span').textContent===text) n.style.display='none'; }, autoHideMs); }
  else { n.style.display='none'; }
}

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

export function paintMode(){
  const btn = document.getElementById('modeBtn'); if (!btn) return;
  const lbl = btn.querySelector('#modeLabel'); if (lbl) lbl.textContent = MODE_LABEL[S.sessionMode] || 'Обычный';
  btn.classList.toggle('cx-mode-bypass', S.sessionMode === 'bypassPermissions');   // байпас — предупреждающе (красный)
  const extra = [];
  const mm = S.MODELS.find(m=>m.value===S.sessionModel); if (S.sessionModel && mm) extra.push(mm.label);
  const ee = S.EFFORTS.find(e=>e.value===S.sessionEffort); if (S.sessionEffort && ee) extra.push(ee.label.replace(/^Effort:\s*/,''));
  btn.title = 'Режим: ' + (MODE_LABEL[S.sessionMode] || 'Обычный') + (extra.length?' · '+extra.join(' · '):'') + ' — клик для настройки (⇧+Tab — режим)';
}
// доступные effort-уровни для модели (из /api/models, не хардкод); всегда с «по умолчанию» первым
function effortsForModel(mv){
  const m = S.MODELS.find(x=>x.value===mv);
  const allowed = m && Array.isArray(m.efforts) && m.efforts.length ? m.efforts : null;
  if (!allowed) return S.EFFORTS;   // модель без явного списка (или синтетический «по умолчанию») → все доступные уровни
  return S.EFFORTS.filter(e=>!e.value || allowed.includes(e.value));
}
// Поповер «Режимы» (как в расширении): список режимов + выбор модели + ползунок effort. Значения подтягиваются.
const MODE_META = {
  default:           { i:'✋',  d:'Спрашивает подтверждение перед каждой правкой' },
  acceptEdits:       { i:'</>', d:'Правит файлы без спроса; Bash и прочее — спрашивает' },
  plan:              { i:'▤',  d:'Сначала исследует и предлагает план, без правок' },
  bypassPermissions: { i:'⚡',  d:'Разрешает все действия без спроса' },
};
function openModePop(){
  const pop = document.getElementById('modePop'); if (!pop) return;
  if (!S.MODELS.length){ loadModelsCatalog().then(()=>{ const p=document.getElementById('modePop'); if (p && !p.hidden) openModePop(); }); }   // каталог ещё грузится — дорисуем модели/эффорты как придут
  const modeRows = MODE_ORDER.map(m=>{ const me=MODE_META[m]||{}; const sel=m===S.sessionMode; return `<div class="mp-mode${sel?' sel':''}" data-m="${m}"><span class="mp-ic">${me.i||''}</span><span class="mp-txt"><b>${esc(MODE_LABEL[m]||m)}</b><span>${esc(me.d||'')}</span></span>${sel?'<span class="mp-check">✓</span>':''}</div>`; }).join('');
  const models = S.MODELS.length?S.MODELS:[{value:'',label:'по умолчанию'}];
  const modelOpts = models.map(m=>`<option value="${esc(m.value)}"${m.value===S.sessionModel?' selected':''}>${esc(m.label)}</option>`).join('');
  const effs = effortsForModel(S.sessionModel);
  let ei = effs.findIndex(e=>e.value===S.sessionEffort); if (ei<0){ ei=0; S.sessionEffort=effs[0].value; }
  pop.innerHTML = `<div class="mp-hd">Режимы<span class="mp-hint">⇧+Tab</span></div>
    <div class="mp-row"><span class="mp-k">Модель</span><select class="cx-sel" id="mpModel">${modelOpts}</select></div>
    <div class="mp-modes">${modeRows}</div>
    <div class="mp-eff"><div class="mp-eff-top"><span>Effort</span><b id="mpEffLbl">${esc(effs[ei].label.replace(/^Effort:\s*/,''))}</b></div>
      <input type="range" class="mp-slider" id="mpEff" min="0" max="${Math.max(0,effs.length-1)}" step="1" value="${ei}"${effs.length<=1?' disabled':''}></div>`;
  pop.hidden = false;
  pop.querySelectorAll('.mp-mode').forEach(r=>r.addEventListener('click', ()=>{ S.sessionMode=r.dataset.m; paintMode(); openModePop(); }));
  const ms = pop.querySelector('#mpModel');
  if (ms) ms.onchange = ()=>{ S.sessionModel=ms.value; localStorage.setItem('deckModel',S.sessionModel); openModePop(); paintMode(); };
  const es = pop.querySelector('#mpEff'), el = pop.querySelector('#mpEffLbl');
  if (es) es.oninput = ()=>{ const arr=effortsForModel(S.sessionModel); const v=arr[+es.value]||arr[0]; S.sessionEffort=v.value; localStorage.setItem('deckEffort',S.sessionEffort); if (el) el.textContent=v.label.replace(/^Effort:\s*/,''); paintMode(); };
  // клик вне поповера — закрыть
  const off = (e)=>{ const p=document.getElementById('modePop'); if (!p||p.hidden){ document.removeEventListener('mousedown',off,true); return; } if (!p.contains(e.target) && !(e.target.closest && e.target.closest('#modeBtn'))){ p.hidden=true; document.removeEventListener('mousedown',off,true); } };
  document.addEventListener('mousedown', off, true);
}
function toggleModePop(){ const pop=document.getElementById('modePop'); if (!pop) return; if (pop.hidden) openModePop(); else pop.hidden=true; }
function cycleMode(){
  const i = MODE_ORDER.indexOf(S.sessionMode);
  S.sessionMode = MODE_ORDER[(i + 1) % MODE_ORDER.length];
  paintMode();
  const pop = document.getElementById('modePop'); if (pop && !pop.hidden) openModePop();   // поповер открыт → отразить смену
}

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
export function clearQueue(){
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
  setTimeout(() => { if (S.currentFile) runPrompt(next); }, 60);
}
function sendMessage(){
  const ta = document.getElementById('composer-ta'); if (!ta) return;
  if (!requireAuth()) return;                             // чат требует логина в Claude
  const text = ta.value.trim();
  const attachments = attachDraft.slice();                // P4: приложенные файлы
  if ((!text && !attachments.length) || (!S.currentFile && !S.pendingNewSession)) return;
  S.slashOpen = false; const box = document.getElementById('slashBox'); if (box) box.hidden = true;
  ta.value = ''; ta.style.height = 'auto';
  attachDraft.length = 0; renderAttachDraft();            // черновик вложений очищаем
  const btn = document.getElementById('sendBtn'); if (btn) btn.disabled = true;
  const payload = { text, mode: S.sessionMode, model: S.sessionModel, effort: S.sessionEffort, attachments };
  if (!S.currentFile && S.pendingNewSession){ payload.newSessionCwd = S.pendingNewSession.cwd; payload.pendingName = S.pendingNewSession.name; }  // первый промт → создать именованную сессию
  if (S.streaming){ enqueuePrompt(payload); return; }       // идёт стрим → в очередь
  runPrompt(payload);
}
export async function runPrompt(payload){
  const text = payload.text || '', mode = payload.mode || 'default', attachments = payload.attachments || [];
  const model = payload.model || '', effort = payload.effort || '';
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
  S.streamingFile = S.currentFile;                           // мгновенно метим сессию как «работает» (оверрайд для карточки)
  notifiedDone.delete(S.currentFile);                      // новый запуск — перевзвести дедуп завершения
  ensureNotifyPermission();                              // разрешение на уведомления — при первой отправке

  // индикатор процесса — В ЧАТЕ: спиннер + «Claude работает… Nс», закреплён внизу консоли,
  // существует только пока идёт ИМЕННО этот стрим (создаётся здесь, снимается в finish/stopStream).
  const runEl = appendHTML(cons, '<div class="cx-run-chat"><span class="cx-spin"></span><span class="cx-run-txt">Claude работает… 0с</span></div>');
  scrollBottom();
  const t0 = Date.now();
  S.streamTimer = setInterval(() => { const el = runEl.querySelector('.cx-run-txt'); if (el) el.textContent = 'Claude работает… ' + Math.round((Date.now()-t0)/1000) + 'с'; }, 1000);

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
        ? { prompt: text, mode, model, effort, fork: true, sessionFile: payload.forkFile, attachments: slim }
        : payload.newSessionCwd
        ? { prompt: text, mode, model, effort, newSession: true, cwd: payload.newSessionCwd, attachments: slim }
        : { prompt: text, mode, model, effort, sessionFile: S.currentFile, attachments: slim };
      const r = await fetch('/api/chat-prepare', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(body) });
      const d = await r.json();
      if (!r.ok || !d.token) throw new Error(d && d.error ? d.error : 'stage failed');
      streamUrl = '/api/chat?token=' + encodeURIComponent(d.token);
    } catch (e){
      appendHTML(cons, '<div class="cx-note">Ошибка запуска: ' + esc(String(e.message||e)) + '</div>');
      setComposerBusy(false); scrollBottom();
      if (S.streamTimer){ clearInterval(S.streamTimer); S.streamTimer = null; }
      const ridx = cons.querySelector('.cx-run-chat'); if (ridx) ridx.remove();
      S.streamingFile = null; drainQueue(); return;
    }
  } else {
    streamUrl = '/api/chat?file=' + encodeURIComponent(S.currentFile) + '&prompt=' + encodeURIComponent(text) + '&mode=' + encodeURIComponent(mode) + '&model=' + encodeURIComponent(model) + '&effort=' + encodeURIComponent(effort);
  }
  const es = new EventSource(streamUrl);
  S.currentES = es;
  let finished = false;
  const finish = (note, opts) => {
    if (finished) return; finished = true;
    if (S.streamTimer){ clearInterval(S.streamTimer); S.streamTimer = null; }
    try { es.close(); } catch {} S.currentES = null; S.liveFinish = null; S.currentStreamId = null;
    clearLive(); finalizeThink();
    runEl.remove();                      // снять индикатор «работает» из чата
    if (opts && typeof opts.ctxPct === 'number') updateRailContext(opts.ctxPct, opts.winTokens);   // контекст в рейле — СРАЗУ по завершении, не ждём поллинг
    if (note) appendHTML(cons, '<div class="cx-note">' + esc(note) + '</div>');
    const doneFile = S.streamingFile || S.currentFile;
    const doneTitle = (SESSION_CACHE[S.currentFile] && SESSION_CACHE[S.currentFile].title) || titleOf(S.currentFile) || '';
    S.streamingFile = null;                // сессия больше не «работает» от Deck
    delete SESSION_CACHE[S.currentFile];   // транскрипт на диске обновился — перечитать при следующем заходе
    setComposerBusy(false);
    const ta2 = document.getElementById('composer-ta'); if (ta2) ta2.focus();
    scrollBottom();
    if (!(opts && opts.silent)) notifyDone(doneFile, doneTitle, 'Claude закончил');   // done/error → уведомление
    const f = doneFile;
    stopTail();
    const wasCompact = payload && typeof payload.text === 'string' && payload.text.trim() === '/compact';
    if (wasCompact){
      // /compact завершился — перечитываем сжатый транскрипт и обновляем карточку/окно (иначе висел старый вид до ручного перезахода)
      appendHTML(cons, '<div class="cx-note">Контекст сжат ✓ — обновляю сессию…</div>');
      delete SESSION_CACHE[f];
      setTimeout(() => { if (S.currentFile === f) openSession(f); }, 500);
    } else if (isNewRun && S.currentFile){
      // новая сессия завершилась. Если в файле есть блоки — полноценно открываем (рейл/сборки/tail). Если 0 блоков
      // (запуск ничего не выдал — напр. сбой SDK) — НЕ вайпаем консоль, оставляем видимым промт + ошибку, освежаем лишь рейл.
      setTimeout(async () => {
        if (S.currentFile !== f) return;
        let t = null; try { t = await (await fetch('/api/session?file=' + encodeURIComponent(f), { cache:'no-store' })).json(); } catch {}
        if (t && !t.error && Array.isArray(t.blocks) && t.blocks.length){ if (S.currentFile === f) openSession(f); return; }
        if (t && !t.error && S.currentFile === f){   // пусто — консоль не трогаем, обновим правый рейл
          SESSION_CACHE[f] = t;
          const side = document.getElementById('sessionSide'); if (side){ side.innerHTML = sideHTML(t); document.querySelectorAll('#sessionSide .sc-cu-run').forEach(el=>el.addEventListener('click',()=>launchUnity(el.dataset.cu,el.dataset.cwd))); wireTags(); wireSideActions(t); loadBuilds(t); loadMrs(t); loadJira(t); }
          appendHTML(cons, '<div class="cx-note">Запуск не дал ответа — сообщений в сессии нет. Если это упакованное приложение и ошибка повторяется, пришлите текст ошибки выше.</div>');
        }
      }, 700);
    } else {
      // синхронизируем курсор live-tail с диском БЕЗ перерисовки (сохраняем live-блоки, включая размышление)
      setTimeout(async () => {
        if (S.currentFile !== f || S.streaming) return;
        try { const r = await fetch('/api/session-tail?file=' + encodeURIComponent(f) + '&after=0', { cache:'no-store' }); const dd = await r.json(); if (typeof dd.count === 'number') S.tailCount = dd.count; if (dd.active) startTail(f); } catch {}
      }, 600);
    }
    if (opts && opts.stopped) clearQueue();          // Стоп → чистим очередь (не сыпем дальше)
    else if (opts && opts.done) drainQueue();        // штатное завершение → следующий из очереди
  };
  S.liveFinish = finish;                   // кнопка СТОП обрывает именно этот стрим (закрытие ES → abort на сервере)
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
      S.currentFile = d.file; S.streamingFile = d.file; S.tailCount = 0;
      const nm = payload.pendingName || (S.pendingNewSession && S.pendingNewSession.name) || '';
      const bt = document.querySelector('#sessionBar .sb-title'); if (bt) bt.textContent = nm || 'Новая сессия';
      if (nm){ fetch('/api/session-name', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ file: d.file, name: nm }) }).catch(()=>{}); }  // закрепляем имя как заголовок карточки
      S.pendingNewSession = null;   // сессия создана — pending снят
    } else if (d.type === 'start'){
      if (d.streamId) S.currentStreamId = d.streamId;   // для гарантированного /api/stop
    } else if (d.type === 'error'){
      finish('Ошибка: ' + (d.message || 'unknown'));   // ошибка стрима — очередь не двигаем
    } else if (d.type === 'done'){
      finish(d.isError ? 'Завершено с ошибкой' : null, { done:true, ctxPct:d.ctxPct, winTokens:d.winTokens });
    }
    // 'system' — в UI не показываем
  };
  es.onerror = () => { if (!finished) finish('Соединение прервано'); };
}
export async function openSession(file){
  stopStream();   // закрыть стрим прошлой сессии, если был
  S.currentFile = file;
  S.returnView = (S.activeView==='status' || S.activeView==='board') ? S.activeView : 'status';
  document.getElementById('viewBoard').style.display = 'none';
  document.getElementById('viewSkills').style.display = 'none';
  document.getElementById('viewMcp').style.display = 'none';
  document.getElementById('viewSession').style.display = 'flex';
  document.querySelectorAll('.tab').forEach(x => x.setAttribute('aria-selected','false'));
  const bar = document.getElementById('sessionBar');
  const backBtn = `<button class="back" id="backBtn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M15 18 9 12l6-6"/></svg> Назад</button>`;
  bar.innerHTML = backBtn + `<span class="sb-title">Загрузка…</span>`;
  document.getElementById('backBtn').addEventListener('click', () => setView(S.returnView));
  document.getElementById('thread').innerHTML = `<div class="empty">Загрузка транскрипта…</div>`;
  document.getElementById('composer').innerHTML = '';
  document.getElementById('sessionSide').innerHTML = '';
  if (S.streamingFile === file || S.SESSIONS.some(s => s.file === file && isWorking(s))) delete SESSION_CACHE[file];   // активная сессия — свежий стейт (active/blocks), чтобы показать «работает» и live-tail при перезаходе
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
  if (S.currentFile !== file) return;
  // тег задачи — кликабельный чип в правом верхнем углу шапки (margin-left:auto), клик → задача в Jira.
  // Всегда JS-кликабельный (как cu-тег), Jira-URL резолвим В МОМЕНТ КЛИКА (хост мог подгрузиться после рендера).
  const woChip = t.wo ? `<span class="sb-wo-tag sb-wo-run" data-wo="${esc(t.wo)}" title="Открыть ${esc(t.wo)} в Jira">${esc(t.wo)}<span class="ext">↗</span></span>` : '';
  bar.innerHTML = backBtn + `<span class="sb-wo">${esc(t.project)}</span><span class="sb-title">${esc(t.title)}</span>${woChip}`;
  document.getElementById('backBtn').addEventListener('click', () => setView(S.returnView));
  const woRun = bar.querySelector('.sb-wo-run'); if (woRun) woRun.addEventListener('click', () => openWoJira(woRun.dataset.wo));
  document.getElementById('sessionSide').innerHTML = sideHTML(t);
  document.querySelectorAll('#sessionSide .sc-cu-run').forEach(el => el.addEventListener('click', () => launchUnity(el.dataset.cu, el.dataset.cwd)));   // cu-тег в рейле → Unity (фокус/запуск)
  wireTags();          // секция «Теги»: add/edit/delete
  wireSideActions(t);  // кнопки «Форкнуть» / «Удалить»
  startAgentsPoll(t.file);   // live-статус фоновых сабагентов
  renderThread(t);     // лента блоков + запуск live-tail для активной сессии
  S.sessionMode = 'default';   // при открытии существующей сессии — обычный режим (модель/effort — сохранённые)
  renderComposer(t);
  loadSkills(t.cwd);   // грузим скиллы cwd один раз (для «/»)
  loadBuilds(t);       // live-статус сборок TeamCity в рейл
  loadMrs(t);          // live-MR из GitLab в рейл
  loadJira(t);         // live-статус Jira в рейл
  if (t.active || S.streamingFile === file) startRailRefresh(file);   // активная сессия → ветка/MR/сборки/Jira обновляются по ходу работы
}

function renderThread(t){
  const blocks = t.blocks || [];
  document.getElementById('thread').innerHTML = blocks.length ? `<div class="cx-console">${blocks.map(blockHTML).join('')}</div>` : `<div class="empty">Сессия без текстовых сообщений.</div>`;
  wireConsole();
  S.tailCount = blocks.length;               // курсор live-tail = число уже показанных блоков
  scrollBottom();                          // открываем на последних сообщениях (актуальный контекст)
  requestAnimationFrame(scrollBottom);     // повтор после раскладки (шрифты/переносы могут сдвинуть высоту)
  stopTail();
  if (t.active) startTail(t.file);         // сессия свежая → тянем новые блоки вживую
}
function stopTail(){ if (S.tailTimer){ clearInterval(S.tailTimer); S.tailTimer = null; } if (S.tailCountTimer){ clearInterval(S.tailCountTimer); S.tailCountTimer = null; } const ind = document.getElementById('tailInd'); if (ind) ind.remove(); }
function startTail(file){ stopTail(); S.tailTimer = setInterval(() => tailTick(file), 4000); tailTick(file); }
// Живой рефреш рейла: по мере работы над контекстом ветка/MR/сборки/Jira меняются — периодически перечитываем
// состояние сессии и обновляем секции (MR/сборки/Jira/ветка) на месте, не трогая теги/скролл/композер.
function stopRailRefresh(){ if (S.railTimer){ clearInterval(S.railTimer); S.railTimer = null; } }
function startRailRefresh(file){
  stopRailRefresh();
  S.railTimer = setInterval(async () => {
    if (S.currentFile !== file){ stopRailRefresh(); return; }
    let t2 = null;
    try { const r = await fetch('/api/session?file=' + encodeURIComponent(file), { cache:'no-store' }); t2 = await r.json(); } catch {}
    if (!t2 || t2.error || S.currentFile !== file) return;
    SESSION_CACHE[file] = t2;
    loadMrs(t2); loadJira(t2); loadBuilds(t2);     // секции сами обновляют свои боксы (+ #branchVal/#sc-base из MR)
    if (!t2.active && !S.streaming){ stopRailRefresh(); }   // сессия затихла и Deck не стримит → рефреш больше не нужен
  }, 25000);
}
// Индикатор «Claude работает… Nс» при перезаходе (tail). turnStartTs (эпоха, старт хода с сервера) — чтобы показывать
// РЕАЛЬНУЮ длительность хода, а не с момента перезахода; нет — фолбэк на локальное время появления индикатора.
export function updateTailIndicator(on, turnStartTs){
  const cons = document.querySelector('.cx-console'); if (!cons) return;
  let ind = document.getElementById('tailInd');
  if (on){
    if (!ind) ind = appendHTML(cons, '<div class="cx-run-chat" id="tailInd"><span class="cx-spin"></span><span class="cx-run-txt">✻ Claude работает…</span></div>');
    else cons.appendChild(ind);            // держим индикатор внизу
    const start = (turnStartTs && turnStartTs > 0) ? turnStartTs : (ind._start || Date.now());
    ind._start = start;
    const txt = ind.querySelector('.cx-run-txt');
    const paint = () => { if (txt) txt.textContent = '✻ Claude работает… ' + Math.max(0, Math.round((Date.now() - start) / 1000)) + 'с'; };
    paint();
    if (S.tailCountTimer) clearInterval(S.tailCountTimer);
    S.tailCountTimer = setInterval(paint, 1000);
  } else {
    if (S.tailCountTimer){ clearInterval(S.tailCountTimer); S.tailCountTimer = null; }
    if (ind) ind.remove();
  }
}
// Обновить индикатор контекста в рейле сессии СРАЗУ (после done или из tail) — без ожидания поллинга.
export function updateRailContext(ctxPct, winTokens){
  const side = document.getElementById('sessionSide'); if (!side) return;
  if (typeof ctxPct === 'number'){
    const p = Math.round(ctxPct * 100), col = ctxColor(ctxPct);
    const bar = side.querySelector('.ctxbar i'); if (bar){ bar.style.width = p + '%'; bar.style.background = col; }
    const pct = side.querySelector('.ctx-pct'); if (pct){ pct.textContent = p + '%'; pct.style.color = col; }
  }
  if (typeof winTokens === 'number'){ const w = side.querySelector('.stat-win'); if (w) w.textContent = kTok(winTokens) + ' / 1M'; }
}
async function tailTick(file){
  if (S.currentFile !== file){ stopTail(); return; }
  if (S.streaming && S.streamingFile === file) return;   // Deck-стрим сам рендерит — не мешаем
  let d; try { const r = await fetch('/api/session-tail?file=' + encodeURIComponent(file) + '&after=' + S.tailCount, { cache:'no-store' }); d = await r.json(); } catch { return; }
  if (S.currentFile !== file || d.error) return;
  const stick = isNearBottom();            // фиксируем позицию ДО добавления блоков/индикатора
  if (Array.isArray(d.blocks) && d.blocks.length){
    const cons = ensureConsole();
    const ind = document.getElementById('tailInd');
    for (const b of d.blocks){ const el = appendHTML(cons, blockHTML(b)); if (el && ind) cons.insertBefore(el, ind); }
    if (typeof d.count === 'number') S.tailCount = d.count;
  } else if (typeof d.count === 'number') { S.tailCount = d.count; }
  updateTailIndicator(!!d.working, d.turnStartTs);   // «работает… Nс» пока файл пишется (< 20с) — индикатор в самом низу
  updateRailContext(d.ctxPct, d.winTokens);          // контекст рейла — сразу из tail, не ждём поллинг
  if (stick) scrollBottom();               // доскролл ПОСЛЕ появления индикатора (иначе он прячется под фолдом)
  if (!d.active) stopTail();                // сессия остыла — прекращаем tail
}
