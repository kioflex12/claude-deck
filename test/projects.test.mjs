// projects.js вынесен из app.js (переключатель workspaces). Boot-smoke меню проектов не строит, поэтому забытый
// импорт внутри toggleProjMenu/renderProjSwitch (esc/S) там бы не стрельнул. Тест кладёт проекты в S.PROJECTS,
// подсовывает persistent-элемент меню (чтобы пройти НЕ по early-return, а по построению строк) и ловит битую ссылку.

import './dom-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setFetch, watchBrokenRefs, makeEl } from './dom-stub.mjs';
import { S } from '../web/js/store.js';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

test('projects.js: переключатель проектов в null-DOM', async () => {
  setFetch(async () => ({ ok:true, status:200,
    json: async () => ({ projects:[], activeId:'', sessions:[] }),
    text: async () => '', headers:{ get(){ return null; } } }));
  const w = watchBrokenRefs();
  const url = pathToFileURL(path.resolve(import.meta.dirname, '../web/js/projects.js')).href;
  let projects;
  try { projects = await import(url); }
  catch (e){ w.stop(); assert.fail('import projects.js упал: ' + (e && e.stack || e)); }

  S.PROJECTS = [{ id:'p1', name:'Proj 1', path:'/a' }, { id:'p2', name:'Proj 2', path:'/b' }];
  S.ACTIVE_PROJECT = 'p1';

  assert.doesNotThrow(() => projects.renderProjSwitch(), 'renderProjSwitch — имя активного проекта');
  assert.equal(typeof projects.activeProjectPath(), 'string', 'activeProjectPath вернул строку');

  // toggleProjMenu делает early-return при menu.hidden===false (стаб отдаёт свежий el). Даём persistent-меню
  // с hidden=true, чтобы пройти по ветке построения строк (esc + S.PROJECTS + wiring), а не по раннему выходу.
  const menuEl = makeEl(); menuEl.hidden = true;
  document.getElementById = (id) => id === 'projMenu' ? menuEl : makeEl();
  assert.doesNotThrow(() => projects.toggleProjMenu(), 'toggleProjMenu — построение строк меню');

  await new Promise((r) => setTimeout(r, 40));
  w.stop();
  assert.deepEqual(w.errors, [], 'сломанная ссылка в projects.js: ' + w.errors.join(' | '));
});
