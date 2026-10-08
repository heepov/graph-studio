// Собирает dist/viewer-template.html — самодостаточную страницу, из которой
// приложение делает viewer.html «только просмотр».
//
// Раньше эту роль играл трюк TEMPLATE = document.documentElement.outerHTML,
// снятый первой строкой скрипта. После перехода на сборку он не работает:
// в собранной странице код и стили лежат отдельными файлами с хэшами в именах,
// и такой снимок ссылался бы на них, а не содержал бы их.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const dist = process.argv[2] || 'dist';
const html = await readFile(join(dist, 'index.html'), 'utf8');

const inlineOne = async (src, tagRe, wrap) => {
  const m = src.match(tagRe);
  if (!m) return { out: src, hit: null };
  const file = m[1].replace(/^\//, '');
  const body = await readFile(join(dist, file), 'utf8');
  if (body.includes('</scr' + 'ipt>')) {
    throw new Error(`в ${file} встретился литерал закрывающего script-тега — он оборвёт встроенный блок`);
  }
  // ВАЖНО: замена функцией, а не строкой. String.replace трактует в СТРОКЕ ЗАМЕНЫ
  // последовательности $&, $`, $', $1… как спецсимволы, а в бандле их полно —
  // подстановка начинала вставлять сама себя и сборка падала по нехватке памяти.
  return { out: src.replace(m[0], () => wrap(body)), hit: file };
};

let out = html, inlined = [], guard = 0;

// Общие чанки, которые главный модуль импортирует статически (у Rolldown это его
// runtime — помощники совместимости с CommonJS, когда React берут и ленивые чанки).
// Встроенный в страницу модуль не может импортировать соседний файл: в просмотрщике,
// открытом с диска, его нет. Такой чанк обязан быть «только экспорт», без импортов, —
// тогда он встраивается в главный модуль функцией, а его импорт меняется на чтение полей.
const shared = new Map();   // имя файла → код замены импорта
for (const m of html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="\/assets\/([^"]+\.js)"[^>]*>/g)) {
  const file = m[1];
  const code = await readFile(join(dist, 'assets', file), 'utf8');
  if (/(^|[;\s])import[\s{*"']/.test(code.replace(/import\(/g, ''))) {
    throw new Error(`общий чанк ${file} сам что-то импортирует — встроить его в просмотрщик нельзя`);
  }
  const ex = code.match(/export\s*\{([^}]*)\}\s*;?\s*$/);
  if (!ex) throw new Error(`общий чанк ${file}: не нашёл export{…} в конце`);
  const map = ex[1].split(',').map(x => x.trim()).filter(Boolean).map(x => { const [a, b] = x.split(/\s+as\s+/); return [b || a, a]; });
  const v = '__shared' + shared.size;
  shared.set(file, `const ${v}=(()=>{${code.slice(0, ex.index)};return{${map.map(([pub, loc]) => `${JSON.stringify(pub)}:${loc}`).join(',')}};})();`);
  out = out.replace(m[0], () => '');
  inlined.push(file + ' (в главный модуль)');
}
const inlineShared = body => body.replace(/import\s*\{([^}]*)\}\s*from\s*"\.\/([^"]+\.js)"\s*;?/g, (all, names, file) => {
  const pre = shared.get(file);
  if (!pre) throw new Error(`главный модуль статически импортирует ${file} — просмотрщик не самодостаточен`);
  const v = pre.match(/^const (__shared\d+)=/)[1];
  const binds = names.split(',').map(x => x.trim()).filter(Boolean).map(x => { const [a, b] = x.split(/\s+as\s+/); return `${JSON.stringify(a)}:${b || a}`; });
  return `${pre}const{${binds.join(',')}}=${v};`;
});

// стили
for (;;) {
  if (++guard > 50) throw new Error('слишком много ассетов — похоже, замена зациклилась');
  const r = await inlineOne(out, /<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"[^>]*>/, b => `<style>\n${b}\n</style>`);
  if (!r.hit) break;
  out = r.out; inlined.push(r.hit);
}
// скрипты-модули
for (;;) {
  if (++guard > 50) throw new Error('слишком много ассетов — похоже, замена зациклилась');
  const r = await inlineOne(out, /<script[^>]*type="module"[^>]*src="([^"]+)"[^>]*><\/scr(?:)ipt>/,
    b => `<script type="module">\n${inlineShared(b)}\n</scr` + `ipt>`);
  if (!r.hit) break;
  out = r.out; inlined.push(r.hit);
}

// проверки-гарды: без них просмотрщик молча перестанет собираться
const need = [
  ['<script id="seed" type="application/json">', 'блок данных, в который подставляется проект'],
  ['window.VIEKER=false;'.replace('VIEKER', 'VIEWER'), 'флаг режима просмотра'],
];
for (const [marker, what] of need) {
  if (!out.includes(marker)) throw new Error(`в шаблоне просмотрщика нет: ${what} (${marker})`);
}
if (/<(script|link)[^>]+(src|href)="\/assets\//.test(out)) {
  throw new Error('в шаблоне остались внешние ссылки на /assets/ — просмотрщик не самодостаточен');
}

await writeFile(join(dist, 'viewer-template.html'), out);
console.log(`viewer-template.html: ${(out.length / 1024).toFixed(0)} КБ, встроено: ${inlined.join(', ')}`);
