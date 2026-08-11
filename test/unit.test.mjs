// Юнит-тесты чистых хелперов server.mjs (node:test, zero-dep). Импорт server.mjs не слушает порт (не _isMain).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import { detectClientCuFromText, detectBranchFromText, detectTargetEnvFromText, tailActivity, terminalFor } from '../server/sessions.mjs';
import { fetchRetry, isTransientStatus, runStatus, writeJsonAtomic } from '../server/core.mjs';
import { firstString, lastString, lastUsageWindow } from '../server/text.mjs';

const SRV = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'server.mjs')).href;
// Динамический импорт server.mjs — ДО объявления тестов: node:test может начать выполнять уже объявленные тесты,
// не дождавшись top-level await ниже (так CI на Node 20 падал с «Cannot access 'buildSessionBlocks' before initialization»).
const {
  isBaseBranch, pickWorkingBranch, pickBaseBranch,
  classifyUserBlock, buildSessionBlocks, wfInfo, scopeInfo,
  isReadOnlyTool, briefArg, woOf, buildUserMessage, makeInputChannel,
} = await import(SRV);

test('detectClientCuFromText: копия из cwd-полей (реальная рабочая папка), а не из вскользь-упоминаний', () => {
  const txt = '"cwd":"D:/wo/client-unity-2/Assets" ... "cwd":"D:/wo/client-unity-2" ... а в тексте client-unity-1 client-unity-1 client-unity-1';
  assert.equal(detectClientCuFromText(txt), 'cu2', 'cwd-поля указывают на 2, хоть 1 упомянут чаще');
  assert.equal(detectClientCuFromText('без копий'), '');
});
test('detectBranchFromText: только ветка WO самой сессии (чужую задачу отсекает даже если чаще)', () => {
  const txt = 'WO-14178-x WO-14178-x WO-14178-x, а рабочая WO-13887-chat-r4-r5-realtime-preprod';
  assert.equal(detectBranchFromText(txt, 'WO-13887'), 'WO-13887-chat-r4-r5-realtime-preprod');
  assert.equal(detectBranchFromText(txt, ''), '', 'без WO сессии не угадываем');
  assert.equal(detectBranchFromText('нет веток', 'WO-1'), '');
});
test('detectTargetEnvFromText: целевой сквад из текста (самое частое упоминание), preprod не ловим', () => {
  assert.equal(detectTargetEnvFromText('окружение: squad40 ... раскатываю squad40 на squad40'), 'squad-40');
  assert.equal(detectTargetEnvFromText('squad-7 и squad-7 против squad-12'), 'squad-7');
  assert.equal(detectTargetEnvFromText('деплой на preprod'), '', 'preprod — базовая ветка, не сквад');
  assert.equal(detectTargetEnvFromText('нет окружения'), '');
});
test('tailActivity: «что делает» из последнего блока ленты', () => {
  assert.equal(tailActivity([{ kind: 'tool', name: 'Bash', arg: 'git commit', result: '' }]), '⚙ Bash · git commit', 'инструмент без result → выполняется');
  assert.equal(tailActivity([{ kind: 'tool', name: 'Read', arg: '/a/b.cs', result: 'ok' }]), '', 'инструмент с result (завершён) → общий «работает»');
  assert.equal(tailActivity([{ kind: 'thinking', text: '...' }]), '✻ размышляет');
  assert.equal(tailActivity([{ kind: 'assistant', text: 'ответ' }]), '✍ пишет ответ');
  assert.equal(tailActivity([{ kind: 'user', text: 'привет' }]), '', 'человеческий блок → без активности');
  assert.equal(tailActivity([]), '', 'пусто → пусто');
});

test('buildSessionBlocks: attachment max_turns_reached → maxTurnsTs (disk-маркер лимита ходов)', () => {
  const jl = [
    '{"type":"user","message":{"role":"user","content":"привет"},"timestamp":"2026-08-04T10:00:00.000Z"}',
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ответ"}]},"timestamp":"2026-08-04T10:00:05.000Z"}',
    '{"type":"attachment","attachment":{"type":"max_turns_reached","maxTurns":200,"turnCount":201},"timestamp":"2026-08-04T10:01:00.000Z"}',
  ].join('\n');
  const r = buildSessionBlocks(jl);
  assert.equal(r.maxTurnsTs, Date.parse('2026-08-04T10:01:00.000Z'), 'фиксируем время терминального attachment');
  assert.ok(r.maxTurnsTs > r.lastUserTs, 'лимит наступил после последнего промпта человека → незакрытый терминал');
  assert.equal(buildSessionBlocks('{"type":"user","message":{"role":"user","content":"x"}}').maxTurnsTs, 0, 'нет attachment → 0');
});

test('terminalFor: serverActive гасит; run-store и disk-маркер новее промпта → маркер; старее / done → null', () => {
  const key = 'sess-term-test';
  const cleanup = () => runStatus.delete(key);
  cleanup();
  // живой ход на сервере — терминал не показываем даже при записи в run-store
  runStatus.set(key, { state: 'max_turns', reason: 'лимит', ts: 5000 });
  assert.equal(terminalFor(key, 1000, 0, true), null, 'serverActive → null (ход ещё жив)');
  // run-store max_turns новее последнего промпта → показываем
  assert.deepEqual(terminalFor(key, 1000, 0, false), { state: 'max_turns', reason: 'лимит' });
  // пользователь уже продолжил (промпт новее терминала) → маркер снят
  assert.equal(terminalFor(key, 9000, 0, false), null, 'lastUserTs > run.ts → уже продолжено');
  // успешное завершение не сюрфейсим
  runStatus.set(key, { state: 'done', ts: 5000 });
  assert.equal(terminalFor(key, 1000, 0, false), null, 'done → без ноты');
  // осиротевший перезапуском
  runStatus.set(key, { state: 'orphaned', reason: 'Ход прерван перезапуском Deck', ts: 5000 });
  assert.equal(terminalFor(key, 1000, 0, false).state, 'orphaned');
  // disk-маркер max_turns без записи в run-store (сессия запущена мимо Deck)
  cleanup();
  assert.equal(terminalFor(key, 1000, 8000, false).state, 'max_turns', 'disk maxTurnsTs новее промпта → max_turns');
  assert.equal(terminalFor(key, 9000, 8000, false), null, 'disk-маркер старее промпта → null');
  cleanup();
});

test('D5: per-line экстракторы читают top-level поле, игнорируя ключ внутри tool_result', () => {
  // l1 — реальное событие (top-level cwd/aiTitle/lastPrompt). l2 — tool_result со СТРУКТУРНЫМ (не экранированным)
  // ключом aiTitle/cwd внутри контента: старый глобальный regex взял бы их как «последние», per-line JSON — нет.
  const l1 = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }, cwd: '/real', aiTitle: 'REAL', lastPrompt: 'do it' });
  const l2 = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'x' }], meta: { aiTitle: 'FAKE', cwd: '/evil' } }] } });
  const text = l1 + '\n' + l2;
  assert.equal(lastString(text, 'aiTitle'), 'REAL', 'вложенный FAKE не перебивает реальный top-level aiTitle');
  assert.equal(firstString(text, 'cwd'), '/real', 'вложенный /evil игнорируется — берём top-level cwd');
  assert.equal(firstString('{"type":"user","message":{"role":"user","content":"нет cwd"}}', 'cwd'), null, 'нет поля → null');
});

test('writeJsonAtomic: пишет полный JSON и не оставляет .tmp (temp+rename) — D1', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-atomic-'));
  const f = path.join(dir, 'store.json');
  writeJsonAtomic(f, { a: 1, b: 'два', arr: [1, 2, 3] });
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { a: 1, b: 'два', arr: [1, 2, 3] });
  assert.equal(fs.readdirSync(dir).filter((n) => n.includes('.tmp')).length, 0, 'временный файл не остаётся после rename');
  writeJsonAtomic(f, { a: 2 });   // перезапись поверх — атомарно
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { a: 2 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('isTransientStatus: 429/5xx транзиентны (повтор имеет шанс), 2xx/4xx — нет', () => {
  for (const s of [429, 500, 502, 503, 599]) assert.equal(isTransientStatus(s), true, String(s));
  for (const s of [200, 301, 400, 404, 409]) assert.equal(isTransientStatus(s), false, String(s));
});

test('fetchRetry: повторяет транзиентные до первого успеха; 4xx не повторяет; исчерпание отдаёт последний ответ', async () => {
  const orig = globalThis.fetch;
  // сценарный фейк fetch: отдаёт элементы seq по очереди (последний — залипает), Error → throw. Считает вызовы.
  const scripted = (seq) => { const f = async () => { const v = seq[Math.min(f.calls, seq.length - 1)]; f.calls++; if (v instanceof Error) throw v; return v; }; f.calls = 0; return f; };
  try {
    let f = scripted([{ ok: false, status: 503 }, { ok: false, status: 503 }, { ok: true, status: 200 }]);
    globalThis.fetch = f;
    let r = await fetchRetry('x', {}, { retries: 2, baseDelay: 1 });
    assert.equal(r.status, 200, '503,503,200 → вернул успех');
    assert.equal(f.calls, 3, 'ровно 3 попытки (initial + 2 ретрая)');

    f = scripted([{ ok: false, status: 503 }]);
    globalThis.fetch = f;
    r = await fetchRetry('x', {}, { retries: 2, baseDelay: 1 });
    assert.equal(r.status, 503, 'всегда 503 → отдаёт последний ответ, не бросает');
    assert.equal(f.calls, 3, 'попытки исчерпаны на 3');

    f = scripted([{ ok: false, status: 404 }, { ok: true, status: 200 }]);
    globalThis.fetch = f;
    r = await fetchRetry('x', {}, { retries: 2, baseDelay: 1 });
    assert.equal(r.status, 404, '4xx не повторяем');
    assert.equal(f.calls, 1, 'ровно одна попытка на 404');

    f = scripted([new Error('network'), { ok: true, status: 200 }]);
    globalThis.fetch = f;
    r = await fetchRetry('x', {}, { retries: 2, baseDelay: 1 });
    assert.equal(r.status, 200, 'сетевая ошибка → ретрай → успех');
    assert.equal(f.calls, 2);

    f = scripted([new Error('down')]);
    globalThis.fetch = f;
    await assert.rejects(fetchRetry('x', {}, { retries: 1, baseDelay: 1 }), /down/, 'сеть падает всегда → бросает после исчерпания');
  } finally { globalThis.fetch = orig; }
});


test('buildUserMessage: текст+вложения → SDKUserMessage с массивом content-блоков', () => {
  const m = buildUserMessage('привет', []);
  assert.equal(m.type, 'user');
  assert.equal(m.message.role, 'user');
  assert.ok(Array.isArray(m.message.content), 'content — массив');
  assert.equal(m.message.content[0].type, 'text');
  assert.equal(m.message.content[0].text, 'привет');
  const img = buildUserMessage('', [{ kind: 'image', dataB64: 'AAA', mediaType: 'image/png' }]);
  assert.ok(img.message.content.some((b) => b.type === 'image'), 'картинка → image-блок');
  // Файл-вложение путём (дампы/логи любого размера): путь попадает в текст промта — Claude прочитает его Read'ом.
  const pf = buildUserMessage('глянь', [{ kind: 'path', name: 'dump.sql', path: '/tmp/dump.sql' }]);
  const txt = pf.message.content.find((b) => b.type === 'text').text;
  assert.ok(txt.includes('/tmp/dump.sql') && /Read/.test(txt), 'путь вложения + подсказка Read в тексте');
});

test('makeInputChannel: gen отдаёт message, ждёт push, осушает очередь; pid — дедуп + onConsume', async () => {
  const consumed = [];
  const ch = makeInputChannel({ message: { n: 1 }, pid: 'a' });
  ch.setOnConsume((p) => consumed.push(p));
  const it = ch.gen();
  assert.deepEqual((await it.next()).value, { n: 1 }, 'первое сообщение (это item.message)');
  const p = it.next();                     // очередь пуста → ждёт
  assert.equal(ch.push({ message: { n: 2 }, pid: 'b' }), true, 'push в открытый канал → true');
  assert.deepEqual((await p).value, { n: 2 }, 'push разбудил ожидание');
  assert.equal(ch.push({ message: { n: 9 }, pid: 'b' }), true, 'дубль pid принят (true), но в очередь не встал');
  ch.push({ message: { n: 3 }, pid: 'c' });   // лежит в очереди
  ch.end();
  assert.equal(ch.push({ message: { n: 4 }, pid: 'd' }), false, 'после end push отвергнут');
  assert.deepEqual((await it.next()).value, { n: 3 }, 'очередь осушается перед закрытием (дубль b не всплыл)');
  assert.equal((await it.next()).done, true, 'осушено → gen завершается');
  assert.deepEqual(consumed, ['a', 'b', 'c'], 'onConsume(pid) вызван в момент выдачи каждого сообщения, дубль b — один раз');
  assert.equal(ch.hasPid('a'), true, 'hasPid помнит виденные pid');
});

test('isBaseBranch: базовые ветки → true, рабочая/пустая', () => {
  for (const b of ['preprod', 'preupdate', 'master', 'main', 'develop', 'dev', 'prod', 'release']) assert.equal(isBaseBranch(b), true, b);
  assert.equal(isBaseBranch('PREPROD'), true, 'регистронезависимо');
  assert.equal(isBaseBranch('  preprod  '), true, 'с пробелами');
  assert.equal(isBaseBranch(''), true, 'пустая = базовая');
  assert.equal(isBaseBranch(null), true, 'null = пустая = базовая');
  assert.equal(isBaseBranch('WO-123-fix'), false, 'рабочая ветка');
  assert.equal(isBaseBranch('feature-x'), false);
});

test('pickWorkingBranch: WO-ветка > не-базовая > последняя', () => {
  assert.equal(pickWorkingBranch(['preprod', 'WO-123-x', 'preprod']), 'WO-123-x', 'WO предпочтительнее базовых');
  assert.equal(pickWorkingBranch(['WO-1', 'WO-2']), 'WO-2', 'последняя WO');
  assert.equal(pickWorkingBranch(['preprod', 'feature-y']), 'feature-y', 'не-базовая без WO');
  assert.equal(pickWorkingBranch(['preprod', 'preupdate']), 'preupdate', 'только базовые → последняя');
  assert.equal(pickWorkingBranch([]), '', 'пусто → пусто');
});

test('pickBaseBranch: первая базовая из истории; иначе пусто', () => {
  assert.equal(pickBaseBranch(['WO-123-x', 'preprod', 'WO-123-x']), 'preprod', 'первая базовая');
  assert.equal(pickBaseBranch(['WO-1', 'feature']), '', 'нет базовой → пусто (фолбэк на targetEnv у вызывающего)');
  assert.equal(pickBaseBranch(['head', 'preupdate']), 'preupdate', 'head пропускается, берём базовую');
  assert.equal(pickBaseBranch([]), '');
});

test('woOf: извлечение WO-номера', () => {
  assert.equal(woOf('WO-14019-throne'), 'WO-14019');
  assert.equal(woOf('feature-x'), '');
  assert.equal(woOf(null), '');
});

test('classifyUserBlock: происхождение user-строки', () => {
  assert.deepEqual(classifyUserBlock('<task-notification>agent done</task-notification>'), { kind: 'system', text: '⚙ фоновая задача' });
  assert.deepEqual(classifyUserBlock('<command-name>deploy</command-name>'), { kind: 'command', text: '/deploy' });
  assert.deepEqual(classifyUserBlock('[Request interrupted by user'), { kind: 'system', text: '⛔ прервано пользователем' });
  assert.equal(classifyUserBlock('Caveat: The messages below were generated…'), null, 'Caveat → drop');
  assert.equal(classifyUserBlock('<local-command-stdout>x</local-command-stdout>'), null, 'local-command-stdout → drop');
  assert.equal(classifyUserBlock('   '), null, 'пусто → drop');
  const u = classifyUserBlock('Почини баг');
  assert.equal(u.kind, 'user');
  assert.equal(u.text, 'Почини баг');
  const s = classifyUserBlock('<system-reminder>ignore me</system-reminder>реальный вопрос');
  assert.equal(s.kind, 'user');
  assert.equal(s.text, 'реальный вопрос', 'system-reminder вырезается');
});

test('isReadOnlyTool: read → true, мутирующие → false', () => {
  for (const t of ['Read', 'Grep', 'Glob', 'WebFetch', 'mcp__mcp-tools__git_read_file', 'mcp__x__search_context', 'mcp__x__list_things']) assert.equal(isReadOnlyTool(t), true, t);
  for (const t of ['Write', 'Bash', 'Edit', 'mcp__mcp-tools__jira_create_issue', 'mcp__x__deploy', 'mcp__x__trigger_build']) assert.equal(isReadOnlyTool(t), false, t);
});

test('briefArg: сводка аргумента tool_use', () => {
  assert.equal(briefArg({ file_path: '/a/b.cs' }), '/a/b.cs');
  assert.equal(briefArg({ command: 'ls -la' }), 'ls -la');
  assert.equal(briefArg({ pattern: 'foo.*bar' }), 'foo.*bar');
  assert.equal(briefArg({ foo: 'bar' }), 'bar', 'неизвестный ключ → первая строка');
  assert.equal(briefArg({}), '');
  assert.equal(briefArg(null), '');
  assert.ok(briefArg({ file_path: 'x'.repeat(200) }).endsWith('…'), 'длинное усечено');
});

test('wfInfo: маппинг стадий dev-workflow → колонка', () => {
  assert.deepEqual(wfInfo(null, false), { wfColumn: 'todo' }, 'нет состояния, неактивна → todo');
  assert.deepEqual(wfInfo(null, true), { wfColumn: 'active' }, 'нет состояния, активна → active');

  const build = wfInfo({ currentStep: 5, client: { buildTriggered: true } }, false);
  assert.equal(build.wfColumn, 'build');
  assert.equal(build.wfBuildState, 'running', 'buildTriggered → running');

  const qaLocal = wfInfo({ currentStep: 8, client: { createdMR: { url: 'http://mr/1' } }, testedOnSquad: false }, false);
  assert.equal(qaLocal.wfColumn, 'qa');
  assert.equal(qaLocal.wfQa, 'localcheck', 'MR открыт, не отдан на QA → ждёт локальной проверки');

  const qaHanded = wfInfo({ currentStep: 8, client: { createdMR: { url: 'http://mr/1' } }, testedOnSquad: false, readyForQA: true }, false);
  assert.equal(qaHanded.wfQa, 'qa', 'readyForQA → отдан на QA');

  const rmApproval = wfInfo({ currentStep: 8, serverApprovalRequired: true, approvedForMR: false }, false);
  assert.equal(rmApproval.wfColumn, 'readymerge', 'ждёт серверного аппрува');

  const rmTested = wfInfo({ currentStep: 9, client: { createdMR: { url: 'http://mr/2' } }, testedOnSquad: true }, false);
  assert.equal(rmTested.wfColumn, 'readymerge', 'MR открыт + оттестировано → ждёт мерджа');

  const done = wfInfo({ currentStep: 13 }, false);
  assert.equal(done.wfColumn, 'done');
  assert.equal(done.wfMrState, 'merged');
});

test('scopeInfo: скоуп из dev-workflow-состояния', () => {
  assert.equal(scopeInfo(null, '').backend, false, 'нет состояния → пустой скоуп');
  const s = scopeInfo({ scope: 'full', backend: { changedServices: ['town', 'map'] }, targetEnv: 'squad-7', currentStep: 5 }, '/repo/client-unity-2/x');
  assert.equal(s.backend, true);
  assert.deepEqual(s.changedServices, ['town', 'map']);
  assert.equal(s.targetEnv, 'squad-7');
  assert.equal(s.clientCu, 'cu2', 'клиентская копия из cwd');
  assert.equal(s.merged, false);
  const nonEnv = scopeInfo({ targetEnv: 'null' }, '');
  assert.equal(nonEnv.targetEnv, '', '«null» targetEnv нормализуется в пусто');
});

test('buildSessionBlocks: лента блоков, шум отфильтрован, tool_result подшит', () => {
  const lines = [
    { type: 'user', cwd: '/repo', gitBranch: 'WO-999-x', message: { role: 'user', content: 'Почини баг' } },
    { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-4-8', content: [
      { type: 'thinking', thinking: 'размышляю' },
      { type: 'text', text: 'Смотрю код' },
      { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a/b.cs' } },
    ], usage: { input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 20 } } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'содержимое файла' }] } },
    { type: 'user', isMeta: true, message: { role: 'user', content: '<command-name>skill</command-name>' } },
    { type: 'user', message: { role: 'user', content: '<task-notification>agent done</task-notification>' } },
    { type: 'assistant', message: { role: 'assistant', content: [
      { type: 'thinking', thinking: '   ' },
      { type: 'text', text: 'Готово' },
    ] } },
    { type: 'user', message: { role: 'user', content: 'Caveat: служебное' } },
  ];
  const text = lines.map((l) => JSON.stringify(l)).join('\n');
  const { blocks, model, branches, winTokens } = buildSessionBlocks(text);

  const users = blocks.filter((b) => b.kind === 'user');
  assert.equal(users.length, 1, 'ровно одна человеческая реплика (isMeta/Caveat/task-notification отфильтрованы)');
  assert.equal(users[0].text, 'Почини баг');

  const tools = blocks.filter((b) => b.kind === 'tool');
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'Read');
  assert.equal(tools[0].result, 'содержимое файла', 'tool_result подшит к своему tool_use');

  const thinking = blocks.filter((b) => b.kind === 'thinking');
  assert.equal(thinking.length, 1, 'пустой thinking опущен, непустой оставлен');
  assert.equal(thinking[0].text, 'размышляю');

  const system = blocks.filter((b) => b.kind === 'system');
  assert.equal(system.length, 1);
  assert.equal(system[0].text, '⚙ фоновая задача');

  assert.ok(!blocks.some((b) => (b.text || '').startsWith('Caveat')), 'Caveat не попал в ленту');
  assert.equal(model, 'claude-opus-4-8');
  assert.ok(branches.includes('WO-999-x'));
  assert.equal(winTokens, 150, 'токены хода = input + cache_read + cache_creation');

  const assistantWithMeta = blocks.find((b) => b.kind === 'assistant' && b.meta);
  assert.ok(assistantWithMeta, 'usage-мета навешана на текст/thinking-блок хода');
  assert.equal(assistantWithMeta.meta.in, 150);
});

test('окно контекста после сжатия: предсжатый usage не показывается как занятое окно', () => {
  const LF = String.fromCharCode(10);
  const big = JSON.stringify({ type:'assistant', message:{ role:'assistant', model:'claude-opus-5', content:[{ type:'text', text:'много' }], usage:{ input_tokens:5, cache_read_input_tokens:970_000, output_tokens:100 } } });
  const boundary = JSON.stringify({ type:'user', message:{ role:'user', content:'This session is being continued from a previous conversation that ran out of context.' + LF + LF + 'Summary:' + LF + '1. итог' }, timestamp:'2026-08-05T10:30:00Z' });
  const small = JSON.stringify({ type:'assistant', message:{ role:'assistant', model:'claude-opus-5', content:[{ type:'text', text:'дальше' }], usage:{ input_tokens:5, cache_read_input_tokens:78_000, output_tokens:20 } } });
  const zeroUsage = JSON.stringify({ type:'assistant', message:{ role:'assistant', model:'<synthetic>', content:[{ type:'text', text:'x' }], usage:{ input_tokens:0, output_tokens:0 } } });

  assert.equal(buildSessionBlocks(big).winTokens, 970_005, 'до сжатия — реальный объём окна');
  const after = buildSessionBlocks(big + LF + boundary);
  assert.equal(after.winTokens, 0, 'сразу после сжатия объём неизвестен (0), а не предсжатые 970k = полная полоса');
  assert.equal(after.blocks.filter((b) => b.kind === 'compact').length, 1, 'вставка продолжения — свой вид блока, не «Ты»');
  assert.equal(buildSessionBlocks(big + LF + boundary + LF + small).winTokens, 78_005, 'первый ответ нового отрезка задаёт реальный объём');
  assert.equal(buildSessionBlocks(big + LF + zeroUsage).winTokens, 970_005, 'нулевой usage служебного ответа не обнуляет известный объём');

  assert.equal(lastUsageWindow(big), 970_005, 'список карточек: до сжатия — реальный объём');
  assert.equal(lastUsageWindow(big + LF + boundary), 0, 'список карточек: после сжатия предсжатый usage не берём');
  assert.equal(lastUsageWindow(big + LF + boundary + LF + small), 78_005);
  assert.equal(lastUsageWindow(big + LF + zeroUsage), 970_005, 'нулевой usage пропускаем, берём предыдущий известный');
});

test('buildSessionBlocks: image-вложение → блок kind:image с data (после перезахода скрин виден)', () => {
  const jl = JSON.stringify({ type:'user', message:{ role:'user', content:[ { type:'text', text:'смотри скрин' }, { type:'image', source:{ type:'base64', media_type:'image/png', data:'AAAA' } } ] } });
  const r = buildSessionBlocks(jl);
  const img = r.blocks.find((b) => b.kind === 'image');
  assert.ok(img, 'image-блок создан'); assert.equal(img.data, 'AAAA'); assert.equal(img.media, 'image/png');
});
