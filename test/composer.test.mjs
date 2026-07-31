// composer.js — поле ввода. renderComposer строит композер и вешает листенеры; paintMode красит кнопку режима;
// updateSlash/renderSlash — «/»-автокомплит скиллов; renderAttachDraft — превью вложений; cycleMode — циклит режим.
// Забытый импорт (S/attachDraft/esc/toast/requireAuth/loadModelsCatalog/userStop/runPrompt/ensureConsole и хелперы
// transcript) стрельнул бы в момент вызова — гоняем в null-DOM.

import './dom-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setFetch, watchBrokenRefs } from './dom-stub.mjs';
import { S, attachDraft } from '../web/js/store.js';
import { renderComposer, paintMode, updateSlash, renderSlash, renderAttachDraft, cycleMode } from '../web/js/composer.js';

test('composer.js: renderComposer + paintMode + slash + attach + cycleMode', async () => {
  setFetch(async () => ({ ok:true, status:200,
    json: async () => ({ models:[], efforts:[] }), text: async () => '', headers:{ get(){ return null; } } }));
  const w = watchBrokenRefs();

  // Каталог моделей/эффортов заранее непустой: иначе openModePop (его дёргает cycleMode, т.к. в null-DOM попап
  // «не скрыт») уходит в бесконечный loadModelsCatalog().then(openModePop) — стаб отдаёт пустой список моделей.
  S.MODELS = [{ value:'claude-opus', label:'Opus', efforts:['low','high'] }];
  S.EFFORTS = [{ value:'', label:'Effort: по умолчанию' }, { value:'low', label:'Effort: low' }, { value:'high', label:'Effort: high' }];

  renderComposer({ file:'f1', cwd:'/tmp' });
  paintMode();

  S.SESSION_SKILLS = [
    { name:'jira-report', source:'user',    description:'отчёт в jira' },
    { name:'commit',      source:'project', description:'коммит результата' },
  ];
  updateSlash();                              // «/» в поле нет (value='') → дропдаун закрыт, но фильтр не падает
  S.slashOpen = true; S.slashItems = S.SESSION_SKILLS.slice(); S.slashSel = 0;
  renderSlash();                              // рендер элементов дропдауна + esc

  attachDraft.length = 0;                     // renderComposer уже обнулил — наполняем после
  attachDraft.push({ kind:'text', name:'a.txt' }, { kind:'image', name:'b.png', preview:'data:,' });
  renderAttachDraft();

  const before = S.sessionMode;
  cycleMode();
  assert.notEqual(S.sessionMode, before, 'cycleMode переключает режим');

  await new Promise((r) => setTimeout(r, 80));   // дожидаемся loadModelsCatalog / setTimeout(focus)
  w.stop();
  assert.deepEqual(w.errors, [], 'сломанная ссылка в composer.js: ' + w.errors.join(' | '));
});
