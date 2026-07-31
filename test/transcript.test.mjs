// transcript.js — лента сообщений. blockHTML строит разметку блока каждого вида; renderThread рисует весь тред и
// цепляет wireConsole/live-tail; appendHTML вставляет узел. Ловим сломанные ссылки (mdToHtml/esc/fmtTok/wireConsole/
// startTail/stopTail) реальным вызовом в null-DOM.

import './dom-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { watchBrokenRefs, makeEl } from './dom-stub.mjs';
import { S } from '../web/js/store.js';
import { renderThread, blockHTML, appendHTML } from '../web/js/transcript.js';

test('transcript.js: blockHTML всех видов + renderThread + appendHTML в null-DOM', async () => {
  const w = watchBrokenRefs();
  const blocks = [
    { kind:'user', text:'привет' },
    { kind:'assistant', text:'**жирный** ответ', meta:{ in:1200, out:800, ctxPct:0.3 } },
    { kind:'assistant', text:'x'.repeat(1500) },                 // длинный ответ → ветка «показать полностью»
    { kind:'thinking', text:'размышляю' },
    { kind:'thinking', text:'' },                                // пустое размышление → ''
    { kind:'tool', name:'Read', arg:'file.js', result:'ok' },
    { kind:'tool', name:'Bash' },                                // без результата
    { kind:'system', text:'служебное' },
    { kind:'command', text:'/compact' },
    { kind:'unknown' },                                          // неизвестный вид → ''
  ];
  for (const b of blocks){ assert.equal(typeof blockHTML(b), 'string'); }
  assert.equal(blockHTML({ kind:'thinking', text:'' }), '');
  assert.equal(blockHTML({ kind:'unknown' }), '');

  renderThread({ file:'f1', active:false, blocks });             // active:false → без live-tail
  assert.equal(S.tailCount, blocks.length);                     // курсор = число показанных блоков

  const el = appendHTML(makeEl(), blockHTML(blocks[0]));         // null-DOM: firstElementChild=null → el=null, не падаем
  assert.ok(el === null || typeof el === 'object');

  await new Promise((r) => setTimeout(r, 20));
  w.stop();
  assert.deepEqual(w.errors, [], 'сломанная ссылка в transcript.js: ' + w.errors.join(' | '));
});
