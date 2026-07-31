// ui.js — общие UI-листья вынесены из app.js. Boot-smoke ловит только load-time импорты; забытый
// импорт ВНУТРИ тела листа (jiraUrl/loadServicesGate/modalBack/mdToHtml/esc) стрельнул бы лишь при
// вызове. Этот тест вызывает каждый лист в null-DOM и ловит такую «сломанную ссылку».

import './dom-stub.mjs';   // ПЕРВОЙ строкой — браузерные заглушки до импорта ui.js (тянет app.js по циклу)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setFetch, watchBrokenRefs } from './dom-stub.mjs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

test('ui.js: листья вызываются в null-DOM без сломанных ссылок', async () => {
  // /api/file → «ok md» (openFileViewer дойдёт до modalBack+mdToHtml); прочее → {} (мягко, как боевые хендлеры).
  setFetch(async (u) => {
    const url = String(u);
    const payload = url.includes('/api/file') ? { ok:true, ext:'md', text:'# заголовок\n\nтекст', name:'plan.md' } : {};
    return { ok:true, status:200, json: async () => payload, text: async () => '', headers:{ get(){ return null; } } };
  });
  const w = watchBrokenRefs();
  const uiUrl = pathToFileURL(path.resolve(import.meta.dirname, '../web/js/ui.js')).href;
  let ui;
  try { ui = await import(uiUrl); }
  catch (e) { w.stop(); assert.fail('import ui.js упал: ' + (e && e.stack || e)); }

  assert.doesNotThrow(() => ui.toast('привет'), 'toast');
  assert.doesNotThrow(() => ui.openExternal('https://example.com'), 'openExternal');
  await ui.openWoJira('WO-123');                 // exercises jiraUrl + loadServicesGate
  ui.openLocalResource('docs/plan.md');          // exercises S/SESSION_CACHE + openFileViewer
  await ui.openFileViewer('docs/plan.md', '');   // exercises modalBack + mdToHtml + esc

  await new Promise((r) => setTimeout(r, 60));
  w.stop();
  assert.deepEqual(w.errors, [], 'сломанная ссылка в ui.js: ' + w.errors.join(' | '));
});
