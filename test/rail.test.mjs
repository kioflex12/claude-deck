// rail.js — правый контекст-рейл сессии. sideHTML синхронно строит разметку из объекта сессии; забытый импорт
// (esc/aReal/jiraUrl/WF_LABEL/runningAgents/agentBoxHTML) стрельнул бы ReferenceError в момент вызова. Гоняем в null-DOM.

import './dom-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { watchBrokenRefs } from './dom-stub.mjs';
import { sideHTML } from '../web/js/rail.js';

test('rail.js: sideHTML рендерит рейл синтетической сессии', () => {
  const w = watchBrokenRefs();
  const t = {
    file:'/x/f1.jsonl', title:'Заголовок', project:'proj', cwd:'/tmp/proj', wo:'WO-42',
    model:'opus', count:7, mtime:Date.now(), winTokens:123456, ctxPct:0.42, active:true,
    gitBranch:'preprod', wfBranch:'feature/WO-42', wfColumn:'in_progress', wfStep:3,
    wfMrUrl:'https://gitlab.example/group/repo/-/merge_requests/17', wfMrState:'open', wfBuildState:'done',
    clientCu:'cu1', backend:true, statics:false, baseBranch:'preprod', merged:false,
    changedServices:['town','map'], notes:['вернуться к маппингу','проверить миграцию'], agents:[], tags:['chat'],
    lastPrompt:'сделай X',
  };
  const html = sideHTML(t);
  assert.equal(typeof html, 'string');
  assert.ok(html.length > 0);
  assert.ok(html.includes('proj'), 'рейл содержит имя проекта');

  const minimal = sideHTML({ file:'f0', title:'', project:'p', cwd:'', model:'sonnet', count:0, mtime:0, winTokens:0, ctxPct:0 });
  assert.equal(typeof minimal, 'string');   // без wo/mr/сборок/агентов — не падаем

  w.stop();
  assert.deepEqual(w.errors, [], 'сломанная ссылка в rail.js: ' + w.errors.join(' | '));
});
