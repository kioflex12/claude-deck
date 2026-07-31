// Deck — интеграции с внешними сервисами: live-статус клиентских сборок TeamCity, MR по ветке из GitLab
// и статус задачи в Jira. Хосты/токены резолвятся в applyConfig (core); нет токена → мягкая деградация.

import { TC_HOST, TC_TOKEN, GL_HOST, GL_TOKEN, JIRA_ENABLED, JIRA_HOST, JIRA_EMAIL, JIRA_TOKEN, BASE_BRANCHES, sendJSON } from './core.mjs';
import { isBaseBranch } from './text.mjs';

// -------- TeamCity: live-статус клиентских сборок по ветке (секция «Сборки» в рейле) --------
// Хост дефолтный, токен из env (TEAMCITY_TOKEN). Нет токена → { available:false } и клиент
// показывает приближённую метку по wfBuildState. Ветку матчим точно; фолбэк — свежие билды типа,
// у которых branchName начинается с WO (ветка vibecode-сессии не всегда = ветка клиентской сборки).
// TC_HOST/TC_TOKEN резолвятся в applyConfig() (config → env/.env → дефолт; токен из safeStorage либо .env).
const TC_BUILD_TYPES = [
  { id: 'Wo_Client_Development_Android', plat: 'Android' },
  { id: 'Wo_Client_Development_IOS', plat: 'iOS' },
];
const TC_FIELDS = 'fields=count,build(id,number,status,state,branchName,webUrl,buildTypeId)';
export const _tcCache = new Map();   // branch -> { ts, data }
const TC_TTL = 8000;

async function tcJson(pathq) {
  const r = await fetch(TC_HOST + pathq, {
    headers: { Authorization: 'Bearer ' + TC_TOKEN, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error('TeamCity HTTP ' + r.status);
  return r.json();
}
async function tcLatestBuild(btId, branch, wo) {
  // Точный матч по ветке — ТОЛЬКО для реальной фича/WO-ветки. У базовой (preprod/preupdate/…) он вернул бы
  // чужой неродственный dev-билд, крутившийся на этой ветке (баг «сборки упали» на контексте без сборок).
  if (branch && !isBaseBranch(branch)) {
    const j = await tcJson('/app/rest/builds?locator=buildType:(id:' + btId + '),branch:(name:' + encodeURIComponent(branch) + ',default:any),count:1&' + TC_FIELDS);
    if (j.count && j.build && j.build[0]) return j.build[0];
  }
  if (wo) {
    const j = await tcJson('/app/rest/builds?locator=buildType:(id:' + btId + '),branch:(default:any),count:40&' + TC_FIELDS);
    const hit = (j.build || []).find((b) => b.branchName && b.branchName.indexOf(wo) === 0);
    if (hit) return hit;
  }
  return null;
}
// ЖИВОЙ признак «билд реально идёт» (running/queued в TeamCity). Кэш по branch|wo с АДАПТИВНЫМ TTL:
// активный билд — короткий TTL (~15с), чтобы быстро поймать завершение; неактивный — обычный (~60с).
export const _buildActiveCache = new Map();
const BUILD_TTL_ACTIVE = 15 * 1000;
const BUILD_TTL_IDLE = 60 * 1000;
export async function buildActiveFor(branch, wo) {
  if (!TC_TOKEN || !TC_HOST) return false;
  const key = (branch || '') + '|' + (wo || '');
  const c = _buildActiveCache.get(key);
  if (c && Date.now() - c.ts < (c.v ? BUILD_TTL_ACTIVE : BUILD_TTL_IDLE)) return c.v;
  let active = false;
  try {
    for (const bt of TC_BUILD_TYPES) {
      const b = await tcLatestBuild(bt.id, branch, wo);
      const state = b && String(b.state || '').toLowerCase();
      if (state === 'running' || state === 'queued') { active = true; break; }   // finished/none → не активен
    }
  } catch { active = false; }
  _buildActiveCache.set(key, { ts: Date.now(), v: active });
  return active;
}
export async function apiBuild(res, u) {
  const branch = u.searchParams.get('branch') || '';
  const wo = u.searchParams.get('wo') || '';
  if (!TC_TOKEN || !TC_HOST) { sendJSON(res, { available: false, reason: 'TeamCity не настроен (host/token)', host: TC_HOST }); return; }
  if (!branch) { sendJSON(res, { available: true, host: TC_HOST, branch, builds: [] }); return; }
  // Базовая ветка без WO не идентифицирует сборки контекста — не дёргаем TeamCity впустую.
  if (isBaseBranch(branch) && !wo) { sendJSON(res, { available: true, host: TC_HOST, branch, builds: [], reason: 'base-branch' }); return; }
  const cached = _tcCache.get(branch);
  if (cached && Date.now() - cached.ts < TC_TTL) { sendJSON(res, cached.data); return; }
  try {
    const builds = [];
    for (const bt of TC_BUILD_TYPES) {
      const b = await tcLatestBuild(bt.id, branch, wo);
      if (b) builds.push({ plat: bt.plat, number: b.number, status: b.status, state: b.state, webUrl: b.webUrl, branchName: b.branchName });
    }
    const data = { available: true, host: TC_HOST, branch, builds };
    _tcCache.set(branch, { ts: Date.now(), data });
    sendJSON(res, data);
  } catch (e) {
    sendJSON(res, { available: false, reason: (e && e.message) || String(e), host: TC_HOST });
  }
}

// -------- GitLab: live-MR по ветке (секция «Merge Requests»; приоритет над stale wfMrUrl из dev-workflow) --------
// Ищем MR ГЛОБАЛЬНО по source_branch (scope=all) — надёжнее, чем угадывать project id (client-unity/backend-services/
// staticsutils). Фолбэк — search=<WO-XXXX>. Нет токена → { available:false }, клиент оставляет wfMrUrl.
// GL_HOST/GL_TOKEN резолвятся в applyConfig() (config → env/.env → дефолт; токен из safeStorage либо .env).
export const _mrCache = new Map();   // branch|wo -> { ts, data }
const MR_TTL = 30000;

async function glJson(pathq) {
  const r = await fetch(GL_HOST + pathq, { headers: { 'PRIVATE-TOKEN': GL_TOKEN }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('GitLab HTTP ' + r.status);
  return r.json();
}
function mrProject(webUrl) {
  const m = String(webUrl || '').match(/^https?:\/\/[^/]+\/(.+?)\/-\/merge_requests\//);
  return m ? m[1] : '';
}
function mapMr(m) {
  return { iid: m.iid, title: m.title, state: m.state, web_url: m.web_url, target_branch: m.target_branch, source_branch: m.source_branch, project: mrProject(m.web_url), updated_at: m.updated_at };
}
export async function apiMrs(res, u) {
  const branch = u.searchParams.get('branch') || '';
  const wo = u.searchParams.get('wo') || '';
  if (!GL_TOKEN || !GL_HOST) { sendJSON(res, { available: false, reason: 'GitLab не настроен (host/token)', host: GL_HOST }); return; }
  if (!branch && !wo) { sendJSON(res, { available: true, host: GL_HOST, mrs: [] }); return; }
  const key = branch + '|' + wo;
  const fresh = u.searchParams.get('refresh') === '1';   // рефреш дашборда — обойти кэш
  const cached = _mrCache.get(key);
  if (!fresh && cached && Date.now() - cached.ts < MR_TTL) { sendJSON(res, cached.data); return; }
  try {
    let list = [];
    // По source_branch ищем только для рабочих (не-базовых) веток — у preprod/preupdate это бессмысленно.
    const useBranch = branch && !BASE_BRANCHES.has(String(branch).toLowerCase());
    if (useBranch) list = await glJson('/api/v4/merge_requests?scope=all&source_branch=' + encodeURIComponent(branch) + '&state=all&per_page=20');
    // Фолбэк: по WO в ЗАГОЛОВКЕ MR (точнее, чем полнотекст) — ловит MR сессий-уборок (ветка preprod, WO в промпте).
    if ((!Array.isArray(list) || !list.length) && wo) list = await glJson('/api/v4/merge_requests?scope=all&search=' + encodeURIComponent(wo) + '&in=title&state=all&per_page=20');
    const mrs = (Array.isArray(list) ? list : []).map(mapMr).sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
    const data = { available: true, host: GL_HOST, branch, mrs };
    _mrCache.set(key, { ts: Date.now(), data });
    sendJSON(res, data);
  } catch (e) {
    sendJSON(res, { available: false, reason: (e && e.message) || String(e), host: GL_HOST });
  }
}

// -------- Jira: живой статус задачи (колонка «Статусы» приоритетнее локального dev-workflow) --------
// Гейт по JIRA_HOST/JIRA_EMAIL/JIRA_TOKEN (кладутся через .env). Basic auth base64(email:token).
// Возвращаем СЫРОЙ статус; маппинг статус→колонка делает клиент (нужен live-статус билда для In Progress).
// JIRA_HOST/EMAIL/TOKEN/JIRA_ENABLED резолвятся в applyConfig() (config → env/.env; токен из safeStorage либо .env).
export const _jiraCache = new Map();   // wo -> { ts, data }
const JIRA_TTL = 30000;
// Реюзабельный резолвер статуса Jira (кэш 30с). Возвращает {available,status,category,summary}. Не бросает.
export async function jiraStatus(wo, fresh) {
  wo = String(wo || '').trim();
  if (!JIRA_ENABLED) return { available: false, reason: 'no JIRA token/email/host' };
  if (!/^WO-\d+$/i.test(wo)) return { available: true, status: null };
  const cached = _jiraCache.get(wo);
  if (!fresh && cached && Date.now() - cached.ts < JIRA_TTL) return cached.data;   // refresh=1 (рефреш дашборда) обходит кэш
  try {
    const auth = Buffer.from(JIRA_EMAIL + ':' + JIRA_TOKEN).toString('base64');
    const r = await fetch('https://' + JIRA_HOST + '/rest/api/3/issue/' + encodeURIComponent(wo) + '?fields=status,summary', {
      headers: { Authorization: 'Basic ' + auth, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error('Jira HTTP ' + r.status);
    const j = await r.json();
    const st = j.fields && j.fields.status;
    const data = { available: true, status: st ? st.name : null, category: st && st.statusCategory ? st.statusCategory.key : '', summary: (j.fields && j.fields.summary) || '' };
    _jiraCache.set(wo, { ts: Date.now(), data });
    return data;
  } catch (e) {
    const data = { available: false, reason: (e && e.message) || String(e) };
    _jiraCache.set(wo, { ts: Date.now(), data });   // кэшируем и неудачу — не долбим на каждый поллинг
    return data;
  }
}
export async function apiJira(res, u) { sendJSON(res, await jiraStatus(u.searchParams.get('wo') || '', u.searchParams.get('refresh') === '1')); }
