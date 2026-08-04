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

// фикстура для /api/session-artifacts: сессия правит .md-файл в своей cwd (touched)
const artCwd = path.join(tmp, 'art-cwd');
mkdirSync(artCwd, { recursive: true });
const artDoc = path.join(artCwd, 'notes.md');
writeFileSync(artDoc, '# заметки\n');
const artSession = [
  { type: 'user', cwd: artCwd, gitBranch: 'WO-555-art', message: { role: 'user', content: 'сделай' } },
  { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'tool_use', name: 'Edit', id: 'e1', input: { file_path: artDoc, old_string: 'x', new_string: 'y' } }] } },
].map((l) => JSON.stringify(l)).join('\n');
writeFileSync(path.join(projSub, 'sess-art.jsonl'), artSession);

process.env.CLAUDE_PROJECTS_DIR = projectsDir;
process.env.PORT = '0';
delete process.env.WO_STATES_DIR;   // детерминизм: без dev-workflow-состояний
// Херметичность: гасим креды интеграций (пустая строка «занимает» ключ → loadDotEnv из репо-.env не перебьёт).
// Иначе на машине разработчика с реальным .env тест /api/config/test дёрнул бы живую сеть.
for (const k of ['JIRA_HOST', 'JIRA_EMAIL', 'JIRA_TOKEN', 'TEAMCITY_HOST', 'TEAMCITY_TOKEN', 'GITLAB_HOST', 'GITLAB_TOKEN']) process.env[k] = '';

let srv, base, mod;
before(async () => {
  mod = await import(pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs')).href);
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

test('/api/session-artifacts → находит .md, изменённый в сессии (touched:true)', async () => {
  const { status, body } = await getJson('/api/session-artifacts?file=' + encodeURIComponent('test-project/sess-art.jsonl'));
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.artifacts), 'artifacts — массив');
  const a = body.artifacts.find((x) => x.name === 'notes.md');
  assert.ok(a, 'notes.md найден среди артефактов');
  assert.equal(a.touched, true, 'файл помечен как изменённый в сессии');
  assert.equal(a.rel, 'notes.md', 'rel относительно cwd сессии');
});

test('/api/build?branch=preprod (без wo) → мягко: base-branch builds:[] или available:false', async () => {
  const { status, body } = await getJson('/api/build?branch=preprod');
  assert.equal(status, 200);
  const ok = body.available === false || (Array.isArray(body.builds) && body.builds.length === 0);
  assert.ok(ok, 'без TC-токена available:false, либо base-branch пустой список сборок');
});

test('/api/health → 200, сводка трёх интеграций правильной формы (configured/ok — булевы)', async () => {
  const { status, body } = await getJson('/api/health');
  assert.equal(status, 200);
  assert.ok(body.services && typeof body.services === 'object', 'есть объект services');
  for (const k of ['teamcity', 'gitlab', 'jira']) {
    assert.ok(body.services[k], 'сервис ' + k + ' присутствует');
    assert.equal(typeof body.services[k].configured, 'boolean', k + '.configured — булев');
    assert.equal(typeof body.services[k].ok, 'boolean', k + '.ok — булев');
    // На старте (до первого запроса к интеграции) ничто не помечено упавшим: свежий сервис ok:true.
    if (!body.services[k].configured) assert.equal(body.services[k].ok, true, k + ' не настроен → не «упал»');
  }
});

test('/api/git-dirty → 200, {repos:[]} (фикстур-cwd не git-репо → пусто, без падения)', async () => {
  const { status, body } = await getJson('/api/git-dirty');
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.repos), 'repos — массив');
  // Фикстур-cwd — несуществующий путь либо не-git временный каталог: git тихо отсеивается → пустой список.
  assert.equal(body.repos.length, 0, 'нет git-репо среди фикстур → ничего не требует внимания');
});

test('/api/config/test → 200, {ok, message}; неизвестный svc → ok:false', async () => {
  const r = await fetch(base + '/api/config/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ svc: 'jira', host: '', email: '', token: '' }) });
  const body = await r.json();
  assert.equal(r.status, 200);
  assert.equal(typeof body.ok, 'boolean');
  assert.equal(typeof body.message, 'string');
  assert.equal(body.ok, false, 'без host/email/token — не ок');

  const bad = await fetch(base + '/api/config/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ svc: 'nope' }) });
  const badBody = await bad.json();
  assert.equal(badBody.ok, false, 'неизвестный сервис → ok:false');
});

test('/api/answer резолвит зарегистрированный pendingQuestions-id ответом пользователя', async () => {
  let got = null;
  const id = 'aq_test1';
  mod.pendingQuestions.set(id, { questions: [{ question: 'Q?', options: [{ label: 'A' }], multiSelect: false }], sessionKey: 'sess-aaa', resolve: (answers) => { got = answers; mod.pendingQuestions.delete(id); } });
  const r = await fetch(base + '/api/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, answers: { 'Q?': 'A' } }) });
  const body = await r.json();
  assert.equal(r.status, 200);
  assert.equal(body.ok, true, 'известный id → ok:true');
  assert.deepEqual(got, { 'Q?': 'A' }, 'resolve вызван с ответом пользователя');
  assert.equal(mod.pendingQuestions.has(id), false, 'id снят после ответа');

  const bad = await fetch(base + '/api/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'aq_unknown', answers: {} }) });
  const badBody = await bad.json();
  assert.equal(badBody.ok, false, 'неизвестный id → ok:false');
});

test('/api/pending-questions возвращает висящие вопросы по sessionKey файла', async () => {
  const id = 'aq_test2';
  mod.pendingQuestions.set(id, { questions: [{ question: 'Продолжить?', options: [{ label: 'Да' }], multiSelect: false }], sessionKey: 'sess-pending', resolve: () => {} });
  let set = mod.pendingQuestionsByKey.get('sess-pending'); if (!set) { set = new Set(); mod.pendingQuestionsByKey.set('sess-pending', set); } set.add(id);
  const { status, body } = await getJson('/api/pending-questions?file=' + encodeURIComponent('test-project/sess-pending.jsonl'));
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.questions), 'questions — массив');
  const q = body.questions.find((x) => x.id === id);
  assert.ok(q, 'висящий вопрос найден по sessionKey');
  assert.equal(q.questions[0].question, 'Продолжить?');
  mod.pendingQuestions.delete(id); set.delete(id);
});

test('/api/pending-approvals возвращает висящие аппрувы по sessionKey файла', async () => {
  const id = 'ap_test2';
  mod.pendingApprovals.set(id, { decide: () => {}, tool: 'Bash', input: { command: 'ls' }, sessionKey: 'sess-appr' });
  let set = mod.pendingApprovalsByKey.get('sess-appr'); if (!set) { set = new Set(); mod.pendingApprovalsByKey.set('sess-appr', set); } set.add(id);
  const { status, body } = await getJson('/api/pending-approvals?file=' + encodeURIComponent('test-project/sess-appr.jsonl'));
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.approvals), 'approvals — массив');
  const a = body.approvals.find((x) => x.id === id);
  assert.ok(a, 'висящий аппрув найден по sessionKey');
  assert.equal(a.tool, 'Bash');
  assert.equal(a.input.command, 'ls');
  mod.pendingApprovals.delete(id); set.delete(id);
});

test('/api/chat-input докидывает промт в живой ход по ключу сессии; нет живого → ok:false', async () => {
  let got = null;
  mod.activeStreams.set('sx_steer', { ac: { abort() {} }, key: 'sess-steer', push: (m) => { got = m; return true; } });
  const r = await fetch(base + '/api/chat-input', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: 'proj/sess-steer.jsonl', prompt: 'дальше' }) });
  const b = await r.json();
  assert.equal(r.status, 200);
  assert.equal(b.ok, true, 'нашёл живой ход по ключу → запушено');
  assert.ok(got && got.message && Array.isArray(got.message.content), 'push получил SDKUserMessage');
  mod.activeStreams.delete('sx_steer');

  const r2 = await fetch(base + '/api/chat-input', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: 'proj/no-such.jsonl', prompt: 'x' }) });
  const b2 = await r2.json();
  assert.equal(b2.ok, false, 'нет живого хода → ok:false (клиент фолбэкнется на новый ход)');
});

test('/api/stop?file=... рвёт активный ход по ключу сессии (после перезахода streamId потерян)', async () => {
  let aborted = false;
  mod.activeStreams.set('sx_stoptest', { ac: { abort: () => { aborted = true; } }, key: 'sess-stopf' });
  const { status, body } = await getJson('/api/stop?file=' + encodeURIComponent('proj/sess-stopf.jsonl'));
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(aborted, true, 'AbortController найден по ключу сессии и прерван');
  assert.equal(mod.activeStreams.has('sx_stoptest'), false, 'запись активного хода снята');
});
