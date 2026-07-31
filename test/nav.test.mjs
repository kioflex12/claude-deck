// nav.js вынесен из app.js (переключение видов + командная палитра + поиск-дропдаун). Boot-smoke виды не гоняет
// на синтетике, поэтому забытый импорт внутри setView/renderPal/renderSearchDrop (renderBoard/renderMcp/renderSkills/
// openSession/searchableText/…) там бы не стрельнул. Тест дёргает эти рендер-пути в null-DOM и ловит битую ссылку.

import './dom-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setFetch, watchBrokenRefs, makeEl } from './dom-stub.mjs';
import { S } from '../web/js/store.js';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

test('nav.js: виды/палитра/поиск-дропдаун в null-DOM', async () => {
  setFetch(async () => ({ ok:true, status:200,
    json: async () => ({ sessions:[], skills:[], servers:[], instances:[] }),
    text: async () => '', headers:{ get(){ return null; } } }));
  const w = watchBrokenRefs();
  const url = pathToFileURL(path.resolve(import.meta.dirname, '../web/js/nav.js')).href;
  let nav;
  try { nav = await import(url); }
  catch (e){ w.stop(); assert.fail('import nav.js упал: ' + (e && e.stack || e)); }

  S.SESSIONS = [{ file:'a', title:'Рефакторинг', project:'p', cwd:'/t', wo:'WO-1', gitBranch:'x',
    model:'opus', msgs:3, ctxPct:0.2, mtime:Date.now(), wfColumn:'active' }];
  S.SKILLS = [{ cmd:'foo', does:'делает foo', trig:'x' }];
  S.MCP_SERVERS = [{ name:'mcp-tools', scope:'user', transport:'stdio' }];

  for (const v of ['board','skills','mcp','session','status'])
    assert.doesNotThrow(() => nav.setView(v), 'setView ' + v);

  S.query = 'wo';
  assert.doesNotThrow(() => nav.applySearchQuery(), 'applySearchQuery');
  assert.doesNotThrow(() => nav.openPal(), 'openPal');
  assert.doesNotThrow(() => nav.renderPal(''), 'renderPal пусто');
  assert.doesNotThrow(() => nav.renderPal('WO'), 'renderPal с фильтром');

  // renderSearchDrop early-return'ит при пустом #q. Persistent-элементы q/qDrop с непустым value → пройдём
  // по построению items (searchableText/cardStatus/esc/openSession-wiring).
  const qEl = makeEl(); qEl.value = 'WO'; const dropEl = makeEl();
  document.getElementById = (id) => id === 'q' ? qEl : id === 'qDrop' ? dropEl : makeEl();
  assert.doesNotThrow(() => nav.renderSearchDrop(), 'renderSearchDrop — построение items');

  await new Promise((r) => setTimeout(r, 40));
  w.stop();
  assert.deepEqual(w.errors, [], 'сломанная ссылка в nav.js: ' + w.errors.join(' | '));
});
