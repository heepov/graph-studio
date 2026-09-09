// Доски: хранение, доступ, ссылки.
//
// Документ хранится как есть, ТЕКСТОМ. Сервер его не разбирает — только считает
// пару чисел для списка. Это сознательно: формат документа принадлежит клиенту
// и будет меняться, а сервер не должен ломаться от каждого нового поля.
import { newToken, newId } from './auth.js';

const now = () => Date.now();

export function registerBoards(app, db, deps) {
  const { requireUser } = deps;

  /* ---------- доступ ---------- */
  // Роль человека на доске. Админ видит всё, но его доступ помечается отдельно
  // и пишется в журнал: «админ смотрел чужое» не должно смешиваться с обычной работой.
  const qBoard = db.prepare('SELECT * FROM boards WHERE id = ?');
  const qMember = db.prepare('SELECT role FROM board_members WHERE board_id = ? AND user_id = ?');
  const logAdmin = db.prepare('INSERT INTO admin_access_log (admin_id, board_id, at, action) VALUES (?,?,?,?)');

  function access(user, boardId, action) {
    const b = qBoard.get(boardId);
    if (!b) return { board: null, role: null };
    if (!user) return { board: b, role: null };
    if (b.owner_id === user.id) return { board: b, role: 'owner' };
    const m = qMember.get(boardId, user.id);
    if (m) return { board: b, role: m.role };
    if (user.admin) {
      try { logAdmin.run(user.id, boardId, now(), action || 'open'); } catch {}
      return { board: b, role: 'admin', asAdmin: true };
    }
    return { board: b, role: null };
  }
  const canEdit = r => r === 'owner' || r === 'editor' || r === 'admin';
  const canRead = r => canEdit(r) || r === 'viewer';

  // Из документа нужны только два числа для карточки в списке. Если документ
  // окажется не тем, что мы ждём, — это не повод падать: пишем нули.
  function counts(docText) {
    try {
      const d = JSON.parse(docText);
      return { n: Array.isArray(d.nodes) ? d.nodes.length : 0, l: Array.isArray(d.links) ? d.links.length : 0 };
    } catch { return { n: 0, l: 0 }; }
  }
  const nameOf = docText => {
    try { return String(JSON.parse(docText).name || '').slice(0, 200); } catch { return ''; }
  };

  /* ---------- список ---------- */
  app.get('/api/boards', { preHandler: requireUser }, async (req) => {
    const mine = db.prepare(`SELECT id, name, nodes_count, links_count, updated_at, created_at, 'owner' AS role
      FROM boards WHERE owner_id = ? AND deleted = 0 ORDER BY updated_at DESC`).all(req.user.id);
    const shared = db.prepare(`SELECT b.id, b.name, b.nodes_count, b.links_count, b.updated_at, b.created_at,
        m.role, u.email AS owner_email
      FROM board_members m JOIN boards b ON b.id = m.board_id
      LEFT JOIN users u ON u.id = b.owner_id
      WHERE m.user_id = ? AND b.deleted = 0 AND b.owner_id != ?
      ORDER BY b.updated_at DESC`).all(req.user.id, req.user.id);
    const trashed = db.prepare(`SELECT id, name, updated_at FROM boards
      WHERE owner_id = ? AND deleted = 1 ORDER BY updated_at DESC LIMIT 50`).all(req.user.id);
    return { mine, shared, trashed };
  });

  /* ---------- создание ---------- */
  app.post('/api/boards', { preHandler: requireUser }, async (req, reply) => {
    const doc = req.body && req.body.doc;
    if (!doc || typeof doc !== 'object') return reply.code(400).send({ error: 'нужен документ доски' });
    const text = JSON.stringify(doc);
    const c = counts(text);
    const id = newId('b');
    const t = now();
    db.prepare(`INSERT INTO boards (id, owner_id, name, doc, version, nodes_count, links_count, created_at, updated_at, updated_by)
      VALUES (?,?,?,?,1,?,?,?,?,?)`).run(id, req.user.id, nameOf(text) || 'Доска', text, c.n, c.l, t, t, req.user.id);
    db.prepare('INSERT INTO board_members (board_id, user_id, role, added_at) VALUES (?,?,?,?)')
      .run(id, req.user.id, 'owner', t);
    return { id, version: 1 };
  });

  /* ---------- чтение ---------- */
  app.get('/api/boards/:id', { preHandler: requireUser }, async (req, reply) => {
    const { board, role, asAdmin } = access(req.user, req.params.id, 'open');
    if (!board || !canRead(role)) return reply.code(404).send({ error: 'доска не найдена' });
    if (board.deleted && role !== 'owner' && !asAdmin) return reply.code(404).send({ error: 'доска не найдена' });
    return {
      id: board.id, version: board.version, role, asAdmin: !!asAdmin,
      doc: JSON.parse(board.doc),
      updated_at: board.updated_at,
    };
  });

  /* ---------- запись ---------- */
  // Оптимистическая блокировка: клиент присылает версию, от которой правил.
  // Если на сервере уже другая — отдаём 409 и АКТУАЛЬНЫЙ документ, чтобы клиент
  // мог слить изменения, а не потерять чужие. Молчаливая перезапись тут недопустима:
  // это ровно тот случай, когда «победил последний» стирает чужую работу целиком.
  app.put('/api/boards/:id', { preHandler: requireUser }, async (req, reply) => {
    const { board, role } = access(req.user, req.params.id, 'edit');
    if (!board || !canRead(role)) return reply.code(404).send({ error: 'доска не найдена' });
    if (!canEdit(role)) return reply.code(403).send({ error: 'только просмотр' });

    const { doc, baseVersion } = req.body || {};
    if (!doc || typeof doc !== 'object') return reply.code(400).send({ error: 'нужен документ доски' });
    if (baseVersion != null && +baseVersion !== board.version) {
      return reply.code(409).send({
        error: 'на сервере более новая версия',
        version: board.version,
        doc: JSON.parse(board.doc),
        updated_at: board.updated_at,
      });
    }
    const text = JSON.stringify(doc);
    const c = counts(text);
    const t = now();
    const v = board.version + 1;
    db.prepare(`UPDATE boards SET doc = ?, version = ?, name = ?, nodes_count = ?, links_count = ?,
      updated_at = ?, updated_by = ? WHERE id = ?`)
      .run(text, v, nameOf(text) || board.name, c.n, c.l, t, req.user.id, board.id);
    return { version: v, updated_at: t };
  });

  /* ---------- корзина ---------- */
  app.delete('/api/boards/:id', { preHandler: requireUser }, async (req, reply) => {
    const { board, role } = access(req.user, req.params.id, 'delete');
    if (!board || role !== 'owner') return reply.code(403).send({ error: 'удалять может только владелец' });
    db.prepare('UPDATE boards SET deleted = 1, updated_at = ? WHERE id = ?').run(now(), board.id);
    return { ok: true };
  });
  app.post('/api/boards/:id/restore', { preHandler: requireUser }, async (req, reply) => {
    const { board, role } = access(req.user, req.params.id, 'restore');
    if (!board || role !== 'owner') return reply.code(403).send({ error: 'только владелец' });
    db.prepare('UPDATE boards SET deleted = 0, updated_at = ? WHERE id = ?').run(now(), board.id);
    return { ok: true };
  });

  /* ---------- ссылки-доступы ---------- */
  app.post('/api/boards/:id/shares', { preHandler: requireUser }, async (req, reply) => {
    const { board, role } = access(req.user, req.params.id, 'share');
    if (!board || (role !== 'owner' && role !== 'admin')) return reply.code(403).send({ error: 'только владелец' });
    const wanted = (req.body || {}).role === 'editor' ? 'editor' : 'viewer';
    const days = +((req.body || {}).days || 0);
    const token = newToken();
    db.prepare('INSERT INTO share_links (token, board_id, role, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?)')
      .run(token, board.id, wanted, req.user.id, now(), days > 0 ? now() + days * 864e5 : null);
    return { token, role: wanted, path: (wanted === 'editor' ? '/e/' : '/s/') + token };
  });

  app.get('/api/boards/:id/shares', { preHandler: requireUser }, async (req, reply) => {
    const { board, role } = access(req.user, req.params.id, 'shares');
    if (!board || (role !== 'owner' && role !== 'admin')) return reply.code(403).send({ error: 'только владелец' });
    return {
      shares: db.prepare(`SELECT token, role, created_at, expires_at, revoked FROM share_links
        WHERE board_id = ? ORDER BY created_at DESC`).all(board.id),
      members: db.prepare(`SELECT u.email, u.name, m.role, m.added_at FROM board_members m
        JOIN users u ON u.id = m.user_id WHERE m.board_id = ? ORDER BY m.added_at`).all(board.id),
    };
  });

  app.delete('/api/shares/:token', { preHandler: requireUser }, async (req, reply) => {
    const sh = db.prepare('SELECT * FROM share_links WHERE token = ?').get(req.params.token);
    if (!sh) return reply.code(404).send({ error: 'ссылка не найдена' });
    const { role } = access(req.user, sh.board_id, 'revoke');
    if (role !== 'owner' && role !== 'admin') return reply.code(403).send({ error: 'только владелец' });
    db.prepare('UPDATE share_links SET revoked = 1 WHERE token = ?').run(req.params.token);
    return { ok: true };
  });

  // Переход по ссылке. Просмотр — можно без входа; правка — только после входа,
  // иначе у изменения не будет настоящего автора и история «кто что поменял»
  // выродится в «гость по ссылке».
  app.get('/api/share/:token', async (req, reply) => {
    const sh = db.prepare('SELECT * FROM share_links WHERE token = ?').get(req.params.token);
    if (!sh || sh.revoked || (sh.expires_at && sh.expires_at < now())) {
      return reply.code(404).send({ error: 'ссылка недействительна' });
    }
    const b = qBoard.get(sh.board_id);
    if (!b || b.deleted) return reply.code(404).send({ error: 'доска недоступна' });

    if (sh.role === 'editor') {
      if (!req.user) return reply.code(401).send({ error: 'нужен вход', needAuth: true, boardName: b.name });
      // Вошедший по ссылке на правку становится участником доски: дальше он найдёт
      // её в своём списке и не будет зависеть от сохранённой ссылки.
      const has = qMember.get(b.id, req.user.id);
      if (!has && b.owner_id !== req.user.id) {
        db.prepare('INSERT INTO board_members (board_id, user_id, role, added_at) VALUES (?,?,?,?)')
          .run(b.id, req.user.id, 'editor', now());
      }
      return { id: b.id, role: 'editor', name: b.name };
    }
    return { id: b.id, role: 'viewer', name: b.name, doc: JSON.parse(b.doc), version: b.version };
  });

  return { access, canEdit, canRead };
}
