@echo off
rem Deck — запуск локального сервера на Windows (двойной клик).
rem Работает из любой папки: переходит в корень репозитория (родитель scripts/).
chcp 65001 >nul
setlocal
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo [Deck] Node.js не найден. Установи Node 20+ с https://nodejs.org и запусти снова.
  pause
  exit /b 1
)

if not exist "node_modules\@anthropic-ai\claude-agent-sdk\package.json" (
  echo [Deck] Первый запуск — ставлю зависимости ^(npm install^)...
  call npm install
  if errorlevel 1 (
    echo [Deck] npm install не удался.
    pause
    exit /b 1
  )
)

echo [Deck] Запускаю сервер: http://localhost:4317  ^(Ctrl+C — остановить^)
start "" "http://localhost:4317"
node server\server.mjs
echo [Deck] Сервер остановлен.
pause
