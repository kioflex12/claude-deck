// transcript.js — лента сообщений. blockHTML строит разметку блока каждого вида; renderThread рисует весь тред и
// цепляет wireConsole/live-tail; appendHTML вставляет узел. Ловим сломанные ссылки (mdToHtml/esc/fmtTok/wireConsole/
// startTail/stopTail) реальным вызовом в null-DOM.

import './dom-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { watchBrokenRefs, makeEl } from './dom-stub.mjs';
import { S } from '../web/js/store.js';
import { renderThread, blockHTML, appendHTML } from '../web/js/transcript.js';
import { addShown, loadShown } from '../web/js/composer.js';

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

  // Референс-стиль: у ассистента больше НЕТ шапки-карточки «Claude»; инструмент рисует IN(команда)/OUT(результат).
  assert.ok(!/cx-role[^>]*>Claude/.test(blockHTML({ kind:'assistant', text:'ответ' })), 'ассистент без шапки «Claude»');
  const toolHtml = blockHTML({ kind:'tool', name:'Bash', desc:'сделать X', cmd:'git status', result:'clean' });
  assert.ok(toolHtml.includes('cx-tool-h') && toolHtml.includes('сделать X'), 'заголовок инструмента + описание');
  assert.ok(toolHtml.includes('>IN<') && toolHtml.includes('git status'), 'IN = команда');
  assert.ok(toolHtml.includes('>OUT<') && toolHtml.includes('clean'), 'OUT = результат');
  assert.ok(!blockHTML({ kind:'tool', name:'Read' }).includes('cx-io'), 'без cmd/result — без IN/OUT-боксов');
  assert.ok(blockHTML({ kind:'image', media:'image/png', data:'AAAA' }).includes('src="data:image/png;base64,AAAA"'), 'image-блок → <img> с data-url');

  renderThread({ file:'f1', active:false, blocks });             // active:false → без live-tail
  assert.equal(S.tailCount, blocks.length);                     // курсор = число показанных блоков

  const el = appendHTML(makeEl(), blockHTML(blocks[0]));         // null-DOM: firstElementChild=null → el=null, не падаем
  assert.ok(el === null || typeof el === 'object');

  await new Promise((r) => setTimeout(r, 20));
  w.stop();
  assert.deepEqual(w.errors, [], 'сломанная ссылка в transcript.js: ' + w.errors.join(' | '));
});

test('addShown: лог подкинутых промтов — дедуп по pid; хранит текст/скрины', () => {
  localStorage.clear();
  addShown('fx', 'подкинутый', [{ kind:'image', name:'s.png', preview:'data:,' }], 'p1');
  addShown('fx', 'подкинутый', [], 'p1');                 // тот же pid → не дублируем
  addShown('fx', 'второй', [], 'p2');
  const log = loadShown('fx');
  assert.equal(log.length, 2, 'дедуп по pid: p1 один раз, p2 добавлен');
  assert.equal(log[0].pid, 'p1'); assert.equal(log[0].atts.length, 1, 'скрин сохранён в логе показа');
  assert.equal(loadShown('other').length, 0, 'лог по ключу файла');
  localStorage.clear();
});

test('renderThread со shown-логом: доставленный вычищается, осиротевший остаётся (null-DOM)', async () => {
  const w = watchBrokenRefs();
  localStorage.clear();
  addShown('finj', 'мой подкинутый промт', [], 'pid-x');   // steered, в .jsonl не попал → осиротевший, показываем и держим
  addShown('finj', 'этот уже в транскрипте  ', [], 'pid-y');   // хвостовые пробелы: точное равенство бы промазало
  assert.doesNotThrow(() => renderThread({ file:'finj', active:false, blocks:[ { kind:'user', text:'этот уже в транскрипте' }, { kind:'assistant', text:'ответ' } ] }));
  const log = loadShown('finj');
  assert.equal(log.length, 1, 'доставленный (есть в транскрипте) вычищен из стора — не залипает внизу на каждом заходе');
  assert.equal(log[0].pid, 'pid-x', 'остался только реально осиротевший steered-промт');
  localStorage.clear();
  await new Promise((r) => setTimeout(r, 20));
  w.stop();
  assert.deepEqual(w.errors, [], 'сломанная ссылка: ' + w.errors.join(' | '));
});
