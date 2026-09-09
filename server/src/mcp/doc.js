// Операции над документом доски.
//
// ВНИМАНИЕ, это сознательное исключение из правила «сервер документ не разбирает».
// Правило было про хранение: boards.js кладёт документ текстом и не ломается от
// новых полей. Здесь другая задача — дать Claude менять доску, а менять то, чего
// не понимаешь, нельзя.
//
// Чтобы исключение не превратилось во вторую реализацию формата, весь код ниже
// подчинён одному условию: НЕИЗВЕСТНЫЕ ПОЛЯ НЕ ТРОГАЮТСЯ. Мы читаем и пишем
// только то, что перечислено явно, и никогда не пересобираем объекты целиком.
// Клиент может добавить в узел что угодно — оно переживёт правку отсюда.

const uid = p => p + '_' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);

export const PAGE_KINDS = ['canvas', 'space', 'table', 'board', 'dash'];
export const SHAPES = ['rect', 'pill', 'diamond'];
export const LINK_STYLES = ['solid', 'dashed'];
export const FIELD_TYPES = ['text', 'longtext', 'select', 'list', 'number', 'date'];
export const SCHEMA_KINDS = { nodeType: 'nodeTypes', status: 'statuses', category: 'categories', linkType: 'linkTypes' };

export class DocError extends Error {}
export const fail = m => { throw new DocError(m); };

/* ---------- общее ---------- */

// Ключи в схеме человекочитаемые: они попадают в экспорт и в CSV, где «st_x7f2»
// ничего не говорит тому, кто открыл файл.
export function keyFrom(name, taken) {
  const translit = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
    к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h',
    ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
  let base = String(name || '').toLowerCase().split('').map(c => translit[c] ?? c)
    .join('').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'k';
  let k = base, i = 2;
  while (taken.includes(k)) k = base + '_' + i++;
  return k;
}

const findNode = (doc, id) => doc.nodes.find(n => n.id === id);
const need = (doc, id) => findNode(doc, id) || fail(`узла ${id} нет на доске`);

// Значение статуса/категории/типа принимаем и ключом, и названием: модель видит
// в сводке названия, и требовать от неё ключ — значит гарантировать промахи.
function resolveKey(list, v, what) {
  if (v == null || v === '') return null;
  const s = String(v);
  const hit = list.find(x => x.key === s) || list.find(x => String(x.name).toLowerCase() === s.toLowerCase());
  if (!hit) fail(`${what} «${s}» нет в схеме доски. Есть: ${list.map(x => x.key + ' (' + x.name + ')').join(', ')}`);
  return hit.key;
}

/* ---------- сводка ---------- */

// Компактный вид доски для модели. Целиком документ — это сотни килобайт, из которых
// девять десятых это координаты и служебные поля; в контекст их тащить незачем.
export function summarize(doc, opts = {}) {
  const S = doc.schema || {};
  // Страницы, на которых узел вообще может стоять в координатах.
  const spatial = (doc.pages || []).filter(p => p.kind === 'canvas' || p.kind === 'space').map(p => p.id);
  const short = n => {
    const o = { id: n.id, name: n.name };
    if (n.sub) o.sub = n.sub;
    if (n.status) o.status = n.status;
    if (n.cat) o.category = n.cat;
    if (n.type) o.type = n.type;
    if (n.draft) o.draft = 1;
    if (n.body && opts.body) o.body = n.body;
    if (n.checks && n.checks.length) o.checks = n.checks.map(c => ({ text: c.t, status: c.s, blocking: !!c.b, note: c.z || '' }));
    if (n.f && Object.keys(n.f).length) o.fields = n.f;
    if (opts.layout) {
      // lane — ручная колонка на холсте с авто-раскладкой, общая для всех таких
      // страниц доски. null означает «считать глубину зависимости самому».
      o.lane = (n.lane == null || n.lane === '') ? null : +n.lane;
      const pos = {};
      for (const pid of spatial) if (n.p && n.p[pid]) pos[pid] = { x: n.p[pid].x, y: n.p[pid].y };
      if (Object.keys(pos).length) o.positions = pos;
      if (n.sz) {
        const sz = {};
        for (const pid of spatial) if (n.sz[pid]) sz[pid] = { w: n.sz[pid].w, h: n.sz[pid].h };
        if (Object.keys(sz).length) o.sizes = sz;
      }
    }
    return o;
  };
  const pinnedOn = pid => (doc.nodes || []).filter(n => n.p && n.p[pid]).length;
  const out = {
    name: doc.name || '',
    description: doc.desc || '',
    schema: {
      nodeTypes: (S.nodeTypes || []).map(x => ({ key: x.key, name: x.name, shape: x.shape || 'rect' })),
      statuses: (S.statuses || []).map(x => ({ key: x.key, name: x.name, color: x.color })),
      categories: (S.categories || []).map(x => ({ key: x.key, name: x.name, color: x.color })),
      linkTypes: (S.linkTypes || []).map(x => ({ key: x.key, name: x.name, style: x.style || 'solid', blocking: !!x.blocking })),
      fields: (S.fields || []).map(x => ({ key: x.key, label: x.label, type: x.type, options: x.options || undefined })),
    },
    pages: (doc.pages || []).map(p => {
      const o = {
        id: p.id, name: p.name, kind: p.kind,
        layout: p.canvas ? p.canvas.layout : undefined,
        lanes: p.canvas && p.canvas.lanes && p.canvas.lanes.length ? p.canvas.lanes : undefined,
        groupBy: p.board ? p.board.groupBy : undefined,
        columns: p.table ? p.table.cols : undefined,
        filter: filterSummary(p.filter),
      };
      if (opts.layout && (p.kind === 'canvas' || p.kind === 'space')) {
        o.nodes_pinned = pinnedOn(p.id);
        // Камера обычно живёт в браузере, а не в документе: она у каждого своя.
        // В документе она бывает у файлов старых версий — тогда и отдаём.
        if (p.view && isFinite(p.view.k)) o.view = { x: p.view.x, y: p.view.y, k: p.view.k };
      }
      return o;
    }),
  };
  if (opts.pagesOnly) return out;
  out.nodes = (doc.nodes || []).map(short);
  out.links = (doc.links || []).map(l => ({ from: l.from, to: l.to, type: l.type }));
  out.frames = (doc.frames || []).map(f => ({ id: f.id, name: f.name, x: f.x, y: f.y, w: f.w, h: f.h }));
  out.notes = (doc.notes || []).map(t => ({ id: t.id, text: t.text, x: t.x, y: t.y }));
  return out;
}

function filterSummary(f) {
  if (!f) return undefined;
  const o = {};
  if (f.q) o.query = f.q;
  if (f.cats && f.cats.length) o.categories = f.cats;
  if (f.statuses && f.statuses.length) o.statuses = f.statuses;
  if (f.types && f.types.length) o.types = f.types;
  if (f.blockersOnly) o.blockersOnly = true;
  if (f.f && Object.keys(f.f).length) o.fields = f.f;
  return Object.keys(o).length ? o : undefined;
}

/* ---------- узлы ---------- */

export function addNodes(doc, list) {
  const S = doc.schema;
  const made = [];
  for (const raw of list) {
    if (!raw || !String(raw.name || '').trim()) fail('у узла должно быть название');
    const n = {
      id: raw.id && !findNode(doc, raw.id) ? String(raw.id) : uid('n'),
      name: String(raw.name).trim(),
      sub: String(raw.sub || ''),
      type: resolveKey(S.nodeTypes, raw.type, 'типа узла') || S.nodeTypes[0].key,
      status: resolveKey(S.statuses, raw.status, 'статуса') || S.statuses[S.statuses.length - 1].key,
      cat: resolveKey(S.categories, raw.category, 'категории') || S.categories[0].key,
      body: String(raw.body || ''),
      draft: raw.draft ? 1 : 0,
      lane: null, x: null, y: null, pinned: 0,
      f: {}, checks: [], p: {},
    };
    applyFields(doc, n, raw.fields);
    applyChecks(doc, n, raw.checks);
    doc.nodes.push(n);
    made.push({ id: n.id, name: n.name });
  }
  return made;
}

function applyFields(doc, n, fields) {
  if (!fields || typeof fields !== 'object') return;
  const known = (doc.schema.fields || []);
  for (const [k, v] of Object.entries(fields)) {
    const f = known.find(x => x.key === k) || known.find(x => String(x.label).toLowerCase() === String(k).toLowerCase());
    if (!f) fail(`поля «${k}» нет в схеме доски. Есть: ${known.map(x => x.key).join(', ') || '(ни одного)'}`);
    if (v == null || v === '') { delete n.f[f.key]; continue; }
    n.f[f.key] = f.type === 'list' ? (Array.isArray(v) ? v.map(String) : String(v).split(/\s*[|;]\s*/)) : String(v);
  }
}

function applyChecks(doc, n, checks) {
  if (!Array.isArray(checks)) return;
  n.checks = checks.map(c => ({
    t: String(c.text || c.t || ''),
    s: resolveKey(doc.schema.statuses, c.status ?? c.s, 'статуса вехи') || doc.schema.statuses[doc.schema.statuses.length - 1].key,
    b: (c.blocking ?? c.b) ? 1 : 0,
    z: String(c.note || c.z || ''),
  })).filter(c => c.t);
}

export function updateNodes(doc, list) {
  const S = doc.schema;
  const touched = [];
  for (const raw of list) {
    const n = need(doc, raw.id);
    // Присваиваем ТОЛЬКО присланное: объект не пересобирается, и всё, чего мы
    // не знаем (позиции на страницах, чужие поля), остаётся на месте.
    if (raw.name !== undefined) n.name = String(raw.name).trim() || n.name;
    if (raw.sub !== undefined) n.sub = String(raw.sub);
    if (raw.body !== undefined) n.body = String(raw.body);
    if (raw.draft !== undefined) n.draft = raw.draft ? 1 : 0;
    if (raw.status !== undefined) n.status = resolveKey(S.statuses, raw.status, 'статуса') || n.status;
    if (raw.category !== undefined) n.cat = resolveKey(S.categories, raw.category, 'категории') || n.cat;
    if (raw.type !== undefined) n.type = resolveKey(S.nodeTypes, raw.type, 'типа узла') || n.type;
    // Колонка на холсте с авто-раскладкой. Поле общее для доски, а не постраничное —
    // так устроен сам документ, и делать вид, что оно постраничное, было бы враньём.
    if (raw.lane !== undefined) n.lane = raw.lane === null || raw.lane === '' ? null : Math.max(0, Math.round(+raw.lane));
    applyFields(doc, n, raw.fields);
    if (raw.checks !== undefined) applyChecks(doc, n, raw.checks);
    touched.push(n.id);
  }
  return touched;
}

export function deleteNodes(doc, ids) {
  const set = new Set(ids.map(String));
  const gone = doc.nodes.filter(n => set.has(n.id)).map(n => n.id);
  if (!gone.length) fail('таких узлов на доске нет');
  doc.nodes = doc.nodes.filter(n => !set.has(n.id));
  // Связь в никуда — это мусор, который потом рисуется линией в пустоту.
  const before = doc.links.length;
  doc.links = doc.links.filter(l => !set.has(l.from) && !set.has(l.to));
  return { nodes: gone, links_removed: before - doc.links.length };
}

/* ---------- связи ---------- */

// Направление: from → to читается как «from держит to», то есть to заблокирован,
// пока не закрыт from. Это главное отношение всего инструмента, и путать его нельзя.
export function addLinks(doc, list, opts = {}) {
  const made = [], skipped = [], warnings = [];
  for (const raw of list) {
    const from = need(doc, raw.from).id, to = need(doc, raw.to).id;
    if (from === to) fail('узел не может блокировать сам себя');
    if (doc.links.some(l => l.from === from && l.to === to)) {
      // Повторный вызов не должен быть ошибкой: агент, потерявший ответ, повторит
      // запрос, и падать на этом значит требовать от него безошибочной памяти.
      if (opts.onDuplicate === 'error') fail(`связь ${from} → ${to} уже есть`);
      skipped.push({ from, to, reason: 'уже есть' });
      continue;
    }
    const type = linkType(doc, raw.type, warnings);
    if (createsCycle(doc, from, to)) fail(`связь ${from} → ${to} замкнула бы круг: тогда ни один из узлов нельзя закрыть первым`);
    doc.links.push({ id: uid('l'), from, to, type });
    made.push({ from, to, type });
  }
  return { made, skipped, warnings };
}

// Тип связи, которого нет в схеме, — не повод отбросить связь. Отброшенная связь
// это молча потерянные данные; заведённый тип видно в схеме и легко поправить.
export function linkType(doc, want, warnings) {
  const list = doc.schema.linkTypes;
  if (want == null || want === '') return list[0].key;
  const s = String(want);
  const hit = list.find(x => x.key === s) || list.find(x => String(x.name).toLowerCase() === s.toLowerCase());
  if (hit) return hit.key;
  const made = { key: s.replace(/[^\w-]+/g, '_').slice(0, 24) || keyFrom(s, list.map(x => x.key)),
    name: s, color: '#9aa1b2', style: 'solid', blocking: 0 };
  if (list.some(x => x.key === made.key)) made.key = keyFrom(s, list.map(x => x.key));
  list.push(made);
  if (warnings) warnings.push(`типа связи «${s}» в схеме не было — завёл его (сплошная линия, не считается зависимостью)`);
  return made.key;
}

// Круг в зависимостях — это не «сложный граф», а неразрешимое условие: каждый
// узел ждёт другого. В приложении такая связь тоже отклоняется.
function createsCycle(doc, from, to) {
  const out = {};
  for (const l of doc.links) (out[l.from] = out[l.from] || []).push(l.to);
  (out[from] = out[from] || []).push(to);
  const seen = new Set(), stack = [to];
  while (stack.length) {
    const cur = stack.pop();
    if (cur === from) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const nx of out[cur] || []) stack.push(nx);
  }
  return false;
}

export function deleteLinks(doc, list) {
  let n = 0;
  for (const raw of list) {
    const before = doc.links.length;
    doc.links = doc.links.filter(l => !(l.from === String(raw.from) && l.to === String(raw.to)));
    n += before - doc.links.length;
  }
  if (!n) fail('таких связей нет');
  return n;
}

/* ---------- схема ---------- */

export function addSchemaItem(doc, kind, item) {
  const listName = SCHEMA_KINDS[kind] || fail(`неизвестный вид: ${kind}. Есть: ${Object.keys(SCHEMA_KINDS).join(', ')}`);
  const list = doc.schema[listName];
  const name = String(item.name || '').trim() || fail('нужно название');
  if (list.some(x => String(x.name).toLowerCase() === name.toLowerCase())) fail(`«${name}» уже есть`);
  const key = item.key ? String(item.key) : keyFrom(name, list.map(x => x.key));
  const made = { key, name };
  if (kind === 'nodeType') made.shape = SHAPES.includes(item.shape) ? item.shape : 'rect';
  if (kind === 'status' || kind === 'category') made.color = /^#[0-9a-f]{6}$/i.test(item.color || '') ? item.color : '#9aa1b2';
  if (kind === 'linkType') {
    made.color = /^#[0-9a-f]{6}$/i.test(item.color || '') ? item.color : '#9aa1b2';
    made.style = LINK_STYLES.includes(item.style) ? item.style : 'solid';
    // blocking решает, считается ли связь в вес узла и в критический путь:
    // мягкая связь рисуется, но зависимостью не является.
    made.blocking = item.blocking === false ? 0 : 1;
  }
  list.push(made);
  return made;
}

export function updateSchemaItem(doc, kind, key, patch) {
  const listName = SCHEMA_KINDS[kind] || fail(`неизвестный вид: ${kind}`);
  const it = doc.schema[listName].find(x => x.key === key) || fail(`${kind} «${key}» не найден`);
  if (patch.name !== undefined) it.name = String(patch.name);
  if (patch.color !== undefined && /^#[0-9a-f]{6}$/i.test(patch.color)) it.color = patch.color;
  if (patch.shape !== undefined && SHAPES.includes(patch.shape)) it.shape = patch.shape;
  if (patch.style !== undefined && LINK_STYLES.includes(patch.style)) it.style = patch.style;
  if (patch.blocking !== undefined) it.blocking = patch.blocking ? 1 : 0;
  return it;
}

export function deleteSchemaItem(doc, kind, key) {
  const listName = SCHEMA_KINDS[kind] || fail(`неизвестный вид: ${kind}`);
  const list = doc.schema[listName];
  if (list.length < 2) fail('это последнее значение — без него доска сломается');
  const idx = list.findIndex(x => x.key === key);
  if (idx < 0) fail(`${kind} «${key}» не найден`);
  const fallback = list[idx === 0 ? 1 : 0].key;
  list.splice(idx, 1);
  // Узлы не должны остаться со ссылкой на то, чего больше нет: иначе доска
  // рисуется серым и «статус не проставлен» появляется там, где его не ставили.
  const field = { nodeType: 'type', status: 'status', category: 'cat' }[kind];
  if (field) for (const n of doc.nodes) if (n[field] === key) n[field] = fallback;
  if (kind === 'status') for (const n of doc.nodes) for (const c of n.checks || []) if (c.s === key) c.s = fallback;
  if (kind === 'linkType') for (const l of doc.links) if (l.type === key) l.type = fallback;
  return { removed: key, movedTo: fallback };
}

export function addField(doc, item) {
  const name = String(item.label || item.name || '').trim() || fail('нужна подпись поля');
  const type = FIELD_TYPES.includes(item.type) ? item.type : 'text';
  const key = item.key ? String(item.key) : keyFrom(name, doc.schema.fields.map(x => x.key));
  if (doc.schema.fields.some(x => x.key === key)) fail(`поле «${key}» уже есть`);
  const f = { key, label: name, type, card: item.showOnCard ? 1 : 0 };
  if (type === 'select') f.options = Array.isArray(item.options) ? item.options.map(String) : [];
  doc.schema.fields.push(f);
  return f;
}

export function deleteField(doc, key) {
  const idx = doc.schema.fields.findIndex(x => x.key === key);
  if (idx < 0) fail(`поля «${key}» нет`);
  doc.schema.fields.splice(idx, 1);
  for (const n of doc.nodes) delete n.f[key];
  return key;
}

/* ---------- страницы ---------- */

export function addPage(doc, raw) {
  const kind = PAGE_KINDS.includes(raw.kind) ? raw.kind : 'canvas';
  const p = {
    id: uid('p'),
    name: String(raw.name || '').trim() || 'Страница',
    kind,
    filter: { q: '', cats: [], statuses: [], types: [], f: {} },
  };
  if (kind === 'canvas') p.canvas = { layout: raw.layout === 'free' ? 'free' : 'auto', lanes: Array.isArray(raw.lanes) ? raw.lanes.map(String) : [] };
  if (kind === 'space') p.space = {};
  if (kind === 'table') p.table = { cols: Array.isArray(raw.columns) ? raw.columns.map(String) : ['name', 'cat', 'status', 'step', 'weight'], sort: 'name', dir: 1, group: '' };
  if (kind === 'board') p.board = { groupBy: String(raw.groupBy || 'status') };
  applyFilter(doc, p, raw.filter);
  doc.pages.push(p);
  return { id: p.id, name: p.name, kind: p.kind };
}

export function updatePage(doc, id, raw) {
  const p = doc.pages.find(x => x.id === id) || fail(`страницы ${id} нет`);
  if (raw.name !== undefined) p.name = String(raw.name).trim() || p.name;
  if (raw.layout !== undefined && p.canvas) p.canvas.layout = raw.layout === 'free' ? 'free' : 'auto';
  if (raw.lanes !== undefined && p.canvas) {
    p.canvas.lanes = Array.isArray(raw.lanes) ? raw.lanes.map(String) : [];
    // Узел, закреплённый за колонкой, которой больше нет, иначе просто исчезал бы
    // с холста: раскладка не знает, куда его ставить. Возвращаем на авто.
    const len = p.canvas.lanes.length;
    for (const n of doc.nodes) if (n.lane != null && +n.lane >= len) n.lane = null;
  }
  if (raw.intro !== undefined && (p.canvas || p.space)) {
    const cfg = p.canvas || p.space;
    cfg.intro = String(raw.intro);
    delete cfg.introOff;
  }
  if (raw.groupBy !== undefined && p.board) p.board.groupBy = String(raw.groupBy);
  if (raw.columns !== undefined && p.table) p.table.cols = raw.columns.map(String);
  if (raw.sort !== undefined && p.table) p.table.sort = String(raw.sort);
  if (raw.group !== undefined && p.table) p.table.group = String(raw.group);
  if (raw.filter !== undefined) applyFilter(doc, p, raw.filter);
  return { id: p.id, name: p.name, kind: p.kind };
}

function applyFilter(doc, p, f) {
  if (!f || typeof f !== 'object') return;
  const S = doc.schema;
  p.filter = p.filter || { q: '', cats: [], statuses: [], types: [], f: {} };
  if (f.query !== undefined) p.filter.q = String(f.query || '');
  if (f.categories !== undefined) p.filter.cats = (f.categories || []).map(v => resolveKey(S.categories, v, 'категории'));
  if (f.statuses !== undefined) p.filter.statuses = (f.statuses || []).map(v => resolveKey(S.statuses, v, 'статуса'));
  if (f.types !== undefined) p.filter.types = (f.types || []).map(v => resolveKey(S.nodeTypes, v, 'типа узла'));
  if (f.blockersOnly !== undefined) p.filter.blockersOnly = f.blockersOnly ? 1 : 0;
  if (f.fields !== undefined) {
    p.filter.f = {};
    for (const [k, v] of Object.entries(f.fields || {})) p.filter.f[k] = Array.isArray(v) ? v.map(String) : [String(v)];
  }
}

export function deletePage(doc, id) {
  if (doc.pages.length < 2) fail('это последняя страница — доска не может остаться без единого вида');
  const idx = doc.pages.findIndex(p => p.id === id);
  if (idx < 0) fail(`страницы ${id} нет`);
  const [gone] = doc.pages.splice(idx, 1);
  // Позиции узлов на этой странице больше не нужны: страницы нет, а поле останется
  // висеть в каждом узле и уедет в экспорт.
  for (const n of doc.nodes) { if (n.p) delete n.p[id]; if (n.sz) delete n.sz[id]; }
  return { id: gone.id, name: gone.name };
}

export function reorderPages(doc, order) {
  const byId = new Map(doc.pages.map(p => [p.id, p]));
  const out = [];
  for (const id of order) { const p = byId.get(id); if (p && !out.includes(p)) out.push(p); }
  for (const p of doc.pages) if (!out.includes(p)) out.push(p);
  doc.pages = out;
  return doc.pages.map(p => ({ id: p.id, name: p.name }));
}

/* ---------- раскладка на холсте ---------- */

// Позиция хранится ПОСТРАНИЧНО (n.p[pageId]): один и тот же узел стоит по-разному
// на разных холстах, и это главное свойство модели «одни узлы — много видов».
export function placeNodes(doc, pageId, list) {
  const p = doc.pages.find(x => x.id === pageId) || fail(`страницы ${pageId} нет`);
  if (p.kind !== 'canvas' && p.kind !== 'space') fail(`на странице «${p.name}» (${p.kind}) узлы не расставляются: это не холст`);
  const done = [];
  for (const raw of list) {
    const n = need(doc, raw.node ?? raw.id);
    n.p = n.p || {};
    n.p[pageId] = { x: Math.round(+raw.x || 0), y: Math.round(+raw.y || 0) };
    if (raw.w || raw.h) {
      n.sz = n.sz || {};
      n.sz[pageId] = { w: Math.max(120, Math.round(+raw.w || 210)), h: Math.max(52, Math.round(+raw.h || 64)) };
    }
    done.push(n.id);
  }
  return done;
}

export function unplaceNodes(doc, pageId, ids) {
  const list = ids && ids.length ? ids.map(String) : doc.nodes.map(n => n.id);
  let n = 0;
  for (const id of list) {
    const node = findNode(doc, id);
    if (node && node.p && node.p[pageId]) { delete node.p[pageId]; n++; }
  }
  return n;
}

/* ---------- области и заметки ---------- */

export function addFrame(doc, raw) {
  const f = {
    id: uid('f'),
    name: String(raw.name || 'Область'),
    kind: raw.kind === 'lane' ? 'lane' : 'frame',
    x: Math.round(+raw.x || 0), y: Math.round(+raw.y || 0),
    w: Math.max(80, Math.round(+raw.w || 460)), h: Math.max(60, Math.round(+raw.h || 320)),
    color: /^#[0-9a-f]{6}$/i.test(raw.color || '') ? raw.color : '',
  };
  doc.frames.push(f);
  return f;
}

export function updateFrame(doc, id, raw) {
  const f = doc.frames.find(x => x.id === id) || fail(`области ${id} нет`);
  for (const k of ['x', 'y', 'w', 'h']) if (raw[k] !== undefined) f[k] = Math.round(+raw[k]);
  if (raw.name !== undefined) f.name = String(raw.name);
  if (raw.color !== undefined) f.color = /^#[0-9a-f]{6}$/i.test(raw.color) ? raw.color : '';
  return f;
}

export function deleteFrame(doc, id) {
  const i = doc.frames.findIndex(x => x.id === id);
  if (i < 0) fail(`области ${id} нет`);
  doc.frames.splice(i, 1);
  return id;
}

export function addNote(doc, raw) {
  const t = {
    id: uid('t'),
    text: String(raw.text || 'Заметка'),
    x: Math.round(+raw.x || 0), y: Math.round(+raw.y || 0),
    w: Math.max(80, Math.round(+raw.w || 200)), h: Math.max(50, Math.round(+raw.h || 96)),
    color: /^#[0-9a-f]{6}$/i.test(raw.color || '') ? raw.color : '',
  };
  doc.notes.push(t);
  return t;
}

export function updateNote(doc, id, raw) {
  const t = doc.notes.find(x => x.id === id) || fail(`заметки ${id} нет`);
  if (raw.text !== undefined) t.text = String(raw.text);
  for (const k of ['x', 'y', 'w', 'h']) if (raw[k] !== undefined) t[k] = Math.round(+raw[k]);
  if (raw.color !== undefined) t.color = /^#[0-9a-f]{6}$/i.test(raw.color) ? raw.color : '';
  return t;
}

export function deleteNote(doc, id) {
  const i = doc.notes.findIndex(x => x.id === id);
  if (i < 0) fail(`заметки ${id} нет`);
  doc.notes.splice(i, 1);
  return id;
}

/* ---------- метрики ---------- */

// То же, что считает приложение: вес узла — сколько всего откроется, если его
// закрыть. Модель должна отвечать на «что взять первым» теми же числами,
// которые человек видит на экране.
export function metrics(doc) {
  const blocking = new Set((doc.schema.linkTypes || []).filter(t => t.blocking).map(t => t.key));
  const kids = {}, parents = {};
  for (const l of doc.links) {
    if (!blocking.has(l.type)) continue;
    (kids[l.from] = kids[l.from] || []).push(l.to);
    (parents[l.to] = parents[l.to] || []).push(l.from);
  }
  const weight = id => {
    const seen = new Set(), stack = [...(kids[id] || [])];
    while (stack.length) { const c = stack.pop(); if (seen.has(c)) continue; seen.add(c); for (const k of kids[c] || []) stack.push(k); }
    return seen.size;
  };
  const nodes = doc.nodes.map(n => ({
    id: n.id, name: n.name, status: n.status,
    weight: weight(n.id),
    blockedBy: (parents[n.id] || []),
    ready: (parents[n.id] || []).length === 0,
  }));
  return {
    nodes: nodes.sort((a, b) => b.weight - a.weight),
    ready: nodes.filter(n => n.ready).map(n => n.name),
  };
}

export { uid };
