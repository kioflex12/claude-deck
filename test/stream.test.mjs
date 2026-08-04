// stream.js — движок живого ответа. runPrompt поднимает стрим (EventSource застабан, событий нет → setup-путь);
// setStreamStatus/updateTailIndicator/updateRailContext рисуют индикаторы; approvalCardHTML строит карточку аппрува;
// userStop обрывает. Ловим сломанные ссылки (transcript/composer/services/notify/rail/unity/dialogs/session) вызовом
// в null-DOM.

import './dom-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setFetch, watchBrokenRefs } from './dom-stub.mjs';
import { S } from '../web/js/store.js';
import { runPrompt, setStreamStatus, updateTailIndicator, updateRailContext, userStop, approvalCardHTML, questionCardHTML, wireQuestion } from '../web/js/stream.js';

// Мини-DOM для wireQuestion: узлы с classList/dataset/closest/querySelectorAll по классам (null-DOM stub этого не умеет).
function makeNode(classes, dataset){
  const cls = new Set(String(classes || '').split(/\s+/).filter(Boolean));
  const node = {
    dataset: dataset || {}, disabled: false, hidden: false, textContent: '', _cls: cls, _parent: null, _kids: [], _lst: {},
    classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), toggle: (c) => (cls.has(c) ? cls.delete(c) : cls.add(c)), contains: (c) => cls.has(c) },
    addEventListener(ev, fn){ (node._lst[ev] = node._lst[ev] || []).push(fn); },
    click(){ (node._lst.click || []).forEach((f) => f()); },
    remove(){ if (node._parent) node._parent._kids = node._parent._kids.filter((k) => k !== node); },
  };
  const desc = (n) => n._kids.flatMap((k) => [k, ...desc(k)]);
  const match = (n, sel) => sel.split(',').some((p) => p.trim().split('.').filter(Boolean).every((c) => n._cls.has(c)));
  node.querySelectorAll = (sel) => desc(node).filter((n) => match(n, sel));
  node.querySelector = (sel) => node.querySelectorAll(sel)[0] || null;
  node.closest = (sel) => { let p = node; while (p){ if (match(p, sel)) return p; p = p._parent; } return null; };
  node.add = (child) => { child._parent = node; node._kids.push(child); return child; };
  return node;
}

test('stream.js: runPrompt(setup) + индикаторы + approvalCardHTML + userStop', async () => {
  setFetch(async () => ({ ok:true, status:200,
    json: async () => ({ ok:true, token:'t', blocks:[], count:0, active:false }),
    text: async () => '', headers:{ get(){ return null; } } }));
  const w = watchBrokenRefs();

  S.currentFile = 'f1';                        // без файла runPrompt/sendMessage не стартуют
  await Promise.race([
    runPrompt({ text:'hi', mode:'default' }),  // GET-путь: EventSource застабан, событий нет → резолвится сразу
    new Promise((r) => setTimeout(r, 150)),
  ]);

  setStreamStatus('идёт');
  setStreamStatus('');
  updateTailIndicator(true, 0);
  updateTailIndicator(false, 0);
  updateRailContext(0.5, 100);

  const card = approvalCardHTML({ id:'a1', tool:'Bash', input:{ command:'ls -la', description:'список' } });
  assert.equal(typeof card, 'string');
  assert.ok(card.includes('Bash'));
  assert.ok(approvalCardHTML({ id:'a2', tool:'Edit', input:{ file_path:'x.js', old_string:'a', new_string:'b' } }).includes('x.js'));

  // finish() зовёт runEl.remove(), а appendHTML в null-DOM отдал null — обрываем hard-reset веткой (без finish).
  S.liveFinish = null;
  userStop();

  await new Promise((r) => setTimeout(r, 40));
  w.stop();
  assert.deepEqual(w.errors, [], 'сломанная ссылка в stream.js: ' + w.errors.join(' | '));
});

test('stream.js: questionCardHTML рендерит варианты; wireQuestion(single) отвечает и POSTит /api/answer', async () => {
  const d = { id: 'aq_x', questions: [{ question: 'Куда идём?', header: 'Выбор', options: [{ label: 'Влево', description: 'на запад' }, { label: 'Вправо' }], multiSelect: false }] };
  const html = questionCardHTML(d);
  assert.equal(typeof html, 'string');
  assert.ok(html.includes('Куда идём?'), 'текст вопроса');
  assert.ok(html.includes('Влево') && html.includes('Вправо'), 'оба варианта');
  assert.ok(html.includes('на запад'), 'описание варианта');
  assert.ok(html.includes('data-single="1"'), 'один single-select → auto-submit флаг');

  // multiSelect карточка тоже строится без падения
  assert.ok(questionCardHTML({ id: 'aq_m', questions: [{ question: 'Что?', options: [{ label: 'A' }], multiSelect: true }] }).includes('data-single="0"'));

  // wireQuestion на null-DOM-элементе (makeEl) — не падает
  wireQuestion(null, d);

  // функциональный мини-DOM: клик по варианту single-select → auto-submit → POST /api/answer с answers
  S.currentFile = null;   // изолируем от live-tail: без открытой сессии resumeTailAfterInput (после ответа) — no-op, иначе стартанул бы tail и его fetch'и перебили бы posted
  let posted = null;
  setFetch(async (url, opt) => { if (url === '/api/answer') posted = { url, body: opt && opt.body ? JSON.parse(opt.body) : null }; return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '', headers: { get(){ return null; } } }; });
  const card = makeNode('cx-msg cx-question', { single: '1' });
  const block = card.add(makeNode('q-block', { multi: '0', question: 'Куда идём?' }));
  const opt1 = block.add(makeNode('q-opt', { label: 'Влево' }));
  block.add(makeNode('q-opt', { label: 'Вправо' }));
  const foot = card.add(makeNode('q-foot'));
  foot.add(makeNode('q-submit'));
  card.add(makeNode('q-result'));
  wireQuestion(card, d);
  opt1.click();
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(posted, 'fetch вызван');
  assert.equal(posted.url, '/api/answer', 'POST на /api/answer');
  assert.equal(posted.body.id, 'aq_x', 'прислан id вопроса');
  assert.deepEqual(posted.body.answers, { 'Куда идём?': 'Влево' }, 'answers = { текст: выбранный лейбл }');
  assert.ok(card.classList.contains('q-resolved'), 'карточка помечена отвеченной');
});

test('stream.js: fake EventSource — done чистит стрим (teardownLive); steered → фоновый tail + serverBusy (A2/R3/T1)', async () => {
  const w = watchBrokenRefs();
  let lastES = null;
  const prevES = globalThis.EventSource;
  globalThis.EventSource = class { constructor(url){ this.url = url; this.onmessage = null; this.onerror = null; this.readyState = 1; lastES = this; } close(){ this.readyState = 2; } };
  setFetch(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, count: 0, serverActive: false, blocks: [], questions: [], approvals: [] }), text: async () => '', headers: { get(){ return null; } } }));

  // 1) done → стрим чисто завершён (teardownLive): currentES/currentStreamId сброшены, streaming=false
  S.currentFile = 'f1'; S.serverBusy = false;
  runPrompt({ text: 'hi', mode: 'default' });   // sync-setup (GET-путь): создаёт EventSource и вешает onmessage
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(lastES, 'EventSource создан');
  assert.equal(S.streaming, true, 'старт → setComposerBusy(true)');
  lastES.onmessage({ data: JSON.stringify({ type: 'start', streamId: 'sx1' }) });
  assert.equal(S.currentStreamId, 'sx1', 'start → currentStreamId');
  lastES.onmessage({ data: JSON.stringify({ type: 'done', subtype: 'success', isError: false }) });
  assert.equal(S.currentES, null, 'done → teardownLive очистил currentES');
  assert.equal(S.currentStreamId, null, 'done → currentStreamId сброшен');
  assert.equal(S.streaming, false, 'done → setComposerBusy(false)');

  // 2) steered → НЕ «завершено»: currentStreamId сброшен (Стоп по файлу), serverBusy=true (composer будет steer-ить)
  const es1 = lastES;
  S.currentFile = 'f2'; S.serverBusy = false;
  runPrompt({ text: 'ещё', mode: 'default' });
  await new Promise((r) => setTimeout(r, 10));
  assert.notEqual(lastES, es1, 'второй ход → новый EventSource');
  lastES.onmessage({ data: JSON.stringify({ type: 'steered' }) });
  assert.equal(S.currentES, null, 'steered → ES закрыт');
  assert.equal(S.currentStreamId, null, 'steered → currentStreamId сброшен');
  assert.equal(S.serverBusy, true, 'steered → serverBusy=true держится после startTail (гейт R3)');

  globalThis.EventSource = prevES;
  if (S.tailTimer){ clearInterval(S.tailTimer); S.tailTimer = null; }
  if (S.streamTimer){ clearInterval(S.streamTimer); S.streamTimer = null; }
  S.currentFile = null; S.serverBusy = false;
  await new Promise((r) => setTimeout(r, 20));
  w.stop();
  assert.deepEqual(w.errors, [], 'нет сломанных ссылок: ' + w.errors.join(' | '));
});
