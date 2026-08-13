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
//
// КЛЮЧЕВОЕ: iframe'ы НЕ живут внутри узлов дерева. Перемещение iframe в DOM (перенос в другого родителя при
// перестройке дерева) браузер трактует как перезагрузку — стрим рвётся, скрины из памяти композера теряются. Поэтому
// iframe'ы держим в ОТДЕЛЬНОМ постоянном слое (.ws-frame-layer), который при перестройке не трогается, и позиционируем
// их абсолютно поверх «тела» соответствующего листа (.ws-body). Структуру (таб-бары, сплиттеры, зоны докинга) можно
// перестраивать сколько угодно — iframe'ы не переносятся, значит не перезагружаются.

import { S, SESSION_CACHE } from './store.js';
import { esc } from './util.js';
import { openNewSessionDialog } from './dialogs.js';
import { setView } from './nav.js';
import { notifyDone, notifyInput } from './notify.js';

const WS_KEY = 'deckWorkspace';
const PANE_PREFIX = 'deckPane:';

// Дерево лейаута + последняя сфокусированная группа (в неё падает следующая открытая сессия).
let WS = { root: null, lastLeaf: null };
let seq = 1;
let layer = null;              // постоянный слой iframe'ов (не пересоздаётся при перестройке дерева)
let dragOv = null;             // прозрачный оверлей поверх iframe'ов на время drag: ловит dragover/drop (iframe'ы их
                               // «съедают») и рисует подсветку зоны; сами пани при этом ВИДНЫ (не гасим их в чёрное)
let CUR_TARGET = null;         // {leafId, zone} под курсором во время drag
const mounted = new Set();     // id вкладок, для которых iframe создан
const RO = (typeof ResizeObserver !== 'undefined') ? new ResizeObserver(() => layoutFrames()) : { observe(){}, disconnect(){} };

function loadWS(){
  try { const d = JSON.parse(localStorage.getItem(WS_KEY) || 'null'); if (d && typeof d === 'object'){ WS = { root: d.root || null, lastLeaf: d.lastLeaf || null }; } } catch {}
  // восстановить счётчик id выше всех сохранённых, чтобы новые id не коллизились
  let max = 0; walk(WS.root, n => { const m = String(n.id||'').match(/(\d+)$/); if (m) max = Math.max(max, +m[1]); if (n.t==='leaf') n.tabs.forEach(t=>{ const mm=String(t.id||'').match(/(\d+)$/); if (mm) max=Math.max(max,+mm[1]); }); });
  seq = max + 1;
  removeDuplicateTabs();   // подчистить сохранённые дубли одной сессии (могли накопиться до фикса дедупа)
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
function tabById(tid){ let r = null; walk(WS.root, n => { if (n.t==='leaf'){ const t = n.tabs.find(x=>x.id===tid); if (t) r = t; } }); return r; }
function tabByFile(file){ let r = null; walk(WS.root, n => { if (n.t==='leaf'){ const i = n.tabs.findIndex(t => t.file === file); if (i >= 0) r = { leaf:n, i }; } }); return r; }
function titleForTab(file){ const hit = tabByFile(file); if (hit) return hit.leaf.tabs[hit.i].title || ''; const s = (S.SESSIONS || []).find(x => x.file === file); return (s && s.title) || ''; }
// Родительский сплит узла + сторона ('a'|'b'); null для корня.
function parentOf(target){ let res = null; walk(WS.root, n => { if (n.t==='split'){ if (n.a===target) res={ split:n, side:'a' }; else if (n.b===target) res={ split:n, side:'b' }; } }); return res; }
function firstLeaf(node){ if (!node) return null; if (node.t==='leaf') return node; return firstLeaf(node.a) || firstLeaf(node.b); }
function replaceNode(oldNode, newNode){ if (WS.root === oldNode){ WS.root = newNode; return; } const p = parentOf(oldNode); if (p) p.split[p.side] = newNode; }

// Убрать лист из дерева: сплит-родитель схлопывается в сестринский узел.
function collapseLeaf(leaf){
  if (WS.root === leaf){ WS.root = null; WS.lastLeaf = null; return; }
  const p = parentOf(leaf); if (!p) return;
  const sib = p.side === 'a' ? p.split.b : p.split.a;
  replaceNode(p.split, sib);
  if (WS.lastLeaf === leaf.id) WS.lastLeaf = (firstLeaf(sib) || {}).id || null;
}

// Убрать дубли одной сессии: если один файл открыт в нескольких вкладках, оставляем первую, остальные закрываем.
// Возвращает true, если что-то удалили. Layer/DOM могут ещё не существовать (зов на loadWS) — тогда чистим только модель.
function removeDuplicateTabs(){
  const seen = new Set(); const dupes = [];
  walk(WS.root, n => { if (n.t === 'leaf') n.tabs.forEach(t => { if (t.file){ if (seen.has(t.file)) dupes.push(t.id); else seen.add(t.file); } }); });
  if (!dupes.length) return false;
  for (const id of dupes){
    const leaf = leafOfTab(id); if (leaf){ const i = leaf.tabs.findIndex(t => t.id === id); if (i >= 0){ leaf.tabs.splice(i, 1); if (leaf.active >= leaf.tabs.length) leaf.active = Math.max(0, leaf.tabs.length - 1); if (!leaf.tabs.length) collapseLeaf(leaf); } }
    delDesc(id); mounted.delete(id);
    const f = layer && layer.querySelector(`.ws-frame[data-tab="${cssq(id)}"]`); if (f) f.remove();
  }
  saveWS();
  return true;
}

// ── добавление / открытие сессии ────────────────────────────────────────────
// Открыть сессию в воркспейсе. desc — дескриптор пани: {kind:'file',file,title} для существующей сессии либо
// {kind:'new',cwd,name,mode,model,effort,prompt?,forkFile?,title} для новой (prompt задан → сразу запуск скилла).
export function addWorkspaceSession(desc){
  if (desc.kind === 'file' && desc.file){   // уже открыта такой же сессией → фокус на неё, не плодим дубль
    const hit = tabByFile(desc.file);
    if (hit){ WS.lastLeaf = hit.leaf.id; saveWS(); gotoWorkspace(); activate(hit.leaf, hit.i); return; }
  }
  const id = tabId();
  const tab = { id, kind: desc.kind, file: desc.file || '', title: desc.title || desc.name || 'сессия' };
  writeDesc(id, descForIframe(desc));
  let leaf = WS.lastLeaf ? findLeaf(WS.lastLeaf) : null;
  if (!leaf) leaf = firstLeaf(WS.root);
  if (!leaf){ leaf = { t:'leaf', id: leafId(), tabs: [], active: 0 }; WS.root = leaf; }
  leaf.tabs.push(tab);
  leaf.active = leaf.tabs.length - 1;
  WS.lastLeaf = leaf.id;
  saveWS();
  gotoWorkspace();   // переключение на вкладку воркспейса перерисует структуру (nav.setView → renderWorkspace)
}
function descForIframe(desc){
  if (desc.kind === 'file') return { kind:'file', file: desc.file, title: desc.title || '' };
  return { kind:'new', cwd: desc.cwd, name: desc.name || '', mode: desc.mode || 'default', model: desc.model || '', effort: desc.effort || '', prompt: desc.prompt || '', forkFile: desc.forkFile || '', title: desc.title || desc.name || '' };
}

// Открыть СУЩЕСТВУЮЩУЮ сессию в воркспейсе (единая точка для карточек/палитры/уведомлений верхнего окна). Уже открытую —
// активируем, иначе добавляем в последнюю группу. Дубликатов одной сессии не плодим.
export function openWorkspaceForFile(file, title){
  if (!file) return;
  const hit = tabByFile(file);
  if (hit){ WS.lastLeaf = hit.leaf.id; saveWS(); gotoWorkspace(); activate(hit.leaf, hit.i); return; }
  const s = (S.SESSIONS || []).find(x => x.file === file);
  addWorkspaceSession({ kind:'file', file, title: title || (s && s.title) || 'сессия' });
}

function gotoWorkspace(){ setView('workspace'); }   // напрямую, не через симуляцию клика по вкладке — надёжнее

// Закрыть все вкладки, указывающие на файл (сессия удалена). Зовётся из диалога удаления верхнего окна и по сообщению
// от пани (удаление из бокового рейла внутри iframe).
export function closeWorkspaceTabsForFile(file){
  if (!file) return;
  let changed = false, hit;
  while ((hit = tabByFile(file))){
    const leaf = hit.leaf, id = leaf.tabs[hit.i].id;
    leaf.tabs.splice(hit.i, 1); delDesc(id); mounted.delete(id);
    const f = layer && layer.querySelector(`.ws-frame[data-tab="${cssq(id)}"]`); if (f) f.remove();
    if (!leaf.tabs.length) collapseLeaf(leaf); else if (leaf.active >= leaf.tabs.length) leaf.active = leaf.tabs.length - 1;
    changed = true;
  }
  if (changed){ saveWS(); renderWorkspace(); }
}

// ── рендер: структура (перестраиваемая) + слой iframe'ов (постоянный) ─────────
export function renderWorkspace(){
  const host = document.getElementById('viewWorkspace'); if (!host) return;
  host.style.position = 'relative';
  if (!WS.root || !firstLeaf(WS.root)){
    RO.disconnect(); if (layer){ layer.remove(); layer = null; } mounted.clear();
    host.innerHTML = ''; host.appendChild(emptyState()); return;
  }
  ensureLayer(host);
  const old = host.querySelector('.ws-structure'); if (old) old.remove();
  const struct = document.createElement('div'); struct.className = 'ws-structure';
  struct.appendChild(renderNode(WS.root));
  host.insertBefore(struct, layer);   // структура под слоем iframe'ов
  RO.disconnect(); host.querySelectorAll('.ws-body').forEach(b => RO.observe(b));
  // Синхронно (getBoundingClientRect форсит рефлоу — вид уже display:flex) + rAF-подстраховка на случай, если размеры
  // ещё не устаканились после смены display. Без синхронного вызова новая вкладка иногда не появлялась до ресайза.
  layoutFrames();
  if (typeof requestAnimationFrame !== 'undefined') requestAnimationFrame(layoutFrames);
}
function ensureLayer(host){
  if (!(layer && host.contains(layer))){ layer = document.createElement('div'); layer.className = 'ws-frame-layer'; host.appendChild(layer); }
  if (!(dragOv && host.contains(dragOv))){ dragOv = document.createElement('div'); dragOv.className = 'ws-dragover'; dragOv.innerHTML = '<i class="ws-dz-hi"></i>'; host.appendChild(dragOv); }   // оверлей — только визуальная подсветка зон; drag ведут pointer-события вкладки (updateDropTarget/performDrop)
  // «+ Новая сессия» — ВСЕГДА видна в воркспейсе (глобальная кнопка в now-баре живёт в #viewBoard, который в этом виде скрыт).
  if (!host.querySelector('.ws-newbtn')){ const nb = document.createElement('button'); nb.className = 'ws-newbtn'; nb.type = 'button'; nb.title = 'Новая сессия'; nb.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M12 5v14M5 12h14"/></svg><span>Новая сессия</span>'; nb.addEventListener('click', () => openNewSessionDialog({ target:'workspace' })); host.appendChild(nb); }
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
  tb.className = 'ws-tab'; tb.dataset.tab = t.id;
  tb.innerHTML = `<span class="ws-tt">${esc(t.title || 'сессия')}</span><button class="ws-tx" title="Закрыть">✕</button>`;
  tb.querySelector('.ws-tx').addEventListener('click', e => { e.stopPropagation(); closeTab(leaf, t.id); });
  // Перетаскивание — на pointer-событиях с setPointerCapture, а НЕ нативный HTML5 draggable: воркспейс состоит из
  // iframe'ов панелей, а нативный DnD над iframe в Electron/Chromium теряет события — drag «не стартует» / срывается
  // при заходе на панель. Захват указателя (как у сплиттера-дивайдера) доводит pointermove даже поверх iframe'ов.
  tb.addEventListener('pointerdown', e => {
    if (e.button !== 0 || (e.target.closest && e.target.closest('.ws-tx'))) return;   // не левый клик / крестик — не drag
    const sx = e.clientX, sy = e.clientY; let dragging = false; let ghost = null;
    try { tb.setPointerCapture(e.pointerId); } catch {}
    const onMove = ev => {
      if (!dragging){ if (Math.abs(ev.clientX - sx) < 5 && Math.abs(ev.clientY - sy) < 5) return; dragging = true; DRAG = t.id; showDragOverlay(); tb.classList.add('ws-tab-dragging'); ghost = makeDragGhost(t.title || 'сессия'); }   // порог, чтобы клик не превращался в drag
      if (ghost){ ghost.style.left = ev.clientX + 'px'; ghost.style.top = ev.clientY + 'px'; }   // «призрак» вкладки летит за курсором — наглядность перетаскивания
      updateDropTarget(ev.clientX, ev.clientY);
    };
    const onUp = () => {
      tb.removeEventListener('pointermove', onMove); tb.removeEventListener('pointerup', onUp); tb.removeEventListener('pointercancel', onUp);
      try { tb.releasePointerCapture(e.pointerId); } catch {}
      if (ghost) ghost.remove(); tb.classList.remove('ws-tab-dragging');
      if (dragging) performDrop();
      else activate(leaf, leaf.tabs.findIndex(x => x.id === t.id));   // без сдвига — это обычный клик: активируем вкладку
    };
    tb.addEventListener('pointermove', onMove); tb.addEventListener('pointerup', onUp); tb.addEventListener('pointercancel', onUp);
  });
  return tb;
}

function renderLeaf(leaf){
  const el = document.createElement('div');
  el.className = 'ws-leaf' + (WS.lastLeaf === leaf.id ? ' focus' : '');
  el.dataset.leaf = leaf.id;
  const bar = document.createElement('div'); bar.className = 'ws-tabs';
  leaf.tabs.forEach((t, i) => { const tb = makeTabButton(leaf, t); tb.classList.toggle('on', i === leaf.active); bar.appendChild(tb); });
  const add = document.createElement('button'); add.className = 'ws-add'; add.title = 'Добавить сессию в группу'; add.textContent = '+';
  add.addEventListener('click', () => { WS.lastLeaf = leaf.id; openSessionPicker(); });
  bar.appendChild(add);
  const body = document.createElement('div'); body.className = 'ws-body'; body.dataset.leaf = leaf.id;   // цель для позиционирования iframe активной вкладки
  el.append(bar, body);
  el.addEventListener('mousedown', () => { if (WS.lastLeaf !== leaf.id){ WS.lastLeaf = leaf.id; saveWS(); markFocus(); } }, true);
  return el;
}

// Позиционировать iframe активной вкладки каждого листа поверх его .ws-body; неактивные — спрятать. iframe'ы не
// переносятся в DOM (живут в слое), поэтому не перезагружаются ни при перестройке дерева, ни при ресайзе.
function layoutFrames(){
  const host = document.getElementById('viewWorkspace'); if (!host || !layer) return;
  const hr = host.getBoundingClientRect(); const active = new Set();
  host.querySelectorAll('.ws-body').forEach(body => {
    const leaf = findLeaf(body.dataset.leaf); if (!leaf || !leaf.tabs.length) return;
    const tab = leaf.tabs[leaf.active]; if (!tab) return;
    const f = ensureFrame(tab.id); active.add(tab.id);
    const r = body.getBoundingClientRect();
    f.style.display = 'block';
    f.style.left = (r.left - hr.left) + 'px'; f.style.top = (r.top - hr.top) + 'px';
    f.style.width = r.width + 'px'; f.style.height = r.height + 'px';
  });
  layer.querySelectorAll('.ws-frame').forEach(f => { if (!active.has(f.dataset.tab)) f.style.display = 'none'; });
}
function ensureFrame(tid){
  let f = layer.querySelector(`.ws-frame[data-tab="${cssq(tid)}"]`); if (f) return f;
  f = document.createElement('iframe'); f.className = 'ws-frame'; f.dataset.tab = tid; f.src = '/?pane=' + encodeURIComponent(tid);
  f.setAttribute('allow', 'clipboard-read; clipboard-write');
  layer.appendChild(f); mounted.add(tid); return f;
}
const cssq = s => String(s).replace(/["\\]/g, '\\$&');

function activate(leaf, i){
  leaf.active = i; WS.lastLeaf = leaf.id; saveWS();
  const leafEl = document.querySelector(`.ws-leaf[data-leaf="${cssq(leaf.id)}"]`);
  if (leafEl) leafEl.querySelectorAll('.ws-tab').forEach((el, j) => el.classList.toggle('on', j === i));
  layoutFrames(); markFocus();
}
function markFocus(){ document.querySelectorAll('.ws-leaf').forEach(el => el.classList.toggle('focus', el.dataset.leaf === WS.lastLeaf)); }

function closeTab(leaf, tid){
  const i = leaf.tabs.findIndex(t => t.id === tid); if (i < 0) return;
  leaf.tabs.splice(i, 1);
  delDesc(tid); mounted.delete(tid);
  const f = layer && layer.querySelector(`.ws-frame[data-tab="${cssq(tid)}"]`); if (f) f.remove();
  if (!leaf.tabs.length) collapseLeaf(leaf);
  else if (leaf.active >= leaf.tabs.length) leaf.active = leaf.tabs.length - 1;
  saveWS(); renderWorkspace();   // структуру пересобираем, но живые iframe'ы соседей в слое не трогаем → без reload
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
      layoutFrames();   // двигаем iframe'ы вслед за ячейками
    };
    const up = () => { div.releasePointerCapture(e.pointerId); div.removeEventListener('pointermove', move); div.removeEventListener('pointerup', up); saveWS(); };
    div.addEventListener('pointermove', move); div.addEventListener('pointerup', up);
  });
}

// ── докинг вкладок (drag&drop) через прозрачный оверлей ──────────────────────
let DRAG = null;   // id перетаскиваемой вкладки
// «Призрак» перетаскиваемой вкладки — плавающий ярлык под курсором (pointer-events:none, чтобы не мешать hit-тесту).
function makeDragGhost(title){ const g = document.createElement('div'); g.className = 'ws-drag-ghost'; g.textContent = title; document.body.appendChild(g); return g; }
function showDragOverlay(){ if (dragOv){ dragOv.classList.add('on'); } }
function hideDragOverlay(){ if (dragOv){ dragOv.classList.remove('on'); const hi = dragOv.querySelector('.ws-dz-hi'); if (hi) hi.style.display = 'none'; } CUR_TARGET = null; }

// Лист под курсором (оверлей перехватывает события, поэтому ищем по прямоугольникам, а не elementFromPoint).
function leafElAt(x, y){
  const els = document.querySelectorAll('#viewWorkspace .ws-leaf');
  for (const el of els){ const r = el.getBoundingClientRect(); if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return el; }
  return null;
}
// Зона докинга по листу: над таб-баром или в центре тела → 'center' (вложить вкладкой в группу); у краёв тела → сплит.
function zoneForLeaf(leafEl, x, y){
  const body = leafEl.querySelector('.ws-body'); const br = body.getBoundingClientRect();
  if (y < br.top || br.width <= 0 || br.height <= 0) return 'center';   // курсор над таб-баром → вложить в группу
  const fx = (x - br.left) / br.width, fy = (y - br.top) / br.height;
  const d = { left: fx, right: 1 - fx, top: fy, bottom: 1 - fy };
  let z = 'center', mv = 0.28;
  for (const k of ['left','right','top','bottom']) if (d[k] < mv){ mv = d[k]; z = k; }
  return z;
}
// Позиция вставки в таб-баре листа под курсором (переупорядочивание внутри группы / точное вложение в чужую группу).
// null — курсор не над таб-баром. index — куда вставить (по серединам существующих вкладок); markX — экранная X линии-курсора.
function tabBarTarget(leafEl, x, y){
  const bar = leafEl.querySelector('.ws-tabs'); if (!bar) return null;
  const br = bar.getBoundingClientRect();
  if (x < br.left || x > br.right || y < br.top || y > br.bottom) return null;
  const tabs = [...bar.querySelectorAll('.ws-tab')];
  let index = tabs.length, markX = br.left + 4;
  for (let i = 0; i < tabs.length; i++){ const r = tabs[i].getBoundingClientRect(); if (x < r.left + r.width / 2){ index = i; markX = r.left; break; } }
  if (index >= tabs.length && tabs.length){ markX = tabs[tabs.length - 1].getBoundingClientRect().right; }
  return { leafId: leafEl.dataset.leaf, index, barTop: br.top, barH: br.height, markX };
}
// Пересчёт цели дропа + подсветки под курсором (дёргается pointermove'ом перетаскиваемой вкладки).
function updateDropTarget(x, y){
  const host = document.getElementById('viewWorkspace'); if (!host || !dragOv) return;
  const hr = host.getBoundingClientRect();
  const leafEl = leafElAt(x, y); const hi = dragOv.querySelector('.ws-dz-hi');
  if (!leafEl){ CUR_TARGET = null; if (hi) hi.style.display = 'none'; return; }
  // Курсор над таб-баром → вставка МЕЖДУ вкладками (реордер/вложение в позицию), а не грубый «center» в конец.
  const tabT = tabBarTarget(leafEl, x, y);
  if (tabT){
    CUR_TARGET = { leafId: tabT.leafId, tabIndex: tabT.index };
    if (hi){ hi.style.display = 'block'; hi.style.left = (tabT.markX - hr.left - 1) + 'px'; hi.style.top = (tabT.barTop - hr.top) + 'px'; hi.style.width = '3px'; hi.style.height = tabT.barH + 'px'; }
    return;
  }
  const zone = zoneForLeaf(leafEl, x, y);
  CUR_TARGET = { leafId: leafEl.dataset.leaf, zone };
  const lr = leafEl.getBoundingClientRect(); const br = leafEl.querySelector('.ws-body').getBoundingClientRect();
  let box;
  if (zone === 'center') box = { left: lr.left, top: lr.top, width: lr.width, height: lr.height };
  else if (zone === 'left') box = { left: br.left, top: br.top, width: br.width / 2, height: br.height };
  else if (zone === 'right') box = { left: br.left + br.width / 2, top: br.top, width: br.width / 2, height: br.height };
  else if (zone === 'top') box = { left: br.left, top: br.top, width: br.width, height: br.height / 2 };
  else box = { left: br.left, top: br.top + br.height / 2, width: br.width, height: br.height / 2 };
  if (hi){ hi.style.display = 'block'; hi.style.left = (box.left - hr.left) + 'px'; hi.style.top = (box.top - hr.top) + 'px'; hi.style.width = box.width + 'px'; hi.style.height = box.height + 'px'; }
}
function performDrop(){
  const tgt = CUR_TARGET, id = DRAG; hideDragOverlay(); DRAG = null;
  if (!tgt || !id) return;
  const leaf = findLeaf(tgt.leafId); if (!leaf) return;
  if (typeof tgt.tabIndex === 'number') reorderTab(id, leaf, tgt.tabIndex); else dropTab(id, leaf, tgt.zone);
}
// Вставка вкладки в конкретную позицию таб-бара: тот же лист → переупорядочивание; чужой лист → вложение в позицию.
function reorderTab(tid, targetLeaf, index){
  const srcLeaf = leafOfTab(tid); if (!srcLeaf) return;
  if (srcLeaf === targetLeaf){
    const from = srcLeaf.tabs.findIndex(t => t.id === tid); if (from < 0) return;
    let to = index; if (to > from) to--;                        // после изъятия индекс правее сдвигается на 1
    to = Math.max(0, Math.min(to, srcLeaf.tabs.length - 1));
    if (to === from) return;                                    // позиция не изменилась — ничего не делаем (без лишнего ре-рендера)
    const [tab] = srcLeaf.tabs.splice(from, 1);
    srcLeaf.tabs.splice(to, 0, tab);
    srcLeaf.active = to;
    saveWS(); renderWorkspace(); return;
  }
  const tab = takeTab(tid, srcLeaf);
  const to = Math.max(0, Math.min(index, targetLeaf.tabs.length));
  targetLeaf.tabs.splice(to, 0, tab);
  targetLeaf.active = to;
  if (!srcLeaf.tabs.length) collapseLeaf(srcLeaf);
  WS.lastLeaf = targetLeaf.id; saveWS(); renderWorkspace();
}
function dropTab(tid, targetLeaf, zone){
  const srcLeaf = leafOfTab(tid); if (!srcLeaf) return;
  if (zone === 'center'){
    if (srcLeaf === targetLeaf) return;
    moveTab(tid, srcLeaf, targetLeaf); saveWS(); renderWorkspace(); return;
  }
  if (srcLeaf === targetLeaf && srcLeaf.tabs.length === 1) return;   // единственную вкладку расщеплять не во что
  const tab = takeTab(tid, srcLeaf);
  const dir = (zone === 'left' || zone === 'right') ? 'row' : 'col';
  const newLeaf = { t:'leaf', id: leafId(), tabs: [tab], active: 0 };
  const sideAisNew = (zone === 'left' || zone === 'top');
  const split = { t:'split', dir, ratio: 0.5, a: sideAisNew ? newLeaf : targetLeaf, b: sideAisNew ? targetLeaf : newLeaf };
  replaceNode(targetLeaf, split);
  if (!srcLeaf.tabs.length) collapseLeaf(srcLeaf);
  WS.lastLeaf = newLeaf.id; saveWS(); renderWorkspace();
}
function takeTab(tid, leaf){ const i = leaf.tabs.findIndex(t=>t.id===tid); const [tab] = leaf.tabs.splice(i,1); if (leaf.active>=leaf.tabs.length) leaf.active=Math.max(0,leaf.tabs.length-1); return tab; }
function moveTab(tid, src, dst){ const tab = takeTab(tid, src); dst.tabs.push(tab); dst.active = dst.tabs.length-1; if (!src.tabs.length) collapseLeaf(src); }

// ── выбор существующей сессии ────────────────────────────────────────────────
function openSessionPicker(){
  let back = document.getElementById('wsPick');
  if (!back){ back = document.createElement('div'); back.id = 'wsPick'; back.className = 'deck-modal-back'; document.body.appendChild(back); back.addEventListener('click', e => { if (e.target === back) back.classList.remove('open'); }); }
  const openIds = new Set(); walk(WS.root, n => { if (n.t==='leaf') n.tabs.forEach(t => t.file && openIds.add(t.file)); });
  const avail = (S.SESSIONS || []).filter(s => !openIds.has(s.file));
  back.innerHTML = `<div class="deck-modal"><div class="dm-head"><span>Добавить сессию в воркспейс</span><button class="dm-x" type="button">✕</button></div>
    <div class="dm-body">
      <div class="ns-actions" style="margin:0 0 10px"><button class="ns-start" id="wspNew" type="button">Новая сессия…</button></div>
      <input id="wspSearch" class="ns-inp" type="text" placeholder="Поиск по названию / проекту / задаче…" autocomplete="off" spellcheck="false" style="margin:0 0 10px">
      <div class="wsp-list" id="wspList"></div>
    </div></div>`;
  const listEl = back.querySelector('#wspList');
  const paint = (q) => {
    q = (q || '').trim().toLowerCase();
    const items = avail.filter(s => !q || (`${s.title||''} ${s.project||''} ${s.wo||''} ${s.gitBranch||''}`).toLowerCase().includes(q)).slice(0, 80);
    listEl.innerHTML = items.length
      ? items.map(s => `<div class="wsp-item" data-file="${esc(s.file)}" data-title="${esc(s.title||s.project||'сессия')}"><span class="wsp-t">${esc(s.title||'—')}</span><span class="wsp-s">${esc(s.project||'')}${s.wo?' · '+esc(s.wo):''}</span></div>`).join('')
      : `<div class="wsp-empty">${avail.length ? 'Ничего не найдено' : 'Нет других сессий'}</div>`;
    listEl.querySelectorAll('.wsp-item').forEach(el => el.addEventListener('click', () => { back.classList.remove('open'); addWorkspaceSession({ kind:'file', file: el.dataset.file, title: el.dataset.title }); }));
  };
  paint('');
  const srch = back.querySelector('#wspSearch');
  srch.addEventListener('input', e => paint(e.target.value));
  back.querySelector('.dm-x').addEventListener('click', () => back.classList.remove('open'));
  back.querySelector('#wspNew').addEventListener('click', () => { back.classList.remove('open'); openNewSessionDialog({ target:'workspace' }); });
  back.classList.add('open');
  setTimeout(() => srch.focus(), 60);
}

// ── сообщения из паней (iframe → родитель) ───────────────────────────────────
if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('message', e => {
  if (e.origin !== location.origin) return;
  const m = e.data; if (!m || typeof m !== 'object') return;
  if (m.type === 'deck-pane-file') onPaneFile(m.pane, m.file, m.title);
  else if (m.type === 'deck-pane-title') onPaneTitle(m.pane, m.title);
  else if (m.type === 'deck-pane-focus') onPaneFocus(m.pane);
  else if (m.type === 'deck-pane-delete') closeWorkspaceTabsForFile(m.file);
  else if (m.type === 'deck-notify-done') notifyDone(m.file, m.title || titleForTab(m.file), m.heading);   // паня закончила ход → уведомление из верхнего окна (работает и в фоне)
  else if (m.type === 'deck-notify-input') notifyInput(m.file, m.id, m.title || titleForTab(m.file));       // паня ждёт ответа → уведомление
});
// Новая сессия обрела файл (первый промт создал .jsonl) → фиксируем в дереве и дескрипторе, чтобы перезаход iframe
// перецепился к реальной сессии. iframe НЕ перезагружаем — сессия в нём уже открыта.
function onPaneFile(tid, file, title){
  const t = tabById(tid); if (!t) return;
  t.kind = 'file'; t.file = file; if (title) t.title = title;
  writeDesc(tid, { kind: 'file', file, title: t.title }); saveWS(); updateTabTitle(tid);
  if (removeDuplicateTabs()) renderWorkspace();   // новая сессия резолвнулась в уже открытый файл → схлопнуть дубль
}
function onPaneTitle(tid, title){ const t = tabById(tid); if (!t || !title) return; t.title = title; const d = readDesc(tid) || {}; d.title = title; writeDesc(tid, d); saveWS(); updateTabTitle(tid); }
function onPaneFocus(tid){ const leaf = leafOfTab(tid); if (!leaf) return; if (WS.lastLeaf !== leaf.id){ WS.lastLeaf = leaf.id; saveWS(); markFocus(); } }
function updateTabTitle(tid){ const el = document.querySelector(`.ws-tab[data-tab="${cssq(tid)}"] .ws-tt`); if (el){ const t = tabById(tid); el.textContent = t ? (t.title||'сессия') : ''; } }

loadWS();
