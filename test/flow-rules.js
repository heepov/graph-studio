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

  /* ---------- M1: матрица соединений §4.2, клетка за клеткой ---------- */
  const lib = M.normalizeLib({
    dims: [{id: 'D', name: 'Ось', values: [{id: 'v1', name: 'Один'}, {id: 'v2', name: 'Два'}]}],
    sources: [{id: 'S', name: 'Реестр', fields: [{id: 'fd', name: 'Дата', type: 'date'},
      {id: 'fm', name: 'Сумма', type: 'money'}, {id: 'ft', name: 'Текст', type: 'text'}]}],
    checks: [{id: 'C1', code: '1.1', name: 'Первая', inputs: [{id: 'd', name: 'Дата', type: 'date'},
      {id: 'm', name: 'Сумма', type: 'money'}, {id: 'a', name: 'Что угодно', type: 'any'}], verdicts: ['stop_b', 'info']},
      {id: 'C2', code: '1.2', name: 'Вторая', inputs: [{id: 'd', name: 'Дата', type: 'date'}], verdicts: ['risk']}],
    outcomes: [{id: 'O', name: 'Отказ', verdict: 'stop_b'}],
  });
  const mk = () => M.normalizeFlow({nodes: [
    {id: 'nSt', k: 'stage', x: 0, y: 0, w: 360, h: 400, data: {num: '1', name: 'Этап'}},
    {id: 'nD', k: 'dim', ref: 'D', x: 0, y: 0}, {id: 'nS', k: 'source', ref: 'S', x: 0, y: 0},
    {id: 'nC1', k: 'check', ref: 'C1', x: 0, y: 0}, {id: 'nC2', k: 'check', ref: 'C2', x: 0, y: 0},
    {id: 'nO', k: 'outcome', ref: 'O', x: 0, y: 0}, {id: 'nG', k: 'gate', x: 0, y: 0, data: {text: 'Гейт'}},
    {id: 'nA', k: 'anyof', x: 0, y: 0, data: {type: 'date', n: 2}}, {id: 'nAny', k: 'anyof', x: 0, y: 0, data: {type: 'any', n: 2}},
    {id: 'nCalc', k: 'calc', x: 0, y: 0, data: {name: 'DSCR', inputs: [{id: 'x', name: 'Выручка', type: 'money'}], type: 'money'}},
    {id: 'nR', k: 'reroute', x: 0, y: 0}, {id: 'nNote', k: 'note', x: 0, y: 0, data: {text: 'заметка'}},
  ], edges: []});
  const fl = mk();
  const can = (s, sh, t, th) => R.canConnect(fl, lib, {source: s, sourceHandle: sh, target: t, targetHandle: th});
  // Строка — выход, столбец — вход; ожидание прямо из таблицы ТЗ.
  const OUTS = {
    'exec-out (проверка)': ['nC1', 'exec-out'], 'exec-out (этап)': ['nSt', 'exec-out'], 'exec-no (гейт)': ['nG', 'exec-no'],
    'val:* (измерение)': ['nD', 'val:v1'],
    'out:* date (источник)': ['nS', 'out:fd'], 'out (один из, date)': ['nA', 'out'], 'out (показатель, money)': ['nCalc', 'out'],
    'v:* (вердикт)': ['nC1', 'v:stop_b'],
  };
  const INS = {
    'exec-in': ['nC2', 'exec-in'], 'cond-in': ['nC2', 'cond-in'], 'in:* date': ['nC2', 'in:d'],
    'vin': ['nO', 'vin'], 'in:* один из (date)': ['nA', 'in:0'], 'in reroute': ['nR', 'in'],
  };
  const EXPECT = {
    'exec-out (проверка)': {'exec-in': 1, 'cond-in': 0, 'in:* date': 0, 'vin': 1, 'in:* один из (date)': 0, 'in reroute': 1},
    'exec-out (этап)': {'exec-in': 1, 'cond-in': 0, 'in:* date': 0, 'vin': 1, 'in:* один из (date)': 0, 'in reroute': 1},
    'exec-no (гейт)': {'exec-in': 1, 'cond-in': 0, 'in:* date': 0, 'vin': 1, 'in:* один из (date)': 0, 'in reroute': 1},
    'val:* (измерение)': {'exec-in': 0, 'cond-in': 1, 'in:* date': 0, 'vin': 0, 'in:* один из (date)': 0, 'in reroute': 1},
    'out:* date (источник)': {'exec-in': 0, 'cond-in': 0, 'in:* date': 1, 'vin': 0, 'in:* один из (date)': 1, 'in reroute': 1},
    'out (один из, date)': {'exec-in': 0, 'cond-in': 0, 'in:* date': 1, 'vin': 0, 'in:* один из (date)': 0, 'in reroute': 1},
    'out (показатель, money)': {'exec-in': 0, 'cond-in': 0, 'in:* date': 0, 'vin': 0, 'in:* один из (date)': 0, 'in reroute': 1},
    'v:* (вердикт)': {'exec-in': 0, 'cond-in': 0, 'in:* date': 0, 'vin': 1, 'in:* один из (date)': 0, 'in reroute': 1},
  };
  let cells = 0, wrong = [];
  for (const [on, [s, sh]] of Object.entries(OUTS)) {
    for (const [inn, [t, th]] of Object.entries(INS)) {
      if (s === t) continue;   // «один из» сам в себя — это не клетка матрицы, а связь в себя
      cells++;
      const r = can(s, sh, t, th);
      if (!!r.ok !== !!EXPECT[on][inn]) wrong.push(`${on} → ${inn}: ${r.ok ? 'разрешено' : r.reason}`);
    }
  }
  check(!wrong.length, 'матрица §4.2: каждая клетка', wrong.length ? wrong.join('; ') : `${cells} клеток`);

  // Тексты отказов — те, что видит человек у курсора.
  const r1 = can('nS', 'out:fd', 'nC1', 'in:m');
  check(!r1.ok && r1.reason === 'date → money: типы не совпадают', 'отказ по типам объясняет, что с чем не сошлось', r1.reason);
  const r2 = can('nS', 'out:fd', 'nO', 'vin');
  check(!r2.ok && r2.reason === 'в исход можно вести только вердикт или порядок', 'в исход — только вердикт или порядок', r2.reason);
  check(can('nS', 'out:fd', 'nC1', 'in:a').ok, 'вход any принимает любой тип данных');
  check(can('nS', 'out:fm', 'nCalc', 'in:x').ok && !can('nS', 'out:fd', 'nCalc', 'in:x').ok, 'вход показателя типизирован');
  const self = can('nC1', 'exec-out', 'nC1', 'exec-in');
  check(!self.ok && /в себя/.test(self.reason), 'связь в себя запрещена', self.reason);
  check(!can('nC2', 'exec-in', 'nC1', 'exec-out').ok && !can('nC1', 'nope', 'nC2', 'exec-in').ok,
    'связь всегда от выхода ко входу, несуществующий сокет отклоняется');
  check(!can('nNote', 'out', 'nC1', 'exec-in').ok, 'у заметки сокетов нет');

  // Кратность: вход данных держит одну связь, новая её заменяет.
  fl.edges.push({id: 'e1', s: 'nS', sh: 'out:fd', t: 'nC1', th: 'in:d'});
  const rep = can('nA', 'out', 'nC1', 'in:d');
  check(rep.ok && rep.replace.length === 1 && rep.replace[0] === 'e1', 'занятый вход данных: новая связь заменяет старую', JSON.stringify(rep.replace));
  check(!can('nS', 'out:fd', 'nC1', 'in:d').ok, 'повтор существующей связи отклоняется');
  fl.edges.push({id: 'e2', s: 'nD', sh: 'val:v1', t: 'nC1', th: 'cond-in'});
  const many = can('nD', 'val:v2', 'nC1', 'cond-in');
  check(many.ok && many.replace.length === 0, 'cond-in принимает много связей');
  fl.edges.push({id: 'e3', s: 'nC1', sh: 'v:stop_b', t: 'nO', th: 'vin'});
  check(can('nC2', 'v:risk', 'nO', 'vin').ok && can('nC2', 'v:risk', 'nO', 'vin').replace.length === 0, 'vin принимает много связей');

  // Циклы по порядку исполнения — в том числе через вердикт и исход.
  fl.edges.push({id: 'e4', s: 'nC1', sh: 'exec-out', t: 'nC2', th: 'exec-in'});
  const cyc = can('nC2', 'exec-out', 'nC1', 'exec-in');
  check(!cyc.ok && /цикл/.test(cyc.reason), 'цикл по exec отклонён', cyc.reason);
  const cyc2 = can('nO', 'exec-out', 'nC1', 'exec-in');
  check(!cyc2.ok && /цикл/.test(cyc2.reason), 'цикл через вердикт → исход → порядок отклонён', cyc2.reason);
  check(can('nO', 'exec-out', 'nG', 'exec-in').ok, 'порядок из исхода дальше — можно, пока нет цикла');

  // Reroute принимает тип первой связи и дальше ведёт себя как сокет этого типа.
  check(can('nD', 'val:v1', 'nR', 'in').ok && can('nC1', 'v:info', 'nR', 'in').ok, 'пустой reroute примет что угодно');
  fl.edges.push({id: 'e5', s: 'nS', sh: 'out:fd', t: 'nR', th: 'in'});
  const rOut = R.socketOf(fl, lib, 'nR', 'out', 'out');
  check(rOut.kind === 'data' && rOut.type === 'date', 'reroute взял тип первой связи', `${rOut.kind}/${rOut.type}`);
  check(can('nR', 'out', 'nC2', 'in:d').ok && !can('nR', 'out', 'nC1', 'in:m').ok && !can('nR', 'out', 'nC2', 'cond-in').ok,
    'reroute дальше ведёт себя как сокет date');
  const rIn = can('nS', 'out:fm', 'nR', 'in');
  check(!rIn.ok, 'вход reroute после первой связи уже типизирован', rIn.reason);
  check(R.edgeKind(fl, lib, {s: 'nR', sh: 'out', t: 'nC2', th: 'in:d'}) === 'data'
    && R.edgeColor(fl, lib, {s: 'nR', sh: 'out', t: 'nC2', th: 'in:d'}) === '#f08a3c', 'связь из reroute красится цветом своего типа');

  // «Один из» с типом any принимает тип первой связи.
  fl.edges.push({id: 'e6', s: 'nS', sh: 'out:ft', t: 'nAny', th: 'in:0'});
  check(R.anyofType(fl, lib, fl.nodes.find(n => n.id === 'nAny')) === 'text', '«один из» any взял тип первой связи');
  check(!can('nS', 'out:fm', 'nAny', 'in:1').ok && can('nAny', 'out', 'nC1', 'in:a').ok, '«один из» дальше типизирован');

  // Вид связи и её цвет — по сокету-источнику.
  const kinds = [['nC1', 'exec-out'], ['nD', 'val:v1'], ['nS', 'out:fm'], ['nC1', 'v:stop_b']]
    .map(([s, sh]) => R.edgeKind(fl, lib, {s, sh}));
  check(kinds.join(',') === 'exec,cond,data,verdict', 'вид связи определяется выходом', kinds.join(','));
  check(R.edgeColor(fl, lib, {s: 'nC1', sh: 'v:stop_b'}) === '#e0473a' && R.edgeColor(fl, lib, {s: 'nD', sh: 'val:v1'}) === '#7c5cff',
    'цвет вердикта и применимости — константы ТЗ');

  // Готовая схема с циклом (пришла из MCP или старого файла) — валидатор его находит.
  const bad1 = mk(); bad1.edges.push({id: 'x1', s: 'nC1', sh: 'exec-out', t: 'nC2', th: 'exec-in'}, {id: 'x2', s: 'nC2', sh: 'exec-out', t: 'nC1', th: 'exec-in'});
  check(R.controlCycles(bad1, lib).length === 2, 'цикл в документе находится', R.controlCycles(bad1, lib).join(','));

  /* ---------- размеры: одна раскладка для отрисовки и сервера ---------- */
  const nC = fl.nodes.find(n => n.id === 'nC1');
  const sz = R.nodeSize(fl, lib, nC);
  // exec + Когда + 3 входа = 5 строк слева; exec + 2 вердикта = 3 справа
  check(sz.w === 300 && sz.h === 34 + 22 * 5 + 44, 'размер проверки — по строкам сокетов', `${sz.w}×${sz.h}`);
  check(R.nodeSize(fl, lib, Object.assign({}, nC, {collapsed: 1})).h === 34, 'свёрнутая нода — только шапка');
  const hidden = Object.assign({}, nC, {hide: ['in:m', 'in:a', 'in:d']});
  // слева остаются exec, «Когда» и соединённая «Дата»; справа exec и два вердикта
  check(R.nodeSize(fl, lib, hidden).h === 34 + 22 * 3 + 44, 'Ctrl+H прячет только несоединённые сокеты', '«Дата» соединена и осталась');
  const gate = R.nodeSize(fl, lib, fl.nodes.find(n => n.id === 'nG'));
  const outc = R.nodeSize(fl, lib, fl.nodes.find(n => n.id === 'nO'));
  check(gate.h === 110 && outc.h === 80, 'гейт и исход — размеры, которыми размечен seed', `${gate.h}, ${outc.h}`);

  const st = {id: 'S1', k: 'stage', x: 100, y: 100, w: 360, h: 200, fit: 1};
  const fit = R.fitStage({nodes: [st, {id: 'a', k: 'note', parent: 'S1', x: -30, y: 70, w: 100, h: 50}]}, lib, st);
  check(fit.dx === 50 && fit.x === 50 && fit.w >= 240, 'рамка растёт влево, когда ребёнок вылез за край', JSON.stringify(fit));

  /* ---------- M2: библиотека и тексты для таблицы ---------- */
  const seed = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/flow/seed-kyc-rko.json'), 'utf8'));
  seed.flowLib = M.normalizeLib(seed.flowLib);
  seed.pages[0].flow = M.normalizeFlow(seed.pages[0].flow);
  const SF = seed.pages[0].flow, SL = seed.flowLib;
  const nodeOf = code => SF.nodes.find(n => n.ref === 'chk_' + code.replace('.', '_'));
  check(R.condText(SF, SL, nodeOf('3.8').id) === 'кроме: ИП, Свежерег < 180 дней' && R.condText(SF, SL, nodeOf('2.8').id) === 'ЮЛ'
    && R.condText(SF, SL, nodeOf('1.1').id) === 'все', 'применимость текстом — «все» или «ЮЛ; кроме: …»', R.condText(SF, SL, nodeOf('3.8').id));
  check(R.condText(SF, SL, nodeOf('4.5').id) === 'ЮЛ; Единственный участник ≠ ЕИО или Несколько участников-ФЛ',
    'внутри измерения — «или», между измерениями — «;»');
  check(R.sourceText(SF, SL, nodeOf('3.15')) === '🔴 источник не определён', 'вход без связи в колонке «Источник»');
  check(/ЦБ — FinOrg.* → Контур.Фокус.* → ЕГРЮЛ/.test(R.sourceText(SF, SL, nodeOf('3.11'))), '«один из» — через « → » в порядке приоритета',
    R.sourceText(SF, SL, nodeOf('3.11')));
  const pr = R.inputSources(SF, SL, nodeOf('3.11').id, 'in:lic');
  check(pr.length === 3 && pr.map(x => x.priority).join() === '1,2,3', 'источники входа — по приоритету', pr.map(x => x.source).join(' → '));
  const holes = R.checkHoles(SF, SL, nodeOf('3.17'));
  check(holes.noAccess.includes('src_rkn') && R.checkHoles(SF, SL, nodeOf('3.15')).unwired.includes('sanc'), 'дыры проверки: нет доступа и вход без связи');

  const doc = {pages: [{id: 'p1', name: 'РКО', kind: 'flow', flow: JSON.parse(JSON.stringify(SF))},
    {id: 'p2', name: 'Кредит', kind: 'flow', flow: M.normalizeFlow({nodes: [{id: 'x', k: 'check', ref: 'chk_3_11', x: 0, y: 0}], edges: []})}],
    flowLib: JSON.parse(JSON.stringify(SL))};
  const u = M.usages(doc, 'checks', 'chk_3_11');
  check(u.length === 2 && u[0].stage === '3b' && u[1].page === 'p2', 'использование блока — по всем схемам, с этапом', JSON.stringify(u.map(x => x.pageName + ':' + x.stage)));
  check(M.nextCheckCode(doc.flowLib, '3b') === '3.20' && M.nextCheckCode(doc.flowLib, '6') === '6.6' && M.nextCheckCode(doc.flowLib, '') === '',
    'код новой проверки — следующий свободный в этапе', M.nextCheckCode(doc.flowLib, '3b'));
  const nb = M.createBlock(doc.flowLib, 'checks', {name: 'Тест'});
  check(/^chk_/.test(nb.id) && nb.bank.status === 'none' && Array.isArray(nb.inputs), 'новый блок получает id с префиксом и умолчания');
  const vd = M.createBlock(doc.flowLib, 'verdicts', {name: 'Новый'});
  check(/^vd_/.test(vd.key) && /^#[0-9a-f]{6}$/i.test(vd.color) && doc.flowLib.verdicts.filter(v => v.color === vd.color).length === 1,
    'новый вердикт — ключ генерируется, цвет — первый незанятый из палитры', vd.key + ' ' + vd.color);
  const dup = M.duplicateBlock(doc.flowLib, 'sources', 'src_egrul');
  check(dup && dup.id !== 'src_egrul' && / \(копия\)$/.test(dup.name), 'дубликат блока', dup && dup.name);
  // смена типа поля, которое кормит проверки, рвёт связи на всех схемах
  const bad = M.incompatibleAfter(doc, 'source', 'src_egrul', 'out:f_regdate', 'out', it => { it.fields.find(f => f.id === 'f_regdate').type = 'money'; });
  check(bad.length === 1 && doc.flowLib.sources.find(s => s.id === 'src_egrul').fields.find(f => f.id === 'f_regdate').type === 'date',
    'смена типа поля: считаются несовместимые связи, сам тип не меняется до подтверждения', `${bad.length} связь`);
  const sockE = M.socketEdges(doc, 'check', 'chk_3_11', 'in:lic', 'in');
  check(sockE.length === 1, 'связи сокета блока — по всем схемам');
  const del = M.deleteBlock(doc, 'checks', 'chk_3_11');
  // у 3.11 три связи данных (ОКВЭД, лицензии через «один из», самодекларация); вердикт info в исход не ведётся
  check(del.nodes === 2 && del.edges === 3 && !doc.flowLib.checks.some(x => x.id === 'chk_3_11'), 'удаление блока уносит его ноды на всех схемах и их связи',
    JSON.stringify(del));
  check(M.verdictUses(SL, 'stop_b') > 0 && M.verdictUses(SL, 'nope') === 0, 'использование вердикта считается по проверкам и исходам');

  /* ---------- M3: применимость по профилю (§5) ---------- */
  const C = (pos, neg) => ({pos, neg});
  check(R.appliesCond({}, {D: ['a']}), 'без связей «Когда» блок применим всегда');
  check(R.appliesCond({D: C(['a'], [])}, {}) && R.appliesCond({D: C(['a'], [])}, {D: []}), 'пустой выбор по измерению = «любое»');
  check(R.appliesCond({D: C(['a'], [])}, {D: ['a']}) && !R.appliesCond({D: C(['a'], [])}, {D: ['b']}), 'обычная связь: применим только при своём значении');
  check(!R.appliesCond({D: C([], ['a'])}, {D: ['a']}) && R.appliesCond({D: C([], ['a'])}, {D: ['b']}), '«кроме»: гасит своё значение, пропускает остальные');
  check(R.appliesCond({D: C(['a', 'b'], [])}, {D: ['b']}), 'внутри измерения — ИЛИ');
  check(!R.appliesCond({D: C(['a'], []), E: C(['x'], [])}, {D: ['a'], E: ['y']}) && R.appliesCond({D: C(['a'], []), E: C(['x'], [])}, {D: ['a'], E: ['x']}),
    'между измерениями — И');
  check(R.appliesCond({D: C(['a'], [])}, {D: ['b', 'a']}), 'выбрано несколько значений — хватает одного подходящего');
  check(!R.appliesCond({D: C(['a'], ['a'])}, {D: ['a']}), 'значение и «кроме» на одно и то же — не проходит');

  const expectOff = {'P-ИП': '2.8 2.9 2.10 2.11 3.8 3.9 4.2 4.3 4.5 5.3', 'P-ООО-простое': '4.5', 'P-ООО-разделённое': '', 'P-АО (Волна 2)': ''};
  const expectNum = {'P-ИП': [45, 22], 'P-ООО-простое': [54, 24], 'P-ООО-разделённое': [55, 24], 'P-АО (Волна 2)': [55, 24]};
  for (const p of SF.profiles) {
    const a = R.activity(SF, SL, p.sel), st = R.profileStats(SF, SL, p.sel, a);
    const off = SF.nodes.filter(n => n.k === 'check' && !a.nodes.has(n.id)).map(n => SL.checks.find(x => x.id === n.ref).code).sort(R.codeCompare ? (x, y) => x.localeCompare(y, 'ru', {numeric: true}) : undefined);
    const [ch, sr] = expectNum[p.name];
    check(st.checks.on === ch && st.checks.all === 55 && st.sources.on === sr && st.sources.all === 24 && off.join(' ') === expectOff[p.name],
      `контрольные цифры §5: ${p.name} — ${ch}/55, источников ${sr}/24`, `${st.checks.on}/55, ${st.sources.on}/24, погашены: ${off.join(' ') || '—'}`);
  }
  const ip = SF.profiles.find(p => p.name === 'P-ИП').sel;
  const stIP = R.profileStats(SF, SL, ip);
  check(stIP.outcomes.on === 8 && stIP.outcomes.all === 8 && stIP.holes.length === 2, 'P-ИП: исходов 8/8, входов без источника 2',
    stIP.holes.map(h => h.code + '.' + h.input).join(', '));
  const all = R.activity(SF, SL, {});
  check(all.nodes.size === SF.nodes.length && all.edges.size === SF.edges.length, 'без профиля активно всё');
  // выключенная проверка и выключенный этап
  const fm = JSON.parse(JSON.stringify(SF));
  fm.nodes.find(n => n.ref === 'chk_2_6').muted = 1;
  fm.nodes.find(n => n.id === 'n_st_s5').muted = 1;
  const am = R.activity(fm, SL, {});
  const kidsS5 = fm.nodes.filter(n => n.parent === 'n_st_s5');
  check(!am.nodes.has(fm.nodes.find(n => n.ref === 'chk_2_6').id) && kidsS5.length > 0 && kidsS5.every(n => !am.nodes.has(n.id)),
    'выключенная нода (M) вне активных; выключенный этап гасит свои проверки', `в этапе 5: ${kidsS5.length}`);
  // связь применимости через reroute и на источнике
  const fr = M.normalizeFlow({nodes: [{id: 'd', k: 'dim', ref: 'dim_ctype'}, {id: 'r', k: 'reroute'},
    {id: 'c', k: 'check', ref: 'chk_2_6'}, {id: 's', k: 'source', ref: 'src_egrul'}],
    edges: [{id: 'e1', s: 'd', sh: 'val:v_ul', t: 'r', th: 'in'}, {id: 'e2', s: 'r', sh: 'out', t: 'c', th: 'cond-in', neg: 1},
      {id: 'e3', s: 's', sh: 'out:f_regdate', t: 'c', th: 'in:reg'}, {id: 'e4', s: 'd', sh: 'val:v_ip', t: 's', th: 'cond-in'}]});
  const ar1 = R.activity(fr, SL, {dim_ctype: ['v_ul']}), ar2 = R.activity(fr, SL, {dim_ctype: ['v_ip']});
  check(!ar1.nodes.has('c') && !ar1.edges.has('e2') && ar2.nodes.has('c') && ar2.nodes.has('r'), '«кроме» через точку перегиба работает так же');
  check(ar2.nodes.has('s') && !ar1.nodes.has('s'), 'источник с «Когда» активен только при своём значении и при активной проверке');

  const fail = results.filter(r => r[0] === '✗');
  console.log(`\n===== ${results.length - fail.length}/${results.length} пройдено =====`);
  process.exit(fail.length ? 1 : 0);
})().catch(e => { console.log('✗ ПРОГОН УПАЛ', e && e.stack || e); process.exit(1); });
