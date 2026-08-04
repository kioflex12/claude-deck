// Deck — обнаружение возможностей окружения: скиллы/команды по cwd сессий и MCP-серверы (конфиг + живой статус
// через SDK). Цикл skills-mcp↔sessions безопасен — импортированный listSessionFiles вызывается в рантайме.

import { readFileSync, readdirSync, openSync, readSync, closeSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { sendJSON, getClaudeBin } from './core.mjs';
import { listSessionFiles } from './sessions.mjs';
import { getSdkQuery, awaitControlReady } from './sdk.mjs';

// -------- скиллы/команды по cwd сессии (для «/» в композере) --------

const SKILLS_CACHE = new Map();
export function safeDirents(dir) { try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; } }
function readFrontmatter(file) {
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { return null; }
  const m = text.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return { name: '', description: '' };
  const lines = m[1].split(/\r?\n/);
  let name = '', description = '', cat = '', trig = '';
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z0-9_-]+):[ \t]*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let val = kv[2];
    if (/^[|>][+-]?\s*$/.test(val)) {                    // YAML block scalar (folded > / literal |)
      const baseIndent = (lines[i].match(/^\s*/) || [''])[0].length;
      const collected = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        if (/^\s*$/.test(lines[j])) { collected.push(''); continue; }
        if ((lines[j].match(/^\s*/) || [''])[0].length <= baseIndent) break;
        collected.push(lines[j].trim());
      }
      i = j - 1;
      val = collected.join(val[0] === '|' ? '\n' : ' ').trim();
    } else {
      val = val.trim();
      if (val.length >= 2 && ((val[0] === '"' && val.endsWith('"')) || (val[0] === "'" && val.endsWith("'")))) val = val.slice(1, -1);
    }
    if (key === 'name' && !name) name = val;
    else if (key === 'description' && !description) description = val;
    else if ((key === 'cat' || key === 'category') && !cat) cat = val;
    else if ((key === 'trig' || key === 'triggers' || key === 'when') && !trig) trig = val;
  }
  return { name, description, cat, trig };
}
export function collectSkills(cwd) {
  if (SKILLS_CACHE.has(cwd)) return SKILLS_CACHE.get(cwd);
  const found = [], seen = new Set();
  const add = (name, description, source) => {
    name = (name || '').trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    found.push({ name, description: (description || '').slice(0, 300), source });
  };
  const projSkills = cwd ? path.join(cwd, '.claude', 'skills') : '';
  const userSkills = path.join(os.homedir(), '.claude', 'skills');
  const projCmds = cwd ? path.join(cwd, '.claude', 'commands') : '';
  if (projSkills) for (const d of safeDirents(projSkills)) if (d.isDirectory()) { const fm = readFrontmatter(path.join(projSkills, d.name, 'SKILL.md')); if (fm) add(fm.name || d.name, fm.description, 'project'); }
  for (const d of safeDirents(userSkills)) if (d.isDirectory()) { const fm = readFrontmatter(path.join(userSkills, d.name, 'SKILL.md')); if (fm) add(fm.name || d.name, fm.description, 'user'); }
  if (projCmds) for (const d of safeDirents(projCmds)) if (d.isFile() && d.name.endsWith('.md')) { const fm = readFrontmatter(path.join(projCmds, d.name)); add((fm && fm.name) || d.name.replace(/\.md$/, ''), fm && fm.description, 'command'); }
  found.sort((a, b) => a.name.localeCompare(b.name));
  SKILLS_CACHE.set(cwd, found);
  return found;
}

// -------- TECH-2: агрегат реальных скиллов и MCP-серверов (из файлов, БЕЗ хардкода) --------
// Уникальные cwd проектов из транскриптов сессий (читаем только начало файла — cwd в первой строке).
let _cwdsCache = { ts: 0, list: [] };
// cwd из ГОЛОВЫ файла (16КБ): первая строка-событие может быть длиннее буфера (в неё инжектится CLAUDE.md), поэтому
// per-line JSON тут не применим — читаем cwd целевым regex. Безопасно: top-level "cwd" в первой строке идёт до message,
// а первое совпадение = оно (экранированные \"cwd\" внутри контента этот шаблон не ловит).
function firstCwdOfFile(full) {
  let fd;
  try {
    fd = openSync(full, 'r');
    const buf = Buffer.alloc(16384);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const m = buf.toString('utf8', 0, n).match(/"cwd":"((?:[^"\\]|\\.)*)"/);
    if (!m) return '';
    try { return JSON.parse('"' + m[1] + '"'); } catch { return m[1]; }
  } catch { return ''; } finally { if (fd !== undefined) { try { closeSync(fd); } catch {} } }
}
export function uniqueSessionCwds() {
  if (Date.now() - _cwdsCache.ts < 60000) return _cwdsCache.list;
  const set = new Set();
  for (const f of listSessionFiles()) { const c = firstCwdOfFile(f.full); if (c) set.add(c); }
  _cwdsCache = { ts: Date.now(), list: [...set] };
  return _cwdsCache.list;
}
let _allSkills = { ts: 0, list: [] };
export function collectAllSkills() {
  if (Date.now() - _allSkills.ts < 30000) return _allSkills.list;
  const found = [], seen = new Set();
  const add = (name, fm, scope) => {
    name = String(name || '').trim(); const key = name.toLowerCase();
    if (!name || seen.has(key)) return;
    seen.add(key);
    const cat = (fm && (fm.cat || '').trim()) || scope || 'прочее';
    found.push({ cmd: name, does: ((fm && fm.description) || '').slice(0, 300), trig: (fm && fm.trig) || '', cat, scope });
  };
  const userSkills = path.join(os.homedir(), '.claude', 'skills');
  for (const d of safeDirents(userSkills)) if (d.isDirectory()) { const fm = readFrontmatter(path.join(userSkills, d.name, 'SKILL.md')); add((fm && fm.name) || d.name, fm, 'user'); }
  for (const cwd of uniqueSessionCwds()) {
    const ps = path.join(cwd, '.claude', 'skills');
    for (const d of safeDirents(ps)) if (d.isDirectory()) { const fm = readFrontmatter(path.join(ps, d.name, 'SKILL.md')); add((fm && fm.name) || d.name, fm, 'project'); }
  }
  found.sort((a, b) => a.cmd.localeCompare(b.cmd));
  _allSkills = { ts: Date.now(), list: found };
  return found;
}
function mcpEntryInfo(name, cfg, scope) {
  cfg = cfg || {};
  const transport = cfg.type || (cfg.command ? 'stdio' : (cfg.url ? 'http' : ''));
  const command = cfg.command ? [cfg.command].concat(Array.isArray(cfg.args) ? cfg.args : []).join(' ') : (cfg.url || '');
  return { name, scope, transport: transport || (cfg.url ? 'http' : cfg.command ? 'stdio' : ''), command, desc: cfg.description || '' };
}
function collectMcpConfig() {
  const found = new Map();   // name -> info, дедуп по имени (первый источник выигрывает)
  const add = (name, cfg, scope) => { if (!name || found.has(name)) return; found.set(name, mcpEntryInfo(name, cfg, scope)); };
  // ~/.claude.json — глобальные mcpServers + по-проектные projects[<path>].mcpServers
  try {
    const j = JSON.parse(readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
    if (j.mcpServers) for (const [n, c] of Object.entries(j.mcpServers)) add(n, c, 'user');
    if (j.projects && typeof j.projects === 'object') {
      for (const pc of Object.values(j.projects)) { if (pc && pc.mcpServers) for (const [n, c] of Object.entries(pc.mcpServers)) add(n, c, 'project'); }
    }
  } catch {}
  // .mcp.json в корне каждого проекта (по уникальным cwd)
  for (const cwd of uniqueSessionCwds()) {
    try { const j = JSON.parse(readFileSync(path.join(cwd, '.mcp.json'), 'utf8')); if (j.mcpServers) for (const [n, c] of Object.entries(j.mcpServers)) add(n, c, '.mcp.json'); } catch {}
  }
  // enabledMcpjsonServers из settings — только имена (конфиг может жить в другом месте): показываем нейтрально
  for (const sf of ['settings.json', 'settings.local.json']) {
    try {
      const s = JSON.parse(readFileSync(path.join(os.homedir(), '.claude', sf), 'utf8'));
      if (Array.isArray(s.enabledMcpjsonServers)) for (const n of s.enabledMcpjsonServers) add(n, {}, 'enabled');
    } catch {}
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}
export function apiMcp(res) {
  const servers = collectMcpConfig();
  sendJSON(res, { count: servers.length, servers });
}
// Живой статус MCP: контрол-запрос SDK mcpServerStatus() (без turn; SDK коннектит MCP на каждый query).
// Форма ответа сервера: [{name, status: connected|failed|needs-auth|pending, error?, config:{type,command,args,url}, scope, tools:[{name,annotations}]}].
async function fetchMcpStatusRaw() {
  const query = await getSdkQuery();
  const ac = new AbortController();
  async function* openInput() { await new Promise((r) => setTimeout(r, 60000)); }   // держим ввод открытым, turn НЕ шлём
  // БЕЗ settingSources:[] — иначе SDK не загрузит MCP-конфиг и статус будет пустой.
  const q = query({ prompt: openInput(), options: { permissionMode: 'plan', abortController: ac } });
  let streamErr = null;
  (async () => { try { for await (const _ of q) { /* дренаж стрима, чтобы транспорт не блокировался бэкпрешером */ } } catch (e) { streamErr = e; } })();
  try {
    await awaitControlReady(q, 20000);
    // Серверы коннектятся ПОСТЕПЕННО — несколько снимков, мёрж по имени (pending→connected апгрейдим, tools предпочитаем).
    const merged = new Map();
    let got = false, lastErr;
    for (let i = 0; i < 8; i++) {
      if (i) await new Promise((r) => setTimeout(r, 1200));
      try {
        const s = await q.mcpServerStatus();
        if (Array.isArray(s)) { got = true; for (const srv of s) { const prev = merged.get(srv.name); if (!prev || (prev.status === 'pending' && srv.status !== 'pending') || (srv.tools && !prev.tools)) merged.set(srv.name, srv); } }
      } catch (e) { lastErr = e; }
    }
    if (got) return [...merged.values()];
    throw lastErr || streamErr || new Error('mcp status unavailable');
  } finally { try { ac.abort(); } catch {} }
}
function mapMcpServer(s) {
  const cfg = s.config || {};
  const transport = cfg.type || (cfg.url ? 'http' : cfg.command ? 'stdio' : '');
  const command = cfg.command ? [cfg.command].concat(Array.isArray(cfg.args) ? cfg.args : []).join(' ') : (cfg.url || '');
  const tools = Array.isArray(s.tools) ? s.tools.map((t) => (typeof t === 'string' ? t : (t && t.name) || '')).filter(Boolean) : null;
  return { name: s.name, status: s.status || 'unknown', error: s.error || '', transport, command, scope: s.scope || '', toolCount: tools ? tools.length : null, tools: tools ? tools.slice(0, 80) : null };
}
let _mcpStatus = { ts: 0, data: null };
const MCP_STATUS_TTL = 30000;
export async function apiMcpStatus(res, u) {
  const refresh = u.searchParams.get('refresh') === '1';   // reconnect в нашей модели = свежая проба (SDK коннектит MCP заново)
  if (!refresh && _mcpStatus.data && Date.now() - _mcpStatus.ts < MCP_STATUS_TTL) { sendJSON(res, _mcpStatus.data); return; }
  const cfg = collectMcpConfig();
  let data;
  try {
    const raw = await fetchMcpStatusRaw();
    const map = new Map(raw.map((s) => [s.name, mapMcpServer(s)]));
    for (const c of cfg) {   // серверов из конфига, которых SDK не вернул (не поднялись за окно) — добавим со статусом unknown; и добьём desc
      if (!map.has(c.name)) map.set(c.name, { name: c.name, status: 'unknown', error: '', transport: c.transport, command: c.command, scope: c.scope, toolCount: null, tools: null, desc: c.desc });
      else { const s = map.get(c.name); if (!s.desc && c.desc) s.desc = c.desc; if (!s.command && c.command) s.command = c.command; if (!s.transport && c.transport) s.transport = c.transport; if (!s.scope && c.scope) s.scope = c.scope; }
    }
    const servers = [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
    data = { available: true, live: true, count: servers.length, servers };
  } catch (e) {
    // Честный фолбэк: SDK-проба не удалась → листинг из конфигов со статусом unknown + пометка.
    const servers = cfg.map((c) => ({ name: c.name, status: 'unknown', error: '', transport: c.transport, command: c.command, scope: c.scope, toolCount: null, tools: null, desc: c.desc })).sort((a, b) => a.name.localeCompare(b.name));
    data = { available: false, live: false, reason: (e && e.message) || String(e), count: servers.length, servers };
  }
  _mcpStatus = { ts: Date.now(), data };
  sendJSON(res, data);
}
// Authenticate: `claude mcp login <name>` — OAuth-логин к серверу (HTTP/SSE/claude.ai-коннектор), открывает браузер и
// самозавершается через колбэк (как claude auth login). Отвечаем сразу (браузер открыт), клиент поллит статус до connected.
const _mcpLoginChildren = new Set();
// S3: имя MCP уходит в spawn с shell:true (Windows) → без валидации `& | " %..%` вырвались бы в cmd.exe (RCE).
const MCP_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
export function apiMcpLogin(res, u) {
  const name = u.searchParams.get('name') || '';
  if (!MCP_NAME_RE.test(name)) { sendJSON(res, { ok: false, error: 'bad name' }, 400); return; }
  let child;
  try { child = spawn(getClaudeBin(), ['mcp', 'login', name], { windowsHide: true, shell: process.platform === 'win32' }); }
  catch (e) { sendJSON(res, { ok: false, error: String((e && e.message) || e) }); return; }
  _mcpLoginChildren.add(child);
  let buf = '', replied = false;
  const reply = (o) => { if (replied) return; replied = true; sendJSON(res, o); };
  const onData = (d) => { buf += String(d); const m = buf.match(/https?:\/\/\S+/); if (m) reply({ ok: true, name, url: m[0] }); };
  child.stdout.on('data', onData); child.stderr.on('data', onData);
  child.on('exit', () => { _mcpLoginChildren.delete(child); _mcpStatus = { ts: 0, data: null }; reply({ ok: true, name }); });
  child.on('error', (e) => { _mcpLoginChildren.delete(child); reply({ ok: false, error: String((e && e.message) || e) }); });
  setTimeout(() => reply({ ok: true, name }), 4000);   // браузер открылся — не ждём завершения OAuth
}
// Remove/Delete: `claude mcp remove <name> -s <scope>` — безопасно через CLI (без ручной правки JSON). Scope только user/project/local.
export function apiMcpRemove(res, u) {
  const name = u.searchParams.get('name') || '';
  const scope = u.searchParams.get('scope') || '';
  if (!MCP_NAME_RE.test(name)) { sendJSON(res, { ok: false, error: 'bad name' }, 400); return; }   // S3: см. MCP_NAME_RE
  const args = ['mcp', 'remove', name];
  if (['user', 'project', 'local'].includes(scope)) args.push('-s', scope);
  execFile(getClaudeBin(), args, { timeout: 15000, windowsHide: true, shell: process.platform === 'win32' }, (err, stdout, stderr) => {
    _mcpStatus = { ts: 0, data: null };
    if (err) sendJSON(res, { ok: false, error: String(stderr || (err && err.message) || err).trim().slice(0, 300) });
    else sendJSON(res, { ok: true, output: String(stdout || '').trim().slice(0, 300) });
  });
}
