// Данные конструктора: нормализация, идентификаторы, операции над библиотекой.
// В отличие от rules.js, модуль знает про документ доски целиком (страницы,
// P.flowLib), но по-прежнему без DOM и React — его зовёт и normalize() приложения.
import {defaultFlow, defaultLib, DEFAULT_VERDICTS, LIB_KINDS, canConnect, socketOf, nodeSize, fitStage, absPos, itemOf} from './rules.js';

const arr = v => (Array.isArray(v) ? v : []);
const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);

// Досыпаем только то, без чего код упал бы на чтении: массивы, которые обходят,
// и вложенные объекты. Текстовые поля не трогаем — пустое и отсутствующее читаются
// одинаково, а лишние "" раздували бы документ, собранный через MCP по частям.
// Порядок ключей существующих объектов не меняется: недостающее дописывается в конец.
export function normalizeFlow(f) {
  const d = defaultFlow();
  f = obj(f);
  if (!f) return d;
  f.nodes = arr(f.nodes).filter(n => n && typeof n === 'object' && n.id && n.k);
  f.edges = arr(f.edges).filter(e => e && typeof e === 'object' && e.id && e.s && e.t);
  f.profiles = arr(f.profiles).filter(p => p && p.id);
  for (const p of f.profiles) p.sel = obj(p.sel) || {};
  if (f.profile === undefined) f.profile = null;
  f.show = obj(f.show) || d.show;
  for (const k of Object.keys(d.show)) if (f.show[k] === undefined) f.show[k] = d.show[k];
  if (typeof f.overlay !== 'string') f.overlay = '';
  return f;
}

export function normalizeLib(l) {
  l = obj(l);
  if (!l) return defaultLib();
  if (!l.v) l.v = 1;
  for (const k of ['dims', 'sources', 'checks', 'outcomes']) l[k] = arr(l[k]).filter(x => x && x.id);
  // Пустой список вердиктов — это потерянный список, а не намеренно пустой:
  // проверка без единого вида последствия теряет смысл, и правило «удалять
  // только неиспользуемые» не дало бы удалить последний руками.
  if (!Array.isArray(l.verdicts) || !l.verdicts.length) l.verdicts = DEFAULT_VERDICTS.map(v => ({...v}));
  else l.verdicts = l.verdicts.filter(v => v && v.key);
  for (const d of l.dims) d.values = arr(d.values).filter(v => v && v.id);
  for (const s of l.sources) s.fields = arr(s.fields).filter(f => f && f.id);
  for (const c of l.checks) {
    c.inputs = arr(c.inputs).filter(i => i && i.id);
    c.verdicts = arr(c.verdicts);
    c.factors = arr(c.factors);
    if (!obj(c.bank)) c.bank = {status: 'none', comment: ''};
  }
  return l;
}

// Нужна ли доске библиотека. Документ без конструктора обязан сохраняться
// байт-в-байт как в 2.8.0, поэтому flowLib появляется только вместе с первой
// страницей-конструктором (или если её уже принесли в файле).
export const needsLib = doc => !!(doc && (doc.flowLib || (doc.pages || []).some(p => p && p.kind === 'flow')));

// Блок библиотеки по виду ноды и ссылке.
export function libItem(lib, kind, ref) {
  const sec = LIB_KINDS[kind];
  if (!sec || !lib) return null;
  return (lib[sec] || []).find(x => x.id === ref) || null;
}

/* ---------- идентификаторы ---------- */
let seq = Date.now() % 1e6;
// Короткий и читаемый id с проверкой на занятость: внутри страницы и внутри
// каждого раздела библиотеки id обязаны быть уникальными (ТЗ §6.3 п. 6).
export function newId(prefix, taken) {
  for (;;) {
    const id = prefix + (++seq).toString(36) + Math.floor(Math.random() * 1296).toString(36);
    if (!taken || !(taken.has ? taken.has(id) : taken.includes(id))) return id;
  }
}
const idsOf = list => new Set(list.map(x => x.id));

/* ---------- операции над конвейером ----------
   Все — по месту, над объектом страницы. Снимок для отмены и save() — дело
   вызывающего: модель не знает ни про undo, ни про сервер. */

// Соединить по правилам rules.js. Занятый вход данных освобождается в той же
// операции; «один из» с типом any запоминает тип первой связи.
export function connect(flow, lib, c, extra) {
  const r = canConnect(flow, lib, c);
  if (!r.ok) return r;
  if (r.replace.length) flow.edges = flow.edges.filter(e => !r.replace.includes(e.id));
  const e = Object.assign({id: newId('e', idsOf(flow.edges)), s: c.source, sh: c.sourceHandle, t: c.target, th: c.targetHandle}, extra || {});
  flow.edges.push(e);
  for (const id of [c.source, c.target]) {
    const n = flow.nodes.find(x => x.id === id);
    if (n && n.k === 'anyof' && (!n.data || !n.data.type || n.data.type === 'any')) {
      const s = socketOf(flow, lib, c.source, c.sourceHandle, 'out');
      if (s && s.kind === 'data' && s.type && s.type !== 'any') { n.data = n.data || {}; n.data.type = s.type; }
    }
  }
  return {ok: true, edge: e, replaced: r.replace};
}

// Удалить ноды и все их связи. Дети удаляемой рамки остаются на схеме на тех же
// местах: стереть этап вместе с двадцатью проверками одним Delete — не то,
// чего ждёт человек, выделивший рамку.
export function deleteNodes(flow, ids) {
  const del = new Set(ids);
  for (const n of flow.nodes) {
    if (n.parent && del.has(n.parent) && !del.has(n.id)) {
      const p = absPos(flow, n);
      delete n.parent; n.x = p.x; n.y = p.y;
    }
  }
  const before = flow.edges.length;
  flow.nodes = flow.nodes.filter(n => !del.has(n.id));
  flow.edges = flow.edges.filter(e => !del.has(e.s) && !del.has(e.t));
  return {nodes: ids.length, edges: before - flow.edges.length};
}
export function deleteEdges(flow, ids) {
  const del = new Set(ids);
  const before = flow.edges.length;
  flow.edges = flow.edges.filter(e => !del.has(e.id));
  return before - flow.edges.length;
}

// Рамки этапов всегда раньше детей: так их рисует React Flow (родитель до
// потомков) и так они лежат под остальным — порядок в массиве = порядок наложения.
export function orderStages(flow) {
  const st = flow.nodes.filter(n => n.k === 'stage'), rest = flow.nodes.filter(n => n.k !== 'stage');
  flow.nodes = st.concat(rest);
}

// В рамку кладутся «рабочие» ноды. Измерения, источники и исходы — общие для
// всего конвейера, их место вне этапов; рамка в рамке запрещена (§6.3 п. 5).
export const NESTABLE = new Set(['check', 'calc', 'anyof', 'note', 'reroute']);

// Нода отпущена в точке abs (центр, мировые координаты): найти рамку под ней
// и перевесить. Возвращает затронутые рамки, чтобы их подогнать.
export function reparent(flow, lib, node, sizeOf) {
  if (!NESTABLE.has(node.k)) return [];
  const sz = (sizeOf || (n => nodeSize(flow, lib, n)))(node);
  const a = absPos(flow, node), cx = a.x + sz.w / 2, cy = a.y + sz.h / 2;
  let target = null;
  for (const s of flow.nodes) {
    if (s.k !== 'stage' || s.id === node.id) continue;
    const w = +s.w || 360, h = +s.h || 200;
    if (cx >= s.x && cx <= s.x + w && cy >= s.y && cy <= s.y + h) target = s;   // последняя — верхняя
  }
  const was = node.parent || null, now = target ? target.id : null;
  if (was === now) return was ? [was] : [];
  if (now) { node.parent = now; node.x = Math.round(a.x - target.x); node.y = Math.round(a.y - target.y); }
  else { delete node.parent; node.x = Math.round(a.x); node.y = Math.round(a.y); }
  return [was, now].filter(Boolean);
}

// Подогнать рамки (fit:1) и записать результат: сдвиг влево/вверх двигает
// и рамку, и её детей, чтобы абсолютные места детей не поменялись.
export function refit(flow, lib, stageIds, sizeOf) {
  for (const id of new Set(stageIds)) {
    const s = flow.nodes.find(n => n.id === id && n.k === 'stage');
    if (!s || !s.fit) continue;
    const f = fitStage(flow, lib, s, sizeOf);
    if (f.dx || f.dy) for (const k of flow.nodes) if (k.parent === s.id) { k.x = Math.round(+k.x + f.dx); k.y = Math.round(+k.y + f.dy); }
    s.x = Math.round(f.x); s.y = Math.round(f.y); s.w = f.w; s.h = f.h;
  }
}

// Ctrl+J: новая рамка вокруг выделенного. Выделенные дети другой рамки
// переезжают в новую — вложенность у рамок одна.
export function wrapInStage(flow, lib, ids, sizeOf, data) {
  const sz = sizeOf || (n => nodeSize(flow, lib, n));
  const kids = flow.nodes.filter(n => ids.includes(n.id) && NESTABLE.has(n.k));
  if (!kids.length) return null;
  let x0 = Infinity, y0 = Infinity;
  for (const k of kids) { const a = absPos(flow, k); x0 = Math.min(x0, a.x); y0 = Math.min(y0, a.y); }
  const {PAD, PADT} = {PAD: 20, PADT: 56};
  const st = {id: newId('n', idsOf(flow.nodes)), k: 'stage', x: Math.round(x0 - PAD), y: Math.round(y0 - PADT),
    w: 360, h: 200, fit: 1, data: Object.assign({num: '', name: 'Новый этап', point: ''}, data || {})};
  const old = new Set();
  for (const k of kids) {
    const a = absPos(flow, k);
    if (k.parent) old.add(k.parent);
    k.parent = st.id; k.x = Math.round(a.x - st.x); k.y = Math.round(a.y - st.y);
  }
  flow.nodes.push(st);
  orderStages(flow);
  refit(flow, lib, [st.id, ...old], sz);
  return st;
}

/* ---------- буфер обмена ----------
   Копия нод и связей между ними. Буфер — JSON в localStorage, поэтому работает
   между досками; вместе с нодами едут их блоки библиотеки — в целевой доске
   их может не быть. */
export function copyNodes(doc, flow, ids) {
  const lib = doc.flowLib || {};
  const set = new Set(ids);
  // Рамка тянет за собой детей: скопировать этап без его проверок — не то, что ждут.
  for (const n of flow.nodes) if (n.parent && set.has(n.parent)) set.add(n.id);
  const nodes = flow.nodes.filter(n => set.has(n.id)).map(n => {
    const c = JSON.parse(JSON.stringify(n));
    if (c.parent && !set.has(c.parent)) { const a = absPos(flow, n); delete c.parent; c.x = a.x; c.y = a.y; }
    return c;
  });
  const edges = flow.edges.filter(e => set.has(e.s) && set.has(e.t)).map(e => JSON.parse(JSON.stringify(e)));
  const blocks = {dims: [], sources: [], checks: [], outcomes: [], verdicts: []};
  for (const n of nodes) {
    const sec = LIB_KINDS[n.k], it = itemOf(lib, n);
    if (sec && it && !blocks[sec].some(x => x.id === it.id)) blocks[sec].push(JSON.parse(JSON.stringify(it)));
  }
  // Вердикты проверок и исходов — тоже блоки: в чужой библиотеке их может не быть.
  const vk = new Set();
  for (const c of blocks.checks) for (const v of c.verdicts || []) vk.add(v);
  for (const o of blocks.outcomes) if (o.verdict) vk.add(o.verdict);
  blocks.verdicts = (lib.verdicts || []).filter(v => vk.has(v.key)).map(v => ({...v}));
  return {v: 1, kind: 'kycflow-clip', nodes, edges, blocks};
}

// Вставка. Проверка на странице стоит один раз (§6.3 п. 2), поэтому проверка,
// которая здесь уже есть, пропускается вместе со своими связями — об этом
// сообщает skipped. Блоки, которых нет в библиотеке, копируются в неё.
export function pasteClip(doc, flow, clip, at) {
  if (!clip || !Array.isArray(clip.nodes) || !clip.nodes.length) return {added: [], skipped: []};
  doc.flowLib = normalizeLib(doc.flowLib);
  const lib = doc.flowLib;
  const refMap = {dims: {}, sources: {}, checks: {}, outcomes: {}};
  for (const sec of Object.keys(refMap)) {
    for (const it of ((clip.blocks || {})[sec]) || []) {
      const have = lib[sec].find(x => x.id === it.id);
      if (have) { refMap[sec][it.id] = it.id; continue; }
      const c = JSON.parse(JSON.stringify(it));
      lib[sec].push(c);
      refMap[sec][it.id] = c.id;
    }
  }
  for (const v of ((clip.blocks || {}).verdicts) || []) if (!lib.verdicts.some(x => x.key === v.key)) lib.verdicts.push({...v});
  normalizeLib(lib);
  const onPage = new Set(flow.nodes.filter(n => n.k === 'check').map(n => n.ref));
  const skipped = [], idMap = {};
  const taken = idsOf(flow.nodes);
  // Сдвиг: левый верхний угол вставки встаёт в точку at.
  let x0 = Infinity, y0 = Infinity;
  for (const n of clip.nodes) if (!n.parent) { x0 = Math.min(x0, +n.x || 0); y0 = Math.min(y0, +n.y || 0); }
  const dx = at ? at.x - x0 : 40, dy = at ? at.y - y0 : 40;
  const added = [];
  for (const n of clip.nodes) {
    const sec = LIB_KINDS[n.k];
    const ref = sec ? (refMap[sec][n.ref] || n.ref) : undefined;
    if (n.k === 'check' && onPage.has(ref)) { skipped.push(n); continue; }
    const c = JSON.parse(JSON.stringify(n));
    c.id = newId('n', taken); taken.add(c.id); idMap[n.id] = c.id;
    if (sec) c.ref = ref;
    if (!c.parent) { c.x = Math.round((+c.x || 0) + dx); c.y = Math.round((+c.y || 0) + dy); }
    if (n.k === 'check') onPage.add(ref);
    added.push(c);
  }
  for (const c of added) if (c.parent) { if (idMap[c.parent]) c.parent = idMap[c.parent]; else delete c.parent; }
  flow.nodes.push(...added);
  orderStages(flow);
  const etaken = idsOf(flow.edges);
  for (const e of clip.edges || []) {
    if (!idMap[e.s] || !idMap[e.t]) continue;
    const c = Object.assign({}, e, {id: newId('e', etaken), s: idMap[e.s], t: idMap[e.t]});
    etaken.add(c.id);
    flow.edges.push(c);
  }
  return {added: added.map(c => c.id), skipped};
}
