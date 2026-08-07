// Deck — общий kernel сервера: .env/конфиг, живые конфиг-привязки (applyConfig), секретные токены,
// проекты-workspaces, словари/константы времени, рантайм-Map'ы разрешений и утилиты ответа/ввода.

import { readFileSync, writeFileSync, mkdirSync, renameSync, cpSync, rmSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';

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
export function dbgLog(line) {
  try {
    const f = path.join(userDataDir(), 'deck-debug.log');
    try { if (statSync(f).size > 2 * 1024 * 1024) writeFileSync(f, ''); } catch {}   // C9: ротация — не растим лог бесконечно (обнуляем при >2МБ)
    writeFileSync(f, new Date().toISOString() + ' ' + line + '\n', { flag: 'a' });
  } catch {}
}
export function loadConfig() { try { const c = JSON.parse(readFileSync(configFile(), 'utf8')); return (c && typeof c === 'object') ? c : {}; } catch { return {}; } }
export function saveConfig(patch) {
  const c = loadConfig();
  for (const k of ['woStatesDir', 'claudeProjectsDir', 'jiraHost', 'jiraEmail', 'teamcityHost', 'gitlabHost', 'clientUnityParent', 'unityEditorsDir', 'unityHubPath', 'secretsEnvPath', 'envHosts']) if (k in patch) c[k] = String(patch[k] || '');
  try { writeJsonAtomic(configFile(), c); return true; } catch { return false; }   // D1: temp+rename — краш/гонка в момент записи не оставит усечённый конфиг (иначе loadConfig catch→{} потерял бы всё)
}
// Проекты (workspaces): список открытых папок + активная. Доска скоупится на активный проект (сессии по cwd-префиксу),
// новая сессия стартует в его папке. Так Deck не привязан к одной машине — любой открывает свою папку («как в VS Code»).
export function slugForPath(p) { return String(p || '').replace(/[^a-zA-Z0-9]/g, '-'); }   // как Claude Code именует ~/.claude/projects/<slug> из cwd
export function loadProjects() { const c = loadConfig(); return { projects: Array.isArray(c.projects) ? c.projects : [], activeId: c.activeProjectId || '' }; }
export function saveProjects(list, activeId) {
  const c = loadConfig();
  c.projects = Array.isArray(list) ? list : (c.projects || []);
  if (activeId !== undefined) c.activeProjectId = activeId || '';
  try { writeJsonAtomic(configFile(), c); return true; } catch { return false; }   // D1: атомарно (temp+rename) — не потерять список проектов при крахе записи
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
// TECH-4: здоровье интеграций для ВИДИМОЙ деградации (не проглатывать падения TeamCity/GitLab/Jira).
// configured — заданы host+token; ok — прошёл ли последний реальный запрос; reason — текст сбоя.
// Обновляется markHealth'ом из services.mjs, читается /api/health → топбар-индикатор.
export const svcHealth = {
  teamcity: { configured: false, ok: true, reason: '' },
  gitlab: { configured: false, ok: true, reason: '' },
  jira: { configured: false, ok: true, reason: '' },
};
export function markHealth(svc, patch) { const h = svcHealth[svc]; if (h) Object.assign(h, patch, { ts: Date.now() }); }
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
  // «configured» = сервис вообще можно дёргать (есть host+token). Не настроен → индикатор его не показывает
  // как «упавший» (это не сбой, а осознанно выключенная интеграция).
  svcHealth.teamcity.configured = !!(TC_TOKEN && TC_HOST);
  svcHealth.gitlab.configured = !!(GL_TOKEN && GL_HOST);
  svcHealth.jira.configured = JIRA_ENABLED;
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
// Exactly-once доставка подкинутых промтов: pid отмечается ПОТРЕБЛЁННЫМ в момент, когда канал реально отдаёт сообщение
// SDK (gen yield) — не по факту приёма POST. Любой повтор/гонка клиента (перезаход, ретрай, две ветки доставки) видит
// pid как доставленный и не запускает его второй раз. Ключ — sessionId, значение — Set последних pid (кап FIFO).
export const deliveredPids = new Map();       // sessionId -> Set<pid>
export function markPid(key, pid) {
  if (!key || !pid) return;
  let s = deliveredPids.get(key); if (!s) { s = new Set(); deliveredPids.set(key, s); }
  s.add(pid);
  if (s.size > 300) { const first = s.values().next().value; s.delete(first); }   // не растём бесконечно на долгой сессии
}
export function hasPid(key, pid) { if (!key || !pid) return false; const s = deliveredPids.get(key); return !!(s && s.has(pid)); }
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

// X1: единый резолвер бинаря claude для ВСЕХ спавнов (auth, mcp). GUI-запущенный Electron на macOS наследует куцый PATH
// (Finder не даёт /opt/homebrew/bin, /usr/local/bin) → голый `claude` спавнится с ENOENT. На posix резолвим через PATH,
// дополненный типовыми локациями, плюс прямые кандидаты. Windows не трогаем (там PATH+shell:true уже работает —
// не рискуем рабочей настройкой). Ленивый + мемоизированный: execSync НЕ на импорте (тесты/CI не платят и не висят).
let _claudeBin;
export function getClaudeBin() {
  if (_claudeBin !== undefined) return _claudeBin;
  const override = process.env.CLAUDE_BIN;
  if (override) return (_claudeBin = override);
  if (process.platform === 'win32') return (_claudeBin = 'claude');
  const home = os.homedir();
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local'), '/usr/bin', '/bin'];
  const env = { ...process.env, PATH: [process.env.PATH || '', ...extra].filter(Boolean).join(path.delimiter) };
  try {
    const out = String(execSync('command -v claude 2>/dev/null || which claude', { encoding: 'utf8', timeout: 6000, env, shell: '/bin/sh' }) || '').trim();
    const pick = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (pick && existsSync(pick)) return (_claudeBin = pick);
  } catch {}
  for (const c of [path.join(home, '.claude', 'local', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude', path.join(home, '.local', 'bin', 'claude')]) {
    try { if (existsSync(c)) return (_claudeBin = c); } catch {}
  }
  return (_claudeBin = 'claude');   // не нашли — как раньше (пусть spawn попробует PATH)
}

// S1: секрет процесса для гейта /api/. Сервер инжектит его в <meta> index.html — кросс-ориджин вкладка/встраивание
// прочитать HTML не может (SOP), поэтому токен добудет только наша страница. Закрывает no-Origin CSRF (напр.
// <img src="http://localhost:PORT/api/chat?...&prompt=...">), который Host/Origin-гейт пропустил бы (Host=localhost, Origin нет).
export const SESSION_TOKEN = randomBytes(24).toString('hex');

// -------- Статус ходов (наблюдаемость фона) --------
// Ход, запущенный Deck'ом, помечается running, а по завершении — терминальным состоянием (done | max_turns | error |
// aborted). Персистим АТОМАРНО в userData/deck-runs.json, чтобы состояние пережило перезапуск: живые на момент падения
// ходы на старте (initRuns) переводятся в orphaned — видимый маркер вместо «просто остановилось, непонятно что».
// Ключ = session_id (basename .jsonl без расширения) — тот же, что sessionKey в chat.mjs.
export const runStatus = new Map();   // sessionId -> { state, subtype, isError, reason, streamId, ts }
export function runsFile() { return path.join(userDataDir(), 'deck-runs.json'); }
// Атомарная запись JSON: пишем во временный файл рядом и rename'им поверх. Прямой writeFileSync при крахе/гонке в момент
// записи оставлял бы усечённый файл → при чтении catch→{} молча терял бы весь стор. rename на одном диске атомарен,
// tmp кладём в ту же папку (без EXDEV). Возвращает true/бросает — вызывающий сам решает, глотать ли ошибку.
export function writeJsonAtomic(file, obj) {
  const tmp = file + '.' + process.pid + '.tmp';
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, file);
  return true;
}
function saveRuns() { const obj = {}; for (const [k, v] of runStatus) obj[k] = v; try { writeJsonAtomic(runsFile(), obj); } catch {} }
export function setRunStatus(key, patch) {
  if (!key) return;
  const cur = runStatus.get(key) || {};
  runStatus.set(key, { ...cur, ...patch, ts: Date.now() });
  if (runStatus.size > 200) {   // держим компактно — 200 самых свежих по ts
    const sorted = [...runStatus.entries()].sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0));
    runStatus.clear(); for (const [k, v] of sorted.slice(0, 200)) runStatus.set(k, v);
  }
  saveRuns();
}
export function getRunStatus(key) { return key ? (runStatus.get(key) || null) : null; }
// Старт сервера: ход, оставшийся running (процесс упал/перезапустился, не дописав терминал), → orphaned (видимый маркер).
export function initRuns() {
  let persisted = {};
  try { persisted = JSON.parse(readFileSync(runsFile(), 'utf8')) || {}; } catch { persisted = {}; }
  for (const [k, v] of Object.entries(persisted)) {
    if (!v || typeof v !== 'object') continue;
    if (v.state === 'running') { v.state = 'orphaned'; v.reason = v.reason || 'Ход прерван перезапуском Deck'; }
    runStatus.set(k, v);
  }
  saveRuns();
}

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
// TECH-4: fetch с ретраями/экспоненциальным бэкоффом на ТРАНЗИЕНТНЫХ сбоях. Транзиентное — сеть/timeout/abort
// либо 429/5xx (перегруз/временный сбой сервиса): повтор имеет шанс. 4xx (кроме 429) повтор не чинит — отдаём как есть.
// Именно транзиентный 503 Jira обнулял колонку «Заблокировано» — ретрай гасит такие блипы в корне.
const _delay = (ms) => new Promise((r) => setTimeout(r, ms));
export function isTransientStatus(s) { return s === 429 || (s >= 500 && s <= 599); }
export async function fetchRetry(url, opts = {}, { retries = 2, baseDelay = 400, timeout = 15000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeout) });
      if (r.ok || !isTransientStatus(r.status) || attempt >= retries) return r;   // успех / «плохой запрос» / попытки исчерпаны — отдаём ответ, вызывающий решит по r.ok
    } catch (e) {
      if (attempt >= retries) throw e;      // сеть/timeout/abort — тоже транзиентно, но попытки исчерпаны
    }
    await _delay(baseDelay * 2 ** attempt);   // экспоненциальный бэкофф: 400мс, 800мс
  }
}
// Перенос пути; renameSync не умеет через диски (projects на C:, deck-trash на D: → EXDEV) — фолбэк copy+remove.
export function movePath(src, dest) {
  try { renameSync(src, dest); }
  catch (e) { if (e && e.code === 'EXDEV') { cpSync(src, dest, { recursive: true }); rmSync(src, { recursive: true, force: true }); } else throw e; }
}
export const oneLine = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
export const cap = (s) => (s.length > MSG_CAP ? s.slice(0, MSG_CAP) + '\n…' : s);
