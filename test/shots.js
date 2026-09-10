// Снимки экрана для глазной проверки оформления. НЕ тест: ничего не утверждает,
// просто раскладывает PNG по каталогу. Тесты стилей не покрывают, а именно
// оформление тут и меняется.
//   node test/shots.js [каталог] [светлая|тёмная|обе]
const { launch, Client, sleep } = require('./cdp');
const fs = require('fs');
const path = require('path');

const URL = process.env.APP_URL || 'http://127.0.0.1:8081/';
const PORT = 9345;
const OUT = process.argv[2] || './shots';
const WHICH = process.argv[3] || 'обе';
const BOOTED = 'typeof UI !== "undefined" && UI.booted === true';
const EDITOR = " && !document.body.classList.contains('onhome')";

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const chrome = await launch(PORT, './chrome-prof-shots');
  const c = await Client.attach(PORT);
  await c.send('Emulation.setDeviceMetricsOverride',
    { width: 1600, height: 1000, deviceScaleFactor: 2, mobile: false });

  const shot = async (name) => {
    await sleep(450);
    const { data } = await c.send('Page.captureScreenshot', { format: 'png' });
    const f = path.join(OUT, name + '.png');
    fs.writeFileSync(f, Buffer.from(data, 'base64'));
    console.log('•', f);
  };

  await c.send('Page.navigate', { url: URL });
  await c.waitFor(BOOTED, 25000, 'загрузка');
  await shot('00-витрина');

  await c.eval(`createFromTemplate('demo')`);
  await c.waitFor('typeof P !== "undefined" && P && P.nodes.length > 0' + EDITOR, 15000, 'проект');

  const themes = WHICH === 'обе' ? [false, true] : [WHICH === 'тёмная'];
  for (const dark of themes) {
    const t = dark ? 'тёмная' : 'светлая';
    await c.eval(`applyTheme(${dark})`);
    const pages = await c.eval(`P.pages.map(p => ({id: p.id, kind: p.kind, name: p.name}))`);
    for (const pg of pages) {
      await c.eval(`gotoPage(${JSON.stringify(pg.id)})`);
      await sleep(350);
      await shot(`${t}-${pg.kind}`);
    }
    // инспектор
    await c.eval(`openNode(P.nodes[0].id)`);
    await shot(`${t}-инспектор`);
    await c.eval(`closeInsp()`);
    // главная
    await c.eval(`goHome()`);
    await sleep(400);
    await shot(`${t}-главная`);
    await c.eval(`openProject(P.id)`).catch(() => {});
    await c.waitFor('!document.body.classList.contains("onhome")', 10000).catch(() => {});
  }
  await c.eval(`applyTheme(false)`);
  chrome.kill();
  console.log('готово:', OUT);
  process.exit(0);
})().catch(e => { console.error('снимки упали:', e.message); process.exit(1); });
