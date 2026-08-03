// Deck — чистая доска-логика (без DOM). Кэши Jira/MR и working приходят аргументами. D4c: вынесено из index.html.
export const WF_COLUMNS = [
  { key:'todo',       title:'Ждёт',             dot:'var(--text-faint)' },
  { key:'active',     title:'В работе',         dot:'var(--accent)' },
  { key:'blocked',    title:'Заблокировано',    dot:'var(--bad)' },
  { key:'build',      title:'Build In Progress', dot:'var(--warn)' },
  { key:'qa',         title:'На QA',            dot:'var(--info)' },
  { key:'readymerge', title:'Ждёт мерджа',      dot:'var(--info)' },
  { key:'done',       title:'Готово',           dot:'var(--good)' },
];
export const WF_LABEL = { blocked:'Заблокировано', todo:'Ждёт', active:'В работе', build:'Build In Progress', qa:'На QA', readymerge:'Ждёт мерджа', done:'Готово' };
// ключ MR-кэша — пара (ветка, wo), зеркало серверного _mrCache: базовую ветку (preprod) делят десятки задач, ключ по одной ветке склеивал бы их MR в одну запись
export const mrKey = (s) => ((s && s.gitBranch) || '') + '|' + ((s && s.wo) || '');
export function jiraColumn(status, category, s){
  const n = String(status||'').toLowerCase();
  const inProg = () => ({ col:(s && s.buildActive===true)?'build':'active', blocked:false });   // In Progress → build ТОЛЬКО если билд реально идёт (TeamCity), иначе active
  if (/block|блок/.test(n)) return { col:null, blocked:true };            // blocked — стадию не меняем, только бейдж
  if (/ready\s*(to|for)?\s*merge|к\s*мерж|готов.*мерж/.test(n)) return { col:'readymerge', blocked:false };
  if (/done|release|closed|resolved|готово|релиз|закрыт/.test(n) || category==='done') return { col:'done', blocked:false };
  if (/in\s*review|ready\s*(to|for)?\s*qa|in\s*qa|producer\s*review|testing|review|провер|ревью|тестир|на\s*qa/.test(n)) return { col:'qa', blocked:false };
  if (/in\s*progress|in\s*dev|development|doing|в\s*работе|в\s*процесс|разработ/.test(n)) return inProg();
  if (/to\s*do|backlog|open|new|selected|to\s*be|ждёт|бэклог|открыт|новая/.test(n) || category==='new') return { col:'todo', blocked:false };
  if (category==='indeterminate') return inProg();
  return { col:null, blocked:false };   // неизвестный статус → колонка из локального состояния
}
export function jiraSubLabel(status){
  const n = String(status||'').toLowerCase();
  if (/producer\s*review|продюсер/.test(n)) return 'Проверка продюсером';
  if (/in\s*review|ревью|на\s*ревью/.test(n)) return 'Ревью';
  return '';   // In QA / Ready To QA / testing и т.п. — то же, что колонка «На QA» → без дубля
}
export function effectiveColumn(s, jiraCache){
  let jm = null;
  if (s.wo){ const j = jiraCache[s.wo]; if (j && j.available && j.status) jm = jiraColumn(j.status, j.category, s); }
  if (jm && jm.blocked) return { col:'blocked', blocked:true };            // 1. Заблокировано (бейдж)
  if (s.buildActive === true) return { col:'build', blocked:false };       // 2. Build In Progress — ТОЛЬКО живой билд TeamCity (не stale buildTriggered)

  let wfCol = s.wfColumn || (s.active ? 'active' : 'todo');                // стадия dev-workflow (спеккит) — ОСНОВА
  if (wfCol === 'build') wfCol = 'qa';                                     // 3. билд завершён (не идёт) → dev-workflow-стадия «На QA»
  let col = wfCol;

  // Jira только УТОЧНЯЕТ стадию, не подменяет её собой. Два правила против «полагаемся только на Jira»:
  if (jm && jm.col && jm.col !== 'build'){
    const advanced = jm.col === 'qa' || jm.col === 'readymerge' || jm.col === 'done';
    if (advanced && !s.wfHasState){
      // нет dev-workflow-состояния (research-сессия, лишь упоминающая задачу) → Jira одна не тащит в продвинутую
      // колонку; оставляем стадию самой сессии (active/todo). Иначе research улетал в QA/Готово по статусу задачи.
    } else if (jm.col === 'qa' || wfCol === 'qa'){
      // «На QА» — только когда И dev-workflow, И Jira в QA; расходятся → берём НЕ-QA сторону.
      col = (jm.col === 'qa' && wfCol === 'qa') ? 'qa' : (jm.col === 'qa' ? wfCol : jm.col);
    } else {
      col = jm.col;                                                        // done/readymerge/todo при наличии состояния — по Jira
    }
  }
  return { col, blocked:false };
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
  if (jira && jira.status){ const m = jiraColumn(jira.status, jira.category, s); if (m.col) col = m.col; if (m.blocked) parts.push('blocked заблокировано'); parts.push(jira.status); }
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
