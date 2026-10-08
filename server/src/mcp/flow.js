// Конструктор KYC Flow для Claude (ТЗ §12): библиотека блоков доски (doc.flowLib)
// и схемы страниц kind=flow (page.flow).
//
// Правил здесь НЕТ. Совместимость сокетов, применимость, раскладка, контракт
// kycflow/1 и сами операции над схемой живут в flow-rules.js — байтовой копии
// src/flow/rules.js. Модуль только разбирает аргументы, проверяет их и переводит
// ответ на язык модели. Поэтому человек и Claude получают на один вопрос один
// ответ: «date → money: типы не совпадают» — та же строка, что у курсора.
//
// Как и doc.js, модуль не пересобирает объекты целиком: меняет только
// перечисленные поля, незнакомые переживают правку.
import * as R from './flow-rules.js';
import { fail, keyFrom } from './doc.js';

const SEC_KIND = { dims: 'dim', sources: 'source', checks: 'check', outcomes: 'outcome' };
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const arr = v => (Array.isArray(v) ? v : []);
const str = v => (v == null ? '' : String(v));
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const keyOf = sec => (sec === 'verdicts' ? 'key' : 'id');
const plural = (n, one, few, many) => {
  const a = Math.abs(n) % 100, b = a % 10;
  return n + ' ' + (a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many);
};

// Читаемый id: «Сайт в реестре» → in:sayt_v_reestre. Модель соединяет сокеты
// по именам вида «нода.сокет», и случайные id превращали бы это в угадайку.
function readable(prefix, name, taken) {
  const base = prefix + keyFrom(name, []);
  let id = base, i = 2;
  while (taken.has(id)) id = base + '_' + i++;
  taken.add(id);
  return id;
}

/* ---------- страница и библиотека ---------- */

const flowPages = doc => (doc.pages || []).filter(p => p && p.kind === 'flow');

export function flowPage(doc, ref) {
  const s = str(ref).trim();
  const pages = doc.pages || [];
  const p = pages.find(x => x.id === s) || pages.find(x => str(x.name).toLowerCase() === s.toLowerCase());
  const list = () => flowPages(doc).map(x => `${x.name} (${x.id})`).join(', ') || 'на доске их нет — add_page с kind=flow';
  if (!p) fail(`страницы «${s}» нет. Конструкторы: ${list()}`);
  if (p.kind !== 'flow') fail(`страница «${p.name}» — ${p.kind}, а не конструктор. Конструкторы: ${list()}`);
  // Досыпаем только то, без чего код упал бы на чтении (как normalizeFlow приложения).
  if (!isObj(p.flow)) p.flow = R.defaultFlow();
  for (const k of ['nodes', 'edges', 'profiles']) if (!Array.isArray(p.flow[k])) p.flow[k] = [];
  return p;
}

// Библиотека для чтения: отсутствующая читается как пустая, без вердиктов —
// со стандартными (так её показывает и приложение). Документ не трогается.
export function libView(doc) {
  const L = isObj(doc.flowLib) ? doc.flowLib : {};
  return Object.assign({ v: 1 }, L, {
    dims: arr(L.dims), sources: arr(L.sources), checks: arr(L.checks), outcomes: arr(L.outcomes),
    verdicts: arr(L.verdicts).length ? L.verdicts : R.DEFAULT_VERDICTS.map(v => ({ ...v })),
  });
}
// Библиотека для правки: появляется в документе, если её не было.
function libEdit(doc) {
  if (!isObj(doc.flowLib)) doc.flowLib = R.defaultLib();
  const L = doc.flowLib;
  if (!L.v) L.v = 1;
  for (const k of ['dims', 'sources', 'checks', 'outcomes']) if (!Array.isArray(L[k])) L[k] = [];
  if (!arr(L.verdicts).length) L.verdicts = R.DEFAULT_VERDICTS.map(v => ({ ...v }));
  return L;
}
function section(sec) {
  if (!R.LIB_SECTIONS.includes(sec)) fail(`раздела библиотеки «${sec}» нет. Есть: ${R.LIB_SECTIONS.join(', ')}`);
  return sec;
}

// Где стоит блок: страница и нода.
function usages(doc, sec, id) {
  const k = SEC_KIND[sec], out = [];
  for (const pg of flowPages(doc)) {
    for (const n of arr(pg.flow && pg.flow.nodes)) if (n.k === k && n.ref === id) out.push({ page: pg.id, page_name: pg.name, node: n.id });
  }
  return out;
}

/* ---------- как нода и сокеты выглядят для модели ---------- */

export function labelOf(L, n) {
  const it = R.itemOf(L, n), d = n.data || {};
  switch (n.k) {
    case 'check': return it ? `${it.code ? it.code + ' ' : ''}${it.name}` : `? ${n.ref}`;
    case 'dim': case 'source': case 'outcome': return it ? it.name : `? ${n.ref}`;
    case 'stage': return `${d.num ? d.num + '. ' : ''}${d.name || 'этап'}`;
    case 'gate': return d.text || 'гейт';
    case 'anyof': return d.label || 'один из';
    case 'calc': return d.name || 'показатель';
    case 'note': return str(d.text).split('\n')[0].slice(0, 60) || 'заметка';
    default: return n.k;
  }
}
function socketsBrief(f, L, n) {
  const one = x => {
    const o = { h: x.id, kind: x.kind };
    if (x.type && x.kind === 'data') o.type = x.type;
    if (x.name) o.name = x.name;
    return o;
  };
  const s = R.socketsOf(f, L, n);
  return { in: s.ins.map(one), out: s.outs.map(one) };
}
const end = (id, h) => id + '.' + h;

/* ---------- библиотека ---------- */

export function libRead(doc, sec, ids) {
  const L = libView(doc);
  const want = Array.isArray(ids) && ids.length ? ids.map(str) : null;
  const pick = s => (want ? L[s].filter(x => want.includes(x[keyOf(s)])) : L[s]);
  const counts = Object.fromEntries(R.LIB_SECTIONS.map(s => [s, L[s].length]));
  if (sec) {
    section(sec);
    const items = pick(sec);
    const missing = want ? want.filter(id => !items.some(x => x[keyOf(sec)] === id)) : [];
    return { section: sec, count: items.length, items, ...(missing.length ? { missing } : {}) };
  }
  const out = { counts };
  for (const s of R.LIB_SECTIONS) out[s] = pick(s);
  return out;
}

const T = {
  text: v => str(v),
  num: (v, at) => { const n = +v; if (v === '' || v == null || !isFinite(n)) fail(`${at}: ждём число, пришло «${v}»`); return n; },
  flag: v => (v ? 1 : 0),
  list: (v, at) => { if (!Array.isArray(v)) fail(`${at}: ждём массив строк`); return v.map(str); },
  color: (v, at) => { const s = str(v); if (!/^#[0-9a-f]{6}$/i.test(s)) fail(`${at}: цвет в виде #rrggbb, пришло «${s}»`); return s; },
  oneOf: list => (v, at) => {
    const k = str(v);
    const hit = list.find(x => x[0] === k) || list.find(x => x[1].toLowerCase() === k.toLowerCase());
    if (!hit) fail(`${at}: «${k}» нет. Можно: ${list.map(x => `${x[0]} (${x[1]})`).join(', ')}`);
    return hit[0];
  },
};
const typeKey = (v, at) => {
  const k = str(v);
  const hit = R.TYPES.find(t => t.key === k) || R.TYPES.find(t => t.name.toLowerCase() === k.toLowerCase());
  if (!hit) fail(`${at}: типа «${k}» нет. Можно: ${R.TYPES.map(t => `${t.key} (${t.name})`).join(', ')}`);
  return hit.key;
};
const verdictKey = (L, v, at) => {
  const k = str(v);
  const hit = L.verdicts.find(x => x.key === k) || L.verdicts.find(x => str(x.name).toLowerCase() === k.toLowerCase());
  if (!hit) fail(`${at}: вердикта «${k}» нет. Есть: ${L.verdicts.map(x => `${x.key} (${x.name})`).join(', ')}. Новый — flow_lib_upsert с section=verdicts`);
  return hit.key;
};

// Вложенный список (значения измерения, поля источника, входы проверки) приходит
// целиком. Элемент с известным id правится по месту — связи к его сокету живут
// дальше; без id — создаётся; пропавший из списка — удаляется вместе со связями.
function mergeList(cur, next, at, prefix, each) {
  if (!Array.isArray(next)) fail(`${at}: ждём массив`);
  const byId = new Map(arr(cur).map(x => [x.id, x]));
  const taken = new Set(next.filter(x => isObj(x) && x.id != null && x.id !== '').map(x => str(x.id)));
  if (taken.size !== next.filter(x => isObj(x) && x.id != null && x.id !== '').length) fail(`${at}: id повторяется`);
  return next.map((raw, i) => {
    const a = `${at}[${i}]`;
    if (!isObj(raw)) fail(`${a}: ждём объект`);
    const id = raw.id != null && raw.id !== '' ? str(raw.id) : null;
    if (id && !ID_RE.test(id)) fail(`${a}: id «${id}» — только латиница, цифры, _ и -`);
    let o = id ? byId.get(id) : null;
    if (!o) {
      if (!str(raw.name).trim()) fail(`${a}: у нового элемента нужно name`);
      o = { id: id || readable(prefix, raw.name, taken) };
    }
    each(o, raw, a);
    return o;
  });
}

const FIELDS = {
  dims: { code: T.text, name: T.text, desc: T.text, values: 'values' },
  sources: { name: T.text, kind: T.oneOf(R.SOURCE_KINDS), access: T.oneOf(R.SOURCE_ACCESS), mode: T.oneOf(R.SOURCE_MODES),
    status: T.oneOf(R.SOURCE_STATUSES), providers: T.text, url: T.text, cost: T.text, note: T.text, fields: 'fields' },
  checks: { code: T.text, name: T.text, how: T.text, why: T.text, rule: T.text, norm: T.text, factors: T.list,
    inputs: 'inputs', verdicts: 'verdicts', verdictTbd: T.flag, bank: 'bank', wave: T.num, actor: T.oneOf(R.ACTORS),
    note: T.text, comment: T.text, srcText: T.text, tags: T.list },
  outcomes: { verdict: 'verdict', name: T.text, desc: T.text },
  verdicts: { name: T.text, color: T.color },
};

function applyBlock(L, sec, it, raw, at, warnings) {
  const spec = FIELDS[sec];
  for (const [k, v] of Object.entries(raw)) {
    if (k === keyOf(sec)) continue;
    const f = spec[k], a = `${at}.${k}`;
    if (!f) { warnings.push(`${at}: поля «${k}» в разделе ${sec} нет — пропущено. Есть: ${Object.keys(spec).join(', ')}`); continue; }
    if (typeof f === 'function') it[k] = f(v, a);
    else if (f === 'values') {
      it.values = mergeList(it.values, v, a, 'v_', (o, r, b) => {
        for (const x of ['code', 'name', 'desc']) if (has(r, x)) o[x] = str(r[x]);
        if (has(r, 'wave')) o.wave = T.num(r.wave, b + '.wave');
        for (const x of ['code', 'desc']) if (o[x] === undefined) o[x] = '';
        if (o.wave === undefined) o.wave = 1;
      });
    } else if (f === 'fields' || f === 'inputs') {
      it[k] = mergeList(it[k], v, a, f === 'fields' ? 'f_' : '', (o, r, b) => {
        if (has(r, 'name')) o.name = str(r.name);
        if (has(r, 'type') || !o.type) o.type = typeKey(has(r, 'type') ? r.type : 'any', b + '.type');
        if (f === 'fields') { if (has(r, 'desc')) o.desc = str(r.desc); else if (o.desc === undefined) o.desc = ''; }
      });
    } else if (f === 'verdicts') {
      if (!Array.isArray(v)) fail(`${a}: ждём массив ключей вердиктов`);
      it.verdicts = [...new Set(v.map((x, i) => verdictKey(L, x, `${a}[${i}]`)))];
    } else if (f === 'verdict') it.verdict = verdictKey(L, v, a);
    else if (f === 'bank') {
      if (!isObj(v)) fail(`${a}: ждём {status, comment}`);
      if (!isObj(it.bank)) it.bank = { status: 'none', comment: '' };
      if (has(v, 'status')) it.bank.status = T.oneOf(R.BANK_STATUSES)(v.status, a + '.status');
      if (has(v, 'comment')) it.bank.comment = str(v.comment);
    }
  }
}

// Связи, которые после правки блока смотрят в пропавший сокет или стали
// несовместимы по типу. Удаляются в той же правке — как в инспекторе.
function sweepEdges(doc, L, sec, ids) {
  const k = SEC_KIND[sec];
  if (!k || !ids.length) return [];
  const set = new Set(ids), dropped = [];
  const sig = e => [e.s, e.sh, e.t, e.th].join('\u0000');
  for (const pg of flowPages(doc)) {
    const f = pg.flow;
    if (!f || !Array.isArray(f.edges) || !Array.isArray(f.nodes)) continue;
    const hit = new Set(f.nodes.filter(n => n.k === k && set.has(n.ref)).map(n => n.id));
    if (!hit.size) continue;
    const bad = new Set();
    for (const e of f.edges) {
      if (!hit.has(e.s) && !hit.has(e.t)) continue;
      let why = null;
      if (!R.socketOf(f, L, e.s, e.sh, 'out') || !R.socketOf(f, L, e.t, e.th, 'in')) why = 'сокета больше нет';
      else {
        const rest = { nodes: f.nodes, edges: f.edges.filter(x => sig(x) !== sig(e)) };
        const r = R.canConnect(rest, L, { source: e.s, sourceHandle: e.sh, target: e.t, targetHandle: e.th });
        if (!r.ok && !/цикл/.test(r.reason)) why = r.reason;
      }
      if (why) { bad.add(e); dropped.push({ page: pg.id, edge: e.id, from: end(e.s, e.sh), to: end(e.t, e.th), reason: why }); }
    }
    if (bad.size) f.edges = f.edges.filter(e => !bad.has(e));
  }
  return dropped;
}

export function libUpsert(doc, sec, items) {
  section(sec);
  if (!Array.isArray(items) || !items.length) fail('items: пустой список');
  const L = libEdit(doc), key = keyOf(sec);
  const created = [], updated = [], warnings = [];
  const taken = new Set(L[sec].map(x => x[key]));
  items.forEach((raw, i) => {
    const at = `items[${i}]`;
    if (!isObj(raw)) fail(`${at}: ждём объект`);
    const id = raw[key] != null && raw[key] !== '' ? str(raw[key]) : null;
    let it = id ? L[sec].find(x => x[key] === id) : null;
    if (it) {
      applyBlock(L, sec, it, raw, at, warnings);
      updated.push(id);
      return;
    }
    if (id && !ID_RE.test(id)) fail(`${at}: ${key} «${id}» — только латиница, цифры, _ и -`);
    if (!str(raw.name).trim()) fail(`${at}: у нового блока нужно name${id ? ` (блока ${key}=${id} в разделе ${sec} нет — создаётся новый)` : ''}`);
    // Заготовка — та же, что у меню «Создать» в приложении (rules.blankBlock).
    const mk = prefix => {
      if (id && prefix !== 'v_') { taken.add(id); return id; }
      if (prefix === 'chk_' && str(raw.code).trim()) return readable('chk_', str(raw.code).replace(/[^0-9A-Za-z]+/g, '_'), taken);
      return readable(prefix, prefix === 'v_' ? 'значение 1' : raw.name, taken);
    };
    it = R.blankBlock(L, sec, mk, {});
    applyBlock(L, sec, it, raw, at, warnings);
    L[sec].push(it);
    created.push(it[key]);
  });
  const dropped = sweepEdges(doc, L, sec, updated);
  return { section: sec, created, updated, ...(dropped.length ? { dropped_edges: dropped } : {}), ...(warnings.length ? { warnings } : {}) };
}

export function libDelete(doc, sec, ids, force) {
  section(sec);
  if (!Array.isArray(ids) || !ids.length) fail('ids: пустой список');
  if (!isObj(doc.flowLib)) fail('библиотеки на этой доске нет — удалять нечего');
  const L = libEdit(doc), key = keyOf(sec);
  const want = [...new Set(ids.map(str))];
  const missing = want.filter(id => !L[sec].some(x => x[key] === id));
  if (missing.length) fail(`в разделе ${sec} нет: ${missing.join(', ')}. Посмотреть, что есть, — flow_lib_read`);

  if (sec === 'verdicts') {
    if (want.length >= L.verdicts.length) fail('все вердикты удалить нельзя — проверке нужен хотя бы один вид последствия');
    const uses = want.map(k => ({ key: k,
      checks: L.checks.filter(c => arr(c.verdicts).includes(k)).map(c => c.code || c.id),
      outcomes: L.outcomes.filter(o => o.verdict === k).map(o => o.name || o.id) })).filter(u => u.checks.length || u.outcomes.length);
    if (uses.length && !force) {
      fail('вердикты используются: ' + uses.map(u => `${u.key} — ${[u.checks.length ? 'проверки ' + u.checks.join(', ') : '', u.outcomes.length ? 'исходы ' + u.outcomes.join(', ') : ''].filter(Boolean).join('; ')}`).join(' | ')
        + '. С force=true вердикт снимется с проверок (вместе со связями из его сокета), а исходы перейдут на первый оставшийся вердикт');
    }
    const del = new Set(want), rest = L.verdicts.filter(v => !del.has(v.key));
    const touched = [];
    for (const c of L.checks) if (arr(c.verdicts).some(k => del.has(k))) { c.verdicts = c.verdicts.filter(k => !del.has(k)); touched.push(c.id); }
    for (const o of L.outcomes) if (del.has(o.verdict)) o.verdict = rest[0].key;
    L.verdicts = rest;
    const dropped = sweepEdges(doc, L, 'checks', touched);
    return { section: sec, deleted: want, edges: dropped.length };
  }

  const used = want.map(id => ({ id, on: usages(doc, sec, id) })).filter(u => u.on.length);
  if (used.length && !force) {
    fail('блоки стоят на схемах: ' + used.map(u => `${u.id} — ${u.on.map(x => `«${x.page_name}» (нода ${x.node})`).join(', ')}`).join('; ')
      + '. Удалить вместе с нодами и их связями — повторите с force=true');
  }
  let nodes = 0, edges = 0;
  const k = SEC_KIND[sec], del = new Set(want);
  for (const pg of flowPages(doc)) {
    const f = pg.flow;
    if (!f || !Array.isArray(f.nodes)) continue;
    const nids = f.nodes.filter(n => n.k === k && del.has(n.ref)).map(n => n.id);
    if (!nids.length) continue;
    const r = R.deleteNodes(f, nids);
    nodes += r.nodes; edges += r.edges;
  }
  L[sec] = L[sec].filter(x => !del.has(x[key]));
  return { section: sec, deleted: want, nodes, edges };
}

/* ---------- схема ---------- */

export function flowRead(doc, pg, detail) {
  if (detail != null && detail !== 'summary' && detail !== 'full') fail(`detail: «${detail}» нет. Можно: summary, full`);
  const f = pg.flow, L = libView(doc);
  const N = new Map(f.nodes.map(n => [n.id, n]));
  const by = {};
  for (const n of f.nodes) by[n.k] = (by[n.k] || 0) + 1;
  const codes = list => list.map(n => R.itemOf(L, n)).filter(Boolean).sort(R.codeCompare).map(it => it.code || it.name);
  const { stages, gateBefore } = R.stageOrder(f);
  const out = {
    page: { id: pg.id, name: pg.name },
    nodes: f.nodes.length, edges: f.edges.length, by_kind: by,
    stages: stages.map(id => {
      const s = N.get(id), d = s.data || {};
      const o = { id, num: d.num || '', name: d.name || '', checks: codes(f.nodes.filter(n => n.parent === id && n.k === 'check')) };
      if (d.point) o.point = d.point;
      const g = (gateBefore.get(id) || []).map(gid => (N.get(gid).data || {}).text || gid);
      if (g.length) o.gate_before = g;
      return o;
    }),
    profiles: f.profiles.map(p => ({ id: p.id, name: p.name })),
  };
  const loose = f.nodes.filter(n => n.k === 'check' && !(n.parent && N.get(n.parent)));
  if (loose.length) out.checks_outside_stages = codes(loose);
  const issues = R.validateFlow({ flowLib: L }, pg);
  if (issues.length) out.issues = issues.map(i => ({ level: i.level, code: i.code, message: i.msg, ...(i.node ? { node: i.node } : {}) }));
  if (detail === 'full') {
    out.nodes_list = f.nodes.map(n => nodeBrief(f, L, n));
    out.edges_list = f.edges.map(e => {
      const o = { id: e.id, from: end(e.s, e.sh), to: end(e.t, e.th), kind: R.edgeKind(f, L, e) };
      if (e.neg) o.neg = 1;
      return o;
    });
  }
  return out;
}
function nodeBrief(f, L, n) {
  const o = { id: n.id, k: n.k };
  if (n.ref) o.ref = n.ref;
  o.label = labelOf(L, n);
  o.x = n.x; o.y = n.y;
  if (n.parent) o.parent = n.parent;
  if (n.k === 'stage' || n.k === 'note') { o.w = n.w; o.h = n.h; }
  if (n.k === 'stage') o.fit = !!n.fit;
  if (n.collapsed) o.collapsed = 1;
  if (n.muted) o.muted = 1;
  if (!R.LIB_KINDS[n.k] && n.data && Object.keys(n.data).length) o.data = n.data;
  o.sockets = socketsBrief(f, L, n);
  return o;
}

// Данные нод, которых нет в библиотеке. Заготовки — те же, что у меню «Добавить».
const DEFAULTS = {
  stage: () => ({ w: 360, h: 200, fit: 1, data: { num: '', name: 'Новый этап', point: '' } }),
  gate: () => ({ data: { text: 'Условие перехода' } }),
  anyof: () => ({ data: { type: 'any', label: 'Один из (по порядку)', n: 2 } }),
  calc: () => ({ data: { name: 'Показатель', formula: '', inputs: [{ id: 'a', name: 'Вход', type: 'number' }], type: 'number' } }),
  note: () => ({ w: 240, h: 120, data: { text: '' } }),
};
const DATA = {
  stage: { num: T.text, name: T.text, point: T.text },
  gate: { text: T.text },
  anyof: { label: T.text, type: (v, a) => (str(v) === 'any' ? 'any' : typeKey(v, a)),
    n: (v, a) => { const n = Math.round(T.num(v, a)); if (n < 1 || n > 12) fail(`${a}: от 1 до 12`); return n; } },
  calc: { name: T.text, formula: T.text, type: typeKey, inputs: 'inputs' },
  note: { text: T.text },
};
function applyData(n, raw, at, warnings) {
  if (raw == null) return;
  if (!isObj(raw)) fail(`${at}: ждём объект`);
  const spec = DATA[n.k];
  if (!spec) {
    fail(`${at}: у ноды вида ${n.k} нет своих данных` + (R.LIB_KINDS[n.k] ? ' — её содержимое правится в библиотеке: flow_lib_upsert' : ''));
  }
  n.data = isObj(n.data) ? n.data : {};
  for (const [k, v] of Object.entries(raw)) {
    const f = spec[k], a = `${at}.${k}`;
    if (!f) { warnings.push(`${at}: поля «${k}» у ${n.k} нет — пропущено. Есть: ${Object.keys(spec).join(', ')}`); continue; }
    if (v === null) { delete n.data[k]; continue; }
    if (f === 'inputs') {
      n.data.inputs = mergeList(n.data.inputs, v, a, '', (o, r, b) => {
        if (has(r, 'name')) o.name = str(r.name);
        if (has(r, 'type') || !o.type) o.type = typeKey(has(r, 'type') ? r.type : 'number', b + '.type');
      });
    } else n.data[k] = f(v, a);
  }
}
function applySize(n, raw, at) {
  for (const k of ['w', 'h']) {
    if (!has(raw, k)) continue;
    if (n.k !== 'stage' && n.k !== 'note') fail(`${at}.${k}: размер задаётся только у рамки этапа и заметки — остальные ноды меряются по содержимому`);
    const v = Math.round(T.num(raw[k], `${at}.${k}`));
    if (v < 40 || v > 20000) fail(`${at}.${k}: от 40 до 20000`);
    n[k] = v;
    if (n.k === 'stage') n.fit = 0;   // рамку растянули руками — подгонка выключается, как в приложении
  }
  if (has(raw, 'fit')) {
    if (n.k !== 'stage') fail(`${at}.fit: подгонка бывает только у рамки этапа`);
    n.fit = raw.fit ? 1 : 0;
  }
}
function applyFlags(n, raw) {
  for (const k of ['collapsed', 'muted']) {
    if (!has(raw, k)) continue;
    if (raw[k]) n[k] = 1; else delete n[k];
  }
}
function stageFor(f, id, n, at) {
  const p = f.nodes.find(x => x.id === id);
  if (!p) fail(`${at}.parent: ноды «${id}» на схеме нет`);
  if (p.k !== 'stage') fail(`${at}.parent: «${id}» — ${p.k}, а родителем бывает только рамка этапа (stage)`);
  if (!R.NESTABLE.has(n.k)) fail(`${at}.parent: в рамку кладутся ${[...R.NESTABLE].join(', ')} — ${n.k} живёт вне этапов`);
  if (p.id === n.id) fail(`${at}.parent: нода не может быть родителем самой себе`);
  return p;
}

export function flowAdd(doc, pg, list) {
  if (!Array.isArray(list) || !list.length) fail('nodes: пустой список');
  const f = pg.flow, L = libView(doc);
  const taken = new Set(f.nodes.map(n => n.id));
  const sz = n => R.nodeSize(f, L, n);
  const made = [], warnings = [], parents = new Set();
  // Куда ставить ноды без координат: столбцом справа от всей схемы. Ребёнок
  // рамки без координат встаёт в её столбец под последней нодой.
  let right = 0, top = Infinity;
  for (const n of f.nodes) {
    if (n.parent) continue;
    right = Math.max(right, (+n.x || 0) + sz(n).w);
    top = Math.min(top, +n.y || 0);
  }
  let col = { x: f.nodes.length ? Math.round(right + 120) : 0, y: isFinite(top) ? top : 0 };
  list.forEach((raw, i) => {
    const at = `nodes[${i}]`;
    if (!isObj(raw)) fail(`${at}: ждём объект`);
    const k = str(raw.k || raw.kind);
    if (!R.NODE_KINDS.includes(k)) fail(`${at}.k: вида «${k}» нет. Есть: ${R.NODE_KINDS.map(x => `${x} (${R.KIND_NAMES[x]})`).join(', ')}`);
    const n = { id: '', k };
    if (R.LIB_KINDS[k]) {
      const sec = R.LIB_KINDS[k], ref = str(raw.ref);
      const it = L[sec].find(x => x.id === ref);
      if (!it) fail(`${at}.ref: в библиотеке (${sec}) нет «${ref}». Посмотреть — flow_lib_read, создать — flow_lib_upsert`);
      const twin = k === 'check' && f.nodes.find(x => x.k === 'check' && x.ref === ref);
      if (twin) fail(`${at}: проверка «${labelOf(L, twin)}» уже стоит на этой схеме (нода ${twin.id}) — проверка ставится на страницу один раз`);
      n.ref = ref;
    } else if (raw.ref != null && raw.ref !== '') fail(`${at}.ref: нода вида ${k} не из библиотеки, ref ей не нужен`);
    if (raw.id != null && raw.id !== '') {
      const id = str(raw.id);
      if (!ID_RE.test(id)) fail(`${at}.id: «${id}» — только латиница, цифры, _ и -`);
      if (taken.has(id)) fail(`${at}.id: «${id}» на этой схеме уже занят`);
      n.id = id; taken.add(id);
    } else n.id = readable('n_', n.ref || k, taken);
    Object.assign(n, DEFAULTS[k] ? DEFAULTS[k]() : {});
    applyData(n, raw.data, `${at}.data`, warnings);
    applySize(n, raw, at);
    applyFlags(n, raw);
    if (raw.parent != null && raw.parent !== '') {
      const p = stageFor(f, str(raw.parent), n, at);
      n.parent = p.id; parents.add(p.id);
    }
    const hasXY = raw.x != null && raw.y != null;
    if (hasXY) { n.x = Math.round(T.num(raw.x, `${at}.x`)); n.y = Math.round(T.num(raw.y, `${at}.y`)); }
    else if (n.parent) {
      const { PAD, PADT, GAP } = R.SIZE.STAGE;
      let y = PADT;
      for (const c of f.nodes) if (c.parent === n.parent) y = Math.max(y, (+c.y || 0) + sz(c).h + GAP);
      n.x = PAD; n.y = Math.round(y);
    } else { n.x = col.x; n.y = Math.round(col.y); col.y += sz(n).h + 40; }
    f.nodes.push(n);
    made.push(n);
  });
  if (made.some(n => n.k === 'stage')) R.orderStages(f);
  R.refit(f, L, [...parents], sz);
  return { added: made.map(n => nodeBrief(f, L, n)), ...(warnings.length ? { warnings } : {}) };
}

export function flowUpdate(doc, pg, list) {
  if (!Array.isArray(list) || !list.length) fail('nodes: пустой список');
  const f = pg.flow, L = libView(doc);
  const sz = n => R.nodeSize(f, L, n);
  const updated = [], warnings = [], parents = new Set();
  list.forEach((raw, i) => {
    const at = `nodes[${i}]`;
    if (!isObj(raw)) fail(`${at}: ждём объект`);
    const n = f.nodes.find(x => x.id === str(raw.id));
    if (!n) fail(`${at}.id: ноды «${str(raw.id)}» на схеме нет. Список — flow_read с detail=full`);
    if (n.parent) parents.add(n.parent);
    if (has(raw, 'parent')) {
      // Смена рамки без координат сохраняет место ноды на экране.
      const abs = R.absPos(f, n);
      if (raw.parent == null || raw.parent === '') { delete n.parent; n.x = Math.round(abs.x); n.y = Math.round(abs.y); }
      else {
        const p = stageFor(f, str(raw.parent), n, at);
        n.parent = p.id; n.x = Math.round(abs.x - (+p.x || 0)); n.y = Math.round(abs.y - (+p.y || 0));
        parents.add(p.id);
      }
    }
    if (has(raw, 'x')) n.x = Math.round(T.num(raw.x, `${at}.x`));
    if (has(raw, 'y')) n.y = Math.round(T.num(raw.y, `${at}.y`));
    applyData(n, raw.data, `${at}.data`, warnings);
    applySize(n, raw, at);
    applyFlags(n, raw);
    if (n.k === 'stage') parents.add(n.id);
    updated.push(n.id);
  });
  R.refit(f, L, [...parents], sz);
  return { updated, ...(warnings.length ? { warnings } : {}) };
}

export function flowDelete(doc, pg, ids) {
  if (!Array.isArray(ids) || !ids.length) fail('ids: пустой список');
  const f = pg.flow, L = libView(doc);
  const want = [...new Set(ids.map(str))];
  const here = want.filter(id => f.nodes.some(n => n.id === id));
  const missing = want.filter(id => !here.includes(id));
  if (!here.length) return { removed: 0, edges: 0, missing };
  const parents = f.nodes.filter(n => here.includes(n.id) && n.parent && !here.includes(n.parent)).map(n => n.parent);
  const r = R.deleteNodes(f, here);
  R.refit(f, L, parents, n => R.nodeSize(f, L, n));
  return { removed: r.nodes, edges: r.edges, ...(missing.length ? { missing } : {}) };
}

// «нода.сокет». Id ноды может содержать точку — берём самое длинное совпадение.
// Сокет можно писать без префикса: «n_src_egrul.f_inn» = «n_src_egrul.out:f_inn»,
// «n_chk_1_1.ok» = «n_chk_1_1.v:ok», «exec» и «cond» — порядок и применимость.
function endpoint(f, L, raw, side, at) {
  const v = str(raw).trim();
  let node = null;
  for (const n of f.nodes) if (v.startsWith(n.id + '.') && (!node || n.id.length > node.id.length)) node = n;
  if (!node) return { err: `${at}: «${v}» — ждём «нода.сокет»; ноды «${v.split('.')[0]}» на схеме нет` };
  const h = v.slice(node.id.length + 1);
  const socks = R.socketsOf(f, L, node)[side === 'out' ? 'outs' : 'ins'];
  const hit = socks.find(x => x.id === h)
    || socks.find(x => x.id.replace(/^(out|in|val|v):/, '') === h)
    || (h === 'exec' && socks.find(x => x.id === (side === 'out' ? 'exec-out' : 'exec-in')))
    || (h === 'cond' && socks.find(x => x.id === 'cond-in'));
  if (!hit) {
    return { err: `${at}: у «${labelOf(L, node)}» (${node.id}) нет ${side === 'out' ? 'выхода' : 'входа'} «${h}». `
      + `${side === 'out' ? 'Выходы' : 'Входы'}: ${socks.map(x => x.id + (x.type && x.kind === 'data' ? ` (${x.type})` : '')).join(', ') || 'нет'}` };
  }
  return { node, handle: hit.id };
}

export function flowConnect(doc, pg, list) {
  if (!Array.isArray(list) || !list.length) fail('edges: пустой список');
  const f = pg.flow, L = libView(doc);
  const taken = new Set(f.edges.map(e => e.id));
  const added = [], skipped = [];
  list.forEach((raw, i) => {
    const at = `edges[${i}]`;
    if (!isObj(raw)) { skipped.push({ reason: `${at}: ждём {from, to}` }); return; }
    const a = endpoint(f, L, raw.from, 'out', at + '.from'), b = endpoint(f, L, raw.to, 'in', at + '.to');
    const pair = { from: str(raw.from), to: str(raw.to) };
    if (a.err || b.err) { skipped.push({ ...pair, reason: a.err || b.err }); return; }
    const c = { source: a.node.id, sourceHandle: a.handle, target: b.node.id, targetHandle: b.handle };
    if (raw.neg) {
      const s = R.socketOf(f, L, c.source, c.sourceHandle, 'out');
      if (!s || s.kind !== 'cond') { skipped.push({ ...pair, reason: 'neg («кроме») бывает только у связи применимости: значение измерения → «Когда»' }); return; }
    }
    let id = 'e' + (f.edges.length + 1);
    for (let k = 2; taken.has(id); k++) id = 'e' + (f.edges.length + k);
    const r = R.addEdge(f, L, c, id, raw.neg ? { neg: 1 } : null);
    if (!r.ok) {
      const twin = f.edges.find(e => e.s === c.source && e.sh === c.sourceHandle && e.t === c.target && e.th === c.targetHandle);
      skipped.push({ ...pair, reason: r.reason, ...(twin ? { id: twin.id } : {}) });
      return;
    }
    taken.add(id);
    added.push({ id, from: end(c.source, c.sourceHandle), to: end(c.target, c.targetHandle), kind: R.edgeKind(f, L, r.edge),
      ...(raw.neg ? { neg: 1 } : {}), ...(r.replaced.length ? { replaced: r.replaced } : {}) });
  });
  return { added, skipped };
}

export function flowDisconnect(doc, pg, ids) {
  if (!Array.isArray(ids) || !ids.length) fail('ids: пустой список');
  const f = pg.flow;
  const want = new Set(ids.map(str));
  const before = f.edges.length;
  const missing = [...want].filter(id => !f.edges.some(e => e.id === id));
  f.edges = f.edges.filter(e => !want.has(e.id));
  return { removed: before - f.edges.length, ...(missing.length ? { missing } : {}) };
}

/* ---------- профиль и контракт ---------- */

function resolveSel(L, raw) {
  if (!isObj(raw)) fail('sel: ждём объект {измерение: [значения]}');
  const out = {};
  for (const [dk, vals] of Object.entries(raw)) {
    const d = L.dims.find(x => x.id === dk) || L.dims.find(x => str(x.name).toLowerCase() === dk.toLowerCase());
    if (!d) fail(`sel: измерения «${dk}» нет. Есть: ${L.dims.map(x => `${x.id} (${x.name})`).join(', ')}`);
    out[d.id] = (Array.isArray(vals) ? vals : [vals]).map(v => {
      const s = str(v);
      const hit = arr(d.values).find(x => x.id === s) || arr(d.values).find(x => str(x.name).toLowerCase() === s.toLowerCase());
      if (!hit) fail(`sel: у измерения «${d.name}» нет значения «${s}». Есть: ${arr(d.values).map(x => `${x.id} (${x.name})`).join(', ')}`);
      return hit.id;
    });
  }
  return out;
}
function pickProfile(pg, L, a) {
  const f = pg.flow;
  if (a.profile != null && a.profile !== '') {
    const s = str(a.profile);
    const p = f.profiles.find(x => x.id === s) || f.profiles.find(x => str(x.name).toLowerCase() === s.toLowerCase());
    if (!p) fail(`профиля «${s}» нет. Есть: ${f.profiles.map(x => `${x.id} (${x.name})`).join(', ') || 'ни одного — передайте sel'}`);
    return { profile: p, sel: isObj(p.sel) ? p.sel : {} };
  }
  if (a.sel != null) return { profile: null, sel: resolveSel(L, a.sel) };
  return { profile: null, sel: {} };
}

// Те же числа, что в сводке над схемой: «Проверок 45/55 · источников 22/24».
export function flowProfile(doc, pg, a) {
  const f = pg.flow, L = libView(doc);
  const { profile, sel } = pickProfile(pg, L, a);
  const A = R.activity(f, L, sel);
  const st = R.profileStats(f, L, sel, A);
  const checks = f.nodes.filter(n => n.k === 'check').map(n => ({ n, it: R.itemOf(L, n) || { code: '', name: n.ref } }))
    .sort((x, y) => R.codeCompare(x.it, y.it));
  const blocks = (k, sec) => {
    const seen = new Map();
    for (const n of f.nodes) if (n.k === k && A.nodes.has(n.id) && !seen.has(n.ref)) seen.set(n.ref, L[sec].find(x => x.id === n.ref) || { id: n.ref, name: n.ref });
    return [...seen.values()];
  };
  return {
    page: pg.id,
    profile: profile ? { id: profile.id, name: profile.name } : null,
    sel,
    checks: { on: st.checks.on, all: st.checks.all,
      list: checks.filter(x => A.nodes.has(x.n.id)).map(x => `${x.it.code ? x.it.code + ' ' : ''}${x.it.name}`),
      off: checks.filter(x => !A.nodes.has(x.n.id)).map(x => x.it.code || x.it.name) },
    sources: { on: st.sources.on, all: st.sources.all,
      list: blocks('source', 'sources').map(s => ({ id: s.id, name: s.name, status: s.status || 'unknown', access: s.access || '' })) },
    outcomes: { on: st.outcomes.on, all: st.outcomes.all, list: blocks('outcome', 'outcomes').map(o => ({ id: o.id, name: o.name })) },
    holes: st.holes.map(h => ({ check: h.code, input: h.name, node: h.node })),
    profiles: f.profiles.map(p => ({ id: p.id, name: p.name })),
  };
}

export function flowExport(doc, pg, a) {
  const L = libView(doc);
  const { profile } = pickProfile(pg, L, { profile: a.profile });
  return R.toContract(Object.assign({}, doc, { flowLib: L }), pg, profile ? { profile: profile.id } : {});
}

// Раскладка — в два шага: ELK асинхронный, а правка документа синхронна.
// План строится по прочитанной схеме, а пишется в свежую: позиции привязаны
// к id нод, и правка, пришедшая между шагами, не потеряется.
export async function layoutPlan(doc, pg) {
  const plan = R.layoutPlan(pg.flow, libView(doc));
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
  const result = await new ELK().layout(plan.graph);
  return { plan, result };
}
export function layoutApply(pg, lay) {
  return { moved: R.applyLayout(pg.flow, lay.plan, lay.result) };
}

export { plural };
