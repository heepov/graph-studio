#!/bin/sh
# Миграции и заведение админа — ДО подъёма HTTP.
#
# Через ssh это сделать нельзя: ключ CI прописан с forced command и аргументов
# не принимает. Значит единственная надёжная точка — старт контейнера.
# Упали миграции → контейнер не поднялся → health красный → деплой неуспешен.
set -e
echo "==> миграции"
node scripts/migrate.js
echo "==> администратор"
node scripts/bootstrap.js
echo "==> старт api"
exec node src/server.js
