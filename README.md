# Claude Deck

Локальный менеджер **контекстов Claude Code** — замена неудобному VSCode-расширению.

Канбан-доска, где **карточка = контекст (сессия Claude)**: статус в Jira, ветка, MR, статусы сборок Android/iOS, окно контекста. По клику — **полноэкранная сессия**: слева живой чат (стрим, thinking, токены, аппрув Edit/Write/Bash, режимы разрешений, вложения-скриншоты), справа рейл (описание, ветки, MR, сборки, заметки). Плюс вкладки **Скиллы** и **MCP**, командная палитра (Ctrl K), индикатор аккаунт-лимитов Claude.

## Зачем своё, а не готовое

Похожие инструменты (Nimbalyst, langwatch/kanban-code, code-factory) завязаны на **GitHub PR + git worktree**. Наш конвейер другой: **GitLab MR + Jira + TeamCity + файлы `dev-workflow/WO-XXXX.json` + копии `client-unity`**. Этот «клей» и есть смысл проекта — ни один готовый тул его не покрывает.

## Архитектура

Никакого Electron/сборки — **zero-dep Node-сервер + статический HTML**:

- **`server.mjs`** — HTTP-сервер (`localhost:4317`) на голом `node:http`. Читает реальные сессии из `~/.claude/projects/*/*.jsonl`, состояния `dev-workflow/WO-*.json`, ходит в TeamCity/GitLab/Jira, гоняет живого Claude через **Agent SDK** (`@anthropic-ai/claude-agent-sdk`, существующий OAuth-логин Claude Code — без отдельного ключа). Единственная внешняя зависимость.
- **`index.html`** — весь UI одним файлом (дизайн из `prototype/index.html`).

## Запуск

**Требования:** Node.js 20+ и установленный, **залогиненный Claude Code** на этой машине (real-Claude, usage-лимиты и создание сессий работают через его OAuth).

- **Windows** — двойной клик по **`start-deck.bat`**.
- **macOS / Linux** — `bash start-deck.sh` (или сделать исполняемым и запускать `./start-deck.sh`).

Лаунчер сам ставит зависимости при первом запуске (`npm install`), поднимает сервер и открывает браузер на `http://localhost:4317`. Правки `server.mjs` требуют перезапуска, `index.html` — просто F5.

**Автозапуск после перезагрузки (Windows, опц.):** положи ярлык на `start-deck.bat` в папку автозагрузки — `Win+R` → `shell:startup`.

### Переменные окружения (опционально)

Кладутся в `.env` в корне репо (gitignored):

- `JIRA_HOST`, `JIRA_EMAIL`, `JIRA_TOKEN` — живой статус Jira на карточках. Без них Jira-колонка молча берётся из локального `dev-workflow`.
- `WO_STATES_DIR` — путь к `dev-workflow/workflow-states` (по умолчанию — путь основного рабочего репо). На другой машине задай свой или оставь пустым (доска заполнится по активности сессий).
- `CLAUDE_PROJECTS_DIR` — где лежат транскрипты (по умолчанию `~/.claude/projects`).

## Прототип

`prototype/index.html` — кликабельный макет всего UI/UX и источник дизайна.

## Статус

Рабочая платформа (стрим, аппрувы, режимы, вложения, live Jira/MR/сборки, usage, создание сессий). Дальше — см. [ROADMAP.md](ROADMAP.md) и [BACKLOG.md](BACKLOG.md).
