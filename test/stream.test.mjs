// stream.js — движок живого ответа. runPrompt поднимает стрим (EventSource застабан, событий нет → setup-путь);
// setStreamStatus/updateTailIndicator/updateRailContext рисуют индикаторы; approvalCardHTML строит карточку аппрува;
// userStop обрывает. Ловим сломанные ссылки (transcript/composer/services/notify/rail/unity/dialogs/session) вызовом
// в null-DOM.

import './dom-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setFetch, watchBrokenRefs } from './dom-stub.mjs';
import { S } from '../web/js/store.js';
import { runPrompt, setStreamStatus, updateTailIndicator, updateRailContext, userStop, approvalCardHTML } from '../web/js/stream.js';

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
