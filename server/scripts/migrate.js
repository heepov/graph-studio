// Миграции применяет САМ контейнер при старте, до подъёма HTTP.
//
// Почему не через ssh: ключ CI прописан на сервере с forced command и аргументов
// не принимает — передать «примени миграции» снаружи физически нечем.
// Поэтому единственная надёжная точка — entrypoint контейнера. Упали миграции —
// контейнер не поднялся — health красный — деплой считается неуспешным.
//
// Правило: миграции только вперёд и только совместимые с предыдущей версией кода
// (add column / add table / add index). Никаких drop и rename в одном релизе:
// docker compose up пересоздаёт контейнеры не мгновенно и не атомарно с фронтендом.
import { readFileSync, readdirSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, DB_PATH } from '../src/db.js';

const here = dirname(fileURLToPath(import.meta.url));
const MIG_DIR = join(here, '..', 'migrations');
const BACKUP_DIR = process.env.BACKUP_DIR || '/data/backups';
const KEEP = 10;

const db = getDb();
db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL
)`);

const files = readdirSync(MIG_DIR).filter(f => f.endsWith('.sql')).sort();
const applied = new Map(db.prepare('SELECT version, name, checksum FROM schema_migrations').all()
  .map(r => [r.version, r]));

const parse = f => {
  const m = f.match(/^(\d+)_(.+)\.sql$/);
  if (!m) throw new Error(`имя миграции не по формату NNN_название.sql: ${f}`);
  return { version: +m[1], name: m[2], file: f };
};

const all = files.map(parse);
const pending = [];
for (const mig of all) {
  const sql = readFileSync(join(MIG_DIR, mig.file), 'utf8');
  const sum = createHash('sha256').update(sql).digest('hex').slice(0, 16);
  const was = applied.get(mig.version);
  if (!was) { pending.push({ ...mig, sql, sum }); continue; }
  // Изменённая уже применённая миграция — это ошибка, а не «ну ок»: на боевой базе
  // она не переиграется, и код разъедется со схемой молча.
  if (was.checksum !== sum) {
    console.error(`!!! миграция ${mig.file} уже применена, но изменилась (было ${was.checksum}, стало ${sum})`);
    process.exit(1);
  }
}

if (!pending.length) {
  const cur = db.prepare('SELECT COALESCE(MAX(version), 0) v FROM schema_migrations').get().v;
  console.log(`миграции: всё применено, версия схемы ${cur}`);
  process.exit(0);
}

if (process.argv.includes('--status')) {
  console.log('непринятые миграции:', pending.map(p => p.file).join(', '));
  process.exit(0);
}

// Бэкап перед изменением схемы. VACUUM INTO даёт согласованную копию без остановки.
if (existsSync(DB_PATH)) {
  try {
    mkdirSync(BACKUP_DIR, { recursive: true });
    const to = join(BACKUP_DIR, `pre-${String(pending[0].version).padStart(3, '0')}-${Date.now()}.sqlite`);
    db.prepare('VACUUM INTO ?').run(to);
    console.log('бэкап перед миграцией:', to);
    const old = readdirSync(BACKUP_DIR).filter(f => f.startsWith('pre-')).sort();
    for (const f of old.slice(0, Math.max(0, old.length - KEEP))) {
      try { unlinkSync(join(BACKUP_DIR, f)); } catch {}   // require в ESM-модуле не существует
    }
  } catch (e) {
    console.error('!!! не удалось сделать бэкап перед миграцией:', e.message);
    process.exit(1);
  }
}

for (const mig of pending) {
  console.log(`применяю ${mig.file}`);
  const run = db.transaction(() => {
    db.exec(mig.sql);
    db.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)')
      .run(mig.version, mig.name, mig.sum, Date.now());
  });
  try { run(); } catch (e) {
    console.error(`!!! миграция ${mig.file} упала: ${e.message}`);
    process.exit(1);
  }
}
console.log(`миграции: применено ${pending.length}, версия схемы ${pending[pending.length - 1].version}`);
