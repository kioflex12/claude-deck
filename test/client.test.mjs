// Клиентские тесты чистых модулей web/js/util.js и web/js/columns.js (без DOM → импортируются в node). D4c.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esc, kTok, fmtTok, pctOf, ctxColor, timeAgo, mdToHtml } from '../web/js/util.js';
import { jiraColumn, effectiveColumn, cardStatus, searchableText, WF_COLUMNS, WF_LABEL } from '../web/js/columns.js';

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
  assert.equal(effectiveColumn({ wo: 'WO-2', wfColumn: 'active' }, { 'WO-2': { available: true, status: 'Ready to Merge' } }).col, 'readymerge', 'jira перебивает локальный wfColumn');
  assert.equal(effectiveColumn({ active: true }, {}).col, 'active');
  assert.equal(effectiveColumn({ active: false }, {}).col, 'todo');
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
