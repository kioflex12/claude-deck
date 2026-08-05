// Deck — лента сообщений сессии: разметка блоков (user/assistant/thinking/tool/system/command),
// первичная отрисовка треда и DOM-хелперы вставки/прокрутки. Живую дозапись ведёт stream.js.
import { S } from './store.js';
import { esc, mdToHtml, fmtTok } from './util.js';
import { startTail, stopTail, appendTerminalNote } from './stream.js';
import { loadPending, removePending } from './composer.js';

export function wireConsole(){
  const cons = document.querySelector('.cx-console');
  if (!cons) return;
  cons.addEventListener('click', e => {
    // тумблер thinking-блока
    const th = e.target.closest('.cx-think-h');
    if (th){
      const body = th.parentElement.querySelector('.cx-think-body'); if (!body) return;
      const tw = th.querySelector('.cx-tw'); const hidden = body.hasAttribute('hidden');
      if (hidden){ body.removeAttribute('hidden'); if (tw) tw.textContent='▾'; } else { body.setAttribute('hidden',''); if (tw) tw.textContent='▸'; }
      return;
    }
    // тумблер «показать полностью» ⇄ «свернуть» у длинного ответа
    const more = e.target.closest('.cx-more');
    if (more){
      const box = more.closest('.cx-asst');
      const short = box.querySelector('.cx-short'), full = box.querySelector('.cx-fulltext');
      const expanded = short.hasAttribute('hidden');
      if (expanded){ short.removeAttribute('hidden'); full.setAttribute('hidden',''); more.textContent='показать полностью'; }
      else { short.setAttribute('hidden',''); full.removeAttribute('hidden'); more.textContent='свернуть'; }
      return;
    }
    // тумблер результата tool-вызова
    const row = e.target.closest('.cx-tool.cx-clk');
    if (!row) return;
    const pre = row.parentElement.querySelector('.cx-res'); if (!pre) return;
    const hidden = pre.hasAttribute('hidden');
    if (hidden) pre.removeAttribute('hidden'); else pre.setAttribute('hidden','');
    const mk = row.querySelector('.cx-tw'); if (mk) mk.textContent = hidden ? '▾' : '▸';
  });
}

function metaLine(m){
  if (!m) return '';
  return `<div class="cx-meta">↑ ${fmtTok(m.in)} · ↓ ${fmtTok(m.out)} · ctx ${Math.round((m.ctxPct||0)*100)}%</div>`;
}

// Референс-стиль: таймлайн с точкой-маркером слева, содержимое плоское. Текст ассистента — без карточки/шапки «CLAUDE»
// (была коробка на каждый кусок → полотно). Инструмент — заголовок (имя + описание) + IN(команда) + OUT(результат виден).
export function blockHTML(b){
  if (b.kind==='user') return `<div class="cx-msg cx-user"><div class="cx-role">Ты</div><div class="cx-md">${mdToHtml(b.text)}</div></div>`;
  if (b.kind==='assistant') {
    const full = b.text || '';
    const body = full.length > 1200
      ? `<div class="cx-md cx-short">${mdToHtml(full.slice(0,1200)+'…')}</div><div class="cx-md cx-fulltext" hidden>${mdToHtml(full)}</div><button class="cx-more" type="button">показать полностью</button>`
      : `<div class="cx-md">${mdToHtml(full)}</div>`;
    return `<div class="cx-msg cx-asst">${body}${metaLine(b.meta)}</div>`;
  }
  if (b.kind==='thinking') {
    if (!b.text || !b.text.trim()) return '';   // пустое размышление (в истории thinking без текста) — не рендерим
    return `<div class="cx-msg cx-think"><button class="cx-think-h" type="button"><span class="cx-tw">▸</span>✻ Размышление</button><div class="cx-think-body cx-md" hidden>${mdToHtml(b.text)}</div>${metaLine(b.meta)}</div>`;
  }
  if (b.kind==='tool') {
    const desc = b.desc ? `<span class="cx-tdesc">${esc(b.desc)}</span>` : '';
    const head = `<div class="cx-tool-h"><span class="cx-name">${esc(b.name)}</span>${desc}</div>`;
    const inBox = b.cmd ? `<div class="cx-io"><span class="cx-io-l">IN</span><pre class="cx-io-b">${esc(b.cmd)}</pre></div>` : '';
    const outBox = b.result ? `<div class="cx-io"><span class="cx-io-l">OUT</span><pre class="cx-io-b cx-io-out">${esc(b.result)}</pre></div>` : '';
    return `<div class="cx-msg cx-twrap">${head}${inBox}${outBox}</div>`;
  }
  if (b.kind==='image'){
    const src = b.data ? ('data:'+(b.media||'image/png')+';base64,'+b.data) : (b.url||'');
    if (!src) return '';
    return `<div class="cx-msg cx-imgmsg"><img class="cx-img" src="${src}" alt="вложение" loading="lazy"></div>`;
  }
  if (b.kind==='system') return `<div class="cx-msg cx-sys">${esc(b.text||'')}</div>`;         // служебное — приглушённо, не «Ты»
  if (b.kind==='command') return `<div class="cx-msg cx-cmd"><span class="cx-cmd-ico">⌘</span>${esc(b.text||'')}</div>`;   // вызов команды человеком
  return '';
}

export function appendHTML(parent, html){ const t = document.createElement('div'); t.innerHTML = html.trim(); const el = t.firstElementChild; if (el) parent.appendChild(el); return el; }

export function scrollBottom(){ const tr = document.getElementById('transcript'); if (tr) tr.scrollTop = tr.scrollHeight; }

export function isNearBottom(){ const tr = document.getElementById('transcript'); if (!tr) return true; return (tr.scrollHeight - tr.scrollTop - tr.clientHeight) < 90; }

export function attachThumbsHTML(atts){   // мини-превью у отправленного user-блока в ленте
  if (!atts || !atts.length) return '';
  return '<div class="cx-att">' + atts.map(a =>
    a.kind==='image' && a.preview ? `<img class="cx-att-img" src="${a.preview}" alt="">` : `<span class="cx-att-file">${a.kind==='text'?'📄':'📎'} ${esc(a.name)}</span>`
  ).join('') + '</div>';
}

export function renderThread(t){
  const blocks = t.blocks || [];
  document.getElementById('thread').innerHTML = blocks.length ? `<div class="cx-console">${blocks.map(blockHTML).join('')}</div>` : `<div class="empty">Сессия без текстовых сообщений.</div>`;
  wireConsole();
  S.tailCount = blocks.length;               // курсор live-tail = число уже показанных блоков
  try {   // восстановить «ожидающие» промты, пережившие перезаход (те, которых ещё нет в транскрипте) — чтобы не пропадали «вообще»
    const pend = loadPending(t.file);
    if (pend.length){
      const cons = document.querySelector('.cx-console');
      const seen = new Set(blocks.filter((b) => b.kind === 'user').map((b) => String(b.text || '').trim()));
      if (cons) for (const it of pend){
        const tx = String(it && it.text || '').trim();
        const atts = (it && it.atts) || [];
        if (!tx && !atts.length) continue;                       // пустой промт без вложений — пропускаем
        if (tx && seen.has(tx)){ removePending(t.file, tx); continue; }   // уже долетел в транскрипт — не дублируем
        const el = appendHTML(cons, blockHTML({ kind: 'user', text: it.text || '' }));
        if (el){
          if (atts.length) el.insertAdjacentHTML('beforeend', attachThumbsHTML(atts));   // восстановить приложенные скрины (кликабельны → лайтбокс)
          el.classList.add('cx-queued');
          el.insertAdjacentHTML('beforeend', '<div class="cx-queued-tag">⏳ ожидал отправки — восстановлен после перезахода</div>');
        }
      }
    }
  } catch {}
  if (S.pendingCompactNote){               // результат /compact переживает перерисовку сессии (иначе нота стиралась re-render'ом → «пустой» итог)
    const consN = document.querySelector('.cx-console');
    if (consN) appendHTML(consN, '<div class="cx-note cx-compact-done">' + esc(S.pendingCompactNote) + '</div>');
    S.pendingCompactNote = '';
  }
  scrollBottom();                          // открываем на последних сообщениях (актуальный контекст)
  requestAnimationFrame(scrollBottom);     // повтор после раскладки (шрифты/переносы могут сдвинуть высоту)
  stopTail();
  if (t.serverActive){ startTail(t.file); S.serverBusy = true; }   // R3: гейт ставим ПОСЛЕ startTail (startTail→stopTail сбрасывает serverBusy) — иначе окно, где send плодит 2-й resume. На сервере жив ход → tail; при завершении tailTick покажет причину
  else if (t.terminal){ appendTerminalNote(document.querySelector('.cx-console'), t.terminal.state, t.terminal.reason); }   // R5: ход уже завершился лимитом/ошибкой/осиротел — сразу видимый маркер + «Продолжить»
  else if (t.active){ startTail(t.file); }                          // свежая сессия (недавний mtime) — тянем tail (чисто завершённые terminal=null → ноты не будет)
}
