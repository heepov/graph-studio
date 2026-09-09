// Сквозная проверка связки клиент-сервер в настоящем браузере:
// вход → отправка проекта на сервер → правка уезжает → ссылка-доступ открывается.
//
// Набор СОЗДАЁТ данные, поэтому только против локального контейнера.
const { launch, Client, sleep } = require('./cdp');
const { execSync } = require('node:child_process');

const URL = process.env.APP_URL || 'http://127.0.0.1:8081/';
const PORT = 9336;
const results = [];
const ok = (n, d = '') => { results.push(['✓', n, d]); console.log('✓', n, d); };
const bad = (n, d = '') => { results.push(['✗', n, d]); console.log('✗', n, d); };

(async () => {
  const chrome = await launch(PORT, './chrome-prof-cloud');
  const c = await Client.attach(PORT);
  await c.send('Emulation.setDeviceMetricsOverride', {width: 1500, height: 950, deviceScaleFactor: 1, mobile: false});
  try {
    const out = execSync('docker compose exec -T api node scripts/admin.js reset-password kaitnik@gmail.com').toString();
    const pass = (out.match(/пароль для \S+: (\S+)/) || [])[1];
    if (!pass) throw new Error('не удалось получить пароль администратора');

    await c.send('Page.navigate', {url: URL});
    await c.waitFor('typeof idb !== "undefined" && !!idb', 25000, 'загрузка');
    await c.eval('(closeModal(), true)');

    // без входа приложение обязано работать: локальные проекты никуда не делись
    const anon = await c.eval(`({acc: cloud.CLOUD.account, online: cloud.CLOUD.online})`);
    (anon.acc === null && anon.online === true)
      ? ok('без входа приложение работает, сервер виден')
      : bad('состояние до входа неверное', JSON.stringify(anon));

    // вход
    const login = await c.eval(`(async () => {
      const r = await api.login('kaitnik@gmail.com', ${JSON.stringify(pass)});
      cloud.CLOUD.account = r.user; paintAccount();
      return {email: r.user.email, admin: r.user.admin,
              nav: document.querySelector('#navAccount .nm').textContent,
              adminVisible: !document.getElementById('navAdmin').classList.contains('hidden')};
    })()`);
    (login.admin && login.adminVisible)
      ? ok('вход выполняется, админка появляется в панели', login.nav)
      : bad('вход или отображение аккаунта сломаны', JSON.stringify(login));

    // создаём локальный проект из демо-шаблона и отправляем на сервер
    await c.waitFor('document.querySelector(\'#tList .pcard[data-t="demo"]\')', 15000, 'шаблон');
    await c.eval('document.querySelector(\'#tList .pcard[data-t="demo"]\').click()');
    await c.waitFor('typeof P !== "undefined" && P && P.nodes.length > 0', 15000, 'проект');
    await sleep(800);

    const up = await c.eval(`(async () => {
      const id = await cloud.uploadProject(P);
      await openServerBoard(id);
      return {id, bound: cloud.boundToServer(), version: cloud.CLOUD.board.version,
              role: cloud.CLOUD.board.role, url: location.pathname,
              share: !document.getElementById('bShare').classList.contains('hidden')};
    })()`);
    (up.bound && up.role === 'owner' && up.url === '/b/' + up.id)
      ? ok('проект уезжает на сервер и открывается как доска', `${up.id}, версия ${up.version}`)
      : bad('отправка на сервер не сработала', JSON.stringify(up));
    up.share ? ok('кнопка «Поделиться» появляется у серверной доски')
             : bad('кнопки «Поделиться» нет');

    // правка должна уехать на сервер
    const edited = await c.eval(`(async () => {
      const n = P.nodes[0];
      n.name = 'ИЗМЕНЕНО КЛИЕНТОМ';
      save();
      await new Promise(r => setTimeout(r, 2000));   // дебаунс отправки 900 мс
      const srv = await api.boardGet(cloud.CLOUD.board.id);
      return {local: n.name, server: srv.doc.nodes[0].name, version: srv.version, bound: cloud.CLOUD.board.version};
    })()`);
    (edited.server === 'ИЗМЕНЕНО КЛИЕНТОМ' && edited.bound === edited.version)
      ? ok('правка уезжает на сервер, версия синхронизирована', 'версия ' + edited.version)
      : bad('правка не доехала до сервера', JSON.stringify(edited));

    // конфликт версий обрабатывается, а не затирает молча
    const conflict = await c.eval(`(async () => {
      const id = cloud.CLOUD.board.id;
      const cur = await api.boardGet(id);
      // кто-то другой записал свою версию
      const other = JSON.parse(JSON.stringify(cur.doc));
      other.nodes[0].name = 'ПРАВКА КОЛЛЕГИ';
      await api.boardPut(id, other, cur.version);
      // а мы правим от устаревшей версии
      P.nodes[0].name = 'МОЯ ПРАВКА';
      save();
      await new Promise(r => setTimeout(r, 2200));
      const modalOpen = document.getElementById('modal').classList.contains('open');
      const text = document.getElementById('mbox').textContent || '';
      return {modalOpen, mentions: /изменил кто-то ещё/i.test(text)};
    })()`);
    (conflict.modalOpen && conflict.mentions)
      ? ok('конфликт версий показывается человеку, а не затирается молча')
      : bad('конфликт версий обработан неверно', JSON.stringify(conflict));
    await c.eval('(closeModal(), true)');

    // ссылка на просмотр
    const share = await c.eval(`(async () => {
      const r = await api.shareCreate(cloud.CLOUD.board.id, 'viewer', 0);
      return {token: r.token, path: r.path};
    })()`);
    share.path.startsWith('/s/') ? ok('ссылка на просмотр создаётся') : bad('ссылка не создалась', JSON.stringify(share));

    await c.send('Page.navigate', {url: URL.replace(/\/$/, '') + share.path});
    await c.waitFor('typeof P !== "undefined" && P && P.nodes && P.nodes.length > 0', 20000, 'открытие по ссылке');
    await sleep(600);
    const viewed = await c.eval(`({nodes: P.nodes.length, readonly: document.body.classList.contains('readonly'),
      bound: cloud.boundToServer(), title: document.title})`);
    (viewed.nodes > 0 && viewed.readonly && !viewed.bound)
      ? ok('доска открывается по ссылке в режиме просмотра', `${viewed.nodes} узлов`)
      : bad('открытие по ссылке сломано', JSON.stringify(viewed));

    // режим просмотра должен быть настоящим, а не только спрятанными кнопками
    const roCheck = await c.eval(`(async () => {
      const before = P.nodes[0].name;
      P.nodes[0].name = 'ПОПЫТКА ПРАВКИ ИЗ ПРОСМОТРА';
      save(1);
      await new Promise(r => setTimeout(r, 700));
      const stored = await dbGet(STORE, P.id).catch(() => null);
      return {ro: ro(), saved: stored ? stored.nodes[0].name : null, before,
              ports: document.querySelectorAll('.port').length,
              hidden: getComputedStyle(document.getElementById('bAdd')).display};
    })()`);
    roCheck.ro ? ok('режим только чтения включён') : bad('режим только чтения не включился');
    (roCheck.saved !== 'ПОПЫТКА ПРАВКИ ИЗ ПРОСМОТРА')
      ? ok('правка в режиме просмотра не сохраняется')
      : bad('правка в режиме просмотра записалась в базу!', JSON.stringify(roCheck));
    roCheck.hidden === 'none' ? ok('органы правки скрыты') : bad('кнопки правки видны', roCheck.hidden);

    const errs = c.errors.filter(e => !/favicon|manifest/i.test(e));
    errs.length ? bad('исключения в консоли', errs.join(' | ').slice(0, 300))
                : ok('исключений в консоли нет');
  } catch (e) {
    bad('ПРОГОН УПАЛ', e.message);
    console.log('ошибки:', c.errors.slice(-5).join('\n'));
  } finally {
    chrome.kill();
  }

  const fail = results.filter(r => r[0] === '✗');
  console.log(`\n===== ${results.length - fail.length}/${results.length} пройдено =====`);
  process.exit(fail.length ? 1 : 0);
})();
