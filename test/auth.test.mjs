// auth.js вынесен из app.js (чип/гейт Claude + плашка интеграций). Boot-smoke дёргает loadAuth/loadServicesGate,
// но забытый импорт ВНУТРИ renderServicesGate/requireAuth/startLogin стрельнул бы лишь при вызове. Этот тест
// прогоняет рендер-пути авторизации в null-DOM с fetch-заглушкой и ловит «сломанную ссылку».

import './dom-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setFetch, watchBrokenRefs } from './dom-stub.mjs';
import { S } from '../web/js/store.js';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

test('auth.js: чип/гейт/сервисы/requireAuth в null-DOM', async () => {
  setFetch(async () => ({ ok:true, status:200,
    json: async () => ({ loggedIn:true, email:'me@x', orgName:'Org',
      jira:{ host:'h', enabled:false }, teamcity:{}, gitlab:{}, projects:[], activeProjectId:'' }),
    text: async () => '', headers:{ get(){ return null; } } }));
  const w = watchBrokenRefs();
  const url = pathToFileURL(path.resolve(import.meta.dirname, '../web/js/auth.js')).href;
  let auth;
  try { auth = await import(url); }
  catch (e){ w.stop(); assert.fail('import auth.js упал: ' + (e && e.stack || e)); }

  await auth.loadAuth();                     // fetch /api/auth → S.AUTH + renderAuth
  assert.doesNotThrow(() => auth.renderAuth(), 'renderAuth — чип/гейт');
  await auth.loadServicesGate();             // fetch /api/config → renderServicesGate (→ renderProjSwitch)
  assert.doesNotThrow(() => auth.renderServicesGate({   // все сервисы авторизованы → плашка гаснет
    jira:{ host:'h', enabled:true }, teamcity:{ tokenSet:true, host:'t' }, gitlab:{ tokenSet:true, host:'g' },
    projects:[{ id:'p', name:'P', path:'/p' }], activeProjectId:'p' }), 'renderServicesGate с cfg');

  S.AUTH = { loggedIn:true, email:'me@x' };
  assert.equal(auth.requireAuth(), true, 'requireAuth залогинен → true');
  S.AUTH = { loggedIn:false };
  assert.equal(auth.requireAuth(), false, 'requireAuth не залогинен → false (тост + startLogin)');

  await new Promise((r) => setTimeout(r, 60));
  w.stop();
  assert.deepEqual(w.errors, [], 'сломанная ссылка в auth.js: ' + w.errors.join(' | '));
});
