// notify.js вынесен из app.js («работает сейчас» + уведомления + поллинг доски). Boot-smoke initNotifyToggle зовёт,
// но забытый импорт внутри pollSessions (seedJira/renderNow/renderBoard/hydrate*/renderUsageBar) стрельнул бы лишь
// на тяжёлом тике. Тест прогоняет тумблер/кнопку/workingSet и один тяжёлый pollSessions в null-DOM.

import './dom-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setFetch, watchBrokenRefs } from './dom-stub.mjs';
import { S } from '../web/js/store.js';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

test('notify.js: тумблер/кнопка/workingSet/pollSessions в null-DOM', async () => {
  setFetch(async () => ({ ok:true, status:200,
    json: async () => ({ available:true, mrs:[], builds:[],
      sessions:[
        { file:'a', title:'A', project:'p', wo:'WO-1', gitBranch:'x', working:true, active:true, mtime:Date.now(), wfColumn:'active', jira:{ available:true, status:'In Progress', category:'indeterminate' } },
        { file:'b', title:'B', project:'p', wo:'WO-2', gitBranch:'y', working:false, active:false, mtime:Date.now(), wfColumn:'qa' },
      ] }),
    text: async () => '', headers:{ get(){ return null; } } }));
  const w = watchBrokenRefs();
  const url = pathToFileURL(path.resolve(import.meta.dirname, '../web/js/notify.js')).href;
  let notify;
  try { notify = await import(url); }
  catch (e){ w.stop(); assert.fail('import notify.js упал: ' + (e && e.stack || e)); }

  S.SESSIONS = [{ file:'a', title:'A', working:true }, { file:'b', title:'B', working:false }];
  assert.doesNotThrow(() => notify.initNotifyToggle(), 'initNotifyToggle');
  assert.doesNotThrow(() => notify.paintNotifyBtn(), 'paintNotifyBtn');
  assert.equal(notify.workingSet() instanceof Set, true, 'workingSet вернул Set');
  assert.equal(typeof notify.titleOf('a'), 'string', 'titleOf вернул строку');

  S.activeView = 'status'; S._lastHeavy = 0; S.polling = false;
  await notify.pollSessions();   // тяжёлый тик: /api/sessions → seedJira/workingSet/notify + renderNow/renderBoard/hydrate*
  assert.equal(S.polling, false, 'S.polling сброшен после тяжёлого тика (иначе цикл застревает → фоновые завершения не пингуются)');

  // исключение в рендере не должно застрять флагом polling=true (иначе все следующие опросы early-return → нет уведомлений)
  S._lastHeavy = 0;
  const badView = S.activeView; S.activeView = 'attention';   // renderAttention в null-DOM может кинуть — проверяем finally
  try { await notify.pollSessions(); } catch {}
  assert.equal(S.polling, false, 'S.polling сброшен даже если рендер бросил (try/finally)');
  S.activeView = badView;

  await new Promise((r) => setTimeout(r, 60));
  w.stop();
  assert.deepEqual(w.errors, [], 'сломанная ссылка в notify.js: ' + w.errors.join(' | '));
});
