// Проверки бэкенда. Без браузера — обычный fetch по тому же адресу, что и приложение,
// то есть через контейнерный nginx: заодно проверяется, что проксирование настроено.
//
// Набор НЕразрушающий: аккаунтов не заводит, досок не создаёт. Он гоняется и локально,
// и мог бы гоняться против прода.
const BASE = (process.env.APP_URL || 'http://127.0.0.1:8081/').replace(/\/$/, '');
const results = [];
const ok = (n, d = '') => { results.push(['✓', n, d]); console.log('✓', n, d); };
const bad = (n, d = '') => { results.push(['✗', n, d]); console.log('✗', n, d); };

const call = async (path, opts = {}) => {
  const r = await fetch(BASE + path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
  });
  const type = r.headers.get('content-type') || '';
  let body = null;
  try { body = /json/.test(type) ? await r.json() : (await r.text()).slice(0, 200); } catch {}
  return { status: r.status, type, body };
};

(async () => {
  try {
    const h = await call('/api/health');
    (h.status === 200 && h.body && h.body.ok && h.body.schema >= 1)
      ? ok('/api/health отвечает и трогает базу', `схема ${h.body.schema}, пользователей ${h.body.users}`)
      : bad('/api/health не отвечает как надо', JSON.stringify(h));

    // Самое важное для клиента: под /api/ никогда не должно приходить HTML,
    // иначе res.json() падает с «Unexpected token '<'», а настоящая причина не видна.
    const nf = await call('/api/__nope__');
    (nf.status === 404 && /json/.test(nf.type))
      ? ok('несуществующий путь под /api/ отдаёт JSON, а не оболочку')
      : bad('под /api/ пришло не то', JSON.stringify(nf));

    const me = await call('/api/auth/me');
    (me.status === 200 && me.body && me.body.user === null)
      ? ok('без входа /api/auth/me отдаёт пустого пользователя')
      : bad('/api/auth/me ведёт себя странно', JSON.stringify(me));

    const bad1 = await call('/api/auth/login', {
      method: 'POST', body: JSON.stringify({ email: 'nobody@example.invalid', password: 'x' }) });
    (bad1.status === 401 && !/не найден|нет такого/i.test(JSON.stringify(bad1.body)))
      ? ok('вход с чужой почтой отвечает 401 и не выдаёт, есть ли аккаунт', JSON.stringify(bad1.body))
      : bad('ответ входа выдаёт лишнее', JSON.stringify(bad1));

    const noinv = await call('/api/auth/register', {
      method: 'POST', body: JSON.stringify({ email: 'x@example.invalid', password: 'longenough1' }) });
    (noinv.status === 403)
      ? ok('регистрация без приглашения закрыта', JSON.stringify(noinv.body))
      : bad('регистрация без приглашения прошла', JSON.stringify(noinv));

    const shortpw = await call('/api/auth/register', {
      method: 'POST', body: JSON.stringify({ email: 'x@example.invalid', password: '123', invite: 'нет' }) });
    (shortpw.status === 400 || shortpw.status === 403)
      ? ok('короткий пароль не принимается', JSON.stringify(shortpw.body))
      : bad('короткий пароль прошёл', JSON.stringify(shortpw));

    const adm = await call('/api/invites', { method: 'POST', body: JSON.stringify({}) });
    (adm.status === 401 || adm.status === 403)
      ? ok('админские эндпоинты закрыты без входа', 'код ' + adm.status)
      : bad('админский эндпоинт открыт всем', JSON.stringify(adm));
  } catch (e) {
    bad('ПРОГОН УПАЛ', e.message);
  }

  const fail = results.filter(r => r[0] === '✗');
  console.log(`\n===== ${results.length - fail.length}/${results.length} пройдено =====`);
  process.exit(fail.length ? 1 : 0);
})();
