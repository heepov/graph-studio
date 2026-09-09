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
    // Число ТОЧНОЕ, а не «хотя бы столько»: мягкая проверка означала, что реестр
    // можно нечаянно урезать или раздуть, и никто не заметит. Добавили инструмент —
    // поправьте здесь, это одна строка и осознанное действие.
    const TOOLS_EXPECTED = 29;
    (names.length === TOOLS_EXPECTED && names.includes('add_nodes') && names.includes('place_nodes') && names.includes('edit_schema'))
      ? ok('инструменты объявлены', names.length + ' шт.')
      : bad(`инструментов ${names.length}, а ожидалось ${TOOLS_EXPECTED}`, names.join(', '));

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

    // Незнакомый вид — отказ, а не молчаливый холст: раньше add_page подменял его
    // на canvas, и модель считала, что получила то, что просила.
    let badPageKind = '';
    try { await call('add_page', { board: B, name: 'Таймлайн', kind: 'gantt' }); }
    catch (e) { badPageKind = e.message; }
    /вида страницы «gantt» не бывает/.test(badPageKind)
      ? ok('add_page отказывает на незнакомом виде страницы')
      : bad('незнакомый вид страницы принят молча', badPageKind || 'ошибки не было');

    // Доска — такой же вид страницы для коннектора. Без этого экспорт доски с такой
    // страницей нельзя было бы импортировать обратно: import_board отвергает
    // незнакомый вид, и запрет добавления обернулся бы запретом на возврат.
    const jam = await call('add_page', { board: B, name: 'Свободная доска', kind: 'jam' });
    jam.kind === 'jam' ? ok('страница-доска добавляется через коннектор') : bad('add_page jam не сработал', JSON.stringify(jam));

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

    const jamPage = pages.pages.find(p => p.kind === 'jam');
    (jamPage && jamPage.jam_items === 0)
      ? ok('в структуре доски видно число объектов, а не они сами')
      : bad('счётчик объектов доски не отдаётся', JSON.stringify(jamPage));

    /* ---------- свободная доска через коннектор ---------- */
    const jadd = await call('jam_add', { board: B, page: jam.id, items: [
      { kind: 'section', x: 0, y: 0, w: 900, h: 600, text: 'Спринт 1' },
      { kind: 'sticky', x: 40, y: 60, text: 'Проверить у юристов', fill: '#ffd93b' },
      { kind: 'shape', x: 320, y: 60, shape: 'roundrect', text: 'Этап 1' },
      { kind: 'draw', x: 40, y: 400, points: '0,0 20,18 44,6', stroke: '#e0432f', sw: 4 },
    ] });
    jadd.count === 4 ? ok('объекты кладутся на доску', jadd.added.map(i => i.kind).join('/'))
                     : bad('jam_add не сработал', JSON.stringify(jadd));
    const [SEC, STK, SHP] = jadd.added.map(i => i.id);

    // Коннектор доски ссылается на объект по id, а на узел графа — через node:<id>.
    const jconn = await call('jam_add', { board: B, page: jam.id, items: [
      { kind: 'conn', from: STK, to: SHP, style: 'ortho', cap_end: 'arrow' },
    ] });
    jconn.count === 1 ? ok('коннектор между объектами доски создаётся') : bad('коннектор не создался', JSON.stringify(jconn));

    // Стрелки на доске могут ходить по кругу: это линии, а не зависимости.
    const jback = await call('jam_add', { board: B, page: jam.id, items: [
      { kind: 'conn', from: SHP, to: STK },
    ] });
    jback.count === 1 ? ok('встречный коннектор разрешён — на доске цикл законен')
                      : bad('доска отвергла встречную стрелку', JSON.stringify(jback));

    let jamBadRef = '';
    try { await call('jam_add', { board: B, page: jam.id, items: [{ kind: 'conn', from: STK, to: 'нет_такого' }] }); }
    catch (e) { jamBadRef = e.message; }
    /нет на этой доске/.test(jamBadRef) ? ok('коннектор в несуществующий объект отклоняется')
                                        : bad('ссылка в никуда принята', jamBadRef || 'ошибки не было');

    const jread = await call('jam_read', { board: B, page: jam.id });
    const rs = jread.items.find(i => i.id === STK);
    const rc = jread.items.find(i => i.kind === 'conn');
    (jread.count === 6 && rs.text === 'Проверить у юристов' && rs.w === 180 && rc.from === STK && rc.style === 'ortho')
      ? ok('доска читается обратно тем же, чем записана', jread.count + ' объектов')
      : bad('чтение доски расходится с записью', JSON.stringify(jread.items.slice(0, 3)));

    await call('jam_update', { board: B, page: jam.id, items: [{ id: STK, fill: '#ffc0cb' }] });
    const jr2 = await call('jam_read', { board: B, page: jam.id });
    const s2 = jr2.items.find(i => i.id === STK);
    (s2.fill === '#ffc0cb' && s2.text === 'Проверить у юристов' && s2.w === 180)
      ? ok('jam_update меняет только присланное поле')
      : bad('правка затёрла соседние поля', JSON.stringify(s2));

    // То же правило, что для узлов: незнакомые поля объекта переживают правку.
    const jamKeep = await (async () => {
      execSync(`docker compose exec -T api node -e "
        const db = require('better-sqlite3')('/data/graphstudio.sqlite');
        const r = db.prepare('SELECT doc FROM boards WHERE id = ?').get('${B}');
        const d = JSON.parse(r.doc);
        const pg = d.pages.find(p => p.id === '${jam.id}');
        pg.jam.items.find(i => i.id === '${STK}').myJamField = 'не трогать';
        db.prepare('UPDATE boards SET doc = ? WHERE id = ?').run(JSON.stringify(d), '${B}');
      "`);
      await call('jam_update', { board: B, page: jam.id, items: [{ id: STK, text: 'Уточнили' }] });
      return execSync(`docker compose exec -T api node -e "
        const db = require('better-sqlite3')('/data/graphstudio.sqlite');
        const d = JSON.parse(db.prepare('SELECT doc FROM boards WHERE id = ?').get('${B}').doc);
        const pg = d.pages.find(p => p.id === '${jam.id}');
        const it = pg.jam.items.find(i => i.id === '${STK}');
        console.log(JSON.stringify({ keep: it.myJamField || 'ПОТЕРЯНО', text: it.text }));
      "`).toString().trim();
    })();
    const jk = JSON.parse(jamKeep);
    (jk.keep === 'не трогать' && jk.text === 'Уточнили')
      ? ok('неизвестные поля объекта доски переживают правку из MCP')
      : bad('правка доски затирает незнакомые поля', jamKeep);

    const jarr = await call('jam_arrange', { board: B, page: jam.id, items: [STK, SHP], op: 'align_top' });
    const jr3 = await call('jam_read', { board: B, page: jam.id });
    const a1 = jr3.items.find(i => i.id === STK), a2 = jr3.items.find(i => i.id === SHP);
    (jarr.count === 2 && a1.y === a2.y) ? ok('jam_arrange выравнивает объекты', 'y = ' + a1.y)
                                        : bad('выравнивание не сработало', JSON.stringify({ jarr, y1: a1.y, y2: a2.y }));

    // Счётчики в get_board должны видеть содержимое, но НЕ тащить его.
    const jsum = await call('get_board', { board: B, pages_only: true });
    const jp = jsum.pages.find(p => p.id === jam.id);
    (jp.jam_items === 6 && jp.jam_kinds && jp.jam_kinds.conn === 2 && !jp.items)
      ? ok('в get_board видно, что на доске, но не сами объекты', JSON.stringify(jp.jam_kinds))
      : bad('счётчики доски неверны', JSON.stringify(jp));

    // Удаление объекта уносит коннекторы, которые к нему шли.
    const jdel = await call('jam_delete', { board: B, page: jam.id, items: [SHP] });
    (jdel.removed === 1 && jdel.connectors_removed === 2)
      ? ok('удаление объекта уносит висячие коннекторы', `${jdel.connectors_removed} шт.`)
      : bad('висячие коннекторы остались', JSON.stringify(jdel));

    let jamOnCanvas = '';
    const canvasId = pages.pages.find(p => p.kind === 'canvas').id;
    try { await call('jam_add', { board: B, page: canvasId, items: [{ kind: 'sticky', x: 0, y: 0 }] }); }
    catch (e) { jamOnCanvas = e.message; }
    /не доска/.test(jamOnCanvas) ? ok('на холст-граф объекты доски не кладутся')
                                 : bad('объект доски принят не на доску', jamOnCanvas || 'ошибки не было');

    const canvasPage = pages.pages.find(p => p.kind === 'canvas');
    await call('update_page', { board: B, page: canvasPage.id, lanes: ['сейчас', 'потом', 'когда-нибудь'] });
    await call('update_nodes', { board: B, nodes: [{ id: n1, lane: 2 }] });
    const lay = await call('get_board', { board: B, include_layout: true });
    const laid = lay.nodes.find(n => n.id === n1);
    const spacePage = lay.pages.find(p => p.kind === 'space');
    (laid.lane === 2 && laid.positions && laid.positions[page.id] && laid.positions[page.id].x === 100
      && spacePage.nodes_pinned === 3 && spacePage.nodes_visible === 3)
      ? ok('видно колонку узла, его координаты и сколько закреплено на холсте',
          `lane ${laid.lane}, закреплено ${spacePage.nodes_pinned}`)
      : bad('раскладка не отдаётся', JSON.stringify({ laid, spacePage }).slice(0, 250));

    // Размер из place_nodes обязан лежать РЯДОМ с позицией, в n.p[pageId].w/h —
    // именно оттуда его читает nsize() в приложении. До 2.5.0 сервер писал его
    // в отдельное n.sz[pageId], и заданный из Claude размер в редакторе не было видно.
    const laid3 = lay.nodes.find(n => n.id === n3);
    (laid3.sizes && laid3.sizes[page.id] && laid3.sizes[page.id].w === 240)
      ? ok('размер узла отдаётся в раскладке', `${laid3.sizes[page.id].w} px`)
      : bad('размер из place_nodes не виден в include_layout', JSON.stringify(laid3).slice(0, 200));

    const whereSize = execSync(`docker compose exec -T api node -e "
      const db = require('better-sqlite3')('/data/graphstudio.sqlite');
      const d = JSON.parse(db.prepare('SELECT doc FROM boards WHERE id = ?').get('${B}').doc);
      const n = d.nodes.find(x => x.id === '${n3}');
      console.log(JSON.stringify({ p: (n.p||{})['${page.id}'], sz: n.sz || null }));
    "`).toString().trim();
    const ws = JSON.parse(whereSize);
    (ws.p && ws.p.w === 240 && ws.sz === null)
      ? ok('размер хранится рядом с позицией, а не отдельным полем n.sz')
      : bad('размер лежит не там, где его ищет редактор', whereSize);

    // Закреплено и видно — РАЗНЫЕ числа: фильтр страницы отсекает часть узлов,
    // а их координаты остаются в документе. Путать их нельзя.
    await call('update_page', { board: B, page: page.id, filter: { statuses: ['не начато'] } });
    const filtered = await call('get_board', { board: B, include_layout: true });
    const sp2 = filtered.pages.find(p => p.id === page.id);
    (sp2.nodes_pinned === 3 && sp2.nodes_visible < 3)
      ? ok('фильтр страницы виден в счётчике', `закреплено ${sp2.nodes_pinned}, показывается ${sp2.nodes_visible}`)
      : bad('счётчик не учитывает фильтр', JSON.stringify(sp2));
    await call('update_page', { board: B, page: page.id, filter: { statuses: [] } });

    // Узел не должен потеряться, если колонку, за которой он закреплён, убрали.
    await call('update_page', { board: B, page: canvasPage.id, lanes: ['сейчас', 'потом'] });
    const shrunk = await call('get_board', { board: B, include_layout: true });
    shrunk.nodes.find(n => n.id === n1).lane === null
      ? ok('узел из исчезнувшей колонки возвращается на авто, а не пропадает')
      : bad('узел остался в несуществующей колонке', JSON.stringify(shrunk.nodes.find(n => n.id === n1)));

    /* ---------- связи не теряются ---------- */
    const verBefore = (await call('get_board', { board: B, pages_only: true })).version;
    const dupe = await call('link_nodes', { board: B, links: [{ from: n1, to: n2 }] });
    (dupe.added.length === 0 && dupe.skipped.length === 1)
      ? ok('повторная связь пропускается, а не роняет вызов')
      : bad('повтор связи обработан неверно', JSON.stringify(dupe));
    // Вызов, который ничего не изменил, не должен плодить версии: история из пустых
    // записей перестаёт быть историей.
    const verAfter = (await call('get_board', { board: B, pages_only: true })).version;
    (dupe.changed === false && verAfter === verBefore)
      ? ok('пустая правка не создаёт версию', 'версия осталась ' + verAfter)
      : bad('версия выросла на пустом месте', `${verBefore} → ${verAfter}, changed=${dupe.changed}`);

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

    // Пустая страница в самом файле: импорт её не выбрасывает молча, но говорит
    // о ней, а выбросить можно одним параметром — не правя JSON руками.
    const withEmpty = { ...source, pages: [...source.pages,
      { id: 'p_empty', name: 'Новая страница', kind: 'space' }] };
    const warn = await call('import_board', { doc: withEmpty, dry_run: true });
    (warn.pages_created.length === 3 && warn.warnings.some(w => /p_empty/.test(w) && /drop_pages/.test(w)))
      ? ok('пустая страница из файла отмечена в отчёте с подсказкой, как убрать')
      : bad('про пустую страницу не сказано', JSON.stringify(warn.warnings));

    const cleaned = await call('import_board', { doc: withEmpty, dry_run: true, drop_pages: ['p_empty'] });
    (cleaned.pages_created.length === 2 && cleaned.pages_dropped.length === 1)
      ? ok('drop_pages убирает лишнюю страницу при импорте', cleaned.pages_dropped[0].name)
      : bad('drop_pages не сработал', JSON.stringify(cleaned.pages_dropped));

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

    /* ---------- сколько истории переживает время ---------- */
    // Потолок «последние 40 версий» — это один вечер работы. Проверяем, что теперь
    // недавнее хранится целиком, старое прореживается, а первая версия не пропадает.
    const hist2 = await call('board_history', { board: B });
    const curVer = hist2.current;
    const seed = execSync(`docker compose exec -T api node -e "
      const zlib = require('zlib');
      const db = require('better-sqlite3')('/data/graphstudio.sqlite');
      const doc = db.prepare('SELECT doc FROM boards WHERE id = ?').get('${B}').doc;
      const gz = zlib.gzipSync(doc);
      const ins = db.prepare('INSERT OR REPLACE INTO board_versions (board_id, version, at, actor_id, summary, nodes, links, doc, doc_gz) VALUES (?,?,?,?,?,?,?,?,?)');
      const DAY = 86400000, now = Date.now();
      let v = 1000;
      // по 6 версий в час за последние 20 дней и по 4 в день за прошедший год
      for (let h = 0; h < 20 * 24; h++) for (let k = 0; k < 6; k++)
        ins.run('${B}', v++, now - h * 3600000 - k * 600000, null, 'старая правка', 1, 0, '', gz);
      for (let d = 20; d < 365; d++) for (let k = 0; k < 4; k++)
        ins.run('${B}', v++, now - d * DAY - k * 6 * 3600000, null, 'древняя правка', 1, 0, '', gz);
      console.log(db.prepare('SELECT COUNT(*) c FROM board_versions WHERE board_id = ?').get('${B}').c);
    "`).toString().trim();
    const seeded = +seed;
    (seeded > 3000) ? ok('в историю засеяно много версий', seeded + ' версий')
                    : bad('засеять историю не вышло', seed);

    // Любая правка запускает прореживание — берём ту, что не зависит от узлов:
    // выше по прогону доска уже возвращалась к пустой версии.
    await call('update_board', { board: B, description: 'толкаем прореживание' });
    const thinned = execSync(`docker compose exec -T api node -e "
      const db = require('better-sqlite3')('/data/graphstudio.sqlite');
      const DAY = 86400000, now = Date.now();
      const rows = db.prepare('SELECT version, at, doc, doc_gz FROM board_versions WHERE board_id = ? ORDER BY at').all('${B}');
      const age = r => now - r.at;
      console.log(JSON.stringify({
        total: rows.length,
        recent: rows.filter(r => age(r) <= 7 * DAY).length,
        hourly: rows.filter(r => age(r) > 7 * DAY && age(r) <= 30 * DAY).length,
        old: rows.filter(r => age(r) > 30 * DAY).length,
        first: rows[0].version,
        gz: rows.every(r => r.doc_gz && !r.doc),
      }));
    "`).toString().trim();
    const a = JSON.parse(thinned);
    // Засеяно: 6 версий в час за 20 дней и 4 в день за год. После прореживания
    // недавняя неделя обязана остаться целиком, неделя–месяц схлопнуться до часа,
    // старше месяца — до дня.
    (a.total < seeded && a.hourly < 700)
      ? ok('старые версии прорежены, недавние остались', `${seeded} → ${a.total}`)
      : bad('прореживание сработало не так', JSON.stringify(a));
    // В этой полосе засеяно 1872 версии (312 часов по 6) плюс 40 суточных —
    // после схлопывания по часу должно остаться около 350.
    (a.hourly > 250 && a.hourly < 450)
      ? ok('от недели до месяца остаётся примерно по одной версии в час', a.hourly + ' шт.')
      : bad('часовое прореживание неверно', String(a.hourly));
    // за 7 дней сеялось 6 версий в час — все они обязаны уцелеть
    (a.recent >= 7 * 24 * 6)
      ? ok('за последнюю неделю сохранена каждая версия', a.recent + ' шт.')
      : bad('недавние версии потерялись', String(a.recent));
    // за год сеялось по 4 в день — должно остаться примерно по одной
    (a.old > 300 && a.old < 400)
      ? ok('старше месяца остаётся примерно по одной версии в день', a.old + ' шт.')
      : bad('старая история прорежена неверно', String(a.old));
    a.gz ? ok('документы версий лежат сжатыми') : bad('версии хранятся без сжатия');

    // Сжатие не должно мешать вернуть версию.
    const backOld = await call('restore_version', { board: B, version: curVer });
    (backOld.restored === curVer)
      ? ok('версия из сжатой истории возвращается', 'v' + curVer)
      : bad('возврат сжатой версии сломан', JSON.stringify(backOld));

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
