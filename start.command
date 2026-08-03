#!/bin/bash
# Двойной клик по этому файлу запускает Graph Studio как локальный веб-сервер
# и открывает его в браузере по адресу http://localhost:8123 — в этом режиме
# работает установка как приложение (PWA) и синхронизация с файлами на диске.
cd "$(dirname "$0")" || exit 1
PORT=8123
# поднимаем простой статический сервер из папки app (Python есть на macOS из коробки)
python3 -m http.server "$PORT" --directory app >/dev/null 2>&1 &
SRV=$!
sleep 1
open "http://localhost:$PORT/"
echo "Graph Studio запущен на http://localhost:$PORT"
echo "Это окно можно свернуть. Чтобы остановить сервер — закройте это окно Терминала."
# держим сервер живым, пока открыто окно терминала
wait $SRV
