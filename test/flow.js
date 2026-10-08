// Нодовый конструктор (страница kind:'flow') в headless Chrome.
//
// Проверяет то, что легко сломать молча: жизненный цикл страницы и React-корня
// внутри приложения, личную камеру, маршрутизацию клавиш (буквы холста и доски
// не должны срабатывать на конструкторе) и отсутствие утечек обработчиков при
// переключении страниц. Сценарии этапов M1–M6 дописываются ниже по ходу.
//
//   node test/flow.js                       # по умолчанию http://127.0.0.1:8081/
//   APP_URL=http://127.0.0.1:8123/ node test/flow.js
const { launch, Client, sleep } = require('./cdp');

const URL = process.env.APP_URL || 'http://127.0.0.1:8081/';
const PORT = 9338;
// Ждать надо UI.booted (см. test/README.md): boot() сам открывает экран в самом конце.
const BOOTED = 'typeof UI !== "undefined" && UI.booted === true';
const EDITOR_SHOWN = " && !document.body.classList.contains('onhome')";
const results = [];
const ok = (n, d = '') => { results.push(['✓', n, d]); console.log('✓', n, d); };
const bad = (n, d = '') => { results.push(['✗', n, d]); console.log('✗', n, d); };
const check = (cond, n, d = '') => (cond ? ok(n, d) : bad(n, d));

// Сколько обработчиков висит на window и document. Считает сам Chrome (DOMDebugger),
// а не обёртка над addEventListener: обёртка не увидела бы то, что повесили до неё.
async function listenerCount(c) {
  const out = {};
  for (const name of ['window', 'document']) {
    const r = await c.send('Runtime.evaluate', {expression: name});
    const l = await c.send('DOMDebugger.getEventListeners', {objectId: r.result.objectId});
    out[name] = l.listeners.length;
    await c.send('Runtime.releaseObject', {objectId: r.result.objectId});
  }
  return out;
}
async function key(c, code, keyName, mods = 0, vk = 0) {
  await c.send('Input.dispatchKeyEvent', {type: 'keyDown', code, key: keyName, modifiers: mods, windowsVirtualKeyCode: vk});
  await c.send('Input.dispatchKeyEvent', {type: 'keyUp', code, key: keyName, modifiers: mods, windowsVirtualKeyCode: vk});
}

(async () => {
  const chrome = await launch(PORT, './chrome-prof-flow');
  const c = await Client.attach(PORT);
  await c.send('Emulation.setDeviceMetricsOverride', {width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false});
  try {
    await c.send('Page.navigate', {url: URL});
    await c.waitFor('document.getElementById("home") !== null', 20000, 'загрузка html');
    await c.waitFor(BOOTED, 25000, 'приложение загрузилось');
    await c.eval(`createFromTemplate('demo')`);
    await c.waitFor('typeof P !== "undefined" && P && P.nodes.length > 0' + EDITOR_SHOWN, 15000, 'проект открылся');
    ok('приложение загрузилось, проект открыт');

    // --- документ без конструктора не меняется ------------------------------
    // ТЗ §0 п. 4 и §15: доска без страниц flow после 2.9.0 сохраняется байт-в-байт
    // как в 2.8.0 — никакого пустого flowLib «на всякий случай».
    const same = await c.eval(`(async () => {
      await new Promise(r => setTimeout(r, 600));
      const before = JSON.stringify(await dbGet(STORE, P.id));
      const doc = JSON.parse(before);
      const again = JSON.stringify(normalize(JSON.parse(before)));
      save(1);
      await new Promise(r => setTimeout(r, 300));
      const after = JSON.stringify(await dbGet(STORE, P.id));
      return {same: before === after, renorm: before === again, lib: 'flowLib' in doc,
              flowPages: doc.pages.filter(p => p.kind === 'flow').length, len: before.length};
    })()`);
    check(same.same && same.renorm && !same.lib && !same.flowPages,
      'доска без конструктора: открыть → сохранить даёт тот же документ байт-в-байт', `${same.len} байт`);

    // --- вид страницы объявлен в одном месте ---------------------------------
    const kinds = await c.eval(`Object.keys(KIND)`);
    check(kinds.includes('flow') && /Конструктор/.test(await c.eval(`kindName('flow')`)),
      'вид «Конструктор (ноды)» есть в каталоге страниц', kinds.join('/'));

    // --- создание через диалог «Новая страница» ------------------------------
    await c.eval(`newPage()`);
    await c.waitFor(`!!document.querySelector('input[name=npk][value=flow]')`, 5000, 'диалог новой страницы');
    await c.eval(`(() => { document.querySelector('input[name=npk][value=flow]').checked = true;
      document.getElementById('npn').value = 'Конвейер'; document.querySelector('#mbox [data-a=ok]').click(); })()`);
    await c.waitFor(`curPage().kind === 'flow' && !!document.querySelector('#flowRoot .react-flow')`, 8000, 'конструктор открылся');
    const made = await c.eval(`(() => { const pg = curPage();
      return {id: pg.id, name: pg.name, flow: !!pg.flow, nodes: pg.flow.nodes.length, show: pg.flow.show,
        lib: !!P.flowLib, verdicts: P.flowLib ? P.flowLib.verdicts.length : 0,
        empty: (document.querySelector('.fl-empty') || {}).textContent || '',
        bar: !!document.getElementById('flowBar'), cv: !!document.getElementById('cv'),
        icon: !!document.querySelector('#pageList .pgi.on use[href="#i-nodes"]') }; })()`);
    check(made.flow && made.nodes === 0 && made.lib && made.verdicts === 9,
      'страница-конструктор создаётся вместе с библиотекой доски', `«${made.name}», вердиктов ${made.verdicts}`);
    check(/Shift\+A/.test(made.empty), 'пустая схема подсказывает, как добавить блок', made.empty.slice(0, 60));
    check(made.bar && !made.cv, 'полоса конструктора на месте, холст приложения не рисуется');
    check(made.icon, 'у страницы свой значок в списке');
    const PID = made.id;

    // --- камера: личная, переживает перезагрузку ----------------------------
    await c.eval(`FLOW.call('setViewport', {x: 123, y: -45, k: 0.77})`);
    await sleep(900);
    const stored = await c.eval(`localStorage.getItem(viewKey(${JSON.stringify(PID)}))`);
    check(stored && JSON.parse(stored).k === 0.77, 'камера записана в localStorage, а не в документ', stored);
    const inDoc = await c.eval(`JSON.stringify(curPage()).includes('"view"')`);
    check(!inDoc, 'в документ страницы камера не попала');

    const PROJ = await c.eval(`P.id`);
    await c.send('Page.navigate', {url: URL});
    await c.waitFor(BOOTED, 25000, 'перезагрузка');
    await c.eval(`openProject(${JSON.stringify(PROJ)})`);
    await c.waitFor('!!P && P.id === ' + JSON.stringify(PROJ), 15000, 'проект открылся заново');
    const back = await c.eval(`(() => { const pg = P.pages.find(p => p.id === ${JSON.stringify(PID)});
      return pg ? {kind: pg.kind, flow: !!pg.flow, lib: !!P.flowLib} : null; })()`);
    check(back && back.kind === 'flow' && back.flow && back.lib, 'страница-конструктор переживает перезагрузку');
    await c.eval(`gotoPage(${JSON.stringify(PID)})`);
    await c.waitFor(`!!document.querySelector('#flowRoot .react-flow')`, 8000, 'конструктор после перезагрузки');
    const vp = await c.eval(`FLOW.state().viewport`);
    check(vp && vp.x === 123 && vp.y === -45 && vp.k === 0.77, 'камера восстановлена после перезагрузки', JSON.stringify(vp));

    // --- клавиши холста и доски на конструкторе не срабатывают ---------------
    // Глобальный обработчик приложения отдаёт конструктору всё, кроме Esc, Ctrl+K,
    // Ctrl+Z и Ctrl+S: иначе N создавал бы узел графа, а Delete удалял бы узлы пула.
    const box = await c.eval(`(() => { const r = document.querySelector('#flowRoot .react-flow__pane').getBoundingClientRect();
      return {x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2)}; })()`);
    await c.mouse('mousePressed', box.x, box.y);
    await c.mouse('mouseReleased', box.x, box.y, {buttons: 0});
    const n0 = await c.eval(`P.nodes.length`);
    await key(c, 'KeyN', 'n', 0, 78);
    await key(c, 'Delete', 'Delete', 0, 46);
    await sleep(150);
    const n1 = await c.eval(`({nodes: P.nodes.length, page: curPage().kind, focus: document.activeElement && document.activeElement.className})`);
    check(n1.nodes === n0 && n1.page === 'flow', 'N и Delete на конструкторе не трогают узлы пула', `узлов ${n1.nodes}`);
    check(/fl-root/.test(n1.focus || ''), 'клик по холсту отдаёт фокус контейнеру конструктора', n1.focus);
    // Ctrl+K — глобальное сочетание, обязано работать и здесь.
    await key(c, 'KeyK', 'k', 2, 75);
    await sleep(150);
    const pal = await c.eval(`document.getElementById('pal').classList.contains('open')`);
    check(pal, 'Ctrl+K открывает палитру и на конструкторе');
    await key(c, 'Escape', 'Escape', 0, 27);

    // --- режим чтения ----------------------------------------------------------
    await c.eval(`(() => { setReadonly(true); renderPage(); })()`);
    const roState = await c.eval(`({ro: FLOW.state().readonly, cls: !!document.querySelector('.fl-root.fl-ro'),
      hint: (document.querySelector('.fl-empty') || {}).textContent || ''})`);
    check(roState.ro && roState.cls && !/Shift\+A/.test(roState.hint), 'режим чтения доходит до конструктора', roState.hint.slice(0, 50));
    await c.eval(`(() => { setReadonly(false); renderPage(); })()`);

    // --- переключение страниц без утечек обработчиков -----------------------
    // React Flow вешает слушатели на document и window; размонтирование обязано
    // их снимать. Иначе каждый заход на конструктор добавлял бы ещё по копии.
    const CV = await c.eval(`P.pages.find(p => p.kind === 'canvas').id`);
    const cycle = async () => {
      await c.eval(`gotoPage(${JSON.stringify(CV)})`);
      await c.waitFor(`!!document.getElementById('cv')`, 5000, 'холст');
      await c.eval(`gotoPage(${JSON.stringify(PID)})`);
      await c.waitFor(`!!document.querySelector('#flowRoot .react-flow')`, 5000, 'конструктор');
    };
    await cycle();
    const l1 = await listenerCount(c);
    for (let i = 0; i < 5; i++) await cycle();
    const l2 = await listenerCount(c);
    check(l1.window === l2.window && l1.document === l2.document,
      'холст ↔ конструктор пять раз: число обработчиков не растёт', `window ${l1.window}→${l2.window}, document ${l1.document}→${l2.document}`);
    await c.eval(`gotoPage(${JSON.stringify(CV)})`);
    const gone = await c.eval(`({mounted: FLOW.state().mounted, root: !!document.getElementById('flowRoot'), bar: !!document.getElementById('flowBar')})`);
    check(!gone.mounted && !gone.root && !gone.bar, 'уход со страницы размонтирует конструктор целиком', JSON.stringify(gone));

    if (c.errors.length) bad('исключения в консоли', c.errors.join(' | ').slice(0, 400));
    else ok('исключений в консоли нет');
  } catch (e) {
    bad('ПРОГОН УПАЛ', (e && e.message) || String(e));
  } finally {
    try { chrome.kill(); } catch {}
  }
  const fail = results.filter(r => r[0] === '✗');
  console.log(`\n===== ${results.length - fail.length}/${results.length} пройдено =====`);
  process.exit(fail.length ? 1 : 0);
})();
