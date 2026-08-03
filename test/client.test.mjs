// Клиентские тесты чистых модулей web/js/util.js и web/js/columns.js (без DOM → импортируются в node). D4c.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esc, kTok, fmtTok, pctOf, ctxColor, timeAgo, mdToHtml } from '../web/js/util.js';
import { jiraColumn, effectiveColumn, cardStatus, searchableText, WF_COLUMNS, WF_LABEL, mrKey } from '../web/js/columns.js';

test('jiraColumn: Jira-статус → колонка/blocked', () => {
  assert.deepEqual(jiraColumn('Blocked', ''), { col: null, blocked: true });
  assert.deepEqual(jiraColumn('Ready to Merge', ''), { col: 'readymerge', blocked: false });
  assert.deepEqual(jiraColumn('Done', 'done'), { col: 'done', blocked: false });
  assert.equal(jiraColumn('Closed', '').col, 'done');
  assert.equal(jiraColumn('In Review', '').col, 'qa');
  assert.equal(jiraColumn('In QA', '').col, 'qa');
  assert.deepEqual(jiraColumn('In Progress', '', { buildActive: false }), { col: 'active', blocked: false });
  assert.deepEqual(jiraColumn('In Progress', '', { buildActive: true }), { col: 'build', blocked: false });
  assert.equal(jiraColumn('To Do', 'new').col, 'todo');
  assert.deepEqual(jiraColumn('Странный статус', ''), { col: null, blocked: false });
});

test('effectiveColumn: приоритет blocked→build→qa→(jira)→done/active/todo', () => {
  assert.deepEqual(effectiveColumn({ wo: 'WO-1' }, { 'WO-1': { available: true, status: 'Blocked' } }), { col: 'blocked', blocked: true });
  assert.deepEqual(effectiveColumn({ buildActive: true, wfColumn: 'active' }, {}), { col: 'build', blocked: false });
  assert.equal(effectiveColumn({ wfColumn: 'build', buildActive: false }, {}).col, 'qa', 'stale build без живого билда → На QA');
  assert.equal(effectiveColumn({ wfColumn: 'done' }, {}).col, 'done');
  assert.equal(effectiveColumn({ wo: 'WO-2', wfColumn: 'active', wfHasState: true }, { 'WO-2': { available: true, status: 'Ready to Merge' } }).col, 'readymerge', 'jira уточняет стадию при наличии dev-workflow-состояния');
  assert.equal(effectiveColumn({ active: true }, {}).col, 'active');
  assert.equal(effectiveColumn({ active: false }, {}).col, 'todo');
});

test('effectiveColumn: QA требует согласия dev-workflow и Jira; research-сессия не улетает по Jira', () => {
  // research: нет dev-workflow-состояния, задача в Jira-QA → сессия остаётся в своей стадии, НЕ в QA
  assert.equal(effectiveColumn({ wo: 'WO-5', active: true }, { 'WO-5': { available: true, status: 'In QA' } }).col, 'active', 'Jira-QA без dev-workflow не тащит в QA');
  assert.equal(effectiveColumn({ wo: 'WO-5b' }, { 'WO-5b': { available: true, status: 'Done' } }).col, 'todo', 'Jira-Done без dev-workflow не тащит в Готово');
  // оба в QA → На QA
  assert.equal(effectiveColumn({ wo: 'WO-6', wfColumn: 'qa', wfHasState: true }, { 'WO-6': { available: true, status: 'In QA' } }).col, 'qa', 'dev-workflow + Jira в QA → QA');
  // dev-workflow в QA, Jira ещё в работе → не оба → не QA
  assert.equal(effectiveColumn({ wo: 'WO-7', wfColumn: 'qa', wfHasState: true }, { 'WO-7': { available: true, status: 'In Progress' } }).col, 'active', 'Jira отстаёт от dev-workflow → не QA');
  // dev-workflow в QA без данных Jira → QA (полагаемся на спеккит, это не «только Jira»)
  assert.equal(effectiveColumn({ wo: 'WO-8', wfColumn: 'qa', wfHasState: true }, {}).col, 'qa', 'dev-workflow QA без Jira-данных → QA');
});

test('cardStatus: под-статус без дубля колонки', () => {
  assert.deepEqual(cardStatus({ wo: 'WO-3', wfColumn: 'qa' }, { 'WO-3': { available: true, status: 'In Review' } }), { col: 'qa', blocked: false, sub: 'Ревью' });
  assert.deepEqual(cardStatus({ wo: 'WO-4', wfColumn: 'qa', wfQa: 'localcheck' }, {}), { col: 'qa', blocked: false, sub: 'Ожидает проверки' });
  assert.deepEqual(cardStatus({ wfColumn: 'active' }, {}), { col: 'active', blocked: false, sub: '' });
});

test('searchableText: находит wo/cu/backend/ветку/теги/статус', () => {
  const s = { wo: 'WO-777', title: 'Заголовок', clientCu: 'cu2', backend: true, changedServices: ['chat-service'], baseBranch: 'preupdate', tags: ['urgent'], wfColumn: 'qa' };
  const t = searchableText(s, {}, {}, true);
  for (const needle of ['wo-777', 'cu2', 'backend', 'chat-service', 'preupdate', 'urgent', 'работает', 'на qa']) assert.ok(t.includes(needle), 'ищется: ' + needle);
  const t2 = searchableText(s, {}, {}, false);
  assert.ok(!t2.includes('работает'), 'working=false → без «работает»');
});

test('WF_COLUMNS/WF_LABEL: словари колонок', () => {
  assert.ok(Array.isArray(WF_COLUMNS) && WF_COLUMNS.length === 7);
  assert.deepEqual(WF_COLUMNS.map((c) => c.key), ['todo', 'active', 'blocked', 'build', 'qa', 'readymerge', 'done']);
  assert.equal(WF_LABEL.qa, 'На QA');
  assert.equal(WF_LABEL.done, 'Готово');
});

test('mdToHtml: базовый markdown → html (escape-first)', () => {
  assert.equal(mdToHtml('**жирный**'), '<p><strong>жирный</strong></p>');
  assert.equal(mdToHtml('# Заголовок'), '<h1>Заголовок</h1>');
  assert.ok(mdToHtml('`код`').includes('<code class="cx-ic">код</code>'));
  assert.equal(mdToHtml('- a\n- b'), '<ul><li>a</li><li>b</li></ul>');
  assert.ok(mdToHtml('[t](https://a.b)').includes('<a href="https://a.b" target="_blank" rel="noopener">t</a>'));
  assert.ok(mdToHtml('<script>alert(1)</script>').includes('&lt;script&gt;'), 'html экранируется');
});

test('mdToHtml: GFM-таблицы + защита от ложных', () => {
  const t = mdToHtml('| A | B |\n|---|---|\n| 1 | **x** |');
  assert.ok(t.includes('<table class="cx-table">'), 'таблица рендерится');
  assert.ok(/<th[^>]*>A<\/th>/.test(t) && /<th[^>]*>B<\/th>/.test(t), 'шапка из header-строки');
  assert.ok(t.includes('<td>1</td>') && t.includes('<strong>x</strong>'), 'ячейки + инлайн-формат внутри');
  assert.equal((t.match(/<table/g) || []).length, 1, 'ровно одна таблица');
  assert.ok(!mdToHtml('a | b\nтекст').includes('<table'), 'нет строки-разделителя ниже → не таблица');
  assert.ok(!mdToHtml('a | b\n---').includes('<table'), 'разделитель другого числа колонок → не таблица (абзац с | над hr)');
  assert.ok(mdToHtml('| h |\n|:-:|\n| c |').includes('text-align:center'), 'выравнивание из :--:');
});

test('mrKey: ключ MR-кэша = ветка|wo (не по одной ветке)', () => {
  assert.equal(mrKey({ gitBranch: 'preprod', wo: 'WO-1' }), 'preprod|WO-1');
  assert.notEqual(mrKey({ gitBranch: 'preprod', wo: 'WO-1' }), mrKey({ gitBranch: 'preprod', wo: 'WO-2' }), 'разные wo на общей ветке → разные ключи');
  assert.equal(mrKey({}), '|');
});

test('format-хелперы', () => {
  assert.equal(kTok(1500), '2k');
  assert.equal(kTok(500), '500');
  assert.equal(kTok(0), '0');
  assert.equal(fmtTok(1500), '1.5k');
  assert.equal(fmtTok(999), '999');
  assert.equal(pctOf({ ctxPct: 0.5 }), 50);
  assert.equal(pctOf({}), 0);
  assert.equal(ctxColor(0.9), 'var(--bad)');
  assert.equal(ctxColor(0.6), 'var(--warn)');
  assert.equal(ctxColor(0.2), 'var(--good)');
  assert.equal(esc('<a>&'), '&lt;a&gt;&amp;');
  assert.equal(timeAgo(0), '—');
  assert.equal(timeAgo(Date.now()), 'только что');
});
