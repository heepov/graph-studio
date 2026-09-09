// MCP-эндпоинт: один адрес /mcp, JSON-RPC поверх HTTP (Streamable HTTP).
//
// Реализовано вручную, без SDK. Причина та же, по которой в проекте нет argon2
// и Postgres: серверная часть держится на четырёх зависимостях, а нужный здесь
// срез протокола — это initialize, tools/list, tools/call и ping. Тащить ради
// них пакет с собственным жизненным циклом дороже, чем написать сто строк.
//
// Отвечаем и «старым» ревизиям (2025-03-26 … 2025-11-25, с рукопожатием
// initialize), и текущей 2026-07-28, где рукопожатия нет, а версия едет в каждом
// запросе. Клиенты Claude бывают разных поколений, и ронять коннектор из-за
// ревизии протокола — худший из возможных способов сломаться.
import { newToken } from '../auth.js';
import { TOOLS } from './tools.js';
import { DocError } from './doc.js';

const VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];
const SERVER_INFO = { name: 'graph-studio', title: 'Graph Studio', version: '1.0.0' };

const rpcOk = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcErr = (id, code, message, data) => ({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });

// Результат инструмента отдаём и текстом, и структурой: текст читает модель,
// structuredContent — клиент. Одного текста мало, одной структуры не понимает
// часть клиентов.
const toolResult = (obj) => ({
  content: [{ type: 'text', text: JSON.stringify(obj, null, 1) }],
  structuredContent: obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : { result: obj },
});
const toolFail = (msg) => ({ content: [{ type: 'text', text: msg }], isError: true });

export function registerMcp(app, db, deps) {
  const { boards, oauth, publicUrl } = deps;
  const RESOURCE = oauth.RESOURCE;

  const byName = new Map(TOOLS.map(t => [t.name, t]));
  const listed = TOOLS.map(t => ({
    name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema,
  }));

  /* ---------- доступ к доскам от имени владельца токена ---------- */

  function makeCtx(user) {
    // Доску можно назвать id или названием: модель видит в списке названия,
    // и требовать от неё id — значит гарантировать лишний круг запросов.
    function resolve(ref) {
      const s = String(ref || '').trim();
      if (!s) throw new DocError('нужно указать доску');
      const direct = db.prepare('SELECT * FROM boards WHERE id = ? AND deleted = 0').get(s);
      if (direct) return direct;
      const mine = db.prepare(`SELECT b.* FROM boards b
        LEFT JOIN board_members m ON m.board_id = b.id AND m.user_id = ?
        WHERE b.deleted = 0 AND (b.owner_id = ? OR m.user_id IS NOT NULL)`).all(user.id, user.id);
      const low = s.toLowerCase();
      const exact = mine.filter(b => String(b.name).toLowerCase() === low);
      const hits = exact.length ? exact : mine.filter(b => String(b.name).toLowerCase().startsWith(low));
      if (!hits.length) {
        throw new DocError(`доски «${s}» нет. Доступные: ${mine.map(b => b.name).join(', ') || '(ни одной)'}`);
      }
      // Несколько досок с одним названием — обычное дело. Сказать «уточните»
      // честнее, чем молча выбрать первую попавшуюся и править не ту доску.
      if (hits.length > 1) {
        throw new DocError(`под «${s}» подходит несколько досок — укажите id: ` +
          hits.map(b => `${b.name} (${b.id})`).join('; '));
      }
      return hits[0];
    }

    function load(ref) {
      const b = resolve(ref);
      const { board, role } = boards.access(user, b.id, 'mcp');
      if (!board || !boards.canRead(role)) throw new DocError('к этой доске нет доступа');
      return { board, role, doc: JSON.parse(board.doc) };
    }

    // Правка: прочитать → поменять → сохранить общим путём. Версия, история
    // и рассылка живой правки достаются от saveBoard, поэтому открытая вкладка
    // обновляется прямо во время разговора.
    function edit(ref, fn) {
      const { board, role, doc } = load(ref);
      if (!boards.canEdit(role)) throw new DocError(`доску «${board.name}» вам разрешено только смотреть`);
      const out = fn(doc) || {};
      doc.updated = new Date().toISOString().slice(0, 10);
      const saved = boards.saveBoard(board, user, doc, { summary: out.summary || 'правка из Claude' });
      return { board: board.name, version: saved.version, url: publicUrl + '/b/' + board.id, ...(out.result || {}) };
    }

    return { db, user, boards, publicUrl, newToken, load, edit, resolve };
  }

  /* ---------- разбор JSON-RPC ---------- */

  async function handle(msg, user) {
    const id = msg.id;
    const method = String(msg.method || '');
    const params = msg.params || {};

    if (method === 'initialize') {
      const want = String(params.protocolVersion || '');
      return rpcOk(id, {
        protocolVersion: VERSIONS.includes(want) ? want : VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: 'Доски Graph Studio: список — list_boards, содержимое — get_board. ' +
          'Узлы общие для всех страниц доски; страница задаёт фильтр и способ показа. ' +
          'Связь from → to читается как «from держит to».',
      });
    }
    // 2026-07-28: рукопожатия нет, вместо него необязательный опрос возможностей.
    if (method === 'server/discover') {
      return rpcOk(id, { protocolVersions: VERSIONS, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    if (method === 'ping') return rpcOk(id, {});
    if (method === 'tools/list') return rpcOk(id, { tools: listed });
    if (method === 'resources/list') return rpcOk(id, { resources: [] });
    if (method === 'prompts/list') return rpcOk(id, { prompts: [] });

    if (method === 'tools/call') {
      const tool = byName.get(String(params.name || ''));
      if (!tool) return rpcOk(id, toolFail(`Инструмента «${params.name}» нет. Есть: ${TOOLS.map(t => t.name).join(', ')}`));
      try {
        const out = await tool.handler(makeCtx(user), params.arguments || {});
        return rpcOk(id, toolResult(out));
      } catch (e) {
        // Ошибка инструмента — это НЕ ошибка протокола: модель должна её увидеть
        // и исправиться, а не получить обрыв связи. Поэтому isError, а не rpcErr.
        if (e instanceof DocError) return rpcOk(id, toolFail(e.message));
        app.log.error({ err: e.message, tool: tool.name }, 'MCP: инструмент упал');
        return rpcOk(id, toolFail('Не получилось: ' + e.message));
      }
    }
    return rpcErr(id, -32601, `Метод ${method} не поддерживается`);
  }

  /* ---------- HTTP ---------- */

  const challenge = (reply, code, extra) => {
    reply.header('WWW-Authenticate',
      `Bearer resource_metadata="${publicUrl}/.well-known/oauth-protected-resource", ` +
      `scope="${oauth.SCOPES.join(' ')}"` + (extra ? ', ' + extra : ''));
    return reply.code(code);
  };

  app.post('/mcp', async (req, reply) => {
    // Origin проверяем мягко: подделка DNS опасна там, где сервер пускает по кукам.
    // Здесь пускают по Bearer-токену, которого у чужой страницы нет, поэтому
    // отсекаем только заведомо небезопасную схему.
    const origin = req.headers.origin;
    if (origin && !/^https:\/\//i.test(origin)) {
      return reply.code(403).send(rpcErr(null, -32000, 'origin не по https'));
    }

    const auth = String(req.headers.authorization || '');
    const token = /^Bearer /i.test(auth) ? auth.slice(7).trim() : null;
    const found = oauth.userByToken(token, RESOURCE);
    if (!found) {
      return challenge(reply, 401, token ? 'error="invalid_token"' : null)
        .send(rpcErr(null, -32001, 'нужен вход: получите токен по OAuth'));
    }

    const body = req.body;
    if (!body || typeof body !== 'object') return reply.code(400).send(rpcErr(null, -32700, 'ждём JSON-RPC'));

    // Уведомление (без id) подтверждается пустым 202: ответа на него не бывает.
    const one = async m => {
      if (m.id === undefined || m.id === null) return null;
      return handle(m, found.user);
    };

    if (Array.isArray(body)) {
      const out = [];
      for (const m of body) { const r = await one(m); if (r) out.push(r); }
      return out.length ? reply.send(out) : reply.code(202).send();
    }
    const r = await one(body);
    if (!r) return reply.code(202).send();
    return reply.send(r);
  });

  // Ревизия 2026-07-28 убрала и отдельный SSE-поток по GET, и сессии.
  // Старые клиенты это пробуют — спецификация велит отвечать им 405, и они
  // спокойно продолжают работать одними POST.
  const gone = async (req, reply) => reply.code(405).send({ error: 'этот адрес принимает только POST' });
  app.get('/mcp', gone);
  app.delete('/mcp', gone);

  return { TOOLS };
}
