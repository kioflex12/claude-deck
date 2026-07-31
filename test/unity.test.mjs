// unity.js вынесен из app.js. Boot-smoke не запускает авто-дискавери Unity и не жмёт cu-тег, поэтому забытый
// импорт внутри loadUnityInstances (renderMcp из mcp.js) или launchUnity (toast) там не стрельнул бы. Этот тест
// грузит инстансы (→ renderMcp) и дёргает launchUnity без Electron-моста в null-DOM — ловит такую «сломанную ссылку».

import './dom-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setFetch, watchBrokenRefs } from './dom-stub.mjs';
import { S } from '../web/js/store.js';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

test('unity.js: авто-обнаружение инстансов (→ renderMcp) + запуск в null-DOM', async () => {
  setFetch(async () => ({ ok:true, status:200,
    json: async () => ({ instances:[ { cu:'cu2', projectPath:'D:/x/cu2', port:6402 } ], available:true, live:true, servers:[] }),
    text: async () => '', headers:{ get(){ return null; } } }));
  const w = watchBrokenRefs();
  const url = pathToFileURL(path.resolve(import.meta.dirname, '../web/js/unity.js')).href;
  let unity;
  try { unity = await import(url); }
  catch (e){ w.stop(); assert.fail('import unity.js упал: ' + (e && e.stack || e)); }

  S.activeView = 'mcp'; S.mcpDetail = null;
  await unity.loadUnityInstances();                                  // fetch → S.unityInstances + renderMcp
  assert.equal(S.unityInstances.length, 1, 'инстансы загрузились');
  assert.doesNotThrow(() => unity.launchUnity('cu2', 'D:/x/cu2'), 'launchUnity без Electron-моста — тост, не бросок');

  await new Promise((r) => setTimeout(r, 40));
  w.stop();
  assert.deepEqual(w.errors, [], 'сломанная ссылка в unity.js: ' + w.errors.join(' | '));
});
