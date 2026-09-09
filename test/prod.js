// Проверка боевого адреса ПОСЛЕ деплоя. Только чтение.
//
// Раньше здесь гонялся полный test/smoke.js — он создаёт проект из шаблона, тащит
// узел мышью, делает импорт и снимки. Пока приложение было целиком клиентским,
// это оставалось в одноразовом профиле Chrome и никому не мешало. С появлением
// бэкенда тот же набор начал бы писать в БОЕВУЮ базу после каждого деплоя.
//
// Поэтому здесь только неразрушающие проверки: страница поднялась, сборка та,
// что мы задеплоили, API отвечает JSON-ом, консоль чистая.
const { launch, Client, sleep } = require('./cdp');

const URL = process.env.APP_URL || 'https://graph.heeprod.ru/';
const SHA = (process.env.EXPECT_SHA || '').slice(0, 7);
const PORT = 9335;
const results = [];
const ok = (n, d = '') => { results.push(['✓', n, d]); console.log('✓', n, d); };
const bad = (n, d = '') => { results.push(['✗', n, d]); console.log('✗', n, d); };

(async () => {
  const chrome = await launch(PORT, './chrome-prof-prod');
  const c = await Client.attach(PORT);
  try {
    await c.send('Page.navigate', { url: URL });
    await c.waitFor('typeof PROJECTS !== "undefined" && typeof G === "function"', 25000, 'загрузка приложения');
    ok('приложение отдаётся и стартует');

    const errs0 = c.errors.filter(e => !/favicon|manifest/i.test(e));
    errs0.length ? bad('исключения при загрузке', errs0.join(' | ').slice(0, 300))
                 : ok('исключений при загрузке нет');

    // Версия сборки: подтверждает, что задеплоился именно наш коммит, а не
    // остался предыдущий образ. Без этого «деплой прошёл» ничего не значит.
    const ver = await c.eval(`(typeof BUILD !== 'undefined' && BUILD) ? BUILD : null`);
    if (!ver) bad('в сборке нет отметки версии');
    else if (SHA && ver.sha && !ver.sha.startsWith(SHA)) bad('на бою другая сборка', `ожидали ${SHA}, отдаётся ${ver.sha}`);
    else ok('на бою наша сборка', `${ver.version || '?'} · ${ver.sha || '?'}`);

    // /healthz должен отвечать, но сам по себе он ничего не доказывает:
    // это литерал из nginx, он не трогает ни приложение, ни базу.
    const hz = await c.eval(`fetch('/healthz').then(r => r.status).catch(() => 0)`);
    hz === 200 ? ok('/healthz отвечает') : bad('/healthz недоступен', 'код ' + hz);

    // Ключевая проверка на будущий бэкенд: несуществующий путь под /api/ обязан
    // вернуть JSON или 404, но НЕ HTML-оболочку. Если вернётся HTML — значит либо
    // service worker подменяет ответ, либо nginx отдаёт index.html на всё подряд,
    // и тогда res.json() у клиента падает с «Unexpected token '<'».
    const apiProbe = await c.eval(`fetch('/api/__nope__').then(async r => ({
      status: r.status, type: (r.headers.get('content-type') || '')
    })).catch(e => ({err: String(e)}))`);
    if (apiProbe.err) bad('запрос к /api/ не прошёл', apiProbe.err);
    else if (/text\/html/i.test(apiProbe.type)) bad('под /api/ отдаётся HTML-оболочка', JSON.stringify(apiProbe));
    else ok('под /api/ не отдаётся HTML', `код ${apiProbe.status}, тип ${apiProbe.type || '—'}`);

    // старый адрес однофайловой версии должен уводить на корень
    const old = await c.eval(`fetch('/graph_studio.html', {redirect: 'manual'}).then(r => r.status).catch(() => 0)`);
    (old === 301 || old === 200 || old === 0) ? ok('старый адрес не отдаёт 404', 'код ' + old)
                                              : bad('старый адрес сломан', 'код ' + old);

    const errs = c.errors.filter(e => !/favicon|manifest|__nope__|api\//i.test(e));
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
  if (fail.length) { console.log('ПРОВАЛЫ:'); fail.forEach(f => console.log(' ✗', f[1], f[2])); process.exit(1); }
  process.exit(0);
})();
