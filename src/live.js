// Живой канал доски: кто здесь сейчас, где их курсоры, что изменилось.
//
// Отдельный модуль, а не часть cloud.js: у сохранения и у присутствия разные
// жизненные циклы. Сохранение переживает потерю сети (очередь дождётся), а
// присутствие в оффлайне просто перестаёт существовать — и смешивать эти два
// поведения в одном месте значит получить очередь, которая падает вместе с сокетом.
let H = {};
export function initLive(host) { H = host; }

export const LIVE = {
  on: false,        // сокет открыт и поздоровался
  boardId: null,
  me: null,         // {id, name, color}
  peers: [],        // включая себя
  cursors: {},      // id -> {x, y, page, color, name, at}
};

let ws = null, tries = 0, reconnectT = null, closing = false;

const url = id => (location.protocol === 'https:' ? 'wss://' : 'ws://')
  + location.host + '/api/boards/' + encodeURIComponent(id) + '/live';

export function connect(boardId) {
  disconnect();
  if (!boardId) return;
  closing = false;
  LIVE.boardId = boardId;
  open();
}

function open() {
  if (!LIVE.boardId) return;
  try { ws = new WebSocket(url(LIVE.boardId)); } catch { schedule(); return; }

  ws.onopen = () => { tries = 0; };

  ws.onmessage = ev => {
    let m = null;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (!m || !m.t) return;
    if (m.t === 'hello') {
      LIVE.on = true; LIVE.me = m.you; LIVE.peers = m.peers || [];
      H.onPeers(LIVE.peers);
      return;
    }
    if (m.t === 'peers') {
      LIVE.peers = m.peers || [];
      // Курсор ушедшего должен исчезнуть вместе с ним, иначе на холсте
      // остаётся стрелка человека, который давно закрыл вкладку.
      const alive = new Set(LIVE.peers.map(p => p.id));
      for (const id of Object.keys(LIVE.cursors)) if (!alive.has(id)) delete LIVE.cursors[id];
      H.onPeers(LIVE.peers);
      H.onCursors(LIVE.cursors);
      return;
    }
    if (m.t === 'cursor') {
      if (LIVE.me && m.id === LIVE.me.id) return;
      LIVE.cursors[m.id] = {x: m.x, y: m.y, page: m.page, color: m.color, name: m.name, at: Date.now()};
      H.onCursors(LIVE.cursors);
      return;
    }
    // 'stale' — та же новость о новой версии, но без документа: он слишком велик,
    // чтобы рассылать его всем на каждое сохранение. Обработчик один и тот же,
    // отличает случаи он по отсутствию m.doc.
    if (m.t === 'update' || m.t === 'stale') { H.onUpdate(m); return; }
    if (m.t === 'error') { H.onError(m.error); try { ws.close(); } catch {} }
  };

  const gone = () => {
    LIVE.on = false;
    LIVE.peers = [];
    LIVE.cursors = {};
    H.onPeers([]);
    H.onCursors({});
    if (!closing) schedule();
  };
  ws.onclose = gone;
  ws.onerror = () => { try { ws.close(); } catch {} };
}

// Переподключение с растущей паузой. Без потолка вкладка, забытая открытой на
// ночь при упавшем сервере, долбила бы его тысячами попыток.
function schedule() {
  clearTimeout(reconnectT);
  const wait = Math.min(30000, 800 * Math.pow(1.7, Math.min(tries++, 8)));
  reconnectT = setTimeout(open, wait);
}

export function disconnect() {
  closing = true;
  clearTimeout(reconnectT);
  tries = 0;
  LIVE.on = false; LIVE.boardId = null; LIVE.me = null; LIVE.peers = []; LIVE.cursors = {};
  if (ws) { try { ws.close(); } catch {} ws = null; }
}

// Курсор шлём не чаще, чем раз в 60 мс: pointermove приходит на каждый пиксель,
// и без ограничения канал забивается движением мыши вместо работы.
let lastCur = 0;
export function sendCursor(x, y, page) {
  if (!LIVE.on || !ws || ws.readyState !== 1) return;
  const t = Date.now();
  if (t - lastCur < 60) return;
  lastCur = t;
  try { ws.send(JSON.stringify({t: 'cursor', x: Math.round(x), y: Math.round(y), page})); } catch {}
}

export function peersOther() {
  return LIVE.me ? LIVE.peers.filter(p => p.id !== LIVE.me.id) : LIVE.peers;
}
