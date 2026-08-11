// Deck — локальная веб-доска сессий Claude Code.
// Zero-dep Node-сервер: сканирует папку ~/.claude/projects, отдаёт список
// сессий (/api/sessions) и полный транскрипт одной сессии блоками
// (/api/session), плюс страницу index.html. index.html перечитывается на
// каждый запрос (правь и жми F5); server.mjs требует рестарта node.
//
// Папка сессий:   env CLAUDE_PROJECTS_DIR -> дефолт ~/.claude/projects.
// Папка состояний dev-workflow (для вкладки «Статусы»):
//                 env WO_STATES_DIR -> дефолт ниже.
//
// Тонкий роутер: импорты обработчиков из доменных модулей (core/text/sessions/skills-mcp/unity/sdk/chat/services/auth)
// + HTTP-диспетчер + startServer. core.mjs на импорте подхватывает .env и вызывает applyConfig() до первого запроса.

import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HERE, PROJECTS_DIR, WO_STATES_DIR, sendJSON, initRuns, SESSION_TOKEN } from './core.mjs';
import { apiSessions, apiSession, apiSessionTail, sessionArtifacts, apiAgents, apiTags, apiSessionName, apiProjects, apiFile, apiDeleteSession, apiGitDirty } from './sessions.mjs';
import { collectSkills, collectAllSkills, apiMcp, apiMcpStatus, apiMcpLogin, apiMcpRemove } from './skills-mcp.mjs';
import { apiUnityInstances } from './unity.mjs';
import { apiUsage, apiModels } from './sdk.mjs';
import { apiChatPrepare, apiChat, apiChatInput, apiApprove, apiAnswer, apiPendingQuestions, apiPendingApprovals, apiStop } from './chat.mjs';
import { apiBuild, apiMrs, apiJira, apiHealth, apiConfigTest, apiJiraComment, apiCreateMr, apiTriggerBuild, apiEnvStatus, apiSessionDeploys } from './services.mjs';
import { apiConfig, apiImportTokens, apiConfigExport, apiConfigImport, apiAuth, apiAuthLogin, apiAuthCode, apiAuthCancel, apiAuthLogout, autoImportOnFirstRun } from './auth.mjs';

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

// S1: Deck слушает только loopback (см. startServer). Дополнительно гейтим по Host/Origin — защита от DNS-rebinding
// (Host не loopback) и кросс-ориджин браузерной вкладки (Origin не наш). Мутирующее/спавнящее /api/ дополнительно
// требует токен процесса (no-Origin CSRF вроде <img src=/api/chat?...> закрыт только им — Host там наш, Origin нет).
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);
function hostnameOf(hostHeader) {
  let h = String(hostHeader || '').trim().toLowerCase();
  if (h.startsWith('[')) { const i = h.indexOf(']'); return i >= 0 ? h.slice(1, i) : h; }   // [::1]:port
  const c = h.indexOf(':'); return c >= 0 ? h.slice(0, c) : h;                                // host:port (у IPv4/hostname двоеточий нет, кроме порта)
}
function requestIsLocal(req) {
  if (!LOCAL_HOSTS.has(hostnameOf(req.headers.host))) return false;   // Host не loopback → DNS-rebinding
  const origin = req.headers.origin;
  if (origin) { try { if (!LOCAL_HOSTS.has(new URL(origin).hostname.toLowerCase())) return false; } catch { return false; } }   // кросс-ориджин вкладка
  return true;
}
function tokenOk(req, u) { return (u.searchParams.get('tk') || req.headers['x-deck-token'] || '') === SESSION_TOKEN; }

const server = http.createServer((req, res) => {
  const u = new URL(req.url || '/', 'http://localhost');
  if (!requestIsLocal(req)) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('forbidden'); return; }
  if (u.pathname.startsWith('/api/') && !tokenOk(req, u)) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('forbidden: token'); return; }
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
  if (u.pathname === '/api/session-artifacts') { sendJSON(res, sessionArtifacts(u.searchParams.get('file') || '')); return; }
  if (u.pathname === '/api/git-dirty') { apiGitDirty().then((d) => sendJSON(res, d)).catch((e) => sendJSON(res, { repos: [], error: String(e && e.message || e) }, 500)); return; }
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
  if (u.pathname === '/api/projects') { apiProjects(req, res); return; }
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
  if (u.pathname === '/api/chat-input') { apiChatInput(req, res, u).catch((e) => sendJSON(res, { ok: false, error: String(e && e.message || e) }, 500)); return; }
  if (u.pathname === '/api/approve') { apiApprove(res, u); return; }
  if (u.pathname === '/api/answer') { apiAnswer(req, res, u).catch((e) => sendJSON(res, { ok: false, error: String(e && e.message || e) }, 500)); return; }
  if (u.pathname === '/api/pending-questions') { apiPendingQuestions(res, u); return; }
  if (u.pathname === '/api/pending-approvals') { apiPendingApprovals(res, u); return; }
  if (u.pathname === '/api/stop') { apiStop(res, u); return; }
  if (u.pathname === '/api/build') { apiBuild(res, u); return; }
  if (u.pathname === '/api/session-deploys') { apiSessionDeploys(res, u).catch((e) => sendJSON(res, { available: false, reason: String(e && e.message || e) }, 500)); return; }
  if (u.pathname === '/api/mrs') { apiMrs(res, u); return; }
  if (u.pathname === '/api/jira') { apiJira(res, u); return; }
  if (u.pathname === '/api/jira-comment') { apiJiraComment(req, res).catch((e) => sendJSON(res, { ok: false, error: String(e && e.message || e) }, 500)); return; }
  if (u.pathname === '/api/create-mr') { apiCreateMr(req, res).catch((e) => sendJSON(res, { ok: false, error: String(e && e.message || e) }, 500)); return; }
  if (u.pathname === '/api/trigger-build') { apiTriggerBuild(req, res).catch((e) => sendJSON(res, { ok: false, error: String(e && e.message || e) }, 500)); return; }
  if (u.pathname === '/api/health') { apiHealth(res); return; }
  if (u.pathname === '/api/env-status') { apiEnvStatus(res).catch((e) => sendJSON(res, { configured: false, envs: [], error: String(e && e.message || e) }, 500)); return; }
  if (u.pathname === '/api/config/test') { apiConfigTest(req, res).catch((e) => sendJSON(res, { ok: false, message: String(e && e.message || e) }, 500)); return; }
  if (u.pathname === '/api/config/export') { apiConfigExport(req, res).catch((e) => sendJSON(res, { error: String(e && e.message || e) }, 500)); return; }
  if (u.pathname === '/api/config/import') { apiConfigImport(req, res).catch((e) => sendJSON(res, { ok: false, error: String(e && e.message || e) }, 500)); return; }
  if (u.pathname === '/api/config/import-tokens') { apiImportTokens(req, res).catch((e) => sendJSON(res, { ok: false, error: String(e && e.message || e) }, 500)); return; }
  if (u.pathname === '/api/config') { apiConfig(req, res); return; }
  if (u.pathname === '/api/auth') { apiAuth(res); return; }
  if (u.pathname === '/api/auth/login') { apiAuthLogin(res); return; }
  if (u.pathname === '/api/auth/code') { apiAuthCode(req, res); return; }
  if (u.pathname === '/api/auth/cancel') { apiAuthCancel(req, res, u); return; }
  if (u.pathname === '/api/auth/logout') { apiAuthLogout(res); return; }
  if (u.pathname.startsWith('/js/') || u.pathname.startsWith('/css/')) { serveWeb(u.pathname, res); return; }
  try {
    // S1: инжектим токен процесса в <meta> — читаема только нашей (same-origin) страницей, кросс-ориджин прочитать HTML не может.
    const html = '<meta name="deck-token" content="' + SESSION_TOKEN + '">\n' + readFileSync(path.join(HERE, 'index.html'), 'utf8');
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
  initRuns();   // R2: ход, оставшийся running с прошлого запуска (Deck упал/перезапустился), → orphaned — видимый маркер при перезаходе, а не «просто остановилось»
  autoImportOnFirstRun();   // онбординг: на пустом конфиге тихо подтянуть хосты/токены из системных переменных + пути из папок сессий (без ручного ввода)
  const listenPort = preferredPort != null ? preferredPort : (Number(process.env.PORT) || 0);
  server.requestTimeout = 0;      // не убивать долгий SSE-ход дефолтным 5-мин лимитом запроса (иначе closed=true → авто-реджект инструментов)
  server.keepAliveTimeout = 0;    // не закрывать keep-alive соединение по простою
  server.headersTimeout = 0;
  return new Promise((resolve) => {
    const done = () => {
      const port = server.address().port;
      const url = 'http://localhost:' + port;
      console.log('');
      console.log('  Deck — доска сессий Claude Code');
      console.log('  папка сессий:   ' + PROJECTS_DIR);
      console.log('  папка статусов: ' + (WO_STATES_DIR || '(не задана — задайте в Настройках/WO_STATES_DIR)'));
      console.log('  адрес:          ' + url);
      console.log('');
      resolve({ port, url, close: () => new Promise((r) => server.close(() => r())) });
    };
    // S1: слушаем ТОЛЬКО loopback (127.0.0.1) — не 0.0.0.0/::. Машина из LAN до Deck не достучится (RCE-поверхность закрыта).
    // URL остаётся http://localhost:port (Chromium резолвит localhost в loopback) — origin не меняется, localStorage жив.
    server.once('error', (e) => {
      if (e && e.code === 'EADDRINUSE' && listenPort !== 0) server.listen(0, '127.0.0.1', done);
      else console.error('Deck server listen error:', (e && e.message) || e);
    });
    server.listen(listenPort, '127.0.0.1', done);
  });
}

// Прямой запуск (`node server.mjs`, лаунчеры start-deck.*) — авто-старт на 4317 (или env PORT). При импорте (Electron) — нет.
const _isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (_isMain) startServer(Number(process.env.PORT) || 4317);

// Named-экспорты чистых хелперов для тестов (D4b). Аддитивно — поведение не меняем. startServer уже экспортирован.
export { isBaseBranch, pickWorkingBranch, pickBaseBranch, classifyUserBlock, buildSessionBlocks, briefArg, woOf, columnByAge } from './text.mjs';
export { wfInfo, scopeInfo } from './sessions.mjs';
export { isReadOnlyTool, buildUserMessage, makeInputChannel } from './chat.mjs';
export { pendingQuestions, pendingQuestionsByKey, pendingApprovals, pendingApprovalsByKey, activeStreams, markPid, hasPid, deliveredPids, SESSION_TOKEN } from './core.mjs';   // для тестов /api/answer, /api/pending-questions, /api/pending-approvals, /api/stop, токен-гейта
