// Deck — лента сообщений сессии: разметка блоков (user/assistant/thinking/tool/system/command),
// первичная отрисовка треда и DOM-хелперы вставки/прокрутки. Живую дозапись ведёт stream.js.
import { S } from './store.js';
import { esc, mdToHtml, fmtTok } from './util.js';
import { startTail, stopTail } from './stream.js';

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

export function blockHTML(b){
  if (b.kind==='user') return `<div class="cx-msg cx-user"><div class="cx-role">Ты</div><div class="cx-md">${mdToHtml(b.text)}</div></div>`;
  if (b.kind==='assistant') {
    const full = b.text || '';
    const body = full.length > 1200
      ? `<div class="cx-md cx-short">${mdToHtml(full.slice(0,1200)+'…')}</div><div class="cx-md cx-fulltext" hidden>${mdToHtml(full)}</div><button class="cx-more" type="button">показать полностью</button>`
      : `<div class="cx-md">${mdToHtml(full)}</div>`;
    return `<div class="cx-msg cx-asst"><div class="cx-role">Claude</div>${body}${metaLine(b.meta)}</div>`;
  }
  if (b.kind==='thinking') {
    if (!b.text || !b.text.trim()) return '';   // пустое размышление (в истории thinking без текста) — не рендерим
    return `<div class="cx-msg cx-think"><button class="cx-think-h" type="button"><span class="cx-tw">▸</span>✻ Размышление</button><div class="cx-think-body cx-md" hidden>${mdToHtml(b.text)}</div>${metaLine(b.meta)}</div>`;
  }
  if (b.kind==='tool') {
    const arg = b.arg ? `<span class="cx-arg">(${esc(b.arg)})</span>` : '';
    const hasRes = !!b.result;
    const caret = `<span class="cx-tw">${hasRes ? '▸' : '·'}</span>`;
    const row = `<div class="cx-tool${hasRes?' cx-clk':''}">${caret}<span class="cx-mk">⏺</span><span class="cx-name">${esc(b.name)}</span>${arg}</div>`;
    const pre = hasRes ? `<pre class="cx-res" hidden>${esc(b.result)}</pre>` : '';
    return `<div class="cx-msg cx-twrap">${row}${pre}</div>`;
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
  scrollBottom();                          // открываем на последних сообщениях (актуальный контекст)
  requestAnimationFrame(scrollBottom);     // повтор после раскладки (шрифты/переносы могут сдвинуть высоту)
  stopTail();
  if (t.active || t.serverActive) startTail(t.file);   // сессия свежая ИЛИ на сервере жив ход (заблокирован на вопросе/долгом инструменте — файл не пишется, mtime старый) → всё равно тянем tail
}
