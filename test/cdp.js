// Минимальный CDP-драйвер поверх встроенного WebSocket (node >= 22)
const { spawn } = require('child_process');
const fs = require('fs');

const CHROME = process.env.CHROME_PATH || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
].find(p => fs.existsSync(p));
if (!CHROME) throw new Error('Chrome не найден — укажите путь через CHROME_PATH');

async function jget(url) { return (await fetch(url)).json(); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function launch(port, profile) {
  fs.rmSync(profile, { recursive: true, force: true });
  const p = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + port, '--user-data-dir=' + profile,
    '--window-size=1600,1000', 'about:blank',
  ], { stdio: 'ignore', detached: false });
  for (let i = 0; i < 60; i++) {
    try { await jget(`http://127.0.0.1:${port}/json/version`); return p; } catch { await sleep(500); }
  }
  throw new Error('chrome не поднялся');
}

class Client {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); this.logs = []; this.errors = []; }
  static async attach(port) {
    const targets = await jget(`http://127.0.0.1:${port}/json/list`);
    const page = targets.find(t => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new Client(ws);
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && c.waiting.has(m.id)) { c.waiting.get(m.id)(m); c.waiting.delete(m.id); }
      if (m.method === 'Runtime.consoleAPICalled')
        c.logs.push(m.params.type + ': ' + m.params.args.map(a => a.value ?? a.description ?? a.type).join(' '));
      if (m.method === 'Runtime.exceptionThrown')
        c.errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    };
    await c.send('Runtime.enable'); await c.send('Page.enable');
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.waiting.set(id, m => m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error))) : res(m.result));
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise, allowUnsafeEvalBlocking: true,
    });
    if (r.exceptionDetails)
      throw new Error('JS: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
  async waitFor(expr, timeout = 20000, label = expr) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (await this.eval(`!!(${expr})`).catch(() => false)) return true;
      await sleep(200);
    }
    throw new Error('таймаут ожидания: ' + label);
  }
  async mouse(type, x, y, extra = {}) {
    await this.send('Input.dispatchMouseEvent', {
      type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra,
    });
  }
}

module.exports = { launch, Client, sleep };
