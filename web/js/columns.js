// Deck — чистая доска-логика (без DOM). Кэши Jira/MR и working приходят аргументами. D4c: вынесено из index.html.
export const WF_COLUMNS = [
  { key:'todo',       title:'Ждёт',             dot:'var(--text-faint)' },
  { key:'active',     title:'В работе',         dot:'var(--accent)' },
  { key:'blocked',    title:'Заблокировано',    dot:'var(--bad)' },
  { key:'build',      title:'Build In Progress', dot:'var(--warn)' },
  { key:'qa',         title:'На QA',            dot:'var(--info)' },
  { key:'done',       title:'Готово',           dot:'var(--good)' },
];
// readymerge оставлен как СТАДИЯ dev-workflow (метка в рейле), но отдельной КОЛОНКИ на доске больше нет — бесполезна.
export const WF_LABEL = { blocked:'Заблокировано', todo:'Ждёт', active:'В работе', build:'Build In Progress', qa:'На QA', readymerge:'Ждёт мерджа', done:'Готово' };
// ключ MR-кэша — пара (ветка, wo), зеркало серверного _mrCache: базовую ветку (preprod) делят десятки задач, ключ по одной ветке склеивал бы их MR в одну запись
export const mrKey = (s) => ((s && s.gitBranch) || '') + '|' + ((s && s.wo) || '');
// Статус задачи Jira → колонка доски. Build In Progress здесь НЕ выдаём — это живой TeamCity-сигнал, решается в
// effectiveColumn до Jira. Ready-to-merge/ревью/QA — единая колонка «На QA» (колонки «Ждёт мерджа» больше нет).
export function jiraColumn(status, category){
  const n = String(status||'').toLowerCase();
  if (/block|блок/.test(n)) return { col:null, blocked:true };            // blocked — только бейдж, колонка отдельная
  if (/done|release|closed|resolved|готово|релиз|закрыт/.test(n) || category==='done') return { col:'done', blocked:false };
  if (/in\s*review|ready\s*(to|for)?\s*qa|in\s*qa|producer\s*review|testing|review|провер|ревью|тестир|на\s*qa|ready\s*(to|for)?\s*merge|к\s*мерж|готов.*мерж/.test(n)) return { col:'qa', blocked:false };
  if (/in\s*progress|in\s*dev|development|doing|в\s*работе|в\s*процесс|разработ/.test(n)) return { col:'active', blocked:false };
  if (/to\s*do|backlog|open|new|selected|to\s*be|ждёт|бэклог|открыт|новая/.test(n) || category==='new') return { col:'todo', blocked:false };
  if (category==='indeterminate') return { col:'active', blocked:false };
  return { col:null, blocked:false };   // неизвестный статус → колонка из локального dev-workflow-состояния
}
export function jiraSubLabel(status){
  const n = String(status||'').toLowerCase();
  if (/producer\s*review|продюсер/.test(n)) return 'Проверка продюсером';
  if (/in\s*review|ревью|на\s*ревью/.test(n)) return 'Ревью';
  return '';   // In QA / Ready To QA / testing и т.п. — то же, что колонка «На QA» → без дубля
}
// Колонка = статус задачи в Jira (source of truth). ЕДИНСТВЕННОЕ исключение — Build In Progress: живой билд TeamCity
// (собирается ИЛИ в очереди) важнее любого Jira-статуса. Нет данных Jira → фолбэк на стадию dev-workflow (или свежесть).
export function effectiveColumn(s, jiraCache){
  const j = s.wo ? jiraCache[s.wo] : null;
  let jiraCol = null, jiraBlocked = false;
  if (j && j.available && j.status){
    const m = jiraColumn(j.status, j.category);
    if (m.blocked) jiraBlocked = true; else if (m.col) jiraCol = m.col;    // Jira ведёт: To Do/In Progress/On QA/Done
  }
  // C7: терминальные/блокирующие состояния приоритетнее живого билда — иначе re-deploy маскировал бы Done/Blocked
  // (карточка прыгала в «Build In Progress», хотя задача закрыта или заблокирована).
  if (jiraBlocked) return { col:'blocked', blocked:true };
  if (jiraCol === 'done') return { col:'done', blocked:false };
  if (s.buildActive === true) return { col:'build', blocked:false };       // живой билд (running/queued) — если не заблокировано и не Done
  if (jiraCol) return { col: jiraCol, blocked:false };
  let wfCol = s.wfColumn || (s.active ? 'active' : 'todo');                // Jira недоступна → стадия dev-workflow
  if (wfCol === 'build' || wfCol === 'readymerge') wfCol = 'qa';           // билд-стадия без живого билда / ex-«ждёт мерджа» → На QA
  return { col: wfCol, blocked:false };
}
// Статус-бар: НЕ дублирует колонку. Русский под-стадийный текст сверх колонки (или полный ярлык в «Доске»).
export function cardStatus(s, jiraCache){
  const e = effectiveColumn(s, jiraCache);
  let sub = '';
  if (e.col === 'qa'){
    const j = (s.wo && jiraCache[s.wo] && jiraCache[s.wo].available) ? jiraCache[s.wo] : null;
    if (j && j.status) sub = jiraSubLabel(j.status);          // «Ревью»/«Проверка продюсером» — если реально отличается
    if (!sub && s.wfQa === 'localcheck') sub = 'Ожидает проверки';  // локальная проверка разработчиком (билд готов, не отдан в QA)
  }
  return { col:e.col, blocked:e.blocked, sub };
}
// Фаза-4: причины «требует внимания» для сессии (убыв. срочности: блокер > упавшая сборка > ожидание проверки).
// Пусто, если задача завершена (done) или сигналов нет. buildFailed — из /api/sessions (live TeamCity), wfQa='localcheck'
// — билд готов, но задача ещё не отдана в QA (ждёт локальной проверки / проверки на устройстве).
export function attentionReasons(s, jiraCache){
  const st = cardStatus(s, jiraCache);
  if (st.col === 'done') return [];
  const out = [];
  if (st.blocked){
    const j = s.wo && jiraCache[s.wo];
    out.push({ kind:'blocked', sev:3, label:'Заблокирована', detail:(j && j.available && j.status) ? j.status : '' });
  }
  if (s.buildFailed) out.push({ kind:'build', sev:2, label:'Сборка упала', detail:'клиентская сборка TeamCity' });
  if (s.wfQa === 'localcheck') out.push({ kind:'verify', sev:1, label:'Ждёт проверки', detail:'билд готов — проверьте локально / на устройстве' });
  return out;
}
export function searchableText(s, jiraCache, mrCache, working){
  const parts = [s.wo, s.title, s.lastPrompt, s.project, s.gitBranch, s.model];
  if (s.clientCu) parts.push(s.clientCu);
  if (s.backend){ parts.push('backend бэкенд'); if (Array.isArray(s.changedServices)) parts.push(s.changedServices.join(' ')); }
  if (s.statics) parts.push('статика statics');
  if (s.baseBranch) parts.push(s.baseBranch);              // базовая/таргет ветка
  if (Array.isArray(s.tags) && s.tags.length) parts.push(s.tags.join(' '));   // пользовательские теги
  if (s.merged) parts.push('смерджено merged готово');
  // стадия — по Jira-приоритету если доступна, иначе локальный wfColumn; добавляем и код, и человекочитаемую метку
  const jira = (s.wo && jiraCache[s.wo] && jiraCache[s.wo].available) ? jiraCache[s.wo] : null;
  let col = s.wfColumn;
  if (jira && jira.status){ const m = jiraColumn(jira.status, jira.category); if (m.col) col = m.col; if (m.blocked) parts.push('blocked заблокировано'); parts.push(jira.status); }
  if (col) parts.push(col, WF_LABEL[col] || '');
  // MR состояния (live из GitLab, иначе wf-фолбэк)
  const mrs = mrCache[mrKey(s)] ? mrCache[mrKey(s)].mrs : null;
  if (mrs && mrs.length){ for (const m of mrs){ parts.push('!'+m.iid, m.target_branch, m.project || ''); parts.push(m.state==='merged'?'влит merged':m.state==='closed'?'закрыт closed':'открыт opened'); } }
  else if (s.wfMrUrl){ parts.push('mr', s.wfMrState==='merged'?'влит merged':'открыт opened'); }
  // билд
  if (s.buildActive) parts.push('билд идёт running');
  else if (s.wfBuildState==='done') parts.push('билд готово done');
  if (working) parts.push('работает');
  return parts.filter(Boolean).join(' ').toLowerCase();
}
