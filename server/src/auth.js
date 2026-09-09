// Пароли и сессии.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

// scrypt из стандартной библиотеки: argon2 и bcrypt — нативные модули, каждый из них
// пришлось бы собирать в образе. scrypt при этих параметрах даёт сравнимую стойкость,
// а зависимостей не добавляет вообще.
const N = 16384, r = 8, p = 1, KEYLEN = 64;

export function hashPassword(pass) {
  const salt = randomBytes(16);
  const key = scryptSync(pass, salt, KEYLEN, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(pass, stored) {
  try {
    const [alg, n, rr, pp, salt, key] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const want = Buffer.from(key, 'base64');
    const got = scryptSync(pass, Buffer.from(salt, 'base64'), want.length,
      { N: +n, r: +rr, p: +pp, maxmem: 64 * 1024 * 1024 });
    // сравнение за постоянное время: обычное === утекает длину общего префикса
    return got.length === want.length && timingSafeEqual(got, want);
  } catch { return false; }
}

// 32 случайных байта. Токены ссылок-доступов подбирать бессмысленно.
export const newToken = () => randomBytes(32).toString('base64url');
export const newId = (prefix) => prefix + '_' + randomBytes(9).toString('base64url');

export const SESSION_DAYS = 30;
export const sessionCookie = {
  httpOnly: true,          // недоступна из JS: XSS не уносит сессию
  sameSite: 'lax',         // отсекает CSRF на запись, но не ломает переход по ссылке-доступу
  path: '/',
  secure: process.env.COOKIE_SECURE !== '0',
  maxAge: SESSION_DAYS * 24 * 3600,
};
