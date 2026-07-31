// Boot-smoke для web/js/app.js — сеть безопасности рефакторинга-распила.
//
// app.js — side-effect entry-скрипт: дёргает document/window/localStorage/fetch на верхнем уровне и в
// init-хвосте. Этот тест ставит null-DOM (см. dom-stub) и импортирует app.js целиком: если распил
// сломал граф модулей, имя импорта или ссылку — import упадёт синхронно ЛИБО async-init выкинет
// «is not a function»/«Cannot read properties». Runtime-взаимодействие (клики, стрим) — на ручную
// проверку; здесь проверяется именно «модуль грузится и инициализируется».

import './dom-stub.mjs';   // ПЕРВОЙ строкой — ставит браузерные заглушки до импорта app.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { watchBrokenRefs } from './dom-stub.mjs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

test('boot: app.js грузится и инициализируется в null-DOM без ошибок графа модулей', async () => {
  const w = watchBrokenRefs();
  const appUrl = pathToFileURL(path.resolve(import.meta.dirname, '../web/js/app.js')).href;
  try {
    await import(appUrl);            // синхронный eval + init-хвост: упадёт здесь при битом графе/ссылке
  } catch (e) {
    w.stop();
    assert.fail('import app.js упал при загрузке/инициализации: ' + (e && e.stack || e));
  }
  await new Promise((r) => setTimeout(r, 120));   // дать отработать async-init (load и пр.)
  w.stop();
  assert.deepEqual(w.errors, [], 'async-init выкинул ошибку «сломанной ссылки»: ' + w.errors.join(' | '));
});
