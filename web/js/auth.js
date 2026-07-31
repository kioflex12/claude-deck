// Deck — авторизация в Claude (чип/гейт, вход по коду, выход) и плашка неавторизованных интеграций (Jira/TeamCity/GitLab).
// Вынесено из app.js; состояние — в store (S).
import { S } from './store.js';
import { esc } from './util.js';
import { toast, openExternal } from './ui.js';
import { renderProjSwitch } from './projects.js';
import { modalBack } from './dialogs.js';

export async function loadAuth(){
  try { S.AUTH = await (await fetch('/api/auth', { cache:'no-store' })).json(); } catch { S.AUTH = { loggedIn:false, reason:'сеть' }; }
  renderAuth();
}
export function renderAuth(){
  const chip = document.getElementById('authChip'), gate = document.getElementById('authGate');
  if (chip){
    chip.classList.toggle('in', !!S.AUTH.loggedIn);
    chip.textContent = S.AUTH.loggedIn ? (S.AUTH.email || 'Claude ✓') : 'Войти в Claude';
    chip.title = S.AUTH.loggedIn ? ('Claude: ' + (S.AUTH.email||'') + (S.AUTH.orgName?(' · '+S.AUTH.orgName):'') + ' — клик для выхода') : 'Войти в Claude';
  }
  if (gate) gate.hidden = !!S.AUTH.loggedIn;
}

export async function loadServicesGate(){
  try { S.SVC_CFG = await (await fetch('/api/config', { cache:'no-store' })).json(); } catch { S.SVC_CFG = null; }
  renderServicesGate();
}
export function renderServicesGate(cfg){
  if (cfg) S.SVC_CFG = cfg;
  if (S.SVC_CFG && S.SVC_CFG.jira) S.JIRA_HOST_CFG = S.SVC_CFG.jira.host || '';   // хост Jira для ссылок берём из конфига
  if (S.SVC_CFG){ S.PROJECTS = Array.isArray(S.SVC_CFG.projects) ? S.SVC_CFG.projects : []; S.ACTIVE_PROJECT = S.SVC_CFG.activeProjectId || ''; renderProjSwitch(); }   // проекты в переключатель
  const gate = document.getElementById('svcGate'), msg = document.getElementById('svcGateMsg');
  if (!gate || !msg) return;
  const c = S.SVC_CFG || {};
  const missing = [];
  if (!(c.jira && c.jira.enabled)) missing.push('Jira');
  if (!(c.teamcity && c.teamcity.tokenSet && c.teamcity.host)) missing.push('TeamCity');
  if (!(c.gitlab && c.gitlab.tokenSet && c.gitlab.host)) missing.push('GitLab');
  if (!missing.length) { gate.hidden = true; return; }
  msg.textContent = 'Не авторизованы сервисы: ' + missing.join(', ') + ' — доска не получит статусы задач, сборки и MR. Подтяните токены или заполните настройки.';
  gate.hidden = false;
}

export function requireAuth(){   // гейт для chat/usage/новой сессии
  if (S.AUTH.loggedIn) return true;
  toast('Войдите в Claude — действие недоступно без авторизации');
  startLogin();
  return false;
}
export function onAuthChip(){ if (S.AUTH.loggedIn) confirmLogout(); else startLogin(); }
async function confirmLogout(){
  const back = modalBack('logoutBack');
  back.innerHTML = `<div class="deck-modal"><div class="dm-head"><span>Выйти из Claude?</span><button class="dm-x" type="button">✕</button></div>
    <div class="dm-body"><div class="dm-text">${esc(S.AUTH.email||'')}</div><div class="um-note">После выхода чат/лимиты/новые сессии станут недоступны, пока не войдёте снова.</div>
    <div class="ns-actions"><button class="btn-ghost dm-cancel" type="button">Отмена</button><button class="ns-start dm-danger" type="button">Выйти</button></div></div></div>`;
  back.querySelector('.dm-x').addEventListener('click', ()=>back.classList.remove('open'));
  back.querySelector('.dm-cancel').addEventListener('click', ()=>back.classList.remove('open'));
  back.querySelector('.dm-danger').addEventListener('click', async ()=>{ back.classList.remove('open'); try { await fetch('/api/auth/logout', { method:'POST' }); } catch {} await loadAuth(); toast('Вы вышли из Claude'); });
  back.classList.add('open');
}
export async function startLogin(){
  if (S.loginInProgress) return;   // логин уже идёт — не плодим второй процесс/окно браузера
  S.loginInProgress = true;
  const back = modalBack('loginBack');
  back.innerHTML = `<div class="deck-modal"><div class="dm-head"><span>Вход в Claude</span><button class="dm-x" type="button">✕</button></div>
    <div class="dm-body">
      <div class="um-note" id="loginStep">Открываю браузер для входа в Claude…</div>
      <a class="btn-ghost" id="loginOpen" href="#" style="display:none;margin:8px 0">Открыть страницу входа вручную</a>
      <label class="ns-lbl">Код авторизации (со страницы Claude)</label>
      <input id="loginCode" class="ns-inp" type="text" placeholder="вставь код и нажми Подтвердить" autocomplete="off">
      <div class="ns-actions"><button class="btn-ghost dm-cancel" type="button">Отмена</button><button class="ns-start" id="loginSubmit" type="button" disabled>Подтвердить</button></div>
    </div></div>`;
  const close = ()=>{ back.classList.remove('open'); S.loginInProgress = false; if (loginId) fetch('/api/auth/cancel?id='+encodeURIComponent(loginId)).catch(()=>{}); };
  back.querySelector('.dm-x').addEventListener('click', close);
  back.querySelector('.dm-cancel').addEventListener('click', close);
  back.classList.add('open');
  let loginId = null;
  try {
    const d = await (await fetch('/api/auth/login', { method:'POST' })).json();
    loginId = d.loginId;
    if (d.url){
      // Браузер открывает сам Claude CLI — Deck НЕ открывает URL повторно (иначе два окна). Ссылка ниже — ручной фолбэк.
      const link = back.querySelector('#loginOpen'); link.href = d.url; link.style.display = 'inline-flex';
      link.addEventListener('click', (e)=>{ e.preventDefault(); openExternal(d.url); });
      back.querySelector('#loginStep').textContent = 'Браузер открыт — подтверди доступ в Claude и вставь показанный код ниже. Если браузер не открылся — нажми ссылку.';
    } else {
      back.querySelector('#loginStep').textContent = 'Не удалось получить ссылку входа. Проверь, что установлен Claude CLI.';
    }
  } catch { back.querySelector('#loginStep').textContent = 'Ошибка запуска входа.'; }
  // Ловим успех по ЛЮБОМУ пути (в т.ч. когда браузер авторизовал сам, без кода): поллим /api/auth ~каждые 2с.
  const started = Date.now();
  const pollAuth = async () => {
    if (!S.loginInProgress || !back.classList.contains('open')) return;   // модалку закрыли/отменили — стоп
    await loadAuth();                                                    // обновляет S.AUTH + renderAuth: чип зелёный, красная плашка #authGate гаснет
    if (S.AUTH.loggedIn){ back.classList.remove('open'); S.loginInProgress = false; toast('Вход выполнен: ' + (S.AUTH.email || '')); return; }
    if (Date.now() - started > 180000) return;                          // таймаут ~3мин
    setTimeout(pollAuth, 2000);
  };
  if (loginId) setTimeout(pollAuth, 2000);
  const codeInp = back.querySelector('#loginCode'), submit = back.querySelector('#loginSubmit');
  codeInp.addEventListener('input', ()=>{ submit.disabled = !codeInp.value.trim() || !loginId; });
  submit.addEventListener('click', async ()=>{
    submit.disabled = true; submit.textContent = 'Проверяю…';
    try {
      const r = await (await fetch('/api/auth/code', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ loginId, code: codeInp.value.trim() }) })).json();
      if (r.ok){ back.classList.remove('open'); S.loginInProgress = false; await loadAuth(); toast('Вход выполнен: ' + (S.AUTH.email||'')); }
      else { back.querySelector('#loginStep').textContent = 'Код не принят — попробуй ещё раз.'; submit.disabled = false; submit.textContent = 'Подтвердить'; }
    } catch { submit.disabled = false; submit.textContent = 'Подтвердить'; }
  });
}
