// Deck — аккаунт-лимиты Claude: индикатор в баре, окно usage и резолв «текущего контекста» (для .now-лейбла).
// Вынесено из app.js; состояние — в store (S). openUsageModal строит модалку через modalBack (app.js),
// contextSession опирается на isWorking (board.js); цикл app↔usage безопасен (вызовы в рантайме).
import { S, SESSION_CACHE } from './store.js';
import { esc, kTok } from './util.js';
import { modalBack } from './app.js';
import { isWorking } from './board.js';

export async function loadUsage(){
  try { const r = await fetch('/api/usage', { cache:'no-store' }); S.USAGE = await r.json(); }
  catch { S.USAGE = { available:false, reason:'сеть' }; }
  renderUsageBar();
}
function usageBarPct(){
  if (S.USAGE && S.USAGE.available){          // более узкое из 5ч/нед = более израсходованное
    const a = S.USAGE.fiveHour && S.USAGE.fiveHour.utilization!=null ? S.USAGE.fiveHour.utilization : 0;
    const b = S.USAGE.sevenDay && S.USAGE.sevenDay.utilization!=null ? S.USAGE.sevenDay.utilization : 0;
    return { pct: Math.max(a,b), src:'limits' };
  }
  const s = contextSession();             // фолбэк: контекст открытой/свежей сессии
  return { pct: s ? Math.round((s.ctxPct||0)*100) : 0, src:'context' };
}
export function renderUsageBar(){
  const fill = document.getElementById('usageBarFill'), lbl = document.getElementById('usagePct'), ind = document.getElementById('usageInd');
  if (!fill || !lbl) return;
  const { pct, src } = usageBarPct();
  fill.style.width = Math.min(pct,100) + '%';
  fill.style.background = pct>=80?'var(--bad)':pct>=50?'var(--warn)':'var(--good)';
  lbl.textContent = pct + '%';
  if (ind) ind.title = src==='limits' ? 'Лимиты Claude (5ч/нед) — клик для деталей' : 'Контекст сессии (лимиты недоступны) — клик для деталей';
}
function fmtReset(iso){
  if (!iso) return '—';
  const d = new Date(iso); if (isNaN(+d)) return '—';
  const mins = Math.round((d - Date.now())/60000);
  if (mins <= 0) return 'скоро';
  if (mins < 60) return 'через ' + mins + ' мин';
  const h = Math.round(mins/60); if (h < 48) return 'через ' + h + ' ч';
  return d.toLocaleString('ru-RU', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' });
}
export function openUsageModal(){
  const back = modalBack('usageBack');
  const u = S.USAGE || {};
  const win = (w, title) => {
    if (!w) return `<div class="um-row"><span class="um-k">${title}</span><span class="um-v">—</span></div>`;
    const p = w.utilization==null?0:w.utilization;
    return `<div class="um-win"><div class="um-row"><span class="um-k">${title}</span><span class="um-v">${p}% · сброс ${esc(fmtReset(w.resetsAt))}</span></div><div class="um-bar"><i style="width:${Math.min(p,100)}%;background:${p>=80?'var(--bad)':p>=50?'var(--warn)':'var(--good)'}"></i></div></div>`;
  };
  let body;
  if (u.available){
    const extra = u.extra ? `<div class="um-row"><span class="um-k">Доп. кредиты</span><span class="um-v">${esc(String(u.extra.usedCredits))}/${esc(String(u.extra.monthlyLimit))} ${esc(u.extra.currency||'')} · ${Math.round(u.extra.utilization||0)}%</span></div>` : '';
    body = `${win(u.fiveHour,'5-часовое окно')}${win(u.sevenDay,'Недельное окно')}${extra}<div class="um-note">Подписка: ${esc(u.subscriptionType||'—')} · источник: Claude usage (тот же логин)</div>`;
  } else {
    const top = [...S.SESSIONS].sort((a,b)=>(b.winTokens||0)-(a.winTokens||0)).slice(0,8);
    const rows = top.map(s=>`<div class="um-row"><span class="um-k um-ell">${esc(s.title||s.project||'—')}</span><span class="um-v">${kTok(s.winTokens)} · ${Math.round((s.ctxPct||0)*100)}%</span></div>`).join('');
    body = `<div class="um-warn">Аккаунт-лимиты недоступны из Deck: ${esc(u.reason||'нет данных')}</div><div class="um-sub">Контекст открытых сессий (то, что доступно):</div>${rows||'<div class="um-note">нет сессий</div>'}`;
  }
  back.innerHTML = `<div class="deck-modal"><div class="dm-head"><span>Использование и лимиты</span><button class="dm-x" type="button">✕</button></div><div class="dm-body">${body}</div></div>`;
  back.querySelector('.dm-x').addEventListener('click', ()=>back.classList.remove('open'));
  back.classList.add('open');
}
export function contextSession(){
  if (S.currentFile) return SESSION_CACHE[S.currentFile] || S.SESSIONS.find(s=>s.file===S.currentFile) || null;
  return S.SESSIONS.find(isWorking) || S.SESSIONS.find(s=>s.active) || S.SESSIONS[0] || null;
}
