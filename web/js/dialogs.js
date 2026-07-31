// Deck — модалки/диалоги: подложка modalBack, новая сессия/форк, удаление, обновления (Electron) и экран настроек.
// Вынесено из app.js; состояние — в store (S).
import { S, SESSION_CACHE, MODE_ORDER, MODE_LABEL } from './store.js';
import { esc } from './util.js';
import { toast } from './ui.js';
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
import { loadModelsCatalog, UI_BUILD } from './app.js';

export function modalBack(id){
  let back = document.getElementById(id);
  if (!back){ back = document.createElement('div'); back.id = id; back.className = 'deck-modal-back'; document.body.appendChild(back);
    back.addEventListener('click', e => { if (e.target === back) back.classList.remove('open'); }); }
  return back;
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

export function renderUpdateStatus(s){
  if (!s) return;
  if (S.UPDATE_DOWNLOAD_EL){
    S.UPDATE_DOWNLOAD_EL.style.display = (s.state === 'available') ? '' : 'none';   // «Обновить» — только когда апдейт найден и загрузка ещё не начата
    if (s.state === 'available'){ S.UPDATE_DOWNLOAD_EL.textContent = '↓ Обновить до ' + (s.version||''); S.UPDATE_DOWNLOAD_EL.disabled = false; }
  }
  if (S.UPDATE_INSTALL_EL) S.UPDATE_INSTALL_EL.style.display = (s.state === 'downloaded') ? '' : 'none';   // «Перезапустить» — только когда загружено
  if (S.UPDATE_PROGRESS_EL){
    const dl = s.state === 'downloading';
    S.UPDATE_PROGRESS_EL.hidden = !dl;
    if (dl){ const f = S.UPDATE_PROGRESS_EL.firstElementChild; if (f) f.style.width = (s.percent||0) + '%'; }
  }
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
export async function openUpdatesModal(){
  if (!(window.deckNative && window.deckNative.updateInfo)) return;   // только в Electron
  const info = await window.deckNative.updateInfo();
  const back = modalBack('updatesBack');
  back.innerHTML = `<div class="deck-modal"><div class="dm-head"><span>Обновления</span><button class="dm-x" type="button">✕</button></div>
    <div class="dm-body">
      <div class="dm-text">Текущая версия: <b>${esc(info.version||'?')}</b> · UI build: <b>${esc(UI_BUILD)}</b></div>
      ${String(info.version||'')!==UI_BUILD?'<div class="um-note" style="color:var(--warn)">⚠ Версия приложения и UI не совпали — нажмите «Проверить» и обновитесь до последней.</div>':''}
      <div class="um-note">«Проверить» → если есть новая версия, появится «Обновить»: скачает с прогрессом и тихо установит с перезапуском (без окна установщика). Пока не нажмёте — ничего не качается.</div>
      <div class="ns-actions" style="justify-content:flex-end"><button class="ns-start" id="updCheck" type="button">Проверить</button></div>
      <button class="ns-start" id="updDownload" type="button" style="display:none;width:100%;margin-top:10px">↓ Обновить</button>
      <button class="ns-start" id="updInstall" type="button" style="display:none;width:100%;margin-top:10px">↻ Перезапустить и установить</button>
      <div class="um-note" id="updStatus" style="margin-top:8px"></div>
      <div class="upd-progress" id="updProgress" hidden><i></i></div>
      ${info.packaged?'':'<div class="um-note">Проверка обновлений работает только в установленном приложении (не в dev-режиме).</div>'}
    </div></div>`;
  back.querySelector('.dm-x').addEventListener('click', ()=>{ back.classList.remove('open'); S.UPDATE_STATUS_EL=null; S.UPDATE_INSTALL_EL=null; S.UPDATE_DOWNLOAD_EL=null; S.UPDATE_PROGRESS_EL=null; });
  back.classList.add('open');
  S.UPDATE_STATUS_EL = back.querySelector('#updStatus'); S.UPDATE_INSTALL_EL = back.querySelector('#updInstall'); S.UPDATE_DOWNLOAD_EL = back.querySelector('#updDownload'); S.UPDATE_PROGRESS_EL = back.querySelector('#updProgress');
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
