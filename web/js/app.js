// Deck — тонкий entry: head-консты и хелперы-ссылки, глобальные document-листенеры (внешние ссылки + копирование кода),
// оркестрация загрузки доски (load) и init-хвост. Кластеры вынесены в модули (nav/notify/auth/projects/dialogs/…).
import { S } from './store.js';
import { toast, openExternal, openLocalResource } from './ui.js';
import { renderBoard, renderNow, renderFilters } from './board.js';
import { loadMcpCatalog } from './mcp.js';
import { loadSkillsCatalog } from './skills.js';
import { loadUsage, openUsageModal } from './usage.js';
import { hydrateMrs, hydrateJira } from './services.js';
import { openSession } from './session.js';
import { setView, ensureStatusTab, openPal } from './nav.js';
import { workingSet, seedJiraFromSessions, startPolling, initNotifyToggle } from './notify.js';
import { loadAuth, loadServicesGate, onAuthChip, startLogin } from './auth.js';
import { toggleProjMenu } from './projects.js';
import { openSettingsModal, openUpdatesModal, renderUpdateStatus } from './dialogs.js';
S.sessionModel = localStorage.getItem('deckModel') || '';
S.sessionEffort = localStorage.getItem('deckEffort') || '';
S.sessionMode = localStorage.getItem('deckMode') || 'default';   // режим (default/acceptEdits/plan/bypass) — сохранённый выбор, а не сброс на default каждый раз

/* Deck — реальные сессии Claude Code. Данные: /api/sessions (список) + /api/session (транскрипт блоками) + /api/skills (скиллы по cwd). */
export const UI_BUILD = '0.1.40';   // версия ИМЕННО статики (index.html/app.js). Показывается в «Обновлениях»; расхождение с версией asar = жива старая статика (побитое обновление)
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
  const raw = a.getAttribute('href') || '';
  if (!raw || raw === '#' || raw[0] === '#') return;               // якорь/заглушка — свои обработчики
  if (/^(mailto:|tel:)/i.test(raw)) return;                        // почта/тел — системе
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

export async function load(){
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
  loadSkillsCatalog(); // TECH-2: реальные скиллы (для вкладки и палитры)
  // Тяжёлые SDK-пробы (spawn claude) — ПОСЛЕ подъёма борда, чтобы не конкурировать за старт и не морозить UI.
  setTimeout(() => {
    loadMcpCatalog();  // реальные MCP-серверы
    loadUsage();
    if (!S.usageTimer) S.usageTimer = setInterval(loadUsage, 30000);   // лимиты обновляем ~раз в 30с (сервер кэширует 45с)
  }, 1500);
}
function wireTopbar(){
  const u = document.getElementById('usageInd'); if (u) u.addEventListener('click', openUsageModal);
  const a = document.getElementById('authChip'); if (a) a.addEventListener('click', onAuthChip);
  const g = document.getElementById('authGateBtn'); if (g) g.addEventListener('click', startLogin);
  const s = document.getElementById('settingsBtn'); if (s) s.addEventListener('click', openSettingsModal);
  const sg = document.getElementById('svcGateBtn'); if (sg) sg.addEventListener('click', openSettingsModal);
  const pb = document.getElementById('projBtn'); if (pb) pb.addEventListener('click', (e) => { e.stopPropagation(); toggleProjMenu(); });
}

ensureStatusTab();
initNotifyToggle();
wireTopbar();
loadAuth();
loadServicesGate();
// Electron: клик по нативному уведомлению приходит сюда мостом → открываем сессию.
if (window.deckNative && window.deckNative.onOpenSession) window.deckNative.onOpenSession((file)=>{ if (file) openSession(file); });
// Electron: открыть окно «Обновления» из меню/трея + принимать статусы автоапдейтера.
if (window.deckNative && window.deckNative.onOpenUpdates) window.deckNative.onOpenUpdates(openUpdatesModal);
// Electron: Ctrl/Cmd+K через нативный аксельратор меню (физическое сочетание может не дойти до document-listener).
if (window.deckNative && window.deckNative.onOpenPalette) window.deckNative.onOpenPalette(() => openPal());
if (window.deckNative && window.deckNative.onUpdateStatus) window.deckNative.onUpdateStatus(renderUpdateStatus);
load();
