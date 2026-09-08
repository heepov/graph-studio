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
    b => `<script type="module">\n${b}\n</scr` + `ipt>`);
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
