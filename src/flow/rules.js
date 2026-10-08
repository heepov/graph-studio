// Правила нодового конструктора KYC Flow. ЧИСТЫЙ модуль: ни DOM, ни React,
// ни импортов. Им пользуются три стороны сразу — интерфейс (src/flow), сервер
// (server/src/mcp/flow-rules.js — байт-в-байт копия, её делает
// scripts/sync-flow-rules.mjs) и тесты на node. Поэтому всё, что решает «можно ли»
// и «что получится», живёт здесь, а не в компонентах: иначе Claude через MCP
// и человек мышью получали бы разные ответы на один и тот же вопрос.

/* ---------- справочники, зашитые в код ---------- */

// Типы данных полей и входов. От них зависят цвет сокета и совместимость связей,
// поэтому список фиксирован: свой тип в 2.9.0 не заводится (ТЗ §9.2).
export const TYPES = [
  {key: 'bool', name: 'Да/нет', color: '#e0567a'},
  {key: 'text', name: 'Текст', color: '#4fa3e0'},
  {key: 'number', name: 'Число', color: '#3fb37f'},
  {key: 'money', name: 'Сумма', color: '#c9a227'},
  {key: 'date', name: 'Дата', color: '#f08a3c'},
  {key: 'list', name: 'Набор', color: '#6b7fd7'},
  {key: 'person', name: 'Физлицо', color: '#14b8a6'},
  {key: 'file', name: 'Документ', color: '#9ca3af'},
  {key: 'any', name: 'Любой', color: '#c4c9d4'},
];
export const TYPE_KEYS = TYPES.map(t => t.key);
export const typeOf = k => TYPES.find(t => t.key === k) || TYPES[TYPES.length - 1];

// Вердикты по умолчанию. В отличие от типов, список редактируется — это данные
// библиотеки (flowLib.verdicts), а здесь только стартовое наполнение.
export const DEFAULT_VERDICTS = [
  {key: 'ok', name: 'Продолжить / открыть', color: '#2e9d58'},
  {key: 'stop_a', name: 'Отказ обязателен (группа А)', color: '#9f1d16'},
  {key: 'stop_b', name: 'Отказ возможен (группа Б)', color: '#e0473a'},
  {key: 'freeze', name: 'Замораживание + ФЭС', color: '#1f2433'},
  {key: 'manual', name: 'Ручной разбор', color: '#c26a00'},
  {key: 'risk', name: 'Повышение степени риска', color: '#e6a700'},
  {key: 'clarify', name: 'Запрос пояснений', color: '#3b82f6'},
  {key: 'neutral', name: 'Нейтральный экран', color: '#8a94a6'},
  {key: 'info', name: 'Информация, без последствия', color: '#b8bfcc'},
];

// Виды нод и цвет шапки. Исход красится цветом своего вердикта, этап — заливкой.
export const NODE_KINDS = ['dim', 'source', 'check', 'outcome', 'stage', 'gate', 'anyof', 'calc', 'note', 'reroute'];
export const KIND_NAMES = {
  dim: 'Измерение', source: 'Источник', check: 'Проверка', outcome: 'Исход', stage: 'Этап',
  gate: 'Гейт', anyof: 'Один из', calc: 'Показатель', note: 'Заметка', reroute: 'Точка перегиба',
};
export const KIND_COLORS = {
  dim: '#7c5cff', source: '#0f9f8f', check: '#3355d1', stage: '#3355d1',
  gate: '#6b7280', anyof: '#a16207', calc: '#0e7490',
};
export const COND_COLOR = '#7c5cff';
// Блоки библиотеки и их разделы в flowLib. Остальные виды живут только в странице.
export const LIB_KINDS = {dim: 'dims', source: 'sources', check: 'checks', outcome: 'outcomes'};
export const LIB_SECTIONS = ['dims', 'sources', 'checks', 'outcomes', 'verdicts'];

export const SOURCE_KINDS = [['gov', 'Госреестр'], ['commercial', 'Коммерческий сервис'], ['bank', 'Система банка'],
  ['internal', 'Внутренняя система'], ['client', 'Клиент'], ['staff', 'Сотрудник']];
export const SOURCE_ACCESS = [['api', 'API'], ['bulk', 'Выгрузка'], ['cabinet', 'Личный кабинет'], ['manual', 'Вручную'], ['none', 'Нет доступа']];
export const SOURCE_MODES = [['sync', 'Синхронно'], ['async', 'Асинхронно'], ['daily', 'Раз в сутки']];
export const SOURCE_STATUSES = [['live', 'Подключён'], ['contract', 'Договор, не подключён'], ['planned', 'Планируется'],
  ['no_access', 'Нет доступа'], ['no_source', 'Источника нет'], ['unknown', 'Не выяснено']];
export const BANK_STATUSES = [['none', 'Не выносилось'], ['accepted', 'Принято'], ['accepted_comments', 'Принято с комментариями'],
  ['discussion', 'Обсуждение'], ['rejected', 'Отклонено']];
export const ACTORS = [['system', 'Система'], ['verifier', 'Верификатор'], ['km', 'Клиентский менеджер'],
  ['compliance', 'Комплаенс'], ['client', 'Клиент']];
export const nameOf = (list, key) => (list.find(x => x[0] === key) || [key, key || '—'])[1];

/* ---------- умолчания ---------- */

// Единственное место, где описано «пустое»: normalize в приложении и addPage
// на сервере берут умолчания отсюда, а не держат по своей копии.
export function defaultFlow() {
  return {nodes: [], edges: [], profiles: [], profile: null,
    show: {exec: 1, data: 1, cond: 1, verdict: 1}, overlay: ''};
}
export function defaultLib() {
  return {v: 1, dims: [], sources: [], checks: [], outcomes: [],
    verdicts: DEFAULT_VERDICTS.map(v => ({...v}))};
}

/* ---------- сокеты ----------
   Сокет — это ручка на ноде: id ручки (тот же, что в edges[].sh/th), вид и тип.
   Виды: exec ▶ порядок исполнения, cond ◆ применимость, data ● данные,
   verdict ■ вердикт; vin — вход исхода, принимает и вердикт, и порядок;
   any — reroute без связей, примет то, что подключат первым. */

const SECT = {dim: 'dims', source: 'sources', check: 'checks', outcome: 'outcomes'};
const findIn = (list, id) => (list || []).find(x => x.id === id) || null;
export function itemOf(lib, node) {
  const s = node && SECT[node.k];
  return s && lib ? findIn(lib[s], node.ref) : null;
}
export const verdictOf = (lib, key) => ((lib && lib.verdicts) || []).find(v => v.key === key)
  || DEFAULT_VERDICTS.find(v => v.key === key) || {key, name: key, color: '#8a94a6'};

// Эффективный вид и тип reroute: «принимает тип первой подключённой связи».
// Первая — по порядку в edges (порядок создания). Обход ограничен глубиной:
// цепочка reroute → reroute допустима, но не должна зацикливать вычисление.
function rerouteSig(flow, lib, nodeId, depth) {
  if (depth > 12) return {kind: 'any', type: 'any'};
  for (const e of flow.edges) {
    if (e.t === nodeId && e.th === 'in') {
      const s = socketOf(flow, lib, e.s, e.sh, 'out', depth + 1);
      if (s && s.kind !== 'any') return {kind: s.kind, type: s.type, verdict: s.verdict};
    } else if (e.s === nodeId && e.sh === 'out') {
      const t = socketOf(flow, lib, e.t, e.th, 'in', depth + 1);
      if (t && t.kind !== 'any') return {kind: t.kind, type: t.type, verdict: t.verdict};
    }
  }
  return {kind: 'any', type: 'any'};
}
// Тип «один из»: заданный, а при 'any' — тип первой подключённой связи данных.
export function anyofType(flow, lib, node, depth = 0) {
  const t = (node.data || {}).type || 'any';
  if (t !== 'any' || depth > 12) return t;
  for (const e of flow.edges) {
    if (e.t === node.id && /^in:/.test(e.th)) {
      const s = socketOf(flow, lib, e.s, e.sh, 'out', depth + 1);
      if (s && s.kind === 'data' && s.type !== 'any') return s.type;
    } else if (e.s === node.id && e.sh === 'out') {
      const s = socketOf(flow, lib, e.t, e.th, 'in', depth + 1);
      if (s && s.kind === 'data' && s.type !== 'any') return s.type;
    }
  }
  return 'any';
}

// Все сокеты ноды в порядке строк: in — слева, out — справа.
export function socketsOf(flow, lib, node, depth = 0) {
  const ins = [], outs = [];
  const it = itemOf(lib, node), d = node.data || {};
  switch (node.k) {
    case 'dim':
      for (const v of (it && it.values) || []) outs.push({id: 'val:' + v.id, kind: 'cond', name: v.name, code: v.code || ''});
      break;
    case 'source':
      ins.push({id: 'cond-in', kind: 'cond', name: 'Когда', optional: true});
      for (const f of (it && it.fields) || []) outs.push({id: 'out:' + f.id, kind: 'data', type: f.type || 'any', name: f.name});
      break;
    case 'check':
      ins.push({id: 'exec-in', kind: 'exec', name: ''}, {id: 'cond-in', kind: 'cond', name: 'Когда'});
      for (const i of (it && it.inputs) || []) ins.push({id: 'in:' + i.id, kind: 'data', type: i.type || 'any', name: i.name});
      outs.push({id: 'exec-out', kind: 'exec', name: ''});
      for (const v of (it && it.verdicts) || []) outs.push({id: 'v:' + v, kind: 'verdict', verdict: v, name: verdictOf(lib, v).name});
      break;
    case 'outcome':
      ins.push({id: 'vin', kind: 'vin', name: 'вердикт'});
      outs.push({id: 'exec-out', kind: 'exec', name: '', optional: true});
      break;
    case 'stage':
      ins.push({id: 'exec-in', kind: 'exec', name: ''}, {id: 'cond-in', kind: 'cond', name: 'Когда'});
      outs.push({id: 'exec-out', kind: 'exec', name: ''});
      break;
    case 'gate':
      ins.push({id: 'exec-in', kind: 'exec', name: ''});
      outs.push({id: 'exec-out', kind: 'exec', name: 'да'}, {id: 'exec-no', kind: 'exec', name: 'нет'});
      break;
    case 'anyof': {
      const t = anyofType(flow, lib, node, depth), n = Math.max(1, Math.min(12, +d.n || 2));
      for (let i = 0; i < n; i++) ins.push({id: 'in:' + i, kind: 'data', type: t, name: String(i + 1)});
      outs.push({id: 'out', kind: 'data', type: t, name: ''});
      break;
    }
    case 'calc':
      for (const i of d.inputs || []) ins.push({id: 'in:' + i.id, kind: 'data', type: i.type || 'any', name: i.name || ''});
      outs.push({id: 'out', kind: 'data', type: d.type || 'number', name: ''});
      break;
    case 'reroute': {
      const s = rerouteSig(flow, lib, node.id, depth);
      ins.push({id: 'in', kind: s.kind, type: s.type, verdict: s.verdict, name: ''});
      outs.push({id: 'out', kind: s.kind, type: s.type, verdict: s.verdict, name: ''});
      break;
    }
    default: break;   // note — без сокетов
  }
  return {ins, outs};
}
export function socketOf(flow, lib, nodeId, handle, side, depth = 0) {
  const n = findIn(flow.nodes, nodeId);
  if (!n) return null;
  const s = socketsOf(flow, lib, n, depth);
  return (side === 'in' ? s.ins : s.outs).find(x => x.id === handle) || null;
}

// Вид связи — по сокету, из которого она выходит. reroute без связей отдаёт
// свой первый подключённый вид, а если и его нет — data.
export function edgeKind(flow, lib, e) {
  const s = socketOf(flow, lib, e.s, e.sh, 'out');
  if (!s) return /^exec/.test(e.sh) ? 'exec' : /^val:/.test(e.sh) ? 'cond' : /^v:/.test(e.sh) ? 'verdict' : 'data';
  if (s.kind === 'any' || s.kind === 'vin') return s.kind === 'vin' ? 'exec' : 'data';
  return s.kind;
}
export function edgeColor(flow, lib, e) {
  const s = socketOf(flow, lib, e.s, e.sh, 'out');
  if (!s) return '#9aa1b2';
  if (s.kind === 'data' || s.kind === 'any') return typeOf(s.type || 'any').color;
  if (s.kind === 'cond') return COND_COLOR;
  if (s.kind === 'verdict') return verdictOf(lib, s.verdict).color;
  return '';   // exec: цвет темы (--ink2), его подставляет интерфейс
}
export const isConnected = (flow, nodeId, handle) =>
  flow.edges.some(e => (e.s === nodeId && e.sh === handle) || (e.t === nodeId && e.th === handle));

/* ---------- раскладка строк и размеры ----------
   Одна функция и для отрисовки, и для оценки размеров: на сервере (MCP, ELK)
   DOM нет, и размеры считаются отсюда. Расхождение с отрисовкой означало бы,
   что раскладка с сервера кладёт ноды друг на друга. */
export const SIZE = {HDR: 34, ROW: 22, BODY: 44, PAD: 12,
  W: {dim: 220, source: 260, check: 300, outcome: 220, gate: 200, anyof: 180, calc: 240, note: 240, reroute: 12, stage: 360},
  STAGE: {PADT: 56, PAD: 20, GAP: 16, MINW: 240, MINH: 160}};

export function nodeRows(flow, lib, node) {
  const s = socketsOf(flow, lib, node);
  const hide = new Set(node.hide || []);
  // Ctrl+H прячет только НЕсоединённые сокеты: соединённый спрятать нельзя,
  // иначе связь уходила бы в никуда.
  const vis = list => list.filter(x => !hide.has(x.id) || isConnected(flow, node.id, x.id));
  let L = vis(s.ins), Rr = vis(s.outs);
  const it = itemOf(lib, node);
  if (node.k === 'check' && it && it.verdictTbd) Rr = Rr.concat([{id: '', kind: 'tbd', name: 'не определён'}]);
  const rows = [];
  if (node.k === 'source') {
    rows.push({l: L[0] || null, r: null});
    for (const o of Rr) rows.push({l: null, r: o});
    return rows;
  }
  if (node.k === 'anyof') {
    const n = Math.max(L.length, 1);
    for (let i = 0; i < n; i++) rows.push({l: L[i] || null, r: i === 0 ? Rr[0] || null : null});
    rows.push({l: null, r: null, add: true});    // строка «+ вход»
    return rows;
  }
  const n = Math.max(L.length, Rr.length, node.k === 'calc' ? 1 : 0);
  for (let i = 0; i < n; i++) rows.push({l: L[i] || null, r: Rr[i] || null});
  return rows;
}

export function nodeSize(flow, lib, node) {
  const {HDR, ROW, BODY, PAD, W} = SIZE;
  if (node.k === 'reroute') return {w: W.reroute, h: W.reroute};
  if (node.k === 'note') return {w: +node.w || 240, h: +node.h || 120};
  if (node.k === 'stage') return {w: +node.w || W.stage, h: +node.h || 200};
  const w = W[node.k] || 220;
  if (node.collapsed) return {w, h: HDR};
  const rows = nodeRows(flow, lib, node).length;
  switch (node.k) {
    case 'check': return {w, h: HDR + ROW * rows + BODY};
    case 'outcome': return {w, h: HDR + ROW * rows + 24};
    case 'gate': return {w, h: HDR + ROW * rows + 22 + 10};
    case 'calc': return {w, h: HDR + ROW * rows + 24 + PAD};
    default: return {w, h: HDR + ROW * rows + PAD};   // dim, source, anyof
  }
}

// Абсолютная позиция ноды: дети рамки хранят координаты относительно неё.
export function absPos(flow, node) {
  if (!node.parent) return {x: +node.x || 0, y: +node.y || 0};
  const p = findIn(flow.nodes, node.parent);
  return p ? {x: (+p.x || 0) + (+node.x || 0), y: (+p.y || 0) + (+node.y || 0)} : {x: +node.x || 0, y: +node.y || 0};
}

// Подгонка рамки под детей (fit:1). sizeOf позволяет интерфейсу подставить
// измеренные размеры, серверу — оценку nodeSize. Возвращает новые {x, y, w, h}
// рамки и сдвиг детей, если они вылезли за левый или верхний край.
export function fitStage(flow, lib, stage, sizeOf) {
  const {PADT, PAD, MINW, MINH} = SIZE.STAGE;
  const kids = flow.nodes.filter(n => n.parent === stage.id);
  if (!kids.length) return {x: +stage.x || 0, y: +stage.y || 0, w: +stage.w || SIZE.W.stage, h: +stage.h || 200, dx: 0, dy: 0};
  const sz = sizeOf || (n => nodeSize(flow, lib, n));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const k of kids) {
    const s = sz(k), x = +k.x || 0, y = +k.y || 0;
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + s.w); y1 = Math.max(y1, y + s.h);
  }
  const dx = x0 < PAD ? PAD - x0 : 0, dy = y0 < PADT ? PADT - y0 : 0;
  return {x: (+stage.x || 0) - dx, y: (+stage.y || 0) - dy,
    w: Math.max(MINW, Math.round(x1 + dx + PAD)), h: Math.max(MINH, Math.round(y1 + dy + PAD)), dx, dy};
}

/* ---------- соединения ----------
   Матрица ТЗ §4.2: связь всегда от выхода к входу.
     exec  → exec-in, vin (в исход), reroute
     cond  → cond-in, reroute
     data  → вход данных того же типа (или any), reroute
     verdict → vin, reroute
   Вход данных и вход reroute держат одну связь: новая заменяет старую, как в
   Blender, — поэтому ответ несёт replace[]. cond-in, exec-in и vin — много связей. */

const KIND_TEXT = {exec: 'порядок', cond: 'применимость', data: 'данные', verdict: 'вердикт', vin: 'исход', any: 'точка перегиба'};
const single = (node, handle) => handle === 'in' || (/^in:/.test(handle) && node && (node.k === 'check' || node.k === 'calc' || node.k === 'anyof'));

// Есть ли путь по «потоку управления» (порядок и вердикты, сквозь reroute)
// от from до to. Нужен на каждое добавление связи, как hasCycle() у графа.
function controlReach(flow, lib, from, to, extra) {
  const isControl = e => {
    if (/^exec/.test(e.sh) || /^v:/.test(e.sh) || e.th === 'vin' || e.th === 'exec-in') return true;
    if (e.sh === 'out' || e.th === 'in') {
      const k = edgeKind(flow, lib, e);
      return k === 'exec' || k === 'verdict';
    }
    return false;
  };
  const adj = new Map();
  for (const e of flow.edges.concat(extra ? [extra] : [])) {
    if (!isControl(e)) continue;
    if (!adj.has(e.s)) adj.set(e.s, []);
    adj.get(e.s).push(e.t);
  }
  const seen = new Set([from]), st = [from];
  while (st.length) {
    const x = st.pop();
    if (x === to) return true;
    for (const y of adj.get(x) || []) if (!seen.has(y)) { seen.add(y); st.push(y); }
  }
  return false;
}

export function canConnect(flow, lib, c) {
  const no = reason => ({ok: false, reason});
  const sN = findIn(flow.nodes, c.source), tN = findIn(flow.nodes, c.target);
  if (!sN || !tN) return no('нет такой ноды');
  if (c.source === c.target) return no('связь в себя запрещена');
  const so = socketOf(flow, lib, c.source, c.sourceHandle, 'out');
  const ti = socketOf(flow, lib, c.target, c.targetHandle, 'in');
  if (!so) return no('у ноды нет такого выхода: ' + c.sourceHandle);
  if (!ti) return no('у ноды нет такого входа: ' + c.targetHandle);
  if (flow.edges.some(e => e.s === c.source && e.sh === c.sourceHandle && e.t === c.target && e.th === c.targetHandle)) {
    return no('такая связь уже есть');
  }
  const sk = so.kind, tk = ti.kind;
  if (tk === 'vin' && sk !== 'exec' && sk !== 'verdict' && sk !== 'any' && sk !== 'vin') {
    return no('в исход можно вести только вердикт или порядок');
  }
  let fits;
  if (tk === 'any' || sk === 'any') fits = true;                      // reroute без связей примет что угодно
  else if (sk === 'vin') fits = tk === 'vin';                        // reroute, привязанный к исходу
  else if (sk === 'exec') fits = tk === 'exec' || tk === 'vin';
  else if (sk === 'verdict') fits = tk === 'vin';
  else if (sk === 'cond') fits = tk === 'cond';
  else if (sk === 'data') {
    if (tk !== 'data') fits = false;
    else if (so.type !== ti.type && so.type !== 'any' && ti.type !== 'any') {
      return no(`${so.type} → ${ti.type}: типы не совпадают`);
    } else fits = true;
  }
  if (!fits) return no(`${KIND_TEXT[sk] || sk} → ${KIND_TEXT[tk] || tk}: так соединять нельзя`);
  const e = {id: '__new', s: c.source, sh: c.sourceHandle, t: c.target, th: c.targetHandle};
  const control = sk === 'exec' || sk === 'verdict' || sk === 'vin' || tk === 'exec' || tk === 'vin';
  if (control && controlReach(flow, lib, c.target, c.source, e)) {
    return no('порядок исполнения замкнулся бы в цикл');
  }
  const replace = single(tN, c.targetHandle)
    ? flow.edges.filter(x => x.t === c.target && x.th === c.targetHandle).map(x => x.id) : [];
  return {ok: true, replace, kind: sk === 'any' ? (tk === 'any' ? 'data' : tk === 'vin' ? 'exec' : tk) : (sk === 'vin' ? 'exec' : sk)};
}

// Цикл по порядку исполнения уже в документе (валидатор): есть ли ребро, которое
// замыкает путь обратно в свой источник. Возвращает id таких рёбер.
export function controlCycles(flow, lib) {
  const out = [];
  for (const e of flow.edges) {
    const rest = {nodes: flow.nodes, edges: flow.edges.filter(x => x !== e)};
    const k = edgeKind(flow, lib, e);
    if ((k === 'exec' || k === 'verdict') && controlReach(rest, lib, e.t, e.s)) out.push(e.id);
  }
  return out;
}

/* ---------- откуда приходят данные ----------
   Вход проверки получает данные напрямую из поля источника или через
   посредников: «один из» (резерв по приоритету), reroute, показатель.
   Обход назад даёт список источников входа в порядке приоритета — его
   читают бейдж 🔴 на ноде, оверлей покрытия и контракт kycflow/1. */
export function inputSources(flow, lib, nodeId, handle, depth = 0, prio = [1]) {
  const out = [];
  if (depth > 16) return out;
  for (const e of flow.edges) {
    if (e.t !== nodeId || e.th !== handle) continue;
    const s = findIn(flow.nodes, e.s);
    if (!s) continue;
    if (s.k === 'source') {
      const it = itemOf(lib, s), fid = String(e.sh).replace(/^out:/, '');
      out.push({node: s.id, source: s.ref, field: fid, item: it,
        fieldItem: it ? findIn(it.fields, fid) : null, priority: out.length + 1, path: prio.slice()});
    } else if (s.k === 'anyof') {
      const n = Math.max(1, +(s.data || {}).n || 2);
      for (let i = 0; i < n; i++) for (const x of inputSources(flow, lib, s.id, 'in:' + i, depth + 1, prio.concat(i + 1))) out.push(x);
    } else if (s.k === 'reroute') {
      for (const x of inputSources(flow, lib, s.id, 'in', depth + 1, prio)) out.push(x);
    } else if (s.k === 'calc') {
      for (const i of ((s.data || {}).inputs) || []) for (const x of inputSources(flow, lib, s.id, 'in:' + i.id, depth + 1, prio)) out.push(x);
    }
  }
  out.forEach((x, i) => { x.priority = i + 1; });
  return out;
}
export const BAD_STATUS = new Set(['no_access', 'no_source']);
export const SOFT_STATUS = new Set(['planned', 'contract']);

// Дыры проверки: входы без связи и источники без доступа / только в планах.
export function checkHoles(flow, lib, node) {
  const it = itemOf(lib, node);
  const res = {unwired: [], noAccess: [], planned: [], unknown: [], sources: []};
  if (!it) return res;
  const seen = new Set();
  for (const inp of it.inputs || []) {
    const src = inputSources(flow, lib, node.id, 'in:' + inp.id);
    if (!flow.edges.some(e => e.t === node.id && e.th === 'in:' + inp.id)) res.unwired.push(inp.id);
    for (const s of src) {
      if (seen.has(s.source)) continue;
      seen.add(s.source);
      res.sources.push(s.source);
      const st = s.item ? s.item.status : 'unknown';
      if (BAD_STATUS.has(st)) res.noAccess.push(s.source);
      else if (SOFT_STATUS.has(st)) res.planned.push(s.source);
      else if (st !== 'live') res.unknown.push(s.source);
    }
  }
  return res;
}

/* ---------- применимость: связи «Когда» ----------
   Связь применимости может идти через reroute — исток ищется назад до значения
   измерения. Группировка по измерению: внутри измерения ИЛИ, между — И (ТЗ §5). */
export function traceOrigin(flow, nodeId, handle, depth = 0) {
  if (depth > 16) return null;
  for (const e of flow.edges) {
    if (e.t !== nodeId || e.th !== handle) continue;
    const s = findIn(flow.nodes, e.s);
    if (!s) continue;
    if (s.k === 'reroute') { const o = traceOrigin(flow, s.id, 'in', depth + 1); if (o) return Object.assign(o, {neg: !!e.neg || o.neg}); continue; }
    return {node: s, handle: e.sh, neg: !!e.neg, edge: e};
  }
  return null;
}
export function condOf(flow, lib, nodeId) {
  const out = {};
  for (const e of flow.edges) {
    if (e.t !== nodeId || e.th !== 'cond-in') continue;
    let s = findIn(flow.nodes, e.s), sh = e.sh, neg = !!e.neg;
    if (s && s.k === 'reroute') { const o = traceOrigin(flow, s.id, 'in'); if (!o) continue; s = o.node; sh = o.handle; neg = neg || o.neg; }
    if (!s || s.k !== 'dim' || !/^val:/.test(sh)) continue;
    const d = out[s.ref] = out[s.ref] || {pos: [], neg: []};
    const v = sh.slice(4);
    (neg ? d.neg : d.pos).includes(v) || (neg ? d.neg : d.pos).push(v);
  }
  return out;
}
const valueName = (lib, dimId, vid) => {
  const d = findIn(lib && lib.dims, dimId), v = d && findIn(d.values, vid);
  return v ? v.name : vid;
};
// «все» или «ЮЛ; кроме: ИП, Свежерег < 180 дней» — колонка «Применимость» xlsx.
// Внутри измерения значения через «или», измерения — через «;»: так в тексте
// видно то же И/ИЛИ, что считает applies().
export function condText(flow, lib, nodeId) {
  const c = condOf(flow, lib, nodeId), pos = [], neg = [];
  for (const [dim, x] of Object.entries(c)) {
    if (x.pos.length) pos.push(x.pos.map(v => valueName(lib, dim, v)).join(' или '));
    for (const v of x.neg) neg.push(valueName(lib, dim, v));
  }
  if (!pos.length && !neg.length) return 'все';
  return pos.concat(neg.length ? ['кроме: ' + neg.join(', ')] : []).join('; ');
}

// Колонка «Источник»: уникальные названия источников подключённых входов,
// резерв «один из» — через « → »; нет подключённых — исходный текст из xls;
// есть вход без связи — «🔴 источник не определён».
export function sourceText(flow, lib, node) {
  const it = itemOf(lib, node);
  if (!it) return '';
  const groups = [];
  let unwired = false;
  for (const inp of it.inputs || []) {
    const h = 'in:' + inp.id;
    if (!flow.edges.some(e => e.t === node.id && e.th === h)) { unwired = true; continue; }
    const src = inputSources(flow, lib, node.id, h);
    const names = [];
    for (const s of src) { const nm = s.item ? s.item.name : s.source; if (!names.includes(nm)) names.push(nm); }
    const via = src.some(s => s.path.length > 1);
    if (via && names.length > 1) groups.push(names.join(' → '));
    else for (const nm of names) groups.push(nm);
  }
  const uniq = [...new Set(groups)];
  let text = uniq.length ? uniq.join(', ') : (it.srcText || '');
  if (unwired) text = text ? text + ', 🔴 источник не определён' : '🔴 источник не определён';
  return text;
}

// Натуральная сортировка кода проверки: «2.9» < «2.10» (ТЗ §10).
export const codeCompare = (a, b) => String((a && a.code) || '').localeCompare(String((b && b.code) || ''), 'ru', {numeric: true})
  || String((a && a.name) || '').localeCompare(String((b && b.name) || ''), 'ru');

/* ---------- применимость по профилю (ТЗ §5) ----------
   Профиль — выбор значений по измерениям: sel = {dimId: [valueId…]}. Измерение,
   которого нет в sel (или пустой массив), означает «любое». Внутри измерения —
   ИЛИ, между измерениями — И. Ничего не исполняется: ответ только на вопрос
   «какие блоки участвуют в конвейере для этого типа клиента». */
export function appliesCond(cond, sel) {
  for (const [dim, c] of Object.entries(cond)) {
    const S = (sel && sel[dim]) || [];
    if (!S.length) continue;
    if (!S.some(v => (!c.pos.length || c.pos.includes(v)) && !c.neg.includes(v))) return false;
  }
  return true;
}
export const applies = (flow, lib, nodeId, sel) => appliesCond(condOf(flow, lib, nodeId), sel);

const DATA_HELPERS = new Set(['anyof', 'calc', 'reroute']);

// Активность всего конвейера при профиле sel:
//   проверка — применима сама, применим её этап, не выключена;
//   источник — применим, не выключен и кормит активную проверку (напрямую или
//              через «один из», показатель, reroute);
//   исход — в него ведёт вердикт или порядок от активного блока;
//   связь — активны оба конца (reroute — по тому, что он соединяет).
export function activity(flow, lib, sel) {
  const N = new Map(flow.nodes.map(n => [n.id, n]));
  const act = new Set();
  const stageOk = new Map();
  const okStage = id => {
    if (!stageOk.has(id)) { const s = N.get(id); stageOk.set(id, !!s && !s.muted && applies(flow, lib, id, sel)); }
    return stageOk.get(id);
  };
  for (const n of flow.nodes) {
    if (n.k === 'check') { if (!n.muted && applies(flow, lib, n.id, sel) && (!n.parent || okStage(n.parent))) act.add(n.id); }
    else if (n.k === 'stage') { if (okStage(n.id)) act.add(n.id); }
    else if (n.k === 'dim' || n.k === 'note') { if (!n.muted) act.add(n.id); }
    else if (n.k === 'gate') { if (!n.muted) act.add(n.id); }
  }
  // Назад по данным от активных проверок: источники и посредники, которые их кормят.
  const into = new Map();
  for (const e of flow.edges) { if (!into.has(e.t)) into.set(e.t, []); into.get(e.t).push(e); }
  const fed = new Set();
  const stack = [...act].filter(id => (N.get(id) || {}).k === 'check');
  while (stack.length) {
    const id = stack.pop();
    for (const e of into.get(id) || []) {
      if (e.th === 'cond-in' || e.th === 'exec-in' || e.th === 'vin') continue;
      const s = N.get(e.s); if (!s || fed.has(s.id)) continue;
      if (s.k === 'source') fed.add(s.id);
      else if (DATA_HELPERS.has(s.k)) { fed.add(s.id); stack.push(s.id); }
    }
  }
  for (const id of fed) {
    const s = N.get(id);
    if (s.muted) continue;
    if (s.k === 'source' && !applies(flow, lib, id, sel)) continue;
    act.add(id);
  }
  // Вперёд по потоку управления от активных блоков: исходы, в которые он приходит.
  const out = new Map();
  for (const e of flow.edges) { if (!out.has(e.s)) out.set(e.s, []); out.get(e.s).push(e); }
  const ctl = [...act].filter(id => ['check', 'stage', 'gate'].includes((N.get(id) || {}).k));
  const seenC = new Set(ctl);
  while (ctl.length) {
    const id = ctl.pop();
    for (const e of out.get(id) || []) {
      if (!/^exec|^v:/.test(e.sh) && e.sh !== 'out') continue;
      const t = N.get(e.t); if (!t || seenC.has(t.id)) continue;
      if (t.k === 'outcome' && !t.muted) { act.add(t.id); seenC.add(t.id); ctl.push(t.id); }
      else if (t.k === 'reroute') { seenC.add(t.id); ctl.push(t.id); }
    }
  }
  // Связь активна, когда активен её исток и хоть один потребитель (reroute — насквозь).
  const origin = (id, d = 0) => {
    const n = N.get(id);
    if (!n || n.k !== 'reroute' || d > 16) return n;
    const e = (into.get(id) || [])[0];
    return e ? origin(e.s, d + 1) : null;
  };
  const consumer = (id, d = 0) => {
    const n = N.get(id);
    if (!n) return false;
    if (n.k !== 'reroute' || d > 16) return act.has(id);
    return (out.get(id) || []).some(e => consumer(e.t, d + 1));
  };
  const edges = new Set();
  for (const e of flow.edges) {
    const o = origin(e.s);
    if (o && act.has(o.id) && consumer(e.t)) edges.add(e.id);
  }
  for (const n of flow.nodes) {
    if (n.k === 'reroute' && flow.edges.some(e => edges.has(e.id) && (e.s === n.id || e.t === n.id))) act.add(n.id);
  }
  return {nodes: act, edges};
}

// Сводка профиля: «Проверок 45/55 · источников 22/24 · исходов 8/8 · входов без
// источника 2». Источники и исходы считаются по блокам: один источник может
// стоять на схеме несколько раз.
export function profileStats(flow, lib, sel, a) {
  const A = a || activity(flow, lib, sel);
  const by = k => flow.nodes.filter(n => n.k === k);
  const refs = (list, onlyActive) => new Set(list.filter(n => !onlyActive || A.nodes.has(n.id)).map(n => n.ref));
  const checks = by('check'), sources = by('source'), outcomes = by('outcome');
  const holes = [];
  for (const n of checks) {
    if (!A.nodes.has(n.id)) continue;
    const it = itemOf(lib, n);
    for (const inp of (it && it.inputs) || []) {
      if (!flow.edges.some(e => e.t === n.id && e.th === 'in:' + inp.id)) holes.push({node: n.id, input: inp.id, name: inp.name, code: it.code});
    }
  }
  return {
    checks: {on: checks.filter(n => A.nodes.has(n.id)).length, all: checks.length},
    sources: {on: refs(sources, true).size, all: refs(sources).size},
    outcomes: {on: refs(outcomes, true).size, all: refs(outcomes).size},
    holes,
  };
}

/* ---------- авто-раскладка (ELK) ----------
   План строится здесь, чтобы интерфейс и сервер (flow_layout) раскладывали
   одинаково; сам ELK зовёт вызывающий. Внутри рамки этапа проверки идут
   столбцом по коду — они исполняются параллельно, и порядок «по коду» читается
   как в xls. Верхний уровень раскладывает ELK слоями слева направо: измерения
   и источники — раньше этапов, исходы — после. Рамка для ELK — один блок:
   связь к проверке внутри этапа считается связью к самому этапу. */
export const ELK_OPTIONS = {
  'elk.algorithm': 'layered', 'elk.direction': 'RIGHT',
  'elk.layered.spacing.nodeNodeBetweenLayers': '110', 'elk.spacing.nodeNode': '36',
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP', 'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
};
export function layoutPlan(flow, lib, sizeOf) {
  const sz = sizeOf || (n => nodeSize(flow, lib, n));
  const {PADT, PAD, GAP, MINW, MINH} = SIZE.STAGE;
  const byId = new Map(flow.nodes.map(n => [n.id, n]));
  const stages = {};
  for (const s of flow.nodes.filter(n => n.k === 'stage')) {
    const kids = flow.nodes.filter(n => n.parent === s.id);
    kids.sort((a, b) => (a.k === 'check' && b.k === 'check' ? codeCompare(itemOf(lib, a), itemOf(lib, b))
      : a.k === 'check' ? -1 : b.k === 'check' ? 1 : (+a.y || 0) - (+b.y || 0)));
    let y = PADT, w = 0;
    const pos = [];
    for (const k of kids) { const s2 = sz(k); pos.push({id: k.id, x: PAD, y}); y += s2.h + GAP; w = Math.max(w, s2.w); }
    stages[s.id] = {w: Math.max(MINW, Math.round(w + PAD * 2)), h: Math.max(MINH, Math.round(y - GAP + PAD)), kids: pos};
  }
  const top = flow.nodes.filter(n => !n.parent || !stages[n.parent]);
  const anc = id => { const n = byId.get(id); return n && n.parent && stages[n.parent] ? n.parent : id; };
  const children = top.map(n => {
    const s = stages[n.id] || sz(n);
    return {id: n.id, width: s.w, height: s.h};
  });
  const seen = new Set(), edges = [];
  for (const e of flow.edges) {
    const a = anc(e.s), b = anc(e.t);
    if (a === b || !byId.has(a) || !byId.has(b) || seen.has(a + '>' + b)) continue;
    seen.add(a + '>' + b);
    edges.push({id: 'l' + edges.length, sources: [a], targets: [b]});
  }
  return {graph: {id: 'root', layoutOptions: ELK_OPTIONS, children, edges}, stages};
}
// Записать результат ELK в конвейер: позиции верхнего уровня, размеры рамок
// и места детей внутри них. Рамка после раскладки снова подгоняется (fit:1).
export function applyLayout(flow, plan, result) {
  const pos = new Map(((result && result.children) || []).map(c => [c.id, c]));
  const byId = new Map(flow.nodes.map(n => [n.id, n]));
  let moved = 0;
  for (const n of flow.nodes) {
    const p = pos.get(n.id);
    if (p) { n.x = Math.round(p.x); n.y = Math.round(p.y); moved++; }
    const st = plan.stages[n.id];
    if (st) {
      n.w = st.w; n.h = st.h; n.fit = 1;
      for (const k of st.kids) { const c = byId.get(k.id); if (c) { c.x = k.x; c.y = k.y; } }
    }
  }
  return moved;
}

/* ---------- контракт kycflow/1 (ТЗ §10.2) ----------
   Единственный источник для всех выгрузок: xlsx, JSON и Markdown строятся из
   него, поэтому расходиться им негде. Вход будущего rules engine и ТЗ для
   разработки: этапы в порядке исполнения, у каждого входа — источники по
   приоритету, у каждого вердикта — куда он ведёт. */
export const CONTRACT_FORMAT = 'kycflow/1';
export const ISSUE_LEVEL = {INPUT_UNWIRED: 'error', SOURCE_NO_ACCESS: 'error', SOURCE_PLANNED: 'warning',
  VERDICT_TBD: 'warning', VERDICT_UNROUTED: 'warning', CHECK_NOT_IN_STAGE: 'warning'};

// Время выгрузки — локальное, со смещением: «2026-10-08T12:00:00+03:00».
export function isoLocal(d) {
  const p = n => String(Math.abs(n)).padStart(2, '0'), off = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `${off >= 0 ? '+' : '-'}${p(Math.trunc(off / 60))}:${p(off % 60)}`;
}

// Порядок этапов: топологический по цепочке ▶ между рамками и гейтами (сквозь
// reroute), начиная с рамки без входящего порядка; ничьи — по положению слева
// направо. Перед этапом — гейт, из которого в него приходит порядок.
export function stageOrder(flow) {
  const N = new Map(flow.nodes.map(n => [n.id, n]));
  const isSG = n => n && (n.k === 'stage' || n.k === 'gate');
  const next = new Map(), prevGate = new Map();
  const follow = (id, d = 0) => {   // куда ведёт выход, сквозь точки перегиба
    const n = N.get(id);
    if (!n || d > 16) return [];
    if (n.k !== 'reroute') return [n];
    return flow.edges.filter(e => e.s === id).flatMap(e => follow(e.t, d + 1));
  };
  for (const e of flow.edges) {
    const s = N.get(e.s);
    if (!isSG(s) || !/^exec/.test(e.sh)) continue;
    for (const t of follow(e.t)) {
      if (!isSG(t) || t.id === s.id) continue;
      if (!next.has(s.id)) next.set(s.id, []);
      next.get(s.id).push(t.id);
      if (s.k === 'gate' && t.k === 'stage') { if (!prevGate.has(t.id)) prevGate.set(t.id, []); prevGate.get(t.id).push(s.id); }
    }
  }
  const sg = flow.nodes.filter(isSG), indeg = new Map(sg.map(n => [n.id, 0]));
  for (const [, ts] of next) for (const t of ts) indeg.set(t, (indeg.get(t) || 0) + 1);
  const byX = (a, b) => ((+N.get(a).x || 0) - (+N.get(b).x || 0)) || ((+N.get(a).y || 0) - (+N.get(b).y || 0));
  let ready = sg.filter(n => !indeg.get(n.id)).map(n => n.id).sort(byX);
  const order = [];
  while (ready.length) {
    const id = ready.shift();
    order.push(id);
    for (const t of next.get(id) || []) { indeg.set(t, indeg.get(t) - 1); if (!indeg.get(t)) ready = ready.concat(t).sort(byX); }
  }
  for (const n of sg.slice().sort((a, b) => byX(a.id, b.id))) if (!order.includes(n.id)) order.push(n.id);   // цикл — в конец, по x
  return {stages: order.filter(id => N.get(id).k === 'stage'), gateBefore: prevGate};
}

function appliesWhen(flow, lib, nodeId) {
  const c = condOf(flow, lib, nodeId), all = Object.entries(c).map(([dimension, x]) => ({dimension, in: x.pos.slice(), notIn: x.neg.slice()}));
  return all.length ? {all} : null;
}

export function toContract(doc, page, opts = {}) {
  const flow = page.flow, lib = doc.flowLib || defaultLib();
  const prof = opts.profile ? (flow.profiles || []).find(p => p.id === opts.profile) || null : null;
  const sel = prof ? prof.sel : opts.sel || null;
  const act = sel ? activity(flow, lib, sel) : null;
  const N = new Map(flow.nodes.map(n => [n.id, n]));
  const issues = [];
  const issue = (code, ref, message) => issues.push({level: ISSUE_LEVEL[code], code, ref, message});
  const {stages: order, gateBefore} = stageOrder(flow);
  const verdictTarget = (nodeId, key, d = 0) => {
    for (const e of flow.edges) {
      if (e.s !== nodeId || e.sh !== (d ? 'out' : 'v:' + key)) continue;
      const t = N.get(e.t);
      if (t && t.k === 'outcome') return t.ref;
      if (t && t.k === 'reroute' && d < 16) { const r = verdictTarget(t.id, key, d + 1); if (r) return r; }
    }
    return null;
  };
  const checkOut = n => {
    const it = itemOf(lib, n);
    const inputs = (it.inputs || []).map(inp => {
      const h = 'in:' + inp.id, src = inputSources(flow, lib, n.id, h);
      const wired = flow.edges.some(e => e.t === n.id && e.th === h);
      if (!wired) issue('INPUT_UNWIRED', it.id + '.' + inp.id, `${it.code} «${it.name}»: у входа «${inp.name}» нет источника`);
      return {id: inp.id, name: inp.name, type: inp.type || 'any',
        sources: src.map(s => ({source: s.source, field: s.field, priority: s.priority})), missing: !wired};
    });
    const h = checkHoles(flow, lib, n);
    const names = ids => ids.map(id => ((lib.sources || []).find(s => s.id === id) || {name: id}).name).join(', ');
    if (h.noAccess.length) issue('SOURCE_NO_ACCESS', it.id, `${it.code} «${it.name}»: нет доступа к источнику — ${names(h.noAccess)}`);
    if (h.planned.length) issue('SOURCE_PLANNED', it.id, `${it.code} «${it.name}»: источник ещё не подключён — ${names(h.planned)}`);
    if (it.verdictTbd) issue('VERDICT_TBD', it.id, `${it.code} «${it.name}»: последствие проверки не определено`);
    const verdicts = (it.verdicts || []).map(v => {
      const outcome = verdictTarget(n.id, v);
      if (!outcome && v !== 'info' && v !== 'ok') issue('VERDICT_UNROUTED', it.id + '.' + v, `${it.code} «${it.name}»: вердикт «${verdictOf(lib, v).name}» никуда не ведёт`);
      return {verdict: v, outcome};
    });
    const after = flow.edges.filter(e => e.t === n.id && e.th === 'exec-in').map(e => N.get(e.s))
      .filter(x => x && x.k === 'check' && x.parent && x.parent === n.parent).map(x => x.ref);
    return {id: it.id, code: it.code || '', name: it.name || '', how: it.how || '', why: it.why || '', rule: it.rule || '', norm: it.norm || '',
      factors: (it.factors || []).slice(), actor: it.actor || 'system', wave: it.wave == null ? 1 : +it.wave,
      bank: {status: (it.bank || {}).status || 'none', comment: (it.bank || {}).comment || ''}, muted: !!n.muted,
      appliesWhen: appliesWhen(flow, lib, n.id), after, inputs, verdicts, verdictTbd: !!it.verdictTbd};
  };
  const included = n => n.k === 'check' && itemOf(lib, n) && (!act || act.nodes.has(n.id));
  const sortChecks = list => list.sort((a, b) => codeCompare(itemOf(lib, a), itemOf(lib, b)));
  const stages = order.map((id, i) => {
    const s = N.get(id), d = s.data || {}, g = (gateBefore.get(id) || []).map(gid => N.get(gid)).filter(Boolean);
    return {id, order: i + 1, num: String(d.num || ''), name: d.name || '', point: d.point || '',
      gateBefore: g.length ? {text: g.map(x => (x.data || {}).text || '').join('; ')} : null,
      appliesWhen: appliesWhen(flow, lib, id), muted: !!s.muted,
      checks: sortChecks(flow.nodes.filter(n => n.parent === id && included(n))).map(checkOut)};
  });
  const loose = sortChecks(flow.nodes.filter(n => included(n) && !(n.parent && N.get(n.parent) && N.get(n.parent).k === 'stage')));
  if (loose.length) {
    for (const n of loose) { const it = itemOf(lib, n); issue('CHECK_NOT_IN_STAGE', it.id, `${it.code} «${it.name}» не стоит ни в одном этапе`); }
    stages.push({id: '__outside', order: stages.length + 1, num: '', name: 'Вне этапов', point: '', gateBefore: null,
      appliesWhen: null, muted: false, checks: loose.map(checkOut)});
  }
  const lvl = {error: 0, warning: 1};
  issues.sort((a, b) => lvl[a.level] - lvl[b.level]);
  return {
    format: CONTRACT_FORMAT, exported: isoLocal(opts.now || new Date()),
    board: {id: String(opts.boardId || doc.id || ''), name: doc.name || ''},
    pipeline: {id: page.id, name: page.name || ''},
    profileFilter: prof ? {id: prof.id, name: prof.name, sel: prof.sel} : (sel ? {id: null, name: 'свой выбор', sel} : null),
    dictionaries: {
      dimensions: (lib.dims || []).map(x => ({id: x.id, code: x.code || '', name: x.name || '', desc: x.desc || '',
        values: (x.values || []).map(v => ({id: v.id, code: v.code || '', name: v.name || '', desc: v.desc || '', wave: v.wave == null ? 1 : +v.wave}))})),
      sources: (lib.sources || []).map(x => ({id: x.id, name: x.name || '', kind: x.kind || 'gov', access: x.access || 'api', mode: x.mode || 'sync',
        status: x.status || 'unknown', providers: x.providers || '', url: x.url || '', cost: x.cost || '', note: x.note || '',
        fields: (x.fields || []).map(f => ({id: f.id, name: f.name || '', type: f.type || 'any', desc: f.desc || ''}))})),
      outcomes: (lib.outcomes || []).map(x => ({id: x.id, name: x.name || '', verdict: x.verdict || '', desc: x.desc || ''})),
      verdicts: (lib.verdicts || []).map(v => ({key: v.key, name: v.name || '', color: v.color || ''})),
      fieldTypes: TYPES.map(t => ({key: t.key, name: t.name, color: t.color})),
    },
    profiles: (flow.profiles || []).map(p => ({id: p.id, name: p.name || '', selection: p.sel || {}})),
    stages, issues,
  };
}
