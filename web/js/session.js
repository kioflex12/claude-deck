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
import { sideHTML, wireRailTabs, scopeChipsHTML } from './rail.js';
import { renderThread, appendHTML } from './transcript.js';
import { renderComposer, loadSkills } from './composer.js';
import { stopStream, startRailRefresh, questionCardHTML, wireQuestion, approvalCardHTML, wireApproval } from './stream.js';

export async function openSession(file){
  stopStream();   // закрыть стрим прошлой сессии, если был
  S.currentFile = file;
  S.returnView = (S.activeView==='status' || S.activeView==='board') ? S.activeView : 'status';
  S.railTab = 'context'; S.artifacts = null; S.artifactsCwd = '';   // новая сессия — начинаем с вкладки «Контекст»
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
  renderRail(t);       // правый рейл: разметка + привязки + live-секции (MR/сборки/Jira)
  startAgentsPoll(t.file);   // live-статус фоновых сабагентов
  renderThread(t);     // лента блоков + запуск live-tail для активной сессии
  resurfaceQuestions(file);   // висящие (неотвеченные) вопросы AskUserQuestion/ExitPlanMode — снова показать и ждать ответ
  resurfaceApprovals(file);   // висящие аппрувы (обрыв SSE их не решил) — снова показать и ждать решение
  S.sessionMode = localStorage.getItem('deckMode') || 'default';   // сохранённый режим (как модель/effort) — перезаход больше не сбрасывает выбор на default
  renderComposer(t);
  loadSkills(t.cwd);   // грузим скиллы cwd один раз (для «/»)
  if (t.active || S.streamingFile === file) startRailRefresh(file);   // активная сессия → описание/скоуп/ветка/MR/сборки/Jira обновляются по ходу работы
}

// Полный рендер правого рейла (без консоли/tail): разметка + привязки + live-секции. Зовётся при открытии сессии и при
// обретении файла новой сессией (событие session). Пропускает перерисовку, если юзер печатает тег (не затираем ввод).
export function renderRail(t){
  const side = document.getElementById('sessionSide'); if (!side) return;
  if (document.activeElement && document.activeElement.id === 'tagsInput') return;
  side.innerHTML = sideHTML(t);
  side.querySelectorAll('.sc-cu-run').forEach(el => el.addEventListener('click', () => launchUnity(el.dataset.cu, el.dataset.cwd)));
  wireTags(); wireSideActions(t); wireRailTabs();
  loadBuilds(t); loadMrs(t); loadJira(t);
}

// Surgical-обновление статичных полей рейла по ходу сессии (описание=последний промт, чипы скоупа/clientCu появляются по
// мере накопления контекста) — без перерисовки live-секций (MR/сборки/Jira обновляются сами, без мигания).
export function refreshRailFields(t){
  const side = document.getElementById('sessionSide'); if (!side) return;
  if (document.activeElement && document.activeElement.id === 'tagsInput') return;
  const desc = side.querySelector('.desc'); if (desc) desc.textContent = t.lastPrompt || t.title || '—';
  const chips = side.querySelector('.chips');
  if (chips){
    chips.innerHTML = scopeChipsHTML(t);
    chips.querySelectorAll('.sc-cu-run').forEach(el => el.addEventListener('click', () => launchUnity(el.dataset.cu, el.dataset.cwd)));
  }
}

// Ре-сёрфейс висящих вопросов при перезаходе: пока ход в фоне ждёт ответа человека, карточку надо дорисовать в ленту
// и снова принять выбор (сервер держит вопрос в pendingQuestions до /api/answer). Пусто/ошибка — тихо ничего.
async function resurfaceQuestions(file){
  let d; try { const r = await fetch('/api/pending-questions?file=' + encodeURIComponent(file), { cache:'no-store' }); d = await r.json(); } catch { return; }
  if (S.currentFile !== file || !d || !Array.isArray(d.questions) || !d.questions.length) return;
  const cons = document.querySelector('.cx-console'); if (!cons) return;
  for (const q of d.questions){
    if (cons.querySelector('.cx-question[data-id="' + q.id + '"]')) continue;   // уже показана (tail-опрос) — не дублируем
    const card = { id: q.id, questions: q.questions };
    const el = appendHTML(cons, questionCardHTML(card));
    wireQuestion(el, card);
  }
}

// Ре-сёрфейс висящих аппрувов (зеркало resurfaceQuestions): при обрыве SSE аппрув не решается за пользователя, ход в
// фоне ждёт решения (сервер держит его в pendingApprovals до /api/approve) — при перезаходе дорисовываем карточку.
async function resurfaceApprovals(file){
  let d; try { const r = await fetch('/api/pending-approvals?file=' + encodeURIComponent(file), { cache:'no-store' }); d = await r.json(); } catch { return; }
  if (S.currentFile !== file || !d || !Array.isArray(d.approvals) || !d.approvals.length) return;
  const cons = document.querySelector('.cx-console'); if (!cons) return;
  for (const a of d.approvals){
    if (cons.querySelector('.cx-approval[data-id="' + a.id + '"]')) continue;   // уже показан (tail-опрос) — не дублируем
    const card = { id: a.id, tool: a.tool, input: a.input };
    const el = appendHTML(cons, approvalCardHTML(card));
    wireApproval(el, card);
  }
}
