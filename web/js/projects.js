// Deck — переключатель проектов (workspaces): «Открыть папку», выбор/добавление/удаление; доску скоупит сервер.
// Вынесено из app.js; состояние — в store (S). load() остаётся в app.js — импортируется сюда для перезагрузки доски.
import { S } from './store.js';
import { esc } from './util.js';
import { toast } from './ui.js';
import { MR_TTL_RESET } from './services.js';
import { load } from './app.js';

export const activeProjectPath = () => { const p = S.PROJECTS.find(x => x.id === S.ACTIVE_PROJECT); return p ? p.path : ''; };

export function renderProjSwitch(){
  const nameEl = document.getElementById('projName'); if (!nameEl) return;
  const active = S.PROJECTS.find((p) => p.id === S.ACTIVE_PROJECT);
  nameEl.textContent = active ? active.name : 'Все проекты';
}
export function toggleProjMenu(){
  const menu = document.getElementById('projMenu'); if (!menu) return;
  if (!menu.hidden){ menu.hidden = true; return; }
  const rows = [`<div class="pm-item${S.ACTIVE_PROJECT ? '' : ' active'}" data-id=""><span class="pm-main"><span class="pm-name">Все проекты</span></span></div>`];
  for (const p of S.PROJECTS) rows.push(`<div class="pm-item${p.id === S.ACTIVE_PROJECT ? ' active' : ''}" data-id="${esc(p.id)}"><span class="pm-main"><span class="pm-name">${esc(p.name)}</span><span class="pm-path">${esc(p.path)}</span></span><button class="pm-x" data-rm="${esc(p.id)}" title="Убрать из списка">✕</button></div>`);
  rows.push('<div class="pm-sep"></div><div class="pm-item pm-add" data-add="1"><span class="pm-main"><span class="pm-name">＋ Открыть папку…</span></span></div>');
  menu.innerHTML = rows.join('');
  menu.hidden = false;
  menu.querySelectorAll('.pm-item').forEach((el) => el.addEventListener('click', (e) => {
    if (e.target.closest('.pm-x')) return;
    menu.hidden = true;
    if (el.dataset.add) addProject(); else switchProject(el.dataset.id || '');
  }));
  menu.querySelectorAll('.pm-x').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); removeProject(b.dataset.rm); }));
}
async function switchProject(id){
  if (id === S.ACTIVE_PROJECT) return;
  try { await fetch('/api/projects', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'select', id }) }); } catch {}
  S.ACTIVE_PROJECT = id; MR_TTL_RESET(); renderProjSwitch();
  await load();   // сервер отдаст сессии уже скоупнутые на активный проект
}
async function addProject(){
  if (!(window.deckNative && window.deckNative.pickPath)){ toast('Открытие папки доступно только в приложении'); return; }
  let r; try { r = await window.deckNative.pickPath({ title:'Открыть папку проекта' }); } catch { return; }
  if (!r || !r.ok || !r.path) return;
  let d; try { d = await (await fetch('/api/projects', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'add', path: r.path }) })).json(); } catch { toast('Не удалось добавить папку'); return; }
  S.PROJECTS = d.projects || []; S.ACTIVE_PROJECT = d.activeId || ''; MR_TTL_RESET(); renderProjSwitch(); await load();
}
async function removeProject(id){
  let d; try { d = await (await fetch('/api/projects', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'remove', id }) })).json(); } catch { return; }
  S.PROJECTS = d.projects || []; S.ACTIVE_PROJECT = d.activeId || ''; renderProjSwitch();
  const menu = document.getElementById('projMenu'); if (menu){ menu.hidden = true; toggleProjMenu(); }   // перерисовать открытое меню
  await load();
}

document.addEventListener('mousedown', e => { if (!e.target.closest('#projSwitch')){ const m = document.getElementById('projMenu'); if (m) m.hidden = true; } });   // меню проектов — клик-вне закрывает
