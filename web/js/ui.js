// Deck — общие UI-листья: тосты, открытие внешних ссылок и локальных файлов, встроенный просмотрщик.
// Вынесены из app.js, потому что их зовут все кластеры. jiraUrl остаётся в app.js, loadServicesGate — в
// auth.js, modalBack — в dialogs.js; циклы безопасны (вызовы только в рантайме).
import { S, SESSION_CACHE } from './store.js';
import { esc, mdToHtml } from './util.js';
import { jiraUrl } from './app.js';
import { loadServicesGate } from './auth.js';
import { modalBack } from './dialogs.js';

export function toast(msg){
  let el = document.getElementById('deckToast');
  if (!el){ el = document.createElement('div'); el.id = 'deckToast'; el.className = 'deck-toast'; document.body.appendChild(el); }
  el.textContent = msg; el.classList.add('show');
  clearTimeout(el._t); el._t = setTimeout(()=>el.classList.remove('show'), 2600);
}

export function openExternal(url){   // системный браузер: в Electron — мост, в браузере — новая вкладка
  if (window.deckNative && window.deckNative.openExternal) window.deckNative.openExternal(url);
  else window.open(url, '_blank', 'noopener');
}

// Клик по тегу задачи → задача в Jira. URL строим на хосте из /api/config; если не подгрузился к моменту клика — дотягиваем и повторяем.
export async function openWoJira(wo){
  let url = jiraUrl(wo);
  if (!url){ await loadServicesGate(); url = jiraUrl(wo); }
  if (url) openExternal(url);
  else toast('Укажите хост Jira в настройках (⚙), чтобы открывать задачи');
}

// Локальный ресурс из вывода (ссылка на .md и т.п.): открыть файл во встроенном просмотрщике, НЕ навигировать окно Deck.
export function openLocalResource(rawHref){
  const cwd = (S.currentFile && SESSION_CACHE[S.currentFile] && SESSION_CACHE[S.currentFile].cwd) || '';
  openFileViewer(rawHref, cwd);
}

// Встроенный просмотрщик локального файла (клик по ссылке .md/.txt в выводе): читаем через /api/file и показываем
// в модалке (markdown → html, прочее — текст). Не текст / вне cwd / нет файла → отдаём ОС (внешнее приложение).
export async function openFileViewer(rawHref, cwd){
  let p = rawHref;
  try { const uu = new URL(rawHref, location.origin); if (uu.origin === location.origin) p = decodeURIComponent(uu.pathname).replace(/^\//, ''); } catch {}
  const openExt = () => { if (window.deckNative && window.deckNative.openPath) window.deckNative.openPath({ path: p, cwd }).then(r => { if (!r || !r.ok) toast('Не удалось открыть: ' + p); }); else toast('Локальный ресурс: ' + p); };
  let d; try { d = await (await fetch('/api/file?path=' + encodeURIComponent(p) + '&cwd=' + encodeURIComponent(cwd || ''), { cache:'no-store' })).json(); } catch { d = null; }
  if (!d || !d.ok){ openExt(); return; }        // бинарь / вне cwd / не найден → внешнее приложение ОС
  const isMd = d.ext === 'md' || d.ext === 'markdown';
  const body = isMd ? `<div class="cx-md">${mdToHtml(d.text)}</div>` : `<pre class="cx-code"><button class="code-copy" type="button" title="Копировать">⧉</button><code>${esc(d.text)}</code></pre>`;
  const back = modalBack('fileViewBack');
  back.innerHTML = `<div class="deck-modal fileview"><div class="dm-head">
    <span class="fv-name" title="${esc(p)}">${esc(d.name)}${d.truncated?' · фрагмент':''}</span>
    <span class="fv-actions"><button class="fv-ext" id="fvExt" type="button" title="Открыть во внешнем приложении">↗</button><button class="dm-x" id="fvClose" type="button">✕</button></span>
    </div><div class="dm-body">${body}</div></div>`;
  back.classList.add('open');
  back.querySelector('#fvClose').addEventListener('click', ()=> back.classList.remove('open'));
  back.querySelector('#fvExt').addEventListener('click', openExt);
}
