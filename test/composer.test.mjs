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

test('armPending: занято → один push в живой ход (dup снимает pending); свободно → новым ходом; без спама между тиками', async () => {
  localStorage.clear(); promptQueue.length = 0;
  S.sessionMode = 'default'; S.sessionModel = ''; S.sessionEffort = ''; S.streaming = false;
  let pushes = 0; let dupResp = false;
  setFetch(async () => { pushes++; return { ok:true, status:200, json: async () => ({ ok:true, dup:dupResp }), text: async () => '', headers:{ get(){ return null; } } }; });

  // 1) занято (serverBusy=true): один push в живой канал; повторный тик в этом заходе не спамит (pendingHandled).
  // Идемпотентность обеспечивает СЕРВЕР по pid — клиент лишь снижает лишние запросы.
  S.currentFile = 'fbusy'; S.pendingHandled = new Set(); S.serverBusy = true;
  addPending('fbusy', 'в живой ход', []);
  armPending('fbusy'); await new Promise(r=>setTimeout(r,10));
  armPending('fbusy'); await new Promise(r=>setTimeout(r,10));
  assert.equal(pushes, 1, 'занято → один push на текст в этом заходе (без спама каждые 4с)');
  assert.equal(promptQueue.length, 0, 'занято → новый ход в очередь не ставим');
  assert.equal(loadPending('fbusy').length, 1, 'pending держим — снимется по транскрипту или dup-ответу');

  // dup-ответ сервера (pid уже доставлен) → pending снимается
  dupResp = true;
  S.currentFile = 'fbusy2'; S.pendingHandled = new Set(); S.serverBusy = true;
  addPending('fbusy2', 'уже был', []);
  armPending('fbusy2'); await new Promise(r=>setTimeout(r,10));
  assert.equal(loadPending('fbusy2').length, 0, 'dup от сервера → pending снят (не висит вечно)');
  dupResp = false;

  // 2) свободно (serverBusy=false): промт уходит новым ходом (drainQueue сразу вынимает и планирует runPrompt →
  // наблюдаем по pendingHandled). Через /api/chat-input НЕ идёт.
  promptQueue.length = 0;
  S.currentFile = 'fidle'; S.pendingHandled = new Set(); S.serverBusy = false;
  const pushesBefore = pushes;
  addPending('fidle', 'новым ходом', []);
  armPending('fidle');
  S.currentFile = null;   // гасим отложенный drainQueue→runPrompt (его setTimeout выходит, если currentFile снят)
  assert.equal(S.pendingHandled.has('fidle\nновым ходом'), true, 'свободно → промт обработан (ушёл новым ходом)');
  assert.equal(pushes, pushesBefore, 'доставка новым ходом не идёт через /api/chat-input');

  await new Promise(r=>setTimeout(r,80));   // дождаться, пока отложенные drainQueue-таймеры увидят currentFile=null и выйдут
  promptQueue.length = 0;
});
