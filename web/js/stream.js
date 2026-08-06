// Deck — движок живого ответа: SSE-стрим Agent SDK (runPrompt), inline-аппрувы инструментов,
// обрыв по Стоп, live-tail ленты при перезаходе и периодический рефреш правого рейла. Состояние — в store (S).
import { S, notifiedDone, notifiedInput, SESSION_CACHE, promptQueue } from './store.js';
import { esc, mdToHtml, ctxColor, kTok } from './util.js';
import { appendHTML, blockHTML, attachThumbsHTML, scrollBottom, isNearBottom, wireConsole } from './transcript.js';
import { clearQueue, setComposerBusy, updateQueueIndicator, drainQueue, saveSessionSettings } from './composer.js';
import { renderCtxTabs } from './nav.js';
import { loadBuilds, loadMrs, loadJira, wireTags, stopAgentsPoll } from './services.js';
import { ensureNotifyPermission, titleOf, notifyDone, notifyInput } from './notify.js';
import { sideHTML, wireRailTabs } from './rail.js';
import { launchUnity } from './unity.js';
import { wireSideActions } from './dialogs.js';
import { openSession, renderRail, refreshRailFields } from './session.js';
import { updateComposerWarnings, removePending } from './composer.js';

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

// Счётчик токенов в строке хода — с одним знаком после запятой (20.4k → 20.5k …), чтобы динамика была видна мелкими
// шагами (kTok округляет до целых k — счётчик «застревал» на 20k надолго). Слово tokens, как в CLI.
function fmtTokens(n){ return (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n)) + ' tokens'; }

// Строка индикатора хода: что делает · сколько токенов уже сгенерировано · чем занят фоновый агент. Секунды НЕ пишем —
// «работает Nс» бесполезно; полезна динамика токенов (видно, что не завис) и активность инструмента/агента.
export function runLine(label, tokens){
  const parts = [ label || '✻ Claude работает' ];
  if (tokens > 0) parts.push(fmtTokens(tokens));
  const ag = (S.liveAgents || []).filter(a => a && a.running);
  if (ag.length){
    const a = ag[0];
    parts.push('агент: ' + a.label + (a.tokensIn ? ' ' + kTok(a.tokensIn) : '') + (ag.length > 1 ? ' +' + (ag.length - 1) : ''));
  }
  return parts.join(' · ');
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
    resumeTailAfterInput();   // канал мог оборваться — поднять tail, чтобы продолжение хода прилетело и индикатор не завис на «Ожидает»
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
    const custom = `<div class="q-custom"><input class="q-custom-inp" type="text" placeholder="…или впишите свой ответ / уточнение (Enter — отправить)"></div>`;
    return `<div class="q-block" data-multi="${q.multiSelect ? '1' : '0'}" data-question="${esc(String(q.question || ''))}">${head}${text}${plan}<div class="q-opts">${btns}</div>${custom}</div>`;
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
    const ci = blk.querySelector('.q-custom-inp'); const custom = ci ? ci.value.trim() : '';   // свой ответ/уточнение — важнее сухого выбора
    const val = [sel.join(', '), custom].filter(Boolean).join(' — ');   // выбор + свой текст, если оба; иначе что есть
    if (val) answers[qtext] = val;
  });
  return answers;
}

// После ответа на вопрос / решения по аппруву: если живого Deck-SSE нет (канал оборвался или это перезаход), сервер-ход
// продолжится и напишет .jsonl — поднимаем tail, чтобы продолжение прилетело вживую и индикатор пересчитался с «Ожидает»
// на «работает»/скрыт (иначе «Ожидает вашего ответа» висит до ручного перезахода, а новые блоки не подтягиваются).
export function resumeTailAfterInput(){
  const f = S.currentFile; if (!f) return;
  if (S.streaming && S.streamingFile === f) return;   // живой SSE сам дорисует продолжение
  startTail(f);
}

// Кнопка «Продолжить»: resume той же сессии с места остановки. Общая для живого done (finish) и перезахода/фона
// (appendTerminalNote) — иначе логика возобновления копировалась бы в двух местах.
function wireContinueBtn(container){
  const cb = container && container.querySelector('#continueBtn');
  if (cb) cb.addEventListener('click', () => { cb.disabled = true; runPrompt({ text: 'Продолжай с того места, где остановился.', mode: S.sessionMode, model: S.sessionModel, effort: S.sessionEffort, attachments: [] }); });
}

// R5: видимый маркер причины финиша при перезаходе/фоне. Живой SSE-done рисует ноту сам (finish); эта — когда ход
// завершился в фоне (канал закрыт) или ещё до захода: сервер отдаёт terminal={state,reason} в /api/session(-tail).
// Идемпотентна (один .cx-term на консоль). continuable-состояния получают кнопку «Продолжить» (resume).
export function appendTerminalNote(cons, state, reason){
  if (!cons || cons.querySelector('.cx-term')) return;
  const continuable = state === 'max_turns' || state === 'orphaned' || state === 'error';
  const base = reason || (state === 'max_turns' ? 'Достигнут лимит шагов Claude.'
    : state === 'orphaned' ? 'Ход прерван перезапуском Deck.'
    : state === 'error' ? 'Ход завершился с ошибкой.' : 'Ход завершён.');
  const txt = base + (state === 'max_turns' ? ' Нажмите «Продолжить», чтобы он продолжил с того же места.' : '');
  const btn = continuable ? '<div class="cx-note"><button class="q-submit" type="button" id="continueBtn">▶ Продолжить</button></div>' : '';
  const box = appendHTML(cons, '<div class="cx-term"><div class="cx-note">' + esc(txt) + '</div>' + btn + '</div>');
  wireContinueBtn(box);
  scrollBottom();
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
  resumeTailAfterInput();
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
    const ci = blk.querySelector('.q-custom-inp');
    if (single && !multi && !(ci && ci.value.trim())) submitAnswers(el, d);   // single-select — сразу отправляем, НО не если пишут свой ответ (дадим дописать)
  }));
  el.querySelectorAll('.q-custom-inp').forEach(inp => inp.addEventListener('keydown', (e) => { if (e.key === 'Enter'){ e.preventDefault(); submitAnswers(el, d); } }));   // Enter в поле своего ответа — отправить
  const sb = el.querySelector('.q-submit'); if (sb) sb.addEventListener('click', () => submitAnswers(el, d));
}

export async function runPrompt(payload){
  const text = payload.text || '', mode = payload.mode || 'default', attachments = payload.attachments || [];
  try { removePending(S.currentFile, text); } catch {}   // ушёл живым ходом → в транскрипте, из pending снять
  const model = payload.model || '', effort = payload.effort || '';
  const queuedEl = payload.el;
  const cons = ensureConsole();
  const isCompactCmd = text.trim() === '/compact';
  let compactBefore = null;   // контекст ДО сжатия — для читаемого итога «X% → Y%, освобождено ~N токенов»
  if (isCompactCmd){ const c = SESSION_CACHE[S.currentFile] || (S.SESSIONS || []).find(x => x.file === S.currentFile); if (c) compactBefore = { ctxPct:c.ctxPct, winTokens:c.winTokens }; }
  const emptyEl = cons.querySelector('.empty'); if (emptyEl) emptyEl.remove();   // плейсхолдер «Пустая сессия…» новой сессии — убрать при первом же промте (иначе висел над диалогом)
  stopTail();   // живой стрим сам владеет индикатором: снимаем tail-индикатор, иначе рядом с новым «работает» висел бы старый tail (дубль «Claude работает»)
  cons.querySelectorAll('.cx-run-chat').forEach(el => el.remove());   // + снять ЛЮБОЙ оставшийся индикатор (осиротевший runEl прошлого стрима) — гарантия одного «работает»
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
  cons.querySelectorAll('.cx-run-chat').forEach((el) => el.remove());   // единственный индикатор: снять прежние (tail/осиротевшие) перед созданием live-runEl
  const runEl = appendHTML(cons, '<div class="cx-run-chat"><span class="cx-spin"></span><span class="cx-run-txt">Claude работает… 0с</span></div>');
  scrollBottom();
  let t0 = Date.now();
  let waiting = false;   // висит вопрос/аппрув — Claude ЖДЁТ ответа, а не работает: индикатор меняется, таймер замирает
  let activity = '';     // что ИМЕННО делает сейчас: инструмент/размышление/ответ (обновляется по событиям SSE)
  // Живой счётчик токенов хода: сервер сверяет его фактом (событие usage приходит к концу каждого сообщения), а между
  // сверками растёт оценка по объёму пришедших дельт (~4 символа на токен) — чтобы число двигалось непрерывно.
  let tokBase = 0, charsSince = 0;
  const tokNow = () => tokBase + Math.round(charsSince / 4);
  const paintRun = () => {
    if (!runEl) return;   // null-DOM / индикатор снят
    const el = runEl.querySelector('.cx-run-txt'); if (!el) return;
    const sp = runEl.querySelector('.cx-spin'); if (sp) sp.style.display = waiting ? 'none' : '';
    el.textContent = waiting ? '⏳ Ожидает вашего ответа' : runLine(activity, tokNow());
  };
  paintRun();   // строку обновляют события стрима (дельты/инструменты/usage) — посекундный тик больше не нужен (секунды убраны)

  let liveMd = null, liveAccum = '';           // текущий текстовый блок ассистента (дельты text)
  let liveThink = null, liveThinkAccum = '';   // текущий блок размышления (дельты thinking)
  let liveToolEl = null;                       // последний живой tool-блок — чтобы событие tool_input дописало в него IN/описание
  // Якорь вставки живых блоков: перед «ожидающим» промтом, если он есть, иначе перед индикатором. Так подкинутый
  // (steer/очередь) промт остаётся ВНИЗУ — новые команды идут над ним, а не он «перед выполнением текущей команды».
  const liveAnchor = () => cons.querySelector('.cx-queued') || runEl;
  const addBlock = (html) => { const el = appendHTML(cons, html); if (el) cons.insertBefore(el, liveAnchor()); return el; };  // новый блок — над «ожидающим» промтом/индикатором
  const startNewMd = () => {
    const wrap = document.createElement('div'); wrap.className = 'cx-msg cx-asst cx-live';   // референс-стиль: без шапки «Claude» — плоский текст с точкой-маркером
    const md = document.createElement('div'); md.className = 'cx-md';
    wrap.appendChild(md); cons.insertBefore(wrap, liveAnchor());
    liveMd = md; liveAccum = '';
  };
  const startNewThink = () => {
    const wrap = document.createElement('div'); wrap.className = 'cx-msg cx-think cx-live';
    wrap.innerHTML = '<button class="cx-think-h" type="button"><span class="cx-tw">▾</span>✻ Размышление</button>';
    const body = document.createElement('div'); body.className = 'cx-think-body cx-md';
    wrap.appendChild(body); cons.insertBefore(wrap, liveAnchor());
    liveThink = body; liveThinkAccum = '';
  };
  // Дросселирование живого рендера: mdToHtml(весь накопленный текст)+innerHTML на КАЖДУЮ дельту = O(n^2) по главному
  // потоку → на длинном ответе лагал ввод в композере (глючил при работе). Копим дельты и перерисовываем НЕ чаще
  // раза в LIVE_MIN_MS (~8/сек) — иначе на быстром стриме кадровый rAF всё равно даёт O(n^2) reflow и джанк ввода.
  // Финальная корректность гарантируется синхронным clearLive/finalizeThink на границе блока.
  const LIVE_MIN_MS = 120;
  let liveRafPending = false, lastLiveFlush = 0;
  const flushLive = () => {
    liveRafPending = false; lastLiveFlush = Date.now();
    const stick = isNearBottom();
    if (liveMd) liveMd.innerHTML = mdToHtml(liveAccum);
    if (liveThink) liveThink.innerHTML = mdToHtml(liveThinkAccum);
    paintRun();   // счётчик токенов/секунд движется в такт стриму, а не раз в секунду
    if (stick) scrollBottom();
  };
  const scheduleLive = () => {
    if (liveRafPending) return;
    liveRafPending = true;
    const wait = Math.max(0, LIVE_MIN_MS - (Date.now() - lastLiveFlush));
    if (wait) setTimeout(() => requestAnimationFrame(flushLive), wait); else requestAnimationFrame(flushLive);
  };
  // Финализация блока — синхронный доrender финального текста (последние дельты могли не успеть в rAF), затем снять cx-live.
  const clearLive = () => { if (liveMd){ liveMd.innerHTML = mdToHtml(liveAccum); if (liveMd.parentElement) liveMd.parentElement.classList.remove('cx-live'); } liveMd = null; };
  const finalizeThink = () => { if (liveThink){ liveThink.innerHTML = mdToHtml(liveThinkAccum); if (liveThink.parentElement) liveThink.parentElement.classList.remove('cx-live'); } liveThink = null; };

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
        ? { prompt: text, mode, model, effort, newSession: true, cwd: payload.newSessionCwd, name: payload.pendingName || '', attachments: slim }
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
  // A2: единый разбор состояния живого стрима — общий для finish (штатный done), onerror (обрыв канала) и steered
  // (single-writer). keepStreamId=true оставляет currentStreamId, чтобы Стоп мог оборвать фоновый ход по id (onerror).
  const teardownLive = ({ keepStreamId } = {}) => {
    if (S.streamTimer){ clearInterval(S.streamTimer); S.streamTimer = null; }
    try { es.close(); } catch {} S.currentES = null; S.liveFinish = null;
    if (!keepStreamId) S.currentStreamId = null;
    clearLive(); finalizeThink();
    if (runEl && runEl.parentElement) runEl.remove();
  };
  const finish = (note, opts) => {
    if (finished) return; finished = true;
    teardownLive();                      // снять индикатор «работает» из чата + погасить таймер/ES/live-блоки
    // Сам сжимающий запрос уходит с ПОЛНЫМ окном (вход = весь контекст) — его usage не отражает объём ПОСЛЕ сжатия.
    // Показать его в рейле = полная красная полоса на только что сжатой сессии. Такой замер игнорируем.
    const compactOwnUsage = isCompactCmd && opts && typeof opts.winTokens === 'number' && compactBefore
      && typeof compactBefore.winTokens === 'number' && opts.winTokens >= compactBefore.winTokens * 0.8;
    if (opts && typeof opts.ctxPct === 'number' && !compactOwnUsage) updateRailContext(opts.ctxPct, opts.winTokens);   // контекст в рейле — СРАЗУ по завершении, не ждём поллинг
    if (note) appendHTML(cons, '<div class="cx-note">' + esc(note) + '</div>');
    if (opts && opts.maxTurns){   // упёрлись в лимит шагов → кнопка продолжить ход (resume той же сессии)
      const cbEl = appendHTML(cons, '<div class="cx-note"><button class="q-submit" type="button" id="continueBtn">▶ Продолжить</button></div>');
      wireContinueBtn(cbEl);
    }
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
      // /compact завершился — читаемый ИТОГ (сколько сжато), затем перечитываем сжатый транскрипт. Итог кладём в
      // S.pendingCompactNote: openSession перерисует ленту и сотрёт любую ноту здесь → renderThread допишет её заново.
      const aPct = opts && typeof opts.ctxPct === 'number' ? Math.round(opts.ctxPct * 100) : null;
      const bPct = compactBefore && typeof compactBefore.ctxPct === 'number' ? Math.round(compactBefore.ctxPct * 100) : null;
      const aTok = opts && typeof opts.winTokens === 'number' ? opts.winTokens : null;
      const bTok = compactBefore && typeof compactBefore.winTokens === 'number' ? compactBefore.winTokens : null;
      let line = '✓ Контекст сжат';
      if (compactOwnUsage){
        // Замер после сжатия — это вход самого сжимающего запроса (весь контекст), новый объём им не измеришь.
        // Пишем только достоверное: сколько было; фактический размер приедет с первым ответом нового отрезка.
        if (bPct != null) line += ` — было ${bPct}%` + (bTok != null ? ` (${kTok(bTok)})` : '');
        line += ' · новый объём появится после следующего ответа';
      } else {
        if (bPct != null && aPct != null) line += ` — ${bPct}% → ${aPct}%`;
        else if (aPct != null) line += ` — теперь ${aPct}% контекста`;
        if (bTok != null && aTok != null){ line += ` · ${kTok(bTok)} → ${kTok(aTok)}`; if (bTok > aTok) line += ` (освобождено ~${kTok(bTok - aTok)})`; }
        else if (aTok != null) line += ` · ${kTok(aTok)} / 1M`;
      }
      S.pendingCompactNote = line;
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
      charsSince += (d.delta || '').length;
      scheduleLive();
    } else if (d.type === 'thinking'){
      const piece = d.delta || '';
      if (liveThink || piece.trim()){        // блок создаём только с первым НЕПУСТЫМ thinking_delta
        if (waiting){ waiting = false; t0 = Date.now(); }   // после ответа Клод может СНАЧАЛА думать (не сразу текст/tool) — снимаем «Ожидает», иначе индикатор завис бы на размышлении
        if (activity !== '✻ размышляет'){ activity = '✻ размышляет'; paintRun(); }
        clearLive();
        if (!liveThink) startNewThink();
        liveThinkAccum += piece;
        charsSince += piece.length;
        scheduleLive();
      }
    } else if (d.type === 'tool'){
      waiting = false; t0 = Date.now(); activity = '⚙ ' + d.name; paintRun();   // новый инструмент = новый шаг → таймер сбрасывается + показываем что за инструмент
      clearLive(); finalizeThink();   // следующий текст пойдёт в новый блок
      liveToolEl = addBlock('<div class="cx-msg cx-twrap"><div class="cx-tool-h"><span class="cx-name">' + esc(d.name) + '</span><span class="cx-tdesc"></span></div></div>');
      if (stick) scrollBottom();
    } else if (d.type === 'tool_input'){   // команда/описание инструмента дозагрузились (server дособрал input_json_delta) → дорисуем IN + описание в live-блок
      const el = liveToolEl;
      charsSince += (d.cmd || '').length;   // аргументы инструмента — тоже сгенерированные токены
      if (el){
        if (d.desc){ const ds = el.querySelector('.cx-tdesc'); if (ds) ds.textContent = d.desc; }
        if (d.cmd) el.insertAdjacentHTML('beforeend', '<div class="cx-io"><span class="cx-io-l">IN</span><pre class="cx-io-b">' + esc(d.cmd) + '</pre></div>');
        if (stick) scrollBottom();
      }
      paintRun();
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
      if (!S.openFiles.includes(d.file)) S.openFiles.push(d.file);   // новая сессия — в полосу открытых контекстов
      saveSessionSettings(d.file);   // выбранные в окне создания режим/модель/effort закрепляем за появившейся сессией
      renderCtxTabs();
      const nm = payload.pendingName || (S.pendingNewSession && S.pendingNewSession.name) || '';
      const bt = document.querySelector('#sessionBar .sb-title'); if (bt) bt.textContent = nm || 'Новая сессия';
      if (nm){ fetch('/api/session-name', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ file: d.file, name: nm }) }).catch(()=>{}); }  // закрепляем имя как заголовок карточки
      S.pendingNewSession = null;   // сессия создана — pending снят
      // новая/форкнутая сессия обрела файл → сразу показать РЕАЛЬНЫЙ рейл (clientCu из cwd, описание=промт) вместо заглушки.
      // На init .jsonl может ещё НЕ быть на диске → /api/session отдаёт {error} и renderRail не вызывался: рейл оставался
      // заглушкой «создаётся…» до ручного перезахода. Ретраим чтение, пока файл не появится (обычно доли секунды).
      (async () => {
        for (let i = 0; i < 8; i++){
          let t = null; try { t = await (await fetch('/api/session?file=' + encodeURIComponent(d.file), { cache:'no-store' })).json(); } catch {}
          if (S.currentFile !== d.file) return;
          if (t && !t.error){ SESSION_CACHE[d.file] = t; renderRail(t); startRailRefresh(d.file); return; }
          await new Promise(r => setTimeout(r, 400));
        }
      })();
    } else if (d.type === 'start'){
      if (d.streamId) S.currentStreamId = d.streamId;   // для гарантированного /api/stop
    } else if (d.type === 'usage'){
      if (typeof d.turnOut === 'number'){ tokBase = d.turnOut; charsSince = 0; paintRun(); }   // факт от сервера — оценка обнуляется
    } else if (d.type === 'turn'){
      // граница ХОДА в живой сессии (steering): предыдущий промт отработал, стрим НЕ рвём. Обновляем контекст,
      // сбрасываем индикатор шага и снимаем «ожидает» с подкинутых промтов (их ход сейчас начнётся).
      updateRailContext(d.ctxPct, d.winTokens);
      waiting = false; activity = ''; t0 = Date.now(); tokBase = 0; charsSince = 0; paintRun();
      clearLive(); finalizeThink();
      cons.querySelectorAll('.cx-queued').forEach(el => { el.classList.remove('cx-queued'); const t = el.querySelector('.cx-queued-tag'); if (t) t.remove(); });
    } else if (d.type === 'steered'){
      // R3: сервер подкинул наш промт в УЖЕ живой ход этой сессии (2-й resume не запускаем). Не «завершено» — переходим
      // на фоновый tail: продолжение (включая ответ на наш промт) прилетит через него. Бабл промта уже в консоли.
      finished = true;
      teardownLive();   // currentStreamId сброшен: Стоп оборвёт живой фоновый ход по файлу сессии, а не по устаревшему id
      S.streaming = false;
      const f = S.streamingFile || S.currentFile; S.streamingFile = null; setComposerBusy(false);
      if (f && S.currentFile === f){ startTail(f); S.serverBusy = true; }   // serverBusy ПОСЛЕ startTail (startTail→stopTail его сбрасывает) — гейт для composer держится до первого tailTick
    } else if (d.type === 'error'){
      finish('Ошибка: ' + (d.message || 'unknown'));   // ошибка стрима — очередь не двигаем
    } else if (d.type === 'done'){
      // Терминальное состояние хода ВСЕГДА видимо (не пустота): лимит шагов → причина + «Продолжить»; ошибка; иначе «завершено».
      const maxTurns = d.subtype === 'error_max_turns';
      const note = maxTurns ? 'Достигнут лимит шагов Claude — нажмите «Продолжить», чтобы он продолжил с того же места.'
        : d.isError ? '⚠ Ход завершился с ошибкой.'
        : '✓ Claude завершил ход.';
      finish(note, { done:true, ctxPct:d.ctxPct, winTokens:d.winTokens, maxTurns });
    }
    // 'system' — в UI не показываем
  };
  es.onerror = () => {
    if (finished || S.currentES !== es) return;   // штатный done или намеренное закрытие (уход/Стоп) — не трогаем
    // Абнормальный обрыв канала (не done): на сервере ход НЕ прерывается — в bypass дорабатывает в фоне, на вопрос/аппрув
    // встаёт и ждёт. Не объявляем «завершено» (иначе спиннер гаснет, а агент висит незаметно): переходим на фоновое
    // слежение — live-tail показывает дальнейший вывод, tailTick опрашивает висящие вопросы/аппрувы (surfacePending).
    finished = true;
    teardownLive({ keepStreamId: true });   // currentStreamId НЕ сбрасываем — Стоп сможет оборвать фоновый ход (/api/stop)
    S.streaming = false;
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

export function stopTail(){ S.serverBusy = false; if (S.tailTimer){ clearInterval(S.tailTimer); S.tailTimer = null; } if (S.tailCountTimer){ clearInterval(S.tailCountTimer); S.tailCountTimer = null; } const ind = document.getElementById('tailInd'); if (ind) ind.remove(); }

export function startTail(file){ stopTail(); S.tailStepStart = 0; S.tailTimer = setInterval(() => tailTick(file), 4000); tailTick(file); }

// Все «ожидающие» промты (steer/очередь/восстановленные) — единым блоком в самом низу, над индикатором, в порядке
// их появления в DOM. Перемещаем ВСЕ (не только первый), иначе при нескольких промтах они прыгали и меняли места.
function pinQueued(){
  const cons = document.querySelector('.cx-console'); if (!cons) return;
  const anchor = document.getElementById('tailInd') || cons.querySelector('.cx-run-chat:not(.cx-queued)') || null;
  for (const q of cons.querySelectorAll('.cx-queued')){ if (anchor) cons.insertBefore(q, anchor); else cons.appendChild(q); }
}

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
export function updateTailIndicator(on, turnStartTs, waiting, activity, tokens){
  const cons = document.querySelector('.cx-console'); if (!cons) return;
  let ind = document.getElementById('tailInd');
  if (on){
    // ИНВАРИАНТ «один индикатор»: tail-строку НЕ рисуем, если есть живой runEl (Deck сейчас стримит) — иначе два
    // «Claude работает» с разными таймерами. Живой стрим владеет индикатором; оставшийся tail убираем.
    const liveRun = cons.querySelector('.cx-run-chat:not(#tailInd)');
    if (liveRun){ if (ind){ ind.remove(); } if (S.tailCountTimer){ clearInterval(S.tailCountTimer); S.tailCountTimer = null; } return; }
    cons.querySelectorAll('.cx-run-chat').forEach((el) => { if (el.id !== 'tailInd') el.remove(); });   // единственный индикатор: снять осиротевший live-runEl (иначе после перезахода два «Claude работает»)
    if (!ind) ind = appendHTML(cons, '<div class="cx-run-chat" id="tailInd"><span class="cx-spin"></span><span class="cx-run-txt"></span></div>');
    else cons.appendChild(ind);            // держим индикатор внизу
    const sp = ind.querySelector('.cx-spin'); if (sp) sp.style.display = waiting ? 'none' : '';
    const txt = ind.querySelector('.cx-run-txt');
    if (S.tailCountTimer){ clearInterval(S.tailCountTimer); S.tailCountTimer = null; }   // секунды убраны → посекундный тик не нужен; строку обновляет сам tailTick (раз в 4с)
    if (waiting){   // висит вопрос/аппрув — Claude ждёт ответа, а не работает: спиннер убран
      if (txt) txt.textContent = '⏳ Ожидает вашего ответа';
    } else if (txt){
      txt.textContent = runLine(activity, tokens || 0);   // «что делает» из tail (⚙ инструмент / ✻ размышляет / ✍ пишет) + токены + фоновый агент
    }
  } else {
    if (S.tailCountTimer){ clearInterval(S.tailCountTimer); S.tailCountTimer = null; }
    if (ind) ind.remove();
  }
}

// Обновить индикатор контекста в рейле сессии СРАЗУ (после done или из tail) — без ожидания поллинга.
export function updateRailContext(ctxPct, winTokens){
  updateComposerWarnings(ctxPct);   // порог контекста → баннер «сжать» над композером
  const side = document.getElementById('sessionSide'); if (!side) return;
  const unknown = winTokens === 0;   // ход после сжатия ещё не дал своего usage — «—» вместо цифры (иначе видно предсжатое/нулевое)
  if (typeof ctxPct === 'number'){
    const p = Math.round(ctxPct * 100), col = ctxColor(ctxPct);
    const bar = side.querySelector('.ctxbar i'); if (bar){ bar.style.width = (unknown ? 0 : p) + '%'; bar.style.background = col; }
    const pct = side.querySelector('.ctx-pct'); if (pct){ pct.textContent = unknown ? '—' : (p + '%'); pct.style.color = unknown ? 'var(--text-faint)' : col; }
  }
  if (typeof winTokens === 'number'){ const w = side.querySelector('.stat-win'); if (w) w.textContent = unknown ? '—' : (kTok(winTokens) + ' / 1M'); }
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
    const anchor = cons.querySelector('.cx-queued') || ind;   // новые блоки — НАД ожидающими промтами (они держатся в самом низу)
    for (const b of d.blocks){ const el = appendHTML(cons, blockHTML(b)); if (el) cons.insertBefore(el, anchor); }   // anchor=null → в конец
    // «ожидает» снимаем у КАЖДОГО промта, чей текст долетел в транскрипт (несколько — независимо, не только первый: иначе
    // второй «зависал»). Раньше времени (от ЧУЖОГО вывода) не снимаем — только по совпадению своего user-блока.
    const userTexts = new Set(d.blocks.filter(b => b.kind === 'user').map(b => String(b.text || '').trim()));
    for (const q of [...cons.querySelectorAll('.cx-queued')]){ const md = q.querySelector('.cx-md'); const tx = md ? (md.textContent || '').trim() : ''; if (tx && userTexts.has(tx)){ q.remove(); try { removePending(file, tx); } catch {} } }
    S.tailStepStart = Date.now();   // новый шаг/команда → таймер индикатора считает С ЭТОГО МОМЕНТА, а не общий тайминг хода
    if (typeof d.count === 'number') S.tailCount = d.count;
  } else if (typeof d.count === 'number') { S.tailCount = d.count; }
  updateRailContext(d.ctxPct, d.winTokens);          // контекст рейла — сразу из tail, не ждём поллинг
  const pending = await surfacePending(file);        // висящие вопросы/аппрувы (в т.ч. заданные после обрыва канала) — дорисовать
  // Занятость — ТОЛЬКО по serverActive (на сервере жив ход этой сессии). mtime-«working» НЕ используем: он устаревает
  // на долгих инструментах (индикатор мигал «то есть, то нет») и остаётся свежим ~20с после Стопа (индикатор всплывал призраком).
  const working = !!d.serverActive;
  S.serverBusy = working;   // новый промт при живом сервер-ходе, но оборванном SSE → sendMessage должен steer'ить, а не плодить 2-й ход (дубль «работает»)
  updateTailIndicator(working || pending, S.tailStepStart || d.turnStartTs, pending, d.activity, d.turnOut);   // таймер — от текущего шага (S.tailStepStart), не от старта хода; вопрос/аппрув → «ожидает»
  pinQueued();   // ВСЕ ожидающие промты — единым блоком в самом низу (над индикатором), в стабильном порядке добавления, без прыжков
  const stopBtn = document.getElementById('stopBtn'); if (stopBtn) stopBtn.disabled = !(working || pending);   // после перезахода Стоп активен, пока ход жив/ждёт (иначе кнопка мёртвая, ход не оборвать)
  if (stick) scrollBottom();               // доскролл ПОСЛЕ появления индикатора/карточек (иначе прячется под фолдом)
  if (!working && !pending){                // ход на сервере завершён и ничего не ждём → прекращаем опрос (не крутим по mtime и не показываем ложную занятость)
    if (d.terminal) appendTerminalNote(ensureConsole(), d.terminal.state, d.terminal.reason);   // R5: фоновый ход завершился лимитом/ошибкой/осиротел — показать причину + «Продолжить», а не молча исчезнуть
    stopTail();
  }
}
