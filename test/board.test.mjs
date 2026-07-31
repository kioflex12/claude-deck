// board.js вынесен из app.js. Boot-smoke не гоняет доску на синтетических данных, поэтому забытый импорт
// внутри cardHTML/renderBoard/renderNow/renderFilters (esc/ctxColor/pctOf/timeAgo/columns/openSession/launchUnity)
// там не стрельнул бы. Этот тест кладёт сессии в S.SESSIONS и рисует доску/фильтры/карточку в null-DOM.

import './dom-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setFetch, watchBrokenRefs } from './dom-stub.mjs';
import { S } from '../web/js/store.js';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

test('board.js: рендер доски/фильтров/карточки в null-DOM', async () => {
  setFetch(async () => ({ ok:true, status:200,
    json: async () => ({ sessions:[] }), text: async () => '', headers:{ get(){ return null; } } }));
  const w = watchBrokenRefs();
  const url = pathToFileURL(path.resolve(import.meta.dirname, '../web/js/board.js')).href;
  let board;
  try { board = await import(url); }
  catch (e){ w.stop(); assert.fail('import board.js упал: ' + (e && e.stack || e)); }

  S.SESSIONS = [
    { file:'a.jsonl', title:'Рефакторинг чата', project:'client-unity-1', wo:'WO-1', clientCu:'cu1',
      gitBranch:'feature/WO-1', model:'opus', msgs:12, ctxPct:0.42, working:true, active:true,
      mtime:Date.now(), wfColumn:'active', wfHasState:true, tags:['chat','ui'] },
    { file:'b.jsonl', title:'Багфикс арены', project:'WoBackendServices', wo:'WO-2', backend:true,
      gitBranch:'feature/WO-2', model:'sonnet', msgs:3, ctxPct:0.9, working:false, active:false,
      mtime:Date.now()-9e6, wfColumn:'qa', wfHasState:true, baseBranch:'preprod', merged:true, tags:[] },
    { file:'c.jsonl', title:'Статика наград', project:'statics', statics:true,
      gitBranch:'preprod', model:'opus', msgs:1, ctxPct:0.1, working:false, active:true,
      mtime:Date.now()-2e5, wfColumn:'todo', tags:['stat'] },
  ];
  S.currentFile = 'a.jsonl'; S.projFilter = 'all'; S.query = '';

  S.activeView = 'status';
  assert.doesNotThrow(() => board.renderBoard(false), 'renderBoard — вид «Статусы»');
  S.activeView = 'board';
  assert.doesNotThrow(() => board.renderBoard(true), 'renderBoard — вид «Доска»');
  assert.doesNotThrow(() => board.renderNow(), 'renderNow — текущий контекст');
  assert.doesNotThrow(() => board.renderFilters(), 'renderFilters — чипы проектов');
  assert.equal(typeof board.cardHTML(S.SESSIONS[0]), 'string', 'cardHTML вернул строку');
  assert.equal(board.isWorking(S.SESSIONS[0]), true, 'isWorking по working=true');
  assert.equal(board.boardMatch(S.SESSIONS[1]), true, 'boardMatch без фильтра');

  // контекстное меню карточки (правый клик) — строится в null-DOM без броска (синтетический contextmenu-евент)
  const evt = { preventDefault(){}, clientX:10, clientY:10 };
  assert.doesNotThrow(() => board.openCardMenu(evt, 'a.jsonl'), 'openCardMenu — синтетический contextmenu');
  assert.equal(typeof board.refreshCard, 'function', 'refreshCard экспортирован');

  await new Promise((r) => setTimeout(r, 40));
  w.stop();
  assert.deepEqual(w.errors, [], 'сломанная ссылка в board.js: ' + w.errors.join(' | '));
});
