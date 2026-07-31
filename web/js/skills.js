// Deck — вкладка скиллов: каталог с сервера + фильтр по категории/поиску + рендер сетки карточек.
// Вынесено из app.js; состояние — в store (S). renderSkills зовёт openSession (app.js) в кнопке «вставить» —
// цикл app↔skills безопасен (вызовы в рантайме).
import { S } from './store.js';
import { esc } from './util.js';
import { toast } from './ui.js';
import { openSession } from './app.js';

const SCAT_LABEL = { user:'Пользователь', project:'Проект', 'прочее':'Прочее' };
export async function loadSkillsCatalog(){
  try { const r = await fetch('/api/skills', { cache:'no-store' }); const d = await r.json(); S.SKILLS = Array.isArray(d.skills) ? d.skills : []; }
  catch { S.SKILLS = []; }
  S.skillsLoaded = true;
  if (S.activeView === 'skills') renderSkills();
}
function skillMatch(sk){
  if (S.skillCat !== 'all' && sk.cat !== S.skillCat) return false;
  if (S.query && !((sk.cmd||'') + ' ' + (sk.does||'') + ' ' + (sk.trig||'')).toLowerCase().includes(S.query)) return false;
  return true;
}
function skillCats(){   // категории строятся динамически из того, что реально пришло
  const counts = {};
  for (const s of S.SKILLS){ const c = s.cat || 'прочее'; counts[c] = (counts[c]||0) + 1; }
  const keys = Object.keys(counts).sort((a,b)=>counts[b]-counts[a] || a.localeCompare(b));
  return [{ key:'all', label:'Все скиллы' }].concat(keys.map(k=>({ key:k, label: SCAT_LABEL[k] || k })));
}
export function renderSkills(){
  if (!S.skillsLoaded){ loadSkillsCatalog(); }
  const cats = skillCats();
  const rail = document.getElementById('rail');
  rail.innerHTML = `<div class="rail-label">Категории</div>` + cats.map(c => {
    const n = c.key==='all' ? S.SKILLS.length : S.SKILLS.filter(s=>(s.cat||'прочее')===c.key).length;
    return `<button class="cat" data-c="${esc(c.key)}" aria-pressed="${c.key===S.skillCat}">${esc(c.label)}<span class="c-count">${n}</span></button>`;
  }).join('');
  rail.querySelectorAll('.cat').forEach(b => b.addEventListener('click', () => { S.skillCat = b.dataset.c; renderSkills(); }));
  const grid = document.getElementById('skillsGrid');
  const items = S.SKILLS.filter(skillMatch);
  const catLabel = k => { const c = cats.find(x=>x.key===k); return c ? c.label : (SCAT_LABEL[k]||k); };
  if (!S.skillsLoaded){ grid.innerHTML = `<div class="empty">Загрузка скиллов…</div>`; return; }
  grid.innerHTML = items.length ? items.map((s,i)=>`
    <div class="skill-card" style="animation-delay:${i*25}ms">
      <div class="skill-head"><span class="skill-cmd-tag">/${esc(s.cmd)}</span><span class="skill-cat-chip">${esc(catLabel(s.cat||'прочее'))}</span></div>
      <div class="skill-does">${esc(s.does||'')}</div>
      ${s.trig?`<div class="skill-trig"><b>когда зовётся</b>${esc(s.trig)}</div>`:''}
      <div class="skill-foot"><button class="skill-run" data-cmd="${esc(s.cmd)}"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M7 5v14l12-7z"/></svg> вставить /${esc(s.cmd)}</button></div>
    </div>`).join('') : `<div class="empty">${S.SKILLS.length?'Ничего не найдено':'Скиллы не найдены'}</div>`;
  grid.querySelectorAll('.skill-run').forEach(b => b.addEventListener('click', async () => {
    const cmd = '/' + b.dataset.cmd;
    if (S.currentFile){
      await openSession(S.currentFile);                       // переключаемся в сессию — композер становится видимым
      const ta = document.getElementById('composer-ta');
      if (ta){ ta.value = cmd + ' '; ta.dispatchEvent(new Event('input')); ta.focus(); }   // input → включает кнопку отправки/ресайз
      toast('Вставлено в композер: ' + cmd);
    } else if (navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(cmd).then(()=>toast('Скопировано: ' + cmd)).catch(()=>toast('Не удалось скопировать'));
    } else { toast('Открой сессию, чтобы вставить ' + cmd); }
  }));
}
