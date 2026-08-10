// Deck — авто-дискавери запущенных Unity-инстансов по pid-файлам MCP-for-Unity (без ручного `claude mcp add`).

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { sendJSON, loadConfig } from './core.mjs';
import { uniqueSessionCwds } from './skills-mcp.mjs';

// Механизм: MCP-for-Unity пишет на каждый живой Editor файл <project>/Library/MCPForUnity/RunState/mcp_http_<port>.pid
// (имя = HTTP-порт бриджа, содержимое = PID mcp-сервера). Живой PID = инстанс up. projectPath → cuN по client-unity-N.
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); } }
function unityProjectRoots() {
  const roots = new Set();
  // добавить все client-unity-* внутри каталога dir (копии — дети репо/родителя)
  const globCU = (dir) => { try { for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory() && /^client-unity-\d+$/i.test(e.name)) roots.add(path.join(dir, e.name)); } catch {} };
  for (const cwd of uniqueSessionCwds()) {
    const segs = String(cwd).split(/[\\/]/);
    const idx = segs.findIndex((s) => /^client-unity-\d+$/i.test(s));
    if (idx >= 0) { const r = segs.slice(0, idx + 1).join(path.sep); roots.add(r); globCU(path.dirname(r)); }   // cwd внутри client-unity-N → сам + сиблинги
    else globCU(cwd);          // cwd = корень репо → его client-unity-* дети (сессии Deck крутятся в корне, копии — рядом)
    roots.add(cwd);            // сам cwd тоже может быть Unity-проектом (напр. citybuilder)
  }
  try { const c = loadConfig(); if (c.clientUnityParent) globCU(c.clientUnityParent); } catch {}
  return [...roots];
}
function scanUnityInstances() {
  const out = [], seen = new Set();
  for (const root of unityProjectRoots()) {
    const rs = path.join(root, 'Library', 'MCPForUnity', 'RunState');
    let files = []; try { files = readdirSync(rs); } catch { continue; }
    for (const f of files) {
      const m = f.match(/^mcp_http_(\d+)\.pid$/); if (!m) continue;
      let pid = 0; try { pid = parseInt(readFileSync(path.join(rs, f), 'utf8').trim(), 10) || 0; } catch {}
      if (!(pid > 0 && pidAlive(pid))) continue;   // нет pid или процесс мёртв → stale-файл, инстанс не живой
      const key = pid + '@' + m[1];                // один инстанс = один pidfile; один корень мог попасть в разном регистре
      if (seen.has(key)) continue; seen.add(key);
      const cm = root.match(/client-unity-(\d+)/i);
      out.push({ cu: cm ? 'cu' + cm[1] : '', projectPath: root, port: +m[1], pid, status: 'up' });
    }
  }
  return out.sort((a, b) => (a.cu || a.projectPath).localeCompare(b.cu || b.projectPath));
}
let _unityInst = { ts: 0, data: null };
const UNITY_TTL = 12000;   // короткий кэш — инстансы должны появляться/исчезать
export function apiUnityInstances(res, u) {
  if (u.searchParams.get('refresh') !== '1' && _unityInst.data && Date.now() - _unityInst.ts < UNITY_TTL) { sendJSON(res, _unityInst.data); return; }
  const instances = scanUnityInstances();
  _unityInst = { ts: Date.now(), data: { count: instances.length, instances } };
  sendJSON(res, _unityInst.data);
}
