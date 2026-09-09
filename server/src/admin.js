// Админка. Админ ровно один — владелец сервиса, флаг ставится на сервере.
// Раздавать эту роль через интерфейс нельзя: это не «ещё одна роль», а полный
// доступ ко всем чужим доскам.
export function registerAdmin(app, db, deps) {
  const { requireAdmin } = deps;
  const now = () => Date.now();

  app.get('/api/admin/users', { preHandler: requireAdmin }, async () => ({
    users: db.prepare(`SELECT u.id, u.email, u.name, u.is_admin, u.blocked, u.created_at, u.last_seen,
        (SELECT COUNT(*) FROM boards b WHERE b.owner_id = u.id AND b.deleted = 0) AS boards
      FROM users u ORDER BY u.created_at DESC`).all(),
  }));

  // Все доски всех людей — то, ради чего админка и заводилась.
  app.get('/api/admin/boards', { preHandler: requireAdmin }, async (req) => ({
    boards: db.prepare(`SELECT b.id, b.name, b.nodes_count, b.links_count, b.deleted,
        b.created_at, b.updated_at, u.email AS owner_email, u.id AS owner_id
      FROM boards b LEFT JOIN users u ON u.id = b.owner_id
      ORDER BY b.updated_at DESC LIMIT 500`).all(),
  }));

  app.post('/api/admin/users', { preHandler: requireAdmin }, async (req, reply) => {
    const { email, password, name } = req.body || {};
    if (!email || !password) return reply.code(400).send({ error: 'нужны почта и пароль' });
    if (String(password).length < 8) return reply.code(400).send({ error: 'пароль от 8 символов' });
    const { hashPassword, newId } = await import('./auth.js');
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(String(email).trim())) {
      return reply.code(409).send({ error: 'такая почта уже есть' });
    }
    const id = newId('u');
    db.prepare('INSERT INTO users (id, email, name, pass_hash, created_at) VALUES (?,?,?,?,?)')
      .run(id, String(email).trim(), String(name || '').slice(0, 80), hashPassword(String(password)), now());
    return { id };
  });

  app.post('/api/admin/users/:id/password', { preHandler: requireAdmin }, async (req, reply) => {
    const { password } = req.body || {};
    if (!password || String(password).length < 8) return reply.code(400).send({ error: 'пароль от 8 символов' });
    const u = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
    if (!u) return reply.code(404).send({ error: 'нет такого пользователя' });
    const { hashPassword } = await import('./auth.js');
    db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(String(password)), u.id);
    // Сессии закрываются: сброс пароля должен выкидывать того, кто под ней сидел.
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    return { ok: true };
  });

  app.post('/api/admin/users/:id/block', { preHandler: requireAdmin }, async (req, reply) => {
    const on = (req.body || {}).blocked ? 1 : 0;
    const u = db.prepare('SELECT id, is_admin FROM users WHERE id = ?').get(req.params.id);
    if (!u) return reply.code(404).send({ error: 'нет такого пользователя' });
    // Себя заблокировать нельзя: иначе админ запирает сам себя снаружи,
    // а разблокировать некому — админ в системе один.
    if (u.id === req.user.id) return reply.code(400).send({ error: 'нельзя заблокировать самого себя' });
    db.prepare('UPDATE users SET blocked = ? WHERE id = ?').run(on, u.id);
    if (on) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    return { ok: true };
  });

  // Кто и когда открывал чужие доски. Без этого «админ может смотреть всё»
  // превращается в неконтролируемый доступ.
  app.get('/api/admin/access-log', { preHandler: requireAdmin }, async () => ({
    log: db.prepare(`SELECT l.at, l.action, l.board_id, u.email AS admin_email, b.name AS board_name
      FROM admin_access_log l LEFT JOIN users u ON u.id = l.admin_id
      LEFT JOIN boards b ON b.id = l.board_id
      ORDER BY l.at DESC LIMIT 200`).all(),
  }));

  app.get('/api/admin/stats', { preHandler: requireAdmin }, async () => {
    const one = (sql) => db.prepare(sql).get().c;
    return {
      users: one('SELECT COUNT(*) c FROM users'),
      boards: one('SELECT COUNT(*) c FROM boards WHERE deleted = 0'),
      trashed: one('SELECT COUNT(*) c FROM boards WHERE deleted = 1'),
      shares: one('SELECT COUNT(*) c FROM share_links WHERE revoked = 0'),
      sessions: one('SELECT COUNT(*) c FROM sessions WHERE expires_at > ' + now()),
      invites: one('SELECT COUNT(*) c FROM invites WHERE used_by IS NULL'),
    };
  });
}
