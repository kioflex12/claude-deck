// Кластер сессии/чата вынесен из app.js и распилён на rail/transcript/composer/stream + оркестратор session.
// Boot-smoke сессию не открывает, поэтому забытый импорт внутри openSession/runPrompt/sideHTML/renderComposer/
// renderThread там бы не стрельнул (ReferenceError в ES-модуле возникает В МОМЕНТ ВЫЗОВА). Этот тест реально
// открывает сессию и прогоняет композер/стрим в null-DOM, ловя сломанные ссылки через watchBrokenRefs.
// openSession живёт в session.js; renderComposer/paintMode/clearQueue — в composer.js; runPrompt/userStop/
// updateTailIndicator/updateRailContext — в stream.js (импортируем из новых домов).

import './dom-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setFetch, watchBrokenRefs } from './dom-stub.mjs';
import { S, SESSION_CACHE } from '../web/js/store.js';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

test('session.js: открытие сессии + композер + стрим в null-DOM', async () => {
  // единый правдоподобный ответ на все эндпоинты сессии/рейла (session/tail/chat-prepare/builds/mrs/jira/skills/models)
  setFetch(async () => ({ ok:true, status:200,
    json: async () => ({ blocks:[], sessions:[], turnStartTs:0, token:'t', ok:true,
      builds:[], mrs:[], skills:[], models:[], efforts:[], agents:[], available:false, count:0, active:false }),
    text: async () => '', headers:{ get(){ return null; } } }));
  const w = watchBrokenRefs();
  const base = path.resolve(import.meta.dirname, '../web/js');
  let session, composer, stream;
  try {
    session  = await import(pathToFileURL(path.join(base, 'session.js')).href);
    composer = await import(pathToFileURL(path.join(base, 'composer.js')).href);
    stream   = await import(pathToFileURL(path.join(base, 'stream.js')).href);
  } catch (e){ w.stop(); assert.fail('import session-кластера упал: ' + (e && e.stack || e)); }

  S.SESSIONS = [{ file:'f1', title:'T', project:'p', cwd:'/tmp', wo:'WO-1', gitBranch:'x', ctxPct:0.3, updatedAt:0 }];
  SESSION_CACHE.f1 = { file:'f1', cwd:'/tmp', ctxPct:0.3, blocks:[
    { kind:'user', text:'hi' },
    { kind:'assistant', text:'**ok**', meta:{ in:1200, out:800, ctxPct:0.3 } },
    { kind:'thinking', text:'hmm' },
    { kind:'tool', name:'Read', arg:'x', result:'y' },
  ] };

  S.paneMode = true;                          // тестируем классический рендер сессии (в проде это путь iframe-пани воркспейса)
  await session.openSession('f1');            // sideHTML/renderThread/renderComposer/wiring/loadBuilds/loadMrs/loadJira/loadSkills
  composer.renderComposer(S.SESSIONS[0]);
  composer.paintMode();
  stream.updateTailIndicator(true, 0);
  stream.updateRailContext(0.5, 1234);

  await Promise.race([                        // setup-путь стрима: EventSource застабан, событий нет — ок
    stream.runPrompt({ text:'привет', mode:'default' }),
    new Promise((r) => setTimeout(r, 150)),
  ]);

  // finish() зовёт runEl.remove(), но appendHTML в null-DOM возвращает null (firstElementChild=null) — ведём
  // userStop по hard-reset ветке (без finish), это тоже полностью резолвит стрим.
  S.liveFinish = null;
  stream.userStop();
  composer.clearQueue();

  await new Promise((r) => setTimeout(r, 40));
  w.stop();
  assert.deepEqual(w.errors, [], 'сломанная ссылка в session-кластере: ' + w.errors.join(' | '));
});
