// Юнит-тесты чистых модулей конструктора (src/flow/rules.js, src/flow/model.js)
// на node, без браузера и без сервера: правила совместимости, применимость
// профилей и контракт обязаны давать одни и те же ответы и человеку мышью,
// и Claude через MCP — поэтому проверяются здесь, отдельно от интерфейса.
//
//   node test/flow-rules.js
const path = require('path');
const fs = require('fs');

const results = [];
const ok = (n, d = '') => { results.push(['✓', n, d]); console.log('✓', n, d); };
const bad = (n, d = '') => { results.push(['✗', n, d]); console.log('✗', n, d); };
const check = (cond, n, d = '') => (cond ? ok(n, d) : bad(n, d));
const ROOT = path.join(__dirname, '..');

(async () => {
  const R = await import(path.join(ROOT, 'src/flow/rules.js'));
  const M = await import(path.join(ROOT, 'src/flow/model.js'));

  /* ---------- справочники §3 ---------- */
  const T = Object.fromEntries(R.TYPES.map(t => [t.key, t.color]));
  check(R.TYPES.length === 9 && T.bool === '#e0567a' && T.text === '#4fa3e0' && T.number === '#3fb37f'
    && T.money === '#c9a227' && T.date === '#f08a3c' && T.list === '#6b7fd7' && T.person === '#14b8a6'
    && T.file === '#9ca3af' && T.any === '#c4c9d4', 'типы данных и цвета сокетов — как в ТЗ §3', R.TYPE_KEYS.join(' '));
  const V = Object.fromEntries(R.DEFAULT_VERDICTS.map(v => [v.key, v.color]));
  check(R.DEFAULT_VERDICTS.length === 9 && V.ok === '#2e9d58' && V.stop_a === '#9f1d16' && V.stop_b === '#e0473a'
    && V.freeze === '#1f2433' && V.manual === '#c26a00' && V.risk === '#e6a700' && V.clarify === '#3b82f6'
    && V.neutral === '#8a94a6' && V.info === '#b8bfcc', 'девять вердиктов по умолчанию', Object.keys(V).join(' '));
  check(R.NODE_KINDS.length === 10, 'десять видов нод', R.NODE_KINDS.join(' '));

  /* ---------- умолчания и нормализация ---------- */
  const f0 = M.normalizeFlow(undefined);
  check(Array.isArray(f0.nodes) && Array.isArray(f0.edges) && Array.isArray(f0.profiles) && f0.profile === null
    && f0.show.exec === 1 && f0.show.data === 1 && f0.show.cond === 1 && f0.show.verdict === 1 && f0.overlay === '',
    'пустой конвейер получает все умолчания');
  const l0 = M.normalizeLib(null);
  check(l0.v === 1 && l0.dims.length === 0 && l0.verdicts.length === 9, 'пустая библиотека: v1 и девять вердиктов');
  // Умолчания независимы: правка одной библиотеки не должна задеть другую.
  l0.verdicts[0].name = 'испорчено';
  check(M.normalizeLib(null).verdicts[0].name === 'Продолжить / открыть', 'вердикты по умолчанию копируются, а не делятся');

  // Нормализация не переставляет ключи и не дописывает текстовых пустышек.
  const raw = {nodes: [{id: 'a', k: 'check', ref: 'c1', x: 1, y: 2}, {k: 'check'}, null], edges: [{id: 'e1', s: 'a', t: 'b'}, {id: 'e2'}]};
  const f1 = M.normalizeFlow(JSON.parse(JSON.stringify(raw)));
  check(f1.nodes.length === 1 && f1.edges.length === 1, 'битые ноды и связи отбрасываются', `${f1.nodes.length} нод, ${f1.edges.length} связей`);
  check(JSON.stringify(f1.nodes[0]) === JSON.stringify(raw.nodes[0]), 'нода не переписывается нормализацией');
  const lib1 = M.normalizeLib({dims: [{id: 'd1', name: 'Ось'}], checks: [{id: 'c1', name: 'Проверка'}], verdicts: []});
  check(Array.isArray(lib1.dims[0].values) && Array.isArray(lib1.checks[0].inputs) && lib1.checks[0].bank.status === 'none'
    && lib1.checks[0].how === undefined && lib1.verdicts.length === 9,
    'библиотека: досыпаны массивы и согласование, тексты не тронуты, пустой список вердиктов восстановлен');
  const again = JSON.stringify(M.normalizeLib(JSON.parse(JSON.stringify(lib1))));
  check(again === JSON.stringify(lib1), 'нормализация идемпотентна');

  // Библиотека появляется только вместе с конструктором.
  check(!M.needsLib({pages: [{kind: 'canvas'}]}) && M.needsLib({pages: [{kind: 'flow'}]}) && M.needsLib({pages: [], flowLib: {}}),
    'flowLib заводится только при странице-конструкторе или уже существующей библиотеке');

  const fail = results.filter(r => r[0] === '✗');
  console.log(`\n===== ${results.length - fail.length}/${results.length} пройдено =====`);
  process.exit(fail.length ? 1 : 0);
})().catch(e => { console.log('✗ ПРОГОН УПАЛ', e && e.stack || e); process.exit(1); });
