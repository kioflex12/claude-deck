// Deck — стриминговый чат в сессию через Claude Agent SDK (SSE), аппрув инструментов (canUseTool) и
// пользовательский ввод (AskUserQuestion/ExitPlanMode через PostToolUse-hook), стоп/решение/ответ.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  sendJSON, readJsonBody, dbgLog, CTX_LIMIT,
  VALID_MODES, VALID_EFFORTS, READ_ONLY_TOOLS, USER_INPUT_TOOLS, EDIT_TOOLS, PROJECTS_DIR,
  pendingApprovals, pendingApprovalsByKey, pendingQuestions, pendingQuestionsByKey, activeStreams, sessionAllow, stagedRequests,
  setRunStatus,
} from './core.mjs';
import { firstString } from './text.mjs';
import { getSdkQuery } from './sdk.mjs';
import { setName } from './sessions.mjs';

// Мутирующие инструменты, которые managed-тир форсирует в ask. settingSources('project') нужен, чтобы CLI нашёл скиллы
// проекта (/dev-workflow и пр.) и CLAUDE.md — без него слэш-команды = «Unknown command». Но project несёт и
// permissions.allow (Bash(*)/Write(*)/mcp__*…), которые пропускали бы мутирующее мимо canUseTool. Managed-ask имеет
// высший приоритет (deny>ask>allow) и возвращает их под страж; read-only-часть mcp__* отсеет isReadOnlyTool в canUseTool.
const MANAGED_ASK = ['Bash', 'PowerShell', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'mcp__*'];
export function isReadOnlyTool(name) {
  if (READ_ONLY_TOOLS.has(name)) return true;
  const bare = String(name || '').replace(/^mcp__.+?__/, '').toLowerCase();   // mcp__server__tool -> tool
  // мутирующие глаголы — точно спрашиваем (даже если дальше есть read-подстрока)
  if (/^(create|update|delete|remove|add|edit|write|set|put|post|patch|trigger|transition|upload|generate|archive|fix|wipe|deploy|move|rename|assign|merge|apply|kick|ban|send|publish|execute|run|link|unlink|start|stop|restart)/.test(bare)) return false;
  // читающие
  if (/^(get|list|search|read|fetch|describe|view|show|find|query|explore|lookup|check|status|info)/.test(bare)) return true;
  if (/(_|^)(query|get|list|describe|search|read|fetch|log|logs|status|info|context|diff|health|events|metrics)(_|$)/.test(bare)) return true;
  return false;   // неизвестное — спрашиваем (безопасно)
}
function addSessionAllow(sessionId, tool) {
  let set = sessionAllow.get(sessionId);
  if (!set) { set = new Set(); sessionAllow.set(sessionId, set); }
  set.add(tool);
}

// -------- Steering: очередной промт доярыдывается в ЖИВУЮ сессию (streaming-input SDK), а не ждёт конца всего
// агентного цикла + пере-спавн. Модель читает ввод на границе хода/шага — канал отдаёт следующее сообщение, как
// только SDK готов его взять. --------
// Собираем SDKUserMessage из текста+вложений (content ВСЕГДА массив блоков — единый формат для первого и подкинутых).
export function buildUserMessage(text, attachments) {
  const list = Array.isArray(attachments) ? attachments : [];
  const images = list.filter((a) => a && a.kind === 'image' && a.dataB64);
  const textFiles = list.filter((a) => a && a.kind === 'text' && typeof a.text === 'string');
  const otherFiles = list.filter((a) => a && a.kind === 'binary');
  let combinedText = text || '';
  if (textFiles.length) combinedText = textFiles.map((a) => '```' + a.name + '\n' + a.text + '\n```').join('\n\n') + (text ? '\n\n' + text : '');
  if (otherFiles.length) combinedText += '\n\n[вложения без встраивания: ' + otherFiles.map((a) => a.name).join(', ') + ']';
  const content = [];
  if (combinedText.trim()) content.push({ type: 'text', text: combinedText });
  for (const im of images) content.push({ type: 'image', source: { type: 'base64', media_type: im.mediaType || 'image/png', data: im.dataB64 } });
  return { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null };
}
// Async-канал ввода: gen() отдаёт очередь по мере наполнения; push добавляет сообщение (разбудив ожидание),
// end() закрывает поток (gen завершится, когда очередь опустеет → query штатно завершится).
export function makeInputChannel(first) {
  const queue = first ? [first] : [];
  let wake = null, ended = false;
  return {
    push(msg) { if (ended) return false; queue.push(msg); if (wake) { const w = wake; wake = null; w(); } return true; },   // false → канал закрыт (гонка с завершением) → клиент фолбэкнется на новый ход
    end() { ended = true; if (wake) { const w = wake; wake = null; w(); } },
    pending() { return queue.length; },
    async *gen() {
      while (true) {
        if (queue.length) { yield queue.shift(); continue; }   // сначала осушаем очередь (даже если end уже вызван)
        if (ended) return;
        await new Promise((r) => { wake = r; });                // ждём push/end
      }
    },
  };
}

const STAGE_MAX_BYTES = 24 * 1024 * 1024;   // ~24МБ тела (включая base64)
export async function apiChatPrepare(req, res) {
  let body;
  try { body = await readJsonBody(req, STAGE_MAX_BYTES); }
  catch (e) { sendJSON(res, { error: (e && e.message) || 'read error' }, 413); return; }
  const sessionFile = String(body.sessionFile || '');
  const prompt = String(body.prompt || '');
  let mode = String(body.mode || 'default'); if (!VALID_MODES.has(mode)) mode = 'default';
  const model = String(body.model || '').slice(0, 80);   // алиас/ID модели ('' = по умолчанию)
  const effort = String(body.effort || '').slice(0, 12); // low|medium|high|xhigh|max ('' = по умолчанию)
  const attachments = Array.isArray(body.attachments) ? body.attachments.slice(0, 20) : [];
  const newSession = body.newSession === true;         // Part 3: создать НОВУЮ сессию (без resume) в cwd
  const fork = body.fork === true;                     // форк: resume + forkSession — новый id с контекстом исходной
  const cwd = String(body.cwd || '');
  const name = String(body.name || '').slice(0, 120);  // заданное пользователем имя новой сессии — сервер закрепит его при создании (устойчивее клиентского POST: без гонки и без расхождения rel)
  let bytes = 0;
  for (const a of attachments) bytes += (a && a.dataB64 ? a.dataB64.length : 0) + (a && a.text ? a.text.length : 0);
  if (bytes > STAGE_MAX_BYTES) { sendJSON(res, { error: 'attachments too large (~18MB limit)' }, 413); return; }
  const now = Date.now();
  for (const [k, v] of stagedRequests) if (now - v.ts > 5 * 60 * 1000) stagedRequests.delete(k);   // sweep старьё
  const token = 'st_' + now.toString(36) + Math.random().toString(36).slice(2, 10);
  stagedRequests.set(token, { sessionFile, prompt, mode, model, effort, attachments, newSession, cwd, fork, name, ts: now });
  sendJSON(res, { token });
}

export async function apiChat(req, res, u) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (obj) => { try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch { /* поток закрыт */ } };
  const fail = (msg) => { clearInterval(heartbeat); send({ type: 'error', message: msg }); send({ type: 'done', isError: true }); try { res.end(); } catch {} };   // R6: гасим heartbeat и на ранних отказах (до навешивания req 'close'), иначе интервал жил бы вечно, пишя в закрытый res
  // Keepalive: SSE не должен простаивать и закрываться на долгих ходах/паузах — иначе req 'close' выставит closed=true
  // и мутирующие инструменты начнут авто-реджектиться («Клиент отключён»), хотя пользователь в сессии.
  const heartbeat = setInterval(() => { try { res.write(': hb\n\n'); } catch {} }, 15000);

  // Источник запроса: одноразовый token (P4-стадирование / новая сессия) ИЛИ прямые query-параметры (P1/P3)
  let relFile = '', prompt = '', mode = 'default', attachments = [], isNew = false, newCwd = '', isFork = false, model = '', effort = '', newName = '';
  const token = u.searchParams.get('token');
  if (token) {
    const staged = stagedRequests.get(token);
    stagedRequests.delete(token);                                   // одноразовый — чистим сразу
    if (!staged) return fail('stale or unknown token');
    relFile = staged.sessionFile || '';
    prompt = staged.prompt || '';
    mode = staged.mode || 'default';
    model = staged.model || ''; effort = staged.effort || '';
    attachments = Array.isArray(staged.attachments) ? staged.attachments : [];
    isNew = staged.newSession === true;                             // Part 3: новая сессия без resume
    isFork = staged.fork === true;                                  // форк: resume исходной + forkSession
    newCwd = staged.cwd || '';
    newName = staged.name || '';
  } else {
    relFile = u.searchParams.get('file') || '';
    prompt = u.searchParams.get('prompt') || '';
    mode = u.searchParams.get('mode') || 'default';                 // P3: режим разрешений из чата (shift-tab)
    model = u.searchParams.get('model') || ''; effort = u.searchParams.get('effort') || '';
  }
  if (!VALID_MODES.has(mode)) mode = 'default';                     // неизвестное → безопасный default
  if (effort && !VALID_EFFORTS.has(effort)) effort = '';            // неизвестный effort → по умолчанию
  if (!prompt.trim() && !attachments.length) return fail('empty prompt');

  // Резолв контекста: новая сессия → cwd напрямую (файла ещё нет); иначе — из файла существующей сессии.
  let sessionId = null, cwd;
  if (isNew) {
    if (!newCwd) return fail('no cwd for new session');
    cwd = newCwd;
  } else {
    const base = path.resolve(PROJECTS_DIR);
    const resolved = path.resolve(base, relFile);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) return fail('traversal');
    if (!resolved.endsWith('.jsonl')) return fail('not a session file');
    let text = '';
    try { text = readFileSync(resolved, 'utf8'); } catch { return fail('session not found'); }
    sessionId = path.basename(resolved).replace(/\.jsonl$/, '');
    cwd = firstString(text, 'cwd') || undefined;
  }
  let sessionKey = sessionId;                                       // для новой сессии станет известен на init

  const channel = makeInputChannel(buildUserMessage(prompt, attachments));   // steering: первый промт + канал для подкидываемых
  const ac = new AbortController();
  let closed = false;
  const streamId = 'sx_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const streamEntry = { ac, key: sessionKey, push: channel.push };  // key = session_id: Стоп/индикация по файлу; push — /api/chat-input докидывает промт в живой ход
  activeStreams.set(streamId, streamEntry);                         // явный обрыв через /api/stop (не зависит от детекта дисконнекта)
  // R1/R2: помечаем ход running (для существующей сессии id известен сразу; для новой/форка — на init ниже). Терминальное
  // состояние пишет markRun на КАЖДОМ выходе (done/ошибка/аборт) независимо от closed — иначе фоновый сбой при закрытом
  // канале гас бы на доске как «завершено». Персист переживает перезапуск: осиротевший ход на старте станет orphaned.
  if (sessionKey) setRunStatus(sessionKey, { state: 'running', streamId, subtype: '', isError: false, reason: '' });
  const markRun = (state, subtype, isError, reason) => {
    dbgLog('chat END stream=' + streamId + ' state=' + state + ' subtype=' + (subtype || '') + ' isError=' + isError + ' closed=' + closed + (reason ? (' reason=' + reason) : ''));
    if (sessionKey) setRunStatus(sessionKey, { state, subtype: subtype || '', isError: !!isError, reason: reason || '', streamId });
  };
  // При закрытии SSE (ушёл с экрана / перезашёл в сессию) НЕ рвём запрос — пусть Claude доработает в фоне и допишет
  // .jsonl (перезаход подхватит live-tail'ом). Останавливать работу — только явной кнопкой Стоп (/api/stop → ac.abort).
  const _t0 = Date.now();
  dbgLog('chat START stream=' + streamId + ' isNew=' + isNew + ' mode=' + mode + ' file=' + (relFile || '(new)'));
  req.on('close', () => { closed = true; clearInterval(heartbeat); dbgLog('chat REQ-CLOSE stream=' + streamId + ' через ' + (Date.now() - _t0) + 'мс после старта'); });

  // canUseTool — ЕДИНСТВЕННЫЙ страж в default-режиме: без него мутирующие инструменты выполнились бы без спроса.
  const canUseTool = async (toolName, input, opts) => {
    // ПЕРВОЙ проверкой (до read-only/bypass/acceptEdits/closed/session-allow): вопросы к пользователю не гейтятся
    // как разрешение — их авто-allow здесь, а реальный ответ человека собирает PostToolUse-hook ниже (не авто-скип).
    if (USER_INPUT_TOOLS.has(toolName)) return { behavior: 'allow', updatedInput: input };
    if (isReadOnlyTool(toolName)) return { behavior: 'allow', updatedInput: input };
    if (mode === 'bypassPermissions') return { behavior: 'allow', updatedInput: input };            // байпас — ничего не спрашиваем
    if (mode === 'acceptEdits' && EDIT_TOOLS.has(toolName)) return { behavior: 'allow', updatedInput: input };  // «Авто-правки»: правки файлов без спроса (в т.ч. вне cwd); Bash/прочее — по-прежнему спрашиваем
    const set = sessionKey && sessionAllow.get(sessionKey);
    if (set && set.has(toolName)) return { behavior: 'allow', updatedInput: input };
    // Обрыв SSE (ушёл с экрана) НЕ решает за пользователя: аппрув — это решение человека, а не право, которое даёт режим.
    // Регистрируем по ключу сессии и ждём; при закрытом канале send уходит в никуда (ок), а перезаход ре-сёрфейснёт карточку
    // (/api/pending-approvals) и снова будет ждать решения. Отпускаем только явным решением или abort'ом (Стоп → deny).
    const id = 'ap_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const key = sessionKey;
    if (key) { let s = pendingApprovalsByKey.get(key); if (!s) { s = new Set(); pendingApprovalsByKey.set(key, s); } s.add(id); }
    const cleanupKey = () => { const s = key && pendingApprovalsByKey.get(key); if (s) { s.delete(id); if (!s.size) pendingApprovalsByKey.delete(key); } };
    send({ type: 'approval', id, tool: toolName, input });
    return await new Promise((resolve) => {
      const finalize = (result) => { pendingApprovals.delete(id); cleanupKey(); resolve(result); };
      const decide = (decision) => {
        if (decision === 'always') { if (sessionKey) addSessionAllow(sessionKey, toolName); finalize({ behavior: 'allow', updatedInput: input }); }
        else if (decision === 'allow') { finalize({ behavior: 'allow', updatedInput: input }); }
        else finalize({ behavior: 'deny', message: 'Запрещено пользователем' });
      };
      pendingApprovals.set(id, { decide, tool: toolName, input, sessionKey: key });   // tool/input — для ре-сёрфейса карточки при перезаходе
      const sig = opts && opts.signal;
      if (sig) {
        if (sig.aborted) decide('deny');
        else sig.addEventListener('abort', () => { if (pendingApprovals.has(id)) decide('deny'); }, { once: true });
      }
    });
  };

  // Пользовательский ввод (AskUserQuestion/ExitPlanMode). Инструмент авто-выполняется (canUseTool allow), а его вывод
  // здесь ПОДМЕНЯЕТСЯ реальным ответом человека: PostToolUse-hook блокирует ход, пока не придёт /api/answer. При закрытом
  // канале (ушёл с экрана) вопрос всё равно регистрируем и шлём — подхватится ре-сёрфейсом при перезаходе. Сами НЕ
  // резолвим по closed/таймауту; на abort (Стоп) отпускаем пустым — модель получит исходный вывод авто-инструмента.
  const awaitUserInput = (prefix, questions, buildOutput, opts) => {
    const id = prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const key = sessionKey;
    if (key) { let set = pendingQuestionsByKey.get(key); if (!set) { set = new Set(); pendingQuestionsByKey.set(key, set); } set.add(id); }
    const cleanup = () => { pendingQuestions.delete(id); const s = key && pendingQuestionsByKey.get(key); if (s) { s.delete(id); if (!s.size) pendingQuestionsByKey.delete(key); } };
    send({ type: 'question', id, questions });
    return new Promise((resolve) => {
      pendingQuestions.set(id, { questions, sessionKey: key, resolve: (answers) => { cleanup(); resolve(buildOutput(answers)); } });
      const sig = opts && opts.signal;
      if (sig) {
        if (sig.aborted) { cleanup(); resolve({}); }
        else sig.addEventListener('abort', () => { if (pendingQuestions.has(id)) { cleanup(); resolve({}); } }, { once: true });
      }
    });
  };
  const askQuestionHook = async (input, _toolUseId, opts) => {
    const questions = (input && input.tool_input && Array.isArray(input.tool_input.questions)) ? input.tool_input.questions : [];
    return awaitUserInput('aq_', questions, (answers) => ({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: { questions, answers } } }), opts);
  };
  const exitPlanHook = async (input, _toolUseId, opts) => {
    const plan = (input && input.tool_input && typeof input.tool_input.plan === 'string') ? input.tool_input.plan : '';
    const questions = [{ question: 'Принять план и продолжить?', header: 'План', plan, options: [{ label: 'Принять' }, { label: 'Оставить в плане' }], multiSelect: false }];
    return awaitUserInput('ep_', questions, (answers) => ({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: { answers } } }), opts);
  };

  send({ type: 'start', streamId, sessionId: sessionId || '', cwd: cwd || '', isNew });
  try {
    const query = await getSdkQuery();
    const options = {
      cwd,
      permissionMode: mode,           // P3: default | acceptEdits | plan | bypassPermissions (из &mode=)
      canUseTool,                     // read-only → авто-allow; мутирующее → SSE approval + ожидание решения
      hooks: {
        PostToolUse: [
          { matcher: 'AskUserQuestion', hooks: [askQuestionHook] },   // вопрос с вариантами — всегда ждём ответ пользователя
          { matcher: 'ExitPlanMode', hooks: [exitPlanHook] },         // выход из плана — принять/оставить, решает пользователь
        ],
      },
      settingSources: ['user', 'project', 'local'],   // как настоящая CC-сессия: скиллы (/dev-workflow…), CLAUDE.md, агенты
      skills: 'all',                                   // явно включаем все найденные скиллы
      managedSettings: { permissions: { ask: MANAGED_ASK } },   // страж поверх project-allow (см. MANAGED_ASK)
      includePartialMessages: true,   // дельты текста ассистента
      abortController: ac,
      maxTurns: 200,   // автономность: дефолт 24 обрывал длинные ходы (bugfix с Read/Grep/Bash легко >24 шагов) — SDK молча
                       // отдавал result subtype=error_max_turns, и сессия «просто останавливалась». 200 покрывает реальные
                       // задачи; если всё же упрётся — клиент покажет причину и кнопку «Продолжить» (resume).
    };
    if (model) options.model = model;          // выбор модели из футера ('' = дефолт сессии/аккаунта)
    if (effort) options.effort = effort;       // выбор reasoning-effort из футера
    if (!isNew) options.resume = sessionId;   // существующая сессия / форк — resume; новая — без resume
    if (isFork) options.forkSession = true;   // форк: resume создаёт НОВЫЙ session_id (контекст исходной), оригинал не трогаем
    options.systemPrompt = { type: 'preset', preset: 'claude_code' };   // CLAUDE.md грузится нативно через settingSources('project')
    const q = query({ prompt: channel.gen(), options });
    let lastWin, lastCtx, lastSub, lastErr = false;
    for await (const m of q) {
      if (m.type === 'result') {   // конец ОДНОГО хода — обрабатываем ВСЕГДА (в т.ч. при closed), иначе канал не закроется и query зависнет
        const u = m.usage || {};
        const win = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        lastWin = win; lastCtx = win ? Math.min(win / CTX_LIMIT, 1) : undefined; lastSub = m.subtype; lastErr = !!m.is_error;
        if (!closed) send({ type: 'turn', subtype: m.subtype, isError: !!m.is_error, winTokens: win || undefined, ctxPct: lastCtx });   // граница хода: обновить контекст/индикатор, но стрим НЕ рвём
        if (channel.pending() === 0) channel.end();   // нет подкинутого ввода → закрываем канал (query завершится); есть → steering: следующий ход в той же сессии
        continue;
      }
      if (closed) continue;   // клиент ушёл — продолжаем вычитывать поток (CLI дорабатывает и пишет .jsonl), но в закрытый res не шлём
      if (m.type === 'system' && m.subtype === 'init') {
        send({ type: 'system', model: m.model, apiKeySource: m.apiKeySource });
        if ((isNew || isFork) && m.session_id) {         // новая/форкнутая сессия → сообщаем клиенту НОВЫЙ файл (переключиться/тейлить)
          sessionKey = m.session_id;
          streamEntry.key = sessionKey;                              // новая/форкнутая сессия узнала id → привязываем активный ход к её файлу
          setRunStatus(sessionKey, { state: 'running', streamId, subtype: '', isError: false, reason: '' });   // R1/R2: id узнали только сейчас — теперь ход виден в run-store
          const rel = String(cwd).replace(/[^a-zA-Z0-9]/g, '-') + '/' + m.session_id + '.jsonl';
          if (newName) { try { setName(rel, newName); } catch {} }   // закрепляем имя серверно тем же rel — без гонки с клиентским POST и без расхождения ключа/регистра
          send({ type: 'session', id: m.session_id, file: rel });
        }
      } else if (m.type === 'stream_event') {
        const ev = m.event;
        if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
          send({ type: 'text', delta: ev.delta.text });
        } else if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'thinking_delta') {
          send({ type: 'thinking', delta: ev.delta.thinking });   // живое размышление (в сохранённом транскрипте оно пустое)
        } else if (ev.type === 'content_block_start' && ev.content_block && ev.content_block.type === 'tool_use') {
          send({ type: 'tool', name: ev.content_block.name });
        }
      } else if (m.type === 'assistant' && m.error) {
        send({ type: 'error', message: String(m.error) });
      }
    }
    if (!closed) send({ type: 'done', subtype: lastSub, isError: lastErr, winTokens: lastWin || undefined, ctxPct: lastCtx });   // весь query завершился (канал закрыт и осушен)
    const state = lastSub === 'error_max_turns' ? 'max_turns' : (lastErr ? 'error' : 'done');
    markRun(state, lastSub, lastErr, state === 'max_turns' ? 'Достигнут лимит ходов (maxTurns)' : (state === 'error' ? 'Ход завершился ошибкой' : ''));
  } catch (e) {
    channel.end();   // прекратить ожидание ввода на ошибке/аборте
    const aborted = ac.signal.aborted;   // Стоп (/api/stop → ac.abort) — намеренная остановка, не сбой
    const emsg = (e && e.message) ? e.message : String(e);
    if (!closed) send({ type: 'error', message: emsg });
    markRun(aborted ? 'aborted' : 'error', 'exception', !aborted, aborted ? 'Остановлено пользователем' : emsg);
  } finally {
    clearInterval(heartbeat);
    activeStreams.delete(streamId);
    if (!closed) { try { res.end(); } catch {} }
  }
}

// Steering: докинуть промт в ЖИВОЙ ход сессии (streaming-input). Находим активный поток по ключу сессии и пушим
// user-сообщение в его канал — SDK возьмёт его на ближайшей границе хода. Нет живого потока / канал закрылся →
// { ok:false }: клиент запустит обычный новый ход (fallback без потери промта).
export async function apiChatInput(req, res, u) {
  let body = {};
  try { body = await readJsonBody(req, STAGE_MAX_BYTES); } catch {}
  const file = String(body.file || u.searchParams.get('file') || '');
  const key = file ? path.basename(file).replace(/\.jsonl$/, '') : '';
  const prompt = String(body.prompt || '');
  const attachments = Array.isArray(body.attachments) ? body.attachments.slice(0, 20) : [];
  if (!prompt.trim() && !attachments.length) { sendJSON(res, { ok: false, reason: 'empty' }); return; }
  let pushed = false;
  if (key) for (const e of activeStreams.values()) { if (e && e.key === key && typeof e.push === 'function') { pushed = e.push(buildUserMessage(prompt, attachments)) === true; break; } }
  sendJSON(res, { ok: pushed });
}

// Явный обрыв хода: по streamId (живой стрим) ИЛИ по файлу сессии (после перезахода streamId у клиента потерян, но ход
// на сервере жив — рвём по session_id). Гарантированно останавливает SDK-запрос независимо от детекта дисконнекта.
export function apiStop(res, u) {
  const id = u.searchParams.get('id') || '';
  const file = u.searchParams.get('file') || '';
  if (id) {
    const e = activeStreams.get(id);
    if (e) { try { e.ac.abort(); } catch {} activeStreams.delete(id); }
  } else if (file) {
    const key = path.basename(file).replace(/\.jsonl$/, '');
    for (const [sid, e] of activeStreams) { if (e && e.key === key) { try { e.ac.abort(); } catch {} activeStreams.delete(sid); } }
  }
  sendJSON(res, { ok: true });
}

// Решение по аппруву от клиента: allow | deny | always. Нет id (двойной клик/устарело) — тихо ok.
export function apiApprove(res, u) {
  const id = u.searchParams.get('id') || '';
  const decision = u.searchParams.get('decision') || 'deny';
  const p = pendingApprovals.get(id);
  if (p) { try { p.decide(decision); } catch { /* уже снят */ } }
  sendJSON(res, { ok: true });
}

// Ответ пользователя на вопрос (AskUserQuestion/ExitPlanMode). answers = { [текст вопроса]: выбранный лейбл(ы) }.
// POST-телом (обычный путь клиента) либо GET-параметром answers=<json> (зеркало /api/approve). Нет id → тихо ok:false.
export async function apiAnswer(req, res, u) {
  let id = u.searchParams.get('id') || '';
  let answers = null;
  if (req.method === 'POST') { try { const body = await readJsonBody(req, 256 * 1024); if (body.id) id = String(body.id); answers = body.answers; } catch {} }
  if (answers == null) { const raw = u.searchParams.get('answers') || ''; if (raw) { try { answers = JSON.parse(raw); } catch {} } }
  if (answers == null || typeof answers !== 'object') answers = {};
  const p = pendingQuestions.get(id);
  if (p && typeof p.resolve === 'function') { try { p.resolve(answers); } catch { /* уже снят */ } sendJSON(res, { ok: true }); return; }
  sendJSON(res, { ok: false });
}

// Ре-сёрфейс: висящие (неотвеченные) вопросы для сессии этого файла. sessionKey = session_id = basename без .jsonl —
// тот же ключ, что apiChat кладёт в pendingQuestionsByKey. Клиент при перезаходе дорисует карточки и снова ждёт ответ.
export function apiPendingQuestions(res, u) {
  const file = u.searchParams.get('file') || '';
  const sessionKey = path.basename(file).replace(/\.jsonl$/, '');
  const set = pendingQuestionsByKey.get(sessionKey);
  const questions = [];
  if (set) { for (const id of set) { const rec = pendingQuestions.get(id); if (rec) questions.push({ id, questions: rec.questions }); } }
  sendJSON(res, { questions });
}

// Ре-сёрфейс висящих аппрувов сессии (зеркало apiPendingQuestions): обрыв SSE их не решает, они ждут решения — при
// перезаходе клиент дорисует карточки. Отдаём tool+input (как в живом send({type:'approval'})), решение идёт в /api/approve.
export function apiPendingApprovals(res, u) {
  const file = u.searchParams.get('file') || '';
  const sessionKey = path.basename(file).replace(/\.jsonl$/, '');
  const set = pendingApprovalsByKey.get(sessionKey);
  const approvals = [];
  if (set) { for (const id of set) { const rec = pendingApprovals.get(id); if (rec) approvals.push({ id, tool: rec.tool, input: rec.input }); } }
  sendJSON(res, { approvals });
}
