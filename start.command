#!/bin/bash
# Двойной клик по этому файлу запускает Graph Studio локально и открывает его в браузере.
#
# После перехода на сборку приложение — это index.html + src/ + public/, а не один файл,
# поэтому статического http.server уже мало: нужен Vite. Он же даёт горячую перезагрузку.
cd "$(dirname "$0")" || exit 1
PORT=8123

if ! command -v npm >/dev/null 2>&1; then
  echo "Нужен Node.js (npm). Поставьте с https://nodejs.org и запустите снова."
  read -r -p "Нажмите Enter, чтобы закрыть."
  exit 1
fi

# зависимости ставим один раз
if [ ! -d node_modules ]; then
  echo "Первый запуск: ставлю зависимости, это займёт минуту…"
  npm install || { echo "Не удалось поставить зависимости."; read -r -p "Enter"; exit 1; }
fi

npm run dev -- --port "$PORT" >/tmp/graph-studio-dev.log 2>&1 &
SRV=$!
sleep 2
open "http://localhost:$PORT/"
echo "Heepov Board запущен на http://localhost:$PORT"
echo "Это окно можно свернуть. Чтобы остановить сервер — закройте это окно Терминала."
wait $SRV
