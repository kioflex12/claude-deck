// mcp.js вынесен из app.js. Boot-smoke не заходит на вкладку MCP, поэтому забытый импорт внутри
// renderMcp/renderMcpDetail (launchUnity/esc/toast/openExternal) там не стрельнул бы. Этот тест грузит
// каталог и рисует и список, и детальный вид в null-DOM — ловит такую «сломанную ссылку».

import './dom-stub.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setFetch, watchBrokenRefs } from './dom-stub.mjs';
import { S } from '../web/js/store.js';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

test('mcp.js: загрузка каталога + рендер списка/детали в null-DOM', async () => {
  setFetch(async () => ({ ok:true, status:200,
    json: async () => ({ available:true, live:true, servers:[
      { name:'srv-a', scope:'user', status:'connected', transport:'stdio', command:'x', tools:['t1'] },
      { name:'srv-b', scope:'claudeai', status:'needs-auth', transport:'http' },
    ] }), text: async () => '', headers:{ get(){ return null; } } }));
  const w = watchBrokenRefs();
  const url = pathToFileURL(path.resolve(import.meta.dirname, '../web/js/mcp.js')).href;
  let mcp;
  try { mcp = await import(url); }
  catch (e){ w.stop(); assert.fail('import mcp.js упал: ' + (e && e.stack || e)); }

  S.activeView = 'mcp'; S.mcpDetail = null;
  await mcp.loadMcpCatalog(true);                                     // fetch → S.MCP_SERVERS + renderMcp
  assert.equal(S.MCP_SERVERS.length, 2, 'серверы загрузились');
  assert.doesNotThrow(() => mcp.renderMcp(), 'renderMcp — список');
  S.mcpDetail = 'srv-b';
  assert.doesNotThrow(() => mcp.renderMcp(), 'renderMcp — детальный вид (needs-auth)');

  await new Promise((r) => setTimeout(r, 40));
  w.stop();
  assert.deepEqual(w.errors, [], 'сломанная ссылка в mcp.js: ' + w.errors.join(' | '));
});
