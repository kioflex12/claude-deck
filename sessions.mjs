// Deck — домен сессий: пользовательские теги/имена, dev-workflow стадии и скоуп, сбор списка карточек и их сводок,
// транскрипт/агенты/артефакты одной сессии, встроенный просмотрщик файлов, удаление и проекты-workspaces.

import { readFileSync, writeFileSync, readdirSync, statSync, openSync, readSync, closeSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import {
  userDataDir, PROJECTS_DIR, WO_STATES_DIR, NON_ENVS, JIRA_ENABLED,
  ACTIVE_MS, WORKING_MS, BG_ACTIVE_MS, LIST_CAP, CTX_LIMIT, SYSREM,
  sendJSON, readJsonBody, movePath, oneLine, activeStreams,
  loadProjects, saveProjects, slugForPath, activeProject,
} from './core.mjs';
import {
  woOf, firstString, allStrings, lastString, pickWorkingBranch, pickBaseBranch,
  prettyModel, lastRealModel, lastUsageWindow, countMessages, firstUserWo, columnByAge, isBaseBranch, briefArg,
  buildSessionBlocks,
} from './text.mjs';
import { buildActiveFor, jiraStatus } from './services.mjs';
import { safeDirents } from './skills-mcp.mjs';

// -------- пользовательские теги на сессию (Deck-side, сессии read-only). Ключ = rel-путь файла. --------
// В упакованном app HERE = внутри app.asar (это ФАЙЛ) → запись под HERE даёт ENOTDIR. Пишем в userData (как конфиг/токены).
const tagsFile = () => path.join(userDataDir(), 'deck-tags.json');
let _tags = null;
function loadTags() {
  if (_tags) return _tags;
  try { _tags = JSON.parse(readFileSync(tagsFile(), 'utf8')); if (!_tags || typeof _tags !== 'object') _tags = {}; }
  catch { _tags = {}; }
  return _tags;
}
function getTags(file) { const t = loadTags()[file]; return Array.isArray(t) ? t : []; }
function setTags(file, tags) {
  const map = loadTags();
  const clean = [...new Set((Array.isArray(tags) ? tags : []).map((x) => String(x).trim()).filter(Boolean))].slice(0, 30);
  if (clean.length) map[file] = clean; else delete map[file];
  try { mkdirSync(path.dirname(tagsFile()), { recursive: true }); writeFileSync(tagsFile(), JSON.stringify(map, null, 2)); } catch {}
  return clean;
}
// Имя сессии, заданное пользователем при создании (переопределяет производный из транскрипта title). Стор — как теги.
const namesFile = () => path.join(userDataDir(), 'deck-names.json');
let _names = null;
function loadNames() {
  if (_names) return _names;
  try { _names = JSON.parse(readFileSync(namesFile(), 'utf8')); if (!_names || typeof _names !== 'object') _names = {}; }
  catch { _names = {}; }
  return _names;
}
function nameOf(file) { const n = loadNames()[file]; return (typeof n === 'string' && n.trim()) ? n : ''; }
function setName(file, name) {
  const map = loadNames();
  const clean = String(name || '').trim().slice(0, 120);
  if (clean) map[file] = clean; else delete map[file];
  try { mkdirSync(path.dirname(namesFile()), { recursive: true }); writeFileSync(namesFile(), JSON.stringify(map, null, 2)); } catch {}
  return clean;
}

// -------- dev-workflow состояния (для стадии workflow) --------

function loadWfStates() {
  const map = new Map();
  let entries = [];
  try { entries = readdirSync(WO_STATES_DIR, { withFileTypes: true }); } catch { return map; }
  for (const e of entries) {
    if (!e.isFile() || !/^WO-\d+\.json$/i.test(e.name)) continue;
    try {
      const st = JSON.parse(readFileSync(path.join(WO_STATES_DIR, e.name), 'utf8'));
      const wo = (st.jiraKey && woOf(st.jiraKey)) || woOf(e.name);
      if (wo) map.set(wo, st);
    } catch { /* пропускаем битый файл */ }
  }
  return map;
}
function firstMrUrl(createdMRs) {
  if (!createdMRs || typeof createdMRs !== 'object') return '';
  for (const k of Object.keys(createdMRs)) {
    const v = createdMRs[k];
    if (v && v.url) return v.url;
  }
  return '';
}
// userClarifications (свободный текст dev-workflow) → буллеты для «Заметок для возврата».
function notesFromClarifications(uc) {
  if (!uc || typeof uc !== 'string') return [];
  let parts = uc.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length <= 1) parts = uc.split(/(?<=[.;])\s+(?=[А-ЯA-Z(])/).map((s) => s.trim()).filter(Boolean);
  return parts.slice(0, 6).map((s) => (s.length > 240 ? s.slice(0, 240) + '…' : s));
}

// Стадия сессии по состоянию dev-workflow (порядок: первый матч сверху).
export function wfInfo(st, active) {
  if (!st) return { wfColumn: active ? 'active' : 'todo' };
  const step = st.currentStep | 0;
  const clientMr = st.client && st.client.createdMR ? st.client.createdMR : null;
  const backendUrl = firstMrUrl(st.backend && st.backend.createdMRs);
  const staticsUrl = firstMrUrl(st.statics && st.statics.createdMRs);
  const mrUrl = (clientMr && clientMr.url) || backendUrl || staticsUrl || '';
  const hasMr = !!(clientMr || backendUrl || staticsUrl);
  const build = !!(st.client && st.client.buildTriggered);

  let col;
  if (step >= 13) col = 'done';                                           // влито/завершено
  else if (st.serverApprovalRequired && !st.approvedForMR) col = 'readymerge';
  else if (hasMr) col = st.testedOnSquad ? 'readymerge' : 'qa';           // MR открыт, оттестировано → ждёт мерджа
  else if (build || (step >= 7 && step < 11)) col = 'build';
  else col = active ? 'active' : 'todo';

  // Метки карточки. ВНИМАНИЕ: buildState — приближение по buildTriggered/стадии,
  // не live-статус TeamCity (queued/running/success по Android/iOS) — это отдельная фаза.
  const buildState = (build && step < 13 && (col === 'build' || col === 'qa')) ? 'running'
    : (st.testedOnSquad === true || step >= 13) ? 'done' : 'none';
  const mrState = step >= 13 ? 'merged' : 'open';
  // Внутри «На QA»: отдана на QA/проверена (readyForQA/qaReportPosted/deviceVerified/verifiedLocallyByUser) —
  // иначе ждёт ЛОКАЛЬНОЙ проверки разработчиком (билд готов, но ещё не отдана). Развод по этим полям dev-workflow.
  const handed = !!(st.readyForQA || st.qaReportPosted || st.deviceVerified || st.verifiedLocallyByUser);
  const wfQa = col === 'qa' ? (handed ? 'qa' : 'localcheck') : '';

  // Реальная ветка ЗАДАЧИ из dev-workflow (не ветка cwd-репо, который у Deck-сессий = основной vibecode на preprod).
  const beBranch = (() => { const b = (st.backend && st.backend.branches) || {}; for (const v of Object.values(b)) if (v && String(v).trim()) return String(v); return ''; })();
  const wfBranch = (st.client && st.client.branch) || beBranch || (st.statics && st.statics.branch) || '';

  return {
    wfColumn: col, wfStep: step, wfMr: mrUrl || hasMr, wfBuild: build,
    wfMrUrl: mrUrl || null, wfMrState: mrState, wfBuildState: buildState, wfQa, wfBranch,
  };
}

// Метки скоупа задачи из dev-workflow-состояния (+ cwd сессии): клиентская копия cuN, backend(+сервисы),
// статика, целевой env, замерджено ли. Показываем чипами на карточке и секцией «Скоуп» в рейле.
function clientCu(copy, cwd) {
  let m = String(copy || '').match(/client-unity-(\d+)/);
  if (m) return 'cu' + m[1];
  m = String(cwd || '').match(/client-unity-(\d+)(?:[\\/]|$)/);
  return m ? 'cu' + m[1] : '';
}
export function scopeInfo(st, cwd) {
  if (!st) return { clientCu: clientCu('', cwd), backend: false, changedServices: [], statics: false, targetEnv: '', merged: false };
  const beBranches = (st.backend && st.backend.branches) || {};
  const beHasBranch = Object.values(beBranches).some((v) => v && String(v).trim());
  const changed = (st.backend && Array.isArray(st.backend.changedServices)) ? st.backend.changedServices : [];
  const scope = String(st.scope || '');
  const backend = scope === 'full' || scope === 'backend' || beHasBranch || changed.length > 0;
  const stBranches = (st.statics && st.statics.branches) || {};
  const staticsBr = Object.values(stBranches).some((v) => v && String(v).trim());
  const statics = scope === 'statics' || staticsBr;
  const step = st.currentStep;
  const merged = step === 'done' || (typeof step === 'number' ? step >= 13 : (parseInt(step, 10) || 0) >= 13);
  const targetEnv = NON_ENVS.has(String(st.targetEnv || '')) ? '' : String(st.targetEnv);
  return { clientCu: clientCu(st.client && st.client.copy, cwd), backend, changedServices: changed.slice(0, 6), statics, targetEnv, merged };
}
// Fallback-детект из ТЕКСТА сессии: bugfix-сессии стартуют из центрального репо (cwd=vibecode, gitBranch=preprod), а правят
// клиентскую копию по абсолютным путям и в кастомной ветке — это видно только в переписке. Берём самое частое упоминание.
export function detectClientCuFromText(text) {
  // Приоритет — поля "cwd" записей (реальная рабочая папка Claude Code, менявшаяся по ходу на client-unity-N); частота
  // упоминаний в тексте — лишь фолбэк. Так тег = копия, где РЕАЛЬНО шла работа, а не которую вскользь упомянули.
  const cwdHits = String(text).match(/"cwd"\s*:\s*"[^"]*client-unity-(\d+)/g);
  const src = (cwdHits && cwdHits.length) ? cwdHits : (String(text).match(/client-unity-(\d+)/g) || []);
  if (!src.length) return '';
  const cnt = {};
  for (const h of src) { const n = h.match(/client-unity-(\d+)/)[1]; cnt[n] = (cnt[n] || 0) + 1; }
  const top = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a])[0];
  return top ? 'cu' + top : '';
}
export function detectBranchFromText(text, wo) {
  // Только ветки, начинающиеся с WO САМОЙ сессии — иначе рискуем взять ветку чужой задачи, упомянутой в переписке чаще.
  const w = String(wo || '').toUpperCase();
  if (!w) return '';
  const hits = String(text).match(/\bWO-\d+-[a-z0-9][a-z0-9._-]{2,}/gi) || [];
  const cnt = {};
  for (const h of hits) { if (!h.toUpperCase().startsWith(w + '-')) continue; cnt[h] = (cnt[h] || 0) + 1; }
  return Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a])[0] || '';
}

// -------- сбор списка сессий --------

export function listSessionFiles() {
  let projDirs = [];
  try { projDirs = readdirSync(PROJECTS_DIR, { withFileTypes: true }); } catch { return []; }
  const files = [];
  for (const d of projDirs) {
    if (!d.isDirectory()) continue;
    const projPath = path.join(PROJECTS_DIR, d.name);
    let entries = [];
    try { entries = readdirSync(projPath, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const full = path.join(projPath, e.name);
      let mtime = 0;
      try { mtime = statSync(full).mtimeMs; } catch { continue; }
      files.push({ full, rel: d.name + '/' + e.name, id: e.name.replace(/\.jsonl$/, ''), projDir: d.name, mtime });
    }
  }
  return files;
}

// -------- фоновые сабагенты сессии: <projDir>/<sessionId>/subagents/agent-<id>.jsonl (+ .meta.json) --------
function subagentsDir(projDir, sessionId) { return path.join(PROJECTS_DIR, projDir, sessionId, 'subagents'); }
// ДЁШЕВО (для списка карточек): только statSync mtime, БЕЗ парса содержимого.
function sessionSubagents(projDir, sessionId) {
  let entries;
  try { entries = readdirSync(subagentsDir(projDir, sessionId), { withFileTypes: true }); } catch { return []; }
  const now = Date.now(), dir = subagentsDir(projDir, sessionId), out = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const m = e.name.match(/^agent-(.+)\.jsonl$/);
    if (!m) continue;
    let mtime = 0; try { mtime = statSync(path.join(dir, e.name)).mtimeMs; } catch { continue; }
    out.push({ id: m[1], mtime, running: (now - mtime) < BG_ACTIVE_MS });
  }
  return out;
}
// Хвост файла (последние N байт), отбросив обрезанную первую строку — чтобы дёшево взять последние события.
function readTail(full, bytes) {
  let fd;
  try {
    const sz = statSync(full).size; const start = Math.max(0, sz - bytes); const len = sz - start;
    if (len <= 0) return '';
    fd = openSync(full, 'r'); const buf = Buffer.alloc(len); readSync(fd, buf, 0, len, start);
    let s = buf.toString('utf8');
    if (start > 0) { const nl = s.indexOf('\n'); if (nl >= 0) s = s.slice(nl + 1); }
    return s;
  } catch { return ''; } finally { if (fd !== undefined) { try { closeSync(fd); } catch {} } }
}
// Что агент делает СЕЙЧАС — самый свежий значимый блок его транскрипта.
function agentActivity(tailText) {
  const lines = tailText.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    let ev; try { ev = JSON.parse(lines[i]); } catch { continue; }
    if (ev.type !== 'assistant' && ev.type !== 'user') continue;
    const c = ev.message && ev.message.content;
    if (typeof c === 'string') { const t = c.replace(SYSREM, '').trim(); if (t) return oneLine(t, 90); continue; }
    if (Array.isArray(c)) {
      for (let k = c.length - 1; k >= 0; k--) {
        const b = c[k]; if (!b || typeof b !== 'object') continue;
        if (b.type === 'tool_use') { const a = briefArg(b.input); return '▸ ' + (b.name || 'tool') + (a ? '(' + a + ')' : ''); }
        if (b.type === 'text' && b.text && b.text.trim()) return oneLine(b.text, 90);
        if (b.type === 'thinking' && b.thinking && b.thinking.trim()) return '✻ ' + oneLine(b.thinking, 80);
      }
    }
  }
  return '';
}
function lastUsageIn(tailText) {
  const i = tailText.lastIndexOf('"usage":'); if (i < 0) return 0;
  const seg = tailText.slice(i, i + 400);
  const num = (k) => { const m = seg.match(new RegExp('"' + k + '":(\\d+)')); return m ? +m[1] : 0; };
  return num('input_tokens') + num('cache_read_input_tokens') + num('cache_creation_input_tokens');
}
// ДЕТАЛЬНО (только для ОТКРЫТОЙ сессии): label из .meta.json, текущая активность из хвоста, токены.
function sessionAgentsDetail(projDir, sessionId) {
  const dir = subagentsDir(projDir, sessionId);
  let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const now = Date.now(), out = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const m = e.name.match(/^agent-(.+)\.jsonl$/); if (!m) continue;
    const id = m[1], full = path.join(dir, e.name);
    let mtime = 0; try { mtime = statSync(full).mtimeMs; } catch { continue; }
    let label = '', stopped = false;
    try { const meta = JSON.parse(readFileSync(path.join(dir, 'agent-' + id + '.meta.json'), 'utf8')); label = meta.description || meta.agentType || ''; stopped = !!meta.stoppedByUser; } catch {}
    const tail = readTail(full, 65536);
    out.push({ id, label: label || ('агент ' + id.slice(0, 6)), running: (now - mtime) < BG_ACTIVE_MS, stopped, activity: agentActivity(tail), mtime, tokensIn: lastUsageIn(tail) });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

// TECH-3: дорогая часть summary — парс транскрипта (readFileSync + регэкспы). Всё, что выводится ТОЛЬКО из текста
// файла, стабильно пока не менялся mtime → кэшируем по ключу rel+':'+mtime. Смена mtime = новый ключ = перепарс.
export const _summaryCache = new Map();
function textSummary(f) {
  const key = f.rel + ':' + f.mtime;
  const hit = _summaryCache.get(key);
  if (hit) return hit;
  let text = '';
  try { text = readFileSync(f.full, 'utf8'); } catch { text = ''; }
  const cwd = firstString(text, 'cwd') || '';
  const branchesAll = allStrings(text, 'gitBranch');
  const gitBranch = pickWorkingBranch(branchesAll);        // рабочая (не-базовая) ветка сессии
  const baseBranchText = pickBaseBranch(branchesAll) || '';   // базовая ветка из истории gitBranch (фолбэк — targetEnv, добавляется свежим)
  let title = lastString(text, 'aiTitle');
  const lastPrompt = lastString(text, 'lastPrompt') || '';
  if (!title) title = (lastPrompt || '').split('\n')[0].slice(0, 80) || '(без заголовка)';
  const model = prettyModel(lastRealModel(text));
  const winTokens = lastUsageWindow(text);
  const project = cwd ? path.basename(cwd.replace(/[\\/]+$/, '')) : f.projDir;
  const wo = woOf(gitBranch) || woOf(title) || firstUserWo(text);   // WO: ветка → заголовок → первичный WO из первого промпта
  const c = { cwd, gitBranch, baseBranchText, title, lastPrompt, model, winTokens, msgs: countMessages(text), project, wo, clientCuText: detectClientCuFromText(text), branchText: detectBranchFromText(text, wo) };
  _summaryCache.set(key, c);
  return c;
}
function buildSessionSummary(f, wfStates) {
  const c = textSummary(f);   // кэшируемая (из файла) часть
  // Свежее на каждый вызов: зависит от «сейчас» (время), mtime сабагентов, dev-workflow-состояния и тегов.
  const bgRunning = sessionSubagents(f.projDir, f.id).filter((a) => a.running).length;
  let serverActive = false;
  for (const e of activeStreams.values()) { if (e && e.key === f.id) { serverActive = true; break; } }   // на сервере жив ход этой сессии (авторитетно, не по mtime)
  const active = (Date.now() - f.mtime) < ACTIVE_MS || bgRunning > 0 || serverActive;
  const st = c.wo ? wfStates.get(c.wo) : null;
  const wf = wfInfo(st, active);
  const scope = scopeInfo(st, c.cwd);
  if (!scope.clientCu && c.clientCuText) scope.clientCu = c.clientCuText;   // копия из путей сессии (bugfix правит копию не из своего cwd)
  const workBranch = (c.gitBranch && !isBaseBranch(c.gitBranch)) ? c.gitBranch : (c.branchText || c.gitBranch);   // кастомная ветка из текста, если cwd на базовой
  const baseBranch = c.baseBranchText || scope.targetEnv || '';
  return {
    id: f.id,
    file: f.rel,
    title: nameOf(f.rel) || c.title, lastPrompt: c.lastPrompt, cwd: c.cwd, project: c.project, gitBranch: workBranch, wo: c.wo, model: c.model, baseBranch,
    msgs: c.msgs,
    winTokens: c.winTokens,
    ctxPct: Math.min(c.winTokens / CTX_LIMIT, 1),
    mtime: f.mtime,
    active,
    working: (Date.now() - f.mtime) < WORKING_MS || bgRunning > 0 || serverActive,   // живая генерация ИЛИ фоновый агент ИЛИ живой ход на сервере (не гаснет на долгом инструменте → нет ложного «завершено»)
    serverActive,
    bgRunning,
    wfHasState: !!st,   // есть ли dev-workflow-состояние (спеккит) для этой WO — иначе Jira одна не двигает в продвинутые колонки
    column: columnByAge(f.mtime),
    tags: getTags(f.rel),                            // пользовательские теги (Deck-side)
    ...wf,
    ...scope,
  };
}

export async function apiSessions() {
  let all = listSessionFiles().sort((a, b) => b.mtime - a.mtime);
  const ap = activeProject();
  if (ap) { const id = ap.id.toLowerCase(); all = all.filter((f) => { const d = f.projDir.toLowerCase(); return d === id || d.startsWith(id + '-'); }); }   // скоуп на активный проект (регистронезависимо — на Windows буква диска бывает и D, и d)
  const top = all.slice(0, LIST_CAP);
  const wfStates = loadWfStates();   // читается один раз на запрос
  const sessions = top.map((f) => buildSessionSummary(f, wfStates));
  // Кэш парса ограничиваем текущим набором файлов (изменённые/исчезнувшие ключи выкидываем) — размер ≤ числа сессий.
  const live = new Set(top.map((f) => f.rel + ':' + f.mtime));
  for (const k of _summaryCache.keys()) if (!live.has(k)) _summaryCache.delete(k);

  // ЖИВОЙ билд-статус. Кандидаты = сессии с РАБОЧЕЙ (не-базовой) веткой И (свежая активность ИЛИ stale-флаг
  // dev-workflow). Так ловим реальные ручные/безфлаговые билды по фича-ветке, но НЕ долбим TC по базовым/no-branch/
  // старым todo (80 сессий). Всё параллельно + адаптивный кэш buildActiveFor.
  const buildCands = sessions.filter((s) => s.gitBranch && !isBaseBranch(s.gitBranch) && (s.active || s.wfBuildState === 'running'));
  await Promise.all(buildCands.map(async (s) => { s.buildActive = await buildActiveFor(s.gitBranch, s.wo); }));
  for (const s of sessions) if (s.buildActive === undefined) s.buildActive = false;

  // Резолв Jira на сервере (параллельно, кэш 30с) — чтобы колонки были верны уже на ПЕРВОМ рендере (без прыжков).
  if (JIRA_ENABLED) {
    const wos = [...new Set(sessions.filter((s) => s.wo).map((s) => s.wo))];
    const map = new Map();
    await Promise.all(wos.map(async (wo) => { map.set(wo, await jiraStatus(wo)); }));
    for (const s of sessions) {
      const d = s.wo && map.get(s.wo);
      s.jira = (d && d.available && d.status) ? { status: d.status, category: d.category, available: true } : null;
    }
  } else {
    for (const s of sessions) s.jira = null;
  }

  return { dir: PROJECTS_DIR, statesDir: WO_STATES_DIR, total: all.length, shown: sessions.length, sessions, activeProject: ap ? { id: ap.id, name: ap.name, path: ap.path } : null };
}

// -------- транскрипт одной сессии: массив блоков --------

function resolveSessionPath(relFile) {
  const base = path.resolve(PROJECTS_DIR);
  const resolved = path.resolve(base, relFile || '');
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return { error: 'traversal', code: 400 };
  if (!resolved.endsWith('.jsonl')) return { error: 'not a session file', code: 400 };
  return { resolved };
}

// Артефакты сессии: файлы, которые сессия правила инструментами (Write/Edit/…), плюс всё содержимое
// папки её фичи (docs/specs/features|fixes/<…WO…>). Отдаём относительные пути + вид, для правого рейла.
export function sessionArtifacts(relFile) {
  const rp = resolveSessionPath(relFile);
  if (rp.error) return { cwd: '', wo: '', artifacts: [] };
  let text = '';
  try { text = readFileSync(rp.resolved, 'utf8'); } catch { return { cwd: '', wo: '', artifacts: [] }; }
  const cwd = firstString(text, 'cwd') || '';
  const wo = firstUserWo(text) || '';
  const DOC_EXT = /\.(md|markdown|sql|txt|json|ya?ml|html|csv)$/i;
  const touched = new Set();
  for (const line of text.split('\n')) {
    const s = line.trim(); if (!s || s[0] !== '{') continue;
    let o; try { o = JSON.parse(s); } catch { continue; }
    const content = o && o.message && o.message.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (!c || c.type !== 'tool_use' || !/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(c.name || '')) continue;
      const fp = c.input && (c.input.file_path || c.input.notebook_path);
      if (fp) touched.add(String(fp));
    }
  }
  const featureAbs = new Set();
  if (wo && cwd) {
    for (const base of ['docs/specs/features', 'docs/specs/fixes']) {
      const dir = path.join(cwd, base);
      for (const d of safeDirents(dir)) if (d.isDirectory() && d.name.includes(wo)) {
        const fdir = path.join(dir, d.name);
        for (const f of safeDirents(fdir)) if (f.isFile()) featureAbs.add(path.join(fdir, f.name));
      }
    }
  }
  const kindOf = (name, ext) => {
    const n = name.toLowerCase();
    if (n === 'spec.md') return 'спецификация';
    if (n === 'plan.md') return 'план';
    if (n === 'tasks.md') return 'задачи';
    if (n.startsWith('db-patches')) return 'SQL-патч';
    if (n.startsWith('research') || n.startsWith('check_') || n.startsWith('dashboard') || n.startsWith('report')) return 'заметки';
    return ext ? ext.toUpperCase() : 'файл';
  };
  const seen = new Set(), out = [];
  const addAbs = (abs, fromFeature) => {
    const norm = path.resolve(abs);
    if (seen.has(norm)) return;
    let st; try { st = statSync(norm); if (!st.isFile()) return; } catch { return; }
    const name = path.basename(norm);
    const ext = (name.match(/\.([^.]+)$/) || [])[1] || '';
    const rel = cwd ? path.relative(cwd, norm).split(path.sep).join('/') : name;
    seen.add(norm);
    out.push({ name, rel, ext, kind: kindOf(name, ext), touched: touched.has(abs), feature: !!fromFeature, mtime: st.mtimeMs });
  };
  for (const abs of featureAbs) addAbs(abs, true);
  for (const abs of touched) if (DOC_EXT.test(abs)) addAbs(abs, false);
  out.sort((a, b) => (a.feature ? 0 : 1) - (b.feature ? 0 : 1) || b.mtime - a.mtime);
  return { cwd, wo, artifacts: out.slice(0, 80) };
}

export function apiSession(relFile) {
  const rp = resolveSessionPath(relFile);
  if (rp.error) return rp;
  let text = '';
  try { text = readFileSync(rp.resolved, 'utf8'); } catch { return { error: 'not found', code: 404 }; }

  const { blocks, model, cwd, branches, winTokens, msgCount } = buildSessionBlocks(text);
  let title = lastString(text, 'aiTitle');
  const lastPrompt = lastString(text, 'lastPrompt') || '';
  if (!title) title = lastPrompt.split('\n')[0].slice(0, 80) || '(без заголовка)';
  const gitBranch = pickWorkingBranch(branches);
  const mtime = (() => { try { return statSync(rp.resolved).mtimeMs; } catch { return 0; } })();
  // WO: рабочая ветка → заголовок → первичный WO из первого промпта
  const wo = woOf(gitBranch) || woOf(title) || firstUserWo(text);
  const projDir = path.basename(path.dirname(rp.resolved));
  const sessionId = path.basename(rp.resolved).replace(/\.jsonl$/, '');
  const agents = sessionAgentsDetail(projDir, sessionId);   // деталь: label/activity/tokens (открытая сессия — парсить можно)
  const bgRunning = agents.filter((a) => a.running).length;
  const active = (Date.now() - mtime) < ACTIVE_MS || bgRunning > 0;
  // Стадия/билд/MR/скоуп из dev-workflow — те же поля, что и на карточке, чтобы правый рейл их отражал.
  const st = wo ? loadWfStates().get(wo) : null;
  const wf = wfInfo(st, active);
  const scope = scopeInfo(st, cwd);
  if (!scope.clientCu){ const cu = detectClientCuFromText(text); if (cu) scope.clientCu = cu; }   // копия из путей сессии (правит копию не из своего cwd)
  const workBranch = (gitBranch && !isBaseBranch(gitBranch)) ? gitBranch : (detectBranchFromText(text, wo) || gitBranch);   // кастомная ветка (по WO сессии), если cwd на базовой
  const baseBranch = pickBaseBranch(branches) || scope.targetEnv || '';
  const notes = notesFromClarifications(st && st.userClarifications);
  return {
    id: sessionId,
    file: relFile,
    title: nameOf(relFile) || title, lastPrompt, cwd,
    project: cwd ? path.basename(cwd.replace(/[\\/]+$/, '')) : '',
    gitBranch: workBranch, baseBranch,
    wo,
    model: prettyModel(model),
    winTokens,
    ctxPct: Math.min(winTokens / CTX_LIMIT, 1),
    mtime,
    active,
    working: (Date.now() - mtime) < WORKING_MS || bgRunning > 0,
    bgRunning,
    agents,
    blocks,
    count: msgCount,
    notes,
    tags: getTags(relFile),
    ...wf,
    ...scope,
  };
}

// Живой статус фоновых агентов открытой сессии (клиент опрашивает раз в несколько секунд).
export function apiAgents(relFile) {
  const rp = resolveSessionPath(relFile);
  if (rp.error) return rp;
  const projDir = path.basename(path.dirname(rp.resolved));
  const sessionId = path.basename(rp.resolved).replace(/\.jsonl$/, '');
  const agents = sessionAgentsDetail(projDir, sessionId);
  return { agents, bgRunning: agents.filter((a) => a.running).length };
}

// Текущая активность хода из последнего блока ленты — «что именно делает Claude» для строки индикатора.
// tool без result → инструмент ВЫПОЛНЯЕТСЯ; thinking → размышляет; assistant-текст → пишет ответ; иначе — общий «работает».
export function tailActivity(blocks) {
  const b = blocks[blocks.length - 1];
  if (!b) return '';
  if (b.kind === 'tool') return b.result ? '' : ('⚙ ' + b.name + (b.arg ? ' · ' + String(b.arg).slice(0, 48) : ''));
  if (b.kind === 'thinking') return '✻ размышляет';
  if (b.kind === 'assistant') return '✍ пишет ответ';
  return '';
}
// Инкремент для live-tail: те же блоки, но отдаём только «хвост» после индекса after (poll+diff по числу блоков).
export function apiSessionTail(relFile, after) {
  const rp = resolveSessionPath(relFile);
  if (rp.error) return rp;
  let text = '';
  try { text = readFileSync(rp.resolved, 'utf8'); } catch { return { error: 'not found', code: 404 }; }
  const { blocks, winTokens, lastUserTs } = buildSessionBlocks(text);
  const mtime = (() => { try { return statSync(rp.resolved).mtimeMs; } catch { return 0; } })();
  const a = Math.max(0, after | 0);
  const key = path.basename(rp.resolved).replace(/\.jsonl$/, '');
  let serverActive = false;
  for (const e of activeStreams.values()) { if (e && e.key === key) { serverActive = true; break; } }   // на сервере есть живой ход этой сессии
  return {
    count: blocks.length,
    blocks: a < blocks.length ? blocks.slice(a) : [],
    winTokens,
    ctxPct: Math.min(winTokens / CTX_LIMIT, 1),
    mtime,
    turnStartTs: lastUserTs,   // старт текущего хода — для таймера «работает… Nс» при перезаходе
    active: (Date.now() - mtime) < ACTIVE_MS,
    working: (Date.now() - mtime) < WORKING_MS,
    serverActive,   // авторитетно: на сервере ЕСТЬ активный ход этой сессии → индикатор держится даже в паузах записи (>20с без изменений файла)
    activity: tailActivity(blocks),   // «что делает» — для строки индикатора при перезаходе/фоне
  };
}

// -------- встроенный просмотрщик файла + безопасное удаление сессии --------

// Чтение текстового файла для встроенного просмотрщика (клик по ссылке .md/.txt в выводе). ТОЛЬКО в пределах cwd
// сессии — Deck слушает localhost, произвольный FS читать нельзя. :line-суффикс снимаем; бинарь/вне cwd → отказ (клиент
// откроет во внешнем приложении). Размер режем VIEWER_MAX.
const VIEWER_TEXT_EXT = new Set(['md','markdown','txt','json','yml','yaml','toml','ini','cfg','conf','log','csv','tsv','sql','sh','bash','ps1','py','js','mjs','cjs','ts','tsx','jsx','cs','go','rs','java','kt','c','h','cpp','hpp','css','html','xml','patch','diff','env','gitignore','dockerfile']);
const VIEWER_MAX = 2 * 1024 * 1024;
export function apiFile(res, u) {
  let p = String(u.searchParams.get('path') || '').trim();
  const cwd = String(u.searchParams.get('cwd') || '').trim();
  if (!p) { sendJSON(res, { ok: false, error: 'empty' }, 400); return; }
  if (!cwd) { sendJSON(res, { ok: false, error: 'no cwd' }, 400); return; }
  p = p.replace(/:\d+(?::\d+)?$/, '');                                   // file.md:42[:col] → file.md
  const base = path.resolve(cwd);
  const abs = path.resolve(base, p);                                     // относительный → от cwd; абсолютный — как есть
  if (abs !== base && !abs.startsWith(base + path.sep)) { sendJSON(res, { ok: false, outside: true }, 200); return; }   // не читаем вне cwd
  const name = path.basename(abs);
  const ext = (name.match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
  const isText = VIEWER_TEXT_EXT.has(ext) || !/\.[a-z0-9]+$/i.test(name);   // без расширения — пробуем как текст
  if (!isText) { sendJSON(res, { ok: false, binary: true, name }, 200); return; }
  let st; try { st = statSync(abs); } catch { sendJSON(res, { ok: false, notfound: true }, 200); return; }
  if (!st.isFile()) { sendJSON(res, { ok: false, error: 'not a file' }, 200); return; }
  let text; try { text = readFileSync(abs, 'utf8'); } catch (e) { sendJSON(res, { ok: false, error: String((e && e.message) || e) }, 200); return; }
  let truncated = false;
  if (text.length > VIEWER_MAX) { text = text.slice(0, VIEWER_MAX); truncated = true; }
  sendJSON(res, { ok: true, name, ext, text, truncated });
}
// БЕЗОПАСНОЕ удаление: НЕ rm, а перенос .jsonl (+ каталог сабагентов) в <repo>/deck-trash/<ts>-<basename> (восстановимо).
export async function apiDeleteSession(req, res) {
  let body;
  try { body = await readJsonBody(req, 64 * 1024); }
  catch (e) { sendJSON(res, { error: (e && e.message) || 'read error' }, 400); return; }
  const rp = resolveSessionPath(String(body.file || ''));
  if (rp.error) { sendJSON(res, { error: rp.error }, rp.code || 400); return; }
  try {
    const base = path.basename(rp.resolved);
    const sessionId = base.replace(/\.jsonl$/, '');
    const trashDir = path.join(userDataDir(), 'deck-trash');   // userData, не HERE (в сборке HERE в asar → ENOTDIR)
    mkdirSync(trashDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');   // сервер — не воркфлоу-скрипт, Node Date разрешён
    const dest = path.join(trashDir, ts + '-' + base);
    movePath(rp.resolved, dest);                                  // .jsonl → корзина (через диски — copy+remove)
    const subs = path.join(path.dirname(rp.resolved), sessionId); // каталог сабагентов рядом, если есть
    let subsMoved = false;
    if (existsSync(subs)) { try { movePath(subs, path.join(trashDir, ts + '-' + sessionId)); subsMoved = true; } catch {} }
    delete loadTags()[body.file];                                 // теги удалённой сессии тоже чистим
    try { writeFileSync(tagsFile(), JSON.stringify(loadTags(), null, 2)); } catch {}
    sendJSON(res, { ok: true, trash: dest, subsMoved });
  } catch (e) {
    sendJSON(res, { error: (e && e.message) || String(e) }, 500);
  }
}
export async function apiTags(req, res) {   // POST {file, tags:[...]} — перезаписывает набор тегов сессии, персист на диск
  let body;
  try { body = await readJsonBody(req, 256 * 1024); }
  catch (e) { sendJSON(res, { error: (e && e.message) || 'read error' }, 400); return; }
  const file = String(body.file || '');
  if (!file) { sendJSON(res, { error: 'no file' }, 400); return; }
  const tags = setTags(file, body.tags);
  sendJSON(res, { file, tags });
}
export async function apiSessionName(req, res) {   // POST {file, name} — заданное пользователем имя сессии (override title)
  let body;
  try { body = await readJsonBody(req, 8 * 1024); }
  catch (e) { sendJSON(res, { error: (e && e.message) || 'read error' }, 400); return; }
  const file = String(body.file || '');
  if (!file) { sendJSON(res, { error: 'no file' }, 400); return; }
  const name = setName(file, body.name);   // nameOf() применяется при сборке сессии → override виден сразу
  sendJSON(res, { file, name });
}

// Проекты: GET — список + активный; POST {action:add|remove|select, path?|id?} — правит список/активный.
export async function apiProjects(req, res) {
  if (req.method === 'POST') {
    let body; try { body = await readJsonBody(req, 64 * 1024); } catch { sendJSON(res, { error: 'bad body' }, 400); return; }
    const action = String(body.action || '');
    let { projects, activeId } = loadProjects();
    if (action === 'add') {
      const p = String(body.path || '').trim(); if (!p) { sendJSON(res, { error: 'no path' }, 400); return; }
      const id = slugForPath(p);
      if (!projects.some((x) => x.id === id)) projects = [...projects, { id, name: path.basename(p) || p, path: p }];
      activeId = id;
    } else if (action === 'remove') {
      const id = String(body.id || ''); projects = projects.filter((x) => x.id !== id);
      if (activeId === id) activeId = projects.length ? projects[0].id : '';
    } else if (action === 'select') {
      activeId = String(body.id || '');   // '' = все проекты (без скоупа)
    } else { sendJSON(res, { error: 'bad action' }, 400); return; }
    saveProjects(projects, activeId);
    sendJSON(res, { projects, activeId });
    return;
  }
  const { projects, activeId } = loadProjects();
  sendJSON(res, { projects, activeId });
}
