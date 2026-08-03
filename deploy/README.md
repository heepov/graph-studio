# Деплой

Схема: host-nginx держит TLS и проксирует на контейнер `graph-studio`,
который слушает `127.0.0.1:8081` и отдаёт статику. Наружу контейнер не торчит.

```
браузер ──https──▶ nginx (хост, :443) ──http──▶ docker: graph-studio (127.0.0.1:8081 → :8080)
```

## Первая установка

```bash
git clone https://github.com/heepov/graph-studio.git /opt/graph-studio
cd /opt/graph-studio
docker compose up -d --build
curl -f http://127.0.0.1:8081/healthz          # → ok
```

Дальше — nginx и сертификат:

```bash
# 1) bootstrap-конфиг (только HTTP), чтобы прошёл ACME challenge
cp deploy/nginx/graph.heeprod.ru.bootstrap.conf /etc/nginx/sites-available/graph.heeprod.ru.conf
ln -s /etc/nginx/sites-available/graph.heeprod.ru.conf /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

# 2) сертификат — webroot, БЕЗ правки конфигов nginx (не заденет соседние сайты)
certbot certonly --webroot -w /var/www/html -d graph.heeprod.ru

# 3) боевой конфиг с TLS
cp deploy/nginx/graph.heeprod.ru.conf /etc/nginx/sites-available/graph.heeprod.ru.conf
nginx -t && systemctl reload nginx
```

> `certbot --nginx` намеренно не используется: он переписывает конфиги nginx,
> а на сервере живут другие сайты. `certonly --webroot` не трогает nginx вообще.

## Обновление

```bash
cd /opt/graph-studio && ./deploy/deploy.sh
```

## Откат

```bash
cd /opt/graph-studio
git log --oneline -5
git checkout <commit>
docker compose up -d --build
```

## Полное удаление (не задевая остальное)

```bash
cd /opt/graph-studio && docker compose down
rm /etc/nginx/sites-enabled/graph.heeprod.ru.conf
nginx -t && systemctl reload nginx
```

## Проверки

```bash
curl -I https://graph.heeprod.ru/                    # 200
curl -s https://graph.heeprod.ru/healthz             # ok
curl -sI https://graph.heeprod.ru/manifest.webmanifest | grep -i content-type   # application/manifest+json
docker compose -p graph-studio ps
```
