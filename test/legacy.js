// Совместимость со старыми файлами: всё, что Graph Studio умел открывать раньше,
// должен открывать и сейчас. Проверяются все форматы, которые понимает код:
//   A. экспорт Graph Studio 1.1/1.2 — с камерой в page.view, позициями в n.p, областями и стикерами
//   B. старый экспорт с легаси-позициями n.x/n.y/pinned и без n.p
//   C. Roadmap Studio — старый формат, распознаётся isLegacy() и конвертируется fromLegacy()
//   D. огрызок из одних узлов и связей — умолчания досыпает normalize()
//   E. бэкап-бандл старой версии {graphstudio: 1, projects: [...]}
const { launch, Client, sleep } = require('./cdp');

const URL = process.env.APP_URL || 'http://127.0.0.1:8081/';
const PORT = 9334;
// boot() САМ открывает нужный экран в самом конце — и делает это уже после того,
// как появились база и P. Ждать этих признаков мало: следом boot покажет главную
// поверх редактора, elementFromPoint попадёт в неё, и клики уйдут не туда.
// Ждать надо UI.booted, а после открытия проекта — что редактор действительно виден.
const BOOTED = 'typeof UI !== "undefined" && UI.booted === true';
const EDITOR_SHOWN = " && !document.body.classList.contains('onhome')";
const results = [];
const ok = (n, d = '') => { results.push(['✓', n, d]); console.log('✓', n, d); };
const bad = (n, d = '') => { results.push(['✗', n, d]); console.log('✗', n, d); };

// ---------- фикстуры ----------
const A = {
  id: 'old_full', name: 'Старый проект 1.2', desc: 'полный экспорт',
  created: '2026-01-10', updated: '2026-02-02',
  schema: {
    nodeTypes: [{key: 'stage', name: 'Этап', shape: 'rect'}, {key: 'gate', name: 'Гейт', shape: 'pill'}],
    statuses: [{key: 'red', name: 'заблокировано', color: '#b3261e'}, {key: 'green', name: 'готово', color: '#1e7a3c'}],
    categories: [{key: 'F', name: 'Фундамент', color: '#6b7280'}],
    linkTypes: [{key: 'hard', name: 'Жёсткая', color: '#9aa1b2', style: 'solid', blocking: 1},
                {key: 'soft', name: 'Мягкая', color: '#c9a227', style: 'dashed', blocking: 0}],
    fields: [{key: 'wave', label: 'Волна', type: 'select', options: ['Wave 1', 'Wave 2'], card: 1},
             {key: 'note', label: 'Контекст', type: 'longtext', card: 0}]
  },
  nodes: [
    {id: 'LIC', name: 'Лицензия', sub: 'рамка', type: 'gate', status: 'red', cat: 'F',
     body: 'длинный текст\nс переносом', draft: 0, lane: null, x: null, y: null, pinned: 0,
     p: {p_main: {x: 456, y: 712}}, f: {wave: 'Wave 1', note: 'важно'},
     checks: [{t: 'Утвердить', s: 'red', b: 1, z: 'коммент'}]},
    {id: 'RKO', name: 'РКО', sub: '', type: 'stage', status: 'green', cat: 'F',
     body: '', draft: 1, lane: 2, x: null, y: null, pinned: 0,
     p: {p_main: {x: 900, y: 300}}, f: {wave: 'Wave 2'}, checks: []}
  ],
  links: [{id: 'l1', from: 'LIC', to: 'RKO', type: 'hard', label: 'блокирует'}],
  frames: [{id: 'f1', name: 'Область', kind: 'frame', x: 400, y: 650, w: 460, h: 320, color: ''}],
  notes: [{id: 't1', text: 'Заметка', x: 100, y: 100, w: 200, h: 96, color: ''}],
  pages: [
    {id: 'p_main', name: 'Карта', kind: 'canvas',
     filter: {q: '', cats: [], statuses: [], types: [], f: {}},
     canvas: {layout: 'auto', lanes: ['блокировки', 'этап 1', 'этап 2'], intro: '<b>Пояснение</b>'},
     view: {x: 120, y: 40, k: 0.9}},
    {id: 'p_tbl', name: 'Таблица', kind: 'table', filter: {q: '', cats: [], statuses: [], types: [], f: {}},
     table: {cols: ['name', 'cat', 'status', 'step', 'weight', 'checks'], sort: 'step', dir: 1, group: ''}},
    {id: 'p_brd', name: 'Канбан', kind: 'board', filter: {q: '', cats: [], statuses: [], types: [], f: {}},
     board: {groupBy: 'status'}},
    {id: 'p_dash', name: 'Обзор', kind: 'dash', filter: {q: '', cats: [], statuses: [], types: [], f: {}}}
  ]
};

const B = {
  id: 'old_xy', name: 'Старый проект с x/y', created: '2025-12-01', updated: '2025-12-05',
  schema: {
    nodeTypes: [{key: 'stage', name: 'Этап', shape: 'rect'}],
    statuses: [{key: 'na', name: 'без статуса', color: '#a8aebd'}],
    categories: [{key: 'gen', name: 'Общее', color: '#3355d1'}],
    linkTypes: [{key: 'hard', name: 'Жёсткая', color: '#9aa1b2', style: 'solid', blocking: 1}],
    fields: []
  },
  nodes: [
    {id: 'A', name: 'Первый', sub: '', type: 'stage', status: 'na', cat: 'gen', body: '',
     draft: 0, lane: null, x: 111, y: 222, pinned: 1, f: {}, checks: []},
    {id: 'B', name: 'Второй', sub: '', type: 'stage', status: 'na', cat: 'gen', body: '',
     draft: 0, lane: null, x: 333, y: 444, pinned: 1, f: {}, checks: []}
  ],
  links: [{id: 'l1', from: 'A', to: 'B', type: 'hard'}],
  pages: [{id: 'p_free', name: 'Свободный холст', kind: 'canvas',
           filter: {q: '', cats: [], statuses: [], types: [], f: {}},
           canvas: {layout: 'free', lanes: []}}]
};

const C = {
  meta: {title: 'Roadmap Studio', intro: '<p>вступление</p>'},
  statuses: {red: {name: 'заблокировано', color: '#b3261e'}, amber: {name: 'в работе', color: '#b8860b'}},
  tracks: {F: {name: 'Фундамент', color: '#6b7280'}, P: {name: 'Платежи', color: '#3355d1'}},
  waves: ['Wave 1', 'Wave 2'],
  boards: [{id: 'main', name: 'Продукт', lanes: ['блокировки', 'этап 1']}],
  nodes: [
    {id: 'N1', t: 'Узел один', s: 'подпись', st: 'red', track: 'F', d: 'описание', col: 0,
     wv: 'Wave 1', gate: 'гейт', note: 'контекст', cont: ['раз', 'два'], board: 'main',
     m: [{v: 'веха', s: 'red', b: 1, z: 'зачем'}], deps: [], soft: []},
    {id: 'N2', t: 'Узел два', st: 'amber', track: 'P', board: 'main', deps: ['N1'], soft: [], fx: 500, fy: 250}
  ]
};

const D = {nodes: [{id: 'X', name: 'Одинокий'}], links: []};
const E = {graphstudio: 1, exported: '2026-01-01', projects: [JSON.parse(JSON.stringify(A))]};
E.projects[0].id = 'old_bundle';

(async () => {
  const chrome = await launch(PORT, './chrome-prof-legacy');
  const c = await Client.attach(PORT);
  await c.send('Emulation.setDeviceMetricsOverride', {width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false});
  try {
    await c.send('Page.navigate', {url: URL});
    await c.waitFor('typeof PROJECTS !== "undefined" && typeof G === "function"', 20000, 'загрузка');
    // Ждём именно открытую базу, а не просто разобранный скрипт: глобали существуют
    // сразу, а idb появляется только после await openDB() внутри boot(). Без этого
    // dbPut падает с «нет БД» — на быстрой машине везёт, на CI-раннере нет.
    await c.waitFor(BOOTED, 25000, 'приложение загрузилось');
    await c.eval('(closeModal(), true)');
    if (c.errors.length) bad('исключения при загрузке', c.errors.join(' | ').slice(0, 200));

    // общий прогон: положить проект, открыть, отрисовать ВСЕ страницы
    const openFixture = async (label, obj) => {
      const res = await c.eval(`(async () => {
        const raw = ${JSON.stringify(JSON.stringify(obj))};
        const d = JSON.parse(raw);
        const pr = isLegacy(d) ? fromLegacy(d) : normalize(d);
        await dbPut(STORE, pr);
        await loadProjects();
        await openProject(pr.id);
        const rendered = [];
        for (const pg of P.pages) {
          UI.page = pg.id; renderPages(); renderPage();
          rendered.push({kind: pg.kind, name: pg.name, els: document.getElementById('view').children.length});
        }
        return {id: P.id, name: P.name, nodes: P.nodes.length, links: P.links.length,
                pages: P.pages.map(p => p.kind), rendered,
                pos: JSON.parse(JSON.stringify(typeof cvPos === 'object' ? cvPos : {}))};
      })()`);
      const empty = res.rendered.filter(r => !r.els);
      if (!empty.length) ok(`${label}: открылся и отрисовал все страницы`,
        `${res.nodes} узлов, ${res.links} связей, страницы: ${res.pages.join('/')}`);
      else bad(`${label}: пустые страницы`, empty.map(e => e.kind).join(','));
      return res;
    };

    // --- A: полный экспорт 1.2 -------------------------------------------
    const a = await openFixture('A · экспорт 1.2', A);
    a.nodes === 2 && a.links === 1 ? ok('A: узлы и связи на месте') : bad('A: потеряны узлы или связи', JSON.stringify(a));
    const aDeep = await c.eval(`(() => {
      const n = nodeById('LIC'), g = G();
      const pg = pageById('p_main');
      return {pos: n.p && n.p.p_main, checks: n.checks.length, wave: n.f.wave, note: n.f.note,
              sub: n.sub, body: n.body, lane: nodeById('RKO').lane, draft: nodeById('RKO').draft,
              label: (P.links[0] || {}).label, frames: P.frames.length, notes: P.notes.length,
              lanes: pg.canvas.lanes.length, intro: !!pg.canvas.intro,
              statuses: P.schema.statuses.length, fields: P.schema.fields.length,
              weight: g.W('LIC'), layer: g.layer.RKO};
    })()`);
    const aOk = JSON.stringify(aDeep.pos) === '{"x":456,"y":712}' && aDeep.checks === 1 &&
      aDeep.wave === 'Wave 1' && aDeep.note === 'важно' && aDeep.sub === 'рамка' &&
      aDeep.body.includes('\n') && aDeep.lane === 2 && aDeep.draft === 1 && aDeep.label === 'блокирует' &&
      aDeep.frames === 1 && aDeep.notes === 1 && aDeep.lanes === 3 && aDeep.intro &&
      aDeep.statuses === 2 && aDeep.fields === 2;
    aOk ? ok('A: ничего не потеряно', `позиция, вехи, поля, подпись, описание с переносом, колонка, черновик, подпись связи, область, стикер, колонки холста, пояснение, схема`)
        : bad('A: что-то потерялось', JSON.stringify(aDeep));
    (aDeep.weight === 1 && aDeep.layer === 1)
      ? ok('A: метрики графа считаются', `вес LIC=${aDeep.weight}, слой RKO=${aDeep.layer}`)
      : bad('A: метрики графа сломались', JSON.stringify(aDeep));
    // Камера из старого файла обязана подхватиться — но осесть в браузере, а не
    // остаться в документе: иначе чужой зум годичной давности ездит в каждом
    // экспорте и в каждой копии доски и никогда не обновляется.
    const aView = await c.eval(`(() => { UI.page='p_main'; delete UI.view['p_main'];
      return {view: JSON.parse(JSON.stringify(view())),
              inDoc: !!pageById('p_main').view,
              stored: localStorage.getItem('gs_view:' + P.id + ':p_main')}; })()`);
    (aView.view.x === 120 && aView.view.y === 40 && aView.view.k === 0.9)
      ? ok('A: камера из старого файла подхватилась', JSON.stringify(aView.view))
      : bad('A: камера из старого файла потеряна', JSON.stringify(aView.view));
    (!aView.inDoc && aView.stored)
      ? ok('A: камера переехала в браузер и убрана из документа')
      : bad('A: камера осталась в документе и поедет в экспорт', JSON.stringify(aView));

    // --- B: легаси-позиции x/y без n.p ------------------------------------
    const b = await openFixture('B · легаси x/y', B);
    const bPos = b.pos || {};
    (bPos.A && bPos.A.x === 111 && bPos.A.y === 222 && bPos.B && bPos.B.x === 333 && bPos.B.y === 444)
      ? ok('B: узлы встали по старым координатам x/y', JSON.stringify(bPos))
      : bad('B: старые координатыx/y не применились', JSON.stringify(bPos));

    // --- C: Roadmap Studio -------------------------------------------------
    const cc = await openFixture('C · Roadmap Studio', C);
    const cDeep = await c.eval(`(() => {
      const n = P.nodes.find(x => x.id === 'N1');
      return {nodes: P.nodes.length, links: P.links.length, name: n && n.name, sub: n && n.sub,
              checks: n ? n.checks.length : -1, contains: n && n.f && n.f.contains,
              cats: P.schema.categories.length, sts: P.schema.statuses.length,
              pages: P.pages.map(p => p.kind).join('/')};
    })()`);
    (cDeep.nodes === 2 && cDeep.links === 1 && cDeep.name === 'Узел один' && cDeep.sub === 'подпись' &&
     cDeep.checks === 1 && Array.isArray(cDeep.contains) && cDeep.contains.length === 2 &&
     cDeep.cats === 2 && cDeep.sts === 2)
      ? ok('C: старый формат сконвертирован без потерь', JSON.stringify(cDeep))
      : bad('C: конвертация потеряла данные', JSON.stringify(cDeep));

    // --- D: огрызок --------------------------------------------------------
    const d = await openFixture('D · минимальный файл', D);
    const dDeep = await c.eval(`({schema: !!P.schema.statuses.length, pages: P.pages.length,
      frames: Array.isArray(P.frames), notes: Array.isArray(P.notes), checks: Array.isArray(P.nodes[0].checks)})`);
    (dDeep.schema && dDeep.pages >= 1 && dDeep.frames && dDeep.notes && dDeep.checks)
      ? ok('D: умолчания досыпаны, файл открылся')
      : bad('D: normalize() не восстановил структуру', JSON.stringify(dDeep));

    // --- E: старый бэкап-бандл --------------------------------------------
    const e = await c.eval(`(async () => {
      const d = JSON.parse(${JSON.stringify(JSON.stringify(E))});
      let addedName = null;
      for (const pr of d.projects) { pr.id = pr.id || uid('pr'); await dbPut(STORE, normalize(pr)); addedName = pr.name; }
      await loadProjects();
      const found = PROJECTS.find(p => p.id === 'old_bundle');
      return {name: addedName, found: !!found, nodes: found && found.nodes};
    })()`);
    (e.found && e.nodes === 2) ? ok('E: бэкап-бандл версии 1 восстанавливается', JSON.stringify(e))
                               : bad('E: старый бэкап не восстановился', JSON.stringify(e));

    // --- экспорт после открытия старого файла всё ещё читается -------------
    const rt = await c.eval(`(async () => {
      await openProject('old_full');
      let blob = null; const orig = URL.createObjectURL;
      URL.createObjectURL = b => { blob = b; return orig.call(URL, b); };
      try { exportProject(); } finally { URL.createObjectURL = orig; }
      const txt = await blob.text();
      const back = normalize(JSON.parse(txt));
      const n = back.nodes.find(x => x.id === 'LIC');
      return {nodes: back.nodes.length, links: back.links.length, pos: n.p && n.p.p_main,
              frames: back.frames.length, notes: back.notes.length, checks: n.checks.length};
    })()`);
    (rt.nodes === 2 && rt.links === 1 && JSON.stringify(rt.pos) === '{"x":456,"y":712}' &&
     rt.frames === 1 && rt.notes === 1 && rt.checks === 1)
      ? ok('старый файл → экспорт → импорт: ничего не потеряно', JSON.stringify(rt))
      : bad('round-trip старого файла теряет данные', JSON.stringify(rt));

    const errs = c.errors.filter(e2 => !/favicon|manifest/i.test(e2));
    errs.length ? bad('исключения в консоли', errs.join(' | ').slice(0, 400)) : ok('исключений в консоли нет');

  } catch (e) {
    bad('ПРОГОН УПАЛ', e.message);
    console.log('консоль:', c.logs.slice(-10).join('\n'));
    console.log('ошибки:', c.errors.slice(-5).join('\n'));
  } finally {
    chrome.kill();
  }

  const fail = results.filter(r => r[0] === '✗');
  console.log(`\n===== ${results.length - fail.length}/${results.length} пройдено =====`);
  if (fail.length) { console.log('ПРОВАЛЫ:'); fail.forEach(f => console.log(' ✗', f[1], f[2])); process.exit(1); }
  process.exit(0);
})();
