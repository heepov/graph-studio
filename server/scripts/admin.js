// Служебные команды. Запускать на сервере:
//   docker compose exec api node scripts/admin.js <команда> [аргументы]
//
// Нужны потому, что снаружи сервером управлять нечем: ключ деплоя прописан
// с forced command и произвольных команд не выполняет. Это единственный способ
// сбросить пароль, выписать приглашение или посмотреть, что вообще в базе.
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { getDb } from '../src/db.js';
import { hashPassword, newToken, newId } from '../src/auth.js';

const db = getDb();
const [, , cmd, ...args] = process.argv;
const now = () => Date.now();
const fmt = t => t ? new Date(t).toISOString().slice(0, 16).replace('T', ' ') : '—';

function usage() {
  console.log(`Команды:
  users                      кто заведён
  reset-password <почта>     задать новый случайный пароль и показать его
  make-admin <почта>         выдать права администратора
  block <почта>              заблокировать вход
  unblock <почта>            снять блокировку
  invite [почта] [дней]      выписать приглашение и показать ссылку
  invites                    выписанные приглашения
  boards                     доски и их владельцы
  backup                     снять резервную копию прямо сейчас`);
}

const userBy = mail => db.prepare('SELECT * FROM users WHERE email = ?').get(String(mail || '').trim());

switch (cmd) {
  case 'users': {
    const rows = db.prepare('SELECT email, name, is_admin, blocked, created_at, last_seen FROM users ORDER BY created_at').all();
    if (!rows.length) console.log('пользователей нет');
    rows.forEach(u => console.log(
      `${u.is_admin ? '★' : ' '} ${u.blocked ? '⛔' : '  '} ${u.email}  ${u.name || ''}`.padEnd(52) +
      `создан ${fmt(u.created_at)}  был ${fmt(u.last_seen)}`));
    break;
  }
  case 'reset-password': {
    const u = userBy(args[0]);
    if (!u) { console.error('нет такого пользователя'); process.exit(1); }
    const pass = randomBytes(12).toString('base64url');
    db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(pass), u.id);
    // Все сессии закрываются: сброс пароля должен выкидывать того, кто сидел под этой учёткой.
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    console.log(`пароль для ${u.email}: ${pass}`);
    console.log('все его сессии закрыты, показывается один раз');
    break;
  }
  case 'make-admin': {
    const u = userBy(args[0]);
    if (!u) { console.error('нет такого пользователя'); process.exit(1); }
    db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(u.id);
    console.log(`${u.email} теперь администратор`);
    break;
  }
  case 'block': case 'unblock': {
    const u = userBy(args[0]);
    if (!u) { console.error('нет такого пользователя'); process.exit(1); }
    const on = cmd === 'block' ? 1 : 0;
    db.prepare('UPDATE users SET blocked = ? WHERE id = ?').run(on, u.id);
    if (on) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    console.log(`${u.email}: ${on ? 'заблокирован, сессии закрыты' : 'разблокирован'}`);
    break;
  }
  case 'invite': {
    const token = newToken();
    const days = +(args[1] || 14);
    db.prepare('INSERT INTO invites (token, email, created_by, created_at, expires_at) VALUES (?,?,?,?,?)')
      .run(token, args[0] ? String(args[0]).trim() : null, null, now(), now() + days * 864e5);
    console.log(`ссылка: ${process.env.PUBLIC_URL || 'https://graph.heeprod.ru'}/join/${token}`);
    console.log(`действует ${days} дн.${args[0] ? `, только для ${args[0]}` : ', для любой почты'}`);
    break;
  }
  case 'invites': {
    const rows = db.prepare(`SELECT i.token, i.email, i.expires_at, i.used_at, u.email used_by
      FROM invites i LEFT JOIN users u ON u.id = i.used_by ORDER BY i.created_at DESC LIMIT 50`).all();
    if (!rows.length) console.log('приглашений нет');
    rows.forEach(i => console.log(
      `${i.used_at ? 'использовано ' + (i.used_by || '') : 'ждёт'}`.padEnd(34) +
      `${i.email || 'любая почта'}`.padEnd(30) + `до ${fmt(i.expires_at)}  ${i.token.slice(0, 12)}…`));
    break;
  }
  case 'boards': {
    const rows = db.prepare(`SELECT b.id, b.name, b.nodes_count, b.deleted, u.email owner, b.updated_at
      FROM boards b LEFT JOIN users u ON u.id = b.owner_id ORDER BY b.updated_at DESC LIMIT 100`).all();
    if (!rows.length) console.log('досок нет');
    rows.forEach(b => console.log(
      `${b.deleted ? '🗑' : ' '} ${(b.name || b.id).slice(0, 40)}`.padEnd(46) +
      `${b.owner || '—'}`.padEnd(28) + `узлов ${b.nodes_count}  изменена ${fmt(b.updated_at)}`));
    break;
  }
  case 'backup': {
    const dir = process.env.BACKUP_DIR || '/data/backups';
    const to = `${dir}/manual-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.sqlite`;
    mkdirSync(dir, { recursive: true });   // require в ESM не существует
    db.prepare('VACUUM INTO ?').run(to);
    console.log('копия: ' + to);
    break;
  }
  default: usage();
}
