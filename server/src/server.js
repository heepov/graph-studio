import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { getDb } from './db.js';
import { hashPassword, verifyPassword, newToken, newId, sessionCookie, SESSION_DAYS } from './auth.js';
import { mkdirSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';

const db = getDb();
const now = () => Date.now();

const app = Fastify({
  // Перед api стоят ДВА прокси: host-nginx и nginx в контейнере. Без trustProxy
  // ограничитель попыток входа видел бы у всех один и тот же внутренний адрес
  // и блокировал бы всех разом после чужих неудачных попыток.
  trustProxy: 2,
  bodyLimit: 32 * 1024 * 1024,   // документы досок ходят целиком
  logger: { level: process.env.LOG_LEVEL || 'info' },
});

await app.register(cookie);
await app.register(rateLimit, { global: false });

/* ---------- сессии ---------- */
const qSession = db.prepare(`SELECT s.token, s.expires_at, u.id, u.email, u.name, u.is_admin, u.blocked
  FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`);
const qTouch = db.prepare('UPDATE users SET last_seen = ? WHERE id = ?');

app.decorateRequest('user', null);
app.addHook('preHandler', async (req) => {
  const t = req.cookies.gs_session;
  if (!t) return;
  const s = qSession.get(t);
  if (!s || s.expires_at < now() || s.blocked) return;
  req.user = { id: s.id, email: s.email, name: s.name, admin: !!s.is_admin };
  qTouch.run(now(), s.id);
});

const requireUser = async (req, reply) => {
  if (!req.user) { reply.code(401).send({ error: 'нужен вход' }); return reply; }
};
const requireAdmin = async (req, reply) => {
  if (!req.user) { reply.code(401).send({ error: 'нужен вход' }); return reply; }
  if (!req.user.admin) { reply.code(403).send({ error: 'только для администратора' }); return reply; }
};

/* ---------- здоровье ---------- */
// /healthz из nginx — это литерал, он не доказывает ничего. Этот эндпоинт трогает
// базу и отдаёт версию применённой схемы: только он и подтверждает, что деплой живой.
app.get('/api/health', async () => {
  const v = db.prepare('SELECT COALESCE(MAX(version), 0) v FROM schema_migrations').get().v;
  const users = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  return { ok: true, schema: v, users, build: process.env.BUILD_SHA || 'dev', at: new Date().toISOString() };
});

/* ---------- вход и регистрация ---------- */
const startSession = (reply, userId, ua) => {
  const token = newToken();
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at, user_agent) VALUES (?,?,?,?,?)')
    .run(token, userId, now(), now() + SESSION_DAYS * 864e5, (ua || '').slice(0, 200));
  reply.setCookie('gs_session', token, sessionCookie);
};

const publicUser = u => ({ id: u.id, email: u.email, name: u.name, admin: !!u.is_admin });

app.post('/api/auth/login', {
  // Ограничитель именно здесь: вход — единственная точка, где перебор имеет смысл.
  config: { rateLimit: { max: 10, timeWindow: '5 minutes' } },
}, async (req, reply) => {
  const { email, password } = req.body || {};
  if (!email || !password) return reply.code(400).send({ error: 'нужны почта и пароль' });
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).trim());
  // Одинаковый ответ на «нет такого» и «неверный пароль»: иначе форма входа
  // превращается в проверялку, есть ли у человека аккаунт.
  if (!u || u.blocked || !verifyPassword(password, u.pass_hash)) {
    return reply.code(401).send({ error: 'неверная почта или пароль' });
  }
  startSession(reply, u.id, req.headers['user-agent']);
  return { user: publicUser(u) };
});

app.post('/api/auth/logout', async (req, reply) => {
  const t = req.cookies.gs_session;
  if (t) db.prepare('DELETE FROM sessions WHERE token = ?').run(t);
  reply.clearCookie('gs_session', { path: '/' });
  return { ok: true };
});

app.get('/api/auth/me', async (req) => ({ user: req.user || null }));

// Смена своего пароля. Нужна в том числе чтобы убрать сгенерированный при первом
// запуске: пока он не сменён, он лежит открытым текстом в файле внутри тома.
app.post('/api/auth/password', {
  preHandler: requireUser,
  config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
}, async (req, reply) => {
  const { current, next } = req.body || {};
  if (!next || String(next).length < 8) return reply.code(400).send({ error: 'новый пароль от 8 символов' });
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!verifyPassword(String(current || ''), u.pass_hash)) {
    return reply.code(403).send({ error: 'текущий пароль неверен' });
  }
  db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(String(next)), u.id);
  // Все прочие сессии этого человека закрываются: смена пароля должна выкидывать
  // того, кто увёл сессию, иначе она бессмысленна.
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(u.id, req.cookies.gs_session || '');
  if (u.is_admin) { try { unlinkSync('/data/FIRST_RUN.txt'); } catch {} }
  return { ok: true };
});

// Регистрация только по приглашению: сайт открыт в интернете, и открытая
// регистрация означала бы чужие аккаунты на личном сервере.
app.post('/api/auth/register', {
  config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
}, async (req, reply) => {
  const { email, password, name, invite } = req.body || {};
  if (!email || !password) return reply.code(400).send({ error: 'нужны почта и пароль' });
  if (String(password).length < 8) return reply.code(400).send({ error: 'пароль от 8 символов' });
  if (!invite) return reply.code(403).send({ error: 'регистрация только по приглашению' });

  const inv = db.prepare('SELECT * FROM invites WHERE token = ?').get(invite);
  if (!inv || inv.used_by || (inv.expires_at && inv.expires_at < now())) {
    return reply.code(403).send({ error: 'приглашение недействительно' });
  }
  if (inv.email && String(inv.email).toLowerCase() !== String(email).trim().toLowerCase()) {
    return reply.code(403).send({ error: 'приглашение выписано на другую почту' });
  }
  const exists = db.prepare('SELECT 1 FROM users WHERE email = ?').get(String(email).trim());
  if (exists) return reply.code(409).send({ error: 'такая почта уже зарегистрирована' });

  const id = newId('u');
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO users (id, email, name, pass_hash, created_at) VALUES (?,?,?,?,?)')
      .run(id, String(email).trim(), String(name || '').slice(0, 80), hashPassword(String(password)), now());
    db.prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE token = ?').run(id, now(), invite);
  });
  tx();
  startSession(reply, id, req.headers['user-agent']);
  return { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)) };
});

/* ---------- приглашения ---------- */
app.post('/api/invites', { preHandler: requireAdmin }, async (req) => {
  const { email, days } = req.body || {};
  const token = newToken();
  db.prepare('INSERT INTO invites (token, email, created_by, created_at, expires_at) VALUES (?,?,?,?,?)')
    .run(token, email ? String(email).trim() : null, req.user.id, now(),
         days ? now() + (+days) * 864e5 : now() + 14 * 864e5);
  return { token };
});

app.get('/api/invites', { preHandler: requireAdmin }, async () => ({
  invites: db.prepare(`SELECT i.token, i.email, i.created_at, i.expires_at, i.used_at, u.email AS used_by_email
    FROM invites i LEFT JOIN users u ON u.id = i.used_by ORDER BY i.created_at DESC LIMIT 200`).all(),
}));

app.get('/api/invites/:token', async (req, reply) => {
  const inv = db.prepare('SELECT email, expires_at, used_by FROM invites WHERE token = ?').get(req.params.token);
  if (!inv || inv.used_by || (inv.expires_at && inv.expires_at < now())) {
    return reply.code(404).send({ error: 'приглашение недействительно' });
  }
  return { email: inv.email || null };
});

/* ---------- 404 под /api/ отдаёт JSON, а не HTML ---------- */
// Иначе клиентский res.json() падает с «Unexpected token '<'», а настоящая причина
// (упавший маршрут, промах nginx, подмена service worker'ом) остаётся невидимой.
app.setNotFoundHandler(async (req, reply) => {
  reply.code(404).send({ error: 'не найдено', path: req.url });
});

/* ---------- резервные копии ---------- */
// Бэкапов не было вообще: пока данные жили в браузере, это было нормально.
// С момента, когда сервер стал единственным хранилищем, их отсутствие означает,
// что один rm или один сбой диска стирает всё безвозвратно.
//
// Делается прямо в процессе api, отдельным контейнером с cron — не нужно:
// VACUUM INTO даёт согласованную копию без остановки записи, а лишний контейнер
// это лишняя вещь, которая может тихо не работать.
const BACKUP_DIR = process.env.BACKUP_DIR || '/data/backups';
const BACKUP_KEEP = +(process.env.BACKUP_KEEP || 14);
function makeBackup(tag) {
  try {
    mkdirSync(BACKUP_DIR, { recursive: true });
    const d = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const to = join(BACKUP_DIR, `${tag}-${d}.sqlite`);
    db.prepare('VACUUM INTO ?').run(to);
    const mine = readdirSync(BACKUP_DIR).filter(f => f.startsWith(tag + '-')).sort();
    for (const f of mine.slice(0, Math.max(0, mine.length - BACKUP_KEEP))) {
      try { unlinkSync(join(BACKUP_DIR, f)); } catch {}
    }
    app.log.info({ file: to, kept: Math.min(mine.length + 1, BACKUP_KEEP) }, 'резервная копия');
    return to;
  } catch (e) {
    app.log.error({ err: e.message }, 'не удалось сделать резервную копию');
    return null;
  }
}
// первая копия через минуту после старта, дальше раз в сутки
setTimeout(() => makeBackup('daily'), 60_000).unref?.();
setInterval(() => makeBackup('daily'), 24 * 3600 * 1000).unref?.();

// Ручная копия и список — чтобы можно было снять слепок перед рискованной операцией
// и убедиться, что копии вообще создаются, не заходя на сервер.
app.post('/api/admin/backup', { preHandler: requireAdmin }, async (req, reply) => {
  const f = makeBackup('manual');
  if (!f) return reply.code(500).send({ error: 'не удалось создать копию' });
  return { file: f.split('/').pop() };
});
app.get('/api/admin/backups', { preHandler: requireAdmin }, async () => {
  try {
    return {
      dir: BACKUP_DIR,
      files: readdirSync(BACKUP_DIR).filter(f => f.endsWith('.sqlite')).sort().reverse().slice(0, 50)
        .map(f => ({ name: f, size: statSync(join(BACKUP_DIR, f)).size })),
    };
  } catch (e) { return { dir: BACKUP_DIR, files: [], error: e.message }; }
});

const port = +(process.env.PORT || 3000);
await app.listen({ host: '0.0.0.0', port });
app.log.info(`graph-studio api на :${port}`);
