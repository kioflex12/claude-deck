// Deck — модалки/диалоги: подложка modalBack, новая сессия/форк, удаление, обновления (Electron) и экран настроек.
// Вынесено из app.js; состояние — в store (S).
import { S, SESSION_CACHE, MODE_ORDER, MODE_LABEL, JIRA_CACHE, MR_CACHE } from './store.js';
import { esc } from './util.js';
import { toast, openExternal } from './ui.js';
import { mrKey } from './columns.js';
import { stopStream, runPrompt } from './stream.js';
import { renderComposer, paintMode, loadSkills } from './composer.js';
import { wireConsole } from './transcript.js';
import { setView } from './nav.js';
import { renderBoard } from './board.js';
import { requireAuth, renderServicesGate } from './auth.js';
import { activeProjectPath } from './projects.js';
import { MR_TTL_RESET } from './services.js';
import { pollSessions } from './notify.js';
import { loadUsage } from './usage.js';
import { loadEnvStatus } from './attention.js';
import { loadModelsCatalog, UI_BUILD } from './app.js';

export function modalBack(id){
  let back = document.getElementById(id);
  if (!back){ back = document.createElement('div'); back.id = id; back.className = 'deck-modal-back'; document.body.appendChild(back);
    back.addEventListener('click', e => { if (e.target === back) back.classList.remove('open'); }); }
  return back;
}

// Клиентские копии (cuN → рабочая копия client-N, как в аргументах /bugfix-*) и сквады — для форм режимов.
const CLIENT_COPIES = [1, 2, 3, 4];
const SQUADS = Array.from({ length: 30 }, (_, i) => i + 1);

// Собрать первый промт для режима bugfix: /bugfix-<env> <задача> <target>, где target = client-N [server] | server.
function buildBugfixPrompt(f){
  const parts = [];
  if (f.client) parts.push('client-' + f.client);
  if (f.server) parts.push('server');
  const target = parts.join(' ');
  let p = `/bugfix-${f.env} ${f.task} ${target}`.trim();
  if (f.desc) p += `\n\nОписание бага от разработчика: ${f.desc}`;
  return p;
}
// Собрать первый промт для режима dev-workflow: /dev-workflow start <задача> + блок готовых ответов, чтобы оркестратор
// не переспрашивал scope/копию/окружение (иначе он задал бы их через AskUserQuestion).
function buildDevWorkflowPrompt(f){
  let p = `/dev-workflow start ${f.task}`;
  const ans = [];
  if (f.scope) ans.push(`scope: ${f.scope}`);
  if (f.client) ans.push(`клиентская копия: cu${f.client} (client-unity-${f.client})`);
  if (f.env) ans.push(`окружение: ${f.env}`);
  if (ans.length) p += `\n\nПараметры для старта (используй их, не переспрашивай):\n- ` + ans.join('\n- ');
  if (f.desc) p += `\n\nКонтекст задачи: ${f.desc}`;
  return p;
}

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
  const clientOpts = CLIENT_COPIES.map(n=>`<option value="${n}">cu${n} (client-unity-${n})</option>`).join('');
  back.innerHTML = `<div class="deck-modal"><div class="dm-head"><span>Новая сессия</span><button class="dm-x" type="button">✕</button></div>
    <div class="dm-body">
      <label class="ns-lbl">Режим создания</label>
      <div class="ns-seg" id="nsCreateMode">
        <button type="button" class="ns-seg-b on" data-cm="normal">Обычный</button>
        <button type="button" class="ns-seg-b" data-cm="bugfix">Bugfix</button>
        <button type="button" class="ns-seg-b" data-cm="devworkflow">Dev-workflow</button>
      </div>
      <div id="nsModeFields"></div>
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
      <div class="um-note" id="nsNote">Сессия откроется пустой — промты пишешь уже в ней. Настройки применятся к первому запросу.</div>
      <div class="ns-actions"><button id="nsStart" class="ns-start" type="button">Создать</button></div>
    </div></div>`;
  back.querySelector('.dm-x').addEventListener('click', ()=>back.classList.remove('open'));

  let createMode = 'normal';
  const fieldsEl = back.querySelector('#nsModeFields');
  const nameEl = back.querySelector('#nsName');
  const noteEl = back.querySelector('#nsNote');
  const startEl = back.querySelector('#nsStart');
  const renderModeFields = ()=>{
    if (createMode === 'normal'){ fieldsEl.innerHTML = ''; nameEl.previousElementSibling.textContent = 'Имя сессии (так будет называться карточка)'; noteEl.textContent = 'Сессия откроется пустой — промты пишешь уже в ней. Настройки применятся к первому запросу.'; startEl.textContent = 'Создать'; return; }
    const isBug = createMode === 'bugfix';
    const envHtml = isBug
      ? `<select id="nsEnv" class="ns-inp"><option value="preprod">preprod</option><option value="preupdate">preupdate</option></select>`
      : `<select id="nsEnv" class="ns-inp"><option value="preprod">preprod</option><option value="preupdate">preupdate</option>${SQUADS.map(n=>`<option value="squad-${n}">squad-${n}</option>`).join('')}</select>`;
    const scopeHtml = isBug ? '' : `
      <label class="ns-lbl">Scope</label>
      <select id="nsScope" class="ns-inp"><option value="client">Клиент</option><option value="backend">Бекенд</option><option value="full">Оба</option></select>`;
    const serverHtml = isBug ? `<label class="ns-check"><input type="checkbox" id="nsServer"> + серверная часть</label>` : '';
    fieldsEl.innerHTML = `
      <label class="ns-lbl">Задача (WO-XXXX или ссылка на Jira)</label>
      <input id="nsTask" class="ns-inp" type="text" placeholder="напр. WO-13834" autocomplete="off">
      <label class="ns-lbl">Окружение</label>
      ${envHtml}
      ${scopeHtml}
      <label class="ns-lbl">Клиентская копия</label>
      <select id="nsClient" class="ns-inp">${clientOpts}</select>
      ${serverHtml}
      <label class="ns-lbl">Описание ${isBug ? 'бага' : 'задачи'} (необязательно)</label>
      <textarea id="nsDesc" class="ns-inp" rows="3" placeholder="что воспроизводится / что нужно сделать…"></textarea>`;
    nameEl.previousElementSibling.textContent = 'Имя сессии (необязательно — по умолчанию по задаче)';
    noteEl.textContent = isBug
      ? 'Контекст запустится сразу: соберём первый промт /bugfix-<окружение> и начнём починку.'
      : 'Контекст запустится сразу: соберём первый промт /dev-workflow start и начнём работу.';
    startEl.textContent = 'Создать и запустить';
  };
  back.querySelector('#nsCreateMode').addEventListener('click', e=>{
    const b = e.target.closest('.ns-seg-b'); if (!b) return;
    createMode = b.dataset.cm;
    back.querySelectorAll('.ns-seg-b').forEach(x=>x.classList.toggle('on', x===b));
    renderModeFields();
  });

  const submit = ()=>{
    const cwd = back.querySelector('#nsCwd').value;
    const name = nameEl.value.trim();
    const mode = back.querySelector('#nsMode').value;
    const model = back.querySelector('#nsModel').value;
    const effort = back.querySelector('#nsEffort').value;
    if (!cwd){ toast('Не выбрана рабочая папка'); return; }
    if (createMode === 'normal'){
      if (!name){ nameEl.focus(); return; }
      back.classList.remove('open');
      openPendingNewSession(cwd, name, mode, model, effort);
      return;
    }
    const task = (back.querySelector('#nsTask').value || '').trim();
    if (!task){ back.querySelector('#nsTask').focus(); return; }
    const env = back.querySelector('#nsEnv').value;
    const client = back.querySelector('#nsClient').value;
    const desc = (back.querySelector('#nsDesc').value || '').trim();
    let prompt, autoName;
    if (createMode === 'bugfix'){
      const server = back.querySelector('#nsServer').checked;
      if (!client && !server){ toast('Выберите клиентскую копию или серверную часть'); return; }
      prompt = buildBugfixPrompt({ env, task, client, server, desc });
      autoName = `Багфикс ${task} · ${env}`;
    } else {
      const scope = back.querySelector('#nsScope').value;
      prompt = buildDevWorkflowPrompt({ task, env, client, scope, desc });
      autoName = `Dev-workflow ${task}`;
    }
    back.classList.remove('open');
    openNewSession(cwd, prompt, mode, null, { name: name || autoName, model, effort });
  };
  startEl.addEventListener('click', submit);
  nameEl.addEventListener('keydown', e=>{ if (e.key==='Enter'){ e.preventDefault(); submit(); } });
  back.classList.add('open');
  setTimeout(()=>{ if (nameEl) nameEl.focus(); }, 60);
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
// Открыть пустую сессию Claude в КОНКРЕТНОЙ папке (напр. из ленты «Требует внимания» → разобрать незакоммиченную копию).
export function openNewSessionInDir(cwd, name){
  if (!cwd || !requireAuth()) return;
  const nm = name || (String(cwd).split(/[\\/]/).filter(Boolean).pop() || 'сессия');
  openPendingNewSession(cwd, nm, S.sessionMode || 'default', S.sessionModel || '', S.sessionEffort || '');
}
// Форк / режим-запуск остаются с промтом (продолжение контекста или собранный первый промт скилла): создаём и сразу
// отправляем. opts.name закрепляется как заголовок карточки, opts.model/effort — настройки первого запроса.
function openNewSession(cwd, prompt, mode, forkFile, opts={}){
  stopStream();
  S.currentFile = null; S.pendingNewSession = null;
  S.sessionMode = mode || 'default'; S.sessionModel = opts.model || S.sessionModel || ''; S.sessionEffort = opts.effort || S.sessionEffort || '';
  S.returnView = (S.activeView==='status'||S.activeView==='board') ? S.activeView : 'status';
  document.getElementById('viewBoard').style.display='none';
  document.getElementById('viewSkills').style.display='none';
  document.getElementById('viewMcp').style.display='none';
  document.getElementById('viewSession').style.display='flex';
  document.querySelectorAll('.tab').forEach(x=>x.setAttribute('aria-selected','false'));
  const proj = String(cwd).split(/[\\/]/).filter(Boolean).pop() || '';
  const title = opts.name || (forkFile ? 'Форк сессии…' : 'Новая сессия…');
  const backBtn = `<button class="back" id="backBtn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M15 18 9 12l6-6"/></svg> Назад</button>`;
  document.getElementById('sessionBar').innerHTML = backBtn + `<span class="sb-wo">${esc(proj)}</span><span class="sb-title">${esc(title)}</span>`;
  document.getElementById('backBtn').addEventListener('click', ()=>setView(S.returnView));
  document.getElementById('sessionSide').innerHTML = '<div class="sec"><div class="rail-hint">Новая сессия создаётся…</div></div>';
  document.getElementById('thread').innerHTML = '<div class="cx-console"></div>';
  wireConsole();
  renderComposer({ cwd, model:'—', ctxPct:0, wo:'', title: opts.name || 'Новая сессия', project: proj });
  paintMode();
  loadSkills(cwd);
  runPrompt(forkFile
    ? { text: prompt, mode, model: S.sessionModel, effort: S.sessionEffort, attachments: [], forkFile }
    : { text: prompt, mode, model: S.sessionModel, effort: S.sessionEffort, attachments: [], newSessionCwd: cwd, pendingName: opts.name || '' });
}

export function wireSideActions(t){
  const del = document.getElementById('delSessionBtn');
  if (del) del.addEventListener('click', () => openDeleteDialog(t.file, t.title));
  const fork = document.getElementById('forkBtn');
  if (fork) fork.addEventListener('click', () => openForkDialog(t));
}
export function openDeleteDialog(file, title){
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
export function openRenameDialog(file){
  const s = S.SESSIONS.find(x=>x.file===file);
  const back = modalBack('renameBack');
  back.innerHTML = `<div class="deck-modal"><div class="dm-head"><span>Изменить имя сессии</span><button class="dm-x" type="button">✕</button></div>
    <div class="dm-body">
      <label class="ns-lbl">Имя сессии (так будет называться карточка)</label>
      <input id="renameInp" class="ns-inp" type="text" autocomplete="off">
      <div class="ns-actions"><button id="renameSave" class="ns-start" type="button">Сохранить</button></div>
    </div></div>`;
  const inp = back.querySelector('#renameInp');
  if (inp) inp.value = (s && s.title) || '';   // через свойство, не атрибут — esc() не экранирует кавычки в имени
  const close = ()=>back.classList.remove('open');
  back.querySelector('.dm-x').addEventListener('click', close);
  const submit = async ()=>{
    const name = inp.value.trim();
    if (!name){ inp.focus(); return; }
    try {
      const r = await fetch('/api/session-name', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ file, name }) });
      const d = await r.json();
      if (!r.ok || (d && d.error)) throw new Error((d && d.error) || 'rename failed');
      const applied = (d && d.name) || name;
      const se = S.SESSIONS.find(x=>x.file===file); if (se) se.title = applied;
      if (SESSION_CACHE[file]) SESSION_CACHE[file].title = applied;
      renderBoard(false);
      if (S.currentFile === file){ const tl = document.querySelector('#sessionBar .sb-title'); if (tl) tl.textContent = applied; }
      toast('Имя обновлено');
    } catch (e){ toast('Не удалось переименовать: ' + (e.message||e)); }
    close();
  };
  back.querySelector('#renameSave').addEventListener('click', submit);
  inp.addEventListener('keydown', e=>{ if (e.key==='Enter'){ e.preventDefault(); submit(); } });
  back.classList.add('open');
  setTimeout(()=>{ const p = back.querySelector('#renameInp'); if (p) p.focus(); }, 60);
}
export function openForkDialog(t){
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

// -------- Фаза-4: быстрые действия с карточки (прямые API-записи, каждое — после явного подтверждения) --------
// Имя репо GitLab по скоупу задачи — для резолва проекта при создании MR.
function repoHintForScope(s){
  if (s.clientCu) return 'client-unity';
  if (s.backend) return 'backend-services';
  if (s.statics) return 'staticsutils';
  return '';
}
// Черновик отчёта в Jira из уже известных Deck данных (ветка, статус, MR, сборка) — пользователь правит перед отправкой.
function quickReportDraft(s){
  const lines = [];
  if (s.gitBranch) lines.push(`Ветка: ${s.gitBranch}${s.baseBranch?` → ${s.baseBranch}`:''}`);
  const j = s.wo && JIRA_CACHE[s.wo];
  if (j && j.available && j.status) lines.push(`Статус Jira: ${j.status}`);
  const mrs = MR_CACHE[mrKey(s)] && MR_CACHE[mrKey(s)].mrs;
  if (mrs && mrs.length) lines.push('MR: ' + mrs.slice(0,3).map(m=>`!${m.iid} (${m.state})`).join(', '));
  else if (s.wfMrUrl) lines.push('MR: ' + s.wfMrUrl);
  if (s.buildActive) lines.push('Сборка: идёт'); else if (s.buildFailed) lines.push('Сборка: упала'); else if (s.wfBuildState==='done') lines.push('Сборка: готова');
  return lines.join('\n');
}
export function openQuickJiraDialog(s){
  if (!s.wo){ toast('У сессии нет задачи WO — отчёт в Jira недоступен'); return; }
  const back = modalBack('qjiraBack');
  back.innerHTML = `<div class="deck-modal"><div class="dm-head"><span>Отчёт в Jira · ${esc(s.wo)}</span><button class="dm-x" type="button">✕</button></div>
    <div class="dm-body">
      <div class="um-note">Комментарий уйдёт в задачу под вашим Jira-аккаунтом (токен из настроек). Правьте текст перед отправкой.</div>
      <textarea id="qjBody" class="ns-inp" rows="6"></textarea>
      <div class="ns-actions"><button class="btn-ghost dm-cancel" type="button">Отмена</button><button class="ns-start" id="qjSend" type="button">Отправить в Jira</button></div>
      <div class="um-note" id="qjStatus" style="margin-top:6px"></div>
    </div></div>`;
  const ta = back.querySelector('#qjBody'); ta.value = quickReportDraft(s);
  const close = ()=>back.classList.remove('open');
  back.querySelector('.dm-x').addEventListener('click', close);
  back.querySelector('.dm-cancel').addEventListener('click', close);
  back.querySelector('#qjSend').addEventListener('click', async ()=>{
    const body = ta.value.trim(); if (!body){ ta.focus(); return; }
    const st = back.querySelector('#qjStatus'); st.textContent = 'Отправляю…';
    let r; try { r = await (await fetch('/api/jira-comment', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ wo: s.wo, body }) })).json(); } catch { st.textContent = 'Ошибка запроса.'; return; }
    if (!r.ok){ st.textContent = '✗ ' + (r.error||'не удалось'); return; }
    toast('Комментарий добавлен в ' + s.wo); close();
  });
  back.classList.add('open');
  setTimeout(()=>{ ta.focus(); }, 60);
}
export function openCreateMrDialog(s){
  const source = s.gitBranch || '';
  if (!source){ toast('У сессии нет рабочей ветки — MR создать не из чего'); return; }
  const back = modalBack('cmrBack');
  const target = s.baseBranch || 'preprod';
  const title = (s.wo?`[${s.wo}] `:'') + (s.title || source);
  back.innerHTML = `<div class="deck-modal"><div class="dm-head"><span>Создать MR</span><button class="dm-x" type="button">✕</button></div>
    <div class="dm-body">
      <div class="um-note">MR создастся в GitLab под вашим токеном. Репозиторий определяется по имени — поправьте, если не тот.</div>
      <label class="ns-lbl">Из ветки</label><input id="cmrSrc" class="ns-inp" type="text" value="${esc(source)}">
      <label class="ns-lbl">В ветку</label><input id="cmrTgt" class="ns-inp" type="text" value="${esc(target)}">
      <label class="ns-lbl">Репозиторий (поиск в GitLab)</label><input id="cmrRepo" class="ns-inp" type="text" value="${esc(repoHintForScope(s))}" placeholder="client-unity / backend-services / staticsutils">
      <label class="ns-lbl">Заголовок MR</label><input id="cmrTitle" class="ns-inp" type="text" value="${esc(title)}">
      <div class="ns-actions"><button class="btn-ghost dm-cancel" type="button">Отмена</button><button class="ns-start" id="cmrSend" type="button">Создать MR</button></div>
      <div class="um-note" id="cmrStatus" style="margin-top:6px"></div>
    </div></div>`;
  const close = ()=>back.classList.remove('open');
  back.querySelector('.dm-x').addEventListener('click', close);
  back.querySelector('.dm-cancel').addEventListener('click', close);
  back.querySelector('#cmrSend').addEventListener('click', async ()=>{
    const payload = {
      sourceBranch: back.querySelector('#cmrSrc').value.trim(),
      targetBranch: back.querySelector('#cmrTgt').value.trim(),
      repoHint: back.querySelector('#cmrRepo').value.trim(),
      title: back.querySelector('#cmrTitle').value.trim(),
    };
    const st = back.querySelector('#cmrStatus'); st.textContent = 'Создаю MR…';
    let r; try { r = await (await fetch('/api/create-mr', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) })).json(); } catch { st.textContent = 'Ошибка запроса.'; return; }
    if (!r.ok){ st.textContent = '✗ ' + (r.error||'не удалось'); return; }
    toast('MR !' + r.iid + ' создан'); close();
    if (r.web_url) openExternal(r.web_url);
    delete MR_CACHE[mrKey(s)];   // сбросить кэш — новый MR подтянется на ближайшем поллинге
    if (typeof pollSessions === 'function') pollSessions(true);
  });
  back.classList.add('open');
}
// dev-сборки клиента (совпадают с TC_BUILD_TYPES в services.mjs)
const DEV_BUILD_TYPES = [{ id:'Wo_Client_Development_Android', plat:'Android' }, { id:'Wo_Client_Development_IOS', plat:'iOS' }];
export function openDeployDialog(s){
  const branch = s.gitBranch || '';
  if (!branch){ toast('У сессии нет рабочей ветки — деплоить нечего'); return; }
  const back = modalBack('depBack');
  const cbs = DEV_BUILD_TYPES.map((b,i)=>`<label class="dep-cb"><input type="checkbox" data-bt="${esc(b.id)}"${i===0?' checked':''}> ${esc(b.plat)}</label>`).join('');
  back.innerHTML = `<div class="deck-modal"><div class="dm-head"><span>Деплой (сборка клиента)</span><button class="dm-x" type="button">✕</button></div>
    <div class="dm-body">
      <div class="um-note" style="color:var(--warn)">⚠ Поставит РЕАЛЬНУЮ сборку в очередь TeamCity для ветки <b>${esc(branch)}</b>. Это израсходует агент сборки.</div>
      <div class="dep-cbs">${cbs}</div>
      <div class="ns-actions"><button class="btn-ghost dm-cancel" type="button">Отмена</button><button class="ns-start" id="depSend" type="button">Запустить сборку</button></div>
      <div class="um-note" id="depStatus" style="margin-top:6px"></div>
    </div></div>`;
  const close = ()=>back.classList.remove('open');
  back.querySelector('.dm-x').addEventListener('click', close);
  back.querySelector('.dm-cancel').addEventListener('click', close);
  back.querySelector('#depSend').addEventListener('click', async ()=>{
    const picked = [...back.querySelectorAll('.dep-cb input:checked')].map(i=>i.dataset.bt);
    if (!picked.length){ back.querySelector('#depStatus').textContent = 'Выберите платформу.'; return; }
    const st = back.querySelector('#depStatus'); st.textContent = 'Ставлю в очередь…';
    const results = [];
    for (const buildTypeId of picked){
      let r; try { r = await (await fetch('/api/trigger-build', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ buildTypeId, branch }) })).json(); } catch { r = { ok:false, error:'запрос не прошёл' }; }
      results.push({ buildTypeId, r });
    }
    const ok = results.filter(x=>x.r.ok).length;
    if (ok){ toast('Сборок в очереди: ' + ok); if (typeof pollSessions === 'function') pollSessions(true); }
    const fail = results.filter(x=>!x.r.ok);
    st.textContent = (ok?`✓ поставлено: ${ok}`:'') + (fail.length?`  ✗ ошибки: ` + fail.map(x=>x.r.error).join('; '):'');
    if (!fail.length) setTimeout(close, 900);
  });
  back.classList.add('open');
}

export function renderUpdateStatus(s){
  if (!s) return;
  if (S.UPDATE_DOWNLOAD_EL){
    S.UPDATE_DOWNLOAD_EL.style.display = (s.state === 'available') ? '' : 'none';   // «Обновить» — только когда апдейт найден и загрузка ещё не начата
    if (s.state === 'available'){ S.UPDATE_DOWNLOAD_EL.textContent = '↓ Обновить до ' + (s.version||''); S.UPDATE_DOWNLOAD_EL.disabled = false; }
  }
  if (S.UPDATE_INSTALL_EL) S.UPDATE_INSTALL_EL.style.display = (s.state === 'downloaded') ? '' : 'none';   // «Перезапустить» — только когда загружено
  const dl = s.state === 'downloading';
  if (S.UPDATE_PROGRESS_EL){
    S.UPDATE_PROGRESS_EL.hidden = !dl;
    if (dl){ const f = S.UPDATE_PROGRESS_EL.firstElementChild; if (f) f.style.width = (s.percent||0) + '%'; }
  }
  if (S.UPDATE_CANCEL_EL) S.UPDATE_CANCEL_EL.style.display = dl ? '' : 'none';   // крестик отмены — только пока идёт загрузка
  if (!S.UPDATE_STATUS_EL) return;
  const m = {
    checking:'Проверяю обновления…', 'not-available':'У вас последняя версия.',
    available:'Доступна версия '+(s.version||'')+'. Нажмите «Обновить».',
    downloading:'Загрузка… '+(s.percent||0)+'%',
    downloaded:'Обновление '+(s.version||'')+' загружено (проверено по sha512). Нажмите «Перезапустить и установить» — само по себе не установится.',
    error:'Ошибка обновления: '+(s.message||''), dev:'Обновления доступны только в установленном приложении.',
  };
  S.UPDATE_STATUS_EL.textContent = m[s.state] || s.state || '';
}
export async function openUpdatesModal(){
  if (!(window.deckNative && window.deckNative.updateInfo)) return;   // только в Electron
  const info = await window.deckNative.updateInfo();
  const back = modalBack('updatesBack');
  back.innerHTML = `<div class="deck-modal"><div class="dm-head"><span>Обновления</span><button class="dm-x" type="button">✕</button></div>
    <div class="dm-body">
      <div class="dm-text">Текущая версия: <b>${esc(info.version||'?')}</b> · UI build: <b>${esc(UI_BUILD)}</b></div>
      ${String(info.version||'')!==UI_BUILD?'<div class="um-note" style="color:var(--warn)">⚠ Версия приложения и UI не совпали — нажмите «Проверить» и обновитесь до последней.</div>':''}
      <div class="um-note">«Проверить» → если есть новая версия, появится «Обновить»: скачает с прогрессом. Установка — только по кнопке «Перезапустить и установить» (сама при выходе не ставится). Сборка не подписана; целостность — sha512 из GitHub-релиза по HTTPS.</div>
      <div class="ns-actions" style="justify-content:flex-end"><button class="ns-start" id="updCheck" type="button">Проверить</button></div>
      <button class="ns-start" id="updDownload" type="button" style="display:none;width:100%;margin-top:10px">↓ Обновить</button>
      <button class="ns-start" id="updInstall" type="button" style="display:none;width:100%;margin-top:10px">↻ Перезапустить и установить</button>
      <div class="um-note" id="updStatus" style="margin-top:8px"></div>
      <div class="upd-progress" id="updProgress" hidden><i></i></div>
      <button class="btn-ghost" id="updCancel" type="button" style="display:none;width:100%;margin-top:8px">✕ Отменить загрузку</button>
      ${info.packaged?'':'<div class="um-note">Проверка обновлений работает только в установленном приложении (не в dev-режиме).</div>'}
    </div></div>`;
  back.querySelector('.dm-x').addEventListener('click', ()=>{ back.classList.remove('open'); S.UPDATE_STATUS_EL=null; S.UPDATE_INSTALL_EL=null; S.UPDATE_DOWNLOAD_EL=null; S.UPDATE_PROGRESS_EL=null; S.UPDATE_CANCEL_EL=null; });
  back.classList.add('open');
  S.UPDATE_STATUS_EL = back.querySelector('#updStatus'); S.UPDATE_INSTALL_EL = back.querySelector('#updInstall'); S.UPDATE_DOWNLOAD_EL = back.querySelector('#updDownload'); S.UPDATE_PROGRESS_EL = back.querySelector('#updProgress'); S.UPDATE_CANCEL_EL = back.querySelector('#updCancel');
  S.UPDATE_CANCEL_EL.addEventListener('click', async ()=>{ S.UPDATE_STATUS_EL.textContent='Отменяю загрузку…'; try { await window.deckNative.cancelUpdate(); } catch {} });
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

// Настройки: рендер строки поля. Типы: text (✓ прямо в инпуте), path (инпут + «Обзор…» + ✓/очистка),
// token (задан → «✓ задан» + «удалить» ВМЕСТО инпута; не задан → инпут для вставки). state={value}|{set}.
function nsFieldHtml(f, state, hasNative){
  state = state || {};
  const tokHelp = f.type==='token' ? `<button class="ns-tokget" type="button" data-fid="${f.id}" data-svc="${esc(f.svc||'')}" title="Открыть страницу, где взять или сгенерировать токен">🔑 Взять токен</button>` : '';
  if (f.type==='token' && state.set){
    return `<div class="ns-row" data-fid="${f.id}">
      <label class="ns-lbl">${esc(f.label)}</label>
      <div class="ns-tokset"><span class="tok-ok">✓ задан</span><button class="fld-del" type="button" data-fid="${f.id}">удалить</button>${tokHelp}</div>
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
      ${browse}${clr}${tokHelp}
    </div>
  </div>`;
}
export async function openSettingsModal(){
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
  const testRow = (svc)=> `<div class="ns-actions" style="justify-content:flex-start;margin:2px 0 8px"><button class="btn-ghost svc-test" type="button" data-svc="${svc}">Проверить подключение</button><span class="svc-test-res" data-svc="${svc}"></span></div>`;
  back.innerHTML = `<div class="deck-modal"><div class="dm-head"><span>Настройки</span><button class="dm-x" type="button">✕</button></div>
    <div class="dm-body">
      <div class="ns-summary" id="setSummary"></div>
      <div class="ns-actions" style="justify-content:flex-start;margin:2px 0 4px;flex-wrap:wrap;gap:6px">
        <button class="btn-ghost" id="setImport" type="button" title="Автоимпорт из .env / ~/.claude.json / MCP / системных переменных">⤵ Подтянуть токены</button>
        <button class="btn-ghost" id="setExportBtn" type="button" title="Сохранить настройки (хосты, пути, токены) в файл для переноса на другой ПК">⬆ Экспорт в файл</button>
        <button class="btn-ghost" id="setImportFileBtn" type="button" title="Загрузить настройки из файла, полученного с настроенного ПК">⬇ Импорт из файла</button>
        <input type="file" id="setImportFile" accept=".json,application/json" hidden>
      </div>
      <div class="um-note" style="margin:0 0 6px;color:var(--text-faint)">Перенос на другой ПК: на настроенном — «Экспорт в файл», на новом — «Импорт из файла» (заполнит всё разом). Файл содержит токены — передавай безопасно.</div>
      <div class="um-note" id="setImportRes" style="margin:0 0 8px"></div>
      ${row('setEnv')}${row('setWo')}${row('setProj')}
      <div class="ns-grouphd">Jira — колонка «Статусы» и живые статусы задач</div>
      ${row('setJh')}${row('setJe')}${row('setJt')}${testRow('jira')}
      <div class="ns-grouphd">TeamCity — рейл «Сборки» (статус Android/iOS-билдов)</div>
      ${row('setTh')}${row('setTt')}${testRow('teamcity')}
      <div class="ns-grouphd">GitLab — секция «Merge Requests» (живые MR по ветке)</div>
      ${row('setGh')}${row('setGt')}${testRow('gitlab')}
      <div class="ns-grouphd">Окружения — мониторинг доступности (лента «Требует внимания»)</div>
      <div class="ns-row"><label class="ns-lbl" for="setEnvHosts">Health-проверки: по строке «имя = URL»</label>
        <textarea id="setEnvHosts" class="ns-inp" rows="3" placeholder="preprod = https://preprod-api…/health&#10;preupdate = https://preupdate-api…/health"></textarea></div>
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
  const ehInit = back.querySelector('#setEnvHosts'); if (ehInit) ehInit.value = cfg.envHosts || '';   // значение через свойство: в атрибуте переносы строк не сохранить
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
    const tg = el.querySelector('.ns-tokget');   // «Взять токен» → страница выпуска токена сервиса (host из соседнего поля)
    if (tg) tg.addEventListener('click', ()=>{
      let url = '';
      if (f.svc==='jira') url = 'https://id.atlassian.com/manage-profile/security/api-tokens';
      else {
        let h = String((f.svc==='teamcity' ? st.setTh.value : st.setGh.value) || '').trim();
        if (h){ if (!/^https?:\/\//i.test(h)) h = 'https://' + h; h = h.replace(/\/+$/, ''); url = f.svc==='teamcity' ? h + '/profile.html?item=accessTokens' : h + '/-/user_settings/personal_access_tokens'; }
      }
      if (!url){ toast('Укажите host сервиса в поле выше — тогда открою страницу токенов'); return; }
      openExternal(url);
    });
  }
  Object.keys(FIELDS).forEach(wireRow);
  updSummary();
  // Синхронизация полей формы со свежим конфигом (после «Подтянуть» / импорта файла): токены → «✓ задан», хосты/пути → значения.
  const syncFromConfig = (c)=>{
    if (!c) return;
    const applyTok = (id, on)=>{ if (on && !st[id].set){ st[id].set = true; repaint(id); } };
    applyTok('setJt', c.jira && c.jira.tokenSet); applyTok('setTt', c.teamcity && c.teamcity.tokenSet); applyTok('setGt', c.gitlab && c.gitlab.tokenSet);
    const applyVal = (id, v)=>{ if (v==null) return; st[id].value = v; repaint(id); };
    applyVal('setWo', c.woStatesDir); applyVal('setProj', c.claudeProjectsDir);
    if (c.jira){ applyVal('setJh', c.jira.host); applyVal('setJe', c.jira.email); }
    if (c.teamcity) applyVal('setTh', c.teamcity.host);
    if (c.gitlab) applyVal('setGh', c.gitlab.host);
    if (c.unity){ applyVal('setCup', c.unity.clientUnityParent); applyVal('setUed', c.unity.editorsDir); applyVal('setUhub', c.unity.hubPath); }
    const eh = back.querySelector('#setEnvHosts'); if (eh && typeof c.envHosts==='string') eh.value = c.envHosts;
    updSummary(); renderServicesGate(c);
  };
  // «Проверить подключение»: бьём тест-эндпоинт значениями ИЗ ПОЛЕЙ (можно проверить до сохранения; пустой токен в
  // поле → сервер возьмёт сохранённый). Отличает неверный хост (404/нет связи) от учётки (401/403) от рабочего (200).
  async function testSvc(svc){
    const resEl = back.querySelector('.svc-test-res[data-svc="'+svc+'"]'); if (!resEl) return;
    const btn = back.querySelector('.svc-test[data-svc="'+svc+'"]');
    const body = { svc };
    if (svc==='jira'){ body.host = st.setJh.value.trim(); body.email = st.setJe.value.trim(); body.token = tokVal('setJt').trim(); }
    else if (svc==='teamcity'){ body.host = st.setTh.value.trim(); body.token = tokVal('setTt').trim(); }
    else if (svc==='gitlab'){ body.host = st.setGh.value.trim(); body.token = tokVal('setGt').trim(); }
    resEl.className = 'svc-test-res'; resEl.textContent = 'Проверяю…'; if (btn) btn.disabled = true;
    let r; try { r = await (await fetch('/api/config/test', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) })).json(); } catch { r = { ok:false, message:'Ошибка запроса' }; }
    if (btn) btn.disabled = false;
    resEl.textContent = (r.ok ? '✓ ' : '✗ ') + (r.message||'');
    resEl.classList.add(r.ok ? 'ok' : 'err');
  }
  back.querySelectorAll('.svc-test').forEach(b => b.addEventListener('click', ()=>testSvc(b.dataset.svc)));
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
    syncFromConfig(r.config || {});
    if (typeof pollSessions === 'function') await pollSessions();   // подтянулся WO_STATES_DIR/Jira → доска получит стадии
    if (typeof loadUsage === 'function') loadUsage();
  });
  // Экспорт настроек в файл (для переноса на другой ПК).
  back.querySelector('#setExportBtn').addEventListener('click', async ()=>{
    let b; try { b = await (await fetch('/api/config/export', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ includeTokens:true }) })).json(); } catch { toast('Ошибка экспорта'); return; }
    try { const blob = new Blob([JSON.stringify(b, null, 2)], { type:'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'deck-settings.json'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url), 2000); toast('Настройки → deck-settings.json (содержит токены — передавай безопасно)'); }
    catch { toast('Не удалось сохранить файл'); }
  });
  // Импорт настроек из файла.
  const impInput = back.querySelector('#setImportFile');
  const impBtn = back.querySelector('#setImportFileBtn'); if (impBtn && impInput) impBtn.addEventListener('click', ()=> impInput.click());
  if (impInput) impInput.addEventListener('change', async ()=>{
    const f = impInput.files && impInput.files[0]; if (!f) return;
    let b; try { b = JSON.parse(await f.text()); } catch { toast('Файл не читается (не JSON)'); impInput.value=''; return; }
    let r; try { r = await (await fetch('/api/config/import', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(b) })).json(); } catch { toast('Ошибка импорта'); impInput.value=''; return; }
    impInput.value='';
    if (!r || !r.ok){ toast('Импорт не удался: ' + ((r&&r.error)||'')); return; }
    syncFromConfig(r.config || {});
    toast('Настройки импортированы');
    if (typeof pollSessions === 'function') await pollSessions();
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
      envHosts: (back.querySelector('#setEnvHosts') && back.querySelector('#setEnvHosts').value) || '',
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
    if (typeof loadEnvStatus === 'function') loadEnvStatus();   // изменили список окружений → перечитать health
    setTimeout(close, 900);
  });
}
