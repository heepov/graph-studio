# ---------- сборка фронтенда ----------
# node:22-bookworm-slim, а не alpine: на musl нативные модули пришлось бы собирать
# из исходников, таща в образ python3/make/g++. Здесь это пока не нужно, но
# бэкенд с better-sqlite3 появится в этом же репозитории — держим базу совместимой.
FROM node:22-bookworm-slim AS build
WORKDIR /app

# сначала манифесты — слой с npm ci переиспользуется, пока зависимости не менялись
COPY package.json package-lock.json ./
RUN npm ci

# .git/HEAD и refs нужны сборке, чтобы проставить в приложение хеш коммита
COPY .git/ ./.git/
COPY index.html vite.config.mjs ./
COPY src/ ./src/
COPY public/ ./public/
COPY scripts/ ./scripts/

# build = vite build + scripts/pack-viewer.mjs (самодостаточный шаблон просмотрщика).
# Шаг падает, если в шаблоне не окажется блока данных или флага VIEWER, — молча
# сломанный экспорт просмотрщика хуже упавшей сборки.
RUN npm run build

# ---------- раздача ----------
FROM nginx:stable-alpine

LABEL org.opencontainers.image.title="Heepov Board" \
      org.opencontainers.image.description="Редактор графов зависимостей, роадмапов и схем «что чем заблокировано»" \
      org.opencontainers.image.source="https://github.com/heepov/graph-studio" \
      org.opencontainers.image.licenses="MIT"

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/ /usr/share/nginx/html/

# COPY сохраняет права исходников: файл с режимом 600 воркер nginx не прочитает и отдаст 403
RUN chmod -R a=rX /usr/share/nginx/html

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null 2>&1 || exit 1
