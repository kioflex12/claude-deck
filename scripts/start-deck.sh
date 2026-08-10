#!/usr/bin/env bash
# Deck — запуск локального сервера на macOS / Linux.
# Работает из любой папки: переходит в корень репозитория (родитель scripts/).
set -e
cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
  echo "[Deck] Node.js не найден. Установи Node 20+ с https://nodejs.org и запусти снова."
  exit 1
fi

if [ ! -f "node_modules/@anthropic-ai/claude-agent-sdk/package.json" ]; then
  echo "[Deck] Первый запуск — ставлю зависимости (npm install)..."
  npm install
fi

URL="http://localhost:4317"
echo "[Deck] Запускаю сервер: $URL  (Ctrl+C — остановить)"
case "$OSTYPE" in
  darwin*) open "$URL" >/dev/null 2>&1 || true ;;
  linux*)  xdg-open "$URL" >/dev/null 2>&1 || true ;;
esac
node server/server.mjs
