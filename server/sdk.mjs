// Deck — обвязка Claude Agent SDK: резолв бинаря claude, ленивый query, готовность control-транспорта,
// плюс control-request'ы аккаунт-лимитов (usage) и списка моделей (supportedModels).

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { HERE, getElectron, sendJSON } from './core.mjs';

// -------- чат: отправка запроса в сессию через Claude Agent SDK, ответ по SSE --------
// Аутентификация SDK — на существующем логине Claude Code (OAuth из ~/.claude/.credentials.json),
// БЕЗ отдельного ANTHROPIC_API_KEY (init.apiKeySource === 'none'). permissionMode:'plan' —
// read-only: модель читает/планирует, но НЕ применяет правки и не выполняет side-effect bash.
// SDK грузится лениво, чтобы отказ импорта не ронял остальные эндпоинты.
// Путь к платформенному бинарю claude, который спавнит SDK. В упакованном app он физически лежит в
// app.asar.unpacked (spawn не умеет запускать из asar), а SDK по умолчанию строит путь через app.asar →
// процесс не поднимается и любой control-request падает «ProcessTransport is not ready for writing».
// Возвращаем реальный (unpacked) путь; в standalone это тот же файл в node_modules — поведение не меняется.
function claudeExePath() {
  const plat = process.platform === 'win32' ? 'win32-x64'
    : process.platform === 'darwin' ? (process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64')
    : (process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64');
  const bin = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const p = path.join(HERE, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-' + plat, bin);
  const unpacked = p.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');   // spawn читает физический файл, не asar-виртуальный
  try { if (existsSync(unpacked)) return unpacked; } catch {}
  try { if (existsSync(p)) return p; } catch {}
  return null;
}
function isPackaged() { const e = getElectron(); return !!(e && e.app && e.app.isPackaged); }
// Путь к УСТАНОВЛЕННОМУ у пользователя claude (нативный .exe на PATH — тот же, что успешно работает в авторизации).
// В упакованном app бандл-бинарь SDK лежит в asar.unpacked и порой не спавнится → «ProcessTransport is not ready for
// writing» (падают chat/usage/mcp). Спавним рабочий CLI пользователя. Из ИСХОДНИКОВ не трогаем (бандл там ок).
let _claudeCli = undefined;
function resolveClaudeCli() {
  if (_claudeCli !== undefined) return _claudeCli;
  _claudeCli = null;
  try {
    const cmd = process.platform === 'win32' ? 'where claude' : 'command -v claude 2>/dev/null || which claude';
    const out = String(execSync(cmd, { encoding: 'utf8', windowsHide: true, timeout: 6000, shell: process.platform === 'win32' ? undefined : '/bin/sh' }) || '').trim();
    const lines = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const pick = lines.find((l) => /\.exe$/i.test(l)) || lines.find((l) => !/\.(cmd|bat|ps1)$/i.test(l)) || lines[0];
    if (pick && existsSync(pick)) _claudeCli = pick;
  } catch {}
  return _claudeCli;
}
let _sdkQuery = null;
// T1: тест-seam. apiChat вызывает getSdkQuery() → впрыснутая фейк-функция query позволяет прогнать весь event-цикл и
// canUseTool-гейтинг БЕЗ спавна реального claude (ESM-синглтон: тест и apiChat делят один _sdkQuery). Только для тестов.
export function setSdkQueryForTests(fn) { _sdkQuery = fn; }
export async function getSdkQuery() {
  if (_sdkQuery) return _sdkQuery;
  const mod = await import('@anthropic-ai/claude-agent-sdk');
  // В сборке предпочитаем установленный claude пользователя, иначе — распакованный бандл-бинарь. Из исходников — дефолт SDK.
  const exe = isPackaged() ? (resolveClaudeCli() || claudeExePath()) : null;
  _sdkQuery = exe
    ? (args) => mod.query({ ...args, options: { ...((args && args.options) || {}), pathToClaudeCodeExecutable: exe } })
    : mod.query;
  return _sdkQuery;
}
// Готовность control-транспорта: ждём SDK-инициализацию (initializationResult), а НЕ «первое сообщение стрима».
// Это надёжный сигнал, что stdin-канал к CLI открыт — и он лечит «ProcessTransport is not ready for writing» в
// упакованном app (control-запрос usage/models/mcp уходил раньше готовности транспорта). Таймаут → best-effort дальше.
export async function awaitControlReady(q, timeoutMs = 15000) {
  try { await Promise.race([q.initializationResult(), new Promise((_, rej) => setTimeout(() => rej(new Error('init timeout')), timeoutMs))]); } catch {}
}

// -------- Аккаунт-лимиты Claude (5ч / 7д) через control-request usage() SDK — тот же OAuth-логин, без инференса. --------
let _usage = { ts: 0, data: null };
const USAGE_TTL = 45000;
async function fetchUsageRaw() {
  const query = await getSdkQuery();
  const ac = new AbortController();
  async function* openInput() { await new Promise((r) => setTimeout(r, 40000)); }   // держим ввод открытым, НЕ шлём turn
  const q = query({ prompt: openInput(), options: { permissionMode: 'plan', settingSources: [], abortController: ac } });
  let streamErr = null;
  (async () => { try { for await (const _ of q) { /* дренаж стрима */ } } catch (e) { streamErr = e; } })();
  try {
    await awaitControlReady(q);
    let lastErr;
    for (let i = 0; i < 5; i++) {   // CLI холодный старт — ретраим control-request
      if (i) await new Promise((r) => setTimeout(r, 1500));
      try { return await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(); }
      catch (e) { lastErr = e; }
    }
    throw lastErr || streamErr || new Error('usage unavailable');
  } finally { try { ac.abort(); } catch {} }
}
// Список моделей — рантаймовый control-request SDK supportedModels() (реальные value/displayName + какие effort-уровни
// каждая поддерживает). Ничего не хардкодим: и модели, и набор эффортов выводим из ответа CLI. Кэш 5 мин.
async function fetchModelsRaw() {
  const query = await getSdkQuery();
  const ac = new AbortController();
  async function* openInput() { await new Promise((r) => setTimeout(r, 30000)); }
  const q = query({ prompt: openInput(), options: { permissionMode: 'plan', settingSources: [], abortController: ac } });
  let streamErr = null;
  (async () => { try { for await (const _ of q) { /* дренаж стрима */ } } catch (e) { streamErr = e; } })();
  try {
    await awaitControlReady(q);
    let lastErr;
    for (let i = 0; i < 5; i++) {
      if (i) await new Promise((r) => setTimeout(r, 1200));
      try { const m = await q.supportedModels(); if (Array.isArray(m)) return m; } catch (e) { lastErr = e; }
    }
    throw lastErr || streamErr || new Error('models unavailable');
  } finally { try { ac.abort(); } catch {} }
}
let _models = { ts: 0, data: null };
const MODELS_TTL = 5 * 60 * 1000;
export async function apiModels(res) {
  if (_models.data && Date.now() - _models.ts < MODELS_TTL) { sendJSON(res, _models.data); return; }
  const models = [{ value: '', label: 'Модель: по умолчанию' }];
  const effortSet = new Set();
  try {
    const raw = await fetchModelsRaw();
    for (const m of raw) {
      const v = String((m && m.value) || '').trim(); if (!v) continue;
      const efs = Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels : [];
      models.push({ value: v, label: String(m.displayName || v), efforts: efs });
      for (const e of efs) effortSet.add(e);
    }
  } catch {
    // проба не удалась (напр. вне Electron/без логина) — модели из additionalModelOptionsCache конфига, без хардкода
    try {
      const j = JSON.parse(readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
      for (const e of (j.additionalModelOptionsCache || [])) { const v = String((e && e.value) || '').trim(); if (v) models.push({ value: v, label: String((e && e.label) || v), efforts: [] }); }
    } catch {}
  }
  const rank = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 };
  const efforts = [{ value: '', label: 'Effort: по умолчанию' }].concat(
    [...effortSet].sort((a, b) => (rank[a] ?? 99) - (rank[b] ?? 99)).map((e) => ({ value: e, label: e.charAt(0).toUpperCase() + e.slice(1) })));
  const data = { models, efforts };
  _models = { ts: Date.now(), data };
  sendJSON(res, data);
}
function mapUsage(u) {
  if (!u || !u.rate_limits_available || !u.rate_limits) return { available: false, reason: 'аккаунт-лимиты недоступны для этого логина/сессии' };
  const rl = u.rate_limits;
  const win = (w) => (w ? { utilization: (w.utilization == null ? null : Math.round(w.utilization)), resetsAt: w.resets_at || null } : null);
  const ex = rl.extra_usage;
  const extra = ex && ex.is_enabled ? { usedCredits: ex.used_credits, monthlyLimit: ex.monthly_limit, utilization: ex.utilization, currency: ex.currency } : null;
  return { available: true, subscriptionType: u.subscription_type || null, fiveHour: win(rl.five_hour), sevenDay: win(rl.seven_day), extra };
}
export async function apiUsage(res) {
  if (_usage.data && Date.now() - _usage.ts < USAGE_TTL) { sendJSON(res, _usage.data); return; }
  try {
    const data = mapUsage(await fetchUsageRaw());
    _usage = { ts: Date.now(), data };
    sendJSON(res, data);
  } catch (e) {
    const data = { available: false, reason: (e && e.message) || String(e) };
    _usage = { ts: Date.now(), data };
    sendJSON(res, data);
  }
}
