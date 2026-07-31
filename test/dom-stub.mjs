// Общий null-DOM для headless-тестов клиента (boot/ui/…). Ставит браузерные заглушки в globalThis
// как side-effect импорта — импортируй ПЕРВОЙ строкой теста, до dynamic import тестируемого модуля.
// Каждый тест-файл `node --test` запускает в своём процессе, так что глобалы не текут между файлами.

// Универсальный элемент: Proxy → любой неизвестный метод = no-op (chainable). querySelector отдаёт
// такой же стаб (не null), чтобы цепочки `el.querySelector(x).addEventListener(...)` не падали в null-DOM.
export function makeEl(){
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
      if (k === 'querySelector' || k === 'closest') return () => makeEl();
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
    if (k === 'querySelector') return () => makeEl();
    if (k === 'querySelectorAll' || k === 'getElementsByClassName' || k === 'getElementsByTagName') return () => [];
    if (k === 'createElement' || k === 'createElementNS' || k === 'createTextNode') return () => makeEl();
    return () => {};
  },
  set(t, k, v){ t[k] = v; return true; },
});

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
globalThis.EventSource = class { constructor(){} close(){} addEventListener(){} removeEventListener(){} };
globalThis.open = () => null;               // window.open (не-Electron ветка openExternal)
globalThis.confirm = () => true;            // window.confirm (mcpRemove и пр.)
globalThis.alert = () => {};
try {   // в Node ≥21 navigator — read-only-геттер; не переопределяем, лишь дотачиваем clipboard при отсутствии
  if (!globalThis.navigator) globalThis.navigator = { clipboard:{ writeText: async () => {} } };
  else if (!globalThis.navigator.clipboard) globalThis.navigator.clipboard = { writeText: async () => {} };
} catch {}
// Занулить setInterval — иначе поллинг доски и авто-дискавери Unity держат процесс `node --test` живым.
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};

// fetch по умолчанию отдаёт «пустой ok» — тест может переопределить через setFetch.
export function setFetch(fn){ globalThis.fetch = fn; }
setFetch(async () => ({ ok:true, status:200, json: async () => ({}), text: async () => '', headers:{ get(){ return null; } } }));

// Ловушка «сломанной ссылки» в async-init/обработчиках (fire-and-forget): собирает unhandledRejection,
// чьё сообщение похоже на отсутствующий импорт/битую ссылку. Возвращает { errors, stop }.
export function watchBrokenRefs(){
  const errors = [];
  const onRej = (e) => {
    const m = String((e && e.message) || e);
    if (/is not a function|Cannot read propert|is not defined|does not provide an export|has no export|SyntaxError/i.test(m)) errors.push(m);
  };
  process.on('unhandledRejection', onRej);
  return { errors, stop: () => process.off('unhandledRejection', onRej) };
}
