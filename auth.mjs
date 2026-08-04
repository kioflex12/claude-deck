// Deck — настройки (конфиг Deck GET/POST, автоимпорт токенов из секретов Claude Code) и авторизация в Claude
// из приложения через CLI `claude auth` (логин по OAuth-URL/коду, детект успеха, выход).

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import {
  HERE, CLAUDE_BIN, sendJSON, readJsonBody,
  loadConfig, saveConfig, configFile, loadProjects, tokenFile, writeTokenSecure, applyConfig, getElectron, parseEnvFile,
  WO_STATES_DIR, PROJECTS_DIR, JIRA_HOST, JIRA_EMAIL, JIRA_TOKEN, JIRA_ENABLED, TC_HOST, TC_TOKEN, GL_HOST, GL_TOKEN,
} from './core.mjs';
import { _summaryCache } from './sessions.mjs';
import { _jiraCache, _tcCache, _buildActiveCache, _mrCache } from './services.mjs';
import { uniqueSessionCwds } from './skills-mcp.mjs';

// -------- TECH-6: конфиг Deck (GET текущие значения / POST сохранить). Токен наружу НЕ отдаём, только флаг. --------
function configView() {
  const { projects, activeId } = loadProjects();
  return {
    projects, activeProjectId: activeId,   // открытые папки-проекты + активная (для переключателя в топбаре)
    woStatesDir: WO_STATES_DIR,
    claudeProjectsDir: PROJECTS_DIR,
    jira: { host: JIRA_HOST, email: JIRA_EMAIL, tokenSet: !!JIRA_TOKEN, enabled: JIRA_ENABLED },
    teamcity: { host: TC_HOST, tokenSet: !!TC_TOKEN },
    gitlab: { host: GL_HOST, tokenSet: !!GL_TOKEN },
    unity: (() => { const c = loadConfig(); return { clientUnityParent: c.clientUnityParent || '', editorsDir: c.unityEditorsDir || '', hubPath: c.unityHubPath || '' }; })(),
    secretsEnvPath: loadConfig().secretsEnvPath || '',   // явный .env для «Подтянуть токены» (нужно установленному app — HERE в asar)
    envHosts: loadConfig().envHosts || '',   // Фаза-4: URL health-проверок окружений для ленты «Требует внимания»
    electron: !!getElectron(),   // можно ли безопасно сохранить токен (safeStorage) или только через .env
    defaults: { claudeProjectsDir: path.join(os.homedir(), '.claude', 'projects'), teamcityHost: 'https://teamcity.example.com', gitlabHost: 'https://gitlab.example.com' },
  };
}
export async function apiConfig(req, res) {
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
export async function apiImportTokens(req, res) {
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
export async function apiAuth(res) {
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
export function apiAuthLogin(res) {
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
export async function apiAuthCode(req, res) {
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
export function apiAuthCancel(req, res, u) {
  const id = u.searchParams.get('id') || '';
  const rec = logins.get(id);
  if (rec) { if (rec.watcher) { clearInterval(rec.watcher); rec.watcher = null; } try { rec.child.kill(); } catch {} logins.delete(id); }
  clearActiveLogin(id);
  sendJSON(res, { ok: true });
}
export function apiAuthLogout(res) {
  execFile(CLAUDE_BIN, ['auth', 'logout'], { timeout: 12000, windowsHide: true, shell: process.platform === 'win32' }, () => {
    _authCache = { ts: 0, data: null };
    sendJSON(res, { ok: true });
  });
}
