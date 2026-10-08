// Копирует src/flow/rules.js в server/src/mcp/flow-rules.js.
//
// Правила конструктора (совместимость сокетов, применимость, контракт kycflow/1)
// нужны и интерфейсу, и коннектору для Claude. Образ API собирается с контекстом
// ./server и src/ не видит — поэтому сервер получает копию, а не ссылку.
// Копия ГЕНЕРИРУЕТСЯ: руками её не правят. test/flow-rules.js сверяет её
// с оригиналом байт-в-байт, и разъехавшиеся правила дали бы Claude и человеку
// разные ответы на один и тот же вопрос.
//
//   node scripts/sync-flow-rules.mjs          — скопировать
//   node scripts/sync-flow-rules.mjs --check  — только проверить, не разошлись ли
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const SRC = 'src/flow/rules.js', DST = 'server/src/mcp/flow-rules.js';
// Образ приложения собирается без каталога server/ — там копировать некуда,
// и это не ошибка: копию в репозитории уже положила локальная сборка.
if (!existsSync('server/src/mcp')) { console.log('flow-rules: server/ нет рядом — пропускаю'); process.exit(0); }
const src = await readFile(SRC, 'utf8');
let dst = null;
try { dst = await readFile(DST, 'utf8'); } catch { dst = null; }
if (process.argv.includes('--check')) {
  if (src !== dst) { console.error(`${DST} разошёлся с ${SRC} — запустите node scripts/sync-flow-rules.mjs`); process.exit(1); }
  console.log('flow-rules: копия совпадает с оригиналом');
} else if (src !== dst) {
  await writeFile(DST, src);
  console.log(`flow-rules: ${DST} обновлён (${(src.length / 1024).toFixed(0)} КБ)`);
} else {
  console.log('flow-rules: копия уже совпадает');
}
