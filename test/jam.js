// Свободная доска (страница kind:'jam') в headless Chrome.
//
// Проверяет то, что легко сломать молча: жизненный цикл страницы и её объектов,
// раскладку слоёв, габариты сцены (без них fitAll сбрасывает камеру, а миникарта
// остаётся пустой) и превью доски для карточки на главной.
const { launch, Client, sleep } = require('./cdp');

const URL = process.env.APP_URL || 'http://127.0.0.1:8081/';
const PORT = 9337;
const results = [];
const ok = (n, d = '') => { results.push(['✓', n, d]); console.log('✓', n, d); };
const bad = (n, d = '') => { results.push(['✗', n, d]); console.log('✗', n, d); };

(async () => {
  const chrome = await launch(PORT, './chrome-prof-jam');
  const c = await Client.attach(PORT);
  await c.send('Emulation.setDeviceMetricsOverride', {
    width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false,
  });
  try {
    await c.send('Page.navigate', { url: URL });
    await c.waitFor('document.getElementById("home") !== null', 20000, 'загрузка html');
    await c.waitFor('typeof PROJECTS !== "undefined" && typeof G === "function"', 20000, 'boot() отработал');
    await c.waitFor('typeof idb !== "undefined" && !!idb', 20000, 'база открыта');
    await c.eval(`createFromTemplate('demo')`);
    await c.waitFor('typeof P !== "undefined" && P && P.nodes.length > 0', 15000, 'проект открылся');
    ok('приложение загрузилось, проект открыт');

    // --- вид страницы объявлен в одном месте --------------------------------
    const kinds = await c.eval(`Object.keys(KIND)`);
    kinds.includes('jam') ? ok('вид «доска» есть в каталоге страниц', kinds.join('/'))
                          : bad('KIND.jam не объявлен', kinds.join('/'));

    // --- создание страницы --------------------------------------------------
    const made = await c.eval(`(() => {
      const pg = {id: uid('p'), name: 'Доска', kind: 'jam',
        filter: {q: '', cats: [], statuses: [], types: [], f: {}}, jam: {items: [], bg: 'dots'}};
      P.pages.push(pg); save(1); gotoPage(pg.id);
      return {id: pg.id, kind: curPage().kind};
    })()`);
    made.kind === 'jam' ? ok('страница-доска создаётся и открывается') : bad('страница не открылась', JSON.stringify(made));
    const PID = made.id;

    // Доска рисуется СВОИМ рендерером, со своими слоями — и без чужих заметок.
    const layers = await c.eval(`({
      sect: !!document.getElementById('lySect'),
      items: !!document.getElementById('lyItems'),
      draw: !!document.getElementById('lyDraw'),
      edges: !!document.getElementById('edges'),
      rail: !!document.getElementById('toolrail'),
      stack: (document.getElementById('cvstack')||{}).className || ''
    })`);
    (layers.sect && layers.items && layers.draw && layers.edges && !layers.rail && /jam/.test(layers.stack))
      ? ok('слои доски на месте, панель холста-графа не рисуется')
      : bad('раскладка слоёв неверна', JSON.stringify(layers));

    // Пустое состояние у доски своё: она пуста по содержимому, а не по фильтру.
    const empty = await c.eval(`(document.getElementById('cvempty')||{}).textContent || ''`);
    /Доска пока пустая/.test(empty) ? ok('пустая доска объясняет, что делать')
                                    : bad('пустое состояние доски не показано', empty.slice(0, 80));

    // --- объекты ------------------------------------------------------------
    await c.eval(`(() => {
      const pg = pageById('${PID}');
      pg.jam.items = [];
      pg.jam.items.push({id: 'sec1', kind: 'section', x: 0, y: 0, w: 900, h: 700, fill: '#f2f4f9', text: 'Спринт 1'});
      for (let i = 0; i < 50; i++) {
        pg.jam.items.push({id: 'st' + i, kind: 'sticky', x: 40 + (i % 10) * 200, y: 40 + Math.floor(i / 10) * 200,
          w: 180, h: 180, fill: '#ffd93b', text: 'Идея ' + i});
      }
      pg.jam.items.push({id: 'sh1', kind: 'shape', shape: 'roundrect', x: 2200, y: 40, w: 220, h: 120, fill: '#c9e3ff', text: 'Этап'});
      pg.jam.items.push({id: 'dr1', kind: 'draw', x: 2200, y: 300, stroke: '#e0432f', sw: 4, d: '0,0 40,30 90,10 140,60'});
      pg.jam.items.push({id: 'cn1', kind: 'conn', a: {item: 'st0', side: 'r'}, b: {item: 'sh1', side: 'l'}, style: 'curve', capB: 'arrow'});
      save(1); renderPage();
      return true;
    })()`);
    const painted = await c.eval(`({
      items: document.querySelectorAll('#lyItems .jitem').length,
      sect: document.querySelectorAll('#lySect .jsect').length,
      draw: document.querySelectorAll('#lyDraw path.jdraw').length
    })`);
    (painted.items === 51 && painted.sect === 1 && painted.draw === 1)
      ? ok('объекты доски отрисованы по слоям', JSON.stringify(painted))
      : bad('отрисовка объектов неверна', JSON.stringify(painted));

    // --- камера видит содержимое доски -------------------------------------
    // Без ветки jam в sceneBoxes() список строился по одним узлам графа, а их тут нет:
    // fitAll каждый раз сбрасывал бы камеру в {40,40,1}, а миникарта была бы пустой.
    const cam = await c.eval(`(() => { fitAll(); const v = view();
      return {x: Math.round(v.x), y: Math.round(v.y), k: +v.k.toFixed(3), boxes: sceneBoxes(curPage()).length}; })()`);
    (cam.boxes === 53 && !(cam.x === 40 && cam.y === 40 && cam.k === 1))
      ? ok('«показать всё» учитывает объекты доски', `${cam.boxes} объектов, масштаб ${cam.k}`)
      : bad('fitAll не видит содержимое доски', JSON.stringify(cam));

    const mini = await c.eval(`(() => { drawMini(); const c2 = document.getElementById('mini');
      const d = c2.getContext('2d').getImageData(0, 0, c2.width, c2.height).data;
      let painted = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) painted++;
      return {painted, m: !!c2._m}; })()`);
    (mini.painted > 500 && mini.m) ? ok('миникарта рисует доску, а не пустоту', mini.painted + ' пикселей')
                                   : bad('миникарта пуста', JSON.stringify(mini));

    // --- превью для карточки на главной -------------------------------------
    // undefined сервер понимает как «не трогай прежнее»: без своей ветки картинка
    // доски на главной замерла бы на том, что было до её появления.
    const prev = await c.eval(`(() => { const p = buildPreview();
      return p ? {n: p.n.length, e: p.e.length, first: p.n[0]} : null; })()`);
    (prev && prev.n > 0) ? ok('превью доски собирается', `${prev.n} фигур, ${prev.e} линий`)
                         : bad('превью доски не строится', JSON.stringify(prev));

    // --- переживает перезагрузку --------------------------------------------
    const PROJ = await c.eval(`P.id`);
    await c.send('Page.navigate', { url: URL });
    await c.waitFor('typeof idb !== "undefined" && !!idb', 20000, 'перезагрузка');
    await c.eval(`openProject(${JSON.stringify(PROJ)})`);
    await c.waitFor('!!P && P.id === ' + JSON.stringify(PROJ), 15000, 'проект открылся заново');
    const after = await c.eval(`(() => { const pg = P.pages.find(p => p.id === '${PID}');
      return pg ? {kind: pg.kind, items: pg.jam.items.length, bg: pg.jam.bg} : null; })()`);
    (after && after.kind === 'jam' && after.items === 54 && after.bg === 'dots')
      ? ok('доска и её объекты переживают перезагрузку', after.items + ' объектов')
      : bad('доска не сохранилась', JSON.stringify(after));

    // --- дублирование страницы ----------------------------------------------
    // clone() дословно дал бы два набора с ОДИНАКОВЫМИ id, и коннектор копии
    // указывал бы в оригинал.
    const dup = await c.eval(`(() => {
      const src = pageById('${PID}');
      const c2 = duplicatePage(src); P.pages.push(c2); save(1);
      const ids = new Set(src.jam.items.map(i => i.id));
      const clash = c2.jam.items.filter(i => ids.has(i.id)).length;
      const conn = c2.jam.items.find(i => i.kind === 'conn');
      const inside = new Set(c2.jam.items.map(i => i.id));
      return {clash, connOk: !!conn && inside.has(conn.a.item) && inside.has(conn.b.item), items: c2.jam.items.length};
    })()`);
    (dup.clash === 0 && dup.connOk && dup.items === 54)
      ? ok('копия страницы получает свои id, коннекторы смотрят внутрь копии')
      : bad('дублирование ломает идентификаторы', JSON.stringify(dup));

    // --- удаление страницы убирает раскладку узлов ---------------------------
    const del = await c.eval(`(() => {
      const pg = P.pages.find(p => p.kind === 'canvas');
      const n = P.nodes[0];
      setNpos(n, pg.id, 10, 10);
      const before = !!(n.p && n.p[pg.id]);
      P.pages = P.pages.filter(x => x.id !== pg.id);
      for (const nd of P.nodes) if (nd.p) delete nd.p[pg.id];
      save(1);
      return {before, after: !!(n.p && n.p[pg.id])};
    })()`);
    (del.before && !del.after) ? ok('удаление страницы уносит позиции узлов, а не оставляет мусор')
                               : bad('позиции узлов остались от удалённой страницы', JSON.stringify(del));

    // --- инструменты и настоящие жесты мышью --------------------------------
    // Всё выше проверяло модель. Дальше — руки: доска обязана слушаться мыши,
    // а не только вызовов из консоли.
    await c.eval(`(() => {
      const pg = pageById('${PID}'); pg.jam.items = []; save(1); gotoPage(pg.id); return true;
    })()`);
    await sleep(200);

    const bar = await c.eval(`(() => { const b = document.getElementById('jambar');
      return b ? {n: b.querySelectorAll('button').length, tool: JAM.tool} : null; })()`);
    (bar && bar.n >= 10 && bar.tool === 'sel')
      ? ok('панель инструментов доски на месте', bar.n + ' кнопок')
      : bad('панели инструментов нет', JSON.stringify(bar));

    // Клавиша выбирает инструмент. Сверка по e.code — иначе в русской раскладке
    // не работает ни одно сочетание, на этом проект уже обжигался.
    await c.send('Input.dispatchKeyEvent', {type: 'keyDown', code: 'KeyN', key: 'n', windowsVirtualKeyCode: 78});
    await c.send('Input.dispatchKeyEvent', {type: 'keyUp', code: 'KeyN', key: 'n', windowsVirtualKeyCode: 78});
    const tool = await c.eval(`JAM.tool`);
    tool === 'sticky' ? ok('клавиша N выбирает стикер') : bad('клавиша не выбрала инструмент', String(tool));

    // Клик по холсту ставит стикер, и каретка сразу внутри.
    const cvBox = await c.eval(`(() => { const r = document.getElementById('cv').getBoundingClientRect();
      return {x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2)}; })()`);
    await c.mouse('mousePressed', cvBox.x, cvBox.y);
    await c.mouse('mouseReleased', cvBox.x, cvBox.y, {buttons: 0});
    await sleep(250);
    const made2 = await c.eval(`(() => { const pg = pageById('${PID}');
      const it = pg.jam.items[0];
      return {n: pg.jam.items.length, kind: it && it.kind, w: it && it.w,
              editing: !!document.querySelector('.jitem .jtxt[contenteditable="true"]'),
              tool: JAM.tool, sel: UI.selItems.size}; })()`);
    (made2.n === 1 && made2.kind === 'sticky' && made2.editing && made2.sel === 1)
      ? ok('клик ставит стикер и сразу открывает ввод текста', made2.w + 'px')
      : bad('стикер не поставился', JSON.stringify(made2));
    made2.tool === 'sel' ? ok('инструмент одноразовый: вернулся к стрелке')
                         : bad('инструмент залип без просьбы', String(made2.tool));

    // Текст пишется на месте и попадает в документ.
    await c.eval(`(() => { const t = document.querySelector('.jitem .jtxt[contenteditable="true"]');
      t.textContent = 'Проверка'; t.blur(); return true; })()`);
    await sleep(200);
    const txt = await c.eval(`pageById('${PID}').jam.items[0].text`);
    txt === 'Проверка' ? ok('текст стикера правится на месте') : bad('текст не сохранился', String(txt));

    // Перетаскивание: координаты меняются на ОТПУСКАНИИ, а не по ходу жеста —
    // иначе снимок для отмены снимался бы с уже изменённого состояния.
    const before = await c.eval(`(() => { const i = pageById('${PID}').jam.items[0]; return {x: i.x, y: i.y}; })()`);
    const el = await c.eval(`(() => { const r = document.querySelector('.jitem').getBoundingClientRect();
      return {x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2)}; })()`);
    await c.mouse('mousePressed', el.x, el.y);
    for (let i = 1; i <= 6; i++) await c.mouse('mouseMoved', el.x + i * 20, el.y);
    const during = await c.eval(`(() => { const i = pageById('${PID}').jam.items[0]; return {x: i.x, y: i.y}; })()`);
    await c.mouse('mouseReleased', el.x + 120, el.y, {buttons: 0});
    await sleep(250);
    const after2 = await c.eval(`(() => { const i = pageById('${PID}').jam.items[0]; return {x: i.x, y: i.y}; })()`);
    (during.x === before.x && after2.x !== before.x)
      ? ok('стикер тащится мышью, документ меняется только на отпускании', `${before.x} → ${after2.x}`)
      : bad('перетаскивание пишет в документ по ходу жеста', JSON.stringify({before, during, after: after2}));

    // Отмена возвращает позицию — это и есть проверка, что снимок снят вовремя.
    await c.eval(`undo()`);
    await sleep(200);
    const undone = await c.eval(`(() => { const i = pageById('${PID}').jam.items[0]; return i ? i.x : null; })()`);
    undone === before.x ? ok('Ctrl+Z возвращает стикер на место')
                        : bad('отмена не вернула позицию', `${undone} вместо ${before.x}`);

    // Рисование пером: штрих упрощается, а не сохраняет каждую точку курсора.
    await c.eval(`setTool('pen')`);
    await c.mouse('mousePressed', cvBox.x - 300, cvBox.y + 200);
    for (let i = 1; i <= 40; i++) await c.mouse('mouseMoved', cvBox.x - 300 + i * 5, cvBox.y + 200 + Math.round(Math.sin(i / 4) * 30));
    await c.mouse('mouseReleased', cvBox.x - 100, cvBox.y + 200, {buttons: 0});
    await sleep(250);
    const stroke = await c.eval(`(() => { const it = pageById('${PID}').jam.items.find(i => i.kind === 'draw');
      return it ? {pts: it.d.trim().split(' ').length, bytes: JSON.stringify(it).length} : null; })()`);
    (stroke && stroke.pts >= 2 && stroke.pts < 40 && stroke.bytes < 900)
      ? ok('штрих сохраняется упрощённым', `${stroke.pts} точек, ${stroke.bytes} байт`)
      : bad('штрих не упрощён', JSON.stringify(stroke));

    // Удаление клавишей: забыть здесь UI.selItems — классическая «половина работает».
    await c.eval(`(() => { setTool('sel'); setSelItems([pageById('${PID}').jam.items[0].id]); return true; })()`);
    await c.send('Input.dispatchKeyEvent', {type: 'keyDown', code: 'Delete', key: 'Delete', windowsVirtualKeyCode: 46});
    await c.send('Input.dispatchKeyEvent', {type: 'keyUp', code: 'Delete', key: 'Delete', windowsVirtualKeyCode: 46});
    await sleep(250);
    const gone = await c.eval(`pageById('${PID}').jam.items.filter(i => i.kind === 'sticky').length`);
    gone === 0 ? ok('Delete удаляет выделенный объект доски') : bad('объект не удалился клавишей', String(gone));

    // Инструмент не должен утечь на холст-граф: там его ветка в onDown перехватила бы
    // нажатия, которых от неё не ждут.
    await c.eval(`setTool('pen')`);
    const leaked = await c.eval(`(() => { const cv = P.pages.find(p => p.kind === 'canvas');
      gotoPage(cv.id); return {tool: JAM.tool, kind: curPage().kind}; })()`);
    leaked.tool === 'sel' ? ok('инструмент сбрасывается при уходе с доски')
                          : bad('инструмент утёк на другую страницу', JSON.stringify(leaked));

    if (c.errors.length) bad('исключения в консоли', c.errors.join(' | ').slice(0, 300));
    else ok('исключений в консоли нет');
  } catch (e) {
    bad('ПРОГОН УПАЛ', (e && e.message) || String(e));
  } finally {
    try { await c.close(); } catch {}
    try { chrome.kill(); } catch {}
  }
  const fail = results.filter(r => r[0] === '✗');
  console.log(`\n===== ${results.length - fail.length}/${results.length} пройдено =====`);
  process.exit(fail.length ? 1 : 0);
})();
