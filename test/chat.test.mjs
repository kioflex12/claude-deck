// Поведенческий тест apiChat: прогоняем ВЕСЬ SSE-event-цикл и canUseTool-гейтинг через впрыснутую фейк-функцию SDK
// query (setSdkQueryForTests) — без спавна реального claude. Это самый рисковый код (T1): раньше он был без теста.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'deck-chattest-'));
const projectsDir = path.join(tmp, 'projects');
const projSub = path.join(projectsDir, 'test-project');
mkdirSync(projSub, { recursive: true });
const cwd = path.join(tmp, 'work'); mkdirSync(cwd, { recursive: true });
const fixture = [{ type: 'user', cwd, gitBranch: 'WO-1-x', message: { role: 'user', content: 'привет' } }].map((l) => JSON.stringify(l)).join('\n');
const sessBase = 'sess-chat.jsonl';
writeFileSync(path.join(projSub, sessBase), fixture);
const fileRel = 'test-project/' + sessBase;
const sessionId = sessBase.replace(/\.jsonl$/, '');

process.env.CLAUDE_PROJECTS_DIR = projectsDir;
process.env.PORT = '0';
delete process.env.WO_STATES_DIR;
for (const k of ['JIRA_HOST', 'JIRA_EMAIL', 'JIRA_TOKEN', 'TEAMCITY_HOST', 'TEAMCITY_TOKEN', 'GITLAB_HOST', 'GITLAB_TOKEN']) process.env[k] = '';

let srv, base, mod, core, sdk;
before(async () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  mod = await import(pathToFileURL(path.join(dir, '..', 'server.mjs')).href);
  core = await import(pathToFileURL(path.join(dir, '..', 'core.mjs')).href);
  sdk = await import(pathToFileURL(path.join(dir, '..', 'sdk.mjs')).href);
  srv = await mod.startServer();
  base = srv.url;
});
after(async () => { if (srv) await srv.close(); try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

const addTk = (p) => p + (p.includes('?') ? '&' : '?') + 'tk=' + encodeURIComponent(core.SESSION_TOKEN || '');

// Читаем SSE-поток /api/chat, собираем события; на 'approval' зовём onApproval; выходим на 'done'.
async function runChat(fileRelArg, onApproval) {
  const url = base + addTk('/api/chat?file=' + encodeURIComponent(fileRelArg) + '&prompt=hi&mode=default');
  const res = await fetch(url);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const events = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
      for (const line of chunk.split('\n')) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;   // ': hb' keepalive пропускаем
        let d; try { d = JSON.parse(s.slice(5).trim()); } catch { continue; }
        events.push(d);
        if (d.type === 'approval' && onApproval) await onApproval(d);
        if (d.type === 'done') { try { await reader.cancel(); } catch {} return events; }
      }
    }
  }
  return events;
}

test('apiChat: SSE-цикл + canUseTool (read-only авто-allow, мутирующее → approval → /api/approve) + терминал в run-store', async () => {
  // Фейк SDK query: init → гейт Read (должен пройти без approval) → гейт Write (должен поднять approval) → result.
  sdk.setSdkQueryForTests((args) => {
    const opts = (args && args.options) || {};
    return (async function* () {
      yield { type: 'system', subtype: 'init', model: 'claude-test' };
      const rd = await opts.canUseTool('Read', { file_path: '/x' }, {});
      yield { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name: rd.behavior === 'allow' ? 'Read' : 'ReadDenied' } } };
      const wr = await opts.canUseTool('Write', { file_path: '/y', content: 'z' }, {});
      yield { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name: wr.behavior === 'allow' ? 'Write' : 'WriteDenied' } } };
      yield { type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 7 } };
    })();
  });

  const events = await runChat(fileRel, async (d) => {
    assert.equal(d.tool, 'Write', 'approval поднят именно для мутирующего Write');
    await fetch(base + addTk('/api/approve?id=' + encodeURIComponent(d.id) + '&decision=allow'));
  });

  const types = events.map((e) => e.type);
  assert.ok(types.includes('start'), 'есть start');
  assert.ok(types.includes('system'), 'есть system (init)');
  const tools = events.filter((e) => e.type === 'tool').map((e) => e.name);
  assert.deepEqual(tools, ['Read', 'Write'], 'Read авто-allow (без approval), Write — после разрешения');
  const approvals = events.filter((e) => e.type === 'approval');
  assert.equal(approvals.length, 1, 'ровно один approval — только для Write (Read read-only, не гейтится)');
  const doneEv = events.find((e) => e.type === 'done');
  assert.ok(doneEv && !doneEv.isError, 'done без ошибки');

  // R1: терминал зафиксирован в run-store как успешный (done, не сюрфейсится нотой).
  const run = core.getRunStatus(sessionId);
  assert.ok(run && run.state === 'done', 'run-store: ход помечен done');
});

test('apiChat: пустой промт → error+done (ранний fail, heartbeat погашен — R6)', async () => {
  const res = await fetch(base + addTk('/api/chat?file=' + encodeURIComponent(fileRel) + '&prompt=&mode=default'));
  const txt = await res.text();
  assert.match(txt, /"type":"error"/, 'ранний отказ шлёт error');
  assert.match(txt, /"type":"done"/, 'и done — стрим закрыт корректно');
});
