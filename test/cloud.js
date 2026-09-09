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

    // Без входа человек должен увидеть, что это за инструмент и куда войти.
    // Раньше здесь был пустой список проектов без единой кнопки входа.
    const anon = await c.eval(`({acc: cloud.CLOUD.account, online: cloud.CLOUD.online,
      landing: document.getElementById('landing').classList.contains('open'),
      loginBtn: !!document.querySelector('#landing [data-a=login]'),
      demoBtn: !!document.querySelector('#landing [data-a=demo]')})`);
    (anon.acc === null && anon.online === true && anon.landing && anon.loginBtn && anon.demoBtn)
      ? ok('без входа открывается витрина с кнопками «Войти» и «Демо»')
      : bad('витрина до входа не показана', JSON.stringify(anon));

    // вход
    const login = await c.eval(`(async () => {
      const r = await api.login('kaitnik@gmail.com', ${JSON.stringify(pass)});
      cloud.CLOUD.account = r.user; paintAccount(); await home.showHome('all');
      return {email: r.user.email, admin: r.user.admin,
              nav: document.getElementById('hAvatar').textContent,
              adminVisible: !!document.querySelector('#hnav [data-a=admin]')};
    })()`);
    (login.admin && login.adminVisible)
      ? ok('вход выполняется, админка появляется в панели', login.nav)
      : bad('вход или отображение аккаунта сломаны', JSON.stringify(login));

    // Новая доска создаётся СРАЗУ на сервере: промежуточного локального шага
    // больше нет. Раньше «＋ проект» клал файл в браузер, и человек узнавал,
    // что доски нет на втором устройстве, уже потеряв её.
    await c.waitFor('typeof createFromTemplate === "function"', 15000, 'приложение готово');
    await c.eval('createFromTemplate(\'demo\')');
    await c.waitFor('typeof P !== "undefined" && P && P.nodes.length > 0 && cloud.boundToServer()',
      20000, 'доска на сервере');
    await sleep(800);

    const up = await c.eval(`({id: cloud.CLOUD.board.id, bound: cloud.boundToServer(),
      version: cloud.CLOUD.board.version, role: cloud.CLOUD.board.role, url: location.pathname,
      share: !document.getElementById('bShare').classList.contains('hidden')})`);
    (up.bound && up.role === 'owner' && up.url === '/b/' + up.id)
      ? ok('новая доска создаётся сразу на сервере', `${up.id}, версия ${up.version}`)
      : bad('доска не создалась на сервере', JSON.stringify(up));
    up.share ? ok('кнопка «Поделиться» появляется у серверной доски')
             : bad('кнопки «Поделиться» нет');

    // превью для карточки в списке: без него сетка досок — просто столбик названий
    const prev = await c.eval(`(async () => {
      gotoPage(P.pages.find(p => p.kind === 'canvas').id);
      await new Promise(r => setTimeout(r, 900));
      const p = buildPreview();
      P.desc = (P.desc || '') + '.';
      save();
      await new Promise(r => setTimeout(r, 2200));
      const list = await api.boards();
      const row = list.mine.find(b => b.id === cloud.CLOUD.board.id);
      let parsed = null; try { parsed = JSON.parse(row.preview); } catch {}
      return {built: p ? p.n.length : 0, stored: parsed ? parsed.n.length : 0};
    })()`);
    (prev.built > 0 && prev.stored === prev.built)
      ? ok('превью доски считается и доезжает до сервера', prev.stored + ' узлов')
      : bad('превью не сохраняется', JSON.stringify(prev));

    // Импорт кладёт доску сразу на сервер: файл — это способ занести работу внутрь,
    // а не второе место, где она живёт.
    const imp = await c.eval(`(async () => {
      const before = cloud.CLOUD.board.id;
      await importText(JSON.stringify({name: 'Из файла', desc: '', nodes: [
        {id: 'f1', name: 'Один'}, {id: 'f2', name: 'Два'}], links: [{id:'fl', from:'f1', to:'f2'}], pages: []}), 'new');
      const list = await api.boards();
      const row = list.mine.find(b => b.name === 'Из файла');
      return {opened: cloud.CLOUD.board.id, changed: cloud.CLOUD.board.id !== before,
              onServer: !!row, nodes: row ? row.nodes_count : 0,
              local: localProjects().some(p => p.name === 'Из файла'),
              cached: PROJECTS.some(p => p.id.startsWith('srv_') && p.name === 'Из файла')};
    })()`);
    (imp.onServer && imp.changed && imp.nodes === 2 && !imp.local && imp.cached)
      ? ok('импорт создаёт доску на сервере и открывает её', imp.opened)
      : bad('импорт не уехал на сервер', JSON.stringify(imp));

    // Копия всего должна содержать серверные доски: раньше бэкап брал только
    // IndexedDB и после переезда молча не содержал бы главного.
    const bk = await c.eval(`(async () => {
      let blob = null; const orig = URL.createObjectURL;
      URL.createObjectURL = b => { blob = b; return orig.call(URL, b); };
      try { await backupAll(); } finally { URL.createObjectURL = orig; }
      const d = blob ? JSON.parse(await blob.text()) : null;
      return d && {count: d.projects.length, hasImported: d.projects.some(p => p.name === 'Из файла')};
    })()`);
    (bk && bk.count > 0 && bk.hasImported)
      ? ok('копия всего содержит доски с сервера', bk.count + ' досок')
      : bad('бэкап не забрал серверные доски', JSON.stringify(bk));

    // Вернуться к доске, которую правим дальше.
    await c.eval(`(async () => { const l = await api.boards();
      await openServerBoard(l.mine.find(b => b.name.indexOf('Демо') === 0).id); })()`);
    await sleep(700);

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

    // Конфликт версий обрабатывается, а не затирает молча.
    //
    // Порядок здесь важен и он же — настоящий: СНАЧАЛА своя правка (она встаёт
    // в очередь на 900 мс), и уже потом чужая. Пока своё не ушло, живой канал
    // чужую правку НЕ применяет — иначе он затёр бы работу, которую человек
    // делает прямо сейчас, — и отправка упирается в 409 с разбором конфликта.
    const conflict = await c.eval(`(async () => {
      const id = cloud.CLOUD.board.id;
      P.nodes[0].name = 'МОЯ ПРАВКА';
      save();                                    // очередь отправки: 900 мс
      const cur = await api.boardGet(id);
      const other = JSON.parse(JSON.stringify(cur.doc));
      other.nodes[0].name = 'ПРАВКА КОЛЛЕГИ';
      await api.boardPut(id, other, cur.version);   // коллега успел раньше
      await new Promise(r => setTimeout(r, 2500));
      const modalOpen = document.getElementById('modal').classList.contains('open');
      const text = document.getElementById('mbox').textContent || '';
      return {modalOpen, mentions: /изменил кто-то ещё/i.test(text)};
    })()`);
    (conflict.modalOpen && conflict.mentions)
      ? ok('конфликт версий показывается человеку, а не затирается молча')
      : bad('конфликт версий обработан неверно', JSON.stringify(conflict));
    await c.eval('(closeModal(), true)');

    // Меню карточки и меню аккаунта: проверяем, что меню реально ВИДНО, а не что
    // на нём висит класс .open. Ровно так баг и прожил: #ctx с z-index 200
    // открывался под списком досок (250), и обе кнопки выглядели мёртвыми.
    const menus = await c.eval(`(async () => {
      await home.showHome('all');
      await new Promise(r => setTimeout(r, 600));
      const seen = el => {
        const r = el.getBoundingClientRect();
        const top = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + 8));
        return !!(top && top.closest('#ctx'));
      };
      const out = {};

      document.querySelector('#hmain .bcard [data-menu]').click();
      await new Promise(r => setTimeout(r, 150));
      const ctx = document.getElementById('ctx');
      out.cardOpen = ctx.classList.contains('open');
      out.cardVisible = out.cardOpen && seen(ctx.querySelector('.mlist'));
      out.cardItems = [...ctx.querySelectorAll('.mi')].map(m => m.textContent);
      hideCtx();

      document.getElementById('hAvatar').click();
      await new Promise(r => setTimeout(r, 150));
      out.accOpen = ctx.classList.contains('open');
      out.accVisible = out.accOpen && seen(ctx.querySelector('.mlist'));
      out.accItems = [...ctx.querySelectorAll('.mi')].map(m => m.textContent);
      hideCtx();
      return out;
    })()`);
    (menus.cardVisible && menus.cardItems.some(t => /корзин/i.test(t)))
      ? ok('меню карточки доски открывается и видно', menus.cardItems.join(' / '))
      : bad('меню карточки не работает', JSON.stringify(menus));
    (menus.accVisible && menus.accItems.some(t => /Выйти/.test(t)))
      ? ok('меню аккаунта открывается и видно', menus.accItems.join(' / '))
      : bad('меню аккаунта не работает', JSON.stringify(menus));

    // Доска действительно удаляется из списка через это меню.
    const del = await c.eval(`(async () => {
      const list = await api.boards();
      const victim = list.mine.find(b => b.name === 'Из файла') || list.mine[0];
      const before = list.mine.length;
      await api.boardDelete(victim.id);
      await home.refreshBoards();
      const after = (await api.boards()).mine.length;
      const gone = !document.querySelector('#hmain .bcard[data-b="' + victim.id + '"]');
      return {before, after, gone, name: victim.name};
    })()`);
    (del.after === del.before - 1 && del.gone)
      ? ok('доска убирается в корзину и пропадает из сетки', del.name)
      : bad('удаление доски не сработало', JSON.stringify(del));

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
