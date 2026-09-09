// Совместное редактирование в двух настоящих браузерах.
//
// Один браузер здесь ничего не доказывает: весь смысл в том, что правка одного
// человека доезжает до другого. Поэтому поднимаются ДВА Chrome с разными
// профилями — то есть с разными сессиями, как у двух разных людей.
//
// Набор СОЗДАЁТ данные (доску, второго пользователя), поэтому только против
// локального контейнера.
const { launch, Client, sleep } = require('./cdp');
const { execSync } = require('node:child_process');

const URL = process.env.APP_URL || 'http://127.0.0.1:8081/';
const PORT_A = 9351, PORT_B = 9352;
const results = [];
const ok = (n, d = '') => { results.push(['✓', n, d]); console.log('✓', n, d); };
const bad = (n, d = '') => { results.push(['✗', n, d]); console.log('✗', n, d); };

const GUEST = 'live-test@example.com';
const GUEST_PASS = 'test-pass-12345';

(async () => {
  let chromeA = null, chromeB = null;
  try {
    const out = execSync('docker compose exec -T api node scripts/admin.js reset-password kaitnik@gmail.com').toString();
    const pass = (out.match(/пароль для \S+: (\S+)/) || [])[1];
    if (!pass) throw new Error('не удалось получить пароль администратора');

    chromeA = await launch(PORT_A, './chrome-prof-live-a');
    const A = await Client.attach(PORT_A);
    await A.send('Emulation.setDeviceMetricsOverride', {width: 1400, height: 900, deviceScaleFactor: 1, mobile: false});
    await A.send('Page.navigate', {url: URL});
    await A.waitFor('typeof idb !== "undefined" && !!idb', 25000, 'загрузка A');

    // --- первый человек: вход, доска, ссылка на правку для второго ----------
    await A.eval(`(async () => {
      const r = await api.login('kaitnik@gmail.com', ${JSON.stringify(pass)});
      cloud.CLOUD.account = r.user; paintAccount();
    })()`);
    await A.eval(`createFromTemplate('demo')`);
    await A.waitFor('P && P.nodes.length > 0 && cloud.boundToServer()', 20000, 'доска А');
    await A.waitFor('live.LIVE.on === true', 15000, 'канал А открыт');
    ok('живой канал открывается при входе на доску');

    const boardId = await A.eval(`cloud.CLOUD.board.id`);

    // второй человек и ссылка на правку
    const link = await A.eval(`(async () => {
      try { await api.adminUserCreate(${JSON.stringify(GUEST)}, ${JSON.stringify(GUEST_PASS)}, 'Второй'); }
      catch (e) { /* уже заведён прошлым прогоном */ }
      const s = await api.shareCreate('${boardId}', 'editor', 0);
      return s.path;
    })()`);

    // --- второй человек в отдельном браузере -------------------------------
    chromeB = await launch(PORT_B, './chrome-prof-live-b');
    const B = await Client.attach(PORT_B);
    await B.send('Emulation.setDeviceMetricsOverride', {width: 1400, height: 900, deviceScaleFactor: 1, mobile: false});
    await B.send('Page.navigate', {url: URL});
    await B.waitFor('typeof idb !== "undefined" && !!idb', 25000, 'загрузка B');
    await B.eval(`(async () => {
      const r = await api.login(${JSON.stringify(GUEST)}, ${JSON.stringify(GUEST_PASS)});
      cloud.CLOUD.account = r.user; paintAccount();
      await openShare('${link.replace(/^\/e\//, '')}', 'editor');
    })()`);
    await B.waitFor('P && P.nodes.length > 0 && cloud.boundToServer()', 20000, 'доска B');
    await B.waitFor('live.LIVE.on === true', 15000, 'канал B открыт');
    ok('второй человек открывает ту же доску по ссылке на правку');

    // --- присутствие --------------------------------------------------------
    await A.waitFor('live.LIVE.peers.length === 2', 10000, 'A видит двоих').catch(() => {});
    const peersA = await A.eval(`({n: live.LIVE.peers.length, other: live.peersOther().map(p => p.email),
      avatars: document.querySelectorAll('#tbMembers .avat').length})`);
    (peersA.n === 2 && peersA.other.includes(GUEST) && peersA.avatars === 1)
      ? ok('видно, что на доске не один', peersA.other.join(', '))
      : bad('присутствие не показано', JSON.stringify(peersA));

    // --- правка первого доезжает до второго ---------------------------------
    const before = await B.eval(`P.nodes[0].name`);
    await A.eval(`(() => { P.nodes[0].name = 'ПРАВКА ПЕРВОГО'; save(1); return true; })()`);
    let got = false;
    for (let i = 0; i < 40 && !got; i++) {
      got = await B.eval(`P.nodes[0].name === 'ПРАВКА ПЕРВОГО'`).catch(() => false);
      if (!got) await sleep(300);
    }
    const bState = await B.eval(`({name: P.nodes[0].name, ver: cloud.CLOUD.board.version,
      drawn: (document.querySelector('.nd[data-n="' + P.nodes[0].id + '"]') || {}).textContent || ''})`);
    got ? ok('чужая правка приезжает сама, без перезагрузки', 'версия ' + bState.ver)
        : bad('правка не доехала', `было «${before}», стало «${bState.name}»`);

    // --- и обратно ----------------------------------------------------------
    await B.eval(`(() => { P.nodes[1].sub = 'ОТВЕТ ВТОРОГО'; save(1); return true; })()`);
    let back = false;
    for (let i = 0; i < 40 && !back; i++) {
      back = await A.eval(`P.nodes[1].sub === 'ОТВЕТ ВТОРОГО'`).catch(() => false);
      if (!back) await sleep(300);
    }
    back ? ok('правка едет в обе стороны') : bad('обратная правка не доехала');

    // --- большая доска: сервер шлёт уведомление, клиент догружает сам ---------
    // Документ больше LIVE_FULL_MAX по живому каналу не рассылается: он ушёл бы
    // каждому на каждое сохранение. Вместо него приходит {t:'stale'} без doc,
    // и правка обязана доехать всё равно — просто другим путём.
    await A.eval(`(() => {
      P.notes = [];
      for (let i = 0; i < 400; i++) P.notes.push({id: 'big' + i, text: 'z'.repeat(900), x: i, y: i, w: 200, h: 96, color: ''});
      P.nodes[0].sub = 'ТОЛСТАЯ ДОСКА';
      save(1); return JSON.stringify(P).length;
    })()`);
    let heavy = false;
    for (let i = 0; i < 60 && !heavy; i++) {
      heavy = await B.eval(`P.nodes[0].sub === 'ТОЛСТАЯ ДОСКА' && (P.notes || []).length === 400`).catch(() => false);
      if (!heavy) await sleep(300);
    }
    const size = await B.eval(`JSON.stringify(P).length`).catch(() => 0);
    heavy ? ok('правка на большой доске доезжает уведомлением с догрузкой', Math.round(size / 1024) + ' КБ')
          : bad('большая доска не доехала до второго', Math.round(size / 1024) + ' КБ');

    // --- двое клеят стикеры одновременно ------------------------------------
    // На доске одновременная правка — не исключение, а весь смысл. Раньше второй
    // получал модалку «взять серверную», то есть «потерять свой стикер».
    const JPID = await A.eval(`(() => {
      P.notes = [];
      const pg = {id: uid('p'), name: 'Доска', kind: 'jam',
        filter: {q: '', cats: [], statuses: [], types: [], f: {}}, jam: {items: [], bg: 'dots'}};
      P.pages.push(pg); save(1); return pg.id;
    })()`);
    // ждём, пока страница доедет до второго
    let hasPage = false;
    for (let i = 0; i < 40 && !hasPage; i++) {
      hasPage = await B.eval(`!!P.pages.find(p => p.id === ${JSON.stringify(JPID)})`).catch(() => false);
      if (!hasPage) await sleep(300);
    }
    hasPage ? ok('доска доехала до второго участника') : bad('доска не доехала');

    // Оба ставят по стикеру, не дав друг другу сохраниться: это и есть 409.
    await A.eval(`(() => { const pg = pageById(${JSON.stringify(JPID)});
      pg.jam.items.push({id: 'from_A', kind: 'sticky', x: 40, y: 40, w: 180, h: 180, fill: '#ffd93b', text: 'от первого'});
      save(1); return true; })()`);
    await B.eval(`(() => { const pg = pageById(${JSON.stringify(JPID)});
      pg.jam.items.push({id: 'from_B', kind: 'sticky', x: 300, y: 40, w: 180, h: 180, fill: '#c9e3ff', text: 'от второго'});
      save(1); return true; })()`);

    let bothSeen = false, whoLost = null;
    for (let i = 0; i < 50 && !bothSeen; i++) {
      const st = await B.eval(`(() => { const pg = pageById(${JSON.stringify(JPID)});
        const ids = (pg.jam.items || []).map(i => i.id);
        return {ids, modal: document.getElementById('modal').classList.contains('open')}; })()`).catch(() => null);
      if (st) { whoLost = st; bothSeen = st.ids.includes('from_A') && st.ids.includes('from_B'); }
      if (!bothSeen) await sleep(300);
    }
    bothSeen ? ok('оба стикера на доске: правки слиты, а не затёрты')
             : bad('чей-то стикер потерян', JSON.stringify(whoLost));

    const modalUp = await B.eval(`document.getElementById('modal').classList.contains('open')`).catch(() => false);
    !modalUp ? ok('слияние прошло без вопросов человеку')
             : bad('вылезла модалка разрешения конфликта');

    // И у первого тоже должны оказаться оба.
    let bothOnA = false;
    for (let i = 0; i < 40 && !bothOnA; i++) {
      bothOnA = await A.eval(`(() => { const pg = pageById(${JSON.stringify(JPID)});
        const ids = (pg.jam.items || []).map(i => i.id);
        return ids.includes('from_A') && ids.includes('from_B'); })()`).catch(() => false);
      if (!bothOnA) await sleep(300);
    }
    bothOnA ? ok('оба стикера доехали и до первого') : bad('у первого пропал чужой стикер');

    // --- курсоры ------------------------------------------------------------
    await A.eval(`(() => { live.sendCursor(500, 400, UI.page); return true; })()`);
    let cur = null;
    for (let i = 0; i < 25 && !cur; i++) {
      cur = await B.eval(`(() => { const k = Object.keys(live.LIVE.cursors);
        return k.length ? live.LIVE.cursors[k[0]] : null; })()`).catch(() => null);
      if (!cur) await sleep(250);
    }
    cur ? ok('чужой курсор виден', `${cur.name} @ ${cur.x},${cur.y}`) : bad('курсор не доехал');

    // --- история ------------------------------------------------------------
    const hist = await A.eval(`(async () => {
      const h = await api.versions('${boardId}');
      return {current: h.current, n: h.versions.length,
        top: h.versions.slice(0, 3).map(v => v.summary), authors: [...new Set(h.versions.map(v => v.actor_email))]};
    })()`);
    (hist.n >= 3 && hist.top.some(s => s && s !== 'доска создана'))
      ? ok('история пишется и объясняет, что поменялось', hist.top.filter(Boolean)[0])
      : bad('история пустая или без подписей', JSON.stringify(hist));
    (hist.authors.length === 2)
      ? ok('в истории видно, кто именно правил', hist.authors.join(', '))
      : bad('авторы в истории не различаются', JSON.stringify(hist.authors));

    // --- возврат версии -----------------------------------------------------
    const restored = await A.eval(`(async () => {
      const h = await api.versions('${boardId}');
      // самая ранняя из сохранённых — там ещё нет «ПРАВКИ ПЕРВОГО»
      const first = h.versions[h.versions.length - 1];
      const r = await api.versionRestore('${boardId}', first.version);
      return {from: r.from, version: r.version, name: r.doc.nodes[0].name};
    })()`);
    (restored.name !== 'ПРАВКА ПЕРВОГО' && restored.version > restored.from)
      ? ok('возврат к прежней версии работает и не стирает историю', `версия ${restored.from} → ${restored.version}`)
      : bad('возврат версии не сработал', JSON.stringify(restored));

    // Возврат — это тоже правка, и он обязан доехать до второго так же, как любая другая.
    let seen = false;
    for (let i = 0; i < 40 && !seen; i++) {
      seen = await B.eval(`P.nodes[0].name !== 'ПРАВКА ПЕРВОГО'`).catch(() => false);
      if (!seen) await sleep(300);
    }
    seen ? ok('возврат версии доезжает до второго') : bad('возврат версии не разошёлся');

    // --- история в интерфейсе, а не только в API -----------------------------
    const ui = await A.eval(`(async () => {
      await showHistory();
      const box = document.getElementById('mbox');
      const rows = box.querySelectorAll('[data-see]').length;
      const canBack = box.querySelectorAll('[data-back]').length;
      closeModal();
      return {rows, canBack};
    })()`);
    (ui.rows >= 3 && ui.canBack >= 1)
      ? ok('история открывается в интерфейсе', `${ui.rows} версий, вернуть можно ${ui.canBack}`)
      : bad('окно истории пустое', JSON.stringify(ui));

    const peek = await A.eval(`(async () => {
      // на дашборде узлов на экране нет по определению — смотрим версию на холсте
      gotoPage(P.pages.find(p => p.kind === 'canvas').id);
      const h = await api.versions('${boardId}');
      await viewVersion(h.versions[h.versions.length - 1].version);
      return {v: UI.viewVersion, ro: ro(), bar: !!document.getElementById('verbar'),
              drawn: document.querySelectorAll('.nd[data-n]').length};
    })()`);
    (peek.v && peek.ro && peek.bar && peek.drawn > 0)
      ? ok('старую версию видно на холсте и она только читается', 'версия ' + peek.v)
      : bad('просмотр версии не работает', JSON.stringify(peek));

    const backNow = await A.eval(`(async () => { await exitVersionView();
      return {v: UI.viewVersion, ro: ro(), bar: !!document.getElementById('verbar')}; })()`);
    (!backNow.v && !backNow.ro && !backNow.bar)
      ? ok('возврат к текущей версии снимает режим просмотра')
      : bad('из просмотра версии не выйти', JSON.stringify(backNow));

    // --- уход ---------------------------------------------------------------
    await B.eval(`goHome()`);
    let alone = false;
    for (let i = 0; i < 30 && !alone; i++) {
      alone = await A.eval(`live.LIVE.peers.length === 1`).catch(() => false);
      if (!alone) await sleep(300);
    }
    alone ? ok('ушедший пропадает из списка присутствующих')
          : bad('ушедший остался висеть в присутствующих');

    const errA = (await A.eval(`1`), A.errors), errB = B.errors;
    (!errA.length && !errB.length) ? ok('исключений в консоли нет')
      : bad('исключения', [...errA, ...errB].join(' | ').slice(0, 300));
  } catch (e) {
    bad('ПРОГОН УПАЛ', e.message);
  } finally {
    try { chromeA && chromeA.kill(); } catch {}
    try { chromeB && chromeB.kill(); } catch {}
  }

  const good = results.filter(r => r[0] === '✓').length;
  console.log(`\n===== ${good}/${results.length} пройдено =====`);
  if (good < results.length) {
    console.log('ПРОВАЛЫ:');
    results.filter(r => r[0] === '✗').forEach(r => console.log(' ✗', r[1], r[2]));
    process.exit(1);
  }
})();
