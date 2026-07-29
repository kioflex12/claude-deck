// Deck — локальная веб-доска сессий Claude Code.
// Zero-dep Node-сервер: сканирует папку ~/.claude/projects, отдаёт список
// сессий (/api/sessions) и полный транскрипт одной сессии блоками
// (/api/session), плюс страницу index.html. index.html перечитывается на
// каждый запрос (правь и жми F5); server.mjs требует рестарта node.
//
// Папка сессий:   env CLAUDE_PROJECTS_DIR -> дефолт ~/.claude/projects.
// Папка состояний dev-workflow (для вкладки «Статусы»):
//                 env WO_STATES_DIR -> дефолт ниже.

import http from 'node:http';
import { readFileSync, writeFileSync, readdirSync, statSync, openSync, readSync, closeSync, mkdirSync, renameSync, existsSync, cpSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, execFile, execSync } from 'node:child_process';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// zero-dep .env парсер: простой KEY=VALUE, игнор #/пустых, trim, снятие кавычек. Возвращает объект пар.
function parseEnvText(raw) {
  const out = {};
  for (const line of String(raw || '').split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s[0] === '#') continue;
    const eq = s.indexOf('=');
    if (eq < 1) continue;
    const key = s.slice(0, eq).trim();
    let val = s.slice(eq + 1).trim();
    if (val.length >= 2 && ((val[0] === '"' && val.endsWith('"')) || (val[0] === "'" && val.endsWith("'")))) val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}
function parseEnvFile(p) { try { return parseEnvText(readFileSync(p, 'utf8')); } catch { return null; } }
// Подхватываем <repo>/.env при старте, НЕ перезаписывая уже заданное в окружении (source-режим; в установленном
// app HERE = внутри asar, .env там нет — концы токенов тянет «Подтянуть токены» из явного пути, см. secretsEnvCandidates).
(function loadDotEnv() {
  const env = parseEnvFile(path.join(HERE, '.env'));
  if (env) for (const [k, v] of Object.entries(env)) if (!(k in process.env)) process.env[k] = v;
})();

const PORT = Number(process.env.PORT) || 4317;

// -------- Конфиг Deck (TECH-6): userData/deck-config.json в Electron, иначе рядом с server.mjs. --------
// Резолв значений: config → env/.env → дефолт. Хардкода пути WO_STATES_DIR больше НЕТ: пусто → доска мягко деградирует.
const _require = createRequire(import.meta.url);
let _electron;
function getElectron() {
  if (_electron !== undefined) return _electron;
  _electron = null;
  // Реальный API `electron` есть только внутри Electron-main; в standalone `require('electron')` даёт строку-путь — не трогаем.
  if (process.versions.electron) { try { _electron = _require('electron'); } catch {} }
  return _electron;
}
function userDataDir() { const e = getElectron(); if (e && e.app) { try { return e.app.getPath('userData'); } catch {} } return HERE; }
function configFile() { return path.join(userDataDir(), 'deck-config.json'); }
function loadConfig() { try { const c = JSON.parse(readFileSync(configFile(), 'utf8')); return (c && typeof c === 'object') ? c : {}; } catch { return {}; } }
function saveConfig(patch) {
  const c = loadConfig();
  for (const k of ['woStatesDir', 'claudeProjectsDir', 'jiraHost', 'jiraEmail', 'teamcityHost', 'gitlabHost', 'clientUnityParent', 'unityEditorsDir', 'unityHubPath', 'secretsEnvPath']) if (k in patch) c[k] = String(patch[k] || '');
  try { mkdirSync(path.dirname(configFile()), { recursive: true }); writeFileSync(configFile(), JSON.stringify(c, null, 2)); return true; } catch { return false; }
}
// Секретные токены (Jira/TeamCity/GitLab): в Electron шифруем safeStorage'ом (как update-token в D3) в userData/<svc>-token.bin;
// в standalone безопасно сохранить нельзя — фолбэк на .env (<SVC>_TOKEN).
function tokenFile(service) { return path.join(userDataDir(), service + '-token.bin'); }
function readTokenSecure(service) {
  const e = getElectron();
  if (e && e.safeStorage) { try { if (e.safeStorage.isEncryptionAvailable()) return e.safeStorage.decryptString(readFileSync(tokenFile(service))) || ''; } catch {} }
  return '';
}
function writeTokenSecure(service, tok) {
  tok = String(tok || '');
  if (!tok) { try { rmSync(tokenFile(service), { force: true }); } catch {} return { ok: true, cleared: true }; }
  const e = getElectron();
  if (e && e.safeStorage && e.safeStorage.isEncryptionAvailable()) {
    try { mkdirSync(path.dirname(tokenFile(service)), { recursive: true }); writeFileSync(tokenFile(service), e.safeStorage.encryptString(tok)); return { ok: true, storage: 'safeStorage' }; }
    catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
  }
  return { ok: false, standalone: true };   // standalone — задать токен можно только через .env
}

let PROJECTS_DIR, WO_STATES_DIR, JIRA_HOST, JIRA_EMAIL, JIRA_TOKEN, JIRA_ENABLED, TC_HOST, TC_TOKEN, GL_HOST, GL_TOKEN;
function applyConfig() {
  const c = loadConfig();
  PROJECTS_DIR = c.claudeProjectsDir || process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
  WO_STATES_DIR = c.woStatesDir || process.env.WO_STATES_DIR || '';
  JIRA_HOST = String(c.jiraHost || process.env.JIRA_HOST || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  JIRA_EMAIL = c.jiraEmail || process.env.JIRA_EMAIL || '';
  JIRA_TOKEN = readTokenSecure('jira') || process.env.JIRA_TOKEN || '';
  JIRA_ENABLED = !!(JIRA_TOKEN && JIRA_EMAIL && JIRA_HOST);
  // Хосты без зашитых дефолтов: задаются в ⚙/«Подтянуть»/env. Пусто → фича молча выключена (плашка сервисов подскажет).
  // Так публично раздаваемый бинарник не содержит внутренних адресов инфраструктуры.
  TC_HOST = String(c.teamcityHost || process.env.TEAMCITY_HOST || '').replace(/\/$/, '');
  TC_TOKEN = readTokenSecure('teamcity') || process.env.TEAMCITY_TOKEN || '';
  GL_HOST = String(c.gitlabHost || process.env.GITLAB_HOST || '').replace(/\/$/, '');
  GL_TOKEN = readTokenSecure('gitlab') || process.env.GITLAB_TOKEN || '';
}
applyConfig();
const CTX_LIMIT = 1_000_000;          // сессии на 1M-контексте
const ACTIVE_MS = 30 * 60 * 1000;     // «активна», если mtime моложе 30 минут
const WORKING_MS = 20 * 1000;         // «работает сейчас»: файл сессии писался < 20с назад (живая генерация)
const BG_ACTIVE_MS = 60 * 1000;       // фоновый сабагент «живой», если его файл писался < 60с назад
const LIST_CAP = 150;                 // сколько самых свежих сессий листаем
const MSG_CAP = 8000;                 // максимум символов на текстовый блок транскрипта
const SYSREM = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

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

// -------- дешёвые экстракторы по сырому тексту (без JSON.parse каждой строки) --------

function lastString(text, key) {
  const re = new RegExp('"' + key + '":"((?:[^"\\\\]|\\\\.)*)"', 'g');
  let m, last = null;
  while ((m = re.exec(text)) !== null) last = m[1];
  if (last === null) return null;
  try { return JSON.parse('"' + last + '"'); } catch { return last; }
}
function firstString(text, key) {
  const m = text.match(new RegExp('"' + key + '":"((?:[^"\\\\]|\\\\.)*)"'));
  if (!m) return null;
  try { return JSON.parse('"' + m[1] + '"'); } catch { return m[1]; }
}
function allStrings(text, key) {
  const re = new RegExp('"' + key + '":"((?:[^"\\\\]|\\\\.)*)"', 'g');
  const out = []; let m;
  while ((m = re.exec(text)) !== null) { let v; try { v = JSON.parse('"' + m[1] + '"'); } catch { v = m[1]; } out.push(v); }
  return out;
}
// Рабочая ветка сессии: в файле gitBranch часто скачет (старт/после cleanup — базовая preprod/preupdate).
// Берём НЕ-базовую, предпочитая WO-ветку; если несколько не-базовых — последнюю; если только базовые — последнюю.
const BASE_BRANCHES = new Set(['preprod', 'preupdate', 'master', 'main', 'develop', 'dev', 'prod', 'release', 'head', '']);
function isBaseBranch(b) { return BASE_BRANCHES.has(String(b || '').trim().toLowerCase()); }
function pickWorkingBranch(branches) {
  const uniq = [];
  for (const b of branches) { if (b && !uniq.includes(b)) uniq.push(b); }
  if (!uniq.length) return '';
  const nonBase = uniq.filter((b) => !BASE_BRANCHES.has(String(b).toLowerCase()));
  const wo = nonBase.filter((b) => /WO-\d+/.test(b));
  if (wo.length) return wo[wo.length - 1];
  if (nonBase.length) return nonBase[nonBase.length - 1];
  return uniq[uniq.length - 1];
}
// Базовая ветка (источник форка рабочей ветки) = первая базовая из истории gitBranch сессии; иначе '' (фолбэк на targetEnv у вызывающего).
function pickBaseBranch(branches) {
  const empty = new Set(['', 'head']);
  for (const b of branches) { const s = String(b || '').trim(); if (s && !empty.has(s.toLowerCase()) && isBaseBranch(s)) return s; }
  return '';
}
// Первичный WO из первого человеческого промпта: у сессии-уборки ветка = preprod, WO нет в ветке/заголовке,
// но он есть в первом user-сообщении (напр. ссылка .../browse/WO-13914). Сканируем первые ~5 человеческих реплик.
function firstUserWo(text) {
  let idx = 0, seen = 0;
  while (idx < text.length && seen < 5) {
    const nl = text.indexOf('\n', idx);
    const line = nl === -1 ? text.slice(idx) : text.slice(idx, nl);
    idx = nl === -1 ? text.length : nl + 1;
    if (!line.includes('"type":"user"')) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type !== 'user') continue;
    const c = ev.message && ev.message.content;
    let s = '';
    if (typeof c === 'string') s = c;
    else if (Array.isArray(c)) s = c.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join(' ');
    s = s.replace(SYSREM, '').trim();
    if (!s) continue;                 // пропускаем user-события с одними tool_result
    seen++;
    const m = s.match(/WO-\d+/);
    if (m) return m[0];
  }
  return '';
}
function lastUsageWindow(text) {
  const i = text.lastIndexOf('"usage":');
  if (i < 0) return 0;
  const seg = text.slice(i, i + 500);
  const num = (k) => { const m = seg.match(new RegExp('"' + k + '":(\\d+)')); return m ? +m[1] : 0; };
  return num('input_tokens') + num('cache_read_input_tokens') + num('cache_creation_input_tokens');
}
function countMessages(text) {
  return (text.match(/"type":"user"/g) || []).length + (text.match(/"type":"assistant"/g) || []).length;
}
function prettyModel(m) {
  if (!m || /^<.*>$/.test(m)) return '—';   // '<synthetic>' и прочие служебные псевдо-модели → «—», не показываем сырьём
  const x = m.match(/(opus|sonnet|haiku)-(\d+)-(\d+)/i);
  if (x) return x[1][0].toUpperCase() + x[1].slice(1).toLowerCase() + ' ' + x[2] + '.' + x[3];
  return m.replace(/^claude-/, '');
}
// Последняя РЕАЛЬНАЯ модель: Claude Code метит служебные авто-сообщения ассистента "model":"<synthetic>" —
// берём последнее значение model, не обёрнутое в <...> (иначе на чип попадает <synthetic>).
function lastRealModel(text) {
  const all = allStrings(text, 'model');
  for (let i = all.length - 1; i >= 0; i--) { const m = all[i]; if (m && !/^<.*>$/.test(m)) return m; }
  return '';
}
const woOf = (s) => { const m = String(s || '').match(/WO-\d+/); return m ? m[0] : ''; };

function columnByAge(mtimeMs) {
  const age = Date.now() - mtimeMs;
  if (age < 24 * 3600 * 1000) return 'today';
  if (age < 7 * 24 * 3600 * 1000) return 'week';
  return 'older';
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
function wfInfo(st, active) {
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
const NON_ENVS = new Set(['null', 'без деплоя', 'local', '']);
function clientCu(copy, cwd) {
  let m = String(copy || '').match(/client-unity-(\d+)/);
  if (m) return 'cu' + m[1];
  m = String(cwd || '').match(/client-unity-(\d+)(?:[\\/]|$)/);
  return m ? 'cu' + m[1] : '';
}
function scopeInfo(st, cwd) {
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

// -------- сбор списка сессий --------

function listSessionFiles() {
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
const _summaryCache = new Map();
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
  const c = { cwd, gitBranch, baseBranchText, title, lastPrompt, model, winTokens, msgs: countMessages(text), project, wo };
  _summaryCache.set(key, c);
  return c;
}
function buildSessionSummary(f, wfStates) {
  const c = textSummary(f);   // кэшируемая (из файла) часть
  // Свежее на каждый вызов: зависит от «сейчас» (время), mtime сабагентов, dev-workflow-состояния и тегов.
  const bgRunning = sessionSubagents(f.projDir, f.id).filter((a) => a.running).length;
  const active = (Date.now() - f.mtime) < ACTIVE_MS || bgRunning > 0;
  const st = c.wo ? wfStates.get(c.wo) : null;
  const wf = wfInfo(st, active);
  const scope = scopeInfo(st, c.cwd);
  const baseBranch = c.baseBranchText || scope.targetEnv || '';
  return {
    id: f.id,
    file: f.rel,
    title: nameOf(f.rel) || c.title, lastPrompt: c.lastPrompt, cwd: c.cwd, project: c.project, gitBranch: c.gitBranch, wo: c.wo, model: c.model, baseBranch,
    msgs: c.msgs,
    winTokens: c.winTokens,
    ctxPct: Math.min(c.winTokens / CTX_LIMIT, 1),
    mtime: f.mtime,
    active,
    working: (Date.now() - f.mtime) < WORKING_MS || bgRunning > 0,   // живая генерация ИЛИ живой фоновый агент
    bgRunning,
    wfHasState: !!st,   // есть ли dev-workflow-состояние (спеккит) для этой WO — иначе Jira одна не двигает в продвинутые колонки
    column: columnByAge(f.mtime),
    tags: getTags(f.rel),                            // пользовательские теги (Deck-side)
    ...wf,
    ...scope,
  };
}

async function apiSessions() {
  const all = listSessionFiles().sort((a, b) => b.mtime - a.mtime);
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

  return { dir: PROJECTS_DIR, statesDir: WO_STATES_DIR, total: all.length, shown: sessions.length, sessions };
}

// -------- транскрипт одной сессии: массив блоков --------

const RESULT_CAP = 4000;   // tool-результат: почти полный (в UI свёрнут, разворот по клику)
const oneLine = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
const cap = (s) => (s.length > MSG_CAP ? s.slice(0, MSG_CAP) + '\n…' : s);

function briefArg(input) {
  if (!input || typeof input !== 'object') return '';
  const keys = ['file_path', 'path', 'notebook_path', 'pattern', 'query', 'command', 'url', 'skill', 'subagent_type', 'description', 'prompt', 'glob', 'old_string'];
  for (const k of keys) {
    if (input[k] != null) { const v = typeof input[k] === 'string' ? input[k] : JSON.stringify(input[k]); return oneLine(v, 64); }
  }
  for (const k of Object.keys(input)) { if (typeof input[k] === 'string') return oneLine(input[k], 64); }
  return '';
}
// Почти полный текст tool-результата (в UI свёрнут, разворачивается по клику; переносы строк сохраняем).
function briefResult(content) {
  let s = '';
  if (typeof content === 'string') s = content;
  else if (Array.isArray(content)) {
    const parts = [];
    for (const b of content) {
      if (!b) continue;
      if (typeof b === 'string') parts.push(b);
      else if (b.type === 'text' && b.text) parts.push(b.text);
      else if (b.type === 'tool_reference' && b.tool_name) parts.push('→ ' + b.tool_name);
      else if (b.type === 'image') parts.push('[image]');
    }
    s = parts.join('\n');
  } else if (content != null) s = String(content);
  s = s.trim();
  return s.length > RESULT_CAP ? s.slice(0, RESULT_CAP) + '\n…' : s;
}

// Разбор транскрипта в ЛЕНТУ отдельных блоков. Каждый content-элемент каждой user/assistant-строки
// jsonl = свой блок (kind: user | assistant | thinking | tool) — ничего не склеиваем. Токены хода
// (message.usage) вешаются метой на последний текст/thinking-блок сообщения.
// Классификация user-текста по происхождению: не всякая user-строка jsonl — человек. Служебные инжекты
// (загрузка скиллов помечены ev.isMeta — фильтруется выше), task-notification, вызовы команд, interrupt,
// Caveat/local-command-stdout — это шум, который нельзя рисовать как «Ты».
function classifyUserBlock(rawText) {
  const t = String(rawText || '').replace(SYSREM, '').trim();
  if (!t) return null;
  if (t.startsWith('Caveat:') || t.includes('<local-command-stdout>')) return null;   // чистый шум — пропускаем
  if (t.includes('<task-notification>')) return { kind: 'system', text: '⚙ фоновая задача' };
  if (t.startsWith('[Request interrupted')) return { kind: 'system', text: '⛔ прервано пользователем' };
  const cmd = t.match(/<command-name>([\s\S]*?)<\/command-name>/);
  if (cmd) { const name = cmd[1].trim().replace(/^\//, ''); return { kind: 'command', text: '/' + name }; }
  return { kind: 'user', text: cap(t) };
}
function buildSessionBlocks(text) {
  const blocks = [];
  const toolById = {};
  let model = '', cwd = '', winTokens = 0, msgCount = 0;
  const branches = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type !== 'user' && ev.type !== 'assistant') continue;
    const msg = ev.message || {};
    if (!cwd && ev.cwd) cwd = ev.cwd;
    if (ev.gitBranch) branches.push(ev.gitBranch);
    msgCount++;
    const role = ev.type === 'assistant' ? 'assistant' : 'user';
    // Служебная вставка (загрузка скилла / ре-инвок) — не человек, блок не создаём.
    if (role === 'user' && ev.isMeta === true) continue;
    if (role === 'assistant' && msg.model && !/^<.*>$/.test(msg.model)) model = msg.model;   // игнорим <synthetic> — иначе модель сессии слетает на служебную
    const start = blocks.length;
    const content = msg.content;
    if (typeof content === 'string') {
      if (role === 'user') { const c = classifyUserBlock(content); if (c) blocks.push(c); }
      else { const t = content.replace(SYSREM, '').trim(); if (t) blocks.push({ kind: role, text: cap(t) }); }
    } else if (Array.isArray(content)) {
      for (const b of content) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text' && b.text && b.text.trim()) {
          if (role === 'user') { const c = classifyUserBlock(b.text); if (c) blocks.push(c); }
          else blocks.push({ kind: role, text: cap(b.text.trim()) });
        }
        else if (b.type === 'thinking' && b.thinking && b.thinking.trim()) blocks.push({ kind: 'thinking', text: cap(b.thinking.trim()) });
        else if (b.type === 'tool_use') { const blk = { kind: 'tool', name: b.name || 'tool', arg: briefArg(b.input), result: '' }; if (b.id) toolById[b.id] = blk; blocks.push(blk); }
        else if (b.type === 'tool_result') { const blk = b.tool_use_id && toolById[b.tool_use_id]; if (blk) blk.result = briefResult(b.content); }
        // image — скрываем
      }
    }
    if (role === 'assistant' && msg.usage) {
      const u = msg.usage;
      const tin = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      const tout = u.output_tokens || 0;
      winTokens = tin;
      for (let k = blocks.length - 1; k >= start; k--) {
        if (blocks[k].kind === 'assistant' || blocks[k].kind === 'thinking') { blocks[k].meta = { in: tin, out: tout, ctxPct: Math.min(tin / CTX_LIMIT, 1) }; break; }
      }
    }
  }
  return { blocks, model, cwd, branches, winTokens, msgCount };
}

function resolveSessionPath(relFile) {
  const base = path.resolve(PROJECTS_DIR);
  const resolved = path.resolve(base, relFile || '');
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return { error: 'traversal', code: 400 };
  if (!resolved.endsWith('.jsonl')) return { error: 'not a session file', code: 400 };
  return { resolved };
}

function apiSession(relFile) {
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
  const baseBranch = pickBaseBranch(branches) || scope.targetEnv || '';
  const notes = notesFromClarifications(st && st.userClarifications);
  return {
    id: sessionId,
    file: relFile,
    title: nameOf(relFile) || title, lastPrompt, cwd,
    project: cwd ? path.basename(cwd.replace(/[\\/]+$/, '')) : '',
    gitBranch, baseBranch,
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
function apiAgents(relFile) {
  const rp = resolveSessionPath(relFile);
  if (rp.error) return rp;
  const projDir = path.basename(path.dirname(rp.resolved));
  const sessionId = path.basename(rp.resolved).replace(/\.jsonl$/, '');
  const agents = sessionAgentsDetail(projDir, sessionId);
  return { agents, bgRunning: agents.filter((a) => a.running).length };
}

// Инкремент для live-tail: те же блоки, но отдаём только «хвост» после индекса after (poll+diff по числу блоков).
function apiSessionTail(relFile, after) {
  const rp = resolveSessionPath(relFile);
  if (rp.error) return rp;
  let text = '';
  try { text = readFileSync(rp.resolved, 'utf8'); } catch { return { error: 'not found', code: 404 }; }
  const { blocks, winTokens } = buildSessionBlocks(text);
  const mtime = (() => { try { return statSync(rp.resolved).mtimeMs; } catch { return 0; } })();
  const a = Math.max(0, after | 0);
  return {
    count: blocks.length,
    blocks: a < blocks.length ? blocks.slice(a) : [],
    winTokens,
    ctxPct: Math.min(winTokens / CTX_LIMIT, 1),
    mtime,
    active: (Date.now() - mtime) < ACTIVE_MS,
    working: (Date.now() - mtime) < WORKING_MS,
  };
}

// -------- скиллы/команды по cwd сессии (для «/» в композере) --------

const SKILLS_CACHE = new Map();
function safeDirents(dir) { try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; } }
function readFrontmatter(file) {
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { return null; }
  const m = text.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return { name: '', description: '' };
  const lines = m[1].split(/\r?\n/);
  let name = '', description = '', cat = '', trig = '';
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z0-9_-]+):[ \t]*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let val = kv[2];
    if (/^[|>][+-]?\s*$/.test(val)) {                    // YAML block scalar (folded > / literal |)
      const baseIndent = (lines[i].match(/^\s*/) || [''])[0].length;
      const collected = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        if (/^\s*$/.test(lines[j])) { collected.push(''); continue; }
        if ((lines[j].match(/^\s*/) || [''])[0].length <= baseIndent) break;
        collected.push(lines[j].trim());
      }
      i = j - 1;
      val = collected.join(val[0] === '|' ? '\n' : ' ').trim();
    } else {
      val = val.trim();
      if (val.length >= 2 && ((val[0] === '"' && val.endsWith('"')) || (val[0] === "'" && val.endsWith("'")))) val = val.slice(1, -1);
    }
    if (key === 'name' && !name) name = val;
    else if (key === 'description' && !description) description = val;
    else if ((key === 'cat' || key === 'category') && !cat) cat = val;
    else if ((key === 'trig' || key === 'triggers' || key === 'when') && !trig) trig = val;
  }
  return { name, description, cat, trig };
}
function collectSkills(cwd) {
  if (SKILLS_CACHE.has(cwd)) return SKILLS_CACHE.get(cwd);
  const found = [], seen = new Set();
  const add = (name, description, source) => {
    name = (name || '').trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    found.push({ name, description: (description || '').slice(0, 300), source });
  };
  const projSkills = cwd ? path.join(cwd, '.claude', 'skills') : '';
  const userSkills = path.join(os.homedir(), '.claude', 'skills');
  const projCmds = cwd ? path.join(cwd, '.claude', 'commands') : '';
  if (projSkills) for (const d of safeDirents(projSkills)) if (d.isDirectory()) { const fm = readFrontmatter(path.join(projSkills, d.name, 'SKILL.md')); if (fm) add(fm.name || d.name, fm.description, 'project'); }
  for (const d of safeDirents(userSkills)) if (d.isDirectory()) { const fm = readFrontmatter(path.join(userSkills, d.name, 'SKILL.md')); if (fm) add(fm.name || d.name, fm.description, 'user'); }
  if (projCmds) for (const d of safeDirents(projCmds)) if (d.isFile() && d.name.endsWith('.md')) { const fm = readFrontmatter(path.join(projCmds, d.name)); add((fm && fm.name) || d.name.replace(/\.md$/, ''), fm && fm.description, 'command'); }
  found.sort((a, b) => a.name.localeCompare(b.name));
  SKILLS_CACHE.set(cwd, found);
  return found;
}

// -------- TECH-2: агрегат реальных скиллов и MCP-серверов (из файлов, БЕЗ хардкода) --------
// Уникальные cwd проектов из транскриптов сессий (читаем только начало файла — cwd в первой строке).
let _cwdsCache = { ts: 0, list: [] };
function firstCwdOfFile(full) {
  let fd;
  try {
    fd = openSync(full, 'r');
    const buf = Buffer.alloc(16384);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return firstString(buf.toString('utf8', 0, n), 'cwd') || '';
  } catch { return ''; } finally { if (fd !== undefined) { try { closeSync(fd); } catch {} } }
}
function uniqueSessionCwds() {
  if (Date.now() - _cwdsCache.ts < 60000) return _cwdsCache.list;
  const set = new Set();
  for (const f of listSessionFiles()) { const c = firstCwdOfFile(f.full); if (c) set.add(c); }
  _cwdsCache = { ts: Date.now(), list: [...set] };
  return _cwdsCache.list;
}
let _allSkills = { ts: 0, list: [] };
function collectAllSkills() {
  if (Date.now() - _allSkills.ts < 30000) return _allSkills.list;
  const found = [], seen = new Set();
  const add = (name, fm, scope) => {
    name = String(name || '').trim(); const key = name.toLowerCase();
    if (!name || seen.has(key)) return;
    seen.add(key);
    const cat = (fm && (fm.cat || '').trim()) || scope || 'прочее';
    found.push({ cmd: name, does: ((fm && fm.description) || '').slice(0, 300), trig: (fm && fm.trig) || '', cat, scope });
  };
  const userSkills = path.join(os.homedir(), '.claude', 'skills');
  for (const d of safeDirents(userSkills)) if (d.isDirectory()) { const fm = readFrontmatter(path.join(userSkills, d.name, 'SKILL.md')); add((fm && fm.name) || d.name, fm, 'user'); }
  for (const cwd of uniqueSessionCwds()) {
    const ps = path.join(cwd, '.claude', 'skills');
    for (const d of safeDirents(ps)) if (d.isDirectory()) { const fm = readFrontmatter(path.join(ps, d.name, 'SKILL.md')); add((fm && fm.name) || d.name, fm, 'project'); }
  }
  found.sort((a, b) => a.cmd.localeCompare(b.cmd));
  _allSkills = { ts: Date.now(), list: found };
  return found;
}
function mcpEntryInfo(name, cfg, scope) {
  cfg = cfg || {};
  const transport = cfg.type || (cfg.command ? 'stdio' : (cfg.url ? 'http' : ''));
  const command = cfg.command ? [cfg.command].concat(Array.isArray(cfg.args) ? cfg.args : []).join(' ') : (cfg.url || '');
  return { name, scope, transport: transport || (cfg.url ? 'http' : cfg.command ? 'stdio' : ''), command, desc: cfg.description || '' };
}
function collectMcpConfig() {
  const found = new Map();   // name -> info, дедуп по имени (первый источник выигрывает)
  const add = (name, cfg, scope) => { if (!name || found.has(name)) return; found.set(name, mcpEntryInfo(name, cfg, scope)); };
  // ~/.claude.json — глобальные mcpServers + по-проектные projects[<path>].mcpServers
  try {
    const j = JSON.parse(readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
    if (j.mcpServers) for (const [n, c] of Object.entries(j.mcpServers)) add(n, c, 'user');
    if (j.projects && typeof j.projects === 'object') {
      for (const pc of Object.values(j.projects)) { if (pc && pc.mcpServers) for (const [n, c] of Object.entries(pc.mcpServers)) add(n, c, 'project'); }
    }
  } catch {}
  // .mcp.json в корне каждого проекта (по уникальным cwd)
  for (const cwd of uniqueSessionCwds()) {
    try { const j = JSON.parse(readFileSync(path.join(cwd, '.mcp.json'), 'utf8')); if (j.mcpServers) for (const [n, c] of Object.entries(j.mcpServers)) add(n, c, '.mcp.json'); } catch {}
  }
  // enabledMcpjsonServers из settings — только имена (конфиг может жить в другом месте): показываем нейтрально
  for (const sf of ['settings.json', 'settings.local.json']) {
    try {
      const s = JSON.parse(readFileSync(path.join(os.homedir(), '.claude', sf), 'utf8'));
      if (Array.isArray(s.enabledMcpjsonServers)) for (const n of s.enabledMcpjsonServers) add(n, {}, 'enabled');
    } catch {}
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}
function apiMcp(res) {
  const servers = collectMcpConfig();
  sendJSON(res, { count: servers.length, servers });
}
// Живой статус MCP: контрол-запрос SDK mcpServerStatus() (без turn; SDK коннектит MCP на каждый query).
// Форма ответа сервера: [{name, status: connected|failed|needs-auth|pending, error?, config:{type,command,args,url}, scope, tools:[{name,annotations}]}].
async function fetchMcpStatusRaw() {
  const query = await getSdkQuery();
  const ac = new AbortController();
  async function* openInput() { await new Promise((r) => setTimeout(r, 60000)); }   // держим ввод открытым, turn НЕ шлём
  // БЕЗ settingSources:[] — иначе SDK не загрузит MCP-конфиг и статус будет пустой.
  const q = query({ prompt: openInput(), options: { permissionMode: 'plan', abortController: ac } });
  // Транспорт считается готовым к control-запросу с ПЕРВОГО сообщения стрима (init). В упакованном app холодный
  // старт бинаря медленнее — без ожидания mcpServerStatus() падает «ProcessTransport is not ready for writing».
  let ready = false, streamErr = null;
  (async () => { try { for await (const _ of q) { ready = true; } } catch (e) { streamErr = e; } })();
  try {
    const t0 = Date.now();
    while (!ready && !streamErr && Date.now() - t0 < 20000) await new Promise((r) => setTimeout(r, 200));
    // Серверы коннектятся ПОСТЕПЕННО — несколько снимков, мёрж по имени (pending→connected апгрейдим, tools предпочитаем).
    const merged = new Map();
    let got = false, lastErr;
    for (let i = 0; i < 8; i++) {
      if (i) await new Promise((r) => setTimeout(r, 1200));
      try {
        const s = await q.mcpServerStatus();
        if (Array.isArray(s)) { got = true; for (const srv of s) { const prev = merged.get(srv.name); if (!prev || (prev.status === 'pending' && srv.status !== 'pending') || (srv.tools && !prev.tools)) merged.set(srv.name, srv); } }
      } catch (e) { lastErr = e; }
    }
    if (got) return [...merged.values()];
    throw lastErr || streamErr || new Error('mcp status unavailable');
  } finally { try { ac.abort(); } catch {} }
}
function mapMcpServer(s) {
  const cfg = s.config || {};
  const transport = cfg.type || (cfg.url ? 'http' : cfg.command ? 'stdio' : '');
  const command = cfg.command ? [cfg.command].concat(Array.isArray(cfg.args) ? cfg.args : []).join(' ') : (cfg.url || '');
  const tools = Array.isArray(s.tools) ? s.tools.map((t) => (typeof t === 'string' ? t : (t && t.name) || '')).filter(Boolean) : null;
  return { name: s.name, status: s.status || 'unknown', error: s.error || '', transport, command, scope: s.scope || '', toolCount: tools ? tools.length : null, tools: tools ? tools.slice(0, 80) : null };
}
let _mcpStatus = { ts: 0, data: null };
const MCP_STATUS_TTL = 30000;
async function apiMcpStatus(res, u) {
  const refresh = u.searchParams.get('refresh') === '1';   // reconnect в нашей модели = свежая проба (SDK коннектит MCP заново)
  if (!refresh && _mcpStatus.data && Date.now() - _mcpStatus.ts < MCP_STATUS_TTL) { sendJSON(res, _mcpStatus.data); return; }
  const cfg = collectMcpConfig();
  let data;
  try {
    const raw = await fetchMcpStatusRaw();
    const map = new Map(raw.map((s) => [s.name, mapMcpServer(s)]));
    for (const c of cfg) {   // серверов из конфига, которых SDK не вернул (не поднялись за окно) — добавим со статусом unknown; и добьём desc
      if (!map.has(c.name)) map.set(c.name, { name: c.name, status: 'unknown', error: '', transport: c.transport, command: c.command, scope: c.scope, toolCount: null, tools: null, desc: c.desc });
      else { const s = map.get(c.name); if (!s.desc && c.desc) s.desc = c.desc; if (!s.command && c.command) s.command = c.command; if (!s.transport && c.transport) s.transport = c.transport; if (!s.scope && c.scope) s.scope = c.scope; }
    }
    const servers = [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
    data = { available: true, live: true, count: servers.length, servers };
  } catch (e) {
    // Честный фолбэк: SDK-проба не удалась → листинг из конфигов со статусом unknown + пометка.
    const servers = cfg.map((c) => ({ name: c.name, status: 'unknown', error: '', transport: c.transport, command: c.command, scope: c.scope, toolCount: null, tools: null, desc: c.desc })).sort((a, b) => a.name.localeCompare(b.name));
    data = { available: false, live: false, reason: (e && e.message) || String(e), count: servers.length, servers };
  }
  _mcpStatus = { ts: Date.now(), data };
  sendJSON(res, data);
}
// Authenticate: `claude mcp login <name>` — OAuth-логин к серверу (HTTP/SSE/claude.ai-коннектор), открывает браузер и
// самозавершается через колбэк (как claude auth login). Отвечаем сразу (браузер открыт), клиент поллит статус до connected.
const _mcpLoginChildren = new Set();
function apiMcpLogin(res, u) {
  const name = u.searchParams.get('name') || '';
  if (!name) { sendJSON(res, { ok: false, error: 'no name' }, 400); return; }
  let child;
  try { child = spawn(CLAUDE_BIN, ['mcp', 'login', name], { windowsHide: true, shell: process.platform === 'win32' }); }
  catch (e) { sendJSON(res, { ok: false, error: String((e && e.message) || e) }); return; }
  _mcpLoginChildren.add(child);
  let buf = '', replied = false;
  const reply = (o) => { if (replied) return; replied = true; sendJSON(res, o); };
  const onData = (d) => { buf += String(d); const m = buf.match(/https?:\/\/\S+/); if (m) reply({ ok: true, name, url: m[0] }); };
  child.stdout.on('data', onData); child.stderr.on('data', onData);
  child.on('exit', () => { _mcpLoginChildren.delete(child); _mcpStatus = { ts: 0, data: null }; reply({ ok: true, name }); });
  child.on('error', (e) => { _mcpLoginChildren.delete(child); reply({ ok: false, error: String((e && e.message) || e) }); });
  setTimeout(() => reply({ ok: true, name }), 4000);   // браузер открылся — не ждём завершения OAuth
}
// Remove/Delete: `claude mcp remove <name> -s <scope>` — безопасно через CLI (без ручной правки JSON). Scope только user/project/local.
function apiMcpRemove(res, u) {
  const name = u.searchParams.get('name') || '';
  const scope = u.searchParams.get('scope') || '';
  if (!name) { sendJSON(res, { ok: false, error: 'no name' }, 400); return; }
  const args = ['mcp', 'remove', name];
  if (['user', 'project', 'local'].includes(scope)) args.push('-s', scope);
  execFile(CLAUDE_BIN, args, { timeout: 15000, windowsHide: true, shell: process.platform === 'win32' }, (err, stdout, stderr) => {
    _mcpStatus = { ts: 0, data: null };
    if (err) sendJSON(res, { ok: false, error: String(stderr || (err && err.message) || err).trim().slice(0, 300) });
    else sendJSON(res, { ok: true, output: String(stdout || '').trim().slice(0, 300) });
  });
}

// -------- Авто-дискавери запущенных Unity-инстансов (без ручного `claude mcp add`). --------
// Механизм: MCP-for-Unity пишет на каждый живой Editor файл <project>/Library/MCPForUnity/RunState/mcp_http_<port>.pid
// (имя = HTTP-порт бриджа, содержимое = PID mcp-сервера). Живой PID = инстанс up. projectPath → cuN по client-unity-N.
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); } }
function unityProjectRoots() {
  const roots = new Set();
  // добавить все client-unity-* внутри каталога dir (копии — дети репо/родителя)
  const globCU = (dir) => { try { for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory() && /^client-unity-\d+$/i.test(e.name)) roots.add(path.join(dir, e.name)); } catch {} };
  for (const cwd of uniqueSessionCwds()) {
    const segs = String(cwd).split(/[\\/]/);
    const idx = segs.findIndex((s) => /^client-unity-\d+$/i.test(s));
    if (idx >= 0) { const r = segs.slice(0, idx + 1).join(path.sep); roots.add(r); globCU(path.dirname(r)); }   // cwd внутри client-unity-N → сам + сиблинги
    else globCU(cwd);          // cwd = корень репо → его client-unity-* дети (сессии Deck крутятся в корне, копии — рядом)
    roots.add(cwd);            // сам cwd тоже может быть Unity-проектом (напр. citybuilder)
  }
  try { const c = loadConfig(); if (c.clientUnityParent) globCU(c.clientUnityParent); } catch {}
  return [...roots];
}
function scanUnityInstances() {
  const out = [], seen = new Set();
  for (const root of unityProjectRoots()) {
    const rs = path.join(root, 'Library', 'MCPForUnity', 'RunState');
    let files = []; try { files = readdirSync(rs); } catch { continue; }
    for (const f of files) {
      const m = f.match(/^mcp_http_(\d+)\.pid$/); if (!m) continue;
      let pid = 0; try { pid = parseInt(readFileSync(path.join(rs, f), 'utf8').trim(), 10) || 0; } catch {}
      if (!(pid > 0 && pidAlive(pid))) continue;   // нет pid или процесс мёртв → stale-файл, инстанс не живой
      const key = pid + '@' + m[1];                // один инстанс = один pidfile; один корень мог попасть в разном регистре
      if (seen.has(key)) continue; seen.add(key);
      const cm = root.match(/client-unity-(\d+)/i);
      out.push({ cu: cm ? 'cu' + cm[1] : '', projectPath: root, port: +m[1], pid, status: 'up' });
    }
  }
  return out.sort((a, b) => (a.cu || a.projectPath).localeCompare(b.cu || b.projectPath));
}
let _unityInst = { ts: 0, data: null };
const UNITY_TTL = 12000;   // короткий кэш — инстансы должны появляться/исчезать
function apiUnityInstances(res, u) {
  if (u.searchParams.get('refresh') !== '1' && _unityInst.data && Date.now() - _unityInst.ts < UNITY_TTL) { sendJSON(res, _unityInst.data); return; }
  const instances = scanUnityInstances();
  _unityInst = { ts: Date.now(), data: { count: instances.length, instances } };
  sendJSON(res, _unityInst.data);
}

// -------- http --------

function sendJSON(res, obj, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

// -------- чат: отправка запроса в сессию через Claude Agent SDK, ответ по SSE --------
// Аутентификация SDK — на существующем логине Claude Code (OAuth из ~/.claude/.credentials.json),
// БЕЗ отдельного ANTHROPIC_API_KEY (init.apiKeySource === 'none'). permissionMode:'plan' —
// read-only: модель читает/планирует, но НЕ применяет правки и не выполняет side-effect bash.
// SDK грузится лениво, чтобы отказ импорта не ронял остальные эндпоинты.
// Путь к платформенному бинарю claude, который спавнит SDK. В упакованном app он физически лежит в
// app.asar.unpacked (spawn не умеет запускать из asar), а SDK по умолчанию строит путь через app.asar →
// процесс не поднимается и любой control-request падает «ProcessTransport is not ready for writing».
// Возвращаем реальный (unpacked) путь; в standalone это тот же файл в node_modules — поведение не меняется.
function claudeExePath() {
  const plat = process.platform === 'win32' ? 'win32-x64'
    : process.platform === 'darwin' ? (process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64')
    : (process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64');
  const bin = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const p = path.join(HERE, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-' + plat, bin);
  const unpacked = p.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');   // spawn читает физический файл, не asar-виртуальный
  try { if (existsSync(unpacked)) return unpacked; } catch {}
  try { if (existsSync(p)) return p; } catch {}
  return null;
}
function isPackaged() { const e = getElectron(); return !!(e && e.app && e.app.isPackaged); }
// Путь к УСТАНОВЛЕННОМУ у пользователя claude (нативный .exe на PATH — тот же, что успешно работает в авторизации).
// В упакованном app бандл-бинарь SDK лежит в asar.unpacked и порой не спавнится → «ProcessTransport is not ready for
// writing» (падают chat/usage/mcp). Спавним рабочий CLI пользователя. Из ИСХОДНИКОВ не трогаем (бандл там ок).
let _claudeCli = undefined;
function resolveClaudeCli() {
  if (_claudeCli !== undefined) return _claudeCli;
  _claudeCli = null;
  try {
    const cmd = process.platform === 'win32' ? 'where claude' : 'command -v claude 2>/dev/null || which claude';
    const out = String(execSync(cmd, { encoding: 'utf8', windowsHide: true, timeout: 6000, shell: process.platform === 'win32' ? undefined : '/bin/sh' }) || '').trim();
    const lines = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const pick = lines.find((l) => /\.exe$/i.test(l)) || lines.find((l) => !/\.(cmd|bat|ps1)$/i.test(l)) || lines[0];
    if (pick && existsSync(pick)) _claudeCli = pick;
  } catch {}
  return _claudeCli;
}
let _sdkQuery = null;
async function getSdkQuery() {
  if (_sdkQuery) return _sdkQuery;
  const mod = await import('@anthropic-ai/claude-agent-sdk');
  // В сборке предпочитаем установленный claude пользователя, иначе — распакованный бандл-бинарь. Из исходников — дефолт SDK.
  const exe = isPackaged() ? (resolveClaudeCli() || claudeExePath()) : null;
  _sdkQuery = exe
    ? (args) => mod.query({ ...args, options: { ...((args && args.options) || {}), pathToClaudeCodeExecutable: exe } })
    : mod.query;
  return _sdkQuery;
}

// -------- Аккаунт-лимиты Claude (5ч / 7д) через control-request usage() SDK — тот же OAuth-логин, без инференса. --------
let _usage = { ts: 0, data: null };
const USAGE_TTL = 45000;
async function fetchUsageRaw() {
  const query = await getSdkQuery();
  const ac = new AbortController();
  async function* openInput() { await new Promise((r) => setTimeout(r, 40000)); }   // держим ввод открытым, НЕ шлём turn
  const q = query({ prompt: openInput(), options: { permissionMode: 'plan', settingSources: [], abortController: ac } });
  // как и в MCP-пробе: ждём готовности транспорта (первое сообщение стрима), иначе в упакованном app control-request падает
  let ready = false, streamErr = null;
  (async () => { try { for await (const _ of q) { ready = true; } } catch (e) { streamErr = e; } })();
  try {
    const t0 = Date.now();
    while (!ready && !streamErr && Date.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 200));
    let lastErr;
    for (let i = 0; i < 5; i++) {   // CLI холодный старт — ретраим control-request
      if (i) await new Promise((r) => setTimeout(r, 1500));
      try { return await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(); }
      catch (e) { lastErr = e; }
    }
    throw lastErr || streamErr || new Error('usage unavailable');
  } finally { try { ac.abort(); } catch {} }
}
// Список моделей — рантаймовый control-request SDK supportedModels() (реальные value/displayName + какие effort-уровни
// каждая поддерживает). Ничего не хардкодим: и модели, и набор эффортов выводим из ответа CLI. Кэш 5 мин.
async function fetchModelsRaw() {
  const query = await getSdkQuery();
  const ac = new AbortController();
  async function* openInput() { await new Promise((r) => setTimeout(r, 30000)); }
  const q = query({ prompt: openInput(), options: { permissionMode: 'plan', settingSources: [], abortController: ac } });
  let ready = false, streamErr = null;
  (async () => { try { for await (const _ of q) { ready = true; } } catch (e) { streamErr = e; } })();
  try {
    const t0 = Date.now();
    while (!ready && !streamErr && Date.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 200));
    let lastErr;
    for (let i = 0; i < 5; i++) {
      if (i) await new Promise((r) => setTimeout(r, 1200));
      try { const m = await q.supportedModels(); if (Array.isArray(m)) return m; } catch (e) { lastErr = e; }
    }
    throw lastErr || streamErr || new Error('models unavailable');
  } finally { try { ac.abort(); } catch {} }
}
let _models = { ts: 0, data: null };
const MODELS_TTL = 5 * 60 * 1000;
async function apiModels(res) {
  if (_models.data && Date.now() - _models.ts < MODELS_TTL) { sendJSON(res, _models.data); return; }
  const models = [{ value: '', label: 'Модель: по умолчанию' }];
  const effortSet = new Set();
  try {
    const raw = await fetchModelsRaw();
    for (const m of raw) {
      const v = String((m && m.value) || '').trim(); if (!v) continue;
      const efs = Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels : [];
      models.push({ value: v, label: String(m.displayName || v), efforts: efs });
      for (const e of efs) effortSet.add(e);
    }
  } catch {
    // проба не удалась (напр. вне Electron/без логина) — модели из additionalModelOptionsCache конфига, без хардкода
    try {
      const j = JSON.parse(readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
      for (const e of (j.additionalModelOptionsCache || [])) { const v = String((e && e.value) || '').trim(); if (v) models.push({ value: v, label: String((e && e.label) || v), efforts: [] }); }
    } catch {}
  }
  const rank = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 };
  const efforts = [{ value: '', label: 'Effort: по умолчанию' }].concat(
    [...effortSet].sort((a, b) => (rank[a] ?? 99) - (rank[b] ?? 99)).map((e) => ({ value: e, label: e.charAt(0).toUpperCase() + e.slice(1) })));
  const data = { models, efforts };
  _models = { ts: Date.now(), data };
  sendJSON(res, data);
}
function mapUsage(u) {
  if (!u || !u.rate_limits_available || !u.rate_limits) return { available: false, reason: 'аккаунт-лимиты недоступны для этого логина/сессии' };
  const rl = u.rate_limits;
  const win = (w) => (w ? { utilization: (w.utilization == null ? null : Math.round(w.utilization)), resetsAt: w.resets_at || null } : null);
  const ex = rl.extra_usage;
  const extra = ex && ex.is_enabled ? { usedCredits: ex.used_credits, monthlyLimit: ex.monthly_limit, utilization: ex.utilization, currency: ex.currency } : null;
  return { available: true, subscriptionType: u.subscription_type || null, fiveHour: win(rl.five_hour), sevenDay: win(rl.seven_day), extra };
}
async function apiUsage(res) {
  if (_usage.data && Date.now() - _usage.ts < USAGE_TTL) { sendJSON(res, _usage.data); return; }
  try {
    const data = mapUsage(await fetchUsageRaw());
    _usage = { ts: Date.now(), data };
    sendJSON(res, data);
  } catch (e) {
    const data = { available: false, reason: (e && e.message) || String(e) };
    _usage = { ts: Date.now(), data };
    sendJSON(res, data);
  }
}

// -------- P2: аппрув инструментов (canUseTool). Читающее — молча allow; пишущее/выполняющее — спросить. --------
const pendingApprovals = new Map();   // approvalId -> { decide(decision) }
const activeStreams = new Map();      // streamId -> AbortController (для гарантированного /api/stop)
const sessionAllow = new Map();       // sessionId -> Set<toolName> (сессионный «Разрешить всё»)
const VALID_MODES = new Set(['default', 'acceptEdits', 'plan', 'bypassPermissions']);   // P3: режимы разрешений
const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);               // уровни reasoning-effort SDK
const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'WebFetch', 'WebSearch', 'TodoWrite']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);   // правки файлов — авто-принимаются в acceptEdits
// Мутирующие инструменты, которые managed-тир форсирует в ask. settingSources('project') нужен, чтобы CLI нашёл скиллы
// проекта (/dev-workflow и пр.) и CLAUDE.md — без него слэш-команды = «Unknown command». Но project несёт и
// permissions.allow (Bash(*)/Write(*)/mcp__*…), которые пропускали бы мутирующее мимо canUseTool. Managed-ask имеет
// высший приоритет (deny>ask>allow) и возвращает их под страж; read-only-часть mcp__* отсеет isReadOnlyTool в canUseTool.
const MANAGED_ASK = ['Bash', 'PowerShell', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'mcp__*'];
function isReadOnlyTool(name) {
  if (READ_ONLY_TOOLS.has(name)) return true;
  const bare = String(name || '').replace(/^mcp__.+?__/, '').toLowerCase();   // mcp__server__tool -> tool
  // мутирующие глаголы — точно спрашиваем (даже если дальше есть read-подстрока)
  if (/^(create|update|delete|remove|add|edit|write|set|put|post|patch|trigger|transition|upload|generate|archive|fix|wipe|deploy|move|rename|assign|merge|apply|kick|ban|send|publish|execute|run|link|unlink|start|stop|restart)/.test(bare)) return false;
  // читающие
  if (/^(get|list|search|read|fetch|describe|view|show|find|query|explore|lookup|check|status|info)/.test(bare)) return true;
  if (/(_|^)(query|get|list|describe|search|read|fetch|log|logs|status|info|context|diff|health|events|metrics)(_|$)/.test(bare)) return true;
  return false;   // неизвестное — спрашиваем (безопасно)
}
function addSessionAllow(sessionId, tool) {
  let set = sessionAllow.get(sessionId);
  if (!set) { set = new Set(); sessionAllow.set(sessionId, set); }
  set.add(tool);
}

// -------- P4: стадирование вложений. base64-картинки не влезают в query-string EventSource — принимаем
// POST-телом, храним в памяти по одноразовому токену, поток /api/chat?token=... поднимает подготовленный запрос. --------
const stagedRequests = new Map();   // token -> { sessionFile, prompt, mode, attachments, ts }
const STAGE_MAX_BYTES = 24 * 1024 * 1024;   // ~24МБ тела (включая base64)
function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > maxBytes) { reject(new Error('payload too large')); try { req.destroy(); } catch {} return; } chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}
// Перенос пути; renameSync не умеет через диски (projects на C:, deck-trash на D: → EXDEV) — фолбэк copy+remove.
function movePath(src, dest) {
  try { renameSync(src, dest); }
  catch (e) { if (e && e.code === 'EXDEV') { cpSync(src, dest, { recursive: true }); rmSync(src, { recursive: true, force: true }); } else throw e; }
}
// БЕЗОПАСНОЕ удаление: НЕ rm, а перенос .jsonl (+ каталог сабагентов) в <repo>/deck-trash/<ts>-<basename> (восстановимо).
async function apiDeleteSession(req, res) {
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
async function apiTags(req, res) {   // POST {file, tags:[...]} — перезаписывает набор тегов сессии, персист на диск
  let body;
  try { body = await readJsonBody(req, 256 * 1024); }
  catch (e) { sendJSON(res, { error: (e && e.message) || 'read error' }, 400); return; }
  const file = String(body.file || '');
  if (!file) { sendJSON(res, { error: 'no file' }, 400); return; }
  const tags = setTags(file, body.tags);
  sendJSON(res, { file, tags });
}
async function apiSessionName(req, res) {   // POST {file, name} — заданное пользователем имя сессии (override title)
  let body;
  try { body = await readJsonBody(req, 8 * 1024); }
  catch (e) { sendJSON(res, { error: (e && e.message) || 'read error' }, 400); return; }
  const file = String(body.file || '');
  if (!file) { sendJSON(res, { error: 'no file' }, 400); return; }
  const name = setName(file, body.name);   // nameOf() применяется при сборке сессии → override виден сразу
  sendJSON(res, { file, name });
}
// Чтение текстового файла для встроенного просмотрщика (клик по ссылке .md/.txt в выводе). ТОЛЬКО в пределах cwd
// сессии — Deck слушает localhost, произвольный FS читать нельзя. :line-суффикс снимаем; бинарь/вне cwd → отказ (клиент
// откроет во внешнем приложении). Размер режем VIEWER_MAX.
const VIEWER_TEXT_EXT = new Set(['md','markdown','txt','json','yml','yaml','toml','ini','cfg','conf','log','csv','tsv','sql','sh','bash','ps1','py','js','mjs','cjs','ts','tsx','jsx','cs','go','rs','java','kt','c','h','cpp','hpp','css','html','xml','patch','diff','env','gitignore','dockerfile']);
const VIEWER_MAX = 2 * 1024 * 1024;
function apiFile(res, u) {
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
async function apiChatPrepare(req, res) {
  let body;
  try { body = await readJsonBody(req, STAGE_MAX_BYTES); }
  catch (e) { sendJSON(res, { error: (e && e.message) || 'read error' }, 413); return; }
  const sessionFile = String(body.sessionFile || '');
  const prompt = String(body.prompt || '');
  let mode = String(body.mode || 'default'); if (!VALID_MODES.has(mode)) mode = 'default';
  const model = String(body.model || '').slice(0, 80);   // алиас/ID модели ('' = по умолчанию)
  const effort = String(body.effort || '').slice(0, 12); // low|medium|high|xhigh|max ('' = по умолчанию)
  const attachments = Array.isArray(body.attachments) ? body.attachments.slice(0, 20) : [];
  const newSession = body.newSession === true;         // Part 3: создать НОВУЮ сессию (без resume) в cwd
  const fork = body.fork === true;                     // форк: resume + forkSession — новый id с контекстом исходной
  const cwd = String(body.cwd || '');
  let bytes = 0;
  for (const a of attachments) bytes += (a && a.dataB64 ? a.dataB64.length : 0) + (a && a.text ? a.text.length : 0);
  if (bytes > STAGE_MAX_BYTES) { sendJSON(res, { error: 'attachments too large (~18MB limit)' }, 413); return; }
  const now = Date.now();
  for (const [k, v] of stagedRequests) if (now - v.ts > 5 * 60 * 1000) stagedRequests.delete(k);   // sweep старьё
  const token = 'st_' + now.toString(36) + Math.random().toString(36).slice(2, 10);
  stagedRequests.set(token, { sessionFile, prompt, mode, model, effort, attachments, newSession, cwd, fork, ts: now });
  sendJSON(res, { token });
}

async function apiChat(req, res, u) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (obj) => { try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch { /* поток закрыт */ } };
  const fail = (msg) => { send({ type: 'error', message: msg }); send({ type: 'done', isError: true }); try { res.end(); } catch {} };

  // Источник запроса: одноразовый token (P4-стадирование / новая сессия) ИЛИ прямые query-параметры (P1/P3)
  let relFile = '', prompt = '', mode = 'default', attachments = [], isNew = false, newCwd = '', isFork = false, model = '', effort = '';
  const token = u.searchParams.get('token');
  if (token) {
    const staged = stagedRequests.get(token);
    stagedRequests.delete(token);                                   // одноразовый — чистим сразу
    if (!staged) return fail('stale or unknown token');
    relFile = staged.sessionFile || '';
    prompt = staged.prompt || '';
    mode = staged.mode || 'default';
    model = staged.model || ''; effort = staged.effort || '';
    attachments = Array.isArray(staged.attachments) ? staged.attachments : [];
    isNew = staged.newSession === true;                             // Part 3: новая сессия без resume
    isFork = staged.fork === true;                                  // форк: resume исходной + forkSession
    newCwd = staged.cwd || '';
  } else {
    relFile = u.searchParams.get('file') || '';
    prompt = u.searchParams.get('prompt') || '';
    mode = u.searchParams.get('mode') || 'default';                 // P3: режим разрешений из чата (shift-tab)
    model = u.searchParams.get('model') || ''; effort = u.searchParams.get('effort') || '';
  }
  if (!VALID_MODES.has(mode)) mode = 'default';                     // неизвестное → безопасный default
  if (effort && !VALID_EFFORTS.has(effort)) effort = '';            // неизвестный effort → по умолчанию
  if (!prompt.trim() && !attachments.length) return fail('empty prompt');

  // Резолв контекста: новая сессия → cwd напрямую (файла ещё нет); иначе — из файла существующей сессии.
  let sessionId = null, cwd;
  if (isNew) {
    if (!newCwd) return fail('no cwd for new session');
    cwd = newCwd;
  } else {
    const base = path.resolve(PROJECTS_DIR);
    const resolved = path.resolve(base, relFile);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) return fail('traversal');
    if (!resolved.endsWith('.jsonl')) return fail('not a session file');
    let text = '';
    try { text = readFileSync(resolved, 'utf8'); } catch { return fail('session not found'); }
    sessionId = path.basename(resolved).replace(/\.jsonl$/, '');
    cwd = firstString(text, 'cwd') || undefined;
  }
  let sessionKey = sessionId;                                       // для новой сессии станет известен на init

  const ac = new AbortController();
  let closed = false;
  const streamId = 'sx_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  activeStreams.set(streamId, ac);                                  // явный обрыв через /api/stop (не зависит от детекта дисконнекта)
  // При закрытии SSE (ушёл с экрана / перезашёл в сессию) НЕ рвём запрос — пусть Claude доработает в фоне и допишет
  // .jsonl (перезаход подхватит live-tail'ом). Останавливать работу — только явной кнопкой Стоп (/api/stop → ac.abort).
  req.on('close', () => { closed = true; });

  // canUseTool — ЕДИНСТВЕННЫЙ страж в default-режиме: без него мутирующие инструменты выполнились бы без спроса.
  const canUseTool = async (toolName, input, opts) => {
    if (isReadOnlyTool(toolName)) return { behavior: 'allow', updatedInput: input };
    if (mode === 'bypassPermissions') return { behavior: 'allow', updatedInput: input };            // байпас — ничего не спрашиваем
    if (mode === 'acceptEdits' && EDIT_TOOLS.has(toolName)) return { behavior: 'allow', updatedInput: input };  // «Авто-правки»: правки файлов без спроса (в т.ч. вне cwd); Bash/прочее — по-прежнему спрашиваем
    if (closed) return { behavior: 'deny', message: 'Клиент отключён — правка не применена (переоткройте сессию и повторите)' };  // фоновая доработка без UI: не зависаем на approval
    const set = sessionKey && sessionAllow.get(sessionKey);
    if (set && set.has(toolName)) return { behavior: 'allow', updatedInput: input };
    const id = 'ap_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    send({ type: 'approval', id, tool: toolName, input });
    return await new Promise((resolve) => {
      const finalize = (result) => { pendingApprovals.delete(id); resolve(result); };
      const decide = (decision) => {
        if (decision === 'always') { if (sessionKey) addSessionAllow(sessionKey, toolName); finalize({ behavior: 'allow', updatedInput: input }); }
        else if (decision === 'allow') { finalize({ behavior: 'allow', updatedInput: input }); }
        else finalize({ behavior: 'deny', message: 'Запрещено пользователем' });
      };
      pendingApprovals.set(id, { decide });
      const sig = opts && opts.signal;
      if (sig) {
        if (sig.aborted) decide('deny');
        else sig.addEventListener('abort', () => { if (pendingApprovals.has(id)) decide('deny'); }, { once: true });
      }
    });
  };

  // P4: собираем промт для query(). Текстовые файлы вклеиваем в текст блоком ```имя```; картинки — vision-блоки;
  // при наличии картинок промт — async-iterable из одного user-сообщения с массивом content-блоков.
  const images = attachments.filter((a) => a && a.kind === 'image' && a.dataB64);
  const textFiles = attachments.filter((a) => a && a.kind === 'text' && typeof a.text === 'string');
  const otherFiles = attachments.filter((a) => a && a.kind === 'binary');
  let combinedText = prompt;
  if (textFiles.length) {
    const blocks = textFiles.map((a) => '```' + a.name + '\n' + a.text + '\n```').join('\n\n');
    combinedText = blocks + (prompt ? '\n\n' + prompt : '');
  }
  if (otherFiles.length) combinedText += '\n\n[вложения без встраивания: ' + otherFiles.map((a) => a.name).join(', ') + ']';
  let sdkPrompt;
  if (images.length) {
    const content = [];
    if (combinedText.trim()) content.push({ type: 'text', text: combinedText });
    for (const im of images) content.push({ type: 'image', source: { type: 'base64', media_type: im.mediaType || 'image/png', data: im.dataB64 } });
    sdkPrompt = (async function* () { yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null }; })();
  } else {
    sdkPrompt = combinedText || prompt;
  }

  send({ type: 'start', streamId, sessionId: sessionId || '', cwd: cwd || '', isNew });
  try {
    const query = await getSdkQuery();
    const options = {
      cwd,
      permissionMode: mode,           // P3: default | acceptEdits | plan | bypassPermissions (из &mode=)
      canUseTool,                     // read-only → авто-allow; мутирующее → SSE approval + ожидание решения
      settingSources: ['user', 'project', 'local'],   // как настоящая CC-сессия: скиллы (/dev-workflow…), CLAUDE.md, агенты
      skills: 'all',                                   // явно включаем все найденные скиллы
      managedSettings: { permissions: { ask: MANAGED_ASK } },   // страж поверх project-allow (см. MANAGED_ASK)
      includePartialMessages: true,   // дельты текста ассистента
      abortController: ac,
      maxTurns: 24,
    };
    if (model) options.model = model;          // выбор модели из футера ('' = дефолт сессии/аккаунта)
    if (effort) options.effort = effort;       // выбор reasoning-effort из футера
    if (!isNew) options.resume = sessionId;   // существующая сессия / форк — resume; новая — без resume
    if (isFork) options.forkSession = true;   // форк: resume создаёт НОВЫЙ session_id (контекст исходной), оригинал не трогаем
    options.systemPrompt = { type: 'preset', preset: 'claude_code' };   // CLAUDE.md грузится нативно через settingSources('project')
    const q = query({ prompt: sdkPrompt, options });
    for await (const m of q) {
      if (closed) continue;   // клиент ушёл — продолжаем вычитывать поток (CLI дорабатывает и пишет .jsonl), но в закрытый res не шлём
      if (m.type === 'system' && m.subtype === 'init') {
        send({ type: 'system', model: m.model, apiKeySource: m.apiKeySource });
        if ((isNew || isFork) && m.session_id) {         // новая/форкнутая сессия → сообщаем клиенту НОВЫЙ файл (переключиться/тейлить)
          sessionKey = m.session_id;
          const rel = String(cwd).replace(/[^a-zA-Z0-9]/g, '-') + '/' + m.session_id + '.jsonl';
          send({ type: 'session', id: m.session_id, file: rel });
        }
      } else if (m.type === 'stream_event') {
        const ev = m.event;
        if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
          send({ type: 'text', delta: ev.delta.text });
        } else if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'thinking_delta') {
          send({ type: 'thinking', delta: ev.delta.thinking });   // живое размышление (в сохранённом транскрипте оно пустое)
        } else if (ev.type === 'content_block_start' && ev.content_block && ev.content_block.type === 'tool_use') {
          send({ type: 'tool', name: ev.content_block.name });
        }
      } else if (m.type === 'assistant' && m.error) {
        send({ type: 'error', message: String(m.error) });
      } else if (m.type === 'result') {
        send({ type: 'done', subtype: m.subtype, isError: !!m.is_error });
      }
    }
  } catch (e) {
    if (!closed) send({ type: 'error', message: (e && e.message) ? e.message : String(e) });
  } finally {
    activeStreams.delete(streamId);
    if (!closed) { try { res.end(); } catch {} }
  }
}

// Явный обрыв стрима по id (клиент дёргает на Стоп, плюс закрывает ES) — гарантированно рвём SDK-запрос.
function apiStop(res, u) {
  const id = u.searchParams.get('id') || '';
  const ac = activeStreams.get(id);
  if (ac) { try { ac.abort(); } catch {} activeStreams.delete(id); }
  sendJSON(res, { ok: true });
}

// Решение по аппруву от клиента: allow | deny | always. Нет id (двойной клик/устарело) — тихо ok.
function apiApprove(res, u) {
  const id = u.searchParams.get('id') || '';
  const decision = u.searchParams.get('decision') || 'deny';
  const p = pendingApprovals.get(id);
  if (p) { try { p.decide(decision); } catch { /* уже снят */ } }
  sendJSON(res, { ok: true });
}

// -------- TeamCity: live-статус клиентских сборок по ветке (секция «Сборки» в рейле) --------
// Хост дефолтный, токен из env (TEAMCITY_TOKEN). Нет токена → { available:false } и клиент
// показывает приближённую метку по wfBuildState. Ветку матчим точно; фолбэк — свежие билды типа,
// у которых branchName начинается с WO (ветка vibecode-сессии не всегда = ветка клиентской сборки).
// TC_HOST/TC_TOKEN резолвятся в applyConfig() (config → env/.env → дефолт; токен из safeStorage либо .env).
const TC_BUILD_TYPES = [
  { id: 'Wo_Client_Development_Android', plat: 'Android' },
  { id: 'Wo_Client_Development_IOS', plat: 'iOS' },
];
const TC_FIELDS = 'fields=count,build(id,number,status,state,branchName,webUrl,buildTypeId)';
const _tcCache = new Map();   // branch -> { ts, data }
const TC_TTL = 8000;

async function tcJson(pathq) {
  const r = await fetch(TC_HOST + pathq, {
    headers: { Authorization: 'Bearer ' + TC_TOKEN, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error('TeamCity HTTP ' + r.status);
  return r.json();
}
async function tcLatestBuild(btId, branch, wo) {
  // Точный матч по ветке — ТОЛЬКО для реальной фича/WO-ветки. У базовой (preprod/preupdate/…) он вернул бы
  // чужой неродственный dev-билд, крутившийся на этой ветке (баг «сборки упали» на контексте без сборок).
  if (branch && !isBaseBranch(branch)) {
    const j = await tcJson('/app/rest/builds?locator=buildType:(id:' + btId + '),branch:(name:' + encodeURIComponent(branch) + ',default:any),count:1&' + TC_FIELDS);
    if (j.count && j.build && j.build[0]) return j.build[0];
  }
  if (wo) {
    const j = await tcJson('/app/rest/builds?locator=buildType:(id:' + btId + '),branch:(default:any),count:40&' + TC_FIELDS);
    const hit = (j.build || []).find((b) => b.branchName && b.branchName.indexOf(wo) === 0);
    if (hit) return hit;
  }
  return null;
}
// ЖИВОЙ признак «билд реально идёт» (running/queued в TeamCity). Кэш по branch|wo с АДАПТИВНЫМ TTL:
// активный билд — короткий TTL (~15с), чтобы быстро поймать завершение; неактивный — обычный (~60с).
const _buildActiveCache = new Map();
const BUILD_TTL_ACTIVE = 15 * 1000;
const BUILD_TTL_IDLE = 60 * 1000;
async function buildActiveFor(branch, wo) {
  if (!TC_TOKEN || !TC_HOST) return false;
  const key = (branch || '') + '|' + (wo || '');
  const c = _buildActiveCache.get(key);
  if (c && Date.now() - c.ts < (c.v ? BUILD_TTL_ACTIVE : BUILD_TTL_IDLE)) return c.v;
  let active = false;
  try {
    for (const bt of TC_BUILD_TYPES) {
      const b = await tcLatestBuild(bt.id, branch, wo);
      const state = b && String(b.state || '').toLowerCase();
      if (state === 'running' || state === 'queued') { active = true; break; }   // finished/none → не активен
    }
  } catch { active = false; }
  _buildActiveCache.set(key, { ts: Date.now(), v: active });
  return active;
}
async function apiBuild(res, u) {
  const branch = u.searchParams.get('branch') || '';
  const wo = u.searchParams.get('wo') || '';
  if (!TC_TOKEN || !TC_HOST) { sendJSON(res, { available: false, reason: 'TeamCity не настроен (host/token)', host: TC_HOST }); return; }
  if (!branch) { sendJSON(res, { available: true, host: TC_HOST, branch, builds: [] }); return; }
  // Базовая ветка без WO не идентифицирует сборки контекста — не дёргаем TeamCity впустую.
  if (isBaseBranch(branch) && !wo) { sendJSON(res, { available: true, host: TC_HOST, branch, builds: [], reason: 'base-branch' }); return; }
  const cached = _tcCache.get(branch);
  if (cached && Date.now() - cached.ts < TC_TTL) { sendJSON(res, cached.data); return; }
  try {
    const builds = [];
    for (const bt of TC_BUILD_TYPES) {
      const b = await tcLatestBuild(bt.id, branch, wo);
      if (b) builds.push({ plat: bt.plat, number: b.number, status: b.status, state: b.state, webUrl: b.webUrl, branchName: b.branchName });
    }
    const data = { available: true, host: TC_HOST, branch, builds };
    _tcCache.set(branch, { ts: Date.now(), data });
    sendJSON(res, data);
  } catch (e) {
    sendJSON(res, { available: false, reason: (e && e.message) || String(e), host: TC_HOST });
  }
}

// -------- GitLab: live-MR по ветке (секция «Merge Requests»; приоритет над stale wfMrUrl из dev-workflow) --------
// Ищем MR ГЛОБАЛЬНО по source_branch (scope=all) — надёжнее, чем угадывать project id (client-unity/backend-services/
// staticsutils). Фолбэк — search=<WO-XXXX>. Нет токена → { available:false }, клиент оставляет wfMrUrl.
// GL_HOST/GL_TOKEN резолвятся в applyConfig() (config → env/.env → дефолт; токен из safeStorage либо .env).
const _mrCache = new Map();   // branch|wo -> { ts, data }
const MR_TTL = 30000;

async function glJson(pathq) {
  const r = await fetch(GL_HOST + pathq, { headers: { 'PRIVATE-TOKEN': GL_TOKEN }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('GitLab HTTP ' + r.status);
  return r.json();
}
function mrProject(webUrl) {
  const m = String(webUrl || '').match(/^https?:\/\/[^/]+\/(.+?)\/-\/merge_requests\//);
  return m ? m[1] : '';
}
function mapMr(m) {
  return { iid: m.iid, title: m.title, state: m.state, web_url: m.web_url, target_branch: m.target_branch, source_branch: m.source_branch, project: mrProject(m.web_url), updated_at: m.updated_at };
}
async function apiMrs(res, u) {
  const branch = u.searchParams.get('branch') || '';
  const wo = u.searchParams.get('wo') || '';
  if (!GL_TOKEN || !GL_HOST) { sendJSON(res, { available: false, reason: 'GitLab не настроен (host/token)', host: GL_HOST }); return; }
  if (!branch && !wo) { sendJSON(res, { available: true, host: GL_HOST, mrs: [] }); return; }
  const key = branch + '|' + wo;
  const fresh = u.searchParams.get('refresh') === '1';   // рефреш дашборда — обойти кэш
  const cached = _mrCache.get(key);
  if (!fresh && cached && Date.now() - cached.ts < MR_TTL) { sendJSON(res, cached.data); return; }
  try {
    let list = [];
    // По source_branch ищем только для рабочих (не-базовых) веток — у preprod/preupdate это бессмысленно.
    const useBranch = branch && !BASE_BRANCHES.has(String(branch).toLowerCase());
    if (useBranch) list = await glJson('/api/v4/merge_requests?scope=all&source_branch=' + encodeURIComponent(branch) + '&state=all&per_page=20');
    // Фолбэк: по WO в ЗАГОЛОВКЕ MR (точнее, чем полнотекст) — ловит MR сессий-уборок (ветка preprod, WO в промпте).
    if ((!Array.isArray(list) || !list.length) && wo) list = await glJson('/api/v4/merge_requests?scope=all&search=' + encodeURIComponent(wo) + '&in=title&state=all&per_page=20');
    const mrs = (Array.isArray(list) ? list : []).map(mapMr).sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
    const data = { available: true, host: GL_HOST, branch, mrs };
    _mrCache.set(key, { ts: Date.now(), data });
    sendJSON(res, data);
  } catch (e) {
    sendJSON(res, { available: false, reason: (e && e.message) || String(e), host: GL_HOST });
  }
}

// -------- Jira: живой статус задачи (колонка «Статусы» приоритетнее локального dev-workflow) --------
// Гейт по JIRA_HOST/JIRA_EMAIL/JIRA_TOKEN (кладутся через .env). Basic auth base64(email:token).
// Возвращаем СЫРОЙ статус; маппинг статус→колонка делает клиент (нужен live-статус билда для In Progress).
// JIRA_HOST/EMAIL/TOKEN/JIRA_ENABLED резолвятся в applyConfig() (config → env/.env; токен из safeStorage либо .env).
const _jiraCache = new Map();   // wo -> { ts, data }
const JIRA_TTL = 30000;
// Реюзабельный резолвер статуса Jira (кэш 30с). Возвращает {available,status,category,summary}. Не бросает.
async function jiraStatus(wo, fresh) {
  wo = String(wo || '').trim();
  if (!JIRA_ENABLED) return { available: false, reason: 'no JIRA token/email/host' };
  if (!/^WO-\d+$/i.test(wo)) return { available: true, status: null };
  const cached = _jiraCache.get(wo);
  if (!fresh && cached && Date.now() - cached.ts < JIRA_TTL) return cached.data;   // refresh=1 (рефреш дашборда) обходит кэш
  try {
    const auth = Buffer.from(JIRA_EMAIL + ':' + JIRA_TOKEN).toString('base64');
    const r = await fetch('https://' + JIRA_HOST + '/rest/api/3/issue/' + encodeURIComponent(wo) + '?fields=status,summary', {
      headers: { Authorization: 'Basic ' + auth, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error('Jira HTTP ' + r.status);
    const j = await r.json();
    const st = j.fields && j.fields.status;
    const data = { available: true, status: st ? st.name : null, category: st && st.statusCategory ? st.statusCategory.key : '', summary: (j.fields && j.fields.summary) || '' };
    _jiraCache.set(wo, { ts: Date.now(), data });
    return data;
  } catch (e) {
    const data = { available: false, reason: (e && e.message) || String(e) };
    _jiraCache.set(wo, { ts: Date.now(), data });   // кэшируем и неудачу — не долбим на каждый поллинг
    return data;
  }
}
async function apiJira(res, u) { sendJSON(res, await jiraStatus(u.searchParams.get('wo') || '', u.searchParams.get('refresh') === '1')); }

// -------- TECH-6: конфиг Deck (GET текущие значения / POST сохранить). Токен наружу НЕ отдаём, только флаг. --------
function configView() {
  return {
    woStatesDir: WO_STATES_DIR,
    claudeProjectsDir: PROJECTS_DIR,
    jira: { host: JIRA_HOST, email: JIRA_EMAIL, tokenSet: !!JIRA_TOKEN, enabled: JIRA_ENABLED },
    teamcity: { host: TC_HOST, tokenSet: !!TC_TOKEN },
    gitlab: { host: GL_HOST, tokenSet: !!GL_TOKEN },
    unity: (() => { const c = loadConfig(); return { clientUnityParent: c.clientUnityParent || '', editorsDir: c.unityEditorsDir || '', hubPath: c.unityHubPath || '' }; })(),
    secretsEnvPath: loadConfig().secretsEnvPath || '',   // явный .env для «Подтянуть токены» (нужно установленному app — HERE в asar)
    electron: !!getElectron(),   // можно ли безопасно сохранить токен (safeStorage) или только через .env
    defaults: { claudeProjectsDir: path.join(os.homedir(), '.claude', 'projects'), teamcityHost: 'https://teamcity.example.com', gitlabHost: 'https://gitlab.example.com' },
  };
}
async function apiConfig(req, res) {
  if (req.method === 'POST') {
    let body; try { body = await readJsonBody(req, 64 * 1024); } catch { sendJSON(res, { error: 'bad body' }, 400); return; }
    saveConfig(body);
    const tokenResult = {};   // токен пустой/не передан = не менять; сохраняем только переданные
    if ('jiraToken' in body) tokenResult.jira = writeTokenSecure('jira', body.jiraToken);
    if ('teamcityToken' in body) tokenResult.teamcity = writeTokenSecure('teamcity', body.teamcityToken);
    if ('gitlabToken' in body) tokenResult.gitlab = writeTokenSecure('gitlab', body.gitlabToken);
    applyConfig();
    _summaryCache.clear();       // могла смениться папка проектов → инвалидируем кэш парса
    _jiraCache.clear();          // сменились host/email/token → сбросить кэш статусов Jira
    _tcCache.clear();            // сменился TeamCity host/token → перечитать сборки
    _buildActiveCache.clear();
    _mrCache.clear();            // сменился GitLab host/token → перечитать MR
    sendJSON(res, { ok: true, tokenResult, config: configView() });
    return;
  }
  sendJSON(res, configView());
}

// -------- Автоимпорт токенов/путей из уже существующих секретов Claude Code (кнопка «Подтянуть токены»). --------
// Сканируем источники (более явный → выше): process.env (включает Deck/.env, загруженный на старте) → env MCP-серверов
// в ~/.claude.json → env MCP-серверов в .mcp.json проектов. Наружу значения НЕ отдаём — только флаги/источники.
function hasStoredToken(svc) { try { return existsSync(tokenFile(svc)); } catch { return false; } }
// Конкретные .env-файлы для «Подтянуть токены»: установленный app не наследует shell-env и HERE у него в asar (там .env нет),
// поэтому читаем файлы по явным путям — заданный в настройках secretsEnvPath (файл или папка) + <repo>/.env + .env в рабочих
// папках известных сессий (там и лежит наш D:\claude-deck\.env). Порядок = приоритет (первый выигрывает в take()).
function secretsEnvCandidates() {
  const out = [], seen = new Set();
  const add = (p) => { if (p && !seen.has(p)) { seen.add(p); out.push(p); } };
  try {
    let p = loadConfig().secretsEnvPath; p = p && String(p).trim();
    if (p) { p = path.resolve(p); try { if (statSync(p).isDirectory()) p = path.join(p, '.env'); } catch {} add(p); }
  } catch {}
  add(path.join(HERE, '.env'));
  for (const cwd of uniqueSessionCwds()) add(path.join(cwd, '.env'));
  return out;
}
function scanSecretSources() {
  const want = ['JIRA_TOKEN', 'JIRA_EMAIL', 'JIRA_HOST', 'TEAMCITY_TOKEN', 'TEAMCITY_HOST', 'GITLAB_TOKEN', 'GITLAB_HOST', 'WO_STATES_DIR', 'CLAUDE_PROJECTS_DIR'];
  const found = {};
  const take = (k, v, source) => { if (!found[k] && v != null && String(v).trim()) found[k] = { value: String(v), source }; };
  for (const k of want) take(k, process.env[k], 'process.env/.env');
  for (const p of secretsEnvCandidates()) { const env = parseEnvFile(p); if (env) for (const k of want) take(k, env[k], p); }
  try {
    const j = JSON.parse(readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
    const scan = (servers, where) => { if (servers && typeof servers === 'object') for (const [name, cfg] of Object.entries(servers)) { const env = cfg && cfg.env; if (env) for (const k of want) take(k, env[k], where + '.' + name + '.env'); } };
    scan(j.mcpServers, '~/.claude.json:mcpServers');
    if (j.projects && typeof j.projects === 'object') for (const pc of Object.values(j.projects)) scan(pc && pc.mcpServers, '~/.claude.json:projects.mcpServers');
  } catch {}
  for (const cwd of uniqueSessionCwds()) {
    try { const j = JSON.parse(readFileSync(path.join(cwd, '.mcp.json'), 'utf8')); if (j.mcpServers) for (const [name, cfg] of Object.entries(j.mcpServers)) { const env = cfg && cfg.env; if (env) for (const k of want) take(k, env[k], cwd + '/.mcp.json:' + name + '.env'); } } catch {}
  }
  return found;
}
async function apiImportTokens(req, res) {
  let body = {}; try { body = await readJsonBody(req, 4096); } catch {}
  const overwrite = !!(body && body.overwrite);
  const cur = loadConfig();
  // путь к .env из поля настроек — сохраняем ДО скана (scanSecretSources читает config.secretsEnvPath)
  if (typeof body.secretsEnvPath === 'string') { cur.secretsEnvPath = body.secretsEnvPath.trim(); try { mkdirSync(path.dirname(configFile()), { recursive: true }); writeFileSync(configFile(), JSON.stringify(cur, null, 2)); } catch {} }
  const found = scanSecretSources();
  const result = {}, sources = {};
  // Хосты/пути → deck-config.json. Не перетираем заполненное (если не overwrite).
  const setCfg = (cfgKey, srcKey) => {
    const f = found[srcKey];
    if (!f) { result[cfgKey] = 'notfound'; return; }
    sources[cfgKey] = f.source;
    if (cur[cfgKey] && String(cur[cfgKey]).trim() && !overwrite) { result[cfgKey] = 'kept'; return; }
    cur[cfgKey] = f.value; result[cfgKey] = 'imported';   // host'ы applyConfig нормализует сам
  };
  setCfg('jiraHost', 'JIRA_HOST'); setCfg('jiraEmail', 'JIRA_EMAIL');
  setCfg('teamcityHost', 'TEAMCITY_HOST'); setCfg('gitlabHost', 'GITLAB_HOST');
  setCfg('woStatesDir', 'WO_STATES_DIR'); setCfg('claudeProjectsDir', 'CLAUDE_PROJECTS_DIR');
  try { mkdirSync(path.dirname(configFile()), { recursive: true }); writeFileSync(configFile(), JSON.stringify(cur, null, 2)); } catch {}
  // Токены → safeStorage. Не перетираем уже сохранённый (если не overwrite). Значения не логируем/не отдаём.
  const setTok = (svc, srcKey) => {
    const f = found[srcKey];
    if (!f) { result[svc + 'Token'] = 'notfound'; return; }
    sources[svc + 'Token'] = f.source;
    if (hasStoredToken(svc) && !overwrite) { result[svc + 'Token'] = 'kept'; return; }
    const r = writeTokenSecure(svc, f.value);
    result[svc + 'Token'] = (r && r.ok) ? 'imported' : (r && r.standalone) ? 'standalone' : 'error';
  };
  setTok('jira', 'JIRA_TOKEN'); setTok('teamcity', 'TEAMCITY_TOKEN'); setTok('gitlab', 'GITLAB_TOKEN');
  applyConfig();
  _summaryCache.clear(); _jiraCache.clear(); _tcCache.clear(); _buildActiveCache.clear(); _mrCache.clear();
  sendJSON(res, { ok: true, electron: !!getElectron(), result, sources, config: configView() });
}

// -------- D1: авторизация Claude ИЗ приложения (без ручного терминала). Через CLI `claude auth`. --------
// Резолвим бинарь claude (PATH; на будущее macOS PATH куцый — можно доопределить через CLAUDE_BIN).
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
let _authCache = { ts: 0, data: null };
const AUTH_TTL = 8000;
function claudeAuthStatus() {
  return new Promise((resolve) => {
    execFile(CLAUDE_BIN, ['auth', 'status', '--json'], { timeout: 12000, windowsHide: true, shell: process.platform === 'win32' }, (err, stdout) => {
      let j = null; try { j = JSON.parse(String(stdout || '').trim()); } catch {}
      if (j && typeof j.loggedIn === 'boolean') resolve({ loggedIn: j.loggedIn, email: j.email || null, orgName: j.orgName || null, subscriptionType: j.subscriptionType || null, authMethod: j.authMethod || null });
      else resolve({ loggedIn: false, reason: (err && err.message) || 'no status', raw: String(stdout || '').slice(0, 200) });
    });
  });
}
async function apiAuth(res) {
  if (_authCache.data && Date.now() - _authCache.ts < AUTH_TTL) { sendJSON(res, _authCache.data); return; }
  const data = await claudeAuthStatus();
  _authCache = { ts: Date.now(), data };
  sendJSON(res, data);
}
// Логин: спавним `claude auth login --claudeai` (пайпы → режим «вставь код»), парсим OAuth-URL из stdout,
// отдаём клиенту (тот открывает в системном браузере). Держим процесс до ввода кода.
const logins = new Map();   // loginId -> { child, buf }
let activeLoginId = null;   // single-flight: пока логин идёт, не спавним второй `claude auth login` (= второе окно браузера)
function clearActiveLogin(id) { if (activeLoginId === id) activeLoginId = null; }

// Успех логина ловим по ЛЮБОМУ пути: `claude auth login` часто завершает OAuth сам через колбэк браузера
// (процесс выходит 0 + пишет ~/.claude/.credentials.json), кода не спрашивая. Помимо ввода кода детектим:
// (а) exit 0, (б) обновление credentials-файла, (в) `claude auth status` = залогинен — что раньше, то и финал.
const credsFile = () => path.join(os.homedir(), '.claude', '.credentials.json');
function credsMtime() { try { return statSync(credsFile()).mtimeMs; } catch { return 0; } }
async function finalizeLoginIfLoggedIn(loginId, rec) {
  if (rec.finalized) return true;
  const st = await claudeAuthStatus();
  if (!st.loggedIn) return false;
  rec.finalized = true; rec.done = true; rec.ok = true;
  if (rec.watcher) { clearInterval(rec.watcher); rec.watcher = null; }
  try { rec.child.kill(); } catch {}                    // процесс мог ещё ждать код — больше не нужен
  clearActiveLogin(loginId);
  logins.delete(loginId);
  _authCache = { ts: Date.now(), data: st };            // следующий /api/auth сразу вернёт свежий loggedIn:true
  return true;
}
function watchLoginSuccess(loginId, rec) {
  const t0 = Date.now();
  rec.watcher = setInterval(() => {
    if (rec.finalized || !logins.has(loginId)) { clearInterval(rec.watcher); rec.watcher = null; return; }
    if (Date.now() - t0 > 180000) { clearInterval(rec.watcher); rec.watcher = null; return; }   // таймаут ~3мин
    rec.ticks = (rec.ticks || 0) + 1;
    // дешёвый сигнал каждые 1.5с (creds-файл обновился) + дорогой `claude auth status` раз в ~4.5с (creds могут быть в keychain)
    if (credsMtime() > rec.credsMtime0 || rec.ticks % 3 === 0) finalizeLoginIfLoggedIn(loginId, rec);
  }, 1500);
}
function apiAuthLogin(res) {
  // Уже есть незавершённый логин — переиспользуем его процесс/URL, а не плодим второй (двойной клик, повторный вызов).
  if (activeLoginId) {
    const cur = logins.get(activeLoginId);
    if (cur && !cur.done) {
      if (cur.url) { sendJSON(res, { loginId: activeLoginId, url: cur.url, reused: true }); return; }
      const t0 = Date.now();   // URL ещё не распарсился — дождёмся его на уже запущенном процессе
      const iv = setInterval(() => {
        if (cur.url || cur.done || Date.now() - t0 > 8000) { clearInterval(iv); sendJSON(res, { loginId: activeLoginId, url: cur.url || '', reused: true }); }
      }, 150);
      return;
    }
    activeLoginId = null;   // прошлый логин уже завершён — можно начинать новый
  }
  const loginId = 'lg_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  let child;
  try { child = spawn(CLAUDE_BIN, ['auth', 'login', '--claudeai'], { windowsHide: true, shell: process.platform === 'win32' }); }
  catch (e) { sendJSON(res, { error: 'spawn failed: ' + (e && e.message) }, 500); return; }
  const rec = { child, buf: '', url: '', done: false, ok: false, finalized: false, watcher: null, credsMtime0: credsMtime() };
  logins.set(loginId, rec);
  activeLoginId = loginId;
  let replied = false;
  const reply = (obj, code) => { if (replied) return; replied = true; sendJSON(res, obj, code); };
  const onData = (d) => {
    rec.buf += String(d);
    const m = rec.buf.match(/https?:\/\/\S*oauth\/authorize\S+/);
    if (m && !rec.url) { rec.url = m[0]; reply({ loginId, url: rec.url }); }
    if (/login successful/i.test(rec.buf)) finalizeLoginIfLoggedIn(loginId, rec);
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('exit', (c) => {
    rec.done = true;
    clearActiveLogin(loginId);                 // процесс завершился — освобождаем single-flight
    _authCache = { ts: 0, data: null };        // следующий /api/auth пересчитает
    if (c === 0) { rec.ok = true; finalizeLoginIfLoggedIn(loginId, rec); }   // самозавершение через колбэк браузера — подтвердить и закешировать успех
  });
  child.on('error', () => { rec.done = true; clearActiveLogin(loginId); });
  setTimeout(() => reply({ loginId, url: rec.url || '' }), 8000);   // на случай, если URL не распарсился — вернём что есть
  watchLoginSuccess(loginId, rec);   // параллельно ждём успех по creds/status (кода может и не быть)
}
// Приём вставленного кода: пишем в stdin процесса логина, ждём завершения/успеха, отдаём свежий статус.
async function apiAuthCode(req, res) {
  let body; try { body = await readJsonBody(req, 16 * 1024); } catch { sendJSON(res, { error: 'bad body' }, 400); return; }
  const id = String(body.loginId || '');
  const rec = logins.get(id);
  // Логин мог уже самозавершиться (watcher финализировал и удалил rec) — отдаём текущий статус, а не ошибку.
  if (!rec) { const status = await claudeAuthStatus(); sendJSON(res, { ok: !!status.loggedIn, status }); return; }
  const code = String(body.code || '').trim();
  try { rec.child.stdin.write(code + '\n'); } catch {}
  // ждём завершения процесса до ~30с
  const t0 = Date.now();
  while (!rec.done && Date.now() - t0 < 30000) { await new Promise((r) => setTimeout(r, 300)); }
  if (rec.watcher) { clearInterval(rec.watcher); rec.watcher = null; }
  logins.delete(id);
  clearActiveLogin(id);
  _authCache = { ts: 0, data: null };
  const status = await claudeAuthStatus();
  sendJSON(res, { ok: !!status.loggedIn, status });
}
function apiAuthCancel(req, res, u) {
  const id = u.searchParams.get('id') || '';
  const rec = logins.get(id);
  if (rec) { if (rec.watcher) { clearInterval(rec.watcher); rec.watcher = null; } try { rec.child.kill(); } catch {} logins.delete(id); }
  clearActiveLogin(id);
  sendJSON(res, { ok: true });
}
function apiAuthLogout(res) {
  execFile(CLAUDE_BIN, ['auth', 'logout'], { timeout: 12000, windowsHide: true, shell: process.platform === 'win32' }, () => {
    _authCache = { ts: 0, data: null };
    sendJSON(res, { ok: true });
  });
}

// -------- статика web/ (D4c: клиент разбит на ES-модули + deck.css). Path-safe: только из web/. --------
const WEB_DIR = path.join(HERE, 'web');
const WEB_MIME = { '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.map': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8' };
function serveWeb(pathname, res) {
  const base = path.resolve(WEB_DIR);
  const resolved = path.resolve(base, pathname.replace(/^\/+/, ''));
  if (resolved !== base && !resolved.startsWith(base + path.sep)) { res.writeHead(403); res.end('forbidden'); return; }
  let buf; try { buf = readFileSync(resolved); } catch { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': WEB_MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(buf);
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url || '/', 'http://localhost');
  if (u.pathname === '/api/sessions') { apiSessions().then((d) => sendJSON(res, d)).catch((e) => sendJSON(res, { error: String(e && e.message || e) }, 500)); return; }
  if (u.pathname === '/api/session') {
    const out = apiSession(u.searchParams.get('file') || '');
    if (out.error) { sendJSON(res, { error: out.error }, out.code || 400); return; }
    sendJSON(res, out);
    return;
  }
  if (u.pathname === '/api/session-tail') {
    const out = apiSessionTail(u.searchParams.get('file') || '', Number(u.searchParams.get('after')) || 0);
    if (out.error) { sendJSON(res, { error: out.error }, out.code || 400); return; }
    sendJSON(res, out);
    return;
  }
  if (u.pathname === '/api/skills') {
    const cwd = u.searchParams.get('cwd') || '';
    if (cwd) { const skills = collectSkills(cwd); sendJSON(res, { cwd, count: skills.length, skills }); return; }
    const skills = collectAllSkills();   // без cwd — агрегат всех доступных скиллов (для вкладки «Скиллы»)
    sendJSON(res, { count: skills.length, skills });
    return;
  }
  if (u.pathname === '/api/mcp/status') { apiMcpStatus(res, u).catch((e) => sendJSON(res, { available: false, error: String(e && e.message || e) }, 500)); return; }
  if (u.pathname === '/api/mcp/login') { apiMcpLogin(res, u); return; }
  if (u.pathname === '/api/mcp/remove') { apiMcpRemove(res, u); return; }
  if (u.pathname === '/api/unity/instances') { apiUnityInstances(res, u); return; }
  if (u.pathname === '/api/mcp') { apiMcp(res); return; }
  if (u.pathname === '/api/tags') { apiTags(req, res); return; }
  if (u.pathname === '/api/session-name') { apiSessionName(req, res); return; }
  if (u.pathname === '/api/file') { apiFile(res, u); return; }
  if (u.pathname === '/api/delete-session') { apiDeleteSession(req, res); return; }
  if (u.pathname === '/api/agents') {
    const out = apiAgents(u.searchParams.get('file') || '');
    if (out.error) { sendJSON(res, { error: out.error }, out.code || 400); return; }
    sendJSON(res, out);
    return;
  }
  if (u.pathname === '/api/usage') { apiUsage(res); return; }
  if (u.pathname === '/api/models') { apiModels(res); return; }
  if (u.pathname === '/api/chat-prepare') { apiChatPrepare(req, res); return; }
  if (u.pathname === '/api/chat') { apiChat(req, res, u); return; }
  if (u.pathname === '/api/approve') { apiApprove(res, u); return; }
  if (u.pathname === '/api/stop') { apiStop(res, u); return; }
  if (u.pathname === '/api/build') { apiBuild(res, u); return; }
  if (u.pathname === '/api/mrs') { apiMrs(res, u); return; }
  if (u.pathname === '/api/jira') { apiJira(res, u); return; }
  if (u.pathname === '/api/config/import-tokens') { apiImportTokens(req, res).catch((e) => sendJSON(res, { ok: false, error: String(e && e.message || e) }, 500)); return; }
  if (u.pathname === '/api/config') { apiConfig(req, res); return; }
  if (u.pathname === '/api/auth') { apiAuth(res); return; }
  if (u.pathname === '/api/auth/login') { apiAuthLogin(res); return; }
  if (u.pathname === '/api/auth/code') { apiAuthCode(req, res); return; }
  if (u.pathname === '/api/auth/cancel') { apiAuthCancel(req, res, u); return; }
  if (u.pathname === '/api/auth/logout') { apiAuthLogout(res); return; }
  if (u.pathname.startsWith('/js/') || u.pathname.startsWith('/css/')) { serveWeb(u.pathname, res); return; }
  try {
    const html = readFileSync(path.join(HERE, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
  } catch {
    res.writeHead(500);
    res.end('index.html не найден рядом с server.mjs');
  }
});

// Экспорт для Electron: поднять сервер на СВОБОДНОМ порту (listen(0)) и вернуть реальные port/url/close.
// preferredPort: явный порт (напр. standalone 4317); иначе env PORT; иначе 0 → ОС выдаёт свободный.
export function startServer(preferredPort) {
  const listenPort = preferredPort != null ? preferredPort : (Number(process.env.PORT) || 0);
  return new Promise((resolve) => {
    server.listen(listenPort, () => {
      const port = server.address().port;
      const url = 'http://localhost:' + port;
      console.log('');
      console.log('  Deck — доска сессий Claude Code');
      console.log('  папка сессий:   ' + PROJECTS_DIR);
      console.log('  папка статусов: ' + (WO_STATES_DIR || '(не задана — задайте в Настройках/WO_STATES_DIR)'));
      console.log('  адрес:          ' + url);
      console.log('');
      resolve({ port, url, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

// Прямой запуск (`node server.mjs`, лаунчеры start-deck.*) — авто-старт на 4317 (или env PORT). При импорте (Electron) — нет.
const _isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (_isMain) startServer(Number(process.env.PORT) || 4317);

// Named-экспорты чистых хелперов для тестов (D4b). Аддитивно — поведение не меняем. startServer уже экспортирован.
export {
  isBaseBranch, pickWorkingBranch, pickBaseBranch,
  classifyUserBlock, buildSessionBlocks,
  wfInfo, scopeInfo,
  isReadOnlyTool, briefArg, woOf, columnByAge,
};
