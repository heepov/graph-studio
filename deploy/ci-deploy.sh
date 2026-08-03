#!/usr/bin/env bash
# Команда, которую выполняет GitHub Actions на сервере.
#
# Ключ CI прописан в authorized_keys с forced command именно на этот скрипт,
# поэтому по этому ключу нельзя выполнить ничего другого — только деплой.
#
# Ставится ВНЕ репозитория (/usr/local/bin/graph-studio-ci-deploy): git reset
# перезаписал бы файл прямо во время его исполнения, а bash дочитывает скрипт
# по ходу выполнения и на этом ломается.
#
#   install -m 755 deploy/ci-deploy.sh /usr/local/bin/graph-studio-ci-deploy
#
# После правки этого файла установку нужно повторить руками.
set -euo pipefail

REPO=/opt/graph-studio
PORT="${GRAPH_STUDIO_PORT:-8081}"
cd "$REPO"

echo "==> было: $(git rev-parse --short HEAD)"
git fetch --quiet origin main
git reset --hard --quiet origin/main
echo "==> стало: $(git rev-parse --short HEAD) $(git log -1 --pretty=%s)"

echo "==> сборка образа"
docker compose build

echo "==> перезапуск"
docker compose up -d

echo "==> ждём health"
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
    echo "    ok (попытка $i)"
    break
  fi
  if [ "$i" = 30 ]; then
    echo "!!! контейнер не поднялся" >&2
    docker compose logs --tail 50 >&2
    exit 1
  fi
  sleep 1
done

code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/")
[ "$code" = "200" ] || { echo "!!! GET / вернул $code" >&2; exit 1; }

# подчистить старые слои, чтобы диск не заплывал от пересборок
docker image prune -f --filter "dangling=true" >/dev/null 2>&1 || true

echo "==> деплой завершён: $(docker compose ps --format '{{.Name}} {{.Status}}')"
