// Deck — Воркспейс: несколько живых сессий одновременно в сплит-лейауте (как редакторы VS Code).
//
// Почему iframe на паню, а не общий DOM: экран сессии (thread/composer/rail/SSE-стрим) во всём остальном коде —
// СИНГЛТОН на S.currentFile (один #thread, один живой стрим). Держать N живых сессий в одном документе значило бы
// переписать весь стабилизированный session/stream/composer/pid-steering на инстансы. Вместо этого каждая паня — тот же
// Deck в «pane-режиме» (одна сессия, без топбара/доски) внутри <iframe>: весь существующий код переиспользуется без
// правок, каждая паня — полностью независимый живой инстанс. Так же устроен VS Code (webview на панель).
//
// Лейаут — рекурсивное бинарное дерево: узел это либо лист (таб-группа с вкладками), либо сплит (row=лево/право,
// col=верх/низ) с долей ratio и двумя детьми. Докинг вкладки к краю листа расщепляет лист; ресайз двигает ratio.
// iframe'ы монтируются лениво (по первой активации вкладки) и живут скрытыми (display:none) при переключении — так
// фоновые вкладки остаются живыми, а переключение не перезагружает стрим.

import { S, SESSION_CACHE } from './store.js';
import { esc } from './util.js';
import { openNewSessionDialog } from './dialogs.js';

const WS_KEY = 'deckWorkspace';
const PANE_PREFIX = 'deckPane:';

// Дерево лейаута + последняя сфокусированная группа (в неё падает следующая открытая сессия).
let WS = { root: null, lastLeaf: null };
let seq = 1;
let built = false;             // дерево уже отрисовано в DOM; добавление/закрытие вкладки идёт инкрементально, без
                               // перестройки (перестройка пересоздала бы iframe'ы = перезагрузка живых сессий соседей)
const mounted = new Set();     // id вкладок, для которых iframe уже создан (переживает перестройку дерева)

function loadWS(){
  try { const d = JSON.parse(localStorage.getItem(WS_KEY) || 'null'); if (d && typeof d === 'object'){ WS = { root: d.root || null, lastLeaf: d.lastLeaf || null }; } } catch {}
  // восстановить счётчик id выше всех сохранённых, чтобы новые id не коллизились
  let max = 0; walk(WS.root, n => { const m = String(n.id||'').match(/(\d+)$/); if (m) max = Math.max(max, +m[1]); if (n.t==='leaf') n.tabs.forEach(t=>{ const mm=String(t.id||'').match(/(\d+)$/); if (mm) max=Math.max(max,+mm[1]); }); });
  seq = max + 1;
}
function saveWS(){ try { localStorage.setItem(WS_KEY, JSON.stringify(WS)); } catch {} }
const leafId = () => 'L' + (seq++);
const tabId = () => 'p' + (seq++);

function writeDesc(id, desc){ try { localStorage.setItem(PANE_PREFIX + id, JSON.stringify(desc)); } catch {} }
function readDesc(id){ try { return JSON.parse(localStorage.getItem(PANE_PREFIX + id) || 'null'); } catch { return null; } }
function delDesc(id){ try { localStorage.removeItem(PANE_PREFIX + id); } catch {} }

// Обход дерева (pre-order), cb(node).
function walk(node, cb){ if (!node) return; cb(node); if (node.t === 'split'){ walk(node.a, cb); walk(node.b, cb); } }
function findLeaf(id){ let r = null; walk(WS.root, n => { if (n.t==='leaf' && n.id===id) r = n; }); return r; }
function leafOfTab(tid){ let r = null; walk(WS.root, n => { if (n.t==='leaf' && n.tabs.some(t=>t.id===tid)) r = n; }); return r; }
// Родительский сплит узла + сторона ('a'|'b'); null для корня.
function parentOf(target){ let res = null; walk(WS.root, n => { if (n.t==='split'){ if (n.a===target) res={ split:n, side:'a' }; else if (n.b===target) res={ split:n, side:'b' }; } }); return res; }

function firstLeaf(node){ if (!node) return null; if (node.t==='leaf') return node; return firstLeaf(node.a) || firstLeaf(node.b); }

// Заменить узел old на новый в дереве (или в корне).
function replaceNode(oldNode, newNode){ if (WS.root === oldNode){ WS.root = newNode; return; } const p = parentOf(oldNode); if (p) p.split[p.side] = newNode; }

// Убрать лист из дерева: сплит-родитель схлопывается в сестринский узел.
function collapseLeaf(leaf){
  if (WS.root === leaf){ WS.root = null; WS.lastLeaf = null; return; }
  const p = parentOf(leaf); if (!p) return;
  const sib = p.side === 'a' ? p.split.b : p.split.a;
  replaceNode(p.split, sib);
  if (WS.lastLeaf === leaf.id) WS.lastLeaf = (firstLeaf(sib) || {}).id || null;
}

// ── добавление сессии ───────────────────────────────────────────────────────
// Открыть сессию в воркспейсе. desc — дескриптор пани: {kind:'file',file,title} для существующей сессии либо
// {kind:'new',cwd,name,mode,model,effort,prompt?,title} для новой (prompt задан → сразу запуск скилла, иначе ждёт промт).
export function addWorkspaceSession(desc){
  const id = tabId();
  const tab = { id, kind: desc.kind, file: desc.file || '', title: desc.title || desc.name || 'сессия' };
  writeDesc(id, descForIframe(desc));
  let leaf = WS.lastLeaf ? findLeaf(WS.lastLeaf) : null;
  if (!leaf){ leaf = firstLeaf(WS.root); }
  if (!leaf){ leaf = { t:'leaf', id: leafId(), tabs: [], active: 0 }; WS.root = leaf; }
  const fresh = !leaf.tabs.length && WS.root === leaf;   // только что созданный корневой лист — DOM ещё нет
  leaf.tabs.push(tab);
  leaf.active = leaf.tabs.length - 1;
  WS.lastLeaf = leaf.id;
  saveWS();
  const onWs = document.querySelector('.tab[data-v="workspace"]')?.getAttribute('aria-selected') === 'true';
  // если воркспейс уже открыт и группа отрисована — доклеиваем вкладку инкрементально (не трогаем живые iframe'ы),
  // иначе просто переключаемся на вкладку (setView построит дерево с нуля, включая новую вкладку).
  if (onWs && built && !fresh && appendTabDOM(leaf, tab)) return;
  gotoWorkspace();
}
// Дескриптор в форме, которую читает pane-режим iframe (см. app.js bootPane).
function descForIframe(desc){
  if (desc.kind === 'file') return { kind:'file', file: desc.file, title: desc.title || '' };
  return { kind:'new', cwd: desc.cwd, name: desc.name || '', mode: desc.mode || 'default', model: desc.model || '', effort: desc.effort || '', prompt: desc.prompt || '', title: desc.title || desc.name || '' };
}

function gotoWorkspace(){
  const tab = document.querySelector('.tab[data-v="workspace"]');
  if (tab) tab.click();   // переключает вид через nav.setView
}

// ── рендер ────────────────────────────────────────────────────────────────
// force=true — полная перестройка дерева (структурное изменение: докинг/схлопывание). Без force и при уже
// построенном дереве переключение на вкладку воркспейса НЕ перестраивает DOM — только домонтирует активные iframe'ы
// (иначе каждый заход перезагружал бы все живые сессии).
export function renderWorkspace(force=false){
  const host = document.getElementById('viewWorkspace'); if (!host) return;
  if (!WS.root || !firstLeaf(WS.root)){ host.innerHTML = ''; host.appendChild(emptyState()); built = false; return; }
  if (!force && built && host.querySelector('.ws-leaf')){ mountVisible(); markFocus(); return; }
  host.innerHTML = '';
  host.appendChild(renderNode(WS.root));
  built = true;
  mountVisible();
}

function emptyState(){
  const d = document.createElement('div'); d.className = 'ws-empty';
  d.innerHTML = `<div class="ws-empty-in"><div class="ws-empty-t">Воркспейс пуст</div>
    <div class="ws-empty-s">Открывайте сессии рядом — сплитами влево/вправо/вверх/вниз, как редакторы в VS Code. Вкладку можно перетащить к краю группы, чтобы расщепить.</div>
    <div class="ws-empty-btns"><button class="ws-btn" data-act="pick">Добавить сессию</button><button class="ws-btn ws-btn-p" data-act="new">Новая сессия</button></div></div>`;
  d.querySelector('[data-act="pick"]').addEventListener('click', openSessionPicker);
  d.querySelector('[data-act="new"]').addEventListener('click', () => openNewSessionDialog({ target:'workspace' }));
  return d;
}

function renderNode(node){
  if (node.t === 'leaf') return renderLeaf(node);
  const wrap = document.createElement('div');
  wrap.className = 'ws-split ' + (node.dir === 'col' ? 'ws-col' : 'ws-row');
  const a = renderNode(node.a); const b = renderNode(node.b);
  const r = typeof node.ratio === 'number' ? node.ratio : 0.5;
  a.style.flex = r + ' 1 0'; b.style.flex = (1 - r) + ' 1 0';
  const div = document.createElement('div'); div.className = 'ws-divider ' + (node.dir === 'col' ? 'ws-div-h' : 'ws-div-v');
  wireDivider(div, wrap, node, a, b);
  wrap.append(a, div, b);
  return wrap;
}

function makeTabButton(leaf, t){
  const tb = document.createElement('div');
  tb.className = 'ws-tab'; tb.draggable = true; tb.dataset.tab = t.id;
  tb.innerHTML = `<span class="ws-tt">${esc(t.title || 'сессия')}</span><button class="ws-tx" title="Закрыть">✕</button>`;
  tb.addEventListener('click', e => { if (e.target.closest('.ws-tx')) return; activate(leaf, leaf.tabs.findIndex(x=>x.id===t.id)); });
  tb.querySelector('.ws-tx').addEventListener('click', e => { e.stopPropagation(); closeTab(leaf, t.id); });
  tb.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', t.id); e.dataTransfer.effectAllowed = 'move'; DRAG = t.id; document.getElementById('viewWorkspace').classList.add('ws-dragging'); });
  tb.addEventListener('dragend', () => { DRAG = null; document.getElementById('viewWorkspace').classList.remove('ws-dragging'); document.querySelectorAll('.ws-dz').forEach(z=>z.className='ws-dz'); });
  return tb;
}
function makeCell(t, visible){ const cell = document.createElement('div'); cell.className = 'ws-cell'; cell.dataset.tab = t.id; cell.style.display = visible ? 'block' : 'none'; return cell; }

function renderLeaf(leaf){
  const el = document.createElement('div');
  el.className = 'ws-leaf' + (WS.lastLeaf === leaf.id ? ' focus' : '');
  el.dataset.leaf = leaf.id;
  const bar = document.createElement('div'); bar.className = 'ws-tabs';
  leaf.tabs.forEach((t, i) => { const tb = makeTabButton(leaf, t); tb.classList.toggle('on', i === leaf.active); bar.appendChild(tb); });
  const add = document.createElement('button'); add.className = 'ws-add'; add.title = 'Добавить сессию в группу'; add.textContent = '+';
  add.addEventListener('click', () => { WS.lastLeaf = leaf.id; openSessionPicker(); });
  bar.appendChild(add);
  const body = document.createElement('div'); body.className = 'ws-body'; body.dataset.leaf = leaf.id;
  leaf.tabs.forEach((t, i) => body.appendChild(makeCell(t, i === leaf.active)));
  const dz = document.createElement('div'); dz.className = 'ws-dz'; dz.innerHTML = '<i class="ws-dz-hi"></i>';
  body.appendChild(dz);
  wireDrop(body, dz, leaf);
  el.append(bar, body);
  el.addEventListener('mousedown', () => { if (WS.lastLeaf !== leaf.id){ WS.lastLeaf = leaf.id; saveWS(); markFocus(); } }, true);
  return el;
}
// Инкрементально доклеить вкладку в уже отрисованную группу — без перестройки дерева (живые iframe'ы соседей целы).
function appendTabDOM(leaf, tab){
  const leafEl = document.querySelector(`.ws-leaf[data-leaf="${cssq(leaf.id)}"]`); if (!leafEl) return false;
  const bar = leafEl.querySelector('.ws-tabs'); const body = leafEl.querySelector('.ws-body');
  bar.insertBefore(makeTabButton(leaf, tab), bar.querySelector('.ws-add'));
  body.insertBefore(makeCell(tab, false), body.querySelector('.ws-dz'));
  activate(leaf, leaf.tabs.findIndex(t=>t.id===tab.id));
  return true;
}

// Смонтировать iframe'ы для активных вкладок всех видимых листов (лениво: только для уже «раскрытых» вкладок).
function mountVisible(){
  walk(WS.root, n => {
    if (n.t !== 'leaf') return;
    n.tabs.forEach((t, i) => {
      if (i === n.active) mounted.add(t.id);
      if (!mounted.has(t.id)) return;
      ensureFrame(t.id);
    });
  });
}
function ensureFrame(tid){
  const cell = document.querySelector(`.ws-cell[data-tab="${cssq(tid)}"]`); if (!cell) return;
  if (cell.querySelector('iframe')) return;
  const f = document.createElement('iframe'); f.className = 'ws-frame'; f.src = '/?pane=' + encodeURIComponent(tid);
  f.setAttribute('allow', 'clipboard-read; clipboard-write');
  cell.appendChild(f);
}
const cssq = s => String(s).replace(/["\\]/g, '\\$&');

function activate(leaf, i){
  leaf.active = i; WS.lastLeaf = leaf.id; mounted.add(leaf.tabs[i].id); saveWS();
  const bar = document.querySelector(`.ws-leaf[data-leaf="${cssq(leaf.id)}"] .ws-tabs`);
  const body = document.querySelector(`.ws-leaf[data-leaf="${cssq(leaf.id)}"] .ws-body`);
  if (bar) bar.querySelectorAll('.ws-tab').forEach((el, j) => el.classList.toggle('on', j === i));
  if (body) body.querySelectorAll('.ws-cell').forEach(c => c.style.display = c.dataset.tab === leaf.tabs[i].id ? 'block' : 'none');
  ensureFrame(leaf.tabs[i].id);
  markFocus();
}
function markFocus(){ document.querySelectorAll('.ws-leaf').forEach(el => el.classList.toggle('focus', el.dataset.leaf === WS.lastLeaf)); }

function closeTab(leaf, tid){
  const i = leaf.tabs.findIndex(t => t.id === tid); if (i < 0) return;
  const wasActive = leaf.active === i;
  leaf.tabs.splice(i, 1);
  mounted.delete(tid); delDesc(tid);
  if (!leaf.tabs.length){ collapseLeaf(leaf); saveWS(); renderWorkspace(true); return; }   // лист опустел → структурная перестройка
  if (leaf.active >= leaf.tabs.length) leaf.active = leaf.tabs.length - 1;
  // инкрементально: убрать кнопку+ячейку закрытой вкладки, не пересобирая дерево
  const leafEl = document.querySelector(`.ws-leaf[data-leaf="${cssq(leaf.id)}"]`);
  if (leafEl){ leafEl.querySelector(`.ws-tab[data-tab="${cssq(tid)}"]`)?.remove(); leafEl.querySelector(`.ws-cell[data-tab="${cssq(tid)}"]`)?.remove(); }
  if (wasActive) activate(leaf, leaf.active);
  saveWS();
}

// ── ресайз сплита ────────────────────────────────────────────────────────
function wireDivider(div, wrap, node, a, b){
  div.addEventListener('pointerdown', e => {
    e.preventDefault(); div.setPointerCapture(e.pointerId);
    const move = ev => {
      const rect = wrap.getBoundingClientRect();
      let r = node.dir === 'col' ? (ev.clientY - rect.top) / rect.height : (ev.clientX - rect.left) / rect.width;
      r = Math.max(0.12, Math.min(0.88, r));
      node.ratio = r; a.style.flex = r + ' 1 0'; b.style.flex = (1 - r) + ' 1 0';
    };
    const up = ev => { div.releasePointerCapture(e.pointerId); div.removeEventListener('pointermove', move); div.removeEventListener('pointerup', up); saveWS(); };
    div.addEventListener('pointermove', move); div.addEventListener('pointerup', up);
  });
}

// ── докинг вкладок (drag&drop) ──────────────────────────────────────────────
let DRAG = null;   // id перетаскиваемой вкладки
function zoneAt(body, ev){
  const r = body.getBoundingClientRect();
  const x = (ev.clientX - r.left) / r.width, y = (ev.clientY - r.top) / r.height;
  const d = { left: x, right: 1 - x, top: y, bottom: 1 - y };
  let min = 'center', mv = 0.28;   // порог краевой зоны
  for (const k of ['left','right','top','bottom']) if (d[k] < mv){ mv = d[k]; min = k; }
  return min;
}
function wireDrop(body, dz, leaf){
  body.addEventListener('dragover', e => {
    if (!DRAG) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move';
    const z = zoneAt(body, e); dz.className = 'ws-dz on z-' + z;
  });
  body.addEventListener('dragleave', e => { if (!body.contains(e.relatedTarget)) dz.className = 'ws-dz'; });
  body.addEventListener('drop', e => {
    if (!DRAG) return; e.preventDefault(); const z = zoneAt(body, e); dz.className = 'ws-dz';
    dropTab(DRAG, leaf, z); DRAG = null;
  });
}
function dropTab(tid, targetLeaf, zone){
  const srcLeaf = leafOfTab(tid); if (!srcLeaf) return;
  if (zone === 'center'){
    if (srcLeaf === targetLeaf) return;   // в свою же группу — нет смысла
    moveTab(tid, srcLeaf, targetLeaf); saveWS(); renderWorkspace(true); return;
  }
  if (srcLeaf === targetLeaf && srcLeaf.tabs.length === 1) return;   // единственную вкладку расщеплять не во что
  const tab = takeTab(tid, srcLeaf);
  const dir = (zone === 'left' || zone === 'right') ? 'row' : 'col';
  const newLeaf = { t:'leaf', id: leafId(), tabs: [tab], active: 0 };
  const sideAisNew = (zone === 'left' || zone === 'top');
  const split = { t:'split', dir, ratio: 0.5, a: sideAisNew ? newLeaf : targetLeaf, b: sideAisNew ? targetLeaf : newLeaf };
  replaceNode(targetLeaf, split);
  if (!srcLeaf.tabs.length) collapseLeaf(srcLeaf);
  WS.lastLeaf = newLeaf.id; saveWS(); renderWorkspace(true);
}
function takeTab(tid, leaf){ const i = leaf.tabs.findIndex(t=>t.id===tid); const [tab] = leaf.tabs.splice(i,1); if (leaf.active>=leaf.tabs.length) leaf.active=Math.max(0,leaf.tabs.length-1); return tab; }
function moveTab(tid, src, dst){ const tab = takeTab(tid, src); dst.tabs.push(tab); dst.active = dst.tabs.length-1; if (!src.tabs.length) collapseLeaf(src); }

// ── выбор существующей сессии ────────────────────────────────────────────────
function openSessionPicker(){
  let back = document.getElementById('wsPick');
  if (!back){ back = document.createElement('div'); back.id = 'wsPick'; back.className = 'deck-modal-back'; document.body.appendChild(back); back.addEventListener('click', e => { if (e.target === back) back.classList.remove('open'); }); }
  const openIds = new Set(); walk(WS.root, n => { if (n.t==='leaf') n.tabs.forEach(t => t.file && openIds.add(t.file)); });
  const list = (S.SESSIONS || []).filter(s => !openIds.has(s.file)).slice(0, 60)
    .map(s => `<div class="wsp-item" data-file="${esc(s.file)}" data-title="${esc(s.title||s.project||'сессия')}"><span class="wsp-t">${esc(s.title||'—')}</span><span class="wsp-s">${esc(s.project||'')}${s.wo?' · '+esc(s.wo):''}</span></div>`).join('');
  back.innerHTML = `<div class="deck-modal"><div class="dm-head"><span>Добавить сессию в воркспейс</span><button class="dm-x" type="button">✕</button></div>
    <div class="dm-body"><div class="ns-actions" style="margin:0 0 10px"><button class="ns-start" id="wspNew" type="button">Новая сессия…</button></div>
    <div class="wsp-list">${list || '<div class="wsp-empty">Нет других сессий</div>'}</div></div></div>`;
  back.querySelector('.dm-x').addEventListener('click', () => back.classList.remove('open'));
  back.querySelector('#wspNew').addEventListener('click', () => { back.classList.remove('open'); openNewSessionDialog({ target:'workspace' }); });
  back.querySelectorAll('.wsp-item').forEach(el => el.addEventListener('click', () => { back.classList.remove('open'); addWorkspaceSession({ kind:'file', file: el.dataset.file, title: el.dataset.title }); }));
  back.classList.add('open');
}

// ── сообщения из паней (iframe → родитель) ───────────────────────────────────
if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('message', e => {
  if (e.origin !== location.origin) return;
  const m = e.data; if (!m || typeof m !== 'object') return;
  if (m.type === 'deck-pane-file') onPaneFile(m.pane, m.file, m.title);
  else if (m.type === 'deck-pane-title') onPaneTitle(m.pane, m.title);
  else if (m.type === 'deck-pane-focus') onPaneFocus(m.pane);
});
function tabById(tid){ let r=null; walk(WS.root, n => { if (n.t==='leaf'){ const t=n.tabs.find(x=>x.id===tid); if (t) r=t; } }); return r; }
// Новая сессия обрела файл (первый промт создал .jsonl) → фиксируем в дереве и дескрипторе, чтобы перезаход iframe
// перецепился к реальной сессии, а карточка/вкладка знала файл. iframe НЕ перезагружаем — сессия в нём уже открыта.
function onPaneFile(tid, file, title){ const t = tabById(tid); if (!t) return; t.kind='file'; t.file=file; if (title) t.title=title; writeDesc(tid, { kind:'file', file, title: t.title }); saveWS(); updateTabTitle(tid); }
function onPaneTitle(tid, title){ const t = tabById(tid); if (!t || !title) return; t.title = title; const d = readDesc(tid) || {}; d.title = title; writeDesc(tid, d); saveWS(); updateTabTitle(tid); }
function onPaneFocus(tid){ const leaf = leafOfTab(tid); if (!leaf) return; if (WS.lastLeaf !== leaf.id){ WS.lastLeaf = leaf.id; saveWS(); markFocus(); } }
function updateTabTitle(tid){ const el = document.querySelector(`.ws-tab[data-tab="${cssq(tid)}"] .ws-tt`); if (el){ const t = tabById(tid); el.textContent = t ? (t.title||'сессия') : ''; } }

loadWS();
