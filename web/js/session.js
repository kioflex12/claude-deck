// Deck — оркестратор экрана сессии: открытие сессии (openSession) собирает рейл, ленту, композер и стрим.
// Кластер сессии/чата разнесён по rail/transcript/composer/stream; здесь — только точка сборки.
import { S, SESSION_CACHE } from './store.js';
import { esc } from './util.js';
import { openWoJira } from './ui.js';
import { isWorking } from './board.js';
import { setView } from './nav.js';
import { launchUnity } from './unity.js';
import { wireTags, startAgentsPoll, loadBuilds, loadMrs, loadJira } from './services.js';
import { wireSideActions } from './dialogs.js';
import { sideHTML } from './rail.js';
import { renderThread } from './transcript.js';
import { renderComposer, loadSkills } from './composer.js';
import { stopStream, startRailRefresh } from './stream.js';

export async function openSession(file){
  stopStream();   // закрыть стрим прошлой сессии, если был
  S.currentFile = file;
  S.returnView = (S.activeView==='status' || S.activeView==='board') ? S.activeView : 'status';
  document.getElementById('viewBoard').style.display = 'none';
  document.getElementById('viewSkills').style.display = 'none';
  document.getElementById('viewMcp').style.display = 'none';
  document.getElementById('viewSession').style.display = 'flex';
  document.querySelectorAll('.tab').forEach(x => x.setAttribute('aria-selected','false'));
  const bar = document.getElementById('sessionBar');
  const backBtn = `<button class="back" id="backBtn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M15 18 9 12l6-6"/></svg> Назад</button>`;
  bar.innerHTML = backBtn + `<span class="sb-title">Загрузка…</span>`;
  document.getElementById('backBtn').addEventListener('click', () => setView(S.returnView));
  document.getElementById('thread').innerHTML = `<div class="empty">Загрузка транскрипта…</div>`;
  document.getElementById('composer').innerHTML = '';
  document.getElementById('sessionSide').innerHTML = '';
  if (S.streamingFile === file || S.SESSIONS.some(s => s.file === file && isWorking(s))) delete SESSION_CACHE[file];   // активная сессия — свежий стейт (active/blocks), чтобы показать «работает» и live-tail при перезаходе
  let t = SESSION_CACHE[file];
  if (!t){
    try {
      const r = await fetch('/api/session?file=' + encodeURIComponent(file), { cache:'no-store' });
      t = await r.json();
      if (t.error) throw new Error(t.error);
      SESSION_CACHE[file] = t;
    } catch (e){
      document.getElementById('thread').innerHTML = `<div class="empty">Не удалось загрузить сессию: ${esc(String(e.message||e))}</div>`;
      return;
    }
  }
  if (S.currentFile !== file) return;
  // тег задачи — кликабельный чип в правом верхнем углу шапки (margin-left:auto), клик → задача в Jira.
  // Всегда JS-кликабельный (как cu-тег), Jira-URL резолвим В МОМЕНТ КЛИКА (хост мог подгрузиться после рендера).
  const woChip = t.wo ? `<span class="sb-wo-tag sb-wo-run" data-wo="${esc(t.wo)}" title="Открыть ${esc(t.wo)} в Jira">${esc(t.wo)}<span class="ext">↗</span></span>` : '';
  bar.innerHTML = backBtn + `<span class="sb-wo">${esc(t.project)}</span><span class="sb-title">${esc(t.title)}</span>${woChip}`;
  document.getElementById('backBtn').addEventListener('click', () => setView(S.returnView));
  const woRun = bar.querySelector('.sb-wo-run'); if (woRun) woRun.addEventListener('click', () => openWoJira(woRun.dataset.wo));
  document.getElementById('sessionSide').innerHTML = sideHTML(t);
  document.querySelectorAll('#sessionSide .sc-cu-run').forEach(el => el.addEventListener('click', () => launchUnity(el.dataset.cu, el.dataset.cwd)));   // cu-тег в рейле → Unity (фокус/запуск)
  wireTags();          // секция «Теги»: add/edit/delete
  wireSideActions(t);  // кнопки «Форкнуть» / «Удалить»
  startAgentsPoll(t.file);   // live-статус фоновых сабагентов
  renderThread(t);     // лента блоков + запуск live-tail для активной сессии
  S.sessionMode = 'default';   // при открытии существующей сессии — обычный режим (модель/effort — сохранённые)
  renderComposer(t);
  loadSkills(t.cwd);   // грузим скиллы cwd один раз (для «/»)
  loadBuilds(t);       // live-статус сборок TeamCity в рейл
  loadMrs(t);          // live-MR из GitLab в рейл
  loadJira(t);         // live-статус Jira в рейл
  if (t.active || S.streamingFile === file) startRailRefresh(file);   // активная сессия → ветка/MR/сборки/Jira обновляются по ходу работы
}
