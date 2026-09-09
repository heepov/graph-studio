// Сквозной сценарий бэкенда: аккаунт → доска → правка → ссылки-доступы → админка.
//
// Этот набор СОЗДАЁТ данные, поэтому гоняется только против локального контейнера
// и никогда против прода. Read-only проверки живут отдельно, в test/api.js.
const BASE = (process.env.APP_URL || 'http://127.0.0.1:8081/').replace(/\/$/, '');
const results = [];
const ok = (n, d = '') => { results.push(['✓', n, d]); console.log('✓', n, d); };
const bad = (n, d = '') => { results.push(['✗', n, d]); console.log('✗', n, d); };

// Почта уникальная на прогон: набор создаёт данные, и повторный запуск на той же
// базе иначе спотыкается о «такая почта уже зарегистрирована».
const RUN = Date.now().toString(36);
const MAIL2 = `vtoroy-${RUN}@example.test`;
const MAIL3 = `chuzhoy-${RUN}@example.test`;
const jars = {};
async function call(who, path, opts = {}) {
  const headers = { 'content-type': 'application/json', ...(opts.headers || {}) };
  if (jars[who]) headers.cookie = jars[who];
  const r = await fetch(BASE + path, { ...opts, headers, redirect: 'manual' });
  const set = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  for (const c of set) {
    const kv = c.split(';')[0];
    if (kv.startsWith('gs_session=')) jars[who] = kv.includes('gs_session=;') ? '' : kv;
  }
  const type = r.headers.get('content-type') || '';
  let body = null;
  try { body = /json/.test(type) ? await r.json() : (await r.text()).slice(0, 160); } catch {}
  return { status: r.status, body };
}
const post = (who, p, b) => call(who, p, { method: 'POST', body: JSON.stringify(b || {}) });
const put = (who, p, b) => call(who, p, { method: 'PUT', body: JSON.stringify(b || {}) });
const del = (who, p) => call(who, p, { method: 'DELETE' });

const DOC = (name) => ({
  id: 'test', name, desc: '', created: '2026-01-01', updated: '2026-01-01',
  schema: { nodeTypes: [{ key: 'stage', name: 'Узел', shape: 'rect' }],
    statuses: [{ key: 'na', name: 'без статуса', color: '#a8aebd' }],
    categories: [{ key: 'gen', name: 'Общее', color: '#3355d1' }],
    linkTypes: [{ key: 'hard', name: 'Жёсткая', color: '#999', style: 'solid', blocking: 1 }], fields: [] },
  nodes: [{ id: 'A', name: 'Первый' }, { id: 'B', name: 'Второй' }],
  links: [{ id: 'l1', from: 'A', to: 'B', type: 'hard' }],
  frames: [], notes: [], pages: [],
});

(async () => {
  try {
    // ---- вход администратором через служебный сброс пароля ----
    const { execSync } = await import('node:child_process');
    const out = execSync('docker compose exec -T api node scripts/admin.js reset-password kaitnik@gmail.com',
      { cwd: process.cwd() }).toString();
    const pass = (out.match(/пароль для \S+: (\S+)/) || [])[1];
    if (!pass) { bad('не удалось получить пароль администратора', out.slice(0, 120)); throw new Error('нет пароля'); }

    const login = await post('admin', '/api/auth/login', { email: 'kaitnik@gmail.com', password: pass });
    login.status === 200 && login.body.user.admin
      ? ok('администратор входит', login.body.user.email)
      : bad('вход администратора не прошёл', JSON.stringify(login));

    // ---- приглашение и регистрация второго человека ----
    const inv = await post('admin', '/api/invites', { email: MAIL2 });
    inv.body && inv.body.token ? ok('приглашение выписано') : bad('приглашение не выписалось', JSON.stringify(inv));

    const wrongMail = await post('guest', '/api/auth/register',
      { email: MAIL3, password: 'parol12345', invite: inv.body.token });
    wrongMail.status === 403
      ? ok('приглашение на другую почту не принимается')
      : bad('приглашение сработало для чужой почты', JSON.stringify(wrongMail));

    const reg = await post('vtoroy', '/api/auth/register',
      { email: MAIL2, password: 'parol12345', name: 'Второй', invite: inv.body.token });
    reg.status === 200 ? ok('регистрация по приглашению проходит', reg.body.user.email)
                       : bad('регистрация не прошла', JSON.stringify(reg));

    const reuse = await post('tretiy', '/api/auth/register',
      { email: MAIL2, password: 'parol12345', invite: inv.body.token });
    reuse.status !== 200 ? ok('приглашение одноразовое', 'код ' + reuse.status)
                         : bad('приглашение сработало второй раз');

    // ---- доска ----
    const created = await post('admin', '/api/boards', { doc: DOC('Тестовая доска') });
    const bid = created.body && created.body.id;
    bid ? ok('доска создаётся', bid) : bad('доска не создалась', JSON.stringify(created));

    const got = await call('admin', '/api/boards/' + bid);
    (got.status === 200 && got.body.doc.nodes.length === 2 && got.body.role === 'owner')
      ? ok('доска читается владельцем', `версия ${got.body.version}, роль ${got.body.role}`)
      : bad('чтение доски сломано', JSON.stringify(got).slice(0, 200));

    // чужой не видит
    const foreign = await call('vtoroy', '/api/boards/' + bid);
    foreign.status === 404 ? ok('чужая доска не отдаётся по прямой ссылке')
                           : bad('чужая доска доступна!', JSON.stringify(foreign).slice(0, 160));

    // ---- запись и оптимистическая блокировка ----
    const d2 = DOC('Тестовая доска'); d2.nodes.push({ id: 'C', name: 'Третий' });
    const saved = await put('admin', '/api/boards/' + bid, { doc: d2, baseVersion: got.body.version });
    saved.body && saved.body.version === got.body.version + 1
      ? ok('правка сохраняется, версия растёт', `${got.body.version} → ${saved.body.version}`)
      : bad('сохранение сломано', JSON.stringify(saved));

    const stale = await put('admin', '/api/boards/' + bid, { doc: d2, baseVersion: got.body.version });
    (stale.status === 409 && stale.body.doc && stale.body.version === saved.body.version)
      ? ok('устаревшая версия отклоняется и возвращает актуальную', 'код 409')
      : bad('запись поверх чужой версии прошла молча', JSON.stringify(stale).slice(0, 160));

    // ---- ссылки-доступы ----
    const sv = await post('admin', `/api/boards/${bid}/shares`, { role: 'viewer' });
    const se = await post('admin', `/api/boards/${bid}/shares`, { role: 'editor' });
    (sv.body.token && se.body.token && sv.body.path.startsWith('/s/') && se.body.path.startsWith('/e/'))
      ? ok('ссылки на просмотр и правку выдаются', `${sv.body.path.slice(0, 12)}… / ${se.body.path.slice(0, 12)}…`)
      : bad('ссылки не выдались', JSON.stringify({ sv: sv.body, se: se.body }));

    const anonView = await call('guest', '/api/share/' + sv.body.token);
    (anonView.status === 200 && anonView.body.role === 'viewer' && anonView.body.doc)
      ? ok('по ссылке на просмотр доска открывается без входа')
      : bad('ссылка на просмотр не работает', JSON.stringify(anonView).slice(0, 160));

    const anonEdit = await call('guest', '/api/share/' + se.body.token);
    (anonEdit.status === 401 && anonEdit.body.needAuth)
      ? ok('ссылка на правку требует входа — у правки должен быть автор')
      : bad('по ссылке на правку пустили без входа', JSON.stringify(anonEdit).slice(0, 160));

    const memberEdit = await call('vtoroy', '/api/share/' + se.body.token);
    (memberEdit.status === 200 && memberEdit.body.role === 'editor')
      ? ok('вошедший по ссылке на правку получает доступ')
      : bad('ссылка на правку не сработала для вошедшего', JSON.stringify(memberEdit).slice(0, 160));

    const nowSees = await call('vtoroy', '/api/boards/' + bid);
    nowSees.status === 200 && nowSees.body.role === 'editor'
      ? ok('доска появилась у приглашённого в списке доступных')
      : bad('доступ по ссылке не закрепился', JSON.stringify(nowSees).slice(0, 160));

    const listed = await call('vtoroy', '/api/boards');
    (listed.body.shared || []).some(b => b.id === bid)
      ? ok('доска видна в разделе «доступные мне»')
      : bad('доски нет в списке доступных', JSON.stringify(listed).slice(0, 200));

    // просмотрщик не может писать
    const svResolve = await call('guest2', '/api/share/' + sv.body.token);
    const viewerWrite = await put('guest2', '/api/boards/' + svResolve.body.id, { doc: d2 });
    (viewerWrite.status === 401 || viewerWrite.status === 403 || viewerWrite.status === 404)
      ? ok('по ссылке на просмотр писать нельзя', 'код ' + viewerWrite.status)
      : bad('просмотрщик записал в доску!', JSON.stringify(viewerWrite).slice(0, 160));

    // отзыв ссылки
    await del('admin', '/api/shares/' + sv.body.token);
    const revoked = await call('guest', '/api/share/' + sv.body.token);
    revoked.status === 404 ? ok('отозванная ссылка перестаёт работать')
                           : bad('отозванная ссылка ещё жива', JSON.stringify(revoked).slice(0, 120));

    // ---- админка ----
    const users = await call('admin', '/api/admin/users');
    (users.status === 200 && users.body.users.length >= 2)
      ? ok('админка показывает всех пользователей', 'их ' + users.body.users.length)
      : bad('список пользователей не отдался', JSON.stringify(users).slice(0, 160));

    const allBoards = await call('admin', '/api/admin/boards');
    (allBoards.status === 200 && allBoards.body.boards.some(b => b.id === bid))
      ? ok('админка показывает доски всех пользователей', 'их ' + allBoards.body.boards.length)
      : bad('доски всех не отдались', JSON.stringify(allBoards).slice(0, 160));

    const notAdmin = await call('vtoroy', '/api/admin/users');
    notAdmin.status === 403 ? ok('обычному пользователю админка закрыта')
                            : bad('админка открыта обычному пользователю!', 'код ' + notAdmin.status);

    const alog = await call('admin', '/api/admin/access-log');
    (alog.status === 200 && Array.isArray(alog.body.log))
      ? ok('журнал доступа админа ведётся', 'записей ' + alog.body.log.length)
      : bad('журнал доступа не отдался', JSON.stringify(alog).slice(0, 120));

    // ---- уборка ----
    await del('admin', '/api/boards/' + bid);
    const afterDel = await call('admin', '/api/boards');
    !(afterDel.body.mine || []).some(b => b.id === bid)
      ? ok('доска уезжает в корзину и пропадает из списка')
      : bad('доска осталась в списке после удаления');
  } catch (e) {
    bad('ПРОГОН УПАЛ', e.message);
  }

  const fail = results.filter(r => r[0] === '✗');
  console.log(`\n===== ${results.length - fail.length}/${results.length} пройдено =====`);
  process.exit(fail.length ? 1 : 0);
})();
