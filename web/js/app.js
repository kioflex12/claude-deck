// Deck — тонкий entry: head-консты и хелперы-ссылки, глобальные document-листенеры (внешние ссылки + копирование кода),
// оркестрация загрузки доски (load) и init-хвост. Кластеры вынесены в модули (nav/notify/auth/projects/dialogs/…).
import { S, normMode, SESSION_CACHE } from './store.js';
import { toast, openExternal, openLocalResource } from './ui.js';
import { renderBoard, renderNow, renderFilters } from './board.js';
import { loadMcpCatalog } from './mcp.js';
import { loadSkillsCatalog } from './skills.js';
import { loadUsage, openUsageModal } from './usage.js';
import { hydrateMrs, hydrateJira, startHealthPoll } from './services.js';
import { openSession } from './session.js';
import { setView, ensureStatusTab, openPal } from './nav.js';
import { workingSet, seedJiraFromSessions, startPolling, initNotifyToggle } from './notify.js';
import { loadAuth, loadServicesGate, onAuthChip, startLogin } from './auth.js';
import { toggleProjMenu } from './projects.js';
import { openSettingsModal, openUpdatesModal, renderUpdateStatus, startDescriptorSession } from './dialogs.js';
import { startAttentionPoll, updateAttentionBadge } from './attention.js';
import { maybeShowOnboarding } from './onboarding.js';

// S1: единый токен-гейт для /api/. Токен сервер инжектит в <meta name="deck-token"> index.html (кросс-ориджин HTML не
// прочитать → вредоносная вкладка/встраивание токен не добудет). Патчим fetch/EventSource ОДНИМ местом, чтобы дописывать
// tk ко всем same-origin /api/-запросам — без правки десятков call-site. Статика (/js,/css) и '/' токена не требуют.
(function installApiToken(){
  const meta = typeof document !== 'undefined' && document.querySelector ? document.querySelector('meta[name="deck-token"]') : null;
  const tok = meta ? (meta.getAttribute('content') || '') : '';
  if (!tok || typeof window === 'undefined') return;
  const withTok = (url) => {
    try {
      const uu = new URL(url, location.origin);
      if (uu.origin === location.origin && uu.pathname.startsWith('/api/')) { if (!uu.searchParams.has('tk')) uu.searchParams.set('tk', tok); return uu.pathname + uu.search + uu.hash; }
    } catch {}
    return url;
  };
  const of = window.fetch.bind(window);
  window.fetch = (input, init) => {
    if (typeof input === 'string') return of(withTok(input), init);
    if (input && input.url) return of(new Request(withTok(input.url), input), init);
    return of(input, init);
  };
  const OES = window.EventSource;
  if (OES){ const Patched = function(url, cfg){ return new OES(withTok(url), cfg); }; Patched.prototype = OES.prototype; window.EventSource = Patched; }
})();

S.sessionModel = localStorage.getItem('deckModel') || '';
S.sessionEffort = localStorage.getItem('deckEffort') || '';
S.sessionMode = normMode(localStorage.getItem('deckMode'));   // режим (default/acceptEdits/plan/bypass) — сохранённый выбор, а не сброс на default каждый раз; невалидное → default

// Pane-режим: этот же Deck внутри iframe воркспейса показывает ОДНУ сессию без топбара/доски (см. workspace.js).
// Дескриптор пани лежит в localStorage['deckPane:<id>']; сюда приходит только id через ?pane=.
const PANE_ID = (new URLSearchParams(location.search)).get('pane') || '';
export const PANE_MODE = !!PANE_ID;
S.paneMode = PANE_MODE;   // читает session.js: в пане openSession рисует сессию классически, в верхнем окне — маршрутизирует в воркспейс
if (PANE_MODE) document.documentElement.classList.add('pane-mode');

/* Deck — реальные сессии Claude Code. Данные: /api/sessions (список) + /api/session (транскрипт блоками) + /api/skills (скиллы по cwd). */
export const UI_BUILD = '0.2.9';   // версия ИМЕННО статики (index.html/app.js). Показывается в «Обновлениях»; расхождение с версией asar = жива старая статика (побитое обновление)
export const jiraUrl = (wo) => S.JIRA_HOST_CFG ? ("https://" + S.JIRA_HOST_CFG + "/browse/" + wo) : "";
const GL = "https://gitlab.wo/";
const TC = "https://teamcity.wo/viewLog.html?buildId=";
const CONN = "https://claude.ai/settings/connectors";
const EI = '<svg class="ei" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6"><path d="M7 17 17 7M9 7h8v8"/></svg>';
export const aReal = (href, text, cls='') => `<a class="lnk ${cls}" href="${href}" target="_blank" rel="noopener" title="${href}">${text}${EI}</a>`;
const aStub = (href, text, cls='') => `<a class="lnk ${cls}" href="#" onclick="return false" title="${href}">${text}${EI}</a>`;

export async function loadModelsCatalog(){
  try { const d = await (await fetch('/api/models', { cache:'no-store' })).json(); S.MODELS = Array.isArray(d.models)?d.models:[]; S.EFFORTS = Array.isArray(d.efforts)?d.efforts:[]; }
  catch { S.MODELS = []; S.EFFORTS = []; }
}

const BASE_BRANCHES = new Set(['preprod','preupdate','master','main','develop','dev','prod','release','head','']);
export function isBaseBranch(b){ return BASE_BRANCHES.has(String(b||'').trim().toLowerCase()); }

// Единый перехват кликов по ссылкам (вывод, рейл, везде): внешние http(s) → системный браузер; локальные/относительные
// (резолвятся в origin Deck) → открыть как файл, а не как страницу Deck. Capture — до дефолтной навигации/target=_blank.
document.addEventListener('click', (e) => {
  const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
  if (!a) return;
  if (a.hasAttribute('download')) return;                          // программная выгрузка файла (Экспорт настроек) — пусть браузер скачает, не перехватываем
  const raw = a.getAttribute('href') || '';
  if (!raw || raw === '#' || raw[0] === '#') return;               // якорь/заглушка — свои обработчики
  if (/^(mailto:|tel:|blob:|data:)/i.test(raw)) return;            // почта/тел/blob-выгрузка/data-URI — системе/браузеру, не openLocalResource
  const abs = a.href || '';
  const external = /^https?:\/\//i.test(raw) && !abs.startsWith(location.origin + '/') && abs !== location.origin;
  e.preventDefault();
  if (external) openExternal(abs);
  else openLocalResource(raw);
}, true);
// Копирование блока кода/преформатированного текста по кнопке справа сверху
document.addEventListener('click', (e) => {
  const b = e.target && e.target.closest ? e.target.closest('.code-copy') : null;
  if (!b) return;
  e.preventDefault(); e.stopPropagation();
  const pre = b.closest('pre'); const code = pre && pre.querySelector('code');
  const text = code ? code.textContent : (pre ? pre.textContent : '');
  const done = () => { b.classList.add('ok'); const o = b.textContent; b.textContent = '✓'; setTimeout(() => { b.classList.remove('ok'); b.textContent = o; }, 1200); };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done).catch(() => toast('Не удалось скопировать'));
  else { try { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); done(); } catch { toast('Не удалось скопировать'); } }
}, true);
// Лайтбокс: клик по вложенной картинке (в ленте или в композере) — открыть во весь экран, повторный клик/Esc — закрыть.
document.addEventListener('click', (e) => {
  const img = e.target && e.target.closest ? e.target.closest('.cx-img, .cx-att-img, .at-thumb') : null;
  if (!img || !img.getAttribute('src')) return;
  e.preventDefault();
  let ov = document.getElementById('imgLightbox');
  if (!ov){ ov = document.createElement('div'); ov.id = 'imgLightbox'; ov.className = 'img-lightbox'; ov.addEventListener('click', () => ov.classList.remove('open')); document.body.appendChild(ov); }
  ov.innerHTML = '<img alt="">'; ov.firstChild.src = img.getAttribute('src'); ov.classList.add('open');
}, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape'){ const ov = document.getElementById('imgLightbox'); if (ov) ov.classList.remove('open'); } });
// Кнопка показа/скрытия бокового рейла сессии (в узкой пане рейл не влезает — держим оверлеем по кнопке). Состояние
// глобальное и запоминается, чтобы при следующем открытии сессии панель была в том же виде.
document.addEventListener('click', (e) => {
  if (!e.target.closest || !e.target.closest('#sideToggle')) return;
  const v = document.getElementById('viewSession'); if (!v) return;
  const open = v.classList.toggle('side-open');
  try { localStorage.setItem('deckSideOpen', open ? '1' : '0'); } catch {}
});

// Загрузка одной сессии в iframe-пане: без доски/поллинг-уведомлений, только экран сессии. Родителю (воркспейсу)
// докладываем реальный файл, когда новая сессия его обретёт, и фокус — для «следующая сессия в последнюю группу».
async function bootPane(){
  S.notifyEnabled = false;   // уведомления о завершении шлёт только верхнее окно, не каждая паня
  let desc = null; try { desc = JSON.parse(localStorage.getItem('deckPane:' + PANE_ID) || 'null'); } catch {}
  try { const r = await fetch('/api/sessions', { cache:'no-store' }); const d = await r.json(); S.SESSIONS = Array.isArray(d.sessions) ? d.sessions : []; } catch { S.SESSIONS = []; }
  loadAuth();
  if (!desc){ document.getElementById('thread').innerHTML = '<div class="empty">Паня не найдена — закройте вкладку.</div>'; return; }
  if (localStorage.getItem('deckSideOpen') === '1'){ const v = document.getElementById('viewSession'); if (v) v.classList.add('side-open'); }
  if (desc.kind === 'file' && desc.file) openSession(desc.file);
  else startDescriptorSession(desc);
  // Поллинг /api/sessions в пане не нужен: доска скрыта, а живость сессии ведёт SSE-стрим и tail. Одной загрузки
  // списка выше достаточно, чтобы openSession подмешал live-поля и поднял tail. Уведомления шлёт только верхнее окно.
  startPaneReporter();
}
function startPaneReporter(){
  const post = m => { try { if (window.parent && window.parent !== window) window.parent.postMessage(m, location.origin); } catch {} };
  let lastFile = null, lastTitle = null;
  setInterval(() => {
    const f = S.currentFile;
    if (!f) return;
    const title = (SESSION_CACHE[f] && SESSION_CACHE[f].title) || (document.querySelector('#sessionBar .sb-title') || {}).textContent || '';
    if (f !== lastFile){ lastFile = f; lastTitle = title; try { localStorage.setItem('deckPane:' + PANE_ID, JSON.stringify({ kind:'file', file:f, title })); } catch {}; post({ type:'deck-pane-file', pane: PANE_ID, file: f, title }); }
    else if (title && title !== lastTitle){ lastTitle = title; post({ type:'deck-pane-title', pane: PANE_ID, title }); }
  }, 700);
  document.addEventListener('mousedown', () => post({ type:'deck-pane-focus', pane: PANE_ID }), true);
}

export async function load(){
  if (PANE_MODE) return bootPane();
  // Мгновенный каркас ДО данных: топбар уже привязан (wireTopbar), сразу показываем борд и кнопки (пустыми) —
  // иначе на холодном старте после апдейта интерфейс «мёртв», пока грузится /api/sessions.
  renderFilters();
  renderNow();
  setView('status');
  try {
    const r = await fetch('/api/sessions', { cache:'no-store' });
    const data = await r.json();
    S.SESSIONS = Array.isArray(data.sessions) ? data.sessions : [];
  } catch (e) { S.SESSIONS = []; }
  seedJiraFromSessions();              // Jira уже в payload → колонки верны на первом рендере
  S.prevWorkingFiles = workingSet();     // базовая линия: на старте «завершения» не шлём
  renderFilters();
  renderNow();
  if (S.activeView === 'status' || S.activeView === 'board') renderBoard(true);   // дорисовать борд с данными (scroll сохраняется)
  startPolling();
  hydrateMrs(true);    // рефреш страницы (F5) → live-MR СРАЗУ, мимо кэшей (не ждать цикл поллинга)
  hydrateJira(true);   // рефреш страницы (F5) → live-статусы Jira СРАЗУ, мимо кэшей
  startHealthPoll();   // TECH-4: индикатор деградации интеграций (какой сервис упал) — раз в 20с
  updateAttentionBadge();   // Фаза-4: счётчик «Требует внимания» из уже загруженных сессий (до первого поллинга)
  startAttentionPoll();     // Фаза-4: git-скан незакоммиченных копий + периодический refresh счётчика
  loadSkillsCatalog(); // TECH-2: реальные скиллы (для вкладки и палитры)
  maybeShowOnboarding();   // первый запуск → дружелюбный экран-приветствие (папку сессий определяем сами, без ручной настройки)
  // Тяжёлые SDK-пробы (spawn claude) — ПОСЛЕ подъёма борда, чтобы не конкурировать за старт и не морозить UI.
  setTimeout(() => {
    loadMcpCatalog();  // реальные MCP-серверы
    loadUsage();
    if (!S.usageTimer) S.usageTimer = setInterval(loadUsage, 30000);   // лимиты обновляем ~раз в 30с (сервер кэширует 45с)
  }, 1500);
}
function wireTopbar(){
  const br = document.querySelector('.brand'); if (br) br.addEventListener('click', () => setView('status'));   // логотип — путь «домой» (как в любом веб-приложении)
  const u = document.getElementById('usageInd'); if (u) u.addEventListener('click', openUsageModal);
  const a = document.getElementById('authChip'); if (a) a.addEventListener('click', onAuthChip);
  const g = document.getElementById('authGateBtn'); if (g) g.addEventListener('click', startLogin);
  const s = document.getElementById('settingsBtn'); if (s) s.addEventListener('click', openSettingsModal);
  const sh = document.getElementById('svcHealth'); if (sh) sh.addEventListener('click', openSettingsModal);   // клик по индикатору деградации → настройки (проверить хост/токен)
  const sg = document.getElementById('svcGateBtn'); if (sg) sg.addEventListener('click', openSettingsModal);
  const pb = document.getElementById('projBtn'); if (pb) pb.addEventListener('click', (e) => { e.stopPropagation(); toggleProjMenu(); });
}

if (!PANE_MODE){
  ensureStatusTab();
  initNotifyToggle();
  wireTopbar();
  loadServicesGate();
  // Electron: клик по нативному уведомлению приходит сюда мостом → открываем сессию.
  if (window.deckNative && window.deckNative.onOpenSession) window.deckNative.onOpenSession((file)=>{ if (file) openSession(file); });
  // Electron: открыть окно «Обновления» из меню/трея + принимать статусы автоапдейтера.
  if (window.deckNative && window.deckNative.onOpenUpdates) window.deckNative.onOpenUpdates(openUpdatesModal);
  // Electron: Ctrl/Cmd+K через нативный аксельратор меню (физическое сочетание может не дойти до document-listener).
  if (window.deckNative && window.deckNative.onOpenPalette) window.deckNative.onOpenPalette(() => openPal());
  if (window.deckNative && window.deckNative.onUpdateStatus) window.deckNative.onUpdateStatus(renderUpdateStatus);
}
load();
