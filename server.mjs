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
import { readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// zero-dep .env loader: подхватываем <repo>/.env (JIRA_HOST/JIRA_EMAIL/JIRA_TOKEN и пр.) при старте,
// НЕ перезаписывая уже заданное в окружении. Простой KEY=VALUE, игнор #/пустых, trim, снятие кавычек.
(function loadDotEnv() {
  let raw = '';
  try { raw = readFileSync(path.join(HERE, '.env'), 'utf8'); } catch { return; }
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s[0] === '#') continue;
    const eq = s.indexOf('=');
    if (eq < 1) continue;
    const key = s.slice(0, eq).trim();
    let val = s.slice(eq + 1).trim();
    if (val.length >= 2 && ((val[0] === '"' && val.endsWith('"')) || (val[0] === "'" && val.endsWith("'")))) val = val.slice(1, -1);
    if (!(key in process.env)) process.env[key] = val;
  }
})();

const PORT = Number(process.env.PORT) || 4317;
const PROJECTS_DIR = process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
const WO_STATES_DIR = process.env.WO_STATES_DIR || 'D:/wo_vibecode/vibecode/.claude/skills/dev-workflow/workflow-states';
const CTX_LIMIT = 1_000_000;          // сессии на 1M-контексте
const ACTIVE_MS = 30 * 60 * 1000;     // «активна», если mtime моложе 30 минут
const WORKING_MS = 20 * 1000;         // «работает сейчас»: файл сессии писался < 20с назад (живая генерация)
const LIST_CAP = 150;                 // сколько самых свежих сессий листаем
const MSG_CAP = 8000;                 // максимум символов на текстовый блок транскрипта
const SYSREM = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

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
  if (!m) return '—';
  const x = m.match(/(opus|sonnet|haiku)-(\d+)-(\d+)/i);
  if (x) return x[1][0].toUpperCase() + x[1].slice(1).toLowerCase() + ' ' + x[2] + '.' + x[3];
  return m.replace(/^claude-/, '');
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
  if (step >= 13) col = 'merge';
  else if (st.serverApprovalRequired && !st.approvedForMR) col = 'merge';
  else if (hasMr) col = (st.testedOnSquad || step >= 13) ? 'merge' : 'qa';
  else if (build || (step >= 7 && step < 11)) col = 'build';
  else col = active ? 'active' : 'todo';

  // Метки карточки. ВНИМАНИЕ: buildState — приближение по buildTriggered/стадии,
  // не live-статус TeamCity (queued/running/success по Android/iOS) — это отдельная фаза.
  const buildState = (build && step < 13 && (col === 'build' || col === 'qa')) ? 'running'
    : (st.testedOnSquad === true || step >= 13) ? 'done' : 'none';
  const mrState = step >= 13 ? 'merged' : 'open';

  return {
    wfColumn: col, wfStep: step, wfMr: mrUrl || hasMr, wfBuild: build,
    wfMrUrl: mrUrl || null, wfMrState: mrState, wfBuildState: buildState,
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

function buildSessionSummary(f, wfStates) {
  let text = '';
  try { text = readFileSync(f.full, 'utf8'); } catch { text = ''; }
  const cwd = firstString(text, 'cwd') || '';
  // Рабочая (не-базовая) ветка сессии — см. pickWorkingBranch. cwd остаётся first (не меняется).
  const gitBranch = pickWorkingBranch(allStrings(text, 'gitBranch'));
  let title = lastString(text, 'aiTitle');
  const lastPrompt = lastString(text, 'lastPrompt') || '';
  if (!title) title = (lastPrompt || '').split('\n')[0].slice(0, 80) || '(без заголовка)';
  const model = prettyModel(lastString(text, 'model'));
  const winTokens = lastUsageWindow(text);
  const project = cwd ? path.basename(cwd.replace(/[\\/]+$/, '')) : f.projDir;
  // WO: рабочая ветка → заголовок → первичный WO из первого промпта
  const wo = woOf(gitBranch) || woOf(title) || firstUserWo(text);
  const active = (Date.now() - f.mtime) < ACTIVE_MS;
  const st = wo ? wfStates.get(wo) : null;
  const wf = wfInfo(st, active);
  const scope = scopeInfo(st, cwd);
  return {
    id: f.id,
    file: f.rel,
    title, lastPrompt, cwd, project, gitBranch, wo, model,
    msgs: countMessages(text),
    winTokens,
    ctxPct: Math.min(winTokens / CTX_LIMIT, 1),
    mtime: f.mtime,
    active,
    working: (Date.now() - f.mtime) < WORKING_MS,   // живая генерация прямо сейчас (< 20с)
    column: columnByAge(f.mtime),
    ...wf,
    ...scope,
  };
}

function apiSessions() {
  const all = listSessionFiles().sort((a, b) => b.mtime - a.mtime);
  const top = all.slice(0, LIST_CAP);
  const wfStates = loadWfStates();   // читается один раз на запрос
  const sessions = top.map((f) => buildSessionSummary(f, wfStates));
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
    if (role === 'assistant' && msg.model) model = msg.model;
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
  const active = (Date.now() - mtime) < ACTIVE_MS;
  // Стадия/билд/MR/скоуп из dev-workflow — те же поля, что и на карточке, чтобы правый рейл их отражал.
  const st = wo ? loadWfStates().get(wo) : null;
  const wf = wfInfo(st, active);
  const scope = scopeInfo(st, cwd);
  const notes = notesFromClarifications(st && st.userClarifications);
  return {
    id: path.basename(rp.resolved).replace(/\.jsonl$/, ''),
    file: relFile,
    title, lastPrompt, cwd,
    project: cwd ? path.basename(cwd.replace(/[\\/]+$/, '')) : '',
    gitBranch,
    wo,
    model: prettyModel(model),
    winTokens,
    ctxPct: Math.min(winTokens / CTX_LIMIT, 1),
    mtime,
    active,
    working: (Date.now() - mtime) < WORKING_MS,
    blocks,
    count: msgCount,
    notes,
    ...wf,
    ...scope,
  };
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
function apiMcp(res) {
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
  const servers = [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
  sendJSON(res, { count: servers.length, servers });
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
let _sdkQuery = null;
async function getSdkQuery() {
  if (_sdkQuery) return _sdkQuery;
  const mod = await import('@anthropic-ai/claude-agent-sdk');
  _sdkQuery = mod.query;
  return _sdkQuery;
}

// -------- Аккаунт-лимиты Claude (5ч / 7д) через control-request usage() SDK — тот же OAuth-логин, без инференса. --------
let _usage = { ts: 0, data: null };
const USAGE_TTL = 45000;
async function fetchUsageRaw() {
  const query = await getSdkQuery();
  const ac = new AbortController();
  async function* openInput() { await new Promise((r) => setTimeout(r, 30000)); }   // держим ввод открытым, НЕ шлём turn
  const q = query({ prompt: openInput(), options: { permissionMode: 'plan', settingSources: [], abortController: ac } });
  (async () => { try { for await (const _ of q) { /* keep-alive drain */ } } catch {} })();
  try {
    let lastErr;
    for (const delay of [1800, 2500, 4000]) {   // CLI холодный старт — даём подняться, ретраим control-request
      await new Promise((r) => setTimeout(r, delay));
      try { return await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(); }
      catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('usage unavailable');
  } finally { try { ac.abort(); } catch {} }
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
const sessionAllow = new Map();       // sessionId -> Set<toolName> (сессионный «Разрешить всё»)
const VALID_MODES = new Set(['default', 'acceptEdits', 'plan', 'bypassPermissions']);   // P3: режимы разрешений
const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'WebFetch', 'WebSearch', 'TodoWrite']);
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

// Project-инструкции для system prompt. settingSources:[] (страж) отключает автозагрузку CLAUDE.md —
// подгружаем вручную: CLAUDE.md + один уровень @-импортов (конституция-индекс дальше через [[wikilinks]],
// их не разворачиваем), затем CLAUDE.local.md; впереди — глобальный ~/.claude/CLAUDE.md. Кэш по cwd.
const _instrCache = new Map();
function expandImports(text, baseDir) {
  return String(text).replace(/^﻿/, '').split(/\r?\n/).map((line) => {
    const m = line.replace(/^﻿/, '').match(/^@(\S+)\s*$/);   // снять BOM — строка-импорт может начинаться с него
    if (!m) return line;
    try { return readFileSync(path.resolve(baseDir, m[1]), 'utf8'); } catch { return ''; }   // нет файла — молча
  }).join('\n');
}
function buildProjectInstructions(cwd) {
  if (!cwd) return '';
  if (_instrCache.has(cwd)) return _instrCache.get(cwd);
  const parts = [];
  const addFile = (file, label) => {
    let raw;
    try { raw = readFileSync(file, 'utf8'); } catch { return; }
    const expanded = expandImports(raw, path.dirname(file));
    if (expanded.trim()) parts.push('# ' + label + '\n\n' + expanded);
  };
  addFile(path.join(os.homedir(), '.claude', 'CLAUDE.md'), 'Глобальные инструкции (~/.claude/CLAUDE.md)');
  addFile(path.join(cwd, 'CLAUDE.md'), 'Инструкции проекта (CLAUDE.md)');
  addFile(path.join(cwd, 'CLAUDE.local.md'), 'Локальные инструкции проекта (CLAUDE.local.md)');
  const out = parts.join('\n\n---\n\n');
  _instrCache.set(cwd, out);
  console.log('[projectInstructions] cwd=%s len=%d rootMarker=%s constitutionMarker=%s',
    cwd, out.length, out.includes('Конституция: сослаться ≠ свериться'), out.includes('Конституция проекта'));
  return out;
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
async function apiChatPrepare(req, res) {
  let body;
  try { body = await readJsonBody(req, STAGE_MAX_BYTES); }
  catch (e) { sendJSON(res, { error: (e && e.message) || 'read error' }, 413); return; }
  const sessionFile = String(body.sessionFile || '');
  const prompt = String(body.prompt || '');
  let mode = String(body.mode || 'default'); if (!VALID_MODES.has(mode)) mode = 'default';
  const attachments = Array.isArray(body.attachments) ? body.attachments.slice(0, 20) : [];
  const newSession = body.newSession === true;         // Part 3: создать НОВУЮ сессию (без resume) в cwd
  const cwd = String(body.cwd || '');
  let bytes = 0;
  for (const a of attachments) bytes += (a && a.dataB64 ? a.dataB64.length : 0) + (a && a.text ? a.text.length : 0);
  if (bytes > STAGE_MAX_BYTES) { sendJSON(res, { error: 'attachments too large (~18MB limit)' }, 413); return; }
  const now = Date.now();
  for (const [k, v] of stagedRequests) if (now - v.ts > 5 * 60 * 1000) stagedRequests.delete(k);   // sweep старьё
  const token = 'st_' + now.toString(36) + Math.random().toString(36).slice(2, 10);
  stagedRequests.set(token, { sessionFile, prompt, mode, attachments, newSession, cwd, ts: now });
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
  let relFile = '', prompt = '', mode = 'default', attachments = [], isNew = false, newCwd = '';
  const token = u.searchParams.get('token');
  if (token) {
    const staged = stagedRequests.get(token);
    stagedRequests.delete(token);                                   // одноразовый — чистим сразу
    if (!staged) return fail('stale or unknown token');
    relFile = staged.sessionFile || '';
    prompt = staged.prompt || '';
    mode = staged.mode || 'default';
    attachments = Array.isArray(staged.attachments) ? staged.attachments : [];
    isNew = staged.newSession === true;                             // Part 3: новая сессия без resume
    newCwd = staged.cwd || '';
  } else {
    relFile = u.searchParams.get('file') || '';
    prompt = u.searchParams.get('prompt') || '';
    mode = u.searchParams.get('mode') || 'default';                 // P3: режим разрешений из чата (shift-tab)
  }
  if (!VALID_MODES.has(mode)) mode = 'default';                     // неизвестное → безопасный default
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
  req.on('close', () => { closed = true; try { ac.abort(); } catch {} });

  // canUseTool — ЕДИНСТВЕННЫЙ страж в default-режиме: без него мутирующие инструменты выполнились бы без спроса.
  const canUseTool = async (toolName, input, opts) => {
    if (isReadOnlyTool(toolName)) return { behavior: 'allow', updatedInput: input };
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

  // settingSources:[] выключает автозагрузку CLAUDE.md — возвращаем project-инструкции руками в system prompt.
  const projectInstructions = buildProjectInstructions(cwd);

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

  send({ type: 'start', sessionId: sessionId || '', cwd: cwd || '', isNew });
  try {
    const query = await getSdkQuery();
    const options = {
      cwd,
      permissionMode: mode,           // P3: default | acceptEdits | plan | bypassPermissions (из &mode=)
      canUseTool,                     // read-only → авто-allow; мутирующее → SSE approval + ожидание решения
      settingSources: [],             // изоляция: НЕ грузим .claude/settings.json — иначе его allow-правила
                                      // пропустили бы мутирующие инструменты мимо canUseTool (страж должен быть единственным)
      includePartialMessages: true,   // дельты текста ассистента
      abortController: ac,
      maxTurns: 24,
    };
    if (!isNew) options.resume = sessionId;   // существующая сессия — продолжаем; новая — без resume
    // claude_code-preset + append: дефолтный системный промпт Claude Code ПЛЮС правила проекта (вместо CLAUDE.md-автозагрузки)
    options.systemPrompt = projectInstructions
      ? { type: 'preset', preset: 'claude_code', append: projectInstructions }
      : { type: 'preset', preset: 'claude_code' };
    const q = query({ prompt: sdkPrompt, options });
    for await (const m of q) {
      if (closed) break;
      if (m.type === 'system' && m.subtype === 'init') {
        send({ type: 'system', model: m.model, apiKeySource: m.apiKeySource });
        if (isNew && m.session_id) {                    // Part 3: узнали id новой сессии — сообщаем клиенту файл, чтобы открыть/тейлить
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
    if (!closed) { try { res.end(); } catch {} }
  }
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
const TC_HOST = (process.env.TEAMCITY_HOST || 'https://teamcity.example.com').replace(/\/$/, '');
const TC_TOKEN = process.env.TEAMCITY_TOKEN || '';
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
async function apiBuild(res, u) {
  const branch = u.searchParams.get('branch') || '';
  const wo = u.searchParams.get('wo') || '';
  if (!TC_TOKEN) { sendJSON(res, { available: false, reason: 'no TEAMCITY_TOKEN in server env', host: TC_HOST }); return; }
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
const GL_HOST = (process.env.GITLAB_HOST || 'https://gitlab.example.com').replace(/\/$/, '');
const GL_TOKEN = process.env.GITLAB_TOKEN || '';
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
  if (!GL_TOKEN) { sendJSON(res, { available: false, reason: 'no GITLAB_TOKEN in server env', host: GL_HOST }); return; }
  if (!branch && !wo) { sendJSON(res, { available: true, host: GL_HOST, mrs: [] }); return; }
  const key = branch + '|' + wo;
  const cached = _mrCache.get(key);
  if (cached && Date.now() - cached.ts < MR_TTL) { sendJSON(res, cached.data); return; }
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
const JIRA_HOST = String(process.env.JIRA_HOST || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
const JIRA_EMAIL = process.env.JIRA_EMAIL || '';
const JIRA_TOKEN = process.env.JIRA_TOKEN || '';
const _jiraCache = new Map();   // wo -> { ts, data }
const JIRA_TTL = 30000;

async function apiJira(res, u) {
  const wo = String(u.searchParams.get('wo') || '').trim();
  if (!JIRA_TOKEN || !JIRA_EMAIL || !JIRA_HOST) { sendJSON(res, { available: false, reason: 'no JIRA_HOST/JIRA_EMAIL/JIRA_TOKEN in server env' }); return; }
  if (!/^WO-\d+$/i.test(wo)) { sendJSON(res, { available: true, status: null }); return; }
  const cached = _jiraCache.get(wo);
  if (cached && Date.now() - cached.ts < JIRA_TTL) { sendJSON(res, cached.data); return; }
  try {
    const auth = Buffer.from(JIRA_EMAIL + ':' + JIRA_TOKEN).toString('base64');
    const r = await fetch('https://' + JIRA_HOST + '/rest/api/3/issue/' + encodeURIComponent(wo) + '?fields=status,summary', {
      headers: { Authorization: 'Basic ' + auth, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error('Jira HTTP ' + r.status);
    const j = await r.json();
    const st = j.fields && j.fields.status;
    const data = {
      available: true,
      status: st ? st.name : null,
      category: st && st.statusCategory ? st.statusCategory.key : '',
      summary: (j.fields && j.fields.summary) || '',
    };
    _jiraCache.set(wo, { ts: Date.now(), data });
    sendJSON(res, data);
  } catch (e) {
    sendJSON(res, { available: false, reason: (e && e.message) || String(e) });
  }
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url || '/', 'http://localhost');
  if (u.pathname === '/api/sessions') { sendJSON(res, apiSessions()); return; }
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
  if (u.pathname === '/api/mcp') { apiMcp(res); return; }
  if (u.pathname === '/api/usage') { apiUsage(res); return; }
  if (u.pathname === '/api/chat-prepare') { apiChatPrepare(req, res); return; }
  if (u.pathname === '/api/chat') { apiChat(req, res, u); return; }
  if (u.pathname === '/api/approve') { apiApprove(res, u); return; }
  if (u.pathname === '/api/build') { apiBuild(res, u); return; }
  if (u.pathname === '/api/mrs') { apiMrs(res, u); return; }
  if (u.pathname === '/api/jira') { apiJira(res, u); return; }
  try {
    const html = readFileSync(path.join(HERE, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
  } catch {
    res.writeHead(500);
    res.end('index.html не найден рядом с server.mjs');
  }
});

server.listen(PORT, () => {
  console.log('');
  console.log('  Deck — доска сессий Claude Code');
  console.log('  папка сессий:   ' + PROJECTS_DIR);
  console.log('  папка статусов: ' + WO_STATES_DIR);
  console.log('  открой в браузере:  http://localhost:' + PORT);
  console.log('');
});
