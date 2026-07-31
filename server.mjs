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
import { HERE, PROJECTS_DIR, WO_STATES_DIR, sendJSON } from './core.mjs';
import { apiSessions, apiSession, apiSessionTail, sessionArtifacts, apiAgents, apiTags, apiSessionName, apiProjects, apiFile, apiDeleteSession } from './sessions.mjs';
import { collectSkills, collectAllSkills, apiMcp, apiMcpStatus, apiMcpLogin, apiMcpRemove } from './skills-mcp.mjs';
import { apiUnityInstances } from './unity.mjs';
import { apiUsage, apiModels } from './sdk.mjs';
import { apiChatPrepare, apiChat, apiApprove, apiAnswer, apiPendingQuestions, apiStop } from './chat.mjs';
import { apiBuild, apiMrs, apiJira } from './services.mjs';
import { apiConfig, apiImportTokens, apiAuth, apiAuthLogin, apiAuthCode, apiAuthCancel, apiAuthLogout } from './auth.mjs';

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
  if (u.pathname === '/api/session-artifacts') { sendJSON(res, sessionArtifacts(u.searchParams.get('file') || '')); return; }
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
  if (u.pathname === '/api/approve') { apiApprove(res, u); return; }
  if (u.pathname === '/api/answer') { apiAnswer(req, res, u).catch((e) => sendJSON(res, { ok: false, error: String(e && e.message || e) }, 500)); return; }
  if (u.pathname === '/api/pending-questions') { apiPendingQuestions(res, u); return; }
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
  server.requestTimeout = 0;      // не убивать долгий SSE-ход дефолтным 5-мин лимитом запроса (иначе closed=true → авто-реджект инструментов)
  server.keepAliveTimeout = 0;    // не закрывать keep-alive соединение по простою
  server.headersTimeout = 0;
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
export { isBaseBranch, pickWorkingBranch, pickBaseBranch, classifyUserBlock, buildSessionBlocks, briefArg, woOf, columnByAge } from './text.mjs';
export { wfInfo, scopeInfo } from './sessions.mjs';
export { isReadOnlyTool } from './chat.mjs';
export { pendingQuestions, pendingQuestionsByKey } from './core.mjs';   // для тестов /api/answer и /api/pending-questions
