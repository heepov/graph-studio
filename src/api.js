// Тонкая обёртка над серверным API.
//
// Два правила, которые здесь важнее удобства:
// 1) Любой ответ не-JSON считаем поломкой инфраструктуры, а не данными. Раньше
//    service worker отдавал HTML-оболочку на упавший запрос, и res.json() падал
//    с «Unexpected token '<'» — причину искали часами.
// 2) Ошибку возвращаем текстом на русском: она идёт прямо в интерфейс.
export const API = '/api';

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body || null;
  }
}

async function req(method, path, body) {
  let res;
  try {
    res = await fetch(API + path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : {'content-type': 'application/json'},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new ApiError('нет связи с сервером', 0, null);
  }
  const type = res.headers.get('content-type') || '';
  if (!/json/.test(type)) {
    const head = (await res.text().catch(() => '')).slice(0, 80);
    throw new ApiError(`сервер ответил не JSON (код ${res.status})`, res.status, head);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError((data && data.error) || `ошибка ${res.status}`, res.status, data);
  return data;
}

export const api = {
  get: p => req('GET', p),
  post: (p, b) => req('POST', p, b === undefined ? {} : b),
  put: (p, b) => req('PUT', p, b),
  del: p => req('DELETE', p),

  me: () => req('GET', '/auth/me'),
  login: (email, password) => req('POST', '/auth/login', {email, password}),
  logout: () => req('POST', '/auth/logout', {}),
  register: (email, password, name, invite) => req('POST', '/auth/register', {email, password, name, invite}),
  changePassword: (current, next) => req('POST', '/auth/password', {current, next}),

  boards: () => req('GET', '/boards'),
  boardCreate: doc => req('POST', '/boards', {doc}),
  boardGet: id => req('GET', '/boards/' + encodeURIComponent(id)),
  boardPut: (id, doc, baseVersion) => req('PUT', '/boards/' + encodeURIComponent(id), {doc, baseVersion}),
  boardDelete: id => req('DELETE', '/boards/' + encodeURIComponent(id)),
  boardRestore: id => req('POST', '/boards/' + encodeURIComponent(id) + '/restore', {}),

  shares: id => req('GET', `/boards/${encodeURIComponent(id)}/shares`),
  shareCreate: (id, role, days) => req('POST', `/boards/${encodeURIComponent(id)}/shares`, {role, days}),
  shareRevoke: token => req('DELETE', '/shares/' + encodeURIComponent(token)),
  shareOpen: token => req('GET', '/share/' + encodeURIComponent(token)),

  inviteInfo: token => req('GET', '/invites/' + encodeURIComponent(token)),
  inviteCreate: (email, days) => req('POST', '/invites', {email, days}),

  adminUsers: () => req('GET', '/admin/users'),
  adminBoards: () => req('GET', '/admin/boards'),
  adminStats: () => req('GET', '/admin/stats'),
  adminLog: () => req('GET', '/admin/access-log'),
  adminUserCreate: (email, password, name) => req('POST', '/admin/users', {email, password, name}),
  adminUserPassword: (id, password) => req('POST', `/admin/users/${encodeURIComponent(id)}/password`, {password}),
  adminUserBlock: (id, blocked) => req('POST', `/admin/users/${encodeURIComponent(id)}/block`, {blocked}),
  adminBackup: () => req('POST', '/admin/backup', {}),
};

// Разбор адреса. Приложение получило собственные адреса, и открытая ссылка должна
// вести туда, куда обещает, а не всегда на список проектов.
export function parseRoute(pathname) {
  const p = (pathname || '/').replace(/\/+$/, '') || '/';
  let m;
  if ((m = p.match(/^\/b\/(.+)$/))) return {kind: 'board', id: decodeURIComponent(m[1])};
  if ((m = p.match(/^\/s\/(.+)$/))) return {kind: 'share', token: m[1], role: 'viewer'};
  if ((m = p.match(/^\/e\/(.+)$/))) return {kind: 'share', token: m[1], role: 'editor'};
  if ((m = p.match(/^\/join\/(.+)$/))) return {kind: 'join', token: m[1]};
  if (p === '/admin') return {kind: 'admin'};
  if (p === '/login') return {kind: 'login'};
  return {kind: 'home'};
}
