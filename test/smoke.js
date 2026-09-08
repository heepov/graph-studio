// Регрессионный прогон Graph Studio в headless Chrome.
// Проверяет: загрузку, демо-шаблон, все типы страниц, реальный drag узла мышью,
// сохранение позиций в IndexedDB после перезагрузки и round-trip экспорт → импорт.
const { launch, Client, sleep } = require('./cdp');

const URL = process.env.APP_URL || 'http://127.0.0.1:8081/';
const PORT = 9333;
const results = [];
const ok = (n, d = '') => { results.push(['✓', n, d]); console.log('✓', n, d); };
const bad = (n, d = '') => { results.push(['✗', n, d]); console.log('✗', n, d); };

(async () => {
  const chrome = await launch(PORT, './chrome-prof-test');
  const c = await Client.attach(PORT);
  await c.send('Emulation.setDeviceMetricsOverride', {
    width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false,
  });
  try {
    // --- загрузка ---------------------------------------------------------
    await c.send('Page.navigate', { url: URL });
    await c.waitFor('window.boot !== undefined || document.getElementById("projects")', 20000, 'загрузка html');
    await c.waitFor('typeof PROJECTS !== "undefined" && typeof G === "function"', 20000, 'boot() отработал');
    ok('приложение загрузилось и boot() отработал');

    if (c.errors.length) bad('исключения при загрузке', c.errors.join(' | ').slice(0, 300));
    else ok('исключений при загрузке нет');

    // --- сид ---------------------------------------------------------------
    const seed = await c.eval(`(() => { const s = JSON.parse(document.getElementById('seed').textContent);
      return {name: s.name, nodes: s.nodes.length, links: s.links.length, pages: s.pages.length}; })()`);
    ok('демо-сид разобран', JSON.stringify(seed));

    // --- создание проекта из демо-шаблона ---------------------------------
    await c.waitFor('document.querySelector(\'#tList .pcard[data-t="demo"]\')', 15000, 'карточка шаблона');
    await c.eval(`document.querySelector('#tList .pcard[data-t="demo"]').click()`);
    await c.waitFor('typeof P !== "undefined" && P && P.nodes.length > 0', 15000, 'проект открылся');
    const proj = await c.eval(`({name: P.name, nodes: P.nodes.length, links: P.links.length, pages: P.pages.map(p => p.kind)})`);
    ok('проект создан из шаблона', JSON.stringify(proj));

    // --- валидатор ---------------------------------------------------------
    const v = await c.eval(`(() => { const r = validateProject();
      return Array.isArray(r) ? {n: r.length, kinds: [...new Set(r.map(x => x.kind || x.type || x.t))].slice(0,8)}
                              : {raw: JSON.stringify(r).slice(0,300)}; })()`);
    if (v.n === 0) ok('validateProject(): претензий нет');
    else if (v.n === undefined) ok('validateProject() вернул', JSON.stringify(v).slice(0, 200));
    else bad('validateProject() нашёл проблемы', JSON.stringify(v));

    // --- метрики графа -----------------------------------------------------
    const g = await c.eval(`(() => { const g = G(); const ws = P.nodes.map(n => g.W(n.id));
      return {maxW: Math.max(...ws), steps: [...new Set(P.nodes.map(stepOf))].sort((a,b)=>a-b)}; })()`);
    ok('граф считается', `макс. вес ${g.maxW}, слои ${g.steps.join(',')}`);

    // --- все типы страниц --------------------------------------------------
    const pages = await c.eval(`P.pages.map(p => ({id: p.id, kind: p.kind, name: p.name}))`);
    for (const p of pages) {
      await c.eval(`(UI.page='${p.id}', renderPages(), renderPage(), true)`);
      await sleep(400);
      const cnt = await c.eval(`document.getElementById('view').children.length`);
      if (cnt > 0) ok(`страница «${p.name}» (${p.kind}) отрисовалась`, `${cnt} элементов`);
      else bad(`страница «${p.name}» (${p.kind}) пустая`);
    }

    // --- РЕАЛЬНЫЙ DRAG УЗЛА МЫШЬЮ -----------------------------------------
    // при первом запуске поверх всего открыта справка — она перехватывает клики
    const modalWasOpen = await c.eval(`document.getElementById('modal').classList.contains('open')`);
    await c.eval(`(closeModal(), true)`);
    ok('модалка справки при первом запуске', modalWasOpen ? 'была открыта, закрыл' : 'не открывалась');

    const canvasPage = pages.find(p => p.kind === 'canvas');
    await c.eval(`(UI.page='${canvasPage.id}', renderPages(), renderPage(), true)`);
    await sleep(800);

    const box = await c.eval(`(() => {
      // узлы холста: <div class="nd..." data-n="id">; берём тот, что реально виден и кликабелен
      const els = [...document.querySelectorAll('.nd[data-n]')];
      const tried = [];
      for (const el of els) {
        const r = el.getBoundingClientRect();
        const cx = r.x + r.width/2, cy = r.y + r.height/2;
        if (r.width < 10 || cx < 0 || cy < 0 || cx > innerWidth - 200 || cy > innerHeight - 200) continue;
        const hit = document.elementFromPoint(cx, cy);
        if (hit && hit.closest('.nd[data-n]') === el)
          return {id: el.dataset.n, x: cx, y: cy, w: r.width};
        tried.push(el.dataset.n + ' → ' + (hit ? hit.tagName + '.' + hit.className : 'null'));
      }
      return {fail: true, tried: tried.slice(0, 5)};
    })()`);
    if (!box || box.fail) {
      const diag = await c.eval(`(() => {
        const els = [...document.querySelectorAll('.nd[data-n]')];
        return {viewport: [innerWidth, innerHeight], count: els.length,
          view: document.getElementById('view').innerHTML.slice(0, 200),
          rects: els.slice(0, 5).map(e => { const r = e.getBoundingClientRect();
            return [e.dataset.n, Math.round(r.x), Math.round(r.y), Math.round(r.width)].join(':'); })};
      })()`);
      const chain = await c.eval(`(() => {
        const el = document.querySelector('.nd[data-n]'); const r = el.getBoundingClientRect();
        let h = document.elementFromPoint(r.x + r.width/2, r.y + r.height/2), out = [];
        while (h && out.length < 8) { out.push(h.tagName + '#' + (h.id||'') + '.' + (h.className||'')); h = h.parentElement; }
        return out.join(' < ');
      })()`);
      bad("не нашёл узел на холсте", JSON.stringify(box) + " | цепочка: " + chain);
    }
    else {
      const before = await c.eval(`JSON.parse(JSON.stringify((nodeById('${box.id}').p) || {}))`);
      await c.mouse('mousePressed', box.x, box.y);
      for (let i = 1; i <= 6; i++) await c.mouse('mouseMoved', box.x + i * 25, box.y + i * 15);
      await c.mouse('mouseReleased', box.x + 150, box.y + 90, { buttons: 0 });
      await sleep(800);
      const after = await c.eval(`JSON.parse(JSON.stringify((nodeById('${box.id}').p) || {}))`);
      const key = canvasPage.id;
      if (after[key] && JSON.stringify(after[key]) !== JSON.stringify(before[key]))
        ok('узел перетащен мышью, позиция записана в n.p', `${box.id}: ${JSON.stringify(after[key])}`);
      else bad('позиция после drag не изменилась', `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);

      // --- камера страницы -------------------------------------------------
      // Камера — личное состояние человека, а не часть документа: под общим сервером
      // панорамирование одного не должно писать в проект. Живёт в localStorage.
      await sleep(1300); // дебаунс persistView — 1 с
      const view = await c.eval(`(() => {
        const raw = localStorage.getItem('gs_view:' + P.id + ':' + UI.page);
        return {loc: raw ? JSON.parse(raw) : null, inDoc: curPage().view || null};
      })()`);
      if (view.loc) ok('камера сохранена в localStorage', JSON.stringify(view.loc));
      else bad('камера не сохранилась в localStorage');
      if (!view.inDoc) ok('камера НЕ пишется в документ проекта');
      else bad('камера всё ещё пишется в page.view', JSON.stringify(view.inDoc));

      // Обратная совместимость: у старых проектов и импорта камера лежит в page.view —
      // её по-прежнему читаем, когда локальной записи нет.
      const legacy = await c.eval(`(() => {
        const pid = UI.page, k = 'gs_view:' + P.id + ':' + pid;
        const saved = localStorage.getItem(k); localStorage.removeItem(k);
        const pg = pageById(pid), old = pg.view;
        pg.view = {x: 11, y: 22, k: 0.5}; delete UI.view[pid];
        const v = JSON.parse(JSON.stringify(view()));
        pg.view = old; delete UI.view[pid];
        if (saved) localStorage.setItem(k, saved);
        return v;
      })()`);
      (legacy.x === 11 && legacy.y === 22 && legacy.k === 0.5)
        ? ok('легаси-камера из page.view читается', JSON.stringify(legacy))
        : bad('легаси-камера из page.view не подхватилась', JSON.stringify(legacy));

      // --- инспектор: оверлей, а не флекс-сосед ------------------------------
      // Раньше открытие панели анимировало width: 0 → 430px и отжимало холст:
      // cvRect() менялся, toWorld/fitAll/drawMini врали, мир уезжал на 430 px.
      await c.eval('(closeInsp(), true)');
      const insp = await c.eval(`(async () => {
        const before = Math.round(cvRect().width);
        openNode('${box.id}');
        await new Promise(r => setTimeout(r, 260));   // дождаться transition .16s
        const after = Math.round(cvRect().width);
        const open = document.getElementById('insp').classList.contains('open');
        const w = Math.round(document.getElementById('insp').getBoundingClientRect().width);
        return {before, after, open, w, kind: UI.inspKind};
      })()`);
      (insp.open && insp.before === insp.after)
        ? ok('инспектор не отжимает холст', `ширина #cv ${insp.before} px до и после, панель ${insp.w} px`)
        : bad('инспектор меняет ширину холста', JSON.stringify(insp));
      insp.kind === 'node' ? ok('UI.inspKind знает, что показывает панель') : bad('UI.inspKind не выставлен', JSON.stringify(insp));

      // --- клик по узлу больше не распахивает панель --------------------------
      await c.eval('(closeInsp(), setSel([]), true)');
      const el2 = await c.eval(`(() => {
        const el = document.querySelector('.nd[data-n="${box.id}"]');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2)};
      })()`);
      if (!el2) bad('узел для клика не найден');
      else {
        await c.mouse('mousePressed', el2.x, el2.y);
        await c.mouse('mouseReleased', el2.x, el2.y);
        await sleep(250);
        const afterClick = await c.eval(`({open: document.getElementById('insp').classList.contains('open'), sel: UI.sel.size})`);
        (afterClick.open && afterClick.sel === 1)
          ? ok('клик по узлу открывает его карточку')
          : bad('клик по узлу не открыл карточку', JSON.stringify(afterClick));

        // ...а вот перетаскивание панель открывать НЕ должно
        await c.eval('(closeInsp(), setSel([]), true)');
        await c.mouse('mousePressed', el2.x, el2.y);
        for (let i = 1; i <= 4; i++) await c.mouse('mouseMoved', el2.x + i * 12, el2.y + i * 6);
        await c.mouse('mouseReleased', el2.x + 48, el2.y + 24);
        await sleep(250);
        const afterDrag = await c.eval(`document.getElementById('insp').classList.contains('open')`);
        !afterDrag ? ok('перетаскивание узла панель не открывает')
                   : bad('панель вылезла при перетаскивании');
        // возвращаем узел на место: дальше идут проверки экспорта и перезагрузки,
        // которые сверяются с позицией, записанной в блоке про drag выше
        await c.eval(`(() => { const n = nodeById('${box.id}');
          setNpos(n, '${key}', ${after[key].x}, ${after[key].y}); save(1); renderPage(); return 1; })()`);
        await sleep(600);
      }

      // --- боковая панель сворачивается --------------------------------------
      const side = await c.eval(`(async () => {
        const w0 = Math.round(document.getElementById('side').getBoundingClientRect().width);
        const cv0 = Math.round(cvRect().width);
        toggleSideRail();
        await new Promise(r => setTimeout(r, 260));
        const w1 = Math.round(document.getElementById('side').getBoundingClientRect().width);
        const cv1 = Math.round(cvRect().width);
        const pagesVisible = document.querySelectorAll('#pageList .pgi').length;
        const namesHidden = getComputedStyle(document.querySelector('#pageList .pgi .nm')).display === 'none';
        toggleSideRail();
        await new Promise(r => setTimeout(r, 260));
        const w2 = Math.round(document.getElementById('side').getBoundingClientRect().width);
        return {w0, w1, w2, cv0, cv1, pagesVisible, namesHidden};
      })()`);
      (side.w1 < side.w0 && side.w2 === side.w0)
        ? ok('панель сворачивается и разворачивается', `${side.w0} → ${side.w1} → ${side.w2} px`)
        : bad('панель не сворачивается', JSON.stringify(side));
      (side.pagesVisible > 0 && side.namesHidden)
        ? ok('в узком режиме страницы остаются кликабельными', `строк: ${side.pagesVisible}`)
        : bad('в узком режиме навигация потерялась', JSON.stringify(side));
      side.cv1 > side.cv0
        ? ok('холст получает освободившуюся ширину', `${side.cv0} → ${side.cv1} px`)
        : bad('холст не расширился', JSON.stringify(side));

      // --- зависимости: поиск вместо стены чекбоксов -------------------------
      const deps = await c.eval(`(() => {
        const pg = P.pages.find(p => p.kind === 'canvas');
        UI.page = pg.id; renderPages(); renderPage();
        const g = G();
        // ищем пару, где связь y → x не создаёт цикл и ещё не существует
        let x = null, y = null;
        outer: for (const a of P.nodes) for (const b of P.nodes) {
          if (a.id === b.id) continue;
          if (P.links.some(l => l.from === b.id && l.to === a.id)) continue;
          if (g.DESC[a.id] && g.DESC[a.id].has(b.id)) continue;
          x = a; y = b; break outer;
        }
        if (!x) return {err: 'не нашлось подходящей пары'};
        UI.iTab = 'edit'; UI.sects = {main:1, desc:1, links:1, fields:1, checks:1, more:1};
        openNode(x.id);
        const ib = document.getElementById('ib');
        const before = {
          checkboxes: ib.querySelectorAll('[data-dep]').length,
          searches: ib.querySelectorAll('[data-depq]').length,
          links: P.links.length
        };
        const box = ib.querySelector('[data-depadd]');
        box.querySelector('[data-depdir]').value = 'in';
        const inp = box.querySelector('[data-depq]');
        inp.value = y.name.slice(0, 6); inp.oninput();
        const opt = box.querySelector('[data-pick="' + CSS.escape(y.id) + '"]')
                 || box.querySelector('[data-pick]');
        const pickedId = opt && opt.dataset.pick;
        if (opt) opt.onmousedown(new MouseEvent('mousedown', {cancelable: true}));
        const added = P.links.length - before.links;
        const chips = document.getElementById('ib').querySelectorAll('[data-depdel]').length;
        // теперь убираем чипом
        const del = document.getElementById('ib').querySelector('[data-depdel]');
        if (del) del.onclick();
        const afterDel = P.links.length;
        return {...before, pickedId, added, chips, afterDel, x: x.id, y: y.id};
      })()`);
      if (deps.err) bad('зависимости: ' + deps.err);
      else {
        deps.checkboxes === 0
          ? ok('зависимости: стены чекбоксов больше нет')
          : bad('зависимости: чекбоксы остались', 'штук: ' + deps.checkboxes);
        deps.searches > 0
          ? ok('зависимости: есть поиск по узлам', 'полей поиска: ' + deps.searches)
          : bad('зависимости: поиск не отрисован');
        deps.added === 1
          ? ok('зависимости: связь добавляется из поиска', deps.y + ' → ' + deps.x)
          : bad('зависимости: связь не добавилась', JSON.stringify(deps));
        deps.chips > 0
          ? ok('зависимости: выбранное показано чипами', 'чипов: ' + deps.chips)
          : bad('зависимости: чипы не отрисованы', JSON.stringify(deps));
        deps.afterDel === deps.links
          ? ok('зависимости: чип удаляет связь')
          : bad('зависимости: удаление чипом не сработало', JSON.stringify(deps));
      }

      // --- цикл по-прежнему отклоняется --------------------------------------
      const cyc = await c.eval(`(() => {
        const l = P.links[0]; if (!l) return {err: 'нет связей'};
        const before = P.links.length;
        UI.iTab = 'edit'; UI.sects = {links: 1};
        openNode(l.from);                            // пробуем добавить l.to как то, что держит l.from
        const box = document.getElementById('ib').querySelector('[data-depadd]');
        box.querySelector('[data-depdir]').value = 'in';
        const inp = box.querySelector('[data-depq]');
        const target = nodeById(l.to);
        inp.value = target.name.slice(0, 6); inp.oninput();
        const opt = box.querySelector('[data-pick="' + CSS.escape(l.to) + '"]');
        if (opt) opt.onmousedown(new MouseEvent('mousedown', {cancelable: true}));
        return {before, after: P.links.length, offered: !!opt};
      })()`);
      if (cyc.err) bad('цикл: ' + cyc.err);
      else if (!cyc.offered) ok('цикл: узел-потомок даже не предлагается в поиске');
      else cyc.after === cyc.before
        ? ok('цикл: связь, создающая цикл, отклонена')
        : bad('цикл: связь с циклом прошла', JSON.stringify(cyc));

      // --- ЭКСПОРТ: что реально уезжает в файл ------------------------------
      // dl объявлен как const — подменить нельзя; перехватываем на уровне Blob/createObjectURL
      const exported = await c.eval(`(async () => {
        let blob = null; const orig = URL.createObjectURL;
        URL.createObjectURL = b => { blob = b; return orig.call(URL, b); };
        try { exportProject(); } finally { URL.createObjectURL = orig; }
        return blob ? {name: 'экспорт.json', content: await blob.text()} : null;
      })()`);
      if (!exported) { bad('exportProject() ничего не выгрузил'); }
      else {
        const parsed = JSON.parse(exported.content);
        const node = parsed.nodes.find(n => n.id === box.id);
        const posOk = node && node.p && JSON.stringify(node.p[key]) === JSON.stringify(after[key]);
        posOk ? ok('ЭКСПОРТ содержит позицию узла', `${exported.name}: n.p[${key}]=${JSON.stringify(node.p[key])}`)
              : bad('ЭКСПОРТ потерял позицию узла', JSON.stringify(node && node.p));
        const pageView = parsed.pages.find(p => p.id === key)?.view;
        !pageView ? ok('ЭКСПОРТ не тащит личную камеру в документ')
                  : bad('ЭКСПОРТ содержит камеру — она должна быть личной', JSON.stringify(pageView));
        const keys = Object.keys(parsed);
        ok('ЭКСПОРТ: состав файла', keys.join(', '));
        const lanesOk = parsed.pages.filter(p => p.kind === 'canvas').every(p => p.canvas && Array.isArray(p.canvas.lanes));
        lanesOk ? ok('ЭКСПОРТ содержит колонки холста') : bad('ЭКСПОРТ потерял колонки холста');

        // --- ИМПОРТ round-trip ----------------------------------------------
        const rt = await c.eval(`(() => {
          const d = JSON.parse(${JSON.stringify(exported.content)});
          const pr = normalize(d);
          const n = pr.nodes.find(x => x.id === '${box.id}');
          return {pos: n && n.p && n.p['${key}'], view: (pr.pages.find(p => p.id === '${key}')||{}).view,
                  nodes: pr.nodes.length, links: pr.links.length,
                  pinned: n && n.pinned, lane: n && n.lane};
        })()`);
        JSON.stringify(rt.pos) === JSON.stringify(after[key])
          ? ok('ИМПОРТ сохраняет позицию узла', JSON.stringify(rt.pos))
          : bad('ИМПОРТ теряет позицию узла', JSON.stringify(rt));
        !rt.view ? ok('ИМПОРТ: камеры в документе нет, как и ожидается')
                 : bad('ИМПОРТ принёс камеру в документе', JSON.stringify(rt.view));
      }

      // --- VIEWER: ссылка коллеге ------------------------------------------
      // viewer весит сотни КБ — разбираем его внутри страницы и наружу отдаём только выжимку.
      // exportViewer() стал асинхронным: шаблон тянется через fetch('viewer-template.html'),
      // потому что после перехода на сборку снимок собственного DOM больше не самодостаточен.
      const viewer = await c.eval(`(async () => {
        let blob = null; const orig = URL.createObjectURL;
        URL.createObjectURL = b => { blob = b; return orig.call(URL, b); };
        try { await exportViewer(); } finally { URL.createObjectURL = orig; }
        if (!blob) return null;
        const content = await blob.text();
        const marker = '<script id="seed" type="application/json">';
        const i = content.indexOf(marker), j = content.indexOf('<' + '/script>', i);
        return {name: 'viewer.html', len: content.length,
                seed: content.slice(i + marker.length, j),
                viewerFlag: content.includes('window.VIEWER=true;')};
      })()`);
      if (!viewer) bad('exportViewer() ничего не выгрузил');
      else {
        const vs = JSON.parse(viewer.seed);
        const vn = vs.nodes.find(n => n.id === box.id);
        const vpos = vn && vn.p && vn.p[key];
        JSON.stringify(vpos) === JSON.stringify(after[key])
          ? ok('VIEWER.HTML содержит позицию узла', `${viewer.name}, ${(viewer.len/1024).toFixed(0)} КБ`)
          : bad('VIEWER.HTML потерял позицию узла', JSON.stringify(vn && vn.p));
        viewer.viewerFlag ? ok('VIEWER.HTML в режиме только-просмотр') : bad('VIEWER.HTML без флага VIEWER=true');
      }

      // --- ПЕРЕЗАГРУЗКА: позиция переживает reload (IndexedDB) --------------
      const pid = await c.eval(`P.id`);
      await sleep(1200); // дать save() отработать
      await c.send('Page.navigate', { url: URL + '?v=reload' });
      await c.waitFor('typeof PROJECTS !== "undefined" && typeof G === "function"', 20000, 'перезагрузка');
      // глобали появляются сразу, а idb — только после await openDB() внутри boot();
      // без этого ожидания dbGet ниже иногда падает с «нет БД»
      await c.waitFor('typeof idb !== "undefined" && !!idb', 20000, 'база открыта');
      await sleep(1500);
      const afterReload = await c.eval(`(async () => {
        const pr = await dbGet(STORE, '${pid}');
        const n = pr && pr.nodes.find(x => x.id === '${box.id}');
        return n && n.p && n.p['${key}'];
      })()`);
      JSON.stringify(afterReload) === JSON.stringify(after[key])
        ? ok('позиция пережила перезагрузку (IndexedDB)', JSON.stringify(afterReload))
        : bad('позиция потеряна после перезагрузки', `было ${JSON.stringify(after[key])}, стало ${JSON.stringify(afterReload)}`);
    }

    // --- свободная схема (kind: 'space') -----------------------------------
    const space = await c.eval(`(() => {
      const pg = {id: 'p_space_test', name: 'Схема', kind: 'space',
                  filter: {q: '', cats: [], statuses: [], types: [], f: {}}, space: {}};
      P.pages.push(pg);
      UI.page = pg.id; renderPages(); renderPage();
      const emptyNodes = pageNodes(pg).length;            // на схему ещё ничего не положили
      const hasCanvas = !!document.getElementById('cv');  // отрисовалась именно как холст
      const hasLanes = document.querySelectorAll('.lanebg').length;  // колонок тут быть не должно
      // кладём существующий узел
      const some = P.nodes[0];
      setNpos(some, pg.id, 200, 120);
      renderPage();
      const afterPut = pageNodes(pg).length;
      const drawn = document.querySelectorAll('.nd[data-n]').length;
      const pos = JSON.parse(JSON.stringify(cvPos[some.id] || null));
      // создаём новый узел прямо на схеме
      const before = P.nodes.length;
      addNode({x: 400, y: 300});
      const created = P.nodes[P.nodes.length - 1];
      const createdPlaced = !!npos(created, pg.id);
      // контекстное меню на узле не должно падать (раньше тут был TypeError на pg.canvas)
      let ctxOk = true;
      try {
        const el = document.querySelector('.nd[data-n]');
        const r = el.getBoundingClientRect();
        ctxMenu({target: el, clientX: r.x + 5, clientY: r.y + 5, preventDefault(){}, stopPropagation(){}});
        hideCtx();
      } catch (e) { ctxOk = 'ошибка: ' + e.message; }
      // экспорт картинки со схемы
      let svgOk = true;
      try { svgOk = !!buildCanvasSVG(); } catch (e) { svgOk = 'ошибка: ' + e.message; }
      return {emptyNodes, hasCanvas, hasLanes, afterPut, drawn, pos,
              addedNode: P.nodes.length - before, createdPlaced, ctxOk, svgOk};
    })()`);
    (space.hasCanvas && space.emptyNodes === 0)
      ? ok('схема: новая страница пустая и рисуется холстом')
      : bad('схема: не отрисовалась или не пустая', JSON.stringify(space));
    space.hasLanes === 0 ? ok('схема: колонок зависимостей на ней нет')
                         : bad('схема: нарисованы колонки', 'штук: ' + space.hasLanes);
    (space.afterPut === 1 && space.drawn >= 1 && space.pos && space.pos.x === 200)
      ? ok('схема: узел появляется, когда его положили', JSON.stringify(space.pos))
      : bad('схема: положенный узел не появился', JSON.stringify(space));
    (space.addedNode === 1 && space.createdPlaced)
      ? ok('схема: новый узел создаётся прямо на ней')
      : bad('схема: новый узел не привязался к странице', JSON.stringify(space));
    space.ctxOk === true ? ok('схема: контекстное меню не падает')
                         : bad('схема: контекстное меню упало', String(space.ctxOk));
    space.svgOk === true ? ok('схема: экспорт картинки работает')
                         : bad('схема: экспорт картинки упал', String(space.svgOk));

    // размер узла: хранится по страницам, в n.p[pid].w/h
    const resize = await c.eval(`(() => {
      const pg = pageById('p_space_test'); UI.page = pg.id; renderPage();
      const n = pageNodes(pg)[0]; if (!n) return {err: 'на схеме нет узлов'};
      const had = document.querySelector('.nd .rs') ? 1 : 0;   // ручка есть только на схеме
      setNsize(n, pg.id, 320, 140);
      renderPage();
      const el = document.querySelector('.nd[data-n="' + CSS.escape(n.id) + '"]');
      const box = el ? {w: Math.round(el.getBoundingClientRect().width / view().k),
                        h: Math.round(el.getBoundingClientRect().height / view().k)} : null;
      // на холсте-зависимостях размер тот же узел иметь не должен: он хранится по страницам
      const cv = P.pages.find(p => p.kind === 'canvas');
      const onCanvas = nsize(n, cv.id);
      const stored = JSON.parse(JSON.stringify(n.p[pg.id]));
      UI.page = cv.id; renderPage();
      const handleOnCanvas = document.querySelector('.nd .rs') ? 1 : 0;
      return {had, box, onCanvas, stored, handleOnCanvas};
    })()`);
    if (resize.err) bad('размер узла: ' + resize.err);
    else {
      resize.had ? ok('размер: ручка есть на схеме') : bad('размер: ручки нет на схеме');
      (resize.box && Math.abs(resize.box.w - 320) <= 2 && Math.abs(resize.box.h - 140) <= 2)
        ? ok('размер: узел рисуется заданного размера', JSON.stringify(resize.box))
        : bad('размер: узел не изменился', JSON.stringify(resize));
      (resize.stored.w === 320 && resize.stored.h === 140)
        ? ok('размер: хранится по страницам в n.p[pageId]', JSON.stringify(resize.stored))
        : bad('размер: сохранён не туда', JSON.stringify(resize.stored));
      (resize.onCanvas.w === 212 && resize.onCanvas.h === 74)
        ? ok('размер: на холсте-зависимостях узел прежнего размера')
        : bad('размер: протёк на другую страницу', JSON.stringify(resize.onCanvas));
      resize.handleOnCanvas === 0
        ? ok('размер: на холсте-зависимостях ручки нет')
        : bad('размер: ручка появилась на холсте, где раскладку считает граф');
    }

    // --- горячие клавиши в русской раскладке --------------------------------
    // Сочетания сверялись по e.key: в русской раскладке та же физическая клавиша
    // даёт 'я' вместо 'z', и у человека, который печатает по-русски, НЕ РАБОТАЛО
    // вообще ничего — ни отмена, ни копирование, ни палитра команд.
    const ru = await c.eval(`(() => {
      const cv = P.pages.find(p => p.kind === 'canvas');
      UI.page = cv.id; renderPages(); renderPage();
      const n = pageNodes(cv)[0];
      const was = n.name;
      snapNow(); n.name = 'ПРОВЕРКА ОТМЕНЫ'; save(1); renderPage();
      return {was, now: nodeById(n.id).name, id: n.id};
    })()`);
    // Ctrl+Z «русской» клавишей: code остаётся KeyZ, key приходит как 'я'
    await c.send('Input.dispatchKeyEvent', {type: 'rawKeyDown', code: 'KeyZ', key: 'я',
      windowsVirtualKeyCode: 90, modifiers: 2});
    await c.send('Input.dispatchKeyEvent', {type: 'keyUp', code: 'KeyZ', key: 'я',
      windowsVirtualKeyCode: 90, modifiers: 2});
    await sleep(300);
    const undone = await c.eval(`nodeById('${ru.id}').name`);
    undone === ru.was
      ? ok('Ctrl+Z работает в русской раскладке', `«${ru.now}» → «${undone}»`)
      : bad('Ctrl+Z в русской раскладке не сработал', JSON.stringify({...ru, undone}));

    // палитра команд той же проверкой
    await c.send('Input.dispatchKeyEvent', {type: 'rawKeyDown', code: 'KeyK', key: 'л',
      windowsVirtualKeyCode: 75, modifiers: 2});
    await c.send('Input.dispatchKeyEvent', {type: 'keyUp', code: 'KeyK', key: 'л',
      windowsVirtualKeyCode: 75, modifiers: 2});
    await sleep(250);
    const palOpen = await c.eval(`document.getElementById('pal').classList.contains('open')`);
    palOpen ? ok('Ctrl+K работает в русской раскладке') : bad('Ctrl+K в русской раскладке не сработал');
    await c.eval(`(document.getElementById('pal').classList.remove('open'), true)`);

    // --- склонение и возврат действий --------------------------------------
    const pl = await c.eval(`({
      one: nOf(1, NODES), two: nOf(2, NODES), five: nOf(5, NODES),
      eleven: nOf(11, NODES), tt: nOf(21, NODES), rows: nOf(1, ROWS)
    })`);
    (pl.one === '1 узел' && pl.two === '2 узла' && pl.five === '5 узлов' &&
     pl.eleven === '11 узлов' && pl.tt === '21 узел' && pl.rows === '1 строка')
      ? ok('числительные склоняются', `${pl.one} · ${pl.two} · ${pl.five} · ${pl.eleven} · ${pl.tt}`)
      : bad('склонение неверное', JSON.stringify(pl));

    // возврат в «Авто» действительно пересчитывает раскладку
    const lay = await c.eval(`(() => {
      const pg = P.pages.find(p => p.kind === 'canvas');
      UI.page = pg.id; renderPages(); renderPage();
      pg.canvas.layout = 'free'; seedFreePositions(pg);
      const pinnedFree = pageNodes(pg).filter(n => n.p && n.p[pg.id]).length;
      // имитируем клик по пункту «Авто» в меню раскладки
      const item = [...document.querySelectorAll('#mLay .mi')].find(x => x.dataset.l === 'auto');
      if (!item) return {err: 'пункт «Авто» не найден'};
      item.onclick();
      const pinnedAuto = pageNodes(pg).filter(n => n.p && n.p[pg.id]).length;
      return {pinnedFree, pinnedAuto, layout: pg.canvas.layout};
    })()`);
    if (lay.err) bad('раскладка: ' + lay.err);
    else (lay.pinnedFree > 0 && lay.pinnedAuto === 0 && lay.layout === 'auto')
      ? ok('возврат в «Авто» снимает ручные позиции', `${lay.pinnedFree} → ${lay.pinnedAuto}`)
      : bad('возврат в «Авто» не пересчитал раскладку', JSON.stringify(lay));

    // тост умеет предлагать возврат
    const tst = await c.eval(`(() => {
      let ran = false;
      toast('Проверка', {label: 'Вернуть', run: () => {ran = true;}});
      const el = document.getElementById('toast');
      const btn = el.querySelector('.tact');
      if (btn) btn.click();
      return {hadBtn: !!btn, ran, act: el.classList.contains('act')};
    })()`);
    (tst.hadBtn && tst.ran)
      ? ok('тост предлагает вернуть действие')
      : bad('кнопка возврата в тосте не работает', JSON.stringify(tst));

    // --- пустые состояния холста --------------------------------------------
    const empty = await c.eval(`(() => {
      const out = {};
      // 1) пустая схема
      const sp = pageById('p_space_test');
      if (sp) {
        P.nodes.forEach(n => {if (n.p) delete n.p[sp.id];});
        UI.page = sp.id; renderPage();
        const el = document.getElementById('cvempty');
        out.space = el ? el.querySelector('.ttl').textContent : null;
      }
      // 2) фильтр отсёк всё на холсте зависимостей
      const cv = P.pages.find(p => p.kind === 'canvas');
      const keep = JSON.parse(JSON.stringify(cv.filter));
      cv.filter.q = 'заведомо-несуществующая-строка-xyzzy';
      UI.page = cv.id; renderPage();
      const el2 = document.getElementById('cvempty');
      out.filtered = el2 ? el2.querySelector('.ttl').textContent : null;
      cv.filter = keep; renderPage();
      out.afterRestore = !!document.getElementById('cvempty');
      return out;
    })()`);
    (empty.space && /пуст/i.test(empty.space))
      ? ok('пустая схема объясняет, что делать', empty.space)
      : bad('на пустой схеме нет подсказки', JSON.stringify(empty));
    (empty.filtered && /фильтр/i.test(empty.filtered))
      ? ok('пустой результат фильтра объяснён', empty.filtered)
      : bad('фильтр не объясняет пустоту', JSON.stringify(empty));
    empty.afterRestore === false
      ? ok('подсказка исчезает, когда узлы есть')
      : bad('подсказка осталась при непустом холсте');

    // --- фаза 0: отрисовка не должна писать в документ ----------------------
    // Раньше layoutPage() на странице layout:'free' сеял позиции и звал save() прямо
    // из рендера. Под общим документом это дало бы конкурирующие записи у всех,
    // кто открыл доску одновременно.
    const noWrite = await c.eval(`(async () => {
      const pg = P.pages.find(p => p.kind === 'canvas');
      UI.page = pg.id;
      const wasLayout = pg.canvas.layout;
      pg.canvas.layout = 'free';
      seedFreePositions(pg);                          // явный засев — разрешённая запись
      save(1);
      await new Promise(r => setTimeout(r, 700));     // дать отработать всем сохранениям
      const puts = [];
      const orig = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function () { puts.push(this.name); return orig.apply(this, arguments); };
      renderPage(); renderPage(); renderPage();
      await new Promise(r => setTimeout(r, 900));     // дебаунс save() — 420 мс
      IDBObjectStore.prototype.put = orig;
      pg.canvas.layout = wasLayout;
      return puts;
    })()`);
    noWrite.length === 0
      ? ok('отрисовка свободного холста не пишет в базу')
      : bad('отрисовка пишет в базу', noWrite.join(', '));

    // --- фаза 0: бэкап не теряет корзину и снимки ---------------------------
    // Раньше backupAll() фильтровал !p.deleted и не выгружал store SNAP вообще:
    // перед переездом на сервер это была тихая потеря данных.
    const backup = await c.eval(`(async () => {
      await dbPut(STORE, {id: 'test_trash', name: 'В корзине', desc: '', nodes: [], links: [],
                          frames: [], notes: [], pages: [], deleted: true, updated: '2026-01-01'});
      await makeSnap('тестовый снимок');
      let blob = null; const orig = URL.createObjectURL;
      URL.createObjectURL = b => { blob = b; return orig.call(URL, b); };
      try { await backupAll(); } finally { URL.createObjectURL = orig; }
      const d = blob ? JSON.parse(await blob.text()) : null;
      await dbDel(STORE, 'test_trash');
      return d && {ver: d.graphstudio, trash: d.projects.filter(p => p.deleted).length,
                   snaps: (d.snaps || []).length};
    })()`);
    if (!backup) bad('backupAll() ничего не выгрузил');
    else {
      backup.trash > 0 ? ok('БЭКАП содержит проекты из корзины', 'в корзине: ' + backup.trash)
                       : bad('БЭКАП потерял корзину');
      backup.snaps > 0 ? ok('БЭКАП содержит снимки версий', 'снимков: ' + backup.snaps)
                       : bad('БЭКАП потерял снимки версий');
    }

    // --- service worker ----------------------------------------------------
    // Воркера быть не должно: sw.js теперь kill-switch, приложение его не регистрирует.
    // Прежний воркер отдавал HTML-оболочку с кодом 200 на упавший same-origin GET —
    // с будущим /api/ это ломало бы разбор ответов.
    const sw = await c.eval(`navigator.serviceWorker.getRegistrations().then(r => r.length)`);
    sw === 0 ? ok('service worker не регистрируется (kill-switch)')
             : bad('service worker всё ещё зарегистрирован', 'регистраций: ' + sw);

    const errs = c.errors.filter(e => !/favicon|manifest/i.test(e));
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
  // Выходим явно: открытый WebSocket до Chrome держит event loop, и без этого
  // успешный прогон просто не завершается — в CI это выглядит как зависший шаг.
  process.exit(0);
})();
