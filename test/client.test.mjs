// Клиентские тесты чистых модулей web/js/util.js и web/js/columns.js (без DOM → импортируются в node). D4c.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esc, kTok, fmtTok, pctOf, ctxColor, timeAgo, mdToHtml } from '../web/js/util.js';
import { jiraColumn, effectiveColumn, cardStatus, searchableText, attentionReasons, WF_COLUMNS, WF_LABEL, mrKey } from '../web/js/columns.js';

test('jiraColumn: Jira-статус → колонка/blocked (build решается отдельно, readymerge→qa)', () => {
  assert.deepEqual(jiraColumn('Blocked', ''), { col: null, blocked: true });
  assert.equal(jiraColumn('Ready to Merge', '').col, 'qa', 'ready-to-merge → колонка «На QA» (отдельной колонки нет)');
  assert.deepEqual(jiraColumn('Done', 'done'), { col: 'done', blocked: false });
  assert.equal(jiraColumn('Closed', '').col, 'done');
  assert.equal(jiraColumn('In Review', '').col, 'qa');
  assert.equal(jiraColumn('In QA', '').col, 'qa');
  assert.equal(jiraColumn('In Progress', '').col, 'active', 'In Progress → В работе (build — не здесь, а в effectiveColumn)');
  assert.equal(jiraColumn('To Do', 'new').col, 'todo');
  assert.deepEqual(jiraColumn('Странный статус', ''), { col: null, blocked: false });
});

test('effectiveColumn: build-исключение важнее Jira, дальше — статус Jira', () => {
  assert.deepEqual(effectiveColumn({ wo: 'WO-1' }, { 'WO-1': { available: true, status: 'Blocked' } }), { col: 'blocked', blocked: true });
  assert.deepEqual(effectiveColumn({ buildActive: true, wfColumn: 'active' }, {}), { col: 'build', blocked: false }, 'живой билд → Build In Progress');
  // build-исключение перекрывает Jira-статус (даже Done)
  assert.equal(effectiveColumn({ wo: 'WO-1b', buildActive: true }, { 'WO-1b': { available: true, status: 'Done' } }).col, 'build', 'живой билд важнее любого Jira-статуса');
  assert.equal(effectiveColumn({ wfColumn: 'build', buildActive: false }, {}).col, 'qa', 'stale build-стадия без живого билда → На QA');
  assert.equal(effectiveColumn({ wo: 'WO-2', wfColumn: 'active' }, { 'WO-2': { available: true, status: 'Ready to Merge' } }).col, 'qa', 'ready-to-merge по Jira → На QA');
});

test('effectiveColumn: Jira — source of truth (ведёт даже без dev-workflow-состояния)', () => {
  assert.equal(effectiveColumn({ wo: 'WO-5', active: true, wfColumn: 'active' }, { 'WO-5': { available: true, status: 'In QA' } }).col, 'qa', 'Jira On QA → На QA');
  assert.equal(effectiveColumn({ wo: 'WO-5b' }, { 'WO-5b': { available: true, status: 'Done' } }).col, 'done', 'Jira Done → Готово');
  assert.equal(effectiveColumn({ wo: 'WO-7', wfColumn: 'qa' }, { 'WO-7': { available: true, status: 'In Progress' } }).col, 'active', 'Jira In Progress перекрывает локальную стадию qa');
  // Jira недоступна → фолбэк на стадию dev-workflow / свежесть
  assert.equal(effectiveColumn({ wo: 'WO-8', wfColumn: 'qa' }, {}).col, 'qa', 'нет Jira → стадия dev-workflow');
  assert.equal(effectiveColumn({ active: true }, {}).col, 'active', 'нет Jira, активна → В работе');
  assert.equal(effectiveColumn({ active: false }, {}).col, 'todo', 'нет Jira, не активна → Ждёт');
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

test('attentionReasons: блокер/упавшая сборка/ожидание проверки; done и «чистые» — пусто', () => {
  // блокер (по Jira-статусу) — severity 3, деталь = статус
  const blk = attentionReasons({ wo: 'WO-A' }, { 'WO-A': { available: true, status: 'Blocked' } });
  assert.equal(blk.length, 1); assert.equal(blk[0].kind, 'blocked'); assert.equal(blk[0].sev, 3); assert.equal(blk[0].detail, 'Blocked');
  // упавшая сборка
  const bf = attentionReasons({ buildFailed: true, wfColumn: 'build' }, {});
  assert.deepEqual(bf.map((r) => r.kind), ['build']);
  // ожидание локальной проверки (билд готов, не отдан в QA)
  const lc = attentionReasons({ wfColumn: 'qa', wfQa: 'localcheck' }, {});
  assert.deepEqual(lc.map((r) => r.kind), ['verify']);
  // несколько причин сразу — по убыванию срочности
  const multi = attentionReasons({ wo: 'WO-B', buildFailed: true }, { 'WO-B': { available: true, status: 'Blocked' } });
  assert.deepEqual(multi.map((r) => r.kind), ['blocked', 'build']);
  // завершённая задача — не «требует внимания», даже с мигнувшим сигналом
  assert.deepEqual(attentionReasons({ wo: 'WO-C', buildFailed: true }, { 'WO-C': { available: true, status: 'Done' } }), []);
  // ничего не горит
  assert.deepEqual(attentionReasons({ wfColumn: 'active', active: true }, {}), []);
});

test('WF_COLUMNS/WF_LABEL: словари колонок (без «Ждёт мерджа»)', () => {
  assert.ok(Array.isArray(WF_COLUMNS) && WF_COLUMNS.length === 6);
  assert.deepEqual(WF_COLUMNS.map((c) => c.key), ['todo', 'active', 'blocked', 'build', 'qa', 'done']);
  assert.ok(!WF_COLUMNS.some((c) => c.key === 'readymerge'), 'колонки readymerge нет');
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
