// Deck — единое мутабельное состояние клиента.
//
// Состояние было размазано ~50 глобалами по app.js: живой стрим торчал разом в рендере карточки
// (isWorking) и в чат-цикле, навигация/поиск/кэши — в десятках функций. Пока оно было набором
// разрозненных `let`, файл нельзя резать на модули: ES-модуль не даёт переприсваивать импортированный
// биндинг (`import { streaming }` + `streaming = true` — ошибка компиляции). Поэтому всё
// переприсваиваемое собрано в объект `S` (пишется через `S.x = …` из любого модуля), а неизменяемые
// контейнеры/словари вынесены отдельными const-экспортами (их ссылки не меняются — импорт по имени).

export const S = {
  // навигация / доска / поиск
  activeView: 'status',       // текущая вкладка: status|board|skills|mcp|session
  projFilter: 'all',          // фильтр доски по проекту (бывш. глобал `filter`)
  query: '',                  // строка поиска (нижний регистр)
  skillCat: 'all',            // выбранная категория скиллов
  currentFile: null,          // открытая сессия
  returnView: 'status',       // куда вернуться из сессии
  SESSIONS: [],               // список сессий доски

  // правый рейл сессии: активная вкладка + кэш артефактов
  railTab: 'context',         // 'context' | 'artifacts'
  artifacts: null,            // null — ещё не грузили; [] — загружено, пусто
  artifactsCwd: '',           // cwd для резолва пути во встроенном просмотрщике

  // проекты (папки)
  PROJECTS: [],
  ACTIVE_PROJECT: '',
  JIRA_HOST_CFG: '',          // хост Jira из /api/config; пусто → ссылку «в Jira» не строим

  // чат / живой стрим
  streaming: false,
  currentES: null,            // EventSource активного стрима
  liveFinish: null,           // коллбэк обрыва стрима
  streamTimer: null,          // тикер «Claude работает Nс»
  currentStreamId: null,      // id стрима для гарантированного /api/stop
  streamingFile: null,        // файл стримящейся сессии (оверрайд working=true в рендере)
  serverBusy: false,          // на сервере жив ход текущей сессии, хотя SSE-канал оборван (из tail serverActive) — новый промт должен steer'иться, а не плодить 2-й ход
  sessionMode: 'default',     // режим разрешений (shift-tab цикл)
  sessionModel: '',           // выбранная модель (пусто = дефолт)
  sessionEffort: '',          // выбранный reasoning-effort
  pendingNewSession: null,    // {cwd,name}: новая сессия создаётся первым промтом (файла ещё нет)
  SESSION_SKILLS: [],         // скиллы cwd для автокомплита «/»
  slashItems: [], slashSel: 0, slashOpen: false,

  // каталоги (перезаписываются целиком при загрузке)
  MODELS: [], EFFORTS: [],
  SKILLS: [], skillsLoaded: false,
  MCP_SERVERS: [], mcpLoaded: false, MCP_STATUS: { available: false, live: false, servers: [] }, mcpLoading: false, mcpDetail: null,
  unityInstances: [],

  // поллинг / notify / таймеры-хэндлы
  buildTimer: null,
  notifyEnabled: false,
  prevWorkingFiles: new Set(),  // «работающие» сессии на прошлый опрос (детект working→idle)
  pendingDone: new Set(),       // простаивают 1 опрос — гасим ложное «готово» на долгом tool-call
  pollTimer: null, polling: false,
  tailTimer: null, tailCount: 0,
  agentsTimer: null,
  mrHydrating: false, jiraHydrating: false,
  tailCountTimer: null, railTimer: null,
  _lastHeavy: 0, usageTimer: null, healthTimer: null,

  // лента «Требует внимания» (Фаза-4)
  ATTENTION_GIT: [],          // незакоммиченные рабочие копии из /api/git-dirty (сессионные сигналы считаются из SESSIONS)
  ENV_STATUS: { configured:false, envs:[] },   // health окружений из /api/env-status
  attnGitTimer: null,

  // палитра / usage / auth / services / login / обновления
  palItems: [], palSel: 0,
  USAGE: null,
  AUTH: { loggedIn: false },  // дефолт совпадает с прежним инлайном — renderAuth/requireAuth читают .loggedIn до резолва loadAuth()
  SVC_CFG: null,
  loginInProgress: false,
  UPDATE_STATUS_EL: null, UPDATE_INSTALL_EL: null, UPDATE_DOWNLOAD_EL: null, UPDATE_PROGRESS_EL: null, UPDATE_CANCEL_EL: null,
};

// Неизменяемые контейнеры рантайма — мутируются по месту (x[k]=…, .add/.push), не переприсваиваются.
// Ссылки на них НЕ меняются при распиле: модули импортируют их по имени.
export const SESSION_CACHE = {};   // file -> полный транскрипт
export const MR_CACHE = {};        // branch -> { ts, mrs } (клиентский кэш MR ~30с)
export const JIRA_CACHE = {};      // wo -> { ts, available, status, category, summary }
export const notifiedDone = new Set();  // файлы, за чей рабочий эпизод уже уведомили (дедуп)
export const notifiedInput = new Set();  // id вопросов/аппрувов, о которых уже уведомили «требуется ответ» (дедуп)
export const promptQueue = [];     // FIFO промтов, отправленных во время активного стрима
export const attachDraft = [];     // черновик вложений текущего сообщения
export const SKILLS_CACHE = {};

// Неизменяемые словари/константы.
export const COLUMNS = [
  { key:'today', title:'Сегодня',         dot:'var(--accent)' },
  { key:'week',  title:'Последние 7 дней', dot:'var(--info)' },
  { key:'older', title:'Раньше',           dot:'var(--text-faint)' },
];
export const MODE_ORDER = ['default','acceptEdits','plan','bypassPermissions'];
export const MODE_LABEL = { default:'Обычный', acceptEdits:'Авто-правки', plan:'План', bypassPermissions:'Байпас' };
// Нормализация сохранённого режима: устаревшее/битое значение в localStorage (напр. старое 'bypass' вместо
// 'bypassPermissions') не должно молча уезжать на сервер и откатываться в default — кнопка бы показывала «Обычный».
export const normMode = (m) => MODE_ORDER.includes(m) ? m : 'default';
export const LIVE_TTL = 30000;              // TTL клиентских кэшей MR/Jira
export const ATTACH_MAX_BYTES = 18 * 1024 * 1024;  // суммарный лимит вложений ~18МБ
