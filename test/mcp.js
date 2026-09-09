// Коннектор для Claude: OAuth целиком и все инструменты MCP.
//
// Без браузера — обычный fetch по тому же адресу, что и настоящий клиент, то есть
// через nginx. Заодно проверяется, что /mcp, /oauth/ и /.well-known/ не съедает
// SPA-фолбэк: до отдельных location там приходил index.html вместо JSON, и клиент
// падал на разборе HTML.
//
// Набор СОЗДАЁТ данные (клиента, токены, доску), поэтому только против локального контейнера.
const { createHash, randomBytes } = require('node:crypto');
const { execSync } = require('node:child_process');

const BASE = (process.env.APP_URL || 'http://127.0.0.1:8081/').replace(/\/$/, '');
const results = [];
const ok = (n, d = '') => { results.push(['✓', n, d]); console.log('✓', n, d); };
const bad = (n, d = '') => { results.push(['✗', n, d]); console.log('✗', n, d); };

const b64u = b => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sha = s => b64u(createHash('sha256').update(s).digest());

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

async function json(path, opts = {}) {
  const r = await fetch(BASE + path, opts);
  const type = r.headers.get('content-type') || '';
  let body = null;
  try { body = /json/.test(type) ? await r.json() : (await r.text()).slice(0, 300); } catch {}
  return { status: r.status, type, body, headers: r.headers };
}

(async () => {
  try {
    const pass = (execSync('docker compose exec -T api node scripts/admin.js reset-password kaitnik@gmail.com')
      .toString().match(/пароль для \S+: (\S+)/) || [])[1];
    if (!pass) throw new Error('не удалось получить пароль администратора');

    // Доски прошлых прогонов мешают проверке поиска по названию: две доски
    // с одним именем — это как раз тот случай, когда сервер отказывается гадать.
    execSync(`docker compose exec -T api node -e "
      const db = require('better-sqlite3')('/data/graphstudio.sqlite');
      db.prepare('DELETE FROM boards WHERE name LIKE ?').run('MCP-проверка%');
    "`);

    /* ---------- метаданные ---------- */
    const prm = await json('/.well-known/oauth-protected-resource');
    (prm.status === 200 && /json/.test(prm.type) && prm.body.authorization_servers)
      ? ok('метаданные ресурса отдаются JSON, а не оболочкой приложения', prm.body.resource)
      : bad('метаданные ресурса сломаны', JSON.stringify(prm).slice(0, 200));

    const asm = await json('/.well-known/oauth-authorization-server');
    (asm.status === 200 && asm.body.authorization_endpoint && asm.body.code_challenge_methods_supported.includes('S256')
      && !asm.body.code_challenge_methods_supported.includes('plain'))
      ? ok('метаданные сервера авторизации на месте, PKCE только S256')
      : bad('метаданные авторизации сломаны', JSON.stringify(asm.body).slice(0, 200));

    /* ---------- без токена ---------- */
    const anon = await json('/mcp', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const wa = anon.headers.get('www-authenticate') || '';
    (anon.status === 401 && /resource_metadata=/.test(wa))
      ? ok('без токена — 401 и адрес, где взять токен')
      : bad('незащищённый MCP или нет подсказки', anon.status + ' ' + wa);

    /* ---------- регистрация клиента ---------- */
    const reg = await json('/oauth/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Тестовый Claude', redirect_uris: [REDIRECT] }),
    });
    (reg.status === 201 && reg.body.client_id)
      ? ok('клиент регистрируется сам (RFC 7591)', reg.body.client_id)
      : bad('регистрация клиента сломана', JSON.stringify(reg.body).slice(0, 200));
    const clientId = reg.body.client_id;

    const badUri = await json('/oauth/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Плохой', redirect_uris: ['http://evil.example.com/cb'] }),
    });
    badUri.status === 400 ? ok('адрес возврата по http наружу не принимается')
                          : bad('http-адрес возврата приняли', String(badUri.status));

    /* ---------- согласие и код ---------- */
    const verifier = b64u(randomBytes(32));
    const challenge = sha(verifier);
    const authQ = new URLSearchParams({
      client_id: clientId, redirect_uri: REDIRECT, response_type: 'code',
      scope: 'boards.read boards.write', state: 'st123',
      code_challenge: challenge, code_challenge_method: 'S256',
      resource: BASE + '/mcp',
    });

    const noPkce = await json('/oauth/authorize?' + new URLSearchParams({
      client_id: clientId, redirect_uri: REDIRECT, response_type: 'code',
    }), { redirect: 'manual' });
    (noPkce.status === 302 && /error=invalid_request/.test(noPkce.headers.get('location') || ''))
      ? ok('без PKCE авторизация отклоняется')
      : bad('PKCE не обязателен', String(noPkce.status));

    const wrongUri = await json('/oauth/authorize?' + new URLSearchParams({
      client_id: clientId, redirect_uri: 'https://evil.example.com/cb', response_type: 'code',
      code_challenge: challenge, code_challenge_method: 'S256',
    }), { redirect: 'manual' });
    (wrongUri.status === 400 && !wrongUri.headers.get('location'))
      ? ok('чужой адрес возврата не открывает редирект')
      : bad('открытый редирект', String(wrongUri.status) + ' ' + wrongUri.headers.get('location'));

    // Вход и согласие одной формой — ровно как это делает человек в браузере.
    const form = new URLSearchParams(authQ);
    form.set('decision', 'login');
    form.set('email', 'kaitnik@gmail.com');
    form.set('password', pass);
    const loginRes = await fetch(BASE + '/oauth/authorize', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(), redirect: 'manual',
    });
    const cookie = (loginRes.headers.getSetCookie ? loginRes.headers.getSetCookie() : [])
      .map(c => c.split(';')[0]).join('; ');
    const consentHtml = await loginRes.text();
    (loginRes.status === 200 && /Разрешить доступ/.test(consentHtml))
      ? ok('вход прямо на странице согласия, дальше спрашивают разрешение')
      : bad('страница согласия не показалась', String(loginRes.status));

    const allow = new URLSearchParams(authQ);
    allow.set('decision', 'allow');
    const allowRes = await fetch(BASE + '/oauth/authorize', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: allow.toString(), redirect: 'manual',
    });
    const loc = new URL(allowRes.headers.get('location') || 'https://x/');
    const code = loc.searchParams.get('code');
    (allowRes.status === 302 && code && loc.searchParams.get('state') === 'st123' && loc.searchParams.get('iss'))
      ? ok('код выдан, state и iss возвращены (RFC 9207)')
      : bad('редирект с кодом сломан', allowRes.headers.get('location') || String(allowRes.status));

    /* ---------- обмен на токен ---------- */
    const badVer = await json('/oauth/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT,
        client_id: clientId, code_verifier: 'не-тот-verifier' }).toString(),
    });
    badVer.status === 400 ? ok('код без правильного verifier не меняется на токен')
                          : bad('PKCE не проверяется', String(badVer.status));

    const tok = await json('/oauth/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT,
        client_id: clientId, code_verifier: verifier, resource: BASE + '/mcp' }).toString(),
    });
    (tok.status === 200 && tok.body.access_token && tok.body.refresh_token)
      ? ok('код меняется на токен доступа и токен обновления')
      : bad('обмен кода на токен сломан', JSON.stringify(tok.body).slice(0, 200));
    const token = tok.body.access_token;

    const reuse = await json('/oauth/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT,
        client_id: clientId, code_verifier: verifier }).toString(),
    });
    reuse.status === 400 ? ok('повторное использование кода отклоняется')
                         : bad('код сработал дважды', String(reuse.status));

    /* ---------- MCP ---------- */
    let rpcId = 100;
    const rpc = async (method, params) => {
      const r = await json('/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token,
          'MCP-Protocol-Version': '2025-06-18' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
      });
      return r.body;
    };
    const call = async (name, args) => {
      const r = await rpc('tools/call', { name, arguments: args });
      const res = r && r.result;
      if (!res) throw new Error('нет результата: ' + JSON.stringify(r).slice(0, 200));
      if (res.isError) throw new Error(res.content[0].text);
      return res.structuredContent;
    };

    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    (init.result && init.result.protocolVersion === '2025-06-18' && init.result.serverInfo.name === 'graph-studio')
      ? ok('рукопожатие проходит и версия протокола согласуется', init.result.protocolVersion)
      : bad('initialize сломан', JSON.stringify(init).slice(0, 200));

    const tools = await rpc('tools/list');
    const names = tools.result.tools.map(t => t.name);
    (names.length >= 18 && names.includes('add_nodes') && names.includes('place_nodes') && names.includes('edit_schema'))
      ? ok('инструменты объявлены', names.length + ' шт.')
      : bad('инструментов мало или не те', names.join(', '));

    /* ---------- полный цикл работы с доской ---------- */
    const created = await call('create_board', {
      name: 'MCP-проверка', description: 'создана тестом',
      categories: [{ name: 'Платформа', color: '#2f6fed' }, { name: 'Юридика', color: '#b08900' }],
    });
    (created.id && created.url.endsWith(created.id))
      ? ok('доска создаётся через MCP', created.name + ' → ' + created.url)
      : bad('create_board не сработал', JSON.stringify(created).slice(0, 200));
    const B = created.id;

    const added = await call('add_nodes', { board: B, nodes: [
      { name: 'Юрлицо и оферта', status: 'в работе', category: 'Юридика', sub: 'рамка' },
      { name: 'Каталог товаров', status: 'не начато', category: 'Платформа',
        checks: [{ text: 'Дерево категорий', status: 'в работе', blocking: true }] },
      { name: 'Публичный запуск', status: 'не начато', category: 'Платформа' },
    ] });
    added.added.length === 3 ? ok('узлы добавляются', added.added.map(n => n.name).join(', '))
                             : bad('add_nodes не сработал', JSON.stringify(added));
    const [n1, n2, n3] = added.added.map(n => n.id);

    // статусы и категории названиями, а не ключами — модель видит именно названия
    const st = await call('get_board', { board: 'MCP-проверка' });
    (st.nodes.find(n => n.id === n1).status !== undefined &&
     st.schema.categories.some(c => c.name === 'Юридика'))
      ? ok('доска находится по названию, статусы и категории разобраны по именам')
      : bad('разбор по именам сломан', JSON.stringify(st.nodes[0]));

    const linked = await call('link_nodes', { board: B, links: [{ from: n1, to: n2 }, { from: n2, to: n3 }] });
    linked.added.length === 2 ? ok('связи создаются') : bad('link_nodes не сработал', JSON.stringify(linked));

    let cycleBlocked = false;
    try { await call('link_nodes', { board: B, links: [{ from: n3, to: n1 }] }); }
    catch (e) { cycleBlocked = /круг/.test(e.message); }
    cycleBlocked ? ok('связь, замыкающая круг, отклоняется с объяснением')
                 : bad('круг в зависимостях создался');

    const metrics = await call('get_board', { board: B, include_metrics: true });
    (metrics.metrics.nodes[0].id === n1 && metrics.metrics.nodes[0].weight === 2)
      ? ok('вес узлов считается как в приложении', 'вес ' + metrics.metrics.nodes[0].weight)
      : bad('метрики неверны', JSON.stringify(metrics.metrics.nodes.slice(0, 2)));

    const page = await call('add_page', { board: B, name: 'Свободная схема', kind: 'space' });
    page.kind === 'space' ? ok('страница-холст добавляется') : bad('add_page не сработал', JSON.stringify(page));

    const placed = await call('place_nodes', { board: B, page: page.id, positions: [
      { node: n1, x: 100, y: 100 }, { node: n2, x: 400, y: 100 }, { node: n3, x: 700, y: 220, w: 240 },
    ] });
    placed.placed.length === 3 ? ok('узлы расставляются на холсте по координатам')
                               : bad('place_nodes не сработал', JSON.stringify(placed));

    const frame = await call('edit_frames', { board: B, op: 'add', name: 'Первая волна', x: 60, y: 60, w: 700, h: 240 });
    const note = await call('edit_notes', { board: B, op: 'add', text: 'Проверить у юристов', x: 100, y: 380 });
    (frame.id && note.id) ? ok('области и заметки создаются') : bad('области или заметки не создались');

    const schema = await call('edit_schema', { board: B, op: 'add', kind: 'status', name: 'на паузе', color: '#8a5d00' });
    const field = await call('edit_fields', { board: B, op: 'add', label: 'Ответственный', type: 'text', showOnCard: true });
    (schema.key && field.key) ? ok('схема и свои поля правятся', `${schema.key} / ${field.key}`)
                              : bad('схема не поправилась');

    await call('update_nodes', { board: B, nodes: [{ id: n1, status: 'на паузе', fields: { Ответственный: 'Никита' } }] });
    const after = await call('get_board', { board: B });
    const upd = after.nodes.find(n => n.id === n1);
    (upd.status === schema.key && upd.fields && upd.fields[field.key] === 'Никита')
      ? ok('узел обновляется, своё поле проставляется по подписи')
      : bad('update_nodes сломан', JSON.stringify(upd));

    // Неизвестные поля документа обязаны пережить правку из MCP.
    const survived = await (async () => {
      const raw = execSync(`docker compose exec -T api node -e "
        const db = require('better-sqlite3')('/data/graphstudio.sqlite');
        const r = db.prepare('SELECT doc FROM boards WHERE id = ?').get('${B}');
        const d = JSON.parse(r.doc); d.nodes[0].myCustomField = 'не трогать';
        db.prepare('UPDATE boards SET doc = ? WHERE id = ?').run(JSON.stringify(d), '${B}');
        console.log('ok');
      "`).toString();
      if (!/ok/.test(raw)) return null;
      await call('update_nodes', { board: B, nodes: [{ id: n1, sub: 'подпись поменяли' }] });
      const d = await call('get_board', { board: B });
      const chk = execSync(`docker compose exec -T api node -e "
        const db = require('better-sqlite3')('/data/graphstudio.sqlite');
        const d = JSON.parse(db.prepare('SELECT doc FROM boards WHERE id = ?').get('${B}').doc);
        console.log(d.nodes[0].myCustomField || 'ПОТЕРЯНО');
      "`).toString().trim();
      return { chk, sub: d.nodes.find(n => n.id === n1).sub };
    })();
    (survived && survived.chk === 'не трогать' && survived.sub === 'подпись поменяли')
      ? ok('неизвестные поля документа переживают правку из MCP')
      : bad('MCP затирает незнакомые поля', JSON.stringify(survived));

    const hist = await call('board_history', { board: B });
    (hist.versions.length >= 5 && hist.versions.every(v => v.author))
      ? ok('каждая правка из MCP попала в историю с автором', hist.versions.length + ' версий')
      : bad('история не пишется', JSON.stringify(hist.versions.slice(0, 3)));

    /* ---------- раскладка видна так же, как человеку ---------- */
    const pages = await call('get_board', { board: B, pages_only: true });
    (pages.pages.length >= 4 && !pages.nodes)
      ? ok('pages_only отдаёт структуру без узлов', pages.pages.length + ' страниц')
      : bad('pages_only не работает', JSON.stringify(pages).slice(0, 150));

    const canvasPage = pages.pages.find(p => p.kind === 'canvas');
    await call('update_page', { board: B, page: canvasPage.id, lanes: ['сейчас', 'потом', 'когда-нибудь'] });
    await call('update_nodes', { board: B, nodes: [{ id: n1, lane: 2 }] });
    const lay = await call('get_board', { board: B, include_layout: true });
    const laid = lay.nodes.find(n => n.id === n1);
    const spacePage = lay.pages.find(p => p.kind === 'space');
    (laid.lane === 2 && laid.positions && laid.positions[page.id] && laid.positions[page.id].x === 100
      && spacePage.nodes_pinned === 3)
      ? ok('видно колонку узла, его координаты и сколько закреплено на холсте',
          `lane ${laid.lane}, закреплено ${spacePage.nodes_pinned}`)
      : bad('раскладка не отдаётся', JSON.stringify({ laid, spacePage }).slice(0, 250));

    // Узел не должен потеряться, если колонку, за которой он закреплён, убрали.
    await call('update_page', { board: B, page: canvasPage.id, lanes: ['сейчас', 'потом'] });
    const shrunk = await call('get_board', { board: B, include_layout: true });
    shrunk.nodes.find(n => n.id === n1).lane === null
      ? ok('узел из исчезнувшей колонки возвращается на авто, а не пропадает')
      : bad('узел остался в несуществующей колонке', JSON.stringify(shrunk.nodes.find(n => n.id === n1)));

    /* ---------- связи не теряются ---------- */
    const dupe = await call('link_nodes', { board: B, links: [{ from: n1, to: n2 }] });
    (dupe.added.length === 0 && dupe.skipped.length === 1)
      ? ok('повторная связь пропускается, а не роняет вызов')
      : bad('повтор связи обработан неверно', JSON.stringify(dupe));

    // n1 → n3 в обход n2: не круг, просто ещё одна стрелка
    const newType = await call('link_nodes', { board: B, links: [{ from: n1, to: n3, type: 'flow' }] });
    (newType.added.length === 1 && newType.warnings.length === 1)
      ? ok('связь с незнакомым типом не отбрасывается — тип заводится', newType.warnings[0])
      : bad('связь с чужим типом потеряна', JSON.stringify(newType));

    /* ---------- импорт целиком ---------- */
    // Файл нарочно с кириллическими id, чужим типом связи, лишней страницей-схемой
    // и дублем id: ровно то, на чём импорт по частям и рассыпался.
    const source = {
      name: 'Импорт целиком', desc: 'проверка',
      schema: {
        nodeTypes: [{ key: 'stage', name: 'Этап', shape: 'rect' }],
        statuses: [{ key: 'ok', name: 'готово', color: '#18a558' }, { key: 'todo', name: 'не начато', color: '#5f6673' }],
        categories: [{ key: 'plat', name: 'Платформа', color: '#2f6fed' }],
        linkTypes: [{ key: 'hard', name: 'Жёсткая', color: '#9aa1b2', style: 'solid', blocking: 1 }],
        fields: [],
      },
      nodes: [
        { id: 'pt_out_яндекс_смена', name: 'Смена Яндекса', status: 'todo', cat: 'plat', type: 'stage' },
        { id: 'bl_pr01', name: 'Блок 1', status: 'ok', cat: 'plat', type: 'stage', p: { pg_map: { x: 40, y: 60 } } },
        { id: 'ind_sel', name: 'Индекс', status: 'todo', cat: 'plat', type: 'stage', lane: 1 },
        { id: 'ind_sel', name: 'Индекс дубль', status: 'todo', cat: 'plat', type: 'stage' },
        { id: 'нет_категории', name: 'Без категории', status: 'todo', cat: 'неизвестная', type: 'stage' },
      ],
      links: [
        { from: 'pt_out_яндекс_смена', to: 'bl_pr01', type: 'hard' },
        { from: 'bl_pr01', to: 'ind_sel', type: 'flow' },
        { from: 'ind_sel', to: 'нет_категории', type: 'soft' },
        { from: 'нет_такого', to: 'bl_pr01', type: 'hard' },
      ],
      pages: [
        { id: 'pg_map', name: 'Карта', kind: 'canvas', canvas: { layout: 'auto', lanes: ['раз', 'два'] } },
        { id: 'pg_tbl', name: 'Таблица', kind: 'table', table: { cols: ['name', 'status'], sort: 'name', dir: 1, group: '' } },
      ],
      frames: [{ id: 'f1', name: 'Волна 1', x: 0, y: 0, w: 400, h: 200 }],
      notes: [{ id: 't1', text: 'заметка', x: 10, y: 10 }],
    };

    const dry = await call('import_board', { doc: source, dry_run: true });
    (dry.dry_run && dry.nodes_created === 5 && dry.links_created === 3 && dry.pages_created.length === 2)
      ? ok('dry_run отчитывается, ничего не создавая', `${dry.nodes_created} узлов, ${dry.links_created} связей`)
      : bad('dry_run неверен', JSON.stringify(dry).slice(0, 250));

    const afterDry = await call('list_boards', {});
    !afterDry.boards.some(b => b.name === 'Импорт целиком')
      ? ok('после dry_run доска не появилась')
      : bad('dry_run всё-таки создал доску');

    const imp = await call('import_board', { doc: source });
    (imp.nodes_created === 5 && imp.links_created === 3 && imp.pages_created.length === 2)
      ? ok('импорт создаёт ровно то, что в файле', `${imp.nodes_created}/${imp.links_created}/${imp.pages_created.length}`)
      : bad('импорт создал не то', JSON.stringify(imp).slice(0, 250));

    (imp.nodes_renamed.length === 1 && imp.nodes_renamed[0].from === 'ind_sel')
      ? ok('дубль id переименован детерминированно', JSON.stringify(imp.nodes_renamed[0]))
      : bad('дубль id обработан неверно', JSON.stringify(imp.nodes_renamed));

    (imp.links_dropped.length === 1 && /нет в файле/.test(imp.links_dropped[0].reason))
      ? ok('единственная отброшенная связь названа с причиной', imp.links_dropped[0].reason)
      : bad('связи теряются молча или не те', JSON.stringify(imp.links_dropped));

    const imported = await call('get_board', { board: imp.id, include_layout: true });
    const cyr = imported.nodes.find(n => n.id === 'pt_out_яндекс_смена');
    const dupNode = imported.nodes.find(n => n.id === 'ind_sel__2');
    const kept = imported.nodes.find(n => n.id === 'bl_pr01');
    (cyr && dupNode && kept && kept.positions && kept.positions.pg_map.x === 40)
      ? ok('кириллические id сохранены как есть, позиции на месте')
      : bad('id или позиции потеряны', JSON.stringify({ cyr: !!cyr, dupNode: !!dupNode, kept }).slice(0, 200));

    (imported.nodes.find(n => n.id === 'ind_sel').lane === 1)
      ? ok('колонка узла пережила импорт')
      : bad('lane потерян при импорте');

    (imported.schema.linkTypes.some(t => t.key === 'flow') &&
     imported.schema.linkTypes.some(t => t.key === 'soft') &&
     imported.schema.categories.some(c => c.key === 'неизвестная'))
      ? ok('незнакомые типы связей и категории заведены, а не отброшены',
          imported.schema.linkTypes.map(t => t.key).join(', '))
      : bad('схема при импорте потеряла значения', JSON.stringify(imported.schema.linkTypes));

    (imported.pages.length === 2 && !imported.pages.some(p => p.kind === 'space'))
      ? ok('лишних страниц импорт не создаёт')
      : bad('импорт создал лишние страницы', JSON.stringify(imported.pages.map(p => p.kind)));

    let badKind = false;
    try {
      await call('import_board', { doc: { ...source, pages: [{ id: 'x', name: 'Ой', kind: 'gantt' }] } });
    } catch (e) { badKind = /не бывает/.test(e.message); }
    badKind ? ok('страница с несуществующим видом отклоняется с ошибкой')
            : bad('страница с чужим видом принята');

    const listed2 = await call('list_boards', {});
    const impRow = listed2.boards.find(b => b.id === imp.id);
    (impRow && impRow.pages === 2 && impRow.version >= 1)
      ? ok('в списке досок видно число страниц и версию', `${impRow.pages} страниц, версия ${impRow.version}`)
      : bad('в списке нет страниц или версии', JSON.stringify(impRow));

    await call('delete_board', { board: imp.id });

    const del = await call('delete_nodes', { board: B, ids: [n3] });
    (del.deleted.length === 1 && del.links_removed >= 1)
      ? ok('узел удаляется вместе со своими связями', `связей убрано ${del.links_removed}`)
      : bad('delete_nodes сломан', JSON.stringify(del));

    const restored = await call('restore_version', { board: B, version: hist.versions[hist.versions.length - 1].version });
    restored.version > 0 ? ok('версия возвращается через MCP', 'v' + restored.restored + ' → v' + restored.version)
                         : bad('restore_version сломан', JSON.stringify(restored));

    const share = await call('share_board', { board: B, role: 'viewer' });
    /\/s\//.test(share.url) ? ok('ссылка на просмотр выдаётся', share.url.slice(0, 48) + '…')
                            : bad('share_board сломан', JSON.stringify(share));

    /* ---------- чужой ресурс и отзыв ---------- */
    const wrongAud = await json('/mcp', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token,
        host: 'example.com' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    wrongAud.status === 200 ? ok('токен работает для своего ресурса') : bad('свой токен не принят', String(wrongAud.status));

    const fake = await json('/mcp', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer nope-not-a-real-token' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    fake.status === 401 ? ok('поддельный токен отклоняется') : bad('поддельный токен принят', String(fake.status));

    const refreshed = await json('/oauth/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tok.body.refresh_token, client_id: clientId }).toString(),
    });
    refreshed.body.access_token ? ok('токен обновляется без повторного входа')
                                : bad('refresh не работает', JSON.stringify(refreshed.body).slice(0, 150));

    const grants = await json('/api/oauth/grants', { headers: { cookie } });
    (grants.status === 200 && grants.body.grants.some(g => g.client_id === clientId))
      ? ok('выданный доступ виден в списке и его можно отозвать')
      : bad('список доступов пуст', JSON.stringify(grants.body).slice(0, 150));

    await json('/api/oauth/grants/' + clientId, { method: 'DELETE', headers: { cookie } });
    const afterRevoke = await json('/mcp', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    afterRevoke.status === 401 ? ok('после отзыва токен перестаёт работать')
                               : bad('отозванный токен всё ещё работает', String(afterRevoke.status));

    // прибираем за собой
    execSync(`docker compose exec -T api node -e "
      const db = require('better-sqlite3')('/data/graphstudio.sqlite');
      db.prepare('DELETE FROM boards WHERE id = ?').run('${B}');
      db.prepare('DELETE FROM boards WHERE name IN (?, ?)').run('Импорт целиком', 'MCP-проверка');
    "`);
  } catch (e) {
    bad('ПРОГОН УПАЛ', e.message);
  }

  const good = results.filter(r => r[0] === '✓').length;
  console.log(`\n===== ${good}/${results.length} пройдено =====`);
  if (good < results.length) {
    console.log('ПРОВАЛЫ:');
    results.filter(r => r[0] === '✗').forEach(r => console.log(' ✗', r[1], r[2]));
    process.exit(1);
  }
})();
