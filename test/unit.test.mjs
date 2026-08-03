// Юнит-тесты чистых хелперов server.mjs (node:test, zero-dep). Импорт server.mjs не слушает порт (не _isMain).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectClientCuFromText, detectBranchFromText } from '../sessions.mjs';

const SRV = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs')).href;

test('detectClientCuFromText: клиентская копия из путей сессии (самая частая), не из cwd', () => {
  assert.equal(detectClientCuFromText('правки в client-unity-2/Assets и ещё client-unity-2/foo, вскользь client-unity-1'), 'cu2');
  assert.equal(detectClientCuFromText('cwd d:/wo_vibecode/vibecode, ничего про копии'), '');
});
test('detectBranchFromText: рабочая ветка из текста (самый частый WO-токен ветки)', () => {
  assert.equal(detectBranchFromText('ветка WO-13887-chat-r4-r5-realtime-preprod; снова WO-13887-chat-r4-r5-realtime-preprod; мимоходом WO-14178-x'), 'WO-13887-chat-r4-r5-realtime-preprod');
  assert.equal(detectBranchFromText('просто текст без веток'), '');
});
const {
  isBaseBranch, pickWorkingBranch, pickBaseBranch,
  classifyUserBlock, buildSessionBlocks, wfInfo, scopeInfo,
  isReadOnlyTool, briefArg, woOf,
} = await import(SRV);

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
