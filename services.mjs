// Deck — интеграции с внешними сервисами: live-статус клиентских сборок TeamCity, MR по ветке из GitLab
// и статус задачи в Jira. Хосты/токены резолвятся в applyConfig (core); нет токена → мягкая деградация.

import { TC_HOST, TC_TOKEN, GL_HOST, GL_TOKEN, JIRA_ENABLED, JIRA_HOST, JIRA_EMAIL, JIRA_TOKEN, BASE_BRANCHES, sendJSON, readJsonBody, fetchRetry, markHealth, svcHealth } from './core.mjs';
import { isBaseBranch } from './text.mjs';

// TECH-4: /api/health — сводка здоровья интеграций для топбар-индикатора (какой сервис деградирует и почему).
export function apiHealth(res) { sendJSON(res, { services: svcHealth }); }

// -------- Проверка подключения из Настроек: бьём по «кто я» (не по конкретной задаче/ветке) — отличаем
// неверный хост (404/нет связи) от неверных учётных данных (401/403) от рабочего подключения (200). --------
const normHost = (h) => String(h || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
async function testJira(host, email, token) {
  host = normHost(host);
  if (!host || !email || !token) return { ok: false, message: 'Заполните host, email и токен' };
  try {
    const auth = Buffer.from(email + ':' + token).toString('base64');
    const r = await fetchRetry('https://' + host + '/rest/api/3/myself', { headers: { Authorization: 'Basic ' + auth, Accept: 'application/json' } }, { retries: 1 });
    if (r.ok) { const j = await r.json().catch(() => ({})); return { ok: true, message: 'OK: ' + (j.displayName || 'вход выполнен') + (j.emailAddress ? ' <' + j.emailAddress + '>' : '') }; }
    if (r.status === 401 || r.status === 403) return { ok: false, message: 'HTTP ' + r.status + ' — неверные email/токен (или нет доступа к сайту)' };
    if (r.status === 404) return { ok: false, message: 'HTTP 404 — учётка ок, но проверьте host: должен быть ВАШ сайт *.atlassian.net (задачи 404 = не тот сайт/нет доступа к проекту)' };
    return { ok: false, message: 'HTTP ' + r.status };
  } catch (e) { return { ok: false, message: 'Хост недоступен: ' + ((e && e.message) || e) }; }
}
async function testGitlab(host, token) {
  host = normHost(host);
  if (!host || !token) return { ok: false, message: 'Заполните host и токен' };
  try {
    const r = await fetchRetry('https://' + host + '/api/v4/user', { headers: { 'PRIVATE-TOKEN': token } }, { retries: 1 });
    if (r.ok) { const j = await r.json().catch(() => ({})); return { ok: true, message: 'OK: ' + (j.username ? '@' + j.username : (j.name || 'вход выполнен')) }; }
    if (r.status === 401 || r.status === 403) return { ok: false, message: 'HTTP ' + r.status + ' — неверный private-токен (или нет прав)' };
    return { ok: false, message: 'HTTP ' + r.status + (r.status === 404 ? ' — проверьте host GitLab' : '') };
  } catch (e) { return { ok: false, message: 'Хост недоступен: ' + ((e && e.message) || e) }; }
}
async function testTeamcity(host, token) {
  host = normHost(host);
  if (!host || !token) return { ok: false, message: 'Заполните host и токен' };
  try {
    const r = await fetchRetry('https://' + host + '/app/rest/server', { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } }, { retries: 1 });
    if (r.ok) { const j = await r.json().catch(() => ({})); return { ok: true, message: 'OK: TeamCity ' + (j.version || 'подключение работает') }; }
    if (r.status === 401 || r.status === 403) return { ok: false, message: 'HTTP ' + r.status + ' — неверный bearer-токен (или нет прав)' };
    return { ok: false, message: 'HTTP ' + r.status + (r.status === 404 ? ' — проверьте host TeamCity' : '') };
  } catch (e) { return { ok: false, message: 'Хост недоступен: ' + ((e && e.message) || e) }; }
}
// Значения берём из тела (то, что сейчас в полях Настроек — можно проверить ДО сохранения); токен пустой в теле →
// используем уже сохранённый (write-only, наружу не отдаётся, поэтому в поле его нет).
export async function apiConfigTest(req, res) {
  let body = {};
  try { body = await readJsonBody(req, 8192); } catch {}
  const svc = String(body.svc || '');
  let out;
  if (svc === 'jira') out = await testJira(body.host || JIRA_HOST, body.email || JIRA_EMAIL, body.token || JIRA_TOKEN);
  else if (svc === 'gitlab') out = await testGitlab(body.host || GL_HOST, body.token || GL_TOKEN);
  else if (svc === 'teamcity') out = await testTeamcity(body.host || TC_HOST, body.token || TC_TOKEN);
  else out = { ok: false, message: 'unknown svc' };
  sendJSON(res, out);
}

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
  const r = await fetchRetry(TC_HOST + pathq, { headers: { Authorization: 'Bearer ' + TC_TOKEN, Accept: 'application/json' } });
  if (!r.ok) throw new Error('TeamCity HTTP ' + r.status);
  return r.json();
}
async function tcLatestBuild(btId, branch, wo) {
  // Точный матч по ветке — ТОЛЬКО для реальной фича/WO-ветки. У базовой (preprod/preupdate/…) он вернул бы
  // чужой неродственный dev-билд, крутившийся на этой ветке (баг «сборки упали» на контексте без сборок).
  // state:any — включаем СТОЯЩИЕ В ОЧЕРЕДИ и ВЫПОЛНЯЮЩИЕСЯ сборки (по умолчанию локатор отдаёт только finished →
  // только что поставленный билд не виден ни в рейле, ни в детекте buildActive → карточка не уходила в «Build In Progress»).
  if (branch && !isBaseBranch(branch)) {
    const j = await tcJson('/app/rest/builds?locator=buildType:(id:' + btId + '),branch:(name:' + encodeURIComponent(branch) + ',default:any),state:any,count:1&' + TC_FIELDS);
    if (j.count && j.build && j.build[0]) return j.build[0];
  }
  if (wo) {
    const j = await tcJson('/app/rest/builds?locator=buildType:(id:' + btId + '),branch:(default:any),state:any,count:40&' + TC_FIELDS);
    const hit = (j.build || []).find((b) => b.branchName && b.branchName.indexOf(wo) === 0);
    if (hit) return hit;
  }
  return null;
}
// ЖИВОЕ состояние клиентских сборок ветки. Кэш по branch|wo с АДАПТИВНЫМ TTL: активный билд — короткий TTL (~15с),
// чтобы быстро поймать завершение; неактивный — обычный (~60с). Отдаём ОБА признака: active (running/queued) → колонка
// «Build In Progress»; failed (последняя ЗАВЕРШЁННАЯ сборка не SUCCESS) → лента «Требует внимания» (красная сборка).
export const _buildActiveCache = new Map();   // branch|wo -> { ts, v:{active,failed} }
const BUILD_TTL_ACTIVE = 15 * 1000;
const BUILD_TTL_IDLE = 60 * 1000;
export async function buildStateFor(branch, wo) {
  if (!TC_TOKEN || !TC_HOST) return { active: false, failed: false };
  const key = (branch || '') + '|' + (wo || '');
  const c = _buildActiveCache.get(key);
  if (c && Date.now() - c.ts < (c.v.active ? BUILD_TTL_ACTIVE : BUILD_TTL_IDLE)) return c.v;
  let active = false, failed = false;
  try {
    for (const bt of TC_BUILD_TYPES) {
      const b = await tcLatestBuild(bt.id, branch, wo);
      if (!b) continue;
      const state = String(b.state || '').toLowerCase();
      if (state === 'running' || state === 'queued') active = true;             // идёт/в очереди
      else if (state === 'finished' && b.status && String(b.status).toUpperCase() !== 'SUCCESS') failed = true;   // FAILURE/ERROR — упала
    }
    markHealth('teamcity', { ok: true, reason: '' });
  } catch (e) { active = false; failed = false; markHealth('teamcity', { ok: false, reason: (e && e.message) || String(e) }); }
  const v = { active, failed };
  _buildActiveCache.set(key, { ts: Date.now(), v });
  return v;
}
export async function buildActiveFor(branch, wo) { return (await buildStateFor(branch, wo)).active; }
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
    markHealth('teamcity', { ok: true, reason: '' });
    sendJSON(res, data);
  } catch (e) {
    const reason = (e && e.message) || String(e);
    markHealth('teamcity', { ok: false, reason });
    sendJSON(res, { available: false, reason, host: TC_HOST });
  }
}

// -------- GitLab: live-MR по ветке (секция «Merge Requests»; приоритет над stale wfMrUrl из dev-workflow) --------
// Ищем MR ГЛОБАЛЬНО по source_branch (scope=all) — надёжнее, чем угадывать project id (client-unity/backend-services/
// staticsutils). Фолбэк — search=<WO-XXXX>. Нет токена → { available:false }, клиент оставляет wfMrUrl.
// GL_HOST/GL_TOKEN резолвятся в applyConfig() (config → env/.env → дефолт; токен из safeStorage либо .env).
export const _mrCache = new Map();   // branch|wo -> { ts, data }
const MR_TTL = 30000;

async function glJson(pathq) {
  const r = await fetchRetry(GL_HOST + pathq, { headers: { 'PRIVATE-TOKEN': GL_TOKEN } });
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
    markHealth('gitlab', { ok: true, reason: '' });
    sendJSON(res, data);
  } catch (e) {
    const reason = (e && e.message) || String(e);
    markHealth('gitlab', { ok: false, reason });
    sendJSON(res, { available: false, reason, host: GL_HOST });
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
  if (!JIRA_ENABLED) return { available: false, configured: false, reason: 'no JIRA token/email/host' };
  if (!/^WO-\d+$/i.test(wo)) return { available: true, status: null };
  const cached = _jiraCache.get(wo);
  if (!fresh && cached && Date.now() - cached.ts < JIRA_TTL) return cached.data;   // refresh=1 (рефреш дашборда) обходит кэш
  try {
    const auth = Buffer.from(JIRA_EMAIL + ':' + JIRA_TOKEN).toString('base64');
    const r = await fetchRetry('https://' + JIRA_HOST + '/rest/api/3/issue/' + encodeURIComponent(wo) + '?fields=status,summary', {
      headers: { Authorization: 'Basic ' + auth, Accept: 'application/json' },
    });
    if (!r.ok) throw new Error('Jira HTTP ' + r.status);
    const j = await r.json();
    const st = j.fields && j.fields.status;
    const data = { available: true, configured: true, status: st ? st.name : null, category: st && st.statusCategory ? st.statusCategory.key : '', summary: (j.fields && j.fields.summary) || '' };
    _jiraCache.set(wo, { ts: Date.now(), data });
    markHealth('jira', { ok: true, reason: '' });
    return data;
  } catch (e) {
    const reason = (e && e.message) || String(e);
    const data = { available: false, configured: true, reason };   // configured:true — Jira настроена, но ход/сеть сбойнули (503/timeout): клиент НЕ должен ронять весь Jira
    _jiraCache.set(wo, { ts: Date.now(), data });   // кэшируем и неудачу — не долбим на каждый поллинг
    markHealth('jira', { ok: false, reason });
    return data;
  }
}
export async function apiJira(res, u) { sendJSON(res, await jiraStatus(u.searchParams.get('wo') || '', u.searchParams.get('refresh') === '1')); }

// -------- Фаза-4: быстрые действия с карточки (прямые API-записи, каждое — после подтверждения в UI) --------
// Отчёт в Jira: POST комментария. Тело Jira требует ADF (Atlassian Document Format), не plain-text — заворачиваем
// абзацы. Комментарий обратим (можно удалить), но всё равно спрашиваем подтверждение на клиенте.
function adfFromText(text) {
  const paras = String(text || '').split(/\n+/).map((s) => s.trim()).filter(Boolean);
  return { type: 'doc', version: 1, content: (paras.length ? paras : ['—']).map((p) => ({ type: 'paragraph', content: [{ type: 'text', text: p }] })) };
}
export async function apiJiraComment(req, res) {
  let body = {}; try { body = await readJsonBody(req, 64 * 1024); } catch {}
  const wo = String(body.wo || '').trim(), text = String(body.body || '').trim();
  if (!JIRA_ENABLED) { sendJSON(res, { ok: false, error: 'Jira не настроена (host/email/token)' }); return; }
  if (!/^WO-\d+$/i.test(wo)) { sendJSON(res, { ok: false, error: 'нужен ключ задачи WO-XXXX' }); return; }
  if (!text) { sendJSON(res, { ok: false, error: 'пустой комментарий' }); return; }
  try {
    const auth = Buffer.from(JIRA_EMAIL + ':' + JIRA_TOKEN).toString('base64');
    const r = await fetchRetry('https://' + JIRA_HOST + '/rest/api/3/issue/' + encodeURIComponent(wo) + '/comment', {
      method: 'POST', headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ body: adfFromText(text) }),
    }, { retries: 1 });
    if (!r.ok) { const t = await r.text().catch(() => ''); sendJSON(res, { ok: false, error: 'HTTP ' + r.status + (t ? ' — ' + t.slice(0, 200) : '') }); return; }
    const j = await r.json().catch(() => ({}));
    sendJSON(res, { ok: true, id: j.id, url: 'https://' + JIRA_HOST + '/browse/' + wo });
  } catch (e) { sendJSON(res, { ok: false, error: String((e && e.message) || e) }); }
}

// Создать MR: GitLab API требует ID/путь проекта, а Deck знает только ветку. Резолвим проект по repoHint (имени репо
// из скоупа задачи: client-unity / backend-services / staticsutils). Не удалось определить — честно отдаём ошибку
// (пользователь создаст MR в GitLab вручную), НЕ угадываем вслепую.
async function glFindProject(repoHint) {
  const list = await glJson('/api/v4/projects?search=' + encodeURIComponent(repoHint) + '&membership=true&per_page=20&order_by=last_activity_at');
  if (!Array.isArray(list) || !list.length) return null;
  const hint = repoHint.toLowerCase();
  return list.find((p) => String(p.path || '').toLowerCase() === hint || String(p.name || '').toLowerCase() === hint) || list[0];
}
export async function apiCreateMr(req, res) {
  let body = {}; try { body = await readJsonBody(req, 64 * 1024); } catch {}
  const source = String(body.sourceBranch || '').trim(), target = String(body.targetBranch || 'preprod').trim(), title = String(body.title || '').trim(), repoHint = String(body.repoHint || '').trim();
  if (!GL_TOKEN || !GL_HOST) { sendJSON(res, { ok: false, error: 'GitLab не настроен (host/token)' }); return; }
  if (!source) { sendJSON(res, { ok: false, error: 'нет исходной ветки' }); return; }
  if (!repoHint) { sendJSON(res, { ok: false, error: 'не задан репозиторий (repoHint)' }); return; }
  try {
    const project = await glFindProject(repoHint);
    if (!project) { sendJSON(res, { ok: false, error: 'проект GitLab по «' + repoHint + '» не найден — создайте MR вручную' }); return; }
    const r = await fetchRetry(GL_HOST + '/api/v4/projects/' + encodeURIComponent(project.id) + '/merge_requests', {
      method: 'POST', headers: { 'PRIVATE-TOKEN': GL_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ source_branch: source, target_branch: target, title: title || source, remove_source_branch: false }),
    }, { retries: 1 });
    if (!r.ok) { const t = await r.text().catch(() => ''); sendJSON(res, { ok: false, error: 'HTTP ' + r.status + (t ? ' — ' + t.slice(0, 200) : '') }); return; }
    const j = await r.json();
    sendJSON(res, { ok: true, iid: j.iid, web_url: j.web_url, project: project.path_with_namespace || project.path });
  } catch (e) { sendJSON(res, { ok: false, error: String((e && e.message) || e) }); }
}

// Деплой: поставить клиентскую сборку ветки в очередь TeamCity (buildQueue). buildTypeId = один из TC_BUILD_TYPES.
export async function apiTriggerBuild(req, res) {
  let body = {}; try { body = await readJsonBody(req, 16 * 1024); } catch {}
  const buildTypeId = String(body.buildTypeId || '').trim(), branch = String(body.branch || '').trim();
  if (!TC_TOKEN || !TC_HOST) { sendJSON(res, { ok: false, error: 'TeamCity не настроен (host/token)' }); return; }
  if (!buildTypeId) { sendJSON(res, { ok: false, error: 'нет buildTypeId' }); return; }
  try {
    const payload = { buildType: { id: buildTypeId } };
    if (branch) payload.branchName = branch;
    const r = await fetchRetry(TC_HOST + '/app/rest/buildQueue', {
      method: 'POST', headers: { Authorization: 'Bearer ' + TC_TOKEN, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(payload),
    }, { retries: 1 });
    if (!r.ok) { const t = await r.text().catch(() => ''); sendJSON(res, { ok: false, error: 'HTTP ' + r.status + (t ? ' — ' + t.slice(0, 200) : '') }); return; }
    const j = await r.json().catch(() => ({}));
    sendJSON(res, { ok: true, id: j.id, webUrl: j.webUrl });
  } catch (e) { sendJSON(res, { ok: false, error: String((e && e.message) || e) }); }
}
// Клиентские build-конфиги dev-сборки — для диалога «Деплой» (совпадают с TC_BUILD_TYPES выше).
export const TC_DEV_BUILD_TYPES = TC_BUILD_TYPES;
