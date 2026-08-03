FROM nginx:stable-alpine

LABEL org.opencontainers.image.title="Graph Studio" \
      org.opencontainers.image.description="Редактор графов зависимостей, роадмапов и схем «что чем заблокировано»" \
      org.opencontainers.image.source="https://github.com/heepov/graph-studio" \
      org.opencontainers.image.licenses="MIT"

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY app/ /usr/share/nginx/html/

# COPY сохраняет права исходников: файл с режимом 600 воркер nginx не прочитает и отдаст 403
RUN chmod -R a=rX /usr/share/nginx/html

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null 2>&1 || exit 1
