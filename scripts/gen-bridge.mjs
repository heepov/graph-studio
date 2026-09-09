// Пересобирает мост в window в конце src/main.js.
//
// Зачем он вообще: сборка делает main.js модулем, а модуль прячет объявления в свою
// область. Тесты (test/smoke.js, test/legacy.js) и отладка из консоли обращаются
// к P, UI, G() и остальным как к глобальным — так этот код и писался.
//
// Запускать после добавления функций верхнего уровня: npm run bridge
import { readFile, writeFile } from 'node:fs/promises';

const F = 'src/main.js';
const src = await readFile(F, 'utf8');

// делим объявление на декларации по запятым верхнего уровня (не внутри скобок и строк)
const splitTop = str => {
  const out = []; let d = 0, q = null, cur = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i], prev = str[i - 1];
    if (q) { cur += ch; if (ch === q && prev !== '\\') q = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { q = ch; cur += ch; continue; }
    if ('([{'.includes(ch)) d++;
    if (')]}'.includes(ch)) d--;
    if (ch === ',' && d === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
};

const fns = new Set(), stable = new Set(), live = new Set();
for (const line of src.split('\n')) {
  let m;
  // Импортированное тоже кладём в мост: тесты и консоль обращаются к api и cloud
  // так же, как к остальному — они часть того же публичного набора.
  if ((m = line.match(/^import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from/))) { stable.add(m[1]); continue; }
  if ((m = line.match(/^import\s+\{([^}]+)\}\s+from/))) {
    m[1].split(',').forEach(part => {
      const n = part.trim().split(/\s+as\s+/).pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(n)) stable.add(n);
    });
    continue;
  }
  if (line.startsWith('import ')) continue;
  if ((m = line.match(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/))) { fns.add(m[1]); continue; }
  if ((m = line.match(/^class\s+([A-Za-z_$][\w$]*)/))) { fns.add(m[1]); continue; }
  if ((m = line.match(/^(const|let|var)\s+([\s\S]*)$/))) {
    const kind = m[1];
    splitTop(m[2].replace(/;\s*$/, '')).forEach(part => {
      const n = part.trim().match(/^([A-Za-z_$][\w$]*)/);
      if (n) (kind === 'const' ? stable : live).add(n[1]);
    });
  }
}
const all = [...fns, ...stable].sort();
const liveArr = [...live].sort();

const MARK = '/* ============ МОСТ В WINDOW ============';
const i = src.indexOf(MARK);
if (i < 0) throw new Error('мост не найден — вставьте маркер вручную');
const lastDef = `Object.defineProperty(window, '${liveArr[liveArr.length - 1]}'`;
const j = src.indexOf('\n\n', src.indexOf(lastDef, i));
if (j < 0) throw new Error('не найден конец блока моста');

const bridge = `${MARK}
   Сборка прячет объявления в область модуля, а тесты (test/smoke.js, test/legacy.js)
   и отладка из консоли обращаются к ним как к глобальным — так этот код и писался.
   Мост ставится ДО boot(), чтобы состояние было видно снаружи с первой миллисекунды.

   Переприсваиваемые переменные отдаются геттерами: простое присваивание положило бы
   в window копию, и после openProject() снаружи был бы виден предыдущий проект.

   Блок СГЕНЕРИРОВАН: scripts/gen-bridge.mjs (npm run bridge). Руками не правьте —
   добавили функцию верхнего уровня, перегенерируйте. */
Object.assign(window, {${all.join(', ')}});
${liveArr.map(n => `Object.defineProperty(window, '${n}', {get: () => ${n}, set: v => {${n} = v;}, configurable: true});`).join('\n')}`;

await writeFile(F, src.slice(0, i) + bridge + src.slice(j));
console.log(`мост: ${all.length} значений + ${liveArr.length} геттеров`);
