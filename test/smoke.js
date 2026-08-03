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
      const view = await c.eval(`JSON.parse(JSON.stringify(curPage().view || null))`);
      if (view) ok('камера страницы сохранена в page.view', JSON.stringify(view));
      else bad('page.view пуст — камера не сохраняется');

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
        pageView ? ok('ЭКСПОРТ содержит камеру страницы', JSON.stringify(pageView))
                 : bad('ЭКСПОРТ потерял камеру страницы');
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
        rt.view ? ok('ИМПОРТ сохраняет камеру', JSON.stringify(rt.view)) : bad('ИМПОРТ теряет камеру');
      }

      // --- VIEWER: ссылка коллеге ------------------------------------------
      // viewer весит сотни КБ — разбираем его внутри страницы и наружу отдаём только выжимку
      const viewer = await c.eval(`(async () => {
        let blob = null; const orig = URL.createObjectURL;
        URL.createObjectURL = b => { blob = b; return orig.call(URL, b); };
        try { exportViewer(); } finally { URL.createObjectURL = orig; }
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

    // --- service worker ----------------------------------------------------
    const sw = await c.eval(`navigator.serviceWorker.getRegistrations().then(r => r.length)`);
    sw > 0 ? ok('service worker зарегистрирован') : bad('service worker не зарегистрирован');

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
})();
