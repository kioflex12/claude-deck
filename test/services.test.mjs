// services.js вынесен из app.js. Boot-smoke не открывает сессию, поэтому забытый импорт внутри
// loadBuilds/loadMrs/loadJira/hydrate*/agentBoxHTML/renderTags (esc/kTok/aReal/isBaseBranch/renderBoard) там
// не стрельнул бы. Этот тест дёргает рендер-пути интеграций в null-DOM с fetch-заглушкой — ловит «сломанную ссылку».

import './dom-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setFetch, watchBrokenRefs } from './dom-stub.mjs';
import { S } from '../web/js/store.js';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

test('services.js: рендер-пути TeamCity/GitLab/Jira/теги/агенты в null-DOM', async () => {
  setFetch(async () => ({ ok:true, status:200,
    json: async () => ({ available:true,
      builds:[{ plat:'Android', state:'running', status:'', number:'42', webUrl:'https://tc/1', percent:42, stage:'Compiling' }],
      mrs:[{ iid:7, web_url:'https://gl/-/merge_requests/7', target_branch:'preprod', source_branch:'feature/x', state:'opened', project:'client' }],
      status:'In Progress', category:'indeterminate', summary:'работаем' }),
    text: async () => '', headers:{ get(){ return null; } } }));
  const w = watchBrokenRefs();
  const url = pathToFileURL(path.resolve(import.meta.dirname, '../web/js/services.js')).href;
  let svc;
  try { svc = await import(url); }
  catch (e){ w.stop(); assert.fail('import services.js упал: ' + (e && e.stack || e)); }

  S.SESSIONS = [
    { file:'a.jsonl', title:'A', project:'p', wo:'WO-1', gitBranch:'feature/WO-1', model:'opus', msgs:1, ctxPct:0.3, mtime:Date.now(), wfColumn:'active' },
    { file:'b.jsonl', title:'B', project:'p', wo:'WO-2', gitBranch:'feature/WO-2', model:'opus', msgs:1, ctxPct:0.3, mtime:Date.now(), wfColumn:'qa' },
  ];
  S.currentFile = 'a.jsonl'; S.activeView = 'status';
  const t = S.SESSIONS[0];

  await assert.doesNotReject(() => svc.loadBuilds(t), 'loadBuilds — рейл сборок');
  await assert.doesNotReject(() => svc.loadMrs(t), 'loadMrs — рейл MR');
  await assert.doesNotReject(() => svc.loadJira(t), 'loadJira — рейл Jira');
  await assert.doesNotReject(() => svc.hydrateMrs(true), 'hydrateMrs — гидрация карточек');
  await assert.doesNotReject(() => svc.hydrateJira(true), 'hydrateJira — гидрация карточек');
  assert.equal(typeof svc.agentBoxHTML([{ running:true, name:'a', label:'Explore' }]), 'string', 'agentBoxHTML вернул строку');
  assert.doesNotThrow(() => svc.renderTags(), 'renderTags — секция тегов');
  assert.doesNotThrow(() => svc.MR_TTL_RESET(), 'MR_TTL_RESET — сброс кэшей');

  await new Promise((r) => setTimeout(r, 40));
  w.stop();
  assert.deepEqual(w.errors, [], 'сломанная ссылка в services.js: ' + w.errors.join(' | '));
});
