#!/usr/bin/env bash
# Полная проверка: сборка образа → контейнер → оба набора тестов.
#
# set -e обязателен. Без него упавшая сборка не видна: контейнер продолжает
# крутиться со СТАРЫМ кодом, тесты проходят и создают ощущение, что всё хорошо.
# Именно так и случилось однажды: pack-viewer падал по памяти, а тесты зеленели.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${GRAPH_STUDIO_PORT:-8081}"

echo "── сборка образа"
docker compose up -d --build

echo "── жду healthz"
for i in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then break; fi
  if [ "$i" = 40 ]; then echo "контейнер не поднялся"; docker compose logs --tail 40; exit 1; fi
  sleep 1
done

echo "── жду api"
for i in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then break; fi
  if [ "$i" = 40 ]; then echo "api не поднялся"; docker compose logs api --tail 40; exit 1; fi
  sleep 1
done

echo "── проверки бэкенда"
node test/api.js

echo "── регрессионный прогон"
node test/smoke.js

echo "── совместимость со старыми файлами"
node test/legacy.js

echo "── всё зелено"
