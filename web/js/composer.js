// Deck — поле ввода сессии: автокомплит «/»-скиллов, поповер режима/модели/effort, вложения (пикер/drag/вставка),
// очередь промтов во время стрима и отправка. Состояние — в store (S); запуск стрима — через stream.runPrompt.
import { S, SKILLS_CACHE, attachDraft, promptQueue, MODE_ORDER, MODE_LABEL, ATTACH_MAX_BYTES } from './store.js';
import { esc } from './util.js';
import { toast } from './ui.js';
import { requireAuth } from './auth.js';
import { loadModelsCatalog } from './app.js';
import { appendHTML, blockHTML, attachThumbsHTML, scrollBottom } from './transcript.js';
import { userStop, runPrompt, setStreamStatus, ensureConsole } from './stream.js';

export async function loadSkills(cwd){
  S.SESSION_SKILLS = [];
  if (!cwd){ updateSlash(); return; }
  if (SKILLS_CACHE[cwd]){ S.SESSION_SKILLS = SKILLS_CACHE[cwd]; updateSlash(); return; }
  try {
    const r = await fetch('/api/skills?cwd=' + encodeURIComponent(cwd), { cache:'no-store' });
    const d = await r.json();
    S.SESSION_SKILLS = Array.isArray(d.skills) ? d.skills : [];
    SKILLS_CACHE[cwd] = S.SESSION_SKILLS;
  } catch (e) { S.SESSION_SKILLS = []; }
  updateSlash();   // если «/» уже введён (гонка загрузки — особенно в новой сессии) — перефильтровать дропдаун
}

function slashFilter(q){
  q = q.toLowerCase();
  return S.SESSION_SKILLS.filter(s => !q || s.name.toLowerCase().includes(q) || (s.description||'').toLowerCase().includes(q));
}

export function updateSlash(){
  const ta = document.getElementById('composer-ta');
  const box = document.getElementById('slashBox');
  if (!ta || !box) return;
  const v = ta.value;
  if (v[0] === '/' && !v.slice(1).includes(' ')) {
    S.slashItems = slashFilter(v.slice(1)).slice(0, 60);
    S.slashOpen = S.slashItems.length > 0;
    S.slashSel = 0;
    renderSlash();
  } else {
    S.slashOpen = false; box.hidden = true;
  }
}

export function renderSlash(){
  const box = document.getElementById('slashBox');
  if (!box) return;
  if (!S.slashOpen){ box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = S.slashItems.map((s,i)=>`<div class="cx-sl-item ${i===S.slashSel?'sel':''}" data-i="${i}"><span class="cx-sl-name">/${esc(s.name)}</span><span class="cx-sl-src">${esc(s.source)}</span><span class="cx-sl-desc">${esc((s.description||'').slice(0,110))}</span></div>`).join('');
  box.querySelectorAll('.cx-sl-item').forEach(el=>{
    el.addEventListener('mousedown', e => { e.preventDefault(); chooseSlash(+el.dataset.i); });
    el.addEventListener('mousemove', () => { S.slashSel = +el.dataset.i; highlightSlash(); });
  });
}

function highlightSlash(){
  document.querySelectorAll('.cx-sl-item').forEach((el,j)=>el.classList.toggle('sel', j===S.slashSel));
  const s = document.querySelector('.cx-sl-item.sel'); if (s) s.scrollIntoView({ block:'nearest' });
}

function chooseSlash(i){
  const s = S.slashItems[i]; if (!s) return;
  const ta = document.getElementById('composer-ta'); if (!ta) return;
  ta.value = '/' + s.name + ' ';
  S.slashOpen = false; const box = document.getElementById('slashBox'); if (box) box.hidden = true;
  ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight,150) + 'px';
  const btn = document.getElementById('sendBtn'); if (btn) btn.disabled = !ta.value.trim();
  ta.focus();
}

export function renderComposer(t){
  const c = document.getElementById('composer');
  const ICON = {
    attach:'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>',
    stop:'<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
    bolt:'<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 3 14h7l-1 8 10-12h-7z"/></svg>',
    send:'<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="m3 20 18-8L3 4v6l12 2-12 2z"/></svg>',
  };
  c.innerHTML = `
    <div class="archived-note" id="viewNote" style="max-width:820px;margin:0 auto 10px;display:none"><span></span></div>
    <div class="cx-slash" id="slashBox" hidden></div>
    <div class="composer-inner" id="composerInner">
      <div class="cx-attach" id="attachBox" hidden></div>
      <input type="file" id="attachInput" multiple hidden>
      <textarea id="composer-ta" rows="1" placeholder="Написать в сессию…  «/» — скиллы  ·  📎/вставка — файлы  ·  Enter — отправить"></textarea>
      <div class="composer-foot cx-foot">
        <div class="cx-foot-l">
          <button class="cx-ibtn" id="attachBtn" type="button" title="Прикрепить (скоро)">${ICON.attach}</button>
          <button class="cx-ibtn" id="skillBtn" type="button" title="Скиллы (/)">/</button>
          <button class="cx-ibtn" id="compactBtn" type="button" title="Сжать контекст сессии (/compact)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3v5H3M16 3v5h5M8 21v-5H3M16 21v-5h5"/></svg></button>
          <button class="cx-ibtn cx-stop" id="stopBtn" type="button" title="Остановить">${ICON.stop}</button>
          <span class="cx-queue" id="queueInd" hidden></span>
        </div>
        <div class="cx-foot-r">
          <div class="cx-modepop" id="modePop" hidden></div>
          <button class="cx-mode" id="modeBtn" type="button" title="Режим / модель / effort">${ICON.bolt}<span id="modeLabel">Обычный</span></button>
          <button class="send-btn" id="sendBtn" type="button" disabled>${ICON.send}</button>
        </div>
      </div>
    </div>`;
  const ta = document.getElementById('composer-ta'), btn = document.getElementById('sendBtn');
  const grow = () => { ta.style.height='auto'; ta.style.height=Math.min(ta.scrollHeight,150)+'px'; btn.disabled = !(ta.value.trim() || attachDraft.length); };
  ta.addEventListener('input', () => { grow(); updateSlash(); });
  ta.addEventListener('keydown', e => {
    if (S.slashOpen) {
      if (e.key==='ArrowDown'){ e.preventDefault(); S.slashSel=Math.min(S.slashSel+1, S.slashItems.length-1); highlightSlash(); return; }
      if (e.key==='ArrowUp'){ e.preventDefault(); S.slashSel=Math.max(S.slashSel-1, 0); highlightSlash(); return; }
      if (e.key==='Enter'){ e.preventDefault(); chooseSlash(S.slashSel); return; }
      if (e.key==='Escape'){ e.preventDefault(); S.slashOpen=false; document.getElementById('slashBox').hidden=true; return; }
    }
    if (e.key==='Tab' && e.shiftKey) { e.preventDefault(); cycleMode(); return; }   // как в расширении — циклим режим
    if (e.key==='Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  btn.addEventListener('click', sendMessage);
  const stopBtn = document.getElementById('stopBtn');
  stopBtn.disabled = !S.streaming;   // состояние Стоп = чистая функция от факта живого стрима (переживает перерисовку)
  stopBtn.addEventListener('click', userStop);
  document.getElementById('skillBtn').addEventListener('click', () => { if (S.streaming) return; if (ta.value[0] !== '/') ta.value = '/' + ta.value; ta.focus(); updateSlash(); });
  document.getElementById('compactBtn').addEventListener('click', () => {   // /compact — сжать контекст текущей сессии
    if (!S.currentFile || !requireAuth()) return;
    const payload = { text: '/compact', mode: S.sessionMode, model: S.sessionModel, effort: S.sessionEffort, attachments: [] };
    if (S.streaming){ enqueuePrompt(payload); toast('/compact добавлен в очередь'); return; }
    toast('Сжимаю контекст сессии…'); runPrompt(payload);
  });
  document.getElementById('modeBtn').addEventListener('click', toggleModePop);   // поповер: режим + модель + effort-ползунок
  // P4: вложения — пикер, drag-drop, вставка скриншота
  const fileInput = document.getElementById('attachInput');
  document.getElementById('attachBtn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { if (fileInput.files && fileInput.files.length) addAttachments([...fileInput.files]); fileInput.value = ''; });
  const inner = document.getElementById('composerInner');
  inner.addEventListener('dragover', e => { e.preventDefault(); inner.classList.add('cx-drop'); });
  inner.addEventListener('dragleave', () => inner.classList.remove('cx-drop'));
  inner.addEventListener('drop', e => { e.preventDefault(); inner.classList.remove('cx-drop'); if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) addAttachments([...e.dataTransfer.files]); });
  ta.addEventListener('paste', e => {
    const items = e.clipboardData && e.clipboardData.items ? [...e.clipboardData.items] : [];
    const files = items.filter(it => it.kind === 'file').map(it => it.getAsFile()).filter(Boolean);
    if (files.length){ e.preventDefault(); addAttachments(files); }   // скриншот из буфера — главный сценарий
  });
  paintMode();   // режим/модель/effort задаёт вызывающий (openSession сбрасывает на default; new/fork — выбранное в окне)
  if (!S.MODELS.length) loadModelsCatalog();   // данные для поповера «Режимы» (модели/эффорты подтягиваются)
  attachDraft.length = 0; renderAttachDraft();
  setTimeout(()=>ta.focus(), 60);
}

export function setComposerBusy(on){
  S.streaming = on;
  const ta = document.getElementById('composer-ta'), send = document.getElementById('sendBtn'),
        stop = document.getElementById('stopBtn');
  if (ta) ta.disabled = false;                          // ввод НЕ блокируем — можно подкидывать промты в очередь
  if (send) send.disabled = !((ta && ta.value.trim()) || attachDraft.length);   // текст ИЛИ вложения
  if (stop) stop.disabled = !on;
}

export function paintMode(){
  const btn = document.getElementById('modeBtn'); if (!btn) return;
  const lbl = btn.querySelector('#modeLabel'); if (lbl) lbl.textContent = MODE_LABEL[S.sessionMode] || 'Обычный';
  btn.classList.toggle('cx-mode-bypass', S.sessionMode === 'bypassPermissions');   // байпас — предупреждающе (красный)
  const extra = [];
  const mm = S.MODELS.find(m=>m.value===S.sessionModel); if (S.sessionModel && mm) extra.push(mm.label);
  const ee = S.EFFORTS.find(e=>e.value===S.sessionEffort); if (S.sessionEffort && ee) extra.push(ee.label.replace(/^Effort:\s*/,''));
  btn.title = 'Режим: ' + (MODE_LABEL[S.sessionMode] || 'Обычный') + (extra.length?' · '+extra.join(' · '):'') + ' — клик для настройки (⇧+Tab — режим)';
}

// доступные effort-уровни для модели (из /api/models, не хардкод); всегда с «по умолчанию» первым
function effortsForModel(mv){
  const m = S.MODELS.find(x=>x.value===mv);
  const allowed = m && Array.isArray(m.efforts) && m.efforts.length ? m.efforts : null;
  if (!allowed) return S.EFFORTS;   // модель без явного списка (или синтетический «по умолчанию») → все доступные уровни
  return S.EFFORTS.filter(e=>!e.value || allowed.includes(e.value));
}

// Поповер «Режимы» (как в расширении): список режимов + выбор модели + ползунок effort. Значения подтягиваются.
const MODE_META = {
  default:           { i:'✋',  d:'Спрашивает подтверждение перед каждой правкой' },
  acceptEdits:       { i:'</>', d:'Правит файлы без спроса; Bash и прочее — спрашивает' },
  plan:              { i:'▤',  d:'Сначала исследует и предлагает план, без правок' },
  bypassPermissions: { i:'⚡',  d:'Разрешает все действия без спроса' },
};

function openModePop(){
  const pop = document.getElementById('modePop'); if (!pop) return;
  if (!S.MODELS.length){ loadModelsCatalog().then(()=>{ const p=document.getElementById('modePop'); if (p && !p.hidden) openModePop(); }); }   // каталог ещё грузится — дорисуем модели/эффорты как придут
  const modeRows = MODE_ORDER.map(m=>{ const me=MODE_META[m]||{}; const sel=m===S.sessionMode; return `<div class="mp-mode${sel?' sel':''}" data-m="${m}"><span class="mp-ic">${me.i||''}</span><span class="mp-txt"><b>${esc(MODE_LABEL[m]||m)}</b><span>${esc(me.d||'')}</span></span>${sel?'<span class="mp-check">✓</span>':''}</div>`; }).join('');
  const models = S.MODELS.length?S.MODELS:[{value:'',label:'по умолчанию'}];
  const modelOpts = models.map(m=>`<option value="${esc(m.value)}"${m.value===S.sessionModel?' selected':''}>${esc(m.label)}</option>`).join('');
  const effs = effortsForModel(S.sessionModel);
  let ei = effs.findIndex(e=>e.value===S.sessionEffort); if (ei<0){ ei=0; S.sessionEffort=effs[0].value; }
  pop.innerHTML = `<div class="mp-hd">Режимы<span class="mp-hint">⇧+Tab</span></div>
    <div class="mp-row"><span class="mp-k">Модель</span><select class="cx-sel" id="mpModel">${modelOpts}</select></div>
    <div class="mp-modes">${modeRows}</div>
    <div class="mp-eff"><div class="mp-eff-top"><span>Effort</span><b id="mpEffLbl">${esc(effs[ei].label.replace(/^Effort:\s*/,''))}</b></div>
      <input type="range" class="mp-slider" id="mpEff" min="0" max="${Math.max(0,effs.length-1)}" step="1" value="${ei}"${effs.length<=1?' disabled':''}></div>`;
  pop.hidden = false;
  pop.querySelectorAll('.mp-mode').forEach(r=>r.addEventListener('click', ()=>{ S.sessionMode=r.dataset.m; paintMode(); openModePop(); }));
  const ms = pop.querySelector('#mpModel');
  if (ms) ms.onchange = ()=>{ S.sessionModel=ms.value; localStorage.setItem('deckModel',S.sessionModel); openModePop(); paintMode(); };
  const es = pop.querySelector('#mpEff'), el = pop.querySelector('#mpEffLbl');
  if (es) es.oninput = ()=>{ const arr=effortsForModel(S.sessionModel); const v=arr[+es.value]||arr[0]; S.sessionEffort=v.value; localStorage.setItem('deckEffort',S.sessionEffort); if (el) el.textContent=v.label.replace(/^Effort:\s*/,''); paintMode(); };
  // клик вне поповера — закрыть
  const off = (e)=>{ const p=document.getElementById('modePop'); if (!p||p.hidden){ document.removeEventListener('mousedown',off,true); return; } if (!p.contains(e.target) && !(e.target.closest && e.target.closest('#modeBtn'))){ p.hidden=true; document.removeEventListener('mousedown',off,true); } };
  document.addEventListener('mousedown', off, true);
}

function toggleModePop(){ const pop=document.getElementById('modePop'); if (!pop) return; if (pop.hidden) openModePop(); else pop.hidden=true; }

export function cycleMode(){
  const i = MODE_ORDER.indexOf(S.sessionMode);
  S.sessionMode = MODE_ORDER[(i + 1) % MODE_ORDER.length];
  paintMode();
  const pop = document.getElementById('modePop'); if (pop && !pop.hidden) openModePop();   // поповер открыт → отразить смену
}

const TEXT_EXT = /\.(txt|md|json|ya?ml|csv|log|cs|js|mjs|ts|tsx|jsx|html|css|py|sh|xml|sql|toml|ini|conf|cfg|gradle|kt|java|go|rs|rb|php|c|h|cpp|hpp)$/i;

function readAttachment(file){
  return new Promise((resolve, reject) => {
    const isImage = /^image\//.test(file.type);
    const isText = !isImage && (/^text\//.test(file.type) || TEXT_EXT.test(file.name) || file.type==='application/json');
    const fr = new FileReader();
    fr.onerror = () => reject(new Error('read fail: ' + file.name));
    if (isImage){
      fr.onload = () => { const s = String(fr.result); const b64 = s.slice(s.indexOf(',') + 1); resolve({ name:file.name, mediaType:file.type || 'image/png', kind:'image', dataB64:b64, preview:s }); };
      fr.readAsDataURL(file);
    } else if (isText){
      fr.onload = () => resolve({ name:file.name, mediaType:file.type || 'text/plain', kind:'text', text:String(fr.result) });
      fr.readAsText(file);
    } else {
      // прочее бинарное — вложим как base64-текстом упоминанием (Claude не «видит», но путь/имя есть)
      fr.onload = () => { const s = String(fr.result); const b64 = s.slice(s.indexOf(',') + 1); resolve({ name:file.name, mediaType:file.type || 'application/octet-stream', kind:'binary', dataB64:b64 }); };
      fr.readAsDataURL(file);
    }
  });
}

function attachBytes(a){ return a.kind==='text' ? (a.text ? a.text.length : 0) : (a.dataB64 ? Math.floor(a.dataB64.length * 3 / 4) : 0); }

async function addAttachments(files){
  for (const f of files){
    try {
      const a = await readAttachment(f);
      const total = attachDraft.reduce((s, x) => s + attachBytes(x), 0) + attachBytes(a);
      if (total > ATTACH_MAX_BYTES){ setStreamStatus('Вложения превышают лимит ~18МБ', 2200); continue; }
      attachDraft.push(a);
    } catch { setStreamStatus('Не удалось прочитать файл', 1800); }
  }
  renderAttachDraft();
}

export function renderAttachDraft(){
  const box = document.getElementById('attachBox'); if (!box) return;
  if (!attachDraft.length){ box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = attachDraft.map((a, i) => {
    const thumb = a.kind==='image' && a.preview ? `<img class="at-thumb" src="${a.preview}" alt="">` : `<span class="at-ico">${a.kind==='text'?'📄':'📎'}</span>`;
    return `<span class="at-chip">${thumb}<span class="at-name">${esc(a.name)}</span><button class="at-x" type="button" data-i="${i}" title="Убрать">✕</button></span>`;
  }).join('');
  box.querySelectorAll('.at-x').forEach(b => b.addEventListener('click', () => { attachDraft.splice(+b.dataset.i, 1); renderAttachDraft(); const s=document.getElementById('sendBtn'); const ta=document.getElementById('composer-ta'); if(s&&ta) s.disabled = !(ta.value.trim()||attachDraft.length); }));
  const s = document.getElementById('sendBtn'), ta = document.getElementById('composer-ta');
  if (s && ta) s.disabled = !(ta.value.trim() || attachDraft.length);   // вложения без текста — тоже можно слать
}

export function updateQueueIndicator(){
  const el = document.getElementById('queueInd'); if (!el) return;
  if (promptQueue.length){ el.hidden = false; el.textContent = 'в очереди: ' + promptQueue.length; }
  else { el.hidden = true; el.textContent = ''; }
}

export function clearQueue(){
  while (promptQueue.length){ const q = promptQueue.shift(); if (q.el && q.el.parentElement) q.el.remove(); }
  updateQueueIndicator();
}

function enqueuePrompt(payload){                          // отправлено во время стрима → в очередь (FIFO)
  const cons = ensureConsole();
  const el = appendHTML(cons, blockHTML({ kind:'user', text: payload.text }));
  if (el){
    if (payload.attachments && payload.attachments.length) el.insertAdjacentHTML('beforeend', attachThumbsHTML(payload.attachments));
    el.classList.add('cx-queued');
    el.insertAdjacentHTML('beforeend', '<div class="cx-queued-tag">в очереди</div>');
    const runEl = cons.querySelector('.cx-run-chat'); if (runEl) cons.insertBefore(el, runEl);
  }
  payload.el = el;
  promptQueue.push(payload);
  updateQueueIndicator();
  scrollBottom();
}

export function drainQueue(){                                     // по завершении стрима — берём следующий из очереди
  if (!promptQueue.length) return;
  const next = promptQueue.shift();
  updateQueueIndicator();
  setTimeout(() => { if (S.currentFile) runPrompt(next); }, 60);
}

function sendMessage(){
  const ta = document.getElementById('composer-ta'); if (!ta) return;
  if (!requireAuth()) return;                             // чат требует логина в Claude
  const text = ta.value.trim();
  const attachments = attachDraft.slice();                // P4: приложенные файлы
  if ((!text && !attachments.length) || (!S.currentFile && !S.pendingNewSession)) return;
  S.slashOpen = false; const box = document.getElementById('slashBox'); if (box) box.hidden = true;
  ta.value = ''; ta.style.height = 'auto';
  attachDraft.length = 0; renderAttachDraft();            // черновик вложений очищаем
  const btn = document.getElementById('sendBtn'); if (btn) btn.disabled = true;
  const payload = { text, mode: S.sessionMode, model: S.sessionModel, effort: S.sessionEffort, attachments };
  if (!S.currentFile && S.pendingNewSession){ payload.newSessionCwd = S.pendingNewSession.cwd; payload.pendingName = S.pendingNewSession.name; }  // первый промт → создать именованную сессию
  if (S.streaming){ enqueuePrompt(payload); return; }       // идёт стрим → в очередь
  runPrompt(payload);
}
