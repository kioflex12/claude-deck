// Deck — вид MCP (расширения Claude Code): список серверов по scope + детальный вид с действиями,
// плюс авто-обнаруженные Unity-инстансы секцией сверху. Вынесено из app.js; состояние — в store (S).
// launchUnity живёт в unity.js (Unity-кластер) — импортируем; цикл mcp↔unity безопасен (вызовы в рантайме).
import { S } from './store.js';
import { esc } from './util.js';
import { toast, openExternal } from './ui.js';
import { launchUnity } from './unity.js';

export async function loadMcpCatalog(refresh){
  // Живой статус через SDK-пробу (mcpServerStatus); refresh=1 = «реконнект» (свежая проба).
  S.mcpLoading = true; if (S.activeView === 'mcp') renderMcp();
  try { const r = await fetch('/api/mcp/status' + (refresh ? '?refresh=1' : ''), { cache:'no-store' }); const d = await r.json(); S.MCP_STATUS = d; S.MCP_SERVERS = Array.isArray(d.servers) ? d.servers : []; }
  catch { S.MCP_STATUS = { available:false, live:false, reason:'сеть', servers:[] }; S.MCP_SERVERS = []; }
  S.mcpLoaded = true; S.mcpLoading = false;
  if (S.activeView === 'mcp') renderMcp();
}

function mcpMatch(m){ return !S.query || ((m.name||'')+' '+(m.desc||'')+' '+(m.command||'')+' '+(m.scope||'')+' '+(m.status||'')).toLowerCase().includes(S.query); }
const MCP_ST = {
  connected:{c:'st-connected',t:'✓ Connected'}, failed:{c:'st-failed',t:'✗ Failed'},
  'needs-auth':{c:'st-needs-auth',t:'⚠ Needs Auth'}, pending:{c:'st-pending',t:'pending'},
  unknown:{c:'st-unknown',t:'—'},
};
function mcpBadge(s){ const m = MCP_ST[s] || MCP_ST.unknown; return `<span class="mcp-badge ${m.c}">${esc(m.t)}</span>`; }
const MCP_SCOPES = [['user','User'],['claudeai','claude.ai'],['dynamic','dynamic'],['project','project']];
function mcpReconnect(){ if (!S.mcpLoading) loadMcpCatalog(true); }   // «реконнект» = свежая проба (SDK коннектит MCP заново)
async function mcpAuthenticate(name){
  toast('Открываю авторизацию: ' + name + '…');
  let r; try { r = await (await fetch('/api/mcp/login?name='+encodeURIComponent(name), { method:'POST' })).json(); } catch { toast('Не удалось запустить авторизацию'); return; }
  if (!r.ok){ toast('Ошибка авторизации: ' + (r.error||'')); return; }
  if (r.url) openExternal(r.url);   // если CLI напечатал URL — откроем; иначе он сам открыл браузер
  const started = Date.now();       // поллим статус до connected (~2мин)
  const poll = async ()=>{
    if (S.activeView !== 'mcp') return;
    await loadMcpCatalog(true);
    const s = S.MCP_SERVERS.find(x=>x.name===name);
    if (s && s.status==='connected'){ toast(name + ': авторизован'); return; }
    if (Date.now()-started > 120000) return;
    setTimeout(poll, 3000);
  };
  setTimeout(poll, 3000);
}
async function mcpRemove(name, scope){
  if (!window.confirm('Удалить MCP-сервер «'+name+'»?\n\nВыполнится: claude mcp remove '+name+(scope?(' -s '+scope):''))) return;
  let r; try { r = await (await fetch('/api/mcp/remove?name='+encodeURIComponent(name)+'&scope='+encodeURIComponent(scope||''), { method:'POST' })).json(); } catch { toast('Ошибка удаления'); return; }
  if (r.ok){ toast('Удалён: ' + name); S.mcpDetail = null; loadMcpCatalog(true); }
  else toast('Не удалось удалить: ' + (r.error||''));
}
function renderMcpDetail(name){
  const s = S.MCP_SERVERS.find(x=>x.name===name);
  if (!s){ S.mcpDetail = null; return renderMcp(); }
  const isAuthable = /claudeai-proxy|http|sse/.test(s.transport||'') || s.scope==='claudeai';
  const canRemove = s.scope==='user' || s.scope==='project';
  const btns = [`<button class="mcp-act" data-act="reconnect">↻ Reconnect</button>`];
  if (isAuthable && (s.status==='needs-auth' || s.status==='failed' || s.scope==='claudeai')) btns.push(`<button class="mcp-act primary" data-act="auth">🔑 Authenticate</button>`);
  if (canRemove) btns.push(`<button class="mcp-act danger" data-act="remove">🗑 Delete</button>`);
  if (s.status==='connected') btns.push(`<button class="mcp-act" data-act="disable" title="Нет CLI-команды disable — отключение через /mcp в Claude Code">⏸ Disable</button>`);
  const cmdLabel = (s.command||'').startsWith('http') ? 'url' : 'command';
  const toolList = Array.isArray(s.tools)&&s.tools.length ? `<div class="mcp-tools">${s.tools.map(t=>`<span class="mcp-tool">${esc(t)}</span>`).join('')}</div>` : '';
  document.getElementById('viewMcp').innerHTML = `<div class="mcp-main">
    <button class="mcp-back" id="mcpBack">← Back to list</button>
    ${s.error?`<div class="mcp-errbar">${esc(s.error)}</div>`:''}
    <div class="mcp-dettop"><span class="mcp-name lg">${esc(s.name)}</span>${mcpBadge(s.status)}</div>
    <div class="mcp-kv"><span>scope</span><b>${esc(s.scope||'—')}</b></div>
    <div class="mcp-kv"><span>transport</span><b>${esc(s.transport||'—')}</b></div>
    <div class="mcp-kv"><span>${cmdLabel}</span><b>${esc(s.command||'—')}</b></div>
    ${s.toolCount!=null?`<div class="mcp-kv"><span>tools</span><b>${s.toolCount}</b></div>`:''}
    <div class="mcp-acts">${btns.join('')}</div>
    ${toolList}</div>`;
  document.getElementById('mcpBack').addEventListener('click', ()=>{ S.mcpDetail = null; renderMcp(); });
  document.querySelectorAll('#viewMcp .mcp-act').forEach(b=>b.addEventListener('click', ()=>{
    const a = b.dataset.act;
    if (a==='reconnect') mcpReconnect();
    else if (a==='auth') mcpAuthenticate(s.name);
    else if (a==='remove') mcpRemove(s.name, s.scope);
    else if (a==='disable') toast('Нет CLI-команды disable — отключи через /mcp в Claude Code');
  }));
}
function mcpRowsHtml(list){ return list.map(m=>`<div class="mcp-row" data-mcp="${esc(m.name)}"><span class="mcp-rowname">${esc(m.name)}</span>${mcpBadge(m.status)}</div>`).join(''); }
export function renderMcp(){
  if (S.mcpDetail) return renderMcpDetail(S.mcpDetail);
  if (!S.mcpLoaded && !S.mcpLoading){ loadMcpCatalog(); }
  const items = S.MCP_SERVERS.filter(mcpMatch);
  const note = S.mcpLoading ? 'опрос…'
    : (S.MCP_STATUS.live ? 'живой статус (SDK)'
      : (S.MCP_STATUS.available === false ? ('статус недоступен: ' + esc(S.MCP_STATUS.reason || '') + ' — показаны конфиги') : 'из конфигов'));
  const known = new Set(MCP_SCOPES.map(x=>x[0]));
  const groups = MCP_SCOPES.map(([sc,lbl])=>{ const g = items.filter(m=>(m.scope||'user')===sc); return g.length ? `<div class="mcp-group"><div class="mcp-grouphd">${esc(lbl)} <span class="mcp-gcount">${g.length}</span></div>${mcpRowsHtml(g)}</div>` : ''; }).join('');
  const other = items.filter(m=>!known.has(m.scope||'user'));
  const otherHtml = other.length ? `<div class="mcp-group"><div class="mcp-grouphd">прочее <span class="mcp-gcount">${other.length}</span></div>${mcpRowsHtml(other)}</div>` : '';
  // Авто-обнаруженные Unity-инстансы (появляются/исчезают сами по RunState-реестру) — отдельной секцией сверху.
  const shortP = p => String(p||'').split(/[\\/]/).slice(-2).join('/');
  const unityHtml = S.unityInstances.length ? `<div class="mcp-group"><div class="mcp-grouphd">Unity инстансы <span class="mcp-gcount">${S.unityInstances.length}</span></div>`
    + S.unityInstances.map(u=>`<div class="unity-row" data-cu="${esc(u.cu||'')}" data-cwd="${esc(u.projectPath||'')}" title="Запустить/сфокусировать Unity: ${esc(u.projectPath||'')}"><span class="mcp-rowname">${esc(u.cu||'unity')} <span class="unity-path">${esc(shortP(u.projectPath))}</span></span>${u.port?`<span class="unity-port">:${esc(String(u.port))}</span>`:''}<span class="mcp-badge st-connected">up</span></div>`).join('')
    + `</div>` : '';
  const body = (S.mcpLoading && !S.MCP_SERVERS.length) ? unityHtml + `<div class="empty">Опрашиваю MCP…</div>`
    : (items.length ? unityHtml+groups+otherHtml : unityHtml + `<div class="empty">${S.MCP_SERVERS.length?'Ничего не найдено':'MCP-серверы не найдены'}</div>`);
  document.getElementById('viewMcp').innerHTML = `<div class="mcp-main">
    <div class="mcp-head"><h2>MCP-инструменты</h2><span class="sub">${S.MCP_SERVERS.length} серверов · ${note}</span><button class="mcp-refresh" id="mcpRefresh"${S.mcpLoading?' disabled':''}>${S.mcpLoading?'опрос…':'↻ Обновить'}</button></div>
    ${body}
    <a class="mcp-learn" href="#" id="mcpLearn">Learn more about MCP ↗</a></div>`;
  const rb = document.getElementById('mcpRefresh'); if (rb) rb.addEventListener('click', ()=>{ if (!S.mcpLoading) loadMcpCatalog(true); });
  const ln = document.getElementById('mcpLearn'); if (ln) ln.addEventListener('click', e=>{ e.preventDefault(); openExternal('https://modelcontextprotocol.io'); });
  document.querySelectorAll('#viewMcp .mcp-row').forEach(r => r.addEventListener('click', ()=>{ S.mcpDetail = r.dataset.mcp; renderMcp(); }));
  document.querySelectorAll('#viewMcp .unity-row').forEach(r => r.addEventListener('click', ()=>launchUnity(r.dataset.cu, r.dataset.cwd)));   // тап → запуск/фокус Unity этого проекта
}
