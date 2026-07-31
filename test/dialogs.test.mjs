// dialogs.js вынесен из app.js (модалки: новая сессия/форк/удаление, обновления, настройки). Boot-smoke ни одну
// модалку не открывает, поэтому забытый импорт внутри их тел (esc/modalBack/requireAuth/renderServicesGate/…)
// там бы не стрельнул. Тест строит модалки в null-DOM (deckNative застабан для обновлений) и ловит битую ссылку.

import './dom-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setFetch, watchBrokenRefs } from './dom-stub.mjs';
import { S } from '../web/js/store.js';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

test('dialogs.js: модалки строятся в null-DOM без сломанных ссылок', async () => {
  setFetch(async () => ({ ok:true, status:200,
    json: async () => ({ ok:true, models:[], efforts:[], sessions:[], jira:{}, teamcity:{}, gitlab:{},
      unity:{}, defaults:{}, electron:true }),
    text: async () => '', headers:{ get(){ return null; } } }));
  const w = watchBrokenRefs();
  const url = pathToFileURL(path.resolve(import.meta.dirname, '../web/js/dialogs.js')).href;
  let dialogs;
  try { dialogs = await import(url); }
  catch (e){ w.stop(); assert.fail('import dialogs.js упал: ' + (e && e.stack || e)); }

  S.AUTH = { loggedIn:true };            // requireAuth пропустит openNewSessionDialog к построению
  S.MODELS = []; S.EFFORTS = [];
  S.SESSIONS = [{ file:'a', title:'A', project:'p', cwd:'/tmp', wo:'WO-1', gitBranch:'x', mtime:Date.now() }];

  assert.equal(typeof dialogs.modalBack('tBack'), 'object', 'modalBack вернул подложку');
  await dialogs.openNewSessionDialog();  // requireAuth → loadModelsCatalog → activeProjectPath → build modal
  assert.doesNotThrow(() => dialogs.renderUpdateStatus({ state:'available', version:'9' }), 'renderUpdateStatus без EL');

  // обновления — только в Electron: стабаем deckNative, чтобы пройти по построению модалки (не по early-return)
  window.deckNative = {
    updateInfo: async () => ({ version:'0.1.28', packaged:false }),
    checkForUpdates: async () => ({ ok:true }),
    downloadUpdate: async () => ({ ok:true }),
    quitAndInstall: async () => {},
  };
  await dialogs.openUpdatesModal();      // build updates modal + wire кнопок
  assert.doesNotThrow(() => dialogs.renderUpdateStatus({ state:'downloading', percent:50 }), 'renderUpdateStatus с EL');
  delete window.deckNative;

  await dialogs.openSettingsModal();     // fetch /api/config → построение полей + wireRow + updSummary

  await new Promise((r) => setTimeout(r, 80));
  w.stop();
  assert.deepEqual(w.errors, [], 'сломанная ссылка в dialogs.js: ' + w.errors.join(' | '));
});
