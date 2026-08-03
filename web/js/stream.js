// Deck — движок живого ответа: SSE-стрим Agent SDK (runPrompt), inline-аппрувы инструментов,
// обрыв по Стоп, live-tail ленты при перезаходе и периодический рефреш правого рейла. Состояние — в store (S).
import { S, notifiedDone, notifiedInput, SESSION_CACHE, promptQueue } from './store.js';
import { esc, mdToHtml, ctxColor, kTok } from './util.js';
import { appendHTML, blockHTML, attachThumbsHTML, scrollBottom, isNearBottom, wireConsole } from './transcript.js';
import { clearQueue, setComposerBusy, updateQueueIndicator, drainQueue } from './composer.js';
import { loadBuilds, loadMrs, loadJira, wireTags, stopAgentsPoll } from './services.js';
import { ensureNotifyPermission, titleOf, notifyDone, notifyInput } from './notify.js';
import { sideHTML, wireRailTabs } from './rail.js';
import { launchUnity } from './unity.js';
import { wireSideActions } from './dialogs.js';
import { openSession, renderRail, refreshRailFields } from './session.js';

// Обрыв стрима кнопкой Стоп — надёжно, независимо от детекта дисконнекта: /api/stop + локальный finish/hard-reset.
export function userStop(){
  if (S.currentStreamId){ fetch('/api/stop?id=' + encodeURIComponent(S.currentStreamId), { cache:'no-store' }).catch(()=>{}); }
  else if (S.currentFile){ fetch('/api/stop?file=' + encodeURIComponent(S.currentFile), { cache:'no-store' }).catch(()=>{}); }   // после перезахода streamId потерян — рвём фоновый ход по файлу сессии
  else { clearQueue(); return; }
  if (S.liveFinish){ S.liveFinish('Остановлено пользователем', { silent:true, stopped:true }); return; }
  // нет живого стрима (перезаход / tail-режим) — гасим индикацию/tail сами
  if (S.currentES){ try { S.currentES.close(); } catch {} S.currentES = null; }
  if (S.streamTimer){ clearInterval(S.streamTimer); S.streamTimer = null; }
  stopTail();
  document.querySelectorAll('.cx-run-chat').forEach(el => el.remove());
  S.streamingFile = null; S.currentStreamId = null; setComposerBusy(false); clearQueue();
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
  notifiedInput.clear();                                 // дедуп «требуется ответ» — по сессии; уходя, сбрасываем
  // жёсткий сброс UI стрима: убрать индикатор «работает» и снять недостроенный live-блок из чата
  document.querySelectorAll('.cx-run-chat').forEach(el => el.remove());
  document.querySelectorAll('.cx-asst.cx-live').forEach(el => el.classList.remove('cx-live'));
}

export function ensureConsole(){
  const thread = document.getElementById('thread');
  let cons = thread.querySelector('.cx-console');
  if (!cons){ thread.innerHTML = '<div class="cx-console"></div>'; cons = thread.querySelector('.cx-console'); wireConsole(); }
  return cons;
}

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

export function approvalCardHTML(d){
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

export function wireApproval(el, d){
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

// Карточка вопроса к пользователю (AskUserQuestion/ExitPlanMode): режим НЕ отвечает за пользователя — вопрос всегда
// показываем и ждём выбор. d = { id, questions:[{ question, header, plan?, options:[{label,description}], multiSelect }] }.
export function questionCardHTML(d){
  const questions = Array.isArray(d.questions) ? d.questions : [];
  const single = questions.length === 1 && !questions[0].multiSelect;   // один single-select → отвечаем сразу по клику
  const qs = questions.map((q, qi) => {
    const head = q.header ? `<div class="q-head">${esc(String(q.header))}</div>` : '';
    const text = q.question ? `<div class="q-text">${esc(String(q.question))}</div>` : '';
    const plan = q.plan ? `<pre class="q-plan">${esc(String(q.plan))}</pre>` : '';
    const opts = Array.isArray(q.options) ? q.options : [];
    const btns = opts.map(o => {
      const label = String(o && o.label != null ? o.label : o);
      const desc = o && o.description ? `<span class="q-opt-desc">${esc(String(o.description))}</span>` : '';
      return `<button class="q-opt" type="button" data-label="${esc(label)}"><span class="q-opt-label">${esc(label)}</span>${desc}</button>`;
    }).join('');
    return `<div class="q-block" data-multi="${q.multiSelect ? '1' : '0'}" data-question="${esc(String(q.question || ''))}">${head}${text}${plan}<div class="q-opts">${btns}</div></div>`;
  }).join('');
  return `<div class="cx-msg cx-question" data-id="${esc(d.id)}" data-single="${single ? '1' : '0'}">
    <div class="q-title"><span class="q-icon">💬</span>Вопрос от Claude</div>
    ${qs}
    <div class="q-foot"><button class="q-submit" type="button">Ответить</button></div>
    <div class="q-result" hidden></div>
  </div>`;
}

function collectAnswers(el){
  const answers = {};
  el.querySelectorAll('.q-block').forEach(blk => {
    const qtext = blk.dataset.question || '';
    const sel = [...blk.querySelectorAll('.q-opt.sel')].map(b => b.dataset.label);
    if (sel.length) answers[qtext] = sel.join(', ');   // multiSelect → лейблы через запятую
  });
  return answers;
}

async function submitAnswers(el, d){
  if (el.classList.contains('q-resolved')) return;
  const answers = collectAnswers(el);
  if (!Object.keys(answers).length) return;   // ничего не выбрано — ждём выбор пользователя
  el.classList.add('q-resolved');
  el.querySelectorAll('.q-opt, .q-submit').forEach(b => b.disabled = true);
  try { await fetch('/api/answer', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ id: d.id, answers }) }); } catch {}
  const foot = el.querySelector('.q-foot'); if (foot) foot.remove();
  const r = el.querySelector('.q-result'); if (r){ r.hidden = false; r.textContent = 'Ответ отправлен: ' + Object.values(answers).join(' · '); }
}

export function wireQuestion(el, d){
  if (!el) return;
  const single = el.dataset.single === '1';
  el.querySelectorAll('.q-opt').forEach(b => b.addEventListener('click', () => {
    if (el.classList.contains('q-resolved')) return;
    const blk = b.closest('.q-block'); if (!blk) return;
    const multi = blk.dataset.multi === '1';
    if (multi) b.classList.toggle('sel');
    else { blk.querySelectorAll('.q-opt').forEach(x => x.classList.remove('sel')); b.classList.add('sel'); }
    if (single && !multi) submitAnswers(el, d);   // единственный single-select вопрос — сразу отправляем
  }));
  const sb = el.querySelector('.q-submit'); if (sb) sb.addEventListener('click', () => submitAnswers(el, d));
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
  let t0 = Date.now();
  let waiting = false;   // висит вопрос/аппрув — Claude ЖДЁТ ответа, а не работает: индикатор меняется, таймер замирает
  let activity = '';     // что ИМЕННО делает сейчас: инструмент/размышление/ответ (обновляется по событиям SSE)
  const paintRun = () => {
    const el = runEl.querySelector('.cx-run-txt'); if (!el) return;
    const sp = runEl.querySelector('.cx-spin'); if (sp) sp.style.display = waiting ? 'none' : '';
    el.textContent = waiting ? '⏳ Ожидает вашего ответа' : ((activity || '✻ Claude работает') + '… ' + Math.round((Date.now()-t0)/1000) + 'с');
  };
  S.streamTimer = setInterval(paintRun, 1000);

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
          const side = document.getElementById('sessionSide'); if (side){ side.innerHTML = sideHTML(t); document.querySelectorAll('#sessionSide .sc-cu-run').forEach(el=>el.addEventListener('click',()=>launchUnity(el.dataset.cu,el.dataset.cwd))); wireTags(); wireSideActions(t); wireRailTabs(); loadBuilds(t); loadMrs(t); loadJira(t); }
          appendHTML(cons, '<div class="cx-note">Запуск не дал ответа — сообщений в сессии нет. Если это упакованное приложение и ошибка повторяется, пришлите текст ошибки выше.</div>');
        }
      }, 700);
    } else if (!(opts && opts.stopped)) {
      // синхронизируем курсор live-tail с диском БЕЗ перерисовки (сохраняем live-блоки, включая размышление).
      // При Стопе НЕ перезапускаем tail: ход оборван, иначе tail всплыл бы призраком «работает» (баг «после Стопа появилось-исчезло»).
      setTimeout(async () => {
        if (S.currentFile !== f || S.streaming) return;
        try { const r = await fetch('/api/session-tail?file=' + encodeURIComponent(f) + '&after=0', { cache:'no-store' }); const dd = await r.json(); if (typeof dd.count === 'number') S.tailCount = dd.count; if (dd.serverActive) startTail(f); } catch {}
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
      if (waiting){ waiting = false; t0 = Date.now(); }   // пришёл ответ модели — снова «работает», таймер шага сброшен
      activity = '✍ пишет ответ'; paintRun();
      finalizeThink();                   // размышление закончилось — начинается ответ
      if (!liveMd) startNewMd();
      liveAccum += d.delta;
      liveMd.innerHTML = mdToHtml(liveAccum);
      if (stick) scrollBottom();
    } else if (d.type === 'thinking'){
      const piece = d.delta || '';
      if (liveThink || piece.trim()){        // блок создаём только с первым НЕПУСТЫМ thinking_delta
        if (activity !== '✻ размышляет'){ activity = '✻ размышляет'; paintRun(); }
        clearLive();
        if (!liveThink) startNewThink();
        liveThinkAccum += piece;
        liveThink.innerHTML = mdToHtml(liveThinkAccum);
        if (stick) scrollBottom();
      }
    } else if (d.type === 'tool'){
      waiting = false; t0 = Date.now(); activity = '⚙ ' + d.name; paintRun();   // новый инструмент = новый шаг → таймер сбрасывается + показываем что за инструмент
      clearLive(); finalizeThink();   // следующий текст пойдёт в новый блок
      addBlock('<div class="cx-msg cx-twrap"><div class="cx-tool"><span class="cx-tw">·</span><span class="cx-mk">⏺</span><span class="cx-name">' + esc(d.name) + '</span></div></div>');
      if (stick) scrollBottom();
    } else if (d.type === 'approval'){
      waiting = true; paintRun();     // ждём решения пользователя — не «работает»
      clearLive(); finalizeThink();   // карточка аппрува — новый элемент ленты
      const el = addBlock(approvalCardHTML(d));
      wireApproval(el, d);
      notifyInput(S.streamingFile || S.currentFile, d.id, titleOf(S.streamingFile || S.currentFile));   // «требуется ответ» — если юзер не смотрит
      if (stick) scrollBottom();
    } else if (d.type === 'question'){
      waiting = true; paintRun();     // ждём ответа пользователя — не «работает»
      clearLive(); finalizeThink();   // карточка вопроса — новый элемент ленты
      const el = addBlock(questionCardHTML(d));
      wireQuestion(el, d);
      notifyInput(S.streamingFile || S.currentFile, d.id, titleOf(S.streamingFile || S.currentFile));   // «требуется ответ» — если юзер не смотрит
      if (stick) scrollBottom();
    } else if (d.type === 'session'){   // Part 3: узнали файл новой сессии — с этого момента метим её
      S.currentFile = d.file; S.streamingFile = d.file; S.tailCount = 0;
      const nm = payload.pendingName || (S.pendingNewSession && S.pendingNewSession.name) || '';
      const bt = document.querySelector('#sessionBar .sb-title'); if (bt) bt.textContent = nm || 'Новая сессия';
      if (nm){ fetch('/api/session-name', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ file: d.file, name: nm }) }).catch(()=>{}); }  // закрепляем имя как заголовок карточки
      S.pendingNewSession = null;   // сессия создана — pending снят
      // новая/форкнутая сессия обрела файл → сразу показать РЕАЛЬНЫЙ рейл (clientCu из cwd, описание=промт) вместо заглушки и обновлять по ходу
      fetch('/api/session?file=' + encodeURIComponent(d.file), { cache:'no-store' }).then(r => r.json())
        .then(t => { if (t && !t.error && S.currentFile === d.file){ SESSION_CACHE[d.file] = t; renderRail(t); startRailRefresh(d.file); } }).catch(()=>{});
    } else if (d.type === 'start'){
      if (d.streamId) S.currentStreamId = d.streamId;   // для гарантированного /api/stop
    } else if (d.type === 'turn'){
      // граница ХОДА в живой сессии (steering): предыдущий промт отработал, стрим НЕ рвём. Обновляем контекст,
      // сбрасываем индикатор шага и снимаем «ожидает» с подкинутых промтов (их ход сейчас начнётся).
      updateRailContext(d.ctxPct, d.winTokens);
      waiting = false; activity = ''; t0 = Date.now(); paintRun();
      clearLive(); finalizeThink();
      cons.querySelectorAll('.cx-queued').forEach(el => { el.classList.remove('cx-queued'); const t = el.querySelector('.cx-queued-tag'); if (t) t.remove(); });
    } else if (d.type === 'error'){
      finish('Ошибка: ' + (d.message || 'unknown'));   // ошибка стрима — очередь не двигаем
    } else if (d.type === 'done'){
      finish(d.isError ? 'Завершено с ошибкой' : null, { done:true, ctxPct:d.ctxPct, winTokens:d.winTokens });
    }
    // 'system' — в UI не показываем
  };
  es.onerror = () => {
    if (finished || S.currentES !== es) return;   // штатный done или намеренное закрытие (уход/Стоп) — не трогаем
    // Абнормальный обрыв канала (не done): на сервере ход НЕ прерывается — в bypass дорабатывает в фоне, на вопрос/аппрув
    // встаёт и ждёт. Не объявляем «завершено» (иначе спиннер гаснет, а агент висит незаметно): переходим на фоновое
    // слежение — live-tail показывает дальнейший вывод, tailTick опрашивает висящие вопросы/аппрувы (surfacePending).
    finished = true;
    if (S.streamTimer){ clearInterval(S.streamTimer); S.streamTimer = null; }
    try { es.close(); } catch {} S.currentES = null; S.liveFinish = null; S.streaming = false;   // currentStreamId НЕ сбрасываем — Стоп сможет оборвать фоновый ход (/api/stop)
    clearLive(); finalizeThink();
    if (runEl && runEl.parentElement) runEl.remove();
    const f = S.streamingFile || S.currentFile;
    S.streamingFile = null; setComposerBusy(false);
    if (!(f && S.currentFile === f)) return;
    setStreamStatus('Канал прервался — слежу за фоном…', 5000);
    delete SESSION_CACHE[f];
    (async () => {   // синхронизируем курсор tail с диском (как в finish), иначе after=0 продублировал бы уже показанное
      try { const r = await fetch('/api/session-tail?file=' + encodeURIComponent(f) + '&after=0', { cache:'no-store' }); const dd = await r.json(); if (typeof dd.count === 'number') S.tailCount = dd.count; } catch {}
      if (S.currentFile === f) startTail(f);
    })();
  };
}

export function stopTail(){ if (S.tailTimer){ clearInterval(S.tailTimer); S.tailTimer = null; } if (S.tailCountTimer){ clearInterval(S.tailCountTimer); S.tailCountTimer = null; } const ind = document.getElementById('tailInd'); if (ind) ind.remove(); }

export function startTail(file){ stopTail(); S.tailTimer = setInterval(() => tailTick(file), 4000); tailTick(file); }

// Живой рефреш рейла: по мере работы над контекстом ветка/MR/сборки/Jira меняются — периодически перечитываем
// состояние сессии и обновляем секции (MR/сборки/Jira/ветка) на месте, не трогая теги/скролл/композер.
function stopRailRefresh(){ if (S.railTimer){ clearInterval(S.railTimer); S.railTimer = null; } }
export function startRailRefresh(file){
  stopRailRefresh();
  S.railTimer = setInterval(async () => {
    if (S.currentFile !== file){ stopRailRefresh(); return; }
    let t2 = null;
    try { const r = await fetch('/api/session?file=' + encodeURIComponent(file), { cache:'no-store' }); t2 = await r.json(); } catch {}
    if (!t2 || t2.error || S.currentFile !== file) return;
    SESSION_CACHE[file] = t2;
    refreshRailFields(t2);                          // описание=последний промт + чипы скоупа/clientCu — появляются/меняются по мере накопления контекста
    loadMrs(t2); loadJira(t2); loadBuilds(t2);      // live-секции обновляют свои боксы на месте (без мигания)
    if (!t2.active && !t2.serverActive && !S.streaming){ stopRailRefresh(); }   // затихла, хода на сервере нет, Deck не стримит → рефреш не нужен
  }, 15000);
}

// Индикатор «Claude работает… Nс» при перезаходе (tail). turnStartTs (эпоха, старт хода с сервера) — чтобы показывать
// РЕАЛЬНУЮ длительность хода, а не с момента перезахода; нет — фолбэк на локальное время появления индикатора.
export function updateTailIndicator(on, turnStartTs, waiting, activity){
  const cons = document.querySelector('.cx-console'); if (!cons) return;
  let ind = document.getElementById('tailInd');
  if (on){
    if (!ind) ind = appendHTML(cons, '<div class="cx-run-chat" id="tailInd"><span class="cx-spin"></span><span class="cx-run-txt"></span></div>');
    else cons.appendChild(ind);            // держим индикатор внизу
    const sp = ind.querySelector('.cx-spin'); if (sp) sp.style.display = waiting ? 'none' : '';
    const txt = ind.querySelector('.cx-run-txt');
    if (waiting){   // висит вопрос/аппрув — Claude ждёт ответа, а не работает: таймер замирает, спиннер убран
      if (S.tailCountTimer){ clearInterval(S.tailCountTimer); S.tailCountTimer = null; }
      if (txt) txt.textContent = '⏳ Ожидает вашего ответа';
    } else {
      const start = (turnStartTs && turnStartTs > 0) ? turnStartTs : (ind._start || Date.now());
      ind._start = start;
      const label = activity || '✻ Claude работает';   // «что делает» из tail (⚙ инструмент / ✻ размышляет / ✍ пишет), иначе общий текст
      const paint = () => { if (txt) txt.textContent = label + '… ' + Math.max(0, Math.round((Date.now() - start) / 1000)) + 'с'; };
      paint();
      if (S.tailCountTimer) clearInterval(S.tailCountTimer);
      S.tailCountTimer = setInterval(paint, 1000);
    }
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

// Опрос висящих вопросов/аппрувов (в т.ч. заданных агентом ПОСЛЕ обрыва канала) + дорисовка карточек. Дедуп по data-id:
// в одном потоке проверка-и-вставка атомарны, поэтому дублей с одноразовым ре-сёрфейсом при перезаходе не будет. Возвращает: есть ли висящие.
async function surfacePending(file){
  const cons = document.querySelector('.cx-console'); if (!cons) return false;
  let q, a;
  try { [q, a] = await Promise.all([
    fetch('/api/pending-questions?file=' + encodeURIComponent(file), { cache:'no-store' }).then(r => r.json()),
    fetch('/api/pending-approvals?file=' + encodeURIComponent(file), { cache:'no-store' }).then(r => r.json()),
  ]); } catch { return false; }
  if (S.currentFile !== file) return false;
  const ind = document.getElementById('tailInd');
  const add = (sel, html, wire, card) => { if (cons.querySelector(sel)) return; const el = appendHTML(cons, html); if (!el) return; if (ind) cons.insertBefore(el, ind); wire(el, card); };
  let has = false;
  const t = titleOf(file);
  if (q && Array.isArray(q.questions)) for (const it of q.questions){ has = true; const card = { id: it.id, questions: it.questions }; add('.cx-question[data-id="' + it.id + '"]', questionCardHTML(card), wireQuestion, card); notifyInput(file, it.id, t); }
  if (a && Array.isArray(a.approvals)) for (const it of a.approvals){ has = true; const card = { id: it.id, tool: it.tool, input: it.input }; add('.cx-approval[data-id="' + it.id + '"]', approvalCardHTML(card), wireApproval, card); notifyInput(file, it.id, t); }
  return has;
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
  updateRailContext(d.ctxPct, d.winTokens);          // контекст рейла — сразу из tail, не ждём поллинг
  const pending = await surfacePending(file);        // висящие вопросы/аппрувы (в т.ч. заданные после обрыва канала) — дорисовать
  // Занятость — ТОЛЬКО по serverActive (на сервере жив ход этой сессии). mtime-«working» НЕ используем: он устаревает
  // на долгих инструментах (индикатор мигал «то есть, то нет») и остаётся свежим ~20с после Стопа (индикатор всплывал призраком).
  const working = !!d.serverActive;
  updateTailIndicator(working || pending, d.turnStartTs, pending, d.activity);   // висит вопрос/аппрув → «ожидает»; ход жив → «работает <активность>»; иначе скрыт
  const stopBtn = document.getElementById('stopBtn'); if (stopBtn) stopBtn.disabled = !(working || pending);   // после перезахода Стоп активен, пока ход жив/ждёт (иначе кнопка мёртвая, ход не оборвать)
  if (stick) scrollBottom();               // доскролл ПОСЛЕ появления индикатора/карточек (иначе прячется под фолдом)
  if (!working && !pending) stopTail();    // ход на сервере завершён и ничего не ждём → прекращаем опрос (не крутим по mtime и не показываем ложную занятость)
}
