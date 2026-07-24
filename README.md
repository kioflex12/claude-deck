# Claude Deck

Десктоп-менеджер **контекстов Claude Code** — замена неудобному VSCode-расширению.

Доска задач WO, где **карточка = контекст (сессия Claude)**, привязанный к задаче: статус в Jira, ветка, MR, статусы сборок Android/iOS, окно контекста. По клику — **полноэкранная сессия**: слева живой чат (как в расширении VSCode), справа рейл с инфой (описание, ветки, MR, сборки, заметки для возврата). Плюс вкладки **Скиллы** и **MCP-инструменты** и командная палитра (Ctrl K).

## Зачем своё, а не готовое

Есть похожие инструменты (Nimbalyst, langwatch/kanban-code, code-factory), но все завязаны на **GitHub PR + git worktree**. Наш конвейер — другой: **GitLab MR + Jira + TeamCity + файлы `dev-workflow/WO-XXXX.json` + 4 копии `client-unity`**. Этот «клей» и есть смысл проекта — ни один готовый тул его не покрывает.

## Подход

**Форк [`nimbalyst/nimbalyst`](https://github.com/nimbalyst/nimbalyst)** (MIT, TypeScript / Electron, кроссплатформа) + наш слой интеграций. У nimbalyst уже готов самый дорогой кусок — запуск и стрим параллельных сессий, git, worktrees, дифф-ревью. Мы добавляем поверх:

- источник задач и статусов: Jira (mcp-tools) + TeamCity (сборки) + GitLab (MR);
- привязку сессия ↔ задача WO через файлы `dev-workflow/WO-XXXX.json`;
- вкладку **Скиллы** (каталог `~100` проектных скиллов, поиск, вставка `/команды`);
- вкладку **MCP** (активные серверы + активация коннекторов);
- обвязку всего гиперссылками (ветка→GitLab, MR→страница MR, сборка→TeamCity, задача→Jira).

## Прототип

`prototype/index.html` — кликабельный макет всего UI/UX (открыть в браузере). Он же источник дизайна.
Онлайн-версия: https://claude.ai/code/artifact/4ba38cff-a443-4a73-b76b-2f6c504d3eb6

## Стек

- **Electron + TypeScript** (от nimbalyst), npm workspaces.
- Сессии Claude — через Claude **Agent SDK** / `claude --resume` (движок nimbalyst).
- Данные — локальные транскрипты `~/.claude/projects/*/*.jsonl`, `dev-workflow/WO-*.json`, REST/MCP к Jira/TeamCity/GitLab.

## Статус

Bootstrap. Дальше — см. [ROADMAP.md](ROADMAP.md).
