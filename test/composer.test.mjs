// composer.js — поле ввода. renderComposer строит композер и вешает листенеры; paintMode красит кнопку режима;
// updateSlash/renderSlash — «/»-автокомплит скиллов; renderAttachDraft — превью вложений; cycleMode — циклит режим.
// Забытый импорт (S/attachDraft/esc/toast/requireAuth/loadModelsCatalog/userStop/runPrompt/ensureConsole и хелперы
// transcript) стрельнул бы в момент вызова — гоняем в null-DOM.

import './dom-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setFetch, watchBrokenRefs } from './dom-stub.mjs';
import { S, attachDraft, promptQueue } from '../web/js/store.js';
import { renderComposer, paintMode, updateSlash, renderSlash, renderAttachDraft, cycleMode, armPending, addPending, loadPending } from '../web/js/composer.js';

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

test('armPending: реконсиль ожидающих — свободно → новым ходом; занято → один push; провал push → повтор новым ходом', async () => {
  localStorage.clear(); promptQueue.length = 0;
  S.currentFile = 'freconcile'; S.pendingHandled = new Set();
  S.sessionMode = 'default'; S.sessionModel = ''; S.sessionEffort = '';

  // 1) свободно (serverBusy=false): pending помечается handled и уходит новым ходом (drainQueue сразу вынимает из
  // очереди и планирует runPrompt — поэтому наблюдаем по pendingHandled, а не по длине очереди). Повторный тик не дублит.
  S.serverBusy = false;
  addPending('freconcile', 'первый', []);
  armPending('freconcile');
  S.currentFile = null;   // гасим отложенный drainQueue→runPrompt (его setTimeout выходит, если currentFile снят)
  assert.equal(S.pendingHandled.has('freconcile\nпервый'), true, 'свободно → промт обработан (ушёл новым ходом)');
  S.currentFile = 'freconcile';
  armPending('freconcile');
  S.currentFile = null;
  assert.equal(promptQueue.length, 0, 'повторный тик не поставил дубль в очередь (pendingHandled удержал)');
  await new Promise(r=>setTimeout(r,80));   // дождаться, пока отложенные drainQueue-таймеры увидят currentFile=null и выйдут
  S.currentFile = 'freconcile';

  // 2) занято (serverBusy=true): пушим в живой канал РОВНО один раз; ok=true → pending НЕ снимаем (снимет транскрипт)
  localStorage.clear(); promptQueue.length = 0;
  S.currentFile = 'fbusy'; S.pendingHandled = new Set(); S.serverBusy = true;
  let pushes = 0;
  setFetch(async () => { pushes++; return { ok:true, status:200, json: async () => ({ ok:true }), text: async () => '', headers:{ get(){ return null; } } }; });
  addPending('fbusy', 'в живой ход', []);
  armPending('fbusy'); await new Promise(r=>setTimeout(r,10));
  armPending('fbusy'); await new Promise(r=>setTimeout(r,10));
  assert.equal(pushes, 1, 'занято → один push на текст, повтор тика не дублирует');
  assert.equal(promptQueue.length, 0, 'занято → в очередь новый ход не ставим');
  assert.equal(loadPending('fbusy').length, 1, 'pending держим до появления промта в транскрипте (не снимаем по ok push)');

  // 3) провал push (ход завершился между снимком и POST): handled снимается → следующий тик отдаёт новым ходом
  localStorage.clear(); promptQueue.length = 0;
  S.currentFile = 'ffail'; S.pendingHandled = new Set(); S.serverBusy = true;
  setFetch(async () => ({ ok:true, status:200, json: async () => ({ ok:false }), text: async () => '', headers:{ get(){ return null; } } }));
  addPending('ffail', 'не долетело', []);
  armPending('ffail'); await new Promise(r=>setTimeout(r,10));
  assert.equal(S.pendingHandled.has('ffail\nне долетело'), false, 'провал push снял метку handled → повтор возможен');
  S.serverBusy = false;                       // ход завершился
  armPending('ffail');
  assert.equal(S.pendingHandled.has('ffail\nне долетело'), true, 'после провала push и завершения хода промт обработан новым ходом (не потерян)');
  S.currentFile = null;                        // гасим отложенный runPrompt
  await new Promise(r=>setTimeout(r,80));
  promptQueue.length = 0;
});
