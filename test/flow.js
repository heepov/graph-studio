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
    // Профиль Chrome у теста постоянный: панели и «скрыть погашенные», запомненные
    // прошлым прогоном, подменили бы умолчания, которые здесь и проверяются.
    await c.eval(`(() => { localStorage.removeItem('gs_flow_panels2'); localStorage.removeItem('gs_flow_hideoff'); return true; })()`);
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

    // --- меню страницы «⋯» в списке страниц: клик по иконке открывает меню, а не страницу
    await c.eval(`(() => { const el = document.querySelector('#pageList .pgi.on [data-mo] svg'); el.dispatchEvent(new MouseEvent('click', {bubbles: true, clientX: 100, clientY: 100})); return true; })()`);
    await sleep(150);
    const pgMenu = await c.eval(`({open: document.getElementById('ctx').classList.contains('open'), items: [...document.querySelectorAll('#ctx .mi')].map(m => m.textContent)})`);
    await c.eval(`hideCtx()`);
    check(pgMenu.open && pgMenu.items.some(t => /Дублировать/.test(t)), 'меню страницы «⋯» открывается кликом по иконке', pgMenu.items.slice(0, 3).join(' / '));

    // --- 2.10: экран по умолчанию — схема на всю ширину ---------------------
    const ux0 = await c.eval(`({lib: !!document.querySelector('.fl-lib'), insp: !!document.querySelector('.fl-insp'),
      rails: document.querySelectorAll('.fl-rail').length, show: curPage().flow.show,
      add: document.getElementById('bAdd').textContent.trim(), stat: document.getElementById('saveState').textContent,
      find: document.getElementById('bFind').title,
      acts: [...document.querySelectorAll('.fl-empty [data-a]')].map(b => b.dataset.a).join(' '),
      bar: document.querySelector('#flowBar .fl-bar').textContent})`);
    check(!ux0.lib && !ux0.insp && ux0.rails === 2, 'панели по умолчанию свёрнуты — схема на всю ширину, вкладки по краям', `вкладок ${ux0.rails}`);
    check(ux0.show.exec === 1 && ux0.show.data === 2 && ux0.show.cond === 2 && ux0.show.verdict === 2,
      'новая схема: видны связи порядка, остальные — у выделенного блока', JSON.stringify(ux0.show));
    check(ux0.add === 'Добавить' && /^0 блоков · 0 связей/.test(ux0.stat) && /по схеме/.test(ux0.find),
      'шапка на конструкторе: «Добавить», счётчик блоков, поиск по схеме', `${ux0.add} · ${ux0.stat.slice(0, 22)}`);
    check(ux0.acts === 'new-check new-source new-dim' && /Клиент/.test(ux0.bar) && /Подсветка/.test(ux0.bar) && !/Оверлей|Найти/.test(ux0.bar),
      'пустая схема — кнопки создания; полоса словами: «Клиент», «Подсветка», без «Оверлей» и «Найти»', ux0.acts);
    await c.eval(`document.querySelector('.fl-empty [data-a="new-check"]').click()`);
    await sleep(500);
    const nc = await c.eval(`({nodes: curPage().flow.nodes.length, lib: P.flowLib.checks.length, insp: document.querySelector('.fl-insp') ? document.querySelector('.fl-insp').dataset.insp : null,
      focus: document.activeElement && document.activeElement.closest('.fl-insp') ? 'инспектор' : String(document.activeElement && document.activeElement.className)})`);
    check(nc.nodes === 1 && nc.lib === 1 && nc.insp === 'check' && nc.focus === 'инспектор',
      '«+ Проверка»: блок в библиотеке, нода на схеме, инспектор открылся сам с фокусом в названии', JSON.stringify(nc));
    await c.eval(`FLOW.call('select', [])`);
    await sleep(250);
    const closed = await c.eval(`!document.querySelector('.fl-insp')`);
    check(closed, 'выделение снято — инспектор, открытый автоматически, закрывается');
    await c.eval(`undo()`);
    await sleep(300);
    const undo0 = await c.eval(`({nodes: curPage().flow.nodes.length, lib: P.flowLib.checks.length, empty: !!document.querySelector('.fl-empty')})`);
    check(undo0.nodes === 0 && undo0.lib === 0 && undo0.empty, 'Ctrl+Z убирает и ноду, и блок библиотеки', JSON.stringify(undo0));

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
        flow: normalizeFlow({show: {exec: 1, data: 1, cond: 1, verdict: 1}, nodes: [
          {id: 'nSt', k: 'stage', x: 760, y: 300, w: 380, h: 260, data: {num: '1', name: 'Этап', point: ''}},
          {id: 'nD', k: 'dim', ref: 'dim_t', x: -280, y: 0},
          {id: 'nS', k: 'source', ref: 'src_t', x: 0, y: 0},
          {id: 'nC1', k: 'check', ref: 'chk_t1', x: 420, y: 0},
          {id: 'nC2', k: 'check', ref: 'chk_t2', x: 420, y: 300},
          {id: 'nO', k: 'outcome', ref: 'out_t', x: 840, y: 0}], edges: []})};
      // Дальше тесты рассчитаны на раскладку с открытыми панелями — как выбор человека
      // (он запоминается). Ставим ДО открытия страницы: иначе схема впишется в широкий
      // холст, а открывшиеся следом панели закроют её часть.
      localStorage.setItem('gs_flow_panels2', JSON.stringify({lib: true, insp: true}));
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
    check(gate === 1, 'поиск в меню и Enter ставят ноду под курсор (по прежнему слову «гейт» — «Условие перехода»)');

    await drag(await H('nS', 'out:f_m'), {x: pane.x + 300, y: pane.y - 60});
    const m2 = await c.eval(`FLOW.state().menu`);
    const okList = m2 && m2.items.includes('Резерв источников') && m2.items.includes('Показатель') && m2.items.includes('9.2 Капитал')
      && !m2.items.includes('Условие перехода') && !m2.items.includes('Этап') && !m2.items.some(x => /Тип/.test(x));
    check(okList, 'связь в пустоту: меню только из совместимых блоков', m2 && m2.items.join(', '));
    await c.eval(`[...document.querySelectorAll('.fl-ai')].find(x => /Резерв источников/.test(x.textContent)).click()`);
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
    // Остаются «Когда» и вход порядка; строка порядка у проверки живёт в шапке — в строках одна.
    check(f2.hide.includes('in:x') && !f2.hide.includes('cond-in') && f2.rows === 1,
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

    /* =====================  M2: библиотека  ===================== */
    const MOD = process.platform === 'darwin' ? 4 : 2;
    // Элемент панели может быть ниже видимой части — человек сначала прокрутил бы к нему.
    const center = sel => c.eval(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null;
      // Прокручиваем только контейнер панели: scrollIntoView сдвинул бы и саму страницу.
      const sc = el.closest('.fl-ibody, .fl-ll, .fl-tw, .fl-pop, .fl-list');
      if (sc) { const r0 = el.getBoundingClientRect(), rs = sc.getBoundingClientRect();
        if (r0.top < rs.top || r0.bottom > rs.bottom) sc.scrollTop += (r0.top - rs.top) - rs.height / 2;
        if (r0.left < rs.left || r0.right > rs.right) sc.scrollLeft += (r0.left - rs.left) - rs.width / 3; }
      const r = el.getBoundingClientRect(); return {x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2)}; })()`);
    const clickEl = async sel => { const p = await center(sel); if (!p) throw new Error('нет элемента ' + sel); await click(p); return p; };
    const typeText = async text => { await c.send('Input.insertText', {text}); await sleep(150); };
    const selectAll = async () => {
      await c.send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: MOD, commands: ['selectAll']});
      await c.send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: MOD});
    };
    const fill = async (sel, text) => { await clickEl(sel); await selectAll(); await typeText(text); };
    // Нативный список <select> в headless не раскрывается — выбор значения
    // отправляем тем же событием change, что и человек.
    const choose = (sel, value) => c.eval(`(() => { const s = document.querySelector(${JSON.stringify(sel)}); if (!s) return null;
      s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', {bubbles: true})); return s.value; })()`);
    const paneAt = (fx, fy) => c.eval(`(() => { const r = document.querySelector('#flowRoot .fl-pane').getBoundingClientRect();
      return {x: Math.round(r.left + ${fx}), y: Math.round(r.top + ${fy})}; })()`);
    const menuPick = async (pt, label) => {
      await c.mouse('mouseMoved', pt.x, pt.y);
      await click(pt);
      await key(c, 'KeyA', 'A', 8, 65);
      await sleep(200);
      await typeText(label);
      await key(c, 'Enter', 'Enter', 0, 13);
      await sleep(350);
    };
    const lastNode = k => c.eval(`(() => { const f = curPage().flow; const l = f.nodes.filter(n => n.k === ${JSON.stringify(k)}); return l.length ? l[l.length - 1].id : null; })()`);

    // --- С11: с нуля на пустой доске, только мышью и клавиатурой -----------------
    await c.eval(`createFromTemplate('blank')`);
    await c.waitFor(`P && P.name === 'Новый проект'` + EDITOR_SHOWN, 15000, 'пустая доска');
    await c.eval(`newPage()`);
    await c.waitFor(`!!document.querySelector('input[name=npk][value=flow]')`, 5000, 'диалог');
    await clickEl('input[name=npk][value=flow]');
    await fill('#npn', 'Кредит — ИП');
    await clickEl('#mbox [data-a=ok]');
    await c.waitFor(`curPage().kind === 'flow' && !!document.querySelector('.fl-lib')`, 8000, 'пустой конструктор с библиотекой');
    const emptyLib = await c.eval(`({d: P.flowLib.dims.length, s: P.flowLib.sources.length, c: P.flowLib.checks.length, o: P.flowLib.outcomes.length})`);
    check(emptyLib.d + emptyLib.s + emptyLib.c + emptyLib.o === 0, 'С11: доска и библиотека пустые');

    // измерение из библиотеки: «+ Новое», название, два значения, перетащить на холст
    await clickEl('.fl-tab[title="Измерения"]');
    await clickEl('.fl-lf .btn');
    await sleep(250);
    await typeText('Тип клиента');
    await fill('.fl-insp [data-row] input[data-f="value-name"]', 'ЮЛ');
    await clickEl('.fl-insp .fl-add1');
    await sleep(200);
    await fill('.fl-insp [data-row]:nth-child(2) input[data-f="value-name"]', 'ИП');
    const dimId = await c.eval(`P.flowLib.dims[0].id`);
    await drag(await center(`[data-lib="dims:${dimId}"]`), await paneAt(150, 70));
    // источник через Shift+A
    await menuPick(await paneAt(150, 330), 'Новый источник');
    await typeText('Бюро кредитных историй');
    await clickEl('.fl-insp .fl-add1');
    await sleep(150);
    await clickEl('.fl-insp .fl-add1');
    await sleep(150);
    await fill('.fl-insp [data-row]:nth-child(1) input[data-f="field-name"]', 'Кредитный рейтинг');
    await choose('.fl-insp [data-row]:nth-child(1) select[data-f="field-type"]', 'number');
    await fill('.fl-insp [data-row]:nth-child(2) input[data-f="field-name"]', 'Просрочки');
    await choose('.fl-insp [data-row]:nth-child(2) select[data-f="field-type"]', 'bool');
    await sleep(200);
    const srcN = await lastNode('source');
    // проверка через Shift+A; входы — бросить поле источника на тело проверки
    await menuPick(await paneAt(480, 250), 'Новая проверка');
    await typeText('Долговая нагрузка');
    const chkN = await lastNode('check');
    const fids = await c.eval(`P.flowLib.sources[0].fields.map(f => f.id)`);
    const body = async () => { const r = await c.eval(`FLOW.call('nodeXY', ${JSON.stringify(chkN)})`); return {x: r.x + r.w / 2, y: r.y + r.h - 20}; };
    await drag(await H(srcN, 'out:' + fids[0]), await body());
    await drag(await H(srcN, 'out:' + fids[1]), await body());
    // новый вердикт в библиотеке и исход с ним
    await clickEl('.fl-tab[title="Исходы"]');
    await clickEl('.fl-vh .fl-ib');
    await sleep(200);
    await fill('.fl-vd .fl-vr:last-child input[type=text]', 'Снижение лимита');
    const vkey = await c.eval(`P.flowLib.verdicts[P.flowLib.verdicts.length - 1].key`);
    await click(await nodeHead(chkN));
    await sleep(150);
    await clickEl(`.fl-insp [data-verdict="${vkey}"] input`);
    await menuPick(await paneAt(470, 560), 'Новый исход');
    await typeText('Лимит снижен');
    await choose('.fl-insp select[data-f="verdict"]', vkey);
    const outN = await lastNode('outcome');
    await drag(await H(chkN, 'v:' + vkey), await H(outN, 'vin'));
    // применимость: значение «ЮЛ» → «Когда» проверки
    const dimN = await lastNode('dim');
    const vUL = await c.eval(`P.flowLib.dims[0].values.find(v => v.name === 'ЮЛ').id`);
    await drag(await H(dimN, 'val:' + vUL), await H(chkN, 'cond-in'));
    // этап вокруг проверки
    await click(await nodeHead(chkN));
    await key(c, 'KeyJ', 'j', 2, 74);
    await sleep(300);
    const c11 = await c.eval(`(() => {
      const L = P.flowLib, f = curPage().flow;
      const d = L.dims[0], s = L.sources[0], ch = L.checks[0], o = L.outcomes[0], v = L.verdicts.find(x => x.key === ${JSON.stringify(vkey)});
      const ck = f.nodes.find(n => n.k === 'check');
      const st = ck && f.nodes.find(n => n.id === ck.parent);
      const kinds = f.edges.map(e => e.sh.split(':')[0] + '>' + e.th.split(':')[0]).sort();
      const types = f.edges.filter(e => e.sh.startsWith('out:')).map(e => {
        const fl = s.fields.find(x => 'out:' + x.id === e.sh), inp = ch.inputs.find(x => 'in:' + x.id === e.th);
        return fl.type + '→' + inp.type; }).sort();
      return {dim: d && d.name + ':' + d.values.map(x => x.name).join('/'), src: s && s.name + ':' + s.fields.map(x => x.name + '/' + x.type).join(','),
        chk: ch && ch.name + ':' + ch.inputs.map(x => x.name + '/' + x.type).join(','), out: o && o.name + ':' + (o.verdict === (v && v.key)),
        verdict: v && v.name, onCanvas: f.nodes.map(n => n.k).sort().join(','), stage: !!st && st.k, kinds, types};
    })()`);
    check(c11.dim === 'Тип клиента:ЮЛ/ИП' && c11.src === 'Бюро кредитных историй:Кредитный рейтинг/number,Просрочки/bool'
      && c11.chk === 'Долговая нагрузка:Кредитный рейтинг/number,Просрочки/bool' && c11.out === 'Лимит снижен:true'
      && c11.verdict === 'Снижение лимита', 'С11: все блоки заведены в библиотеке руками', JSON.stringify(c11));
    check(c11.onCanvas === 'check,dim,outcome,source,stage' && c11.stage === 'stage', 'С11: и стоят на холсте, проверка — в этапе', c11.onCanvas);
    check(c11.types.join(',') === 'bool→bool,number→number' && c11.kinds.join(',') === 'out>in,out>in,v>vin,val>cond-in',
      'С11: связи типизированы — данные, вердикт, применимость', c11.kinds.join(' '));

    // --- правка входа: связи с исчезнувшим сокетом уходят в той же операции отмены
    await click(await nodeHead(chkN));
    await sleep(150);
    const edgesBefore = await c.eval(`curPage().flow.edges.length`);
    await clickEl('.fl-insp [data-row]:nth-child(1) .fl-x');
    await sleep(150);
    const confirmTxt = await c.eval(`(document.querySelector('#modal.open .kv') || {}).textContent || ''`);
    await clickEl('#mbox [data-a=ok]');
    await sleep(250);
    const afterDrop = await c.eval(`({inputs: P.flowLib.checks[0].inputs.length, edges: curPage().flow.edges.length})`);
    check(/1 связь/.test(confirmTxt) && afterDrop.inputs === 1 && afterDrop.edges === edgesBefore - 1,
      'удаление входа со связью — подтверждение со счётчиком, связь уходит вместе с ним', confirmTxt.slice(0, 70));
    await click(await paneAt(40, 40));
    await key(c, 'KeyZ', 'z', 2, 90);
    await sleep(300);
    const undoDrop = await c.eval(`({inputs: P.flowLib.checks[0].inputs.length, edges: curPage().flow.edges.length})`);
    check(undoDrop.inputs === 2 && undoDrop.edges === edgesBefore, 'один Ctrl+Z возвращает и вход, и его связь', JSON.stringify(undoDrop));

    // --- переименование на месте -----------------------------------------------
    const hd = await nodeHead(chkN);
    await c.mouse('mousePressed', hd.x, hd.y, {clickCount: 1}); await c.mouse('mouseReleased', hd.x, hd.y, {buttons: 0, clickCount: 1});
    await c.mouse('mousePressed', hd.x, hd.y, {clickCount: 2}); await c.mouse('mouseReleased', hd.x, hd.y, {buttons: 0, clickCount: 2});
    await sleep(200);
    const inl = await c.eval(`!!document.querySelector('.react-flow__node input.fl-inl')`);
    await selectAll();
    await typeText('Долговая нагрузка (DSCR)');
    await key(c, 'Enter', 'Enter', 0, 13);
    await sleep(250);
    const renamed = await c.eval(`P.flowLib.checks[0].name`);
    check(inl && renamed === 'Долговая нагрузка (DSCR)', 'двойной клик по шапке — переименование прямо на ноде', renamed);

    // --- библиотека: дубликат, удаление со счётчиками, фильтр «не на схеме» ------
    await clickEl('.fl-tab[title="Проверки"]');
    await clickEl(`[data-lib="checks:${await c.eval(`P.flowLib.checks[0].id`)}"]`);
    await sleep(150);
    await c.eval(`[...document.querySelectorAll('.fl-insp .fl-acts .btn')].find(b => /Дубликат/.test(b.textContent)).click()`);
    await sleep(250);
    const dupName = await c.eval(`P.flowLib.checks.map(x => x.name)`);
    check(dupName.length === 2 && /\(копия\)$/.test(dupName[1]), 'дубликат блока — с новым id и пометкой «(копия)»', dupName[1]);
    await clickEl('.fl-lq .fl-chk input');
    await sleep(150);
    const freeList = await c.eval(`[...document.querySelectorAll('.fl-ll .fl-li .fl-lname')].map(x => x.textContent)`);
    check(freeList.length === 1 && /копия/.test(freeList[0]), 'фильтр «не на схеме» оставляет неразмещённые блоки', freeList.join(' | '));
    await clickEl('.fl-lq .fl-chk input');
    // удалить блок, который стоит на схеме: диалог со счётчиками
    await clickEl(`[data-lib="checks:${await c.eval(`P.flowLib.checks[0].id`)}"]`);
    await sleep(150);
    await c.eval(`[...document.querySelectorAll('.fl-insp .fl-acts .btn')].find(b => /Удалить из библиотеки/.test(b.textContent)).click()`);
    await sleep(200);
    const delTxt = await c.eval(`(document.querySelector('#modal.open .kv') || {}).textContent || ''`);
    check(/стоит на 1 схеме/.test(delTxt) && /1 нодой/.test(delTxt) && /связ/.test(delTxt), 'удаление блока со схемы — «стоит на N схемах, удалить вместе с нодами и K связями?»', delTxt.slice(0, 90));
    await clickEl('#mbox [data-a=c]');

    // --- С4 и С5 на seed --------------------------------------------------------
    const seedDoc = require('fs').readFileSync(require('path').join(__dirname, '../src/flow/seed-kyc-rko.json'), 'utf8');
    await c.eval(`(() => { const d = normalize(JSON.parse(${JSON.stringify(seedDoc)}));
      P.flowLib = d.flowLib; P.pages.push(d.pages[0]); save(1); gotoPage(d.pages[0].id); return true; })()`);
    await c.waitFor(`FLOW.state().rfNodes === 109`, 10000, 'seed на странице');
    // С4: Shift+A → «Новая проверка» → название → поле «Сайт» из «Анкеты клиента» на тело проверки
    // камера: «Анкета клиента» в левом верхнем углу холста (человек подвёл бы её колесом)
    await c.eval(`(() => { const n = curPage().flow.nodes.find(x => x.id === 'n_src_form');
      FLOW.call('setViewport', {x: 40 - n.x, y: 60 - n.y, k: 1}); })()`);
    await sleep(250);
    const formXY = await c.eval(`FLOW.call('nodeXY', 'n_src_form')`);
    await menuPick({x: formXY.x + formXY.w + 260, y: formXY.y + 60}, 'Новая проверка');
    await typeText('Сайт в реестре РКН');
    const newChk = await lastNode('check');
    const nb = await c.eval(`FLOW.call('nodeXY', ${JSON.stringify(newChk)})`);
    await drag(await H('n_src_form', 'out:f_site'), {x: nb.x + nb.w / 2, y: nb.y + nb.h - 16});
    const c4 = await c.eval(`(() => { const f = curPage().flow, n = f.nodes.find(x => x.id === ${JSON.stringify(newChk)}), it = P.flowLib.checks.find(x => x.id === n.ref);
      const e = f.edges.find(x => x.t === n.id && x.s === 'n_src_form');
      return {name: it.name, inLib: P.flowLib.checks.includes(it), inputs: it.inputs.map(i => i.name + '/' + i.type), edge: e ? e.sh + '>' + e.th : null}; })()`);
    check(c4.inLib && c4.name === 'Сайт в реестре РКН', 'С4: новая проверка — в библиотеке и на схеме', c4.name);
    check(c4.inputs.join() === 'Сайт/text' && c4.edge && c4.edge.startsWith('out:f_site>in:'), 'С4: связь text → text создаётся вместе со входом', JSON.stringify(c4));
    // date → money отклоняется с подсказкой
    await c.eval(`FLOW.call('select', ['n_src_egrul', 'n_chk_3_4'])`);
    await key(c, 'KeyF', 'f', 0, 70);
    await sleep(250);
    let tip4 = null;
    await drag(await H('n_src_egrul', 'out:f_regdate'), await H('n_chk_3_4', 'in:debt'), async () => {
      tip4 = await c.eval(`document.querySelector('.fl-ctip').textContent`);
    });
    const e34 = await c.eval(`curPage().flow.edges.some(e => e.s === 'n_src_egrul' && e.t === 'n_chk_3_4' && e.th === 'in:debt' && e.sh === 'out:f_regdate')`);
    check(!e34 && tip4 === 'date → money: типы не совпадают', 'С4: date → money отклоняется с подсказкой', tip4);

    // С5: «Как проверяем» у 3.11 — общий блок, меняется на всех схемах
    await c.eval(`(() => { const c2 = duplicatePage(curPage()); P.pages.push(c2); save(1); return true; })()`);
    await c.eval(`FLOW.call('select', ['n_chk_3_11'])`);
    await sleep(250);
    await fill('.fl-insp textarea[data-f="how"]', 'Новая формулировка: лицензия по ИНН в трёх слоях');
    await sleep(300);
    const other = await c.eval(`P.pages.filter(p => p.kind === 'flow' && p.flow.nodes.some(n => n.ref === 'chk_3_11')).map(p => p.id)`);
    await c.eval(`gotoPage(${JSON.stringify(other[other.length - 1])})`);
    await c.waitFor(`!!document.querySelector('.react-flow__node[data-id="n_chk_3_11"]') || FLOW.state().rfNodes > 100`, 8000, 'вторая схема');
    await c.eval(`FLOW.call('select', ['n_chk_3_11'])`);
    await key(c, 'KeyF', 'f', 0, 70);
    await sleep(300);
    const c5 = await c.eval(`({lib: P.flowLib.checks.find(x => x.code === '3.11').how, pages: ${JSON.stringify(other)}.length,
      dom: (document.querySelector('.react-flow__node[data-id="n_chk_3_11"] .fl-body') || {}).textContent || '',
      uses: [...document.querySelectorAll('.fl-insp .fl-use')].length})`);
    check(c5.pages === 2 && c5.lib === 'Новая формулировка: лицензия по ИНН в трёх слоях' && /Новая формулировка/.test(c5.dom),
      'С5: «Как проверяем» у 3.11 изменилось на всех схемах доски', `${c5.pages} схемы`);
    check(c5.uses === 2, 'подвал инспектора: «Используется» на обеих схемах', String(c5.uses));

    // --- перетаскивание из библиотеки: проверку, уже стоящую здесь, не дублирует
    await clickEl('.fl-tab[title="Проверки"]');
    const n311 = await c.eval(`curPage().flow.nodes.filter(n => n.ref === 'chk_3_11').length`);
    await drag(await center('[data-lib="checks:chk_3_11"]'), await paneAt(300, 300));
    const n311b = await c.eval(`({n: curPage().flow.nodes.filter(n => n.ref === 'chk_3_11').length, sel: FLOW.state().selected})`);
    check(n311 === 1 && n311b.n === 1 && n311b.sel.includes('n_chk_3_11'), 'проверку, уже стоящую на схеме, библиотека не дублирует — подсвечивает её');
    const srcBefore = await c.eval(`curPage().flow.nodes.filter(n => n.ref === 'src_kad').length`);
    await clickEl('.fl-tab[title="Источники"]');
    await drag(await center('[data-lib="sources:src_kad"]'), await paneAt(300, 300));
    const srcAfter = await c.eval(`curPage().flow.nodes.filter(n => n.ref === 'src_kad').length`);
    check(srcAfter === srcBefore + 1, 'источник из библиотеки ставится ещё раз — для разгрузки связей', `${srcBefore} → ${srcAfter}`);

    // --- табличный редактор ------------------------------------------------------
    await clickEl('.fl-lib [data-tab="checks"]');
    await clickEl('.fl-lib [data-a="table"]');
    await sleep(300);
    const tbl = await c.eval(`({rows: document.querySelectorAll('#mbox table.fl-lt tbody tr').length,
      heads: [...document.querySelectorAll('#mbox table.fl-lt thead tr:first-child th')].map(t => t.textContent.replace(/[▲▼]/g, '').trim())})`);
    check(tbl.rows === 56 && tbl.heads.includes('Как проверяем') && tbl.heads.includes('Этап на этой схеме'),
      'табличный редактор: проверки и колонки листа xlsx', `${tbl.rows} строк, ${tbl.heads.length} колонок`);
    await fill('#mbox tr[data-id="chk_2_6"] input[data-k="norm"]', 'ФЗ-115');
    await clickEl('#mbox [data-a=c]');
    const norm = await c.eval(`P.flowLib.checks.find(x => x.id === 'chk_2_6').norm`);
    check(norm === 'ФЗ-115', 'правка в ячейке меняет блок библиотеки', norm);

    /* =====================  M3: профили и оверлеи  ===================== */
    // Свежая доска из seed: тесты M2 уже правили библиотеку предыдущей.
    const SEED_PG = 'pg_kyc_rko';
    await c.eval(`(async () => { const d = normalize(JSON.parse(${JSON.stringify(seedDoc)})); d.id = 'seed_m3'; d.name = 'KYC — профили';
      await dbPut(STORE, d); await loadProjects(); await openProject('seed_m3'); gotoPage(${JSON.stringify(SEED_PG)}); return true; })()`);
    await c.waitFor(`P && P.id === 'seed_m3' && FLOW.state().rfNodes > 100`, 10000, 'seed');
    // Связи seed по умолчанию: на экране только порядок этапов, остальные — у выделенного блока.
    const domEdges = () => c.eval(`document.querySelectorAll('#flowRoot .react-flow__edge').length`);
    await c.eval(`FLOW.call('select', [])`);
    await sleep(200);
    const sE0 = await domEdges();
    await c.eval(`FLOW.call('select', ['n_chk_3_11'])`);
    await sleep(250);
    const sE1 = await domEdges();
    check(sE0 === 9 && sE1 > 9, 'seed: видны 9 связей порядка, у выделенной проверки появляются её связи', `${sE0} → ${sE1}`);
    // Меню «Связи»: словами, по видам — показываем все, как было до 2.10, для проверок ниже
    await clickEl('#flowBar [data-a="edges"]');
    await sleep(150);
    for (const k of ['data', 'cond', 'verdict']) await clickEl(`.fl-pop-edges [data-ek="${k}"] [data-mode="1"]`);
    const allShow = await c.eval(`JSON.stringify(curPage().flow.show)`);
    await key(c, 'Escape', 'Escape', 0, 27);
    await c.eval(`FLOW.call('select', [])`);
    await sleep(250);
    check(JSON.parse(allShow).data === 1 && await domEdges() === 137, 'меню «Связи»: «все» по каждому виду — на экране все 137', allShow);

    // Облик нод (2.10): у проверки строка порядка — в шапке, название в две строки;
    // «Когда» подписан тем, для кого проверка; вход без источника — красной точкой.
    const nodeLook = async id => { await c.eval(`FLOW.call('select', [${JSON.stringify(id)}])`); await key(c, 'KeyF', 'f', 0, 70); await sleep(300);
      return c.eval(`(() => { const el = document.querySelector('.react-flow__node[data-id="${id}"]'); if (!el) return null;
        return {hd2: !!el.querySelector('.fl-hd2 .react-flow__handle[data-handleid="exec-in"]') && !!el.querySelector('.fl-hd2 .react-flow__handle[data-handleid="exec-out"]'),
          who: (el.querySelector('.fl-who') || {}).textContent || '', miss: [...el.querySelectorAll('.fl-miss')].map(x => x.textContent),
          ty: !!el.querySelector('.fl-ty'), h: Math.round(el.getBoundingClientRect().height / FLOW.state().viewport.k)}; })()`); };
    const l38 = await nodeLook('n_chk_3_8'), l315 = await nodeLook('n_chk_3_15');
    check(l38 && l38.hd2 && l38.who === 'для всех, кроме: ИП, Свежерег < 180 дней' && !l38.ty,
      'проверка: порядок в шапке, «для кого» словами, типы данных не пишутся', l38 && l38.who);
    check(l315 && l315.miss.length === 1, 'вход без источника помечен на самой ноде', l315 && l315.miss.join(', '));
    await c.eval(`FLOW.call('select', ['n_st_s3b'])`);
    await key(c, 'KeyF', 'f', 0, 70);
    await sleep(300);
    const cnt3b = await c.eval(`(document.querySelector('.react-flow__node[data-id="n_st_s3b"] .fl-st-cnt') || {}).textContent`);
    check(cnt3b === '19', 'в шапке этапа — число проверок', cnt3b);
    // Издалека: подписи этапов крупно, мелкие подписи нод спрятаны
    await c.eval(`FLOW.call('select', [])`);
    await c.eval(`FLOW.call('setViewport', {x: 200, y: 120, k: 0.22})`);
    await sleep(300);
    const far = await c.eval(`({far: document.querySelector('.fl-root').classList.contains('fl-far'), labels: [...document.querySelectorAll('.fl-farlbl b')].map(x => x.textContent),
      ttl: [...document.querySelectorAll('.react-flow__node-check .fl-ttl')].slice(0, 5).map(x => getComputedStyle(x).visibility)})`);
    await c.eval(`FLOW.call('setViewport', {x: 0, y: 0, k: 1})`);
    await sleep(250);
    const near = await c.eval(`({far: document.querySelector('.fl-root').classList.contains('fl-far'), labels: document.querySelectorAll('.fl-farlbl').length})`);
    check(far.far && far.labels.length === 7 && far.labels.includes('3b. Углублённая проверка по ИНН/ОГРН') && !near.far && near.labels === 0,
      'издалека этапы подписаны крупно, вблизи — обычный вид', far.labels.slice(0, 3).join(' | '));
    check(far.ttl.length > 0 && far.ttl.every(v => v === 'visible'), 'издалека содержимое нод не прячется (2.10.1)', far.ttl.join(','));
    const docBefore = await c.eval(`JSON.stringify(pageById(${JSON.stringify(SEED_PG)}).flow.profiles) + pageById(${JSON.stringify(SEED_PG)}).flow.profile`);
    // С2: P-ИП — 45 из 55, погашены ровно десять
    await choose('#flowBar select[data-f="profile"]', 'pf_ip');
    await sleep(250);
    const ip = await c.eval(`(() => { const a = FLOW.active();
      return {c: a.checks, s: a.sources, o: a.outcomes, h: a.holes, off: a.off.sort((x, y) => x.localeCompare(y, 'ru', {numeric: true})),
        bar: document.querySelector('#flowBar .fl-stats').textContent.replace(/\\s+/g, ' '),
        dim: [...document.querySelectorAll('.react-flow__node-check .fl-node.fl-off')].length,
        offEdges: document.querySelectorAll('.react-flow__edge-path.fl-off').length}; })()`);
    check(ip.c.on === 45 && ip.c.all === 55 && ip.s.on === 22 && ip.s.all === 24
      && ip.off.join(' ') === '2.8 2.9 2.10 2.11 3.8 3.9 4.2 4.3 4.5 5.3', 'С2: P-ИП — проверок 45/55, источников 22/24, погашены 2.8…5.3', ip.off.join(' '));
    check(/45\/55 проверок\s*·\s*22\/24 источника\s*·\s*2 без источника/.test(ip.bar), 'С2: сводка в полосе профиля — числа впереди, слова в нужном падеже', ip.bar.trim());
    const banner = await c.eval(`(document.querySelector('.fl-pbanner') || {}).textContent || ''`);
    check(/«P-ИП»/.test(banner) && /45 из 55 проверок, погашено 10/.test(banner), 'плашка профиля над схемой: участвуют 45 из 55, погашено 10', banner.replace(/\s+/g, ' ').trim());
    check(ip.offEdges > 0, 'неактивные связи приглушены', `${ip.offEdges} связей`);
    await choose('#flowBar select[data-f="profile"]', 'pf_ooo1');
    await sleep(250);
    const ooo = await c.eval(`FLOW.active()`);
    check(ooo.checks.on === 54 && ooo.off.join() === '4.5', 'С2: P-ООО-простое — 54/55, погашена 4.5', `${ooo.checks.on}/55`);
    // профиль — личный: в документ не попадает
    const profKey = await c.eval(`Object.keys(localStorage).find(k => k.startsWith('gs_flowprof:') && k.endsWith(${JSON.stringify(':' + SEED_PG)}))`);
    const docAfter = await c.eval(`JSON.stringify(pageById(${JSON.stringify(SEED_PG)}).flow.profiles) + pageById(${JSON.stringify(SEED_PG)}).flow.profile`);
    check(profKey && docAfter === docBefore, 'активный профиль — в localStorage, документ не меняется', profKey);

    // список за числом сводки — с переходом к ноде
    await clickEl('#flowBar [data-stat="holes"]');
    await sleep(150);
    const holesList = await c.eval(`[...document.querySelectorAll('.fl-pop-list .fl-sl-i')].map(x => x.textContent)`);
    await c.eval(`[...document.querySelectorAll('.fl-pop-list .fl-sl-i')].find(x => /3\\.19/.test(x.textContent)).click()`);
    await sleep(250);
    const jumped = await c.eval(`FLOW.state().selected`);
    check(holesList.length === 2 && holesList.some(t => /3\.15/.test(t)) && jumped.includes('n_chk_3_19'),
      'число «входов без источника» открывает список, клик ведёт к ноде', holesList.join(' | '));

    // С3: оверлей «Покрытие источниками»
    await choose('#flowBar select[data-f="profile"]', '');
    await choose('#flowBar select[data-f="overlay"]', 'coverage');
    await sleep(250);
    const cov = await c.eval(`(() => { const col = id => { const el = document.querySelector('.react-flow__node[data-id="' + id + '"] .fl-node'); return el ? el.style.getPropertyValue('--ov') : 'нет в DOM'; };
      const reds = FLOW.api().state ? null : null;
      return {c315: col('n_chk_3_15'), c319: col('n_chk_3_19'), c317: col('n_chk_3_17'), c12: col('n_chk_1_2'), c26: col('n_chk_2_6'),
        legend: [...document.querySelectorAll('.fl-legend .fl-lg-r')].map(x => x.dataset.key + ':' + x.querySelector('b').textContent),
        holes: [...document.querySelectorAll('.fl-legend .fl-lg-holes .fl-sl-i')].map(x => x.textContent.split(' ')[0])}; })()`);
    // часть нод вне экрана не отрисована — проверяем по легенде и по тем, что видны
    check(cov.holes.join(' ') === '3.15 3.17 3.19' && cov.legend.includes('red:3'), 'С3: красным — 3.15, 3.19 (вход без связи) и 3.17 (источник без доступа)', cov.legend.join(' '));
    await c.eval(`FLOW.call('select', ['n_chk_1_2'])`);
    await key(c, 'KeyF', 'f', 0, 70);
    await sleep(250);
    const yellow = await c.eval(`document.querySelector('.react-flow__node[data-id="n_chk_1_2"] .fl-node').style.getPropertyValue('--ov')`);
    check(/e6a700/i.test(yellow), 'С3: жёлтым — проверка на источнике «планируется» (1.2)', yellow);
    const ovDoc = await c.eval(`pageById(${JSON.stringify(SEED_PG)}).flow.overlay`);
    check(ovDoc === 'coverage', 'оверлей хранится в странице (page.flow.overlay)');
    await choose('#flowBar select[data-f="overlay"]', 'tbd');
    await sleep(200);
    const tbdCount = await c.eval(`(document.querySelector('.fl-legend [data-key="tbd"] b') || {}).textContent`);
    check(tbdCount === '15', 'оверлей «вердикт не определён»: в seed — 15', tbdCount);
    await choose('#flowBar select[data-f="overlay"]', 'bank');
    await sleep(200);
    const bankLg = await c.eval(`[...document.querySelectorAll('.fl-legend .fl-lg-r')].map(x => x.dataset.key + ':' + x.querySelector('b').textContent).join(' ')`);
    check(/accepted:3/.test(bankLg) && /discussion:1/.test(bankLg) && /none:49/.test(bankLg), 'оверлей согласования: счётчики по статусам', bankLg);
    await choose('#flowBar select[data-f="overlay"]', '');

    // видимость связей: все → только у выделенной → скрыть → все
    const execShown = () => c.eval(`(() => { const f = curPage().flow; const ids = f.edges.filter(e => /^exec/.test(e.sh)).map(e => e.id);
      return ids.filter(id => document.querySelector('.react-flow__edge[data-id="' + id + '"]')).length; })()`);
    await c.eval(`FLOW.call('fit')`);
    await sleep(200);
    const ex0 = await execShown();
    const execMode = async m => { await clickEl('#flowBar [data-a="edges"]'); await sleep(120);
      await clickEl(`.fl-pop-edges [data-ek="exec"] [data-mode="${m}"]`); await key(c, 'Escape', 'Escape', 0, 27); await sleep(150); };
    await execMode(2);
    await c.eval(`FLOW.call('select', ['n_st_s2'])`);
    await sleep(250);
    const ex2 = await execShown();
    await execMode(0);
    await sleep(200);
    const ex3 = await execShown();
    await execMode(1);
    await sleep(200);
    const ex4 = await execShown();
    check(ex0 === 9 && ex2 === 2 && ex3 === 0 && ex4 === 9, 'видимость порядка ▶: все → у выделенной → скрыть → все', `${ex0} → ${ex2} → ${ex3} → ${ex4}`);

    // Ctrl+F — поиск по полю и переход
    await click(await paneAt(60, 400));
    await key(c, 'KeyF', 'f', 2, 70);
    await sleep(200);
    await typeText('Сайт');
    await sleep(150);
    const found = await c.eval(`[...document.querySelectorAll('.fl-pop-find .fl-ai')].map(x => x.textContent)`);
    await key(c, 'Enter', 'Enter', 0, 13);
    await sleep(300);
    const fsel = await c.eval(`FLOW.state().selected`);
    check(found.length >= 2 && found.some(t => /3\.17/.test(t)) && fsel.length === 1, 'Ctrl+F: поиск по полю «Сайт» находит 3.17, Enter ведёт к ноде', found.slice(0, 3).join(' | '));

    // Настроить → свой выбор → «Сохранить как…» → профиль по умолчанию
    await clickEl('#flowBar .fl-bar > .btn.fl-popbtn');
    await sleep(150);
    await clickEl('.fl-pop-edit [data-dim="dim_ctype"] [data-val="v_ip"] input');
    await sleep(200);
    const custom = await c.eval(`FLOW.active().checks.on`);
    await clickEl('.fl-pop-edit [data-a="saveas"]');
    await sleep(150);
    await fill('#pbin', 'Только ИП');
    await clickEl('#mbox [data-a=ok]');
    await sleep(250);
    const saved = await c.eval(`(() => { const f = pageById(${JSON.stringify(SEED_PG)}).flow; const p = f.profiles.find(x => x.name === 'Только ИП');
      return p ? {sel: p.sel, active: FLOW.active().profile.id === p.id} : null; })()`);
    // «Тип клиента = ИП» гасит те же десять, что и P-ИП: ось ОПФ ни к одной проверке не привязана.
    check(custom === 45 && saved && JSON.stringify(saved.sel) === '{"dim_ctype":["v_ip"]}' && saved.active,
      'свой выбор значений гасит проверки и сохраняется профилем', `${custom}/55 · ${JSON.stringify(saved)}`);
    await key(c, 'Escape', 'Escape', 0, 27);

    // раскладка ELK: ноды переезжают, Ctrl+Z возвращает
    const posBefore = await c.eval(`JSON.stringify(curPage().flow.nodes.map(n => [n.id, n.x, n.y]))`);
    await clickEl('#flowBar [data-a="layout"]');
    await c.waitFor(`JSON.stringify(curPage().flow.nodes.map(n => [n.id, n.x, n.y])) !== ${JSON.stringify(posBefore)}`, 15000, 'ELK отработал');
    const elk = await c.eval(`(() => { const f = curPage().flow; const st = f.nodes.filter(n => n.k === 'stage');
      return {stages: st.length, fit: st.every(s => s.fit === 1), kids: f.nodes.filter(n => n.parent).length}; })()`);
    await click(await paneAt(60, 400));
    await key(c, 'KeyZ', 'z', 2, 90);
    await sleep(300);
    const posUndo = await c.eval(`JSON.stringify(curPage().flow.nodes.map(n => [n.id, n.x, n.y]))`);
    check(elk.stages === 7 && elk.fit && elk.kids === 55 && posUndo === posBefore, '«Разложить»: ELK переставляет ноды, рамки подгоняются, Ctrl+Z возвращает', JSON.stringify(elk));

    // режим чтения: профиль и оверлей переключаются, документ не меняется
    await c.eval(`(() => { setReadonly(true); renderPage(); })()`);
    await sleep(200);
    const roDoc = await c.eval(`JSON.stringify(pageById(${JSON.stringify(SEED_PG)}).flow)`);
    await choose('#flowBar select[data-f="profile"]', 'pf_ip');
    await choose('#flowBar select[data-f="overlay"]', 'wave');
    await sleep(200);
    const roView = await c.eval(`({on: FLOW.active().checks.on, lg: !!document.querySelector('.fl-legend[data-overlay="wave"]'),
      same: JSON.stringify(pageById(${JSON.stringify(SEED_PG)}).flow) === ${JSON.stringify(roDoc)},
      layout: !!document.querySelector('#flowBar [data-a="layout"]')})`);
    check(roView.on === 45 && roView.lg && roView.same && !roView.layout, 'в режиме чтения профиль и оверлей переключаются без записи, раскладки нет', JSON.stringify(roView));
    await c.eval(`(() => { setReadonly(false); renderPage(); })()`);

    /* =====================  M4: seed и шаблон  ===================== */
    await c.eval(`home.showHome('tpl')`);
    await sleep(200);
    const tplCard = await c.eval(`[...document.querySelectorAll('#hmain .bcard[data-t]')].map(x => x.dataset.t + ':' + x.querySelector('.t').textContent)`);
    check(tplCard.includes('kyc:KYC/KYB — конструктор проверок'), 'шаблон «KYC/KYB — конструктор проверок» на главной', tplCard.length + ' шаблонов');
    // С1: открыть шаблон с главной кликом по карточке
    await clickEl('#hmain .bcard[data-t="kyc"]');
    await c.waitFor(`P && P.name === 'KYC/KYB — конструктор проверок'` + EDITOR_SHOWN + ` && FLOW.state().mounted`, 20000, 'доска из шаблона');
    await c.waitFor(`document.querySelectorAll('#flowRoot .react-flow__node').length === 109`, 10000, 'все ноды отрисованы');
    await sleep(400);
    const c1 = await c.eval(`(() => {
      const pane = document.querySelector('#flowRoot .fl-pane').getBoundingClientRect();
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (const el of document.querySelectorAll('#flowRoot .react-flow__node')) { const r = el.getBoundingClientRect();
        x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top); x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom); }
      return {page: curPage().kind, nodes: document.querySelectorAll('#flowRoot .react-flow__node').length,
        edges: document.querySelectorAll('#flowRoot .react-flow__edge').length,
        inside: x0 >= pane.left - 2 && y0 >= pane.top - 2 && x1 <= pane.right + 2 && y1 <= pane.bottom + 2, k: FLOW.state().viewport.k}; })()`);
    const rfE = await c.eval(`FLOW.state().rfEdges`);
    check(c1.page === 'flow' && c1.nodes === 109 && rfE === 137 && c1.edges === 9,
      'С1: 109 нод и 137 связей; на экране — порядок этапов, остальные связи — у выделенного блока', `${c1.nodes} нод, ${rfE} связей, видно ${c1.edges}`);
    check(c1.inside, 'С1: камера вписывает всю схему', `масштаб ${c1.k}`);
    // контрольные цифры §13 — из документа, созданного шаблоном
    const s13 = await c.eval(`(() => { const L = P.flowLib, f = curPage().flow, k = {};
      for (const n of f.nodes) k[n.k] = (k[n.k] || 0) + 1;
      const ek = {}; for (const e of f.edges) { const x = /^exec/.test(e.sh) ? 'exec' : /^val:/.test(e.sh) ? 'cond' : /^v:/.test(e.sh) ? 'verdict' : 'data'; ek[x] = (ek[x] || 0) + 1; }
      return {dims: L.dims.length, values: L.dims.reduce((a, d) => a + d.values.length, 0), sources: L.sources.length,
        fields: L.sources.reduce((a, s) => a + s.fields.length, 0), checks: L.checks.length, outcomes: L.outcomes.length, verdicts: L.verdicts.length,
        stages: k.stage, gates: k.gate, ek, profiles: f.profiles.length}; })()`);
    check(s13.dims === 9 && s13.values === 41 && s13.sources === 24 && s13.fields === 64 && s13.checks === 55 && s13.outcomes === 8 && s13.verdicts === 9,
      '§13: библиотека — 9 измерений (41 значение), 24 источника (64 поля), 55 проверок, 8 исходов', JSON.stringify(s13).slice(0, 120));
    check(s13.stages === 7 && s13.gates === 3 && s13.ek.data === 78 && s13.ek.verdict === 34 && s13.ek.cond === 16 && s13.ek.exec === 9 && s13.profiles === 4,
      '§13: 7 этапов, 3 гейта, связи 78 + 34 + 16 + 9, 4 профиля', JSON.stringify(s13.ek));
    const KYC_ID = await c.eval(`P.id`);
    // §15: открытие seed — от gotoPage до отрисовки всех нод
    const tOpen = await c.eval(`(async () => {
      const pg = {id: 'pg_tbl', name: 'Таблица', kind: 'table', filter: {q: '', cats: [], statuses: [], types: [], f: {}}, table: {cols: ['name'], sort: 'name', dir: 1, group: ''}};
      if (!pageById('pg_tbl')) P.pages.push(pg);
      gotoPage('pg_tbl');
      const t0 = performance.now();
      gotoPage('pg_kyc_rko');
      while (document.querySelectorAll('#flowRoot .react-flow__node').length < 109 && performance.now() - t0 < 10000) await new Promise(r => requestAnimationFrame(r));
      return Math.round(performance.now() - t0); })()`);
    check(tOpen <= 4000, '§15: схема seed открывается быстрее 4 с (цель — 1,5 с)', tOpen + ' мс');

    // §15: просмотрщик офлайн — страница-конструктор рисуется, профиль переключается
    // Dev-сервер Vite отдаёт index.html на любой адрес — настоящий шаблон узнаём
    // по содержимому: в нём код встроен, а не подключён ссылкой.
    const hasTpl = await c.eval(`fetch('/viewer-template.html').then(r => r.ok ? r.text() : '').then(t => !!t && t.includes('window.VIEWER=false;')
      && !/<script[^>]+type="module"[^>]+src=/.test(t)).catch(() => false)`);
    if (!hasTpl) {
      ok('просмотрщик: шаблон есть только в сборке — проверка пропущена на dev-сервере');
    } else {
      const html = await c.eval(`(async () => {
        let blob = null; const orig = URL.createObjectURL;
        URL.createObjectURL = b => { blob = b; return orig.call(URL, b); };
        try { await exportViewer(); } finally { URL.createObjectURL = orig; }
        return blob ? await blob.text() : null; })()`);
      const vpath = require('path').resolve('./chrome-prof-flow-viewer.html');
      require('fs').writeFileSync(vpath, html);
      await c.send('Page.navigate', {url: 'file://' + vpath});
      await c.waitFor(BOOTED, 20000, 'viewer запустился');
      await c.waitFor(`document.querySelectorAll('#flowRoot .react-flow__node').length === 109`, 15000, 'viewer: схема отрисована');
      await choose('#flowBar select[data-f="profile"]', 'pf_ip');
      await sleep(250);
      const vw = await c.eval(`({viewer: document.body.classList.contains('viewer'), ro: FLOW.state().readonly, on: FLOW.active().checks.on})`);
      check(vw.viewer && vw.ro && vw.on === 45, 'viewer.html офлайн: конструктор отрисован, профиль переключается, правки закрыты', JSON.stringify(vw));
      require('fs').unlinkSync(vpath);
      await c.send('Page.navigate', {url: URL});
      await c.waitFor(BOOTED, 25000, 'назад в приложение');
    }

    /* =====================  M5: экспорт  ===================== */
    // Скачивание ловится на URL.createObjectURL; перехват держим, пока файл не появится:
    // выгрузка асинхронная (ленивый чанк), и кнопка возвращает управление раньше.
    const grab = trigger => c.eval(`(async () => {
      let got = null; const orig = URL.createObjectURL;
      URL.createObjectURL = b => { got = b; return orig.call(URL, b); };
      const a = HTMLAnchorElement.prototype.click, names = [];
      HTMLAnchorElement.prototype.click = function () { names.push(this.download); };
      try {
        (async () => { ${trigger} })();
        for (let i = 0; i < 400 && !got; i++) await new Promise(r => setTimeout(r, 50));
        await new Promise(r => setTimeout(r, 100));
      } finally { URL.createObjectURL = orig; HTMLAnchorElement.prototype.click = a; }
      if (!got) return null;
      const buf = new Uint8Array(await got.arrayBuffer());
      let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      return {type: got.type, name: names[names.length - 1], b64: btoa(s), size: buf.length};
    })()`);
    // Проверка просмотрщика уводила вкладку на file:// — открываем доску заново.
    await c.eval(`(async () => { if (!P || P.id !== ${JSON.stringify(KYC_ID)}) await openProject(${JSON.stringify(KYC_ID)}); gotoPage('pg_kyc_rko'); return true; })()`);
    await c.waitFor(`P && P.name === 'KYC/KYB — конструктор проверок' && FLOW.state().mounted && FLOW.state().rfNodes === 109`, 15000, 'доска KYC');
    // С6: xlsx через окно «Экспорт и импорт» → группа «Конструктор»
    await c.eval(`showExport()`);
    await sleep(150);
    const hasGroup = await c.eval(`!!document.querySelector('#mbox [data-x="fxlsx"]') && !!document.querySelector('#flExpProf')`);
    check(hasGroup, 'в «Экспорте и импорте» на конструкторе — группа «Конструктор»');
    const xl = await grab(`document.querySelector('#mbox [data-x="fxlsx"]').click();`);
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(xl.b64, 'base64'));
    const ws = wb.getWorksheet('Проверки');
    const heads = ws.getRow(1).values.slice(1);
    const stageRow = ws.getRow(2), gateRow = [...Array(ws.rowCount).keys()].map(i => ws.getRow(i + 1)).find(r => /^Гейт:/.test(String(r.getCell(1).value)));
    check(ws.rowCount === 66, 'С6: лист «Проверки» — 66 строк (шапка + 7 этапов + 3 гейта + 55)', `${ws.rowCount} строк, файл «${xl.name}»`);
    check(heads.join('|') === '#|Что проверяем|Как проверяем|Зачем проверяем|Источник|Статус согласования|Комментарий|Применимость|Вердикты|Коды факторов|Норматив|Исполнитель|Волна',
      'С6: колонки — как в §10.1', heads.length + ' колонок');
    check(String(stageRow.getCell(1).value) === '1. Проверка телефонного номера' && stageRow.getCell(1).isMerged && stageRow.font && stageRow.font.bold
      && stageRow.getCell(1).fill.fgColor.argb === 'FFEEF1F8', 'строка этапа: объединена, жирная, заливка #eef1f8', String(stageRow.getCell(1).value));
    check(gateRow && gateRow.font && gateRow.font.italic, 'гейт — строка курсивом', gateRow && String(gateRow.getCell(1).value).slice(0, 40));
    check(ws.views[0].state === 'frozen' && ws.views[0].ySplit === 1 && !!ws.autoFilter && ws.columns.map(x => x.width).join('/') === '6/34/46/38/26/18/24/22/18/14/16/12/8',
      'шапка закреплена, автофильтр, ширины 6/34/46/…/8');
    const r315 = [...Array(ws.rowCount).keys()].map(i => ws.getRow(i + 1)).find(r => r.getCell(1).value === '3.15');
    const r38 = [...Array(ws.rowCount).keys()].map(i => ws.getRow(i + 1)).find(r => r.getCell(1).value === '3.8');
    check(/источник не определён/.test(r315.getCell(5).value) && r38.getCell(8).value === 'кроме: ИП, Свежерег < 180 дней',
      'колонки «Источник» и «Применимость» — как в §10.1', r38.getCell(8).value);
    check(['Источники', 'Профили', 'Поля'].every(n => wb.getWorksheet(n)), 'С6: листы «Источники», «Профили», «Поля»');
    const wp = wb.getWorksheet('Профили');
    const ipCol = wp.getRow(1).values.indexOf('P-ИП');
    let ticks = 0; wp.eachRow((r, i) => { if (i > 1 && r.getCell(ipCol).value === '✓') ticks++; });
    const totalRow = wp.getRow(wp.rowCount);
    check(ticks === 45 && totalRow.getCell(ipCol).value === 45, 'лист «Профили» — 45 ✓ в колонке P-ИП и итог', `${ticks} ✓`);
    check(wb.getWorksheet('Источники').rowCount === 25 && wb.getWorksheet('Поля').rowCount === 65, 'источники и поля — все 24 и 64');

    // С7: JSON-контракт проходит схему
    const js = await grab(`FLOW.call('exportFlow', 'json', {})`);
    const contract = JSON.parse(Buffer.from(js.b64, 'base64').toString('utf8'));
    const schemaJson = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '../docs/kycflow.schema.json'), 'utf8'));
    const schemaErr = require('./schema-lite.js').validate(schemaJson, contract);
    const icount = {}; for (const i of contract.issues) icount[i.code] = (icount[i.code] || 0) + 1;
    check(!schemaErr.length && contract.stages.map(s => s.num).join(' ') === '1 2 3a 3b 4 5 6',
      'С7: JSON-контракт валиден по схеме, 7 этапов в порядке исполнения', schemaErr.slice(0, 2).join('; ') || js.name);
    check(icount.INPUT_UNWIRED === 2 && icount.SOURCE_NO_ACCESS === 1 && icount.VERDICT_TBD === 15 && icount.SOURCE_PLANNED === 7 && !icount.VERDICT_UNROUTED,
      'С7: issues совпадают с §10.2', JSON.stringify(icount));
    // фильтр по профилю
    await choose('#flowBar select[data-f="profile"]', 'pf_ip');
    await sleep(200);
    const jsIP = await grab(`FLOW.call('exportFlow', 'json', {byProfile: true})`);
    const conIP = JSON.parse(Buffer.from(jsIP.b64, 'base64').toString('utf8'));
    check(conIP.profileFilter && conIP.profileFilter.id === 'pf_ip' && conIP.stages.flatMap(s => s.checks).length === 45,
      'фильтр выгрузки «только для профиля» — 45 проверок P-ИП');
    await choose('#flowBar select[data-f="profile"]', '');

    // Markdown-архив для Obsidian
    const mdz = await grab(`FLOW.call('exportFlow', 'md', {})`);
    const files = require('fflate').unzipSync(new Uint8Array(Buffer.from(mdz.b64, 'base64')));
    const names = Object.keys(files);
    const root = names[0].split('/')[0];
    const chk311 = names.find(n => /\/Проверки\/3\.11 /.test(n));
    const body311 = Buffer.from(files[chk311]).toString('utf8');
    check(names.length === 1 + 55 + 24 && names.includes(`${root}/${root}.md`) && names.every(n => !/[:*?"<>|]/.test(n.split('/').pop())),
      'Markdown-архив: индекс, 55 проверок и 24 источника, имена без запрещённых символов', `${names.length} файлов в «${root}»`);
    check(/^---\ndate_created: \d{4}-\d{2}-\d{2}\ndate_updated: .*\ndomain: ДБО\nstatus: draft\ntype: spec\ncode: "3\.11"/.test(body311)
      && /## Входы/.test(body311) && /\[\[ЦБ/.test(body311) && /## Вердикты → исходы/.test(body311), 'frontmatter хранилища и разделы проверки', chk311.split('/').pop());
    const egrul = Buffer.from(files[names.find(n => /\/Источники\/ЕГРЮЛ ЕГРИП\.md$/.test(n))]).toString('utf8');
    check(/## Используется в проверках/.test(egrul) && /\[\[2\.6 Дата регистрации\]\]/.test(egrul), 'источник ссылается на проверки, которые его читают');

    // PNG и SVG
    const png = await grab(`FLOW.call('exportFlow', 'png', {})`);
    const pngHead = Buffer.from(png.b64, 'base64').subarray(0, 8).toString('hex');
    check(pngHead === '89504e470d0a1a0a' && png.size > 50000, 'PNG схемы собирается', `${(png.size / 1024).toFixed(0)} КБ`);
    const svg = await grab(`FLOW.call('exportFlow', 'svg', {})`);
    const svgTxt = Buffer.from(svg.b64, 'base64').toString('utf8');
    check(/^<svg/.test(svgTxt) && /foreignObject/.test(svgTxt) && /Проверка телефонного номера/.test(svgTxt), 'SVG схемы — с foreignObject и текстом нод', `${(svg.size / 1024).toFixed(0)} КБ`);
    const noVisLimit = await c.eval(`document.querySelectorAll('#flowRoot .react-flow__node').length`);
    check(noVisLimit === 109, 'после снимка видимость нод возвращается к обычной');

    /* =====================  M6: валидатор, превью, подпись версии  ===================== */
    // Ломаем схему так, как её ломают правкой файла руками или неудачным слиянием.
    const base6 = await c.eval(`JSON.stringify(fingerprint(P))`);
    await c.eval(`(() => { const f = pageById('pg_kyc_rko').flow; snapNow();
      f.nodes.push({id: 'ghost', k: 'check', ref: 'chk_nope', x: 0, y: 1400});
      f.edges.push({id: 'e_bad', s: 'n_src_egrul', sh: 'out:f_regdate', t: 'n_chk_3_4', th: 'in:debt'});
      f.edges.push({id: 'e_gone', s: 'n_src_egrul', sh: 'out:f_gone', t: 'n_chk_2_6', th: 'in:reg'});
      save(1); renderPage(); return true; })()`);
    const sum6 = await c.eval(`summarize(JSON.parse(${JSON.stringify(base6)}), P)`);
    check(/\+1 блок схемы/.test(sum6) && /\+2 связи схемы/.test(sum6), 'подпись версии говорит про схему', sum6);
    const vrows = () => c.eval(`[...document.querySelectorAll('#mbox .lrow')].filter(r => /Конструктор/.test(r.textContent))
      .map(r => r.textContent.replace(/\\s+/g, ' ').trim())`);
    await c.eval(`showValidator()`);
    await sleep(150);
    let vr = await vrows();
    check(vr.length === 3 && vr.some(t => /chk_nope/.test(t) && /Удалить ноду/.test(t)) && vr.some(t => /date → money/.test(t))
      && vr.some(t => /исчезнувшему сокету/.test(t)), 'валидатор: раздел «Конструктор» — три находки, у каждой починка', vr.map(t => t.slice(0, 70)).join(' | '));
    // починка одной находки кнопкой в её строке
    await c.eval(`(() => { const r = [...document.querySelectorAll('#mbox .lrow')].find(r => /date → money/.test(r.textContent));
      r.querySelector('[data-fix]').click(); return true; })()`);
    await sleep(150);
    vr = await vrows();
    const ebad = await c.eval(`pageById('pg_kyc_rko').flow.edges.some(e => e.id === 'e_bad')`);
    check(vr.length === 2 && !ebad, 'кнопка в строке чинит одну находку, окно пересчитывается', vr.length + ' осталось');
    // переход к ноде из находки
    await c.eval(`document.querySelector('#mbox .lrow [data-fgo]') && [...document.querySelectorAll('#mbox [data-fgo]')].find(el => /chk_nope/.test(el.textContent)).click()`);
    await sleep(400);
    const go6 = await c.eval(`({modal: document.getElementById('modal').classList.contains('open'), sel: FLOW.state().selected})`);
    check(!go6.modal && go6.sel.length === 1 && go6.sel[0] === 'ghost', 'из находки — переход к ноде на схеме', JSON.stringify(go6));
    // «Починить всё»
    await c.eval(`showValidator()`);
    await sleep(150);
    await c.eval(`document.querySelector('#mbox [data-a=fixall]').click()`);
    await sleep(200);
    vr = await vrows();
    const after6 = await c.eval(`(() => { const f = pageById('pg_kyc_rko').flow; return {n: f.nodes.length, e: f.edges.length, rf: FLOW.state().rfNodes}; })()`);
    check(vr.length === 0 && after6.n === 109 && after6.e === 137 && after6.rf === 109, '«Починить всё» возвращает схему к целостной', JSON.stringify(after6));
    await c.eval(`closeModal()`);
    // превью для главной: рамки этапов — первыми и серым, ноды — цветом вида
    const pv = await c.eval(`buildPreview()`);
    check(pv && pv.n.length === 90 && pv.n[0][4] === '#e5e8f0' && pv.n.slice(0, 7).every(x => x[4] === '#e5e8f0') && pv.e.length > 50,
      'превью конструктора для главной: рамки первыми, затем ноды и связи', pv && `${pv.n.length} блоков, ${pv.e.length} связей`);

    /* =====================  2.10: связи формой и вид «Список»  ===================== */
    // Небольшая схема: проверка одна; измерения, источник и исход — только в библиотеке.
    await c.eval(`(() => {
      const L = P.flowLib;
      L.sources.push({id: 'src_u', name: 'Реестр сайтов', kind: 'gov', access: 'api', mode: 'sync', status: 'live', fields: [{id: 'f_site', name: 'Сайт', type: 'text', desc: ''}]});
      L.checks.push({id: 'chk_u', code: '9.9', name: 'Сайт в реестре', how: '', inputs: [{id: 'site', name: 'Сайт', type: 'text'}], verdicts: ['manual'], factors: [], bank: {status: 'none', comment: ''}});
      L.outcomes.push({id: 'out_u', name: 'Разбор сайта', verdict: 'manual', desc: ''});
      const pg = {id: 'pg_form', name: 'Форма', kind: 'flow', filter: {q: '', cats: [], statuses: [], types: [], f: {}},
        flow: normalizeFlow({nodes: [{id: 'nU', k: 'check', ref: 'chk_u', x: 0, y: 0}], edges: []})};
      P.pages.push(pg); save(1); gotoPage(pg.id); FLOW.call('select', ['nU']); return true; })()`);
    await sleep(500);
    const fstate = () => c.eval(`(() => { const f = curPage().flow; return {kinds: f.nodes.map(n => n.k).sort().join(','),
      edges: f.edges.map(e => { const s = f.nodes.find(n => n.id === e.s); return (s ? s.k + ':' + (s.ref || '') : '?') + '.' + e.sh + '>' + e.th + (e.neg ? '!' : ''); }).sort().join(' '),
      who: (document.querySelector('[data-wire="who"] [data-who]') || {}).textContent}; })()`);
    const w0 = await fstate();
    check(w0.who === 'для всех' && !!(await c.eval(`!!document.querySelector('[data-wire="data"] select') && !!document.querySelector('[data-wire="verdict"] select')`)),
      'инспектор проверки: «Для кого», «Откуда данные», «Куда ведёт вердикт»', w0.who);
    await clickEl('[data-wire="who"] [data-a="who-more"]');
    await clickEl('[data-wire="who"] [data-dim="dim_ctype"] [data-val="v_ip"]');
    const w1 = await fstate();
    await clickEl('[data-wire="who"] [data-dim="dim_ctype"] [data-val="v_ip"]');
    const w2 = await fstate();
    check(w1.kinds === 'check,dim' && w1.edges === 'dim:dim_ctype.val:v_ip>cond-in' && w1.who === 'для: ИП'
      && w2.edges === 'dim:dim_ctype.val:v_ip>cond-in!' && w2.who === 'для всех, кроме: ИП',
      '«Для кого»: клик — «для», второй — «кроме»; измерение само встаёт на схему', `${w1.who} → ${w2.who}`);
    await choose('[data-wire="data"] [data-input="site"] select', 'src_u::f_site');
    await sleep(200);
    await choose('[data-wire="verdict"] [data-verdict="manual"] select', 'out_u');
    await sleep(200);
    const w3 = await fstate();
    check(w3.kinds === 'check,dim,outcome,source' && w3.edges.includes('source:src_u.out:f_site>in:site') && w3.edges.includes('check:chk_u.v:manual>vin'),
      'источник для входа и исход для вердикта выбираются списком и сами встают на схему', w3.edges);
    for (let i = 0; i < 4; i++) await c.eval(`undo()`);
    await sleep(300);
    const w4 = await fstate();
    check(w4.kinds === 'check' && w4.edges === '', 'каждая правка формой — один шаг отмены', JSON.stringify(w4));

    // «Список» на seed: этапы разделами, строка — проверка; клик открывает инспектор
    await c.eval(`(async () => { if (!P || P.id !== ${JSON.stringify(KYC_ID)}) await openProject(${JSON.stringify(KYC_ID)}); gotoPage('pg_kyc_rko'); return true; })()`);
    await c.waitFor(`FLOW.state().mounted && FLOW.state().rfNodes > 100`, 10000, 'seed для списка');
    await clickEl('#flowBar [data-a="view-list"]');
    await sleep(300);
    const lv = await c.eval(`({rows: document.querySelectorAll('.fl-lrow').length, secs: [...document.querySelectorAll('.fl-lst-h b')].map(x => x.textContent),
      gate: document.querySelectorAll('.fl-lgate').length, r38: (document.querySelector('.fl-lrow[data-row="n_chk_3_8"] .fl-lwho') || {}).textContent})`);
    check(lv.rows === 55 && lv.secs.length === 7 && lv.gate === 3 && lv.r38 === 'для всех, кроме: ИП, Свежерег < 180 дней',
      '«Список»: 7 этапов разделами, 3 условия перехода, 55 проверок строками с «для кого»', `${lv.rows} строк, ${lv.secs.length} этапов`);
    await clickEl('.fl-lrow[data-row="n_chk_2_6"]');
    await sleep(300);
    const lsel = await c.eval(`({sel: FLOW.state().selected, insp: (document.querySelector('.fl-insp') || {dataset: {}}).dataset.insp})`);
    check(lsel.sel.join() === 'n_chk_2_6' && lsel.insp === 'check', 'клик по строке выделяет проверку и открывает её в инспекторе', JSON.stringify(lsel));
    await choose('#flowBar select[data-f="profile"]', 'pf_ip');
    await sleep(250);
    const loff = await c.eval(`document.querySelectorAll('.fl-lrow.fl-loff').length`);
    await clickEl('.fl-pbanner [data-f="hideoff"]');
    await sleep(250);
    const lhidden = await c.eval(`document.querySelectorAll('.fl-lrow').length`);
    await clickEl('.fl-pbanner [data-f="hideoff"]');
    await choose('#flowBar select[data-f="profile"]', '');
    check(loff === 10 && lhidden === 45, 'профиль в списке: 10 строк приглушены, «скрыть погашенные» оставляет 45', `${loff} / ${lhidden}`);
    const ln0 = await c.eval(`curPage().flow.nodes.length`);
    await clickEl('.fl-lst[data-stage="n_st_s3b"] [data-a="list-add"]');
    await sleep(400);
    const added = await c.eval(`(() => { const f = curPage().flow, id = FLOW.state().selected[0], n = f.nodes.find(x => x.id === id); const it = n && P.flowLib.checks.find(x => x.id === n.ref);
      return {nodes: f.nodes.length, parent: n && n.parent, code: it && it.code, focus: !!(document.activeElement && document.activeElement.closest('.fl-insp')),
        row: !!document.querySelector('.fl-lst[data-stage="n_st_s3b"] .fl-lrow[data-row="' + id + '"]')}; })()`);
    check(added.nodes === ln0 + 1 && added.parent === 'n_st_s3b' && added.code === '3.20' && added.focus && added.row,
      '«+ Проверка» в этапе: нода в рамке, код 3.20, строка в разделе, фокус в названии', JSON.stringify(added));
    await c.eval(`undo()`);
    await clickEl('#flowBar [data-a="view-graph"]');
    await sleep(200);
    const lback = await c.eval(`({list: !!document.querySelector('.fl-list'), nodes: curPage().flow.nodes.length})`);
    check(!lback.list && lback.nodes === ln0, 'назад к схеме; отмена убрала добавленную проверку', JSON.stringify(lback));

    /* =====================  M7: справка и версия  ===================== */
    await c.eval(`showHelp()`);
    await sleep(100);
    const help = await c.eval(`document.getElementById('mbox').textContent.replace(/\\s+/g, ' ')`);
    check(/Конструктор проверок/.test(help) && ['Shift+A', 'Ctrl+J', 'Ctrl+H', 'Ctrl+F', 'Ctrl+Shift+Z'].every(k => help.includes(k)),
      'справка: раздел конструктора с горячими клавишами §8.3');
    await c.eval(`closeModal()`);
    const ver = await c.eval(`BUILD.version`).catch(() => null);
    check(ver === require('../package.json').version, 'версия сборки — из package.json', String(ver));

    if (c.errors.length) bad('исключения в консоли', c.errors.join(' | ').slice(0, 400));
    else ok('исключений в консоли нет');
  } catch (e) {
    bad('ПРОГОН УПАЛ', (e && (process.env.FLOW_STACK ? e.stack : e.message)) || String(e));
  } finally {
    try { chrome.kill(); } catch {}
  }
  const fail = results.filter(r => r[0] === '✗');
  console.log(`\n===== ${results.length - fail.length}/${results.length} пройдено =====`);
  process.exit(fail.length ? 1 : 0);
})();
