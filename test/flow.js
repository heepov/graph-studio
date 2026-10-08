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

    /* =====================  M1: грамматика  ===================== */
    // Небольшая схема с известными сокетами: источник с двумя датами и суммой,
    // проверка с входами date и money, вторая проверка, исход, измерение, этап.
    await c.eval(`(() => {
      const lib = P.flowLib;
      lib.dims.push({id: 'dim_t', code: 'T', name: 'Тип', values: [{id: 'v_a', name: 'А'}, {id: 'v_b', name: 'Б'}]});
      lib.sources.push({id: 'src_t', name: 'Тестовый реестр', kind: 'gov', access: 'api', mode: 'sync', status: 'live',
        fields: [{id: 'f_d', name: 'Дата регистрации', type: 'date'}, {id: 'f_m', name: 'Капитал', type: 'money'},
                 {id: 'f_d2', name: 'Дата решения', type: 'date'}]});
      lib.checks.push({id: 'chk_t1', code: '9.1', name: 'Свежая регистрация', how: 'Меньше 180 дней',
        inputs: [{id: 'reg', name: 'Дата', type: 'date'}, {id: 'cap', name: 'Капитал', type: 'money'}], verdicts: ['risk']});
      lib.checks.push({id: 'chk_t2', code: '9.2', name: 'Капитал', how: '', inputs: [{id: 'x', name: 'Сумма', type: 'money'}], verdicts: ['stop_b']});
      lib.outcomes.push({id: 'out_t', name: 'Средний риск', verdict: 'risk'});
      normalizeLib(lib);
      const pg = {id: 'pg_m1', name: 'Грамматика', kind: 'flow', filter: {q: '', cats: [], statuses: [], types: [], f: {}},
        flow: normalizeFlow({nodes: [
          {id: 'nSt', k: 'stage', x: 760, y: 300, w: 380, h: 260, data: {num: '1', name: 'Этап', point: ''}},
          {id: 'nD', k: 'dim', ref: 'dim_t', x: -280, y: 0},
          {id: 'nS', k: 'source', ref: 'src_t', x: 0, y: 0},
          {id: 'nC1', k: 'check', ref: 'chk_t1', x: 420, y: 0},
          {id: 'nC2', k: 'check', ref: 'chk_t2', x: 420, y: 300},
          {id: 'nO', k: 'outcome', ref: 'out_t', x: 840, y: 0}], edges: []})};
      P.pages.push(pg); save(1); gotoPage(pg.id);
      FLOW.call('setViewport', {x: 380, y: 160, k: 0.9});
    })()`);
    await sleep(500);
    const H = (n, h) => c.eval(`FLOW.call('handleXY', ${JSON.stringify(n)}, ${JSON.stringify(h)})`);
    const edgesOf = () => c.eval(`curPage().flow.edges.map(e => e.s + '.' + e.sh + '>' + e.t + '.' + e.th + (e.neg ? '!' : ''))`);
    const drag = async (from, to, mid, mods = 0) => {
      await c.mouse('mousePressed', from.x, from.y, {modifiers: mods});
      for (let i = 1; i <= 8; i++) await c.mouse('mouseMoved', from.x + (to.x - from.x) * i / 8, from.y + (to.y - from.y) * i / 8, {modifiers: mods});
      if (mid) await mid();
      await c.mouse('mouseReleased', to.x, to.y, {buttons: 0, modifiers: mods});
      await sleep(250);
    };
    const click = async (p, extra = {}) => {
      await c.mouse('mousePressed', p.x, p.y, extra);
      await c.mouse('mouseReleased', p.x, p.y, Object.assign({buttons: 0}, extra));
      await sleep(150);
    };
    const nodeHead = async id => { const r = await c.eval(`FLOW.call('nodeXY', ${JSON.stringify(id)})`); return r && {x: r.x + Math.min(60, r.w / 3), y: r.y + 12}; };

    // --- соединение мышью: date → date есть, date → money нет -----------------
    await drag(await H('nS', 'out:f_d'), await H('nC1', 'in:reg'));
    let es = await edgesOf();
    check(es.includes('nS.out:f_d>nC1.in:reg'), 'мышью: date → date соединяется', es.join(' '));
    const col = await c.eval(`(() => { const p = document.querySelector('.react-flow__edge path.fl-e'); return p ? p.style.stroke : ''; })()`);
    check(/240, 138, 60|f08a3c/i.test(col), 'связь данных — цветом типа date', col);
    let tip = null;
    await drag(await H('nS', 'out:f_d'), await H('nC1', 'in:cap'), async () => {
      tip = await c.eval(`({show: getComputedStyle(document.querySelector('.fl-ctip')).display, text: document.querySelector('.fl-ctip').textContent,
        red: document.querySelector('.fl-root').classList.contains('fl-badconn')})`);
    });
    es = await edgesOf();
    check(!es.some(e => e.includes('in:cap')), 'мышью: date → money отклонено', es.join(' '));
    check(tip && tip.show === 'block' && tip.text === 'date → money: типы не совпадают' && tip.red,
      'у курсора — красный курсор и причина отказа', tip && tip.text);
    const tipGone = await c.eval(`({show: getComputedStyle(document.querySelector('.fl-ctip')).display, red: document.querySelector('.fl-root').classList.contains('fl-badconn')})`);
    check(tipGone.show === 'none' && !tipGone.red, 'после отпускания подсказка исчезает');

    // --- кратность: вход данных держит одну связь ------------------------------
    await drag(await H('nS', 'out:f_d2'), await H('nC1', 'in:reg'));
    es = await edgesOf();
    check(es.includes('nS.out:f_d2>nC1.in:reg') && !es.includes('nS.out:f_d>nC1.in:reg'),
      'новая связь во вход данных заменяет старую, как в Blender', es.join(' '));
    // Ctrl+тянуть из занятого сокета — перенос связей на другой сокет той же стороны.
    // На Mac Ctrl+нажатие — правая кнопка, там тот же жест идёт с Cmd.
    await drag(await H('nS', 'out:f_d2'), await H('nS', 'out:f_d'), null, process.platform === 'darwin' ? 4 : 2);
    es = await edgesOf();
    check(es.includes('nS.out:f_d>nC1.in:reg') && !es.some(e => e.startsWith('nS.out:f_d2')),
      'Ctrl+тянуть: связи сокета переехали на другой сокет', es.join(' '));

    // --- порядок, вердикт, применимость и цикл ---------------------------------
    await drag(await H('nC1', 'exec-out'), await H('nC2', 'exec-in'));
    await drag(await H('nC1', 'v:risk'), await H('nO', 'vin'));
    await drag(await H('nD', 'val:v_a'), await H('nC2', 'cond-in'));
    await drag(await H('nC2', 'exec-out'), await H('nC1', 'exec-in'));
    es = await edgesOf();
    const rej = await c.eval(`FLOW.state().lastReject`);
    check(es.includes('nC1.exec-out>nC2.exec-in') && es.includes('nC1.v:risk>nO.vin') && es.includes('nD.val:v_a>nC2.cond-in'),
      'порядок, вердикт в исход и применимость соединяются', `${es.length} связей`);
    check(!es.includes('nC2.exec-out>nC1.exec-in') && /цикл/.test(rej), 'цикл по порядку исполнения отклонён', rej);

    // --- «кроме»: правая кнопка по связи применимости --------------------------
    const condId = await c.eval(`curPage().flow.edges.find(e => e.th === 'cond-in').id`);
    const cp = await c.eval(`FLOW.call('edgeXY', ${JSON.stringify(condId)})`);
    await c.mouse('mousePressed', cp.x, cp.y, {button: 'right', buttons: 2});
    await c.mouse('mouseReleased', cp.x, cp.y, {button: 'right', buttons: 0});
    await sleep(200);
    const ctxItems = await c.eval(`[...document.querySelectorAll('#ctx.open .mi')].map(x => x.textContent)`);
    await c.eval(`(() => { const m = [...document.querySelectorAll('#ctx.open .mi')].find(x => /Исключить/.test(x.textContent)); if (m) m.click(); })()`);
    await sleep(200);
    const negNow = await c.eval(`({neg: !!curPage().flow.edges.find(e => e.id === ${JSON.stringify(condId)}).neg,
      mark: !!document.querySelector('.react-flow__edge .fl-negmark')})`);
    check(ctxItems.some(t => /Исключить это значение/.test(t)) && negNow.neg && negNow.mark,
      'ПКМ по связи применимости → «Исключить это значение»: пунктир со знаком ⊘', ctxItems.join(' / '));

    // --- удаление и отмена: нода возвращается со связями ----------------------
    const before = (await edgesOf()).length;
    await click(await nodeHead('nC1'));
    const selNow = await c.eval(`FLOW.state().selected`);
    await key(c, 'Delete', 'Delete', 0, 46);
    await sleep(250);
    const afterDel = await c.eval(`({n: !!curPage().flow.nodes.find(n => n.id === 'nC1'), e: curPage().flow.edges.length})`);
    check(selNow.includes('nC1') && !afterDel.n && afterDel.e < before, 'Delete убирает ноду со схемы вместе с её связями',
      `связей ${before} → ${afterDel.e}`);
    const libKept = await c.eval(`!!P.flowLib.checks.find(x => x.id === 'chk_t1')`);
    check(libKept, 'блок при этом остаётся в библиотеке');
    await key(c, 'KeyZ', 'z', 2, 90);
    await sleep(300);
    const undone = await c.eval(`({n: !!curPage().flow.nodes.find(n => n.id === 'nC1'), e: curPage().flow.edges.length,
      dom: !!document.querySelector('.react-flow__node[data-id="nC1"]')})`);
    check(undone.n && undone.e === before && undone.dom, 'Ctrl+Z возвращает удалённую ноду со связями', `связей ${undone.e}`);
    await key(c, 'KeyZ', 'z', 2 | 8, 90);
    await sleep(300);
    const redone = await c.eval(`!!curPage().flow.nodes.find(n => n.id === 'nC1')`);
    check(!redone, 'Ctrl+Shift+Z повторяет удаление');
    await key(c, 'KeyZ', 'z', 2, 90);
    await sleep(300);

    // --- Alt+клик удаляет связь, двойной клик вставляет точку перегиба ---------
    const vId = await c.eval(`curPage().flow.edges.find(e => e.sh === 'v:risk').id`);
    await click(await c.eval(`FLOW.call('edgeXY', ${JSON.stringify(vId)})`), {modifiers: 1});
    check(!(await edgesOf()).includes('nC1.v:risk>nO.vin'), 'Alt+клик по связи удаляет её');
    await key(c, 'KeyZ', 'z', 2, 90);
    await sleep(300);
    const eId = await c.eval(`curPage().flow.edges.find(e => e.sh === 'exec-out').id`);
    const ep = await c.eval(`FLOW.call('edgeXY', ${JSON.stringify(eId)})`);
    await c.mouse('mousePressed', ep.x, ep.y, {clickCount: 1});
    await c.mouse('mouseReleased', ep.x, ep.y, {buttons: 0, clickCount: 1});
    await c.mouse('mousePressed', ep.x, ep.y, {clickCount: 2});
    await c.mouse('mouseReleased', ep.x, ep.y, {buttons: 0, clickCount: 2});
    await sleep(300);
    const rr = await c.eval(`(() => { const f = curPage().flow, r = f.nodes.find(n => n.k === 'reroute');
      return r ? {in: f.edges.filter(e => e.t === r.id).map(e => e.s + '.' + e.sh), out: f.edges.filter(e => e.s === r.id).map(e => e.t + '.' + e.th)} : null; })()`);
    check(rr && rr.in[0] === 'nC1.exec-out' && rr.out[0] === 'nC2.exec-in', 'двойной клик по связи вставляет точку перегиба', JSON.stringify(rr));

    // --- меню добавления: Shift+A и связь, брошенная в пустоту -----------------
    const pane = await c.eval(`(() => { const r = document.querySelector('#flowRoot .fl-pane').getBoundingClientRect();
      return {x: Math.round(r.left + r.width * 0.25), y: Math.round(r.top + r.height * 0.8)}; })()`);
    await c.mouse('mouseMoved', pane.x, pane.y);
    await click(pane);
    await key(c, 'KeyA', 'A', 8, 65);
    await sleep(200);
    const m1 = await c.eval(`FLOW.state().menu`);
    check(m1 && m1.items.includes('Этап') && m1.items.includes('9.1 Свежая регистрация') && m1.items.includes('Тестовый реестр'),
      'Shift+A: меню с видами нод и блоками библиотеки', m1 && m1.items.length + ' пунктов');
    await c.send('Input.insertText', {text: 'гейт'});
    await sleep(100);
    await key(c, 'Enter', 'Enter', 0, 13);
    await sleep(300);
    const gate = await c.eval(`curPage().flow.nodes.filter(n => n.k === 'gate').length`);
    check(gate === 1, 'поиск в меню и Enter ставят ноду под курсор');

    await drag(await H('nS', 'out:f_m'), {x: pane.x + 300, y: pane.y - 60});
    const m2 = await c.eval(`FLOW.state().menu`);
    const okList = m2 && m2.items.includes('Один из') && m2.items.includes('Показатель') && m2.items.includes('9.2 Капитал')
      && !m2.items.includes('Гейт') && !m2.items.includes('Этап') && !m2.items.some(x => /Тип/.test(x));
    check(okList, 'связь в пустоту: меню только из совместимых блоков', m2 && m2.items.join(', '));
    await c.eval(`[...document.querySelectorAll('.fl-ai')].find(x => /Один из/.test(x.textContent)).click()`);
    await sleep(300);
    const any = await c.eval(`(() => { const f = curPage().flow, a = f.nodes.find(n => n.k === 'anyof');
      return a ? {type: a.data.type, edge: f.edges.some(e => e.t === a.id && e.s === 'nS' && e.sh === 'out:f_m')} : null; })()`);
    check(any && any.edge && any.type === 'money', 'выбранная нода встала под курсор и сразу соединилась', JSON.stringify(any));

    // --- M, H, Ctrl+H ---------------------------------------------------------
    await click(await nodeHead('nC2'));
    await key(c, 'KeyM', 'm', 0, 77);
    await key(c, 'KeyH', 'h', 0, 72);
    await sleep(200);
    let f2 = await c.eval(`(() => { const n = curPage().flow.nodes.find(x => x.id === 'nC2');
      return {muted: !!n.muted, col: !!n.collapsed, h: FLOW.call('nodeXY', 'nC2').h,
        cls: document.querySelector('.react-flow__node[data-id="nC2"] .fl-node').className}; })()`);
    check(f2.muted && f2.col && /fl-muted/.test(f2.cls) && f2.h <= 36, 'M выключает ноду, H сворачивает до шапки', `высота ${f2.h}`);
    await key(c, 'KeyH', 'h', 0, 72);
    await key(c, 'KeyH', 'h', 2, 72);
    await sleep(200);
    f2 = await c.eval(`(() => { const n = curPage().flow.nodes.find(x => x.id === 'nC2');
      return {hide: n.hide || [], rows: document.querySelectorAll('.react-flow__node[data-id="nC2"] .fl-row').length}; })()`);
    check(f2.hide.includes('in:x') && !f2.hide.includes('cond-in') && f2.rows === 2,
      'Ctrl+H прячет только несоединённые сокеты', `скрыто: ${f2.hide.join(', ')}`);
    await key(c, 'KeyH', 'h', 2, 72);
    await key(c, 'KeyM', 'm', 0, 77);

    // --- рамка: Ctrl+J, перетаскивание в рамку и из неё ------------------------
    await click(await nodeHead('nC2'));
    await key(c, 'KeyJ', 'j', 2, 74);
    await sleep(300);
    const wrapped = await c.eval(`(() => { const f = curPage().flow, n = f.nodes.find(x => x.id === 'nC2'), s = f.nodes.find(x => x.id === n.parent);
      return s ? {stage: s.k, fit: s.fit, first: f.nodes.indexOf(s) < f.nodes.indexOf(n), name: s.data.name} : null; })()`);
    check(wrapped && wrapped.stage === 'stage' && wrapped.fit === 1 && wrapped.first, 'Ctrl+J оборачивает выделенное в новый этап', JSON.stringify(wrapped));
    await key(c, 'KeyZ', 'z', 2, 90);
    await sleep(300);
    // в существующую рамку nSt: тащим проверку за шапку
    const into = await c.eval(`(() => { const r = FLOW.call('nodeXY', 'nSt'); return {x: r.x + r.w / 2, y: r.y + r.h / 2}; })()`);
    await drag(await nodeHead('nC2'), into);
    const inStage = await c.eval(`(() => { const n = curPage().flow.nodes.find(x => x.id === 'nC2'); return {parent: n.parent || null, x: n.x, y: n.y}; })()`);
    check(inStage.parent === 'nSt' && inStage.x < 400 && inStage.y < 300, 'проверка, брошенная в рамку, становится её ребёнком', JSON.stringify(inStage));
    await drag(await nodeHead('nC2'), {x: pane.x, y: pane.y - 200});
    const outStage = await c.eval(`(curPage().flow.nodes.find(x => x.id === 'nC2').parent) || null`);
    check(outStage === null, 'и перестаёт им быть, когда её вынесли');

    // --- F: вписать ----------------------------------------------------------
    await c.eval(`FLOW.call('setViewport', {x: 5000, y: 5000, k: 0.3})`);
    await click(pane);
    await key(c, 'KeyF', 'f', 0, 70);
    await sleep(200);
    const vpF = await c.eval(`FLOW.state().viewport`);
    check(!(vpF.x === 5000 && vpF.y === 5000), 'F вписывает схему в экран', JSON.stringify(vpF));

    // --- копия: Ctrl+C / Ctrl+V / Ctrl+D --------------------------------------
    const nBefore = await c.eval(`curPage().flow.nodes.length`);
    await c.eval(`FLOW.call('select', ['nS', 'nC1'])`);
    await sleep(100);
    await click(pane);
    await c.eval(`FLOW.call('select', ['nS', 'nC1'])`);
    await sleep(100);
    await key(c, 'KeyC', 'c', 2, 67);
    await key(c, 'KeyV', 'v', 2, 86);
    await sleep(300);
    const pasted = await c.eval(`(() => { const f = curPage().flow;
      return {nodes: f.nodes.length, sources: f.nodes.filter(n => n.ref === 'src_t').length, checks: f.nodes.filter(n => n.ref === 'chk_t1').length,
        clip: !!localStorage.getItem('gs_flow_clip')}; })()`);
    check(pasted.clip && pasted.nodes === nBefore + 1 && pasted.sources === 2 && pasted.checks === 1,
      'Ctrl+C/V: источник скопирован, проверка второй раз не встала (одна на странице)', JSON.stringify(pasted));
    await c.eval(`FLOW.call('select', [curPage().flow.nodes.find(n => n.k === 'gate').id])`);
    await sleep(100);
    await key(c, 'KeyD', 'd', 2, 68);
    await sleep(300);
    const gates = await c.eval(`curPage().flow.nodes.filter(n => n.k === 'gate').length`);
    check(gates === 2, 'Ctrl+D дублирует выделенное');

    // --- режим чтения: соединять нельзя ---------------------------------------
    await c.eval(`(() => { setReadonly(true); renderPage(); })()`);
    await sleep(200);
    const e0 = (await edgesOf()).length;
    await drag(await H('nS', 'out:f_m'), await H('nC2', 'in:x'));
    const e1 = (await edgesOf()).length;
    const roCls = await c.eval(`({conn: document.querySelectorAll('.react-flow__handle.connectable').length})`);
    check(e1 === e0 && roCls.conn === 0, 'в режиме чтения сокеты не соединяются');
    await c.eval(`(() => { setReadonly(false); renderPage(); })()`);

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
