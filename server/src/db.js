// Одно соединение с SQLite на процесс.
//
// SQLite, а не Postgres: сервер общий с чужими сервисами, нагрузка — единицы человек,
// документы по сотне-другой килобайт. Это на порядки ниже потолка SQLite в WAL,
// а по эксплуатации разница огромная: один файл в томе против отдельного контейнера,
// пароля, healthcheck и pg_dump по расписанию. Бэкап здесь — одна строка SQL.
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const DB_PATH = process.env.DB_PATH || '/data/graphstudio.sqlite';

let db = null;
export function getDb() {
  if (db) return db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  // WAL — чтобы чтение не блокировалось записью.
  db.pragma('journal_mode = WAL');
  // Ссылочная целостность выключена в SQLite по умолчанию: без этого каскады
  // из схемы молча не работают и в базе остаются висячие строки.
  db.pragma('foreign_keys = ON');
  // При параллельной записи ждём, а не падаем сразу с SQLITE_BUSY.
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  return db;
}
export function closeDb() { if (db) { db.close(); db = null; } }
