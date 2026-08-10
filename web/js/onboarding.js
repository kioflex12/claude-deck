// Deck — приветственный экран первого запуска. Цель: НОЛЬ ручной возни с папками. Папка сессий Claude Code
// детерминирована (~/.claude/projects) и определяется сервером сама — здесь мы только показываем, что нашли, и даём
// одну кнопку «Начать». Интеграции (Jira/TeamCity/GitLab) подтягиваются сервером на первом старте (autoImportOnFirstRun),
// тут они — необязательный блок «можно позже». Никаких обязательных полей/пикеров в типичном случае.

import { S } from './store.js';
import { esc } from './util.js';
import { toast } from './ui.js';
import { openSettingsModal } from './dialogs.js';

const DONE_KEY = 'deckOnboarded';

// Показать приветствие, если пользователь его ещё не проходил. Зовётся из app.load ПОСЛЕ загрузки списка сессий
// (не в pane-режиме). Идемпотентно.
export async function maybeShowOnboarding(){
  try { if (localStorage.getItem(DONE_KEY) === '1') return; } catch {}
  let cfg = {}; try { cfg = await (await fetch('/api/config', { cache:'no-store' })).json(); } catch {}
  render(cfg);
}

function integrations(cfg){
  const on = [];
  if (cfg && cfg.jira && (cfg.jira.tokenSet || cfg.jira.enabled)) on.push('Jira');
  if (cfg && cfg.teamcity && cfg.teamcity.tokenSet) on.push('TeamCity');
  if (cfg && cfg.gitlab && cfg.gitlab.tokenSet) on.push('GitLab');
  return on;
}

function render(cfg){
  let back = document.getElementById('onbBack');
  if (!back){ back = document.createElement('div'); back.id = 'onbBack'; back.className = 'onb-back'; document.body.appendChild(back); }
  const count = (S.SESSIONS || []).length;
  const folder = (cfg && cfg.claudeProjectsDir) || (cfg && cfg.defaults && cfg.defaults.claudeProjectsDir) || '~/.claude/projects';
  const hasNative = !!(window.deckNative && window.deckNative.pickPath);
  const on = integrations(cfg);

  const sessionsBlock = count > 0
    ? `<div class="onb-row ok"><span class="onb-ic">✓</span><div><div class="onb-rt">Нашли ваши сессии Claude Code — ${count}</div><div class="onb-rs">Папка определена автоматически: <code>${esc(folder)}</code></div></div></div>`
    : `<div class="onb-row warn"><span class="onb-ic">•</span><div><div class="onb-rt">Пока не видим сессий Claude Code</div><div class="onb-rs">Deck смотрит в <code>${esc(folder)}</code>. Запустите Claude Code хотя бы раз — сессии появятся здесь сами. Если они в другой папке — можно указать её.</div>${hasNative?`<button class="onb-link" id="onbPick" type="button">Указать папку сессий…</button>`:''}</div></div>`;

  const intBlock = on.length
    ? `<div class="onb-row ok"><span class="onb-ic">✓</span><div><div class="onb-rt">Интеграции подключены: ${on.join(', ')}</div><div class="onb-rs">Токены подтянулись автоматически. Остальное — в настройках, когда понадобится.</div></div></div>`
    : `<div class="onb-row"><span class="onb-ic">＋</span><div><div class="onb-rt">Интеграции — можно подключить позже</div><div class="onb-rs">Jira, TeamCity, GitLab. Не обязательны для работы. Попробуем найти токены автоматически или подключишь вручную в настройках.</div><button class="onb-link" id="onbPull" type="button">Подтянуть автоматически</button></div></div>`;

  back.innerHTML = `<div class="onb-card">
    <div class="onb-head"><div class="onb-logo">D</div><div><div class="onb-title">Добро пожаловать в Deck</div><div class="onb-sub">Доска ваших сессий Claude Code. Настраивать ничего не нужно — всё уже определилось.</div></div></div>
    <div class="onb-body">${sessionsBlock}${intBlock}</div>
    <div class="onb-actions"><button class="onb-more" id="onbSettings" type="button">Открыть настройки</button><button class="onb-start" id="onbStart" type="button">Начать работу</button></div>
  </div>`;
  back.classList.add('open');

  const done = () => { try { localStorage.setItem(DONE_KEY, '1'); } catch {}; back.classList.remove('open'); };
  back.querySelector('#onbStart').addEventListener('click', done);
  back.querySelector('#onbSettings').addEventListener('click', () => { done(); openSettingsModal(); });
  const pull = back.querySelector('#onbPull');
  if (pull) pull.addEventListener('click', async () => {
    pull.disabled = true; pull.textContent = 'Ищу токены…';
    try {
      await fetch('/api/config/import-tokens', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
      const c2 = await (await fetch('/api/config', { cache:'no-store' })).json();
      render(c2);   // перерисовать с обновлённым статусом интеграций
    } catch { pull.disabled = false; pull.textContent = 'Подтянуть автоматически'; toast('Не удалось подтянуть токены'); }
  });
  const pick = back.querySelector('#onbPick');
  if (pick) pick.addEventListener('click', async () => {
    let r; try { r = await window.deckNative.pickPath({ title:'Папка сессий Claude (обычно ~/.claude/projects)' }); } catch { return; }
    if (!r || !r.path) return;
    try {
      await fetch('/api/config', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ claudeProjectsDir: r.path }) });
      toast('Папка сохранена — перезагрузите окно, чтобы подхватить сессии');
    } catch { toast('Не удалось сохранить папку'); }
  });
}
