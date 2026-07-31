// Deck — движок живого ответа: SSE-стрим Agent SDK (runPrompt), inline-аппрувы инструментов,
// обрыв по Стоп, live-tail ленты при перезаходе и периодический рефреш правого рейла. Состояние — в store (S).
import { S, notifiedDone, SESSION_CACHE, promptQueue } from './store.js';
import { esc, mdToHtml, ctxColor, kTok } from './util.js';
import { appendHTML, blockHTML, attachThumbsHTML, scrollBottom, isNearBottom, wireConsole } from './transcript.js';
import { clearQueue, setComposerBusy, updateQueueIndicator, drainQueue } from './composer.js';
import { loadBuilds, loadMrs, loadJira, wireTags, stopAgentsPoll } from './services.js';
import { ensureNotifyPermission, titleOf, notifyDone } from './notify.js';
import { sideHTML } from './rail.js';
import { launchUnity } from './unity.js';
import { wireSideActions } from './dialogs.js';
import { openSession } from './session.js';

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
