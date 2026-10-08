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
