// Deck — общий kernel сервера: .env/конфиг, живые конфиг-привязки (applyConfig), секретные токены,
// проекты-workspaces, словари/константы времени, рантайм-Map'ы разрешений и утилиты ответа/ввода.

import { readFileSync, writeFileSync, mkdirSync, renameSync, cpSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

export const HERE = path.dirname(fileURLToPath(import.meta.url));

// zero-dep .env парсер: простой KEY=VALUE, игнор #/пустых, trim, снятие кавычек. Возвращает объект пар.
export function parseEnvText(raw) {
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
export function parseEnvFile(p) { try { return parseEnvText(readFileSync(p, 'utf8')); } catch { return null; } }
// Подхватываем <repo>/.env при старте, НЕ перезаписывая уже заданное в окружении (source-режим; в установленном
// app HERE = внутри asar, .env там нет — концы токенов тянет «Подтянуть токены» из явного пути, см. secretsEnvCandidates).
(function loadDotEnv() {
  const env = parseEnvFile(path.join(HERE, '.env'));
  if (env) for (const [k, v] of Object.entries(env)) if (!(k in process.env)) process.env[k] = v;
})();

export const PORT = Number(process.env.PORT) || 4317;

// -------- Конфиг Deck (TECH-6): userData/deck-config.json в Electron, иначе рядом с server.mjs. --------
// Резолв значений: config → env/.env → дефолт. Хардкода пути WO_STATES_DIR больше НЕТ: пусто → доска мягко деградирует.
const _require = createRequire(import.meta.url);
let _electron;
export function getElectron() {
  if (_electron !== undefined) return _electron;
  _electron = null;
  // Реальный API `electron` есть только внутри Electron-main; в standalone `require('electron')` даёт строку-путь — не трогаем.
  if (process.versions.electron) { try { _electron = _require('electron'); } catch {} }
  return _electron;
}
export function userDataDir() { const e = getElectron(); if (e && e.app) { try { return e.app.getPath('userData'); } catch {} } return HERE; }
export function configFile() { return path.join(userDataDir(), 'deck-config.json'); }
// Диагностический лог (почему рвётся SSE-канал чата). Пишем в userData/deck-debug.log — читается снаружи, чинится удалением.
export function dbgLog(line) { try { writeFileSync(path.join(userDataDir(), 'deck-debug.log'), new Date().toISOString() + ' ' + line + '\n', { flag: 'a' }); } catch {} }
export function loadConfig() { try { const c = JSON.parse(readFileSync(configFile(), 'utf8')); return (c && typeof c === 'object') ? c : {}; } catch { return {}; } }
export function saveConfig(patch) {
  const c = loadConfig();
  for (const k of ['woStatesDir', 'claudeProjectsDir', 'jiraHost', 'jiraEmail', 'teamcityHost', 'gitlabHost', 'clientUnityParent', 'unityEditorsDir', 'unityHubPath', 'secretsEnvPath']) if (k in patch) c[k] = String(patch[k] || '');
  try { mkdirSync(path.dirname(configFile()), { recursive: true }); writeFileSync(configFile(), JSON.stringify(c, null, 2)); return true; } catch { return false; }
}
// Проекты (workspaces): список открытых папок + активная. Доска скоупится на активный проект (сессии по cwd-префиксу),
// новая сессия стартует в его папке. Так Deck не привязан к одной машине — любой открывает свою папку («как в VS Code»).
export function slugForPath(p) { return String(p || '').replace(/[^a-zA-Z0-9]/g, '-'); }   // как Claude Code именует ~/.claude/projects/<slug> из cwd
export function loadProjects() { const c = loadConfig(); return { projects: Array.isArray(c.projects) ? c.projects : [], activeId: c.activeProjectId || '' }; }
export function saveProjects(list, activeId) {
  const c = loadConfig();
  c.projects = Array.isArray(list) ? list : (c.projects || []);
  if (activeId !== undefined) c.activeProjectId = activeId || '';
  try { mkdirSync(path.dirname(configFile()), { recursive: true }); writeFileSync(configFile(), JSON.stringify(c, null, 2)); return true; } catch { return false; }
}
export function activeProject() { const { projects, activeId } = loadProjects(); return projects.find((p) => p.id === activeId) || null; }
// Секретные токены (Jira/TeamCity/GitLab): в Electron шифруем safeStorage'ом (как update-token в D3) в userData/<svc>-token.bin;
// в standalone безопасно сохранить нельзя — фолбэк на .env (<SVC>_TOKEN).
export function tokenFile(service) { return path.join(userDataDir(), service + '-token.bin'); }
export function readTokenSecure(service) {
  const e = getElectron();
  if (e && e.safeStorage) { try { if (e.safeStorage.isEncryptionAvailable()) return e.safeStorage.decryptString(readFileSync(tokenFile(service))) || ''; } catch {} }
  return '';
}
export function writeTokenSecure(service, tok) {
  tok = String(tok || '');
  if (!tok) { try { rmSync(tokenFile(service), { force: true }); } catch {} return { ok: true, cleared: true }; }
  const e = getElectron();
  if (e && e.safeStorage && e.safeStorage.isEncryptionAvailable()) {
    try { mkdirSync(path.dirname(tokenFile(service)), { recursive: true }); writeFileSync(tokenFile(service), e.safeStorage.encryptString(tok)); return { ok: true, storage: 'safeStorage' }; }
    catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
  }
  return { ok: false, standalone: true };   // standalone — задать токен можно только через .env
}

export let PROJECTS_DIR, WO_STATES_DIR, JIRA_HOST, JIRA_EMAIL, JIRA_TOKEN, JIRA_ENABLED, TC_HOST, TC_TOKEN, GL_HOST, GL_TOKEN;
export function applyConfig() {
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

export const CTX_LIMIT = 1_000_000;          // сессии на 1M-контексте
export const ACTIVE_MS = 30 * 60 * 1000;     // «активна», если mtime моложе 30 минут
export const WORKING_MS = 20 * 1000;         // «работает сейчас»: файл сессии писался < 20с назад (живая генерация)
export const BG_ACTIVE_MS = 60 * 1000;       // фоновый сабагент «живой», если его файл писался < 60с назад
export const LIST_CAP = 150;                 // сколько самых свежих сессий листаем
export const MSG_CAP = 8000;                 // максимум символов на текстовый блок транскрипта
export const SYSREM = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

// Метки скоупа задачи из dev-workflow-состояния: env, который не является реальным окружением деплоя.
export const NON_ENVS = new Set(['null', 'без деплоя', 'local', '']);

// Базовые (не рабочие) ветки: preprod/preupdate/master/… — источник форка, а не ветка задачи.
export const BASE_BRANCHES = new Set(['preprod', 'preupdate', 'master', 'main', 'develop', 'dev', 'prod', 'release', 'head', '']);

// -------- P2: аппрув инструментов (canUseTool). Читающее — молча allow; пишущее/выполняющее — спросить. --------
export const pendingApprovals = new Map();   // approvalId -> { decide(decision), tool, input, sessionKey }
export const pendingApprovalsByKey = new Map(); // sessionKey -> Set(approvalId) — для ре-сёрфейса висящих аппрувов при перезаходе (обрыв SSE не решает за пользователя)
// Вопросы к пользователю (AskUserQuestion/ExitPlanMode) — НЕ разрешения, а ввод: ждут реального ответа человека.
export const pendingQuestions = new Map();      // questionId -> { resolve(answers), questions, sessionKey }
export const pendingQuestionsByKey = new Map(); // sessionKey -> Set(questionId) — для ре-сёрфейса висящих вопросов при перезаходе
export const activeStreams = new Map();      // streamId -> AbortController (для гарантированного /api/stop)
export const sessionAllow = new Map();       // sessionId -> Set<toolName> (сессионный «Разрешить всё»)
export const VALID_MODES = new Set(['default', 'acceptEdits', 'plan', 'bypassPermissions']);   // P3: режимы разрешений
export const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);               // уровни reasoning-effort SDK
export const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'WebFetch', 'WebSearch', 'TodoWrite']);
// Инструменты пользовательского ВВОДА: режим (bypass/acceptEdits/closed/session-allow) даёт право ВЫПОЛНИТЬ инструмент,
// но не право ОТВЕТИТЬ за пользователя. Их НЕ гейтим как разрешение — вопрос показываем всегда и ждём ответ (PostToolUse-hook).
export const USER_INPUT_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);   // правки файлов — авто-принимаются в acceptEdits

// -------- P4: стадирование вложений. base64-картинки не влезают в query-string EventSource — принимаем
// POST-телом, храним в памяти по одноразовому токену, поток /api/chat?token=... поднимает подготовленный запрос. --------
export const stagedRequests = new Map();   // token -> { sessionFile, prompt, mode, attachments, ts }

// Резолвим бинарь claude (PATH; на будущее macOS PATH куцый — можно доопределить через CLAUDE_BIN).
export const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

// -------- общие утилиты ответа/ввода --------

export function sendJSON(res, obj, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
export function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > maxBytes) { reject(new Error('payload too large')); try { req.destroy(); } catch {} return; } chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}
// Перенос пути; renameSync не умеет через диски (projects на C:, deck-trash на D: → EXDEV) — фолбэк copy+remove.
export function movePath(src, dest) {
  try { renameSync(src, dest); }
  catch (e) { if (e && e.code === 'EXDEV') { cpSync(src, dest, { recursive: true }); rmSync(src, { recursive: true, force: true }); } else throw e; }
}
export const oneLine = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
export const cap = (s) => (s.length > MSG_CAP ? s.slice(0, MSG_CAP) + '\n…' : s);
