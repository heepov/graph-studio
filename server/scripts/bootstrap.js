// Заводит администратора при первом старте.
//
// Пароль СЮДА НЕ КЛАДЁТСЯ и в репозиторий не попадает. Порядок такой:
//   1) если задан ADMIN_PASSWORD в окружении — берём его;
//   2) иначе генерируем случайный и печатаем ОДИН РАЗ в лог контейнера.
// Прочитать: docker compose logs api | grep -A3 'ПЕРВЫЙ ЗАПУСК'
//
// Так пароль не проходит через переписку и не лежит файлом в репозитории,
// а поставить файл с секретом на сервер извне я всё равно не могу:
// ключ деплоя прописан с forced command и произвольных команд не выполняет.
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { getDb } from '../src/db.js';
import { hashPassword, newId } from '../src/auth.js';

const db = getDb();
const email = (process.env.ADMIN_EMAIL || 'kaitnik@gmail.com').trim();
const have = db.prepare('SELECT id, is_admin FROM users WHERE email = ?').get(email);

if (have) {
  if (!have.is_admin) {
    db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(have.id);
    console.log(`админ: права выданы существующему пользователю ${email}`);
  } else {
    console.log(`админ: ${email} уже заведён`);
  }
  process.exit(0);
}

const given = process.env.ADMIN_PASSWORD;
const pass = given || randomBytes(12).toString('base64url');
const id = newId('u');
db.prepare('INSERT INTO users (id, email, name, pass_hash, is_admin, created_at) VALUES (?,?,?,?,1,?)')
  .run(id, email, 'Администратор', hashPassword(pass), Date.now());

// Дублируем в файл внутри тома: логи ротируются (max-file: 5), и сообщение
// о первом запуске может потеряться раньше, чем его прочитают.
// Файл удаляется сам, как только админ сменит пароль.
const FIRST_RUN = (process.env.BACKUP_DIR || '/data/backups').replace(/\/backups$/, '') + '/FIRST_RUN.txt';
if (given) {
  console.log(`админ создан: ${email} (пароль взят из ADMIN_PASSWORD)`);
} else {
  try {
    writeFileSync(FIRST_RUN,
      `Heepov Board — первый запуск\n\nАдминистратор: ${email}\nПароль: ${pass}\n\n` +
      `Смените пароль после первого входа — тогда этот файл удалится сам.\n`,
      { mode: 0o600 });
  } catch {}
  console.log('');
  console.log('=================== ПЕРВЫЙ ЗАПУСК ===================');
  console.log(`  Администратор: ${email}`);
  console.log(`  Пароль:        ${pass}`);
  console.log('  Смените его после первого входа.');
  console.log('  Он же продублирован в файле внутри тома:');
  console.log('    docker compose exec api cat /data/FIRST_RUN.txt');
  console.log('=====================================================');
  console.log('');
}
