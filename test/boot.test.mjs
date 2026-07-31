// Boot-smoke для web/js/app.js — сеть безопасности рефакторинга-распила.
//
// app.js — side-effect entry-скрипт без экспортов: он дёргает document/window/localStorage/fetch
// на верхнем уровне и в init-хвосте (ensureStatusTab/wireTopbar/loadAuth/load…). Headless он не
// импортировался вообще (см. client.test.mjs, где берут только util.js/columns.js). Этот тест ставит
// «null-DOM» (Proxy, поглощающий любой метод) и импортирует app.js целиком: если распил сломал граф
// модулей, имя импорта, ссылку на функцию/глобал — import упадёт синхронно ЛИБО async-init выкинет
// «is not a function»/«Cannot read properties». Тест это ловит. Runtime-взаимодействие (клики,
// стрим) остаётся на ручную проверку — тут проверяется именно «модуль грузится и инициализируется».

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

// --- null-DOM: универсальный элемент. Proxy → любой неизвестный метод = no-op (chainable). ---
function makeEl(){
  const base = {
    style:{}, dataset:{},
    classList:{ add(){}, remove(){}, toggle(){}, contains(){ return false; } },
    innerHTML:'', outerHTML:'', textContent:'', value:'', checked:false, hidden:false, id:'', className:'',
    scrollTop:0, scrollHeight:0, clientHeight:0, offsetHeight:0, firstElementChild:null, children:[],
  };
  return new Proxy(base, {
    get(t, k){
      if (k in t) return t[k];
      if (k === 'querySelectorAll' || k === 'getElementsByClassName' || k === 'getElementsByTagName') return () => [];
      if (k === 'querySelector' || k === 'closest') return () => null;
      if (k === 'getBoundingClientRect') return () => ({ top:0, left:0, right:0, bottom:0, width:0, height:0 });
      if (k === 'appendChild' || k === 'insertBefore' || k === 'replaceChild') return (c) => c;
      return () => {};
    },
    set(t, k, v){ t[k] = v; return true; },
  });
}

const doc = new Proxy({ title:'', body:makeEl(), documentElement:makeEl(), head:makeEl(), cookie:'' }, {
  get(t, k){
    if (k in t) return t[k];
    if (k === 'getElementById') return () => makeEl();
    if (k === 'querySelector' || k === 'getElementById') return () => makeEl();
    if (k === 'querySelectorAll' || k === 'getElementsByClassName' || k === 'getElementsByTagName') return () => [];
    if (k === 'createElement' || k === 'createElementNS' || k === 'createTextNode') return () => makeEl();
    return () => {};
  },
  set(t, k, v){ t[k] = v; return true; },
});

// localStorage-заглушка нужна ДО импорта (app.js читает deckModel/deckEffort при eval верхнего уровня).
const _ls = new Map();
globalThis.localStorage = {
  getItem(k){ return _ls.has(k) ? _ls.get(k) : null; },
  setItem(k, v){ _ls.set(k, String(v)); },
  removeItem(k){ _ls.delete(k); },
  clear(){ _ls.clear(); },
};

globalThis.document = doc;
globalThis.window = globalThis;             // window.deckNative остаётся undefined → init-guards пропускают Electron-мосты
globalThis.location = { href:'http://localhost/', origin:'http://localhost', pathname:'/', search:'' };
globalThis.matchMedia = () => ({ matches:false, addEventListener(){}, removeEventListener(){}, addListener(){}, removeListener(){} });
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.fetch = async () => ({ ok:true, status:200, json: async () => ({}), text: async () => '', headers:{ get(){ return null; } } });
globalThis.EventSource = class { constructor(){} close(){} addEventListener(){} removeEventListener(){} };

// Занулить setInterval — иначе поллинг доски (7с) и авто-дискавери Unity (15с, top-level app.js:1425)
// оставляют висячие handle'ы и процесс `node --test` не завершается. setTimeout оставляем настоящим.
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};

test('boot: app.js грузится и инициализируется в null-DOM без ошибок графа модулей', async () => {
  // Ловим «сломанную ссылку» и в async-init (load/loadAuth/loadServicesGate — они fire-and-forget).
  const brokenRef = [];
  const onRej = (e) => {
    const m = String((e && e.message) || e);
    if (/is not a function|Cannot read propert|is not defined|does not provide an export|has no export|Unexpected|SyntaxError/i.test(m)) brokenRef.push(m);
  };
  process.on('unhandledRejection', onRej);

  const appUrl = pathToFileURL(path.resolve(import.meta.dirname, '../web/js/app.js')).href;
  try {
    await import(appUrl);            // синхронный eval + init-хвост: упадёт здесь при битом графе/ссылке
  } catch (e) {
    process.off('unhandledRejection', onRej);
    assert.fail('import app.js упал при загрузке/инициализации: ' + (e && e.stack || e));
  }

  await new Promise((r) => setTimeout(r, 120));   // дать отработать async-init (load и пр.)
  process.off('unhandledRejection', onRej);

  assert.deepEqual(brokenRef, [], 'async-init выкинул ошибку «сломанной ссылки»: ' + brokenRef.join(' | '));
});
