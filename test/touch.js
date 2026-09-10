// Холст пальцем: панорама, щипок, перетаскивание узла, двойное касание, канбан.
//
// Проверять это мышью бессмысленно: до перехода на pointer-события холст слушал
// только mouse*, и с телефона не работал вообще — ни подвинуть карту, ни открыть
// узел. Поэтому здесь настоящие касания через Input.dispatchTouchEvent.
const { launch, Client, sleep } = require('./cdp');

const URL = process.env.APP_URL || 'http://127.0.0.1:8081/';
const PORT = 9361;
// createFromTemplate() асинхронна, и P наполняется РАНЬШЕ, чем закрывается главный
// экран. В это окно #home ещё лежит поверх редактора: elementFromPoint попадает в него,
// клики и сочетания клавиш уходят не туда, и прогон падает «не нашёл узел на холсте».
// Ждать надо не появления данных, а того, что редактор действительно виден.
const EDITOR_SHOWN = " && !document.body.classList.contains('onhome')";
const results = [];
const ok = (n, d = '') => { results.push(['✓', n, d]); console.log('✓', n, d); };
const bad = (n, d = '') => { results.push(['✗', n, d]); console.log('✗', n, d); };

(async () => {
  const chrome = await launch(PORT, './chrome-prof-touch');
  const c = await Client.attach(PORT);
  try {
    await c.send('Emulation.setDeviceMetricsOverride', {
      width: 900, height: 1000, deviceScaleFactor: 1, mobile: true,
    });
    await c.touchOn();
    await c.send('Page.navigate', { url: URL });
    await c.waitFor('typeof idb !== "undefined" && !!idb', 25000, 'загрузка');
    await c.eval(`createFromTemplate('demo')`);
    await c.waitFor('P && P.nodes.length > 0' + EDITOR_SHOWN, 20000, 'проект');
    await c.eval(`gotoPage(P.pages.find(p => p.kind === 'canvas').id)`);
    await sleep(1200);

    const box = await c.eval(`(() => { const r = document.getElementById('cv').getBoundingClientRect();
      return {x: r.x, y: r.y, w: r.width, h: r.height}; })()`);
    const cx = Math.round(box.x + box.w / 2), cy = Math.round(box.y + box.h / 2);

    // --- панорама одним пальцем по пустому месту --------------------------
    const v0 = await c.eval(`JSON.parse(JSON.stringify(view()))`);
    // пустое место ищем ниже узлов, у нижнего края холста
    const py = Math.round(box.y + box.h - 60);
    await c.touch('touchStart', [{ x: cx, y: py }]);
    for (let i = 1; i <= 6; i++) await c.touch('touchMove', [{ x: cx - i * 20, y: py - i * 8 }]);
    await c.touch('touchEnd', []);
    await sleep(300);
    const v1 = await c.eval(`JSON.parse(JSON.stringify(view()))`);
    (Math.abs(v1.x - v0.x) > 40)
      ? ok('одним пальцем холст возится', `x ${Math.round(v0.x)} → ${Math.round(v1.x)}`)
      : bad('панорама пальцем не работает', JSON.stringify([v0, v1]));

    // одним пальцем по пустому месту НЕ должна появляться рамка выделения
    const marq = await c.eval(`getComputedStyle(document.getElementById('marq')).display`);
    marq === 'none' ? ok('рамка выделения пальцем не рисуется')
                    : bad('палец рисует рамку выделения вместо панорамы', marq);

    // --- щипок ------------------------------------------------------------
    const k0 = await c.eval(`view().k`);
    await c.touch('touchStart', [{ x: cx - 60, y: cy, id: 1 }, { x: cx + 60, y: cy, id: 2 }]);
    for (let i = 1; i <= 6; i++) {
      const d = 60 + i * 22;
      await c.touch('touchMove', [{ x: cx - d, y: cy, id: 1 }, { x: cx + d, y: cy, id: 2 }]);
    }
    await c.touch('touchEnd', []);
    await sleep(300);
    const k1 = await c.eval(`view().k`);
    (k1 > k0 * 1.4)
      ? ok('щипок двумя пальцами меняет масштаб', `${k0.toFixed(2)} → ${k1.toFixed(2)}`)
      : bad('щипок не масштабирует', `${k0} → ${k1}`);

    // --- перетаскивание узла пальцем --------------------------------------
    const nd = await c.eval(`(() => { fitAll(); const el = document.querySelector('.nd[data-n]');
      const r = el.getBoundingClientRect();
      // середина узла: у краёв сидят порты связей, и палец там тянул бы связь
      return {id: el.dataset.n, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2)}; })()`);
    await sleep(300);
    const before = await c.eval(`JSON.parse(JSON.stringify(cvPos['${nd.id}']))`);
    await c.touch('touchStart', [{ x: nd.x, y: nd.y }]);
    for (let i = 1; i <= 8; i++) await c.touch('touchMove', [{ x: nd.x + i * 14, y: nd.y + i * 9 }]);
    await c.touch('touchEnd', []);
    await sleep(500);
    const after = await c.eval(`JSON.parse(JSON.stringify(cvPos['${nd.id}']))`);
    (Math.abs(after.x - before.x) > 20 || Math.abs(after.y - before.y) > 20)
      ? ok('узел перетаскивается пальцем', JSON.stringify(after))
      : bad('узел пальцем не двигается', `${JSON.stringify(before)} → ${JSON.stringify(after)}`);

    const stored = await c.eval(`(() => { const n = nodeById('${nd.id}');
      return n.p && n.p[UI.page] ? JSON.parse(JSON.stringify(n.p[UI.page])) : null; })()`);
    stored ? ok('позиция после пальца записана в документ', JSON.stringify(stored))
           : bad('позиция после перетаскивания пальцем не сохранилась');

    // --- двойное касание по пустому месту создаёт узел ---------------------
    const n0 = await c.eval(`P.nodes.length`);
    const ex = Math.round(box.x + 90), ey = Math.round(box.y + box.h - 90);
    for (const t of [0, 1]) {
      await c.touch('touchStart', [{ x: ex, y: ey }]);
      await c.touch('touchEnd', []);
      if (!t) await sleep(90);
    }
    await sleep(700);
    const n1 = await c.eval(`P.nodes.length`);
    (n1 === n0 + 1) ? ok('двойное касание создаёт узел', `${n0} → ${n1}`)
                    : bad('двойное касание не создало узел', `${n0} → ${n1}`);

    // --- долгое нажатие открывает контекстное меню -------------------------
    // Точку ищем заново и проверяем, что под ней действительно холст: после
    // создания узла открылась панель и всплыло уведомление, и «пустое место»,
    // посчитанное в начале прогона, пустым быть перестало.
    await c.eval(`(closeInsp(), hideCtx(), document.getElementById('toast').classList.remove('on'), true)`);
    await sleep(200);
    const spot = await c.eval(`(() => {
      const cv = document.getElementById('cv'), r = cv.getBoundingClientRect();
      for (let fy = 0.75; fy > 0.2; fy -= 0.07) {
        for (let fx = 0.2; fx < 0.9; fx += 0.1) {
          const x = Math.round(r.x + r.width * fx), y = Math.round(r.y + r.height * fy);
          const el = document.elementFromPoint(x, y);
          if (el && (el.id === 'cv' || el.id === 'scene' || el.id === 'marq')) return {x, y};
        }
      }
      return null;
    })()`);
    if (!spot) bad('не нашлось пустого места на холсте');
    else {
      await c.touch('touchStart', [{ x: spot.x, y: spot.y }]);
      await sleep(750);
      await c.touch('touchEnd', []);
      await sleep(200);
      const ctxOpen = await c.eval(`document.getElementById('ctx').classList.contains('open')`);
      ctxOpen ? ok('долгое нажатие открывает контекстное меню')
              : bad('долгое нажатие ничего не открыло', JSON.stringify(spot));
    }
    await c.eval(`hideCtx()`);

    // Порты связей на тач-устройстве не должны ловить палец у невыбранного узла:
    // раньше вместо перетаскивания из невидимого кружка тянулась связь.
    const ports = await c.eval(`(() => {
      const el = document.querySelector('.nd[data-n]:not(.sel)') || document.querySelector('.nd[data-n]');
      const p = el.querySelector('.port');
      return p ? getComputedStyle(p).pointerEvents : 'нет портов';
    })()`);
    ports === 'none' ? ok('порты связей не перехватывают палец у невыбранного узла')
                     : bad('порт ловит палец у невыбранного узла', ports);

    // --- канбан: карточка переносится пальцем ------------------------------
    const kb = await c.eval(`(() => {
      const pg = P.pages.find(p => p.kind === 'board'); if (!pg) return null;
      gotoPage(pg.id); return pg.board.groupBy; })()`);
    await sleep(700);
    if (!kb) bad('канбан-страницы нет в шаблоне');
    else {
      const spots = await c.eval(`(() => {
        const card = document.querySelector('.kc[data-n]');
        const cols = [...document.querySelectorAll('.kbcol')];
        const mine = card.closest('.kbcol');
        const other = cols.find(x => x !== mine);
        if (!card || !other) return null;
        const a = card.getBoundingClientRect(), b = other.getBoundingClientRect();
        return {id: card.dataset.n, from: mine.dataset.k, to: other.dataset.k,
          ax: Math.round(a.x + a.width / 2), ay: Math.round(a.y + 14),
          bx: Math.round(b.x + b.width / 2), by: Math.round(b.y + 60)};
      })()`);
      if (!spots) bad('на канбане нет карточек или колонок');
      else {
        const was = await c.eval(`(() => { const n = nodeById('${spots.id}');
          return '${kb}' === 'status' ? n.status : JSON.stringify(fval(n, '${kb}'.replace('f.',''))); })()`);
        await c.touch('touchStart', [{ x: spots.ax, y: spots.ay }]);
        const steps = 8;
        for (let i = 1; i <= steps; i++) {
          await c.touch('touchMove', [{
            x: Math.round(spots.ax + (spots.bx - spots.ax) * i / steps),
            y: Math.round(spots.ay + (spots.by - spots.ay) * i / steps),
          }]);
          await sleep(30);
        }
        await c.touch('touchEnd', []);
        await sleep(600);
        const now = await c.eval(`(() => { const n = nodeById('${spots.id}');
          return '${kb}' === 'status' ? n.status : JSON.stringify(fval(n, '${kb}'.replace('f.',''))); })()`);
        (now !== was) ? ok('карточка канбана переносится пальцем', `${was} → ${now}`)
                      : bad('карточка канбана пальцем не переносится', `осталось ${was}`);
      }
    }

    c.errors.length ? bad('исключения в консоли', c.errors.join(' | ').slice(0, 300))
                    : ok('исключений в консоли нет');
  } catch (e) {
    bad('ПРОГОН УПАЛ', e.message);
  } finally {
    try { chrome.kill(); } catch {}
  }

  const good = results.filter(r => r[0] === '✓').length;
  console.log(`\n===== ${good}/${results.length} пройдено =====`);
  if (good < results.length) {
    console.log('ПРОВАЛЫ:');
    results.filter(r => r[0] === '✗').forEach(r => console.log(' ✗', r[1], r[2]));
    process.exit(1);
  }
})();
