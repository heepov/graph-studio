// Совместное редактирование: кто сейчас на доске и что там поменялось.
//
// Протокол намеренно простой. CRDT здесь не нужен: документ целиком принадлежит
// клиенту, правки уезжают целым состоянием с оптимистической блокировкой, а
// расхождение версий уже разбирается диалогом «взять серверную / отправить свою».
// Живой канал добавляет к этому две вещи, которых не хватало:
//
//   1) чужая правка приезжает сразу, а не когда ты сам решишь сохранить;
//   2) видно, что ты на доске не один.
//
// Сообщение об изменении несёт документ целиком — вместе с ним, а не «сходи
// забери». Иначе каждая правка превращалась бы в N запросов GET от всех открытых
// вкладок, то есть в то же количество байт, но с задержкой и лишним кругом.
const rooms = new Map();   // boardId -> Set<conn>

// Цвет участника — детерминированный от id: человек должен узнаваться по цвету
// между сессиями, а не перекрашиваться при каждом подключении.
const COLORS = ['#4262ff', '#0f8f6a', '#d2740c', '#8b46c9', '#b3261e', '#0a7d8c', '#c9a227', '#c94690'];
export function colorFor(id) {
  let h = 0;
  for (let i = 0; i < String(id).length; i++) h = (h * 31 + String(id).charCodeAt(i)) >>> 0;
  return COLORS[h % COLORS.length];
}

const peerOf = c => ({ id: c.gsUser.id, name: c.gsUser.name || c.gsUser.email, email: c.gsUser.email,
  color: colorFor(c.gsUser.id), role: c.gsRole });

function send(conn, obj) {
  try { conn.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); } catch {}
}

// Всем в комнате, кроме указанного соединения. Строку не пересобираем на каждого:
// документ может быть в сотню килобайт, и K раз JSON.stringify — это K раз впустую.
export function broadcast(boardId, payload, except) {
  const room = rooms.get(boardId);
  if (!room) return 0;
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  let n = 0;
  for (const c of room) { if (c !== except) { send(c, text); n++; } }
  return n;
}

function peersMsg(boardId) {
  const room = rooms.get(boardId) || new Set();
  return { t: 'peers', peers: [...room].map(peerOf) };
}

// Сколько человек на доске — нужно и списку досок, и тестам.
export function peerCount(boardId) {
  const room = rooms.get(boardId);
  return room ? room.size : 0;
}

export function registerLive(app, db, deps) {
  const { access, canRead } = deps;

  app.get('/api/boards/:id/live', { websocket: true }, (conn, req) => {
    const boardId = req.params.id;
    // Прав спрашиваем ровно те же, что и у чтения доски: живой канал не должен
    // быть дырой, через которую видно то, что по HTTP не отдаётся.
    if (!req.user) { send(conn, { t: 'error', error: 'нужен вход' }); conn.close(); return; }
    const { board, role } = access(req.user, boardId, 'live');
    if (!board || board.deleted || !canRead(role)) {
      send(conn, { t: 'error', error: 'доска недоступна' }); conn.close(); return;
    }

    conn.gsUser = req.user;
    conn.gsRole = role;
    conn.gsBoard = boardId;

    let room = rooms.get(boardId);
    if (!room) { room = new Set(); rooms.set(boardId, room); }
    room.add(conn);

    send(conn, { t: 'hello', you: peerOf(conn), version: board.version, peers: peersMsg(boardId).peers });
    broadcast(boardId, peersMsg(boardId), null);

    conn.on('message', raw => {
      let m = null;
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (!m || typeof m.t !== 'string') return;
      // Курсор — единственное, что клиент шлёт по этому каналу. Он НЕ хранится:
      // это состояние момента, и место ему в сети, а не в базе.
      if (m.t === 'cursor') {
        broadcast(boardId, { t: 'cursor', id: conn.gsUser.id, page: String(m.page || '').slice(0, 60),
          x: +m.x || 0, y: +m.y || 0, color: colorFor(conn.gsUser.id),
          name: conn.gsUser.name || conn.gsUser.email }, conn);
        return;
      }
      if (m.t === 'bye') { try { conn.close(); } catch {} }
    });

    const drop = () => {
      const r = rooms.get(boardId);
      if (!r) return;
      r.delete(conn);
      if (!r.size) rooms.delete(boardId);
      else broadcast(boardId, peersMsg(boardId), null);
    };
    conn.on('close', drop);
    conn.on('error', drop);
  });
}

// Сообщение о новой версии. Собирается строкой, чтобы уже сериализованный
// документ не проходить через JSON.stringify второй раз.
export function updateMessage(version, at, by, docText, summary) {
  return '{"t":"update","version":' + version + ',"at":' + at +
    ',"by":' + JSON.stringify(by) +
    ',"summaryText":' + JSON.stringify(summary || null) +
    ',"doc":' + docText + '}';
}
