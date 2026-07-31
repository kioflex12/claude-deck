// usage.js вынесен из app.js. Boot-smoke не открывает окно usage и не считает фолбэк по контексту, поэтому
// забытый импорт внутри openUsageModal (modalBack/esc/kTok) или contextSession (isWorking из app.js) там не
// стрельнул бы. Тест прогоняет обе ветки бара/модалки (фолбэк по S.SESSIONS и живые лимиты) в null-DOM.

import './dom-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setFetch, watchBrokenRefs } from './dom-stub.mjs';
import { S } from '../web/js/store.js';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

test('usage.js: фолбэк по контексту + живые лимиты (бар и модалка) в null-DOM', async () => {
  const w = watchBrokenRefs();
  const url = pathToFileURL(path.resolve(import.meta.dirname, '../web/js/usage.js')).href;
  let usage;
  try { usage = await import(url); }
  catch (e){ w.stop(); assert.fail('import usage.js упал: ' + (e && e.stack || e)); }

  // Фолбэк-ветка: лимиты недоступны → бар/модалка считают из контекста сессий (contextSession → isWorking из app.js).
  S.currentFile = null; S.USAGE = null;
  S.SESSIONS = [ { file:'a.jsonl', title:'A', project:'P', winTokens:120000, ctxPct:0.3, active:true } ];
  assert.doesNotThrow(() => usage.renderUsageBar(), 'renderUsageBar — фолбэк по контексту');
  assert.doesNotThrow(() => usage.openUsageModal(), 'openUsageModal — фолбэк-ветка (S.SESSIONS)');

  // Ветка лимитов: /api/usage отдал доступные окна.
  setFetch(async () => ({ ok:true, status:200,
    json: async () => ({ available:true, subscriptionType:'max',
      fiveHour:{ utilization:15, resetsAt:new Date(Date.now()+3600000).toISOString() },
      sevenDay:{ utilization:40, resetsAt:new Date(Date.now()+7*86400000).toISOString() } }),
    text: async () => '', headers:{ get(){ return null; } } }));
  await usage.loadUsage();                                           // fetch → S.USAGE + renderUsageBar
  assert.equal(S.USAGE.available, true, 'usage загрузился');
  assert.doesNotThrow(() => usage.renderUsageBar(), 'renderUsageBar — ветка лимитов');
  assert.doesNotThrow(() => usage.openUsageModal(), 'openUsageModal — ветка лимитов');

  await new Promise((r) => setTimeout(r, 40));
  w.stop();
  assert.deepEqual(w.errors, [], 'сломанная ссылка в usage.js: ' + w.errors.join(' | '));
});
