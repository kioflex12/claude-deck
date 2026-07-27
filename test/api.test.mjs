// Интеграционные тесты HTTP-эндпоинтов: поднимаем startServer() на эфемерном порту с временной
// папкой проектов (фикстур-сессии). Проверяем ФОРМУ ответов и мягкую деградацию — без реального Jira/TC/claude.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

// --- временная папка проектов с фикстурами. ВАЖНО: env выставляем ДО import server.mjs (applyConfig читает его). ---
const tmp = mkdtempSync(path.join(os.tmpdir(), 'deck-apitest-'));
const projectsDir = path.join(tmp, 'projects');
const projSub = path.join(projectsDir, 'test-project');
mkdirSync(projSub, { recursive: true });
const mkFixture = (title, branch, prompt) => [
  { type: 'user', cwd: '/home/x/client-unity-1/proj', gitBranch: branch, message: { role: 'user', content: prompt } },
  { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'ок' }], usage: { input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 10 } }, aiTitle: title, lastPrompt: prompt },
].map((l) => JSON.stringify(l)).join('\n');
writeFileSync(path.join(projSub, 'sess-aaa.jsonl'), mkFixture('Первая сессия', 'WO-777-test', 'Почини баг'));
writeFileSync(path.join(projSub, 'sess-bbb.jsonl'), mkFixture('Вторая сессия', 'preprod', 'Второй промпт'));

process.env.CLAUDE_PROJECTS_DIR = projectsDir;
process.env.PORT = '0';
delete process.env.WO_STATES_DIR;   // детерминизм: без dev-workflow-состояний

let srv, base;
before(async () => {
  const mod = await import(pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs')).href);
  srv = await mod.startServer();
  base = srv.url;
});
after(async () => { if (srv) await srv.close(); try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

const getJson = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };

test('/api/sessions → 200, массив с ожидаемыми полями', async () => {
  const { status, body } = await getJson('/api/sessions');
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.sessions), 'sessions — массив');
  assert.equal(body.dir, projectsDir, 'dir = наша временная папка (config/env резолв сработал)');
  assert.ok(body.sessions.length >= 2, 'обе фикстур-сессии найдены');
  const s = body.sessions.find((x) => x.title === 'Первая сессия');
  assert.ok(s, 'фикстура по aiTitle');
  for (const k of ['id', 'file', 'title', 'wfColumn', 'mtime', 'wo', 'gitBranch']) assert.ok(k in s, 'поле ' + k);
  assert.equal(s.wo, 'WO-777', 'WO из рабочей ветки');
  assert.equal(s.gitBranch, 'WO-777-test');
});

test('/api/session?file=<fixture> → 200 blocks; traversal и не-.jsonl → 400', async () => {
  const { body: list } = await getJson('/api/sessions');
  const file = list.sessions[0].file;
  const ok = await getJson('/api/session?file=' + encodeURIComponent(file));
  assert.equal(ok.status, 200);
  assert.ok(Array.isArray(ok.body.blocks), 'blocks — массив');
  assert.ok('title' in ok.body && 'id' in ok.body);

  const trav = await getJson('/api/session?file=' + encodeURIComponent('../../etc/passwd'));
  assert.equal(trav.status, 400, 'path traversal отбит');

  const notJsonl = await getJson('/api/session?file=' + encodeURIComponent('test-project/note.txt'));
  assert.equal(notJsonl.status, 400, 'не-.jsonl отбит');
});

test('/api/skills (агрегат) → 200, skills — массив (пусто на CI ок)', async () => {
  const { status, body } = await getJson('/api/skills');
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.skills));
  assert.equal(typeof body.count, 'number');
});

test('/api/mcp → 200, объект (без падения даже если пусто)', async () => {
  const { status, body } = await getJson('/api/mcp');
  assert.equal(status, 200);
  assert.equal(typeof body, 'object');
  assert.ok(body !== null);
});

test('/api/config → 200, значения + jira.tokenSet, сам токен НЕ отдаётся', async () => {
  const { status, body } = await getJson('/api/config');
  assert.equal(status, 200);
  assert.equal(body.claudeProjectsDir, projectsDir);
  assert.ok(body.jira && typeof body.jira.tokenSet === 'boolean', 'есть флаг tokenSet');
  assert.equal(body.jira.token, undefined, 'сырой токен наружу не отдаётся');
  assert.equal(typeof body.electron, 'boolean');
});

test('/api/auth → 200, деградирует без падения (без claude CLI → loggedIn:false)', async () => {
  const { status, body } = await getJson('/api/auth');
  assert.equal(status, 200);
  assert.equal(typeof body.loggedIn, 'boolean');
});

test('/api/build?branch=preprod (без wo) → мягко: base-branch builds:[] или available:false', async () => {
  const { status, body } = await getJson('/api/build?branch=preprod');
  assert.equal(status, 200);
  const ok = body.available === false || (Array.isArray(body.builds) && body.builds.length === 0);
  assert.ok(ok, 'без TC-токена available:false, либо base-branch пустой список сборок');
});
