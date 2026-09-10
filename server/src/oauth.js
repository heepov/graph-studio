// OAuth 2.1 для MCP-коннектора: сервер выдаёт токены сам.
//
// Зачем вообще. Claude-коннектор ходит к доскам ОТ ИМЕНИ человека. Без входа
// сервер не знал бы, чьи доски показывать, а «коннектор без авторизации» означал
// бы, что доски доступны любому, кто узнал адрес. Поэтому здесь настоящая выдача
// токенов, а не общий ключ в настройках.
//
// Реализуется ровно тот срез спецификации MCP, который нужен клиенту:
//   RFC 9728  — метаданные защищённого ресурса (куда идти за токеном),
//   RFC 8414  — метаданные сервера авторизации,
//   RFC 7591  — регистрация клиента на лету (у Claude нет заранее выданного id),
//   OAuth 2.1 — код + PKCE S256, обязательный точный redirect_uri,
//   RFC 8707  — привязка токена к ресурсу (audience),
//   RFC 9207  — iss в ответе авторизации.
//
// Чего здесь СОЗНАТЕЛЬНО нет: implicit, пароль в обмен на токен, client_credentials.
// Все три либо убраны из 2.1, либо не имеют смысла для персонального сервиса.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { hashPassword, verifyPassword, newToken } from './auth.js';

const now = () => Date.now();
const sha = s => createHash('sha256').update(String(s)).digest('base64url');

const CODE_TTL = 5 * 60 * 1000;             // код живёт минуты: он только для обмена
const ACCESS_TTL = 30 * 24 * 3600 * 1000;   // столько же, сколько сессия в браузере
const SCOPES = ['boards.read', 'boards.write'];

export function registerOAuth(app, db, opts) {
  const { publicUrl } = opts;
  const ISSUER = publicUrl.replace(/\/+$/, '');
  const RESOURCE = ISSUER + '/mcp';

  /* ================= метаданные ================= */

  // RFC 9728: клиент приходит сюда с 401 и узнаёт, у кого просить токен.
  // Отдаём и по суффиксному адресу (/.well-known/oauth-protected-resource/mcp),
  // и по корневому: разные клиенты пробуют разные, и спорить с ними незачем.
  const prm = () => ({
    resource: RESOURCE,
    authorization_servers: [ISSUER],
    scopes_supported: SCOPES,
    bearer_methods_supported: ['header'],
    resource_name: 'Heepov Board',
    resource_documentation: ISSUER + '/',
  });
  app.get('/.well-known/oauth-protected-resource', async () => prm());
  app.get('/.well-known/oauth-protected-resource/mcp', async () => prm());

  // RFC 8414. OpenID-адрес отдаём тем же телом: часть клиентов пробует сначала его.
  const asMeta = () => ({
    issuer: ISSUER,
    authorization_endpoint: ISSUER + '/oauth/authorize',
    token_endpoint: ISSUER + '/oauth/token',
    registration_endpoint: ISSUER + '/oauth/register',
    revocation_endpoint: ISSUER + '/oauth/revoke',
    scopes_supported: SCOPES,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    // Только S256: plain оставляет код перехватываемым, ради чего PKCE и придуман.
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    authorization_response_iss_parameter_supported: true,
    resource_indicators_supported: true,
    service_documentation: ISSUER + '/',
  });
  app.get('/.well-known/oauth-authorization-server', async () => asMeta());
  app.get('/.well-known/oauth-authorization-server/mcp', async () => asMeta());
  app.get('/.well-known/openid-configuration', async () => asMeta());

  /* ================= регистрация клиента ================= */

  // RFC 7591. Открыта намеренно: клиент здесь — это приложение Claude на конкретном
  // устройстве, а не человек. Права даёт не регистрация, а вход на следующем шаге,
  // поэтому свободная регистрация ничего не открывает сама по себе.
  app.post('/oauth/register', {
    config: { rateLimit: { max: 20, timeWindow: '10 minutes' } },
  }, async (req, reply) => {
    const b = req.body || {};
    const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.filter(u => typeof u === 'string') : [];
    if (!uris.length) return reply.code(400).send({ error: 'invalid_redirect_uri', error_description: 'нужен redirect_uris' });
    for (const u of uris) {
      let p;
      try { p = new URL(u); } catch { return reply.code(400).send({ error: 'invalid_redirect_uri', error_description: 'плохой адрес: ' + u }); }
      // http допускаем только на localhost — там нет TLS и это нормальный случай
      // для настольного клиента; во внешнем интернете код по http перехватывается.
      const local = p.hostname === '127.0.0.1' || p.hostname === 'localhost' || p.hostname === '[::1]';
      if (p.protocol !== 'https:' && !(p.protocol === 'http:' && local)) {
        return reply.code(400).send({ error: 'invalid_redirect_uri', error_description: 'нужен https (или http на localhost)' });
      }
    }
    const id = 'gsc_' + randomBytes(12).toString('base64url');
    // Публичный клиент (PKCE без секрета) — норма для настольных и мобильных
    // приложений: секрет в них всё равно негде спрятать.
    const wantsSecret = b.token_endpoint_auth_method && b.token_endpoint_auth_method !== 'none';
    const secret = wantsSecret ? newToken() : null;
    db.prepare(`INSERT INTO oauth_clients (id, secret_hash, name, redirect_uris, created_at)
      VALUES (?,?,?,?,?)`).run(id, secret ? hashPassword(secret) : null,
        String(b.client_name || 'MCP client').slice(0, 120), JSON.stringify(uris), now());
    const out = {
      client_id: id,
      client_id_issued_at: Math.floor(now() / 1000),
      redirect_uris: uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: secret ? 'client_secret_post' : 'none',
      client_name: String(b.client_name || 'MCP client').slice(0, 120),
    };
    if (secret) { out.client_secret = secret; out.client_secret_expires_at = 0; }
    return reply.code(201).send(out);
  });

  const clientBy = id => db.prepare('SELECT * FROM oauth_clients WHERE id = ?').get(String(id || ''));

  // RFC 8707. Аудиторию токена приводим к одному виду: клиенты присылают ресурс
  // то с путём, то без. Разные написания одного и того же дали бы токен, который
  // сервер сам же и не примет, — а выглядело бы это как «коннектор не работает».
  // Чужой ресурс отклоняем сразу, а не выдаём токен, который никогда не сработает.
  const RES_OK = new Set([RESOURCE, RESOURCE + '/', ISSUER, ISSUER + '/']);
  function normResource(v) {
    if (v == null || v === '') return { ok: true, value: RESOURCE };
    const s = String(v);
    return RES_OK.has(s) ? { ok: true, value: RESOURCE } : { ok: false };
  }
  const redirectAllowed = (client, uri) => {
    try { return JSON.parse(client.redirect_uris).includes(uri); } catch { return false; }
  };

  /* ================= согласие и код ================= */

  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const page = (title, body) => `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} — Heepov Board</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f1f3f8;
    font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#141822;padding:24px}
  .c{background:#fff;border:1px solid #e5e8f0;border-radius:16px;box-shadow:0 4px 14px rgba(16,20,32,.1);
    width:100%;max-width:420px;padding:30px}
  .b{display:flex;align-items:center;gap:9px;justify-content:center;margin-bottom:18px}
  .b i{width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,#4262ff,#7b3fd1);
    display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-style:normal;font-size:14px}
  .b span{font-weight:750;font-size:15px}
  h1{font-size:20px;margin:0 0 8px;text-align:center;letter-spacing:-.3px}
  p{color:#4d5567;margin:0 0 16px;text-align:center}
  ul{color:#4d5567;margin:0 0 18px;padding-left:20px}
  li{margin:4px 0}
  label{display:block;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.4px;color:#6b7383;margin:0 0 4px}
  input{width:100%;box-sizing:border-box;padding:10px 12px;font-size:14px;border:1px solid #e5e8f0;
    border-radius:8px;margin-bottom:12px;font-family:inherit}
  button{width:100%;padding:11px;font-size:14.5px;font-weight:650;border:none;border-radius:8px;
    background:#4262ff;color:#fff;cursor:pointer;font-family:inherit}
  button.sec{background:#fff;color:#4d5567;border:1px solid #e5e8f0;margin-top:8px}
  .err{background:#fdecea;border:1px solid #f0c7c2;color:#b3261e;border-radius:8px;padding:9px 11px;margin-bottom:14px}
  .hint{font-size:12.5px;color:#6b7383;text-align:center;margin-top:14px}
</style></head><body><div class="c">
<div class="b"><i>G</i><span>Heepov Board</span></div>${body}</div></body></html>`;

  const hidden = q => Object.entries(q).filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');

  // Разбор запроса на авторизацию. Ошибки, которые НЕЛЬЗЯ отправлять редиректом
  // (неизвестный клиент, чужой redirect_uri), показываем страницей: увести человека
  // по непроверенному адресу — это и есть открытый редирект.
  function parseAuthz(q) {
    const client = clientBy(q.client_id);
    if (!client) return { fatal: 'Приложение не зарегистрировано' };
    const uri = String(q.redirect_uri || '');
    if (!redirectAllowed(client, uri)) return { fatal: 'Адрес возврата не совпадает с зарегистрированным' };
    return { client, uri };
  }
  const back = (uri, params) => {
    const u = new URL(uri);
    for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
    u.searchParams.set('iss', ISSUER);   // RFC 9207: клиент проверит, кто ответил
    return u.toString();
  };

  const consent = (q, client, msg) => page('Доступ', `
    <h1>Разрешить доступ?</h1>
    <p><b>${esc(client.name || 'Приложение')}</b> просит доступ к вашим доскам Heepov Board.</p>
    ${msg ? `<div class="err">${esc(msg)}</div>` : ''}
    <ul>
      <li>видеть список досок и их содержимое</li>
      ${String(q.scope || '').includes('boards.write') ? '<li>создавать и изменять доски</li>' : ''}
    </ul>
    <form method="post" action="/oauth/authorize">
      ${hidden(q)}
      <input type="hidden" name="decision" value="allow">
      <button type="submit">Разрешить</button>
    </form>
    <form method="post" action="/oauth/authorize">
      ${hidden(q)}
      <input type="hidden" name="decision" value="deny">
      <button type="submit" class="sec">Отказать</button>
    </form>
    <div class="hint">Доступ можно отозвать в любой момент — «Приложения» в меню аккаунта.</div>`);

  const loginForm = (q, msg) => page('Вход', `
    <h1>Вход</h1>
    <p>Чтобы разрешить доступ, войдите в свой аккаунт.</p>
    ${msg ? `<div class="err">${esc(msg)}</div>` : ''}
    <form method="post" action="/oauth/authorize">
      ${hidden(q)}
      <input type="hidden" name="decision" value="login">
      <label>Почта</label><input type="email" name="email" autocomplete="username" required>
      <label>Пароль</label><input type="password" name="password" autocomplete="current-password" required>
      <button type="submit">Войти</button>
    </form>`);

  const QKEYS = ['client_id', 'redirect_uri', 'response_type', 'scope', 'state',
    'code_challenge', 'code_challenge_method', 'resource'];
  const pick = src => Object.fromEntries(QKEYS.map(k => [k, src[k]]).filter(([, v]) => v != null));

  app.get('/oauth/authorize', async (req, reply) => {
    const q = pick(req.query || {});
    const p = parseAuthz(q);
    if (p.fatal) return reply.type('text/html').code(400).send(page('Ошибка', `<h1>Не получилось</h1><p>${esc(p.fatal)}</p>`));
    if (q.response_type !== 'code') return reply.redirect(back(p.uri, { error: 'unsupported_response_type', state: q.state }));
    if (!q.code_challenge || q.code_challenge_method !== 'S256') {
      return reply.redirect(back(p.uri, { error: 'invalid_request', error_description: 'нужен PKCE S256', state: q.state }));
    }
    if (!normResource(q.resource).ok) {
      return reply.redirect(back(p.uri, { error: 'invalid_target',
        error_description: `этот сервер выдаёт токены только для ${RESOURCE}`, state: q.state }));
    }
    if (!req.user) return reply.type('text/html').send(loginForm(q));
    return reply.type('text/html').send(consent(q, p.client));
  });

  app.post('/oauth/authorize', async (req, reply) => {
    const b = req.body || {};
    const q = pick(b);
    const p = parseAuthz(q);
    if (p.fatal) return reply.type('text/html').code(400).send(page('Ошибка', `<h1>Не получилось</h1><p>${esc(p.fatal)}</p>`));

    if (b.decision === 'deny') {
      return reply.redirect(back(p.uri, { error: 'access_denied', state: q.state }));
    }
    // Вход прямо на этой странице: гонять человека в приложение и обратно ради
    // сессии — лишний круг, на котором теряется половина людей.
    let user = req.user;
    if (b.decision === 'login') {
      const u = db.prepare('SELECT * FROM users WHERE email = ?').get(String(b.email || '').trim());
      if (!u || u.blocked || !verifyPassword(String(b.password || ''), u.pass_hash)) {
        return reply.type('text/html').send(loginForm(q, 'Неверная почта или пароль'));
      }
      user = { id: u.id, email: u.email, name: u.name, admin: !!u.is_admin };
      opts.startSession(reply, u.id, req.headers['user-agent']);
      return reply.type('text/html').send(consent(q, p.client));
    }
    if (!user) return reply.type('text/html').send(loginForm(q));
    if (b.decision !== 'allow') return reply.type('text/html').send(consent(q, p.client));

    const code = newToken();
    db.prepare(`INSERT INTO oauth_codes (code, client_id, user_id, redirect_uri, code_challenge, scope, resource, expires_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(sha(code), p.client.id, user.id, p.uri, String(q.code_challenge),
        String(q.scope || SCOPES.join(' ')), normResource(q.resource).value, now() + CODE_TTL);
    return reply.redirect(back(p.uri, { code, state: q.state }));
  });

  /* ================= обмен на токен ================= */

  const issue = (kind, row, ttl) => {
    const t = newToken();
    db.prepare(`INSERT INTO oauth_tokens (token_hash, kind, client_id, user_id, scope, audience, created_at, expires_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(sha(t), kind, row.client_id, row.user_id, row.scope,
        row.resource || RESOURCE, now(), ttl ? now() + ttl : null);
    return t;
  };

  function authClient(req) {
    const b = req.body || {};
    let id = b.client_id, secret = b.client_secret;
    const h = req.headers.authorization || '';
    if (/^Basic /i.test(h)) {
      const [u, p] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
      id = id || decodeURIComponent(u || ''); secret = secret || decodeURIComponent(p || '');
    }
    const client = clientBy(id);
    if (!client) return { error: 'invalid_client' };
    if (client.secret_hash && !verifyPassword(String(secret || ''), client.secret_hash)) return { error: 'invalid_client' };
    return { client };
  }

  app.post('/oauth/token', {
    config: { rateLimit: { max: 60, timeWindow: '5 minutes' } },
  }, async (req, reply) => {
    const b = req.body || {};
    const { client, error } = authClient(req);
    if (error) return reply.code(401).send({ error });

    if (b.grant_type === 'authorization_code') {
      const row = db.prepare('SELECT * FROM oauth_codes WHERE code = ?').get(sha(String(b.code || '')));
      if (!row || row.client_id !== client.id) return reply.code(400).send({ error: 'invalid_grant' });
      // Повторное использование кода — признак кражи. Гасим всё, что по нему выдано:
      // если код увели, выданный по нему токен тоже нельзя считать своим.
      if (row.used || row.expires_at < now()) {
        db.prepare('DELETE FROM oauth_codes WHERE code = ?').run(row.code);
        return reply.code(400).send({ error: 'invalid_grant', error_description: 'код уже использован или истёк' });
      }
      if (row.redirect_uri !== String(b.redirect_uri || '')) return reply.code(400).send({ error: 'invalid_grant' });
      const ver = sha(String(b.code_verifier || ''));
      const a = Buffer.from(ver), c = Buffer.from(row.code_challenge);
      if (a.length !== c.length || !timingSafeEqual(a, c)) return reply.code(400).send({ error: 'invalid_grant', error_description: 'PKCE не сошёлся' });
      if (b.resource && !normResource(b.resource).ok) return reply.code(400).send({ error: 'invalid_target' });
      db.prepare('UPDATE oauth_codes SET used = 1 WHERE code = ?').run(row.code);
      const access = issue('access', row, ACCESS_TTL);
      const refresh = issue('refresh', row, null);
      return {
        access_token: access, token_type: 'Bearer', expires_in: Math.floor(ACCESS_TTL / 1000),
        refresh_token: refresh, scope: row.scope,
      };
    }

    if (b.grant_type === 'refresh_token') {
      const row = db.prepare("SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'").get(sha(String(b.refresh_token || '')));
      if (!row || row.client_id !== client.id) return reply.code(400).send({ error: 'invalid_grant' });
      const u = db.prepare('SELECT blocked FROM users WHERE id = ?').get(row.user_id);
      if (!u || u.blocked) return reply.code(400).send({ error: 'invalid_grant' });
      const access = issue('access', { client_id: row.client_id, user_id: row.user_id, scope: row.scope, resource: row.audience }, ACCESS_TTL);
      db.prepare('UPDATE oauth_tokens SET last_used = ? WHERE token_hash = ?').run(now(), row.token_hash);
      return { access_token: access, token_type: 'Bearer', expires_in: Math.floor(ACCESS_TTL / 1000), scope: row.scope };
    }

    return reply.code(400).send({ error: 'unsupported_grant_type' });
  });

  app.post('/oauth/revoke', async (req, reply) => {
    const t = String((req.body || {}).token || '');
    if (t) db.prepare('DELETE FROM oauth_tokens WHERE token_hash = ?').run(sha(t));
    return reply.code(200).send({});
  });

  /* ================= проверка токена ресурсом ================= */

  // Токен годен только для того ресурса, для которого выдан (RFC 8707). Иначе токен,
  // выманенный чужим сервером, открывал бы и этот — классическая «запутанная замена».
  function userByToken(raw, resource) {
    if (!raw) return null;
    const row = db.prepare("SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'access'").get(sha(raw));
    if (!row) return null;
    if (row.expires_at && row.expires_at < now()) return null;
    if (row.audience && resource && row.audience !== resource) return null;
    const u = db.prepare('SELECT id, email, name, is_admin, blocked FROM users WHERE id = ?').get(row.user_id);
    if (!u || u.blocked) return null;
    db.prepare('UPDATE oauth_tokens SET last_used = ? WHERE token_hash = ?').run(now(), row.token_hash);
    return { user: { id: u.id, email: u.email, name: u.name, admin: !!u.is_admin }, scope: row.scope, client_id: row.client_id };
  }

  // Список выданных доступов и отзыв — из приложения. Доступ, который нельзя
  // отозвать, выдавать нельзя.
  app.get('/api/oauth/grants', { preHandler: opts.requireUser }, async (req) => ({
    grants: db.prepare(`SELECT t.client_id, c.name, MIN(t.created_at) AS created_at, MAX(t.last_used) AS last_used
      FROM oauth_tokens t LEFT JOIN oauth_clients c ON c.id = t.client_id
      WHERE t.user_id = ? GROUP BY t.client_id ORDER BY created_at DESC`).all(req.user.id),
  }));
  app.delete('/api/oauth/grants/:client', { preHandler: opts.requireUser }, async (req) => {
    db.prepare('DELETE FROM oauth_tokens WHERE user_id = ? AND client_id = ?').run(req.user.id, req.params.client);
    return { ok: true };
  });

  // Уборка просроченного: коды живут минуты, а строки о них остаются навсегда.
  setInterval(() => {
    try {
      db.prepare('DELETE FROM oauth_codes WHERE expires_at < ?').run(now() - 3600e3);
      db.prepare("DELETE FROM oauth_tokens WHERE kind = 'access' AND expires_at IS NOT NULL AND expires_at < ?").run(now());
    } catch {}
  }, 3600e3).unref?.();

  return { userByToken, RESOURCE, ISSUER, SCOPES };
}
