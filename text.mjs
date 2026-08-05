// Deck — чистые парс-хелперы по сырому тексту транскрипта: экстракторы строк jsonl, выбор рабочей/базовой ветки,
// сводки tool_use/tool_result, классификация user-блоков и разбор транскрипта в ленту блоков.

import { SYSREM, BASE_BRANCHES, CTX_LIMIT, oneLine, cap } from './core.mjs';

// -------- per-line-JSON экстракторы значений полей транскрипта (D5) --------
// Раньше — глобальный regex по всему тексту; он совпадал с ключом, процитированным ВНУТРИ строкового/структурного
// tool_result (напр. когда сессия читает чужой .jsonl), и путал aiTitle/lastPrompt/model/gitBranch/cwd. cwd особенно
// критичен: питает git-dirty и base для /api/file. Разбираем построчно и читаем РЕАЛЬНОЕ поле объекта (top-level либо
// message.<key> — так покрываем и model, который лежит в message.model), а не подстроку внутри значения.
function lineFieldValue(ev, key) {
  if (!ev || typeof ev !== 'object') return undefined;
  if (typeof ev[key] === 'string') return ev[key];
  if (ev.message && typeof ev.message === 'object' && typeof ev.message[key] === 'string') return ev.message[key];
  return undefined;
}
export function firstString(text, key) {
  const needle = '"' + key + '"';
  for (const line of String(text).split('\n')) {
    if (line.indexOf(needle) < 0) continue;   // дешёвый пре-фильтр перед JSON.parse
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    const v = lineFieldValue(ev, key);
    if (v != null) return v;
  }
  return null;
}
export function lastString(text, key) {
  const needle = '"' + key + '"';
  let last = null;
  for (const line of String(text).split('\n')) {
    if (line.indexOf(needle) < 0) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    const v = lineFieldValue(ev, key);
    if (v != null) last = v;
  }
  return last;
}
export function allStrings(text, key) {
  const needle = '"' + key + '"';
  const out = [];
  for (const line of String(text).split('\n')) {
    if (line.indexOf(needle) < 0) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    const v = lineFieldValue(ev, key);
    if (v != null) out.push(v);
  }
  return out;
}
// Рабочая ветка сессии: в файле gitBranch часто скачет (старт/после cleanup — базовая preprod/preupdate).
// Берём НЕ-базовую, предпочитая WO-ветку; если несколько не-базовых — последнюю; если только базовые — последнюю.
export function isBaseBranch(b) { return BASE_BRANCHES.has(String(b || '').trim().toLowerCase()); }
export function pickWorkingBranch(branches) {
  const uniq = [];
  for (const b of branches) { if (b && !uniq.includes(b)) uniq.push(b); }
  if (!uniq.length) return '';
  const nonBase = uniq.filter((b) => !BASE_BRANCHES.has(String(b).toLowerCase()));
  const wo = nonBase.filter((b) => /WO-\d+/.test(b));
  if (wo.length) return wo[wo.length - 1];
  if (nonBase.length) return nonBase[nonBase.length - 1];
  return uniq[uniq.length - 1];
}
// Базовая ветка (источник форка рабочей ветки) = первая базовая из истории gitBranch сессии; иначе '' (фолбэк на targetEnv у вызывающего).
export function pickBaseBranch(branches) {
  const empty = new Set(['', 'head']);
  for (const b of branches) { const s = String(b || '').trim(); if (s && !empty.has(s.toLowerCase()) && isBaseBranch(s)) return s; }
  return '';
}
// Первичный WO из первого человеческого промпта: у сессии-уборки ветка = preprod, WO нет в ветке/заголовке,
// но он есть в первом user-сообщении (напр. ссылка .../browse/WO-13914). Сканируем первые ~5 человеческих реплик.
export function firstUserWo(text) {
  let idx = 0, seen = 0;
  while (idx < text.length && seen < 5) {
    const nl = text.indexOf('\n', idx);
    const line = nl === -1 ? text.slice(idx) : text.slice(idx, nl);
    idx = nl === -1 ? text.length : nl + 1;
    if (!line.includes('"type":"user"')) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type !== 'user') continue;
    const c = ev.message && ev.message.content;
    let s = '';
    if (typeof c === 'string') s = c;
    else if (Array.isArray(c)) s = c.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join(' ');
    s = s.replace(SYSREM, '').trim();
    if (!s) continue;                 // пропускаем user-события с одними tool_result
    seen++;
    const m = s.match(/WO-\d+/);
    if (m) return m[0];
  }
  return '';
}
export function lastUsageWindow(text) {
  const i = text.lastIndexOf('"usage":');
  if (i < 0) return 0;
  const seg = text.slice(i, i + 500);
  const num = (k) => { const m = seg.match(new RegExp('"' + k + '":(\\d+)')); return m ? +m[1] : 0; };
  return num('input_tokens') + num('cache_read_input_tokens') + num('cache_creation_input_tokens');
}
export function countMessages(text) {
  return (text.match(/"type":"user"/g) || []).length + (text.match(/"type":"assistant"/g) || []).length;
}
export function prettyModel(m) {
  if (!m || /^<.*>$/.test(m)) return '—';   // '<synthetic>' и прочие служебные псевдо-модели → «—», не показываем сырьём
  const x = m.match(/(opus|sonnet|haiku)-(\d+)-(\d+)/i);
  if (x) return x[1][0].toUpperCase() + x[1].slice(1).toLowerCase() + ' ' + x[2] + '.' + x[3];
  return m.replace(/^claude-/, '');
}
// Последняя РЕАЛЬНАЯ модель: Claude Code метит служебные авто-сообщения ассистента "model":"<synthetic>" —
// берём последнее значение model, не обёрнутое в <...> (иначе на чип попадает <synthetic>).
export function lastRealModel(text) {
  const all = allStrings(text, 'model');
  for (let i = all.length - 1; i >= 0; i--) { const m = all[i]; if (m && !/^<.*>$/.test(m)) return m; }
  return '';
}
export const woOf = (s) => { const m = String(s || '').match(/WO-\d+/); return m ? m[0] : ''; };

export function columnByAge(mtimeMs) {
  const age = Date.now() - mtimeMs;
  if (age < 24 * 3600 * 1000) return 'today';
  if (age < 7 * 24 * 3600 * 1000) return 'week';
  return 'older';
}

// -------- сводки tool_use/tool_result и разбор транскрипта в ленту блоков --------

const RESULT_CAP = 4000;   // tool-результат: почти полный (в UI свёрнут, разворот по клику)

export function briefArg(input) {
  if (!input || typeof input !== 'object') return '';
  const keys = ['file_path', 'path', 'notebook_path', 'pattern', 'query', 'command', 'url', 'skill', 'subagent_type', 'description', 'prompt', 'glob', 'old_string'];
  for (const k of keys) {
    if (input[k] != null) { const v = typeof input[k] === 'string' ? input[k] : JSON.stringify(input[k]); return oneLine(v, 64); }
  }
  for (const k of Object.keys(input)) { if (typeof input[k] === 'string') return oneLine(input[k], 64); }
  return '';
}
// Референс-стиль ленты: у инструмента показываем ОПИСАНИЕ (subtitle) + IN(команда/цель). toolDesc — человекочитаемое
// описание (у Bash есть input.description); toolCmd — основная команда/цель (полнее briefArg: до CMD_CAP, с переносами
// для многострочных команд), контент-тяжёлые поля (Write.content) не тянем.
export function toolDesc(input) {
  return (input && typeof input.description === 'string' && input.description.trim()) ? oneLine(input.description, 140) : '';
}
const CMD_CAP = 1600;
export function toolCmd(input) {
  if (!input || typeof input !== 'object') return '';
  for (const k of ['command', 'file_path', 'path', 'notebook_path', 'pattern', 'query', 'url', 'glob', 'skill', 'subagent_type', 'prompt']) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) return v.length > CMD_CAP ? v.slice(0, CMD_CAP) + '\n…' : v;
  }
  try { const s = JSON.stringify(input); return s.length > CMD_CAP ? s.slice(0, CMD_CAP) + '…' : s; } catch { return ''; }
}
// Почти полный текст tool-результата (в UI свёрнут, разворачивается по клику; переносы строк сохраняем).
export function briefResult(content) {
  let s = '';
  if (typeof content === 'string') s = content;
  else if (Array.isArray(content)) {
    const parts = [];
    for (const b of content) {
      if (!b) continue;
      if (typeof b === 'string') parts.push(b);
      else if (b.type === 'text' && b.text) parts.push(b.text);
      else if (b.type === 'tool_reference' && b.tool_name) parts.push('→ ' + b.tool_name);
      else if (b.type === 'image') parts.push('[image]');
    }
    s = parts.join('\n');
  } else if (content != null) s = String(content);
  s = s.trim();
  return s.length > RESULT_CAP ? s.slice(0, RESULT_CAP) + '\n…' : s;
}

// Разбор транскрипта в ЛЕНТУ отдельных блоков. Каждый content-элемент каждой user/assistant-строки
// jsonl = свой блок (kind: user | assistant | thinking | tool) — ничего не склеиваем. Токены хода
// (message.usage) вешаются метой на последний текст/thinking-блок сообщения.
// Классификация user-текста по происхождению: не всякая user-строка jsonl — человек. Служебные инжекты
// (загрузка скиллов помечены ev.isMeta — фильтруется выше), task-notification, вызовы команд, interrupt,
// Caveat/local-command-stdout — это шум, который нельзя рисовать как «Ты».
export function classifyUserBlock(rawText) {
  const t = String(rawText || '').replace(SYSREM, '').trim();
  if (!t) return null;
  if (t.startsWith('Caveat:') || t.includes('<local-command-stdout>')) return null;   // чистый шум — пропускаем
  if (t.includes('<task-notification>')) return { kind: 'system', text: '⚙ фоновая задача' };
  if (t.startsWith('[Request interrupted')) return { kind: 'system', text: '⛔ прервано пользователем' };
  const cmd = t.match(/<command-name>([\s\S]*?)<\/command-name>/);
  if (cmd) { const name = cmd[1].trim().replace(/^\//, ''); return { kind: 'command', text: '/' + name }; }
  return { kind: 'user', text: cap(t) };
}
export function buildSessionBlocks(text) {
  const blocks = [];
  const toolById = {};
  let model = '', cwd = '', winTokens = 0, msgCount = 0, lastUserTs = 0, maxTurnsTs = 0;
  const branches = [];
  const tsMs = (s) => { const n = Date.parse(s || ''); return isNaN(n) ? 0 : n; };
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    // Терминальный маркер на диске: CLI пишет attachment.type=max_turns_reached при упоре в лимит ходов (в т.ч. для
    // сессий, запущенных не через Deck) — фиксируем время последнего, чтобы показать причину финиша при перезаходе (R5).
    if (ev.type === 'attachment' && ev.attachment && ev.attachment.type === 'max_turns_reached') { maxTurnsTs = tsMs(ev.timestamp) || maxTurnsTs; continue; }
    if (ev.type !== 'user' && ev.type !== 'assistant') continue;
    const msg = ev.message || {};
    if (!cwd && ev.cwd) cwd = ev.cwd;
    if (ev.gitBranch) branches.push(ev.gitBranch);
    msgCount++;
    const role = ev.type === 'assistant' ? 'assistant' : 'user';
    // Служебная вставка (загрузка скилла / ре-инвок) — не человек, блок не создаём.
    if (role === 'user' && ev.isMeta === true) continue;
    if (role === 'assistant' && msg.model && !/^<.*>$/.test(msg.model)) model = msg.model;   // игнорим <synthetic> — иначе модель сессии слетает на служебную
    const start = blocks.length;
    const content = msg.content;
    if (typeof content === 'string') {
      if (role === 'user') { const c = classifyUserBlock(content); if (c) blocks.push(c); }
      else { const t = content.replace(SYSREM, '').trim(); if (t) blocks.push({ kind: role, text: cap(t) }); }
    } else if (Array.isArray(content)) {
      for (const b of content) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text' && b.text && b.text.trim()) {
          if (role === 'user') { const c = classifyUserBlock(b.text); if (c) blocks.push(c); }
          else blocks.push({ kind: role, text: cap(b.text.trim()) });
        }
        else if (b.type === 'thinking' && b.thinking && b.thinking.trim()) blocks.push({ kind: 'thinking', text: cap(b.thinking.trim()) });
        else if (b.type === 'tool_use') { const blk = { kind: 'tool', name: b.name || 'tool', arg: briefArg(b.input), desc: toolDesc(b.input), cmd: toolCmd(b.input), result: '' }; if (b.id) toolById[b.id] = blk; blocks.push(blk); }
        else if (b.type === 'tool_result') { const blk = b.tool_use_id && toolById[b.tool_use_id]; if (blk) blk.result = briefResult(b.content); }
        else if (b.type === 'image' && b.source) {   // вложения-скриншоты: рисуем (раньше прятали → после перезахода пропадали)
          const src = b.source;
          if (src.type === 'base64' && src.data && src.data.length < 3000000) blocks.push({ kind: 'image', media: src.media_type || 'image/png', data: src.data });
          else if (src.type === 'url' && src.url) blocks.push({ kind: 'image', url: src.url });
          else blocks.push({ kind: 'system', text: '🖼 изображение (слишком большое для показа)' });
        }
      }
    }
    if (role === 'user' && blocks.length > start) lastUserTs = tsMs(ev.timestamp);   // старт текущего хода = время последнего человеческого промпта
    if (role === 'assistant' && msg.usage) {
      const u = msg.usage;
      const tin = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      const tout = u.output_tokens || 0;
      winTokens = tin;
      for (let k = blocks.length - 1; k >= start; k--) {
        if (blocks[k].kind === 'assistant' || blocks[k].kind === 'thinking') { blocks[k].meta = { in: tin, out: tout, ctxPct: Math.min(tin / CTX_LIMIT, 1) }; break; }
      }
    }
  }
  return { blocks, model, cwd, branches, winTokens, msgCount, lastUserTs, maxTurnsTs };
}
