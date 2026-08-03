#!/usr/bin/env bash
# Обновление Graph Studio на сервере. Запускать на сервере из каталога проекта:
#   cd /opt/graph-studio && ./deploy/deploy.sh
#
# Скрипт трогает только собственный docker-compose проект `graph-studio`.
# Ничего чужого (другие контейнеры, конфиги nginx) не затрагивается.
set -euo pipefail

cd "$(dirname "$0")/.."
PORT="${GRAPH_STUDIO_PORT:-8081}"

echo "==> git pull"
git pull --ff-only

echo "==> сборка образа"
docker compose build

echo "==> перезапуск контейнера"
docker compose up -d

echo "==> ждём health"
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
    echo "    ok (попытка $i)"
    break
  fi
  if [ "$i" = 30 ]; then
    echo "!!! приложение не поднялось, логи:" >&2
    docker compose logs --tail 50 >&2
    exit 1
  fi
  sleep 1
done

echo "==> проверка отдачи приложения"
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/")
if [ "$code" != "200" ]; then
  echo "!!! GET / вернул $code" >&2
  exit 1
fi

docker compose ps
echo "==> готово"
