// skills.js вынесен из app.js. Boot-smoke не заходит на вкладку «Скиллы», поэтому забытый импорт внутри
// renderSkills/loadSkillsCatalog (esc/toast/openSession) там не стрельнул бы. Этот тест грузит каталог и рисует
// сетку/категории (в т.ч. с фильтром) в null-DOM — ловит такую «сломанную ссылку».

import './dom-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setFetch, watchBrokenRefs } from './dom-stub.mjs';
import { S } from '../web/js/store.js';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

test('skills.js: загрузка каталога + рендер сетки/категорий в null-DOM', async () => {
  setFetch(async () => ({ ok:true, status:200,
    json: async () => ({ skills:[
      { cmd:'deploy', cat:'user', does:'деплой сервиса', trig:'деплой' },
      { cmd:'bugfix', cat:'project', does:'починка бага', trig:'баг' },
    ] }), text: async () => '', headers:{ get(){ return null; } } }));
  const w = watchBrokenRefs();
  const url = pathToFileURL(path.resolve(import.meta.dirname, '../web/js/skills.js')).href;
  let skills;
  try { skills = await import(url); }
  catch (e){ w.stop(); assert.fail('import skills.js упал: ' + (e && e.stack || e)); }

  S.activeView = 'skills'; S.skillCat = 'all'; S.query = '';
  await skills.loadSkillsCatalog();                                  // fetch → S.SKILLS + renderSkills
  assert.equal(S.SKILLS.length, 2, 'скиллы загрузились');
  assert.doesNotThrow(() => skills.renderSkills(), 'renderSkills — сетка/категории');
  S.skillCat = 'user';
  assert.doesNotThrow(() => skills.renderSkills(), 'renderSkills — фильтр по категории');

  await new Promise((r) => setTimeout(r, 40));
  w.stop();
  assert.deepEqual(w.errors, [], 'сломанная ссылка в skills.js: ' + w.errors.join(' | '));
});
