// workspace.js — воркспейс со сплит-лейаутом (iframe на паню). Ловим сломанные ссылки реальными вызовами в null-DOM:
// пустое состояние, добавление сессии (создание корневого листа), полная перестройка дерева.

import './dom-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { watchBrokenRefs } from './dom-stub.mjs';
import { S } from '../web/js/store.js';
import { renderWorkspace, addWorkspaceSession } from '../web/js/workspace.js';

test('workspace.js: пустой воркспейс + добавление сессии + перестройка дерева в null-DOM', async () => {
  const w = watchBrokenRefs();
  localStorage.clear();
  S.SESSIONS = [{ file:'a.jsonl', title:'A', project:'p' }, { file:'b.jsonl', title:'B', project:'p' }];

  renderWorkspace();                                        // пустое состояние (WS ещё пуст)
  addWorkspaceSession({ kind:'file', file:'a.jsonl', title:'A' });    // первая сессия → корневой лист с одной вкладкой
  addWorkspaceSession({ kind:'file', file:'b.jsonl', title:'B' });    // вторая → доклеивается в последнюю группу
  renderWorkspace(true);                                    // полная перестройка

  const ws = JSON.parse(localStorage.getItem('deckWorkspace') || 'null');
  assert.ok(ws && ws.root, 'лейаут сохранён в localStorage');
  assert.equal(ws.root.t, 'leaf', 'обе сессии в одной группе (докинга не было)');
  assert.equal(ws.root.tabs.length, 2, 'две вкладки в группе');
  assert.ok(ws.lastLeaf, 'запомнена последняя сфокусированная группа (в неё падает следующая сессия)');

  await new Promise((r) => setTimeout(r, 20));
  w.stop();
  assert.deepEqual(w.errors, [], 'сломанная ссылка в workspace.js: ' + w.errors.join(' | '));
  localStorage.clear();
});
