// Импорт проекта целиком — одним вызовом и с отчётом.
//
// Импорт по частям (create_board → add_nodes → link_nodes) выглядит естественно,
// но разваливается ровно там, где это дороже всего заметить: идентификаторы узлов
// заменяются на новые, связи с незнакомым типом отбрасываются, страницы приезжают
// не те. Один вызов, который берёт документ целиком и отчитывается, что именно
// сделал, — единственный способ не разбирать это потом руками.
//
// Три правила, которым подчинён весь файл:
//
//   1. Идентификаторы узлов сохраняются КАК ЕСТЬ. Это произвольные строки,
//      кириллица в них законна, и переименовывать их незачем. Переименование
//      возможно только при столкновении внутри самого файла — и тогда переписываются
//      ВСЕ ссылки: связи и позиции на страницах.
//   2. Ни одна связь не теряется молча. Нет типа — тип заводится, и это в отчёте.
//   3. Ничего не создаётся сверх того, что есть в файле: ни лишних страниц,
//      ни «страницы по умолчанию».
import { PAGE_KINDS, linkType, fail, uid } from './doc.js';

const DEF_STATUSES = [
  { key: 'done', name: 'готово', color: '#18a558' },
  { key: 'work', name: 'в работе', color: '#8a5d00' },
  { key: 'block', name: 'заблокировано', color: '#b3261e' },
  { key: 'na', name: 'не начато', color: '#5f6673' },
];

export function importDoc(src, opts = {}) {
  const drop = new Set((opts.dropPages || []).map(String));
  if (!src || typeof src !== 'object') fail('нужен документ проекта — объект JSON');
  if (!Array.isArray(src.nodes)) fail('в документе нет массива nodes: это не проект Graph Studio');
  // Старый формат Roadmap Studio разбирает приложение (fromLegacy в main.js).
  // Дублировать конвертер здесь значит завести вторую его версию, которая начнёт
  // отставать от первой; честнее сказать, где его открыть.
  if (src.nodes.length && (src.nodes[0].deps !== undefined || src.nodes[0].t !== undefined) && !src.schema) {
    fail('это файл старой версии (Roadmap Studio). Откройте его в приложении: ' +
      '«Экспорт и импорт» → «JSON новой доской» — там есть конвертер');
  }

  const warnings = [];
  const S = src.schema && typeof src.schema === 'object' ? src.schema : {};
  const list = (arr, def) => (Array.isArray(arr) && arr.length ? arr : def).map(x => ({ ...x }));

  const doc = {
    name: String(opts.name || src.name || 'Импортированная доска'),
    desc: String(src.desc || ''),
    created: String(src.created || new Date().toISOString().slice(0, 10)),
    updated: new Date().toISOString().slice(0, 10),
    schema: {
      nodeTypes: list(S.nodeTypes, [{ key: 'stage', name: 'Узел', shape: 'rect' }]),
      statuses: list(S.statuses, DEF_STATUSES),
      categories: list(S.categories, [{ key: 'gen', name: 'Общее', color: '#2f6fed' }]),
      linkTypes: list(S.linkTypes, [{ key: 'hard', name: 'Жёсткая', color: '#9aa1b2', style: 'solid', blocking: 1 }]),
      fields: Array.isArray(S.fields) ? S.fields.map(x => ({ ...x })) : [],
    },
    nodes: [], links: [], frames: [], notes: [], pages: [],
  };

  /* ---- страницы: ровно те, что в файле ---- */
  const pageIds = new Set(), dropped_pages = [];
  for (const p of (Array.isArray(src.pages) ? src.pages : [])) {
    const kind = String(p.kind || 'canvas');
    if (!PAGE_KINDS.includes(kind)) {
      fail(`страница «${p.name || p.id}»: вида «${kind}» не бывает. Допустимо: ${PAGE_KINDS.join(', ')}`);
    }
    // Выбросить страницу можно только по явному указанию: решать за человека,
    // что в его файле лишнее, нельзя — но и заставлять править JSON руками,
    // когда лишнее очевидно, тоже не дело.
    if (p.id && drop.has(String(p.id))) { dropped_pages.push({ id: String(p.id), name: p.name || '' }); continue; }
    const id = p.id && !pageIds.has(String(p.id)) ? String(p.id) : uid('p');
    pageIds.add(id);
    const out = { ...p, id, kind, name: String(p.name || 'Страница') };
    out.filter = p.filter && typeof p.filter === 'object' ? p.filter : { q: '', cats: [], statuses: [], types: [], f: {} };
    if (kind === 'canvas') out.canvas = p.canvas && typeof p.canvas === 'object' ? p.canvas : { layout: 'auto', lanes: [] };
    if (kind === 'space') out.space = p.space && typeof p.space === 'object' ? p.space : {};
    doc.pages.push(out);
  }
  if (!doc.pages.length) {
    doc.pages.push({ id: uid('p'), name: 'Холст', kind: 'canvas',
      filter: { q: '', cats: [], statuses: [], types: [], f: {} }, canvas: { layout: 'auto', lanes: [] } });
    warnings.push('в файле не было ни одной страницы — завёл один холст, иначе доску нечем открыть');
  }

  /* ---- узлы: идентификаторы как есть ---- */
  const renamed = [], seen = new Set();
  for (const n of src.nodes) {
    const want = String(n.id == null ? '' : n.id).trim();
    let id = want;
    if (!id) {
      id = uid('n');
      warnings.push(`у узла «${n.name || '?'}» не было id — присвоил ${id}`);
    } else if (seen.has(id)) {
      // Два узла с одним id в одном файле — это уже сломанный файл, но терять
      // второй узел нельзя. Суффикс детерминированный: повторный импорт того же
      // файла даст те же имена.
      let i = 2, next = `${id}__${i}`;
      while (seen.has(next)) next = `${id}__${++i}`;
      renamed.push({ from: id, to: next });
      id = next;
    }
    seen.add(id);
    const node = { ...n, id };
    node.name = String(n.name == null ? id : n.name);
    node.sub = String(n.sub || '');
    node.body = String(n.body || '');
    node.f = n.f && typeof n.f === 'object' ? n.f : {};
    node.checks = Array.isArray(n.checks) ? n.checks : [];
    node.p = n.p && typeof n.p === 'object' ? n.p : {};
    doc.nodes.push(node);
  }

  // Переименование внутри файла обязано быть переписано ВЕЗДЕ, иначе связь повиснет
  // в никуда. Первое вхождение id остаётся за первым узлом, поэтому карта строится
  // только для повторов и применяется к связям ниже.
  const rename = new Map(renamed.map(r => [r.from, r.to]));

  /* ---- значения, которых нет в схеме, заводим, а не выбрасываем ---- */
  const ensure = (arr, key, mk, what) => {
    if (key == null || key === '') return arr[arr.length - 1].key;
    const hit = arr.find(x => x.key === key);
    if (hit) return hit.key;
    arr.push(mk(key));
    warnings.push(`${what} «${key}» не было в схеме — завёл`);
    return key;
  };
  for (const n of doc.nodes) {
    n.type = ensure(doc.schema.nodeTypes, n.type, k => ({ key: k, name: k, shape: 'rect' }), 'типа узла');
    n.status = ensure(doc.schema.statuses, n.status, k => ({ key: k, name: k, color: '#9aa1b2' }), 'статуса');
    n.cat = ensure(doc.schema.categories, n.cat, k => ({ key: k, name: k, color: '#9aa1b2' }), 'категории');
    for (const c of n.checks) c.s = ensure(doc.schema.statuses, c.s, k => ({ key: k, name: k, color: '#9aa1b2' }), 'статуса вехи');
    // Позиция на странице, которой в файле нет, — мусор, который поедет в экспорт.
    if (n.p) {
      const keep = {};
      for (const [pid, v] of Object.entries(n.p)) if (pageIds.has(pid)) keep[pid] = v;
      n.p = keep;
    }
    if (n.sz) {
      const keep = {};
      for (const [pid, v] of Object.entries(n.sz)) if (pageIds.has(pid)) keep[pid] = v;
      n.sz = keep;
    }
  }

  /* ---- связи: ни одной потерянной молча ---- */
  const known = new Set(doc.nodes.map(n => n.id));
  const dropped = [], pairs = new Set();
  for (const l of (Array.isArray(src.links) ? src.links : [])) {
    const from = String(l.from == null ? '' : l.from);
    const to = String(l.to == null ? '' : l.to);
    const f = rename.has(from) && !known.has(from) ? rename.get(from) : from;
    const t = rename.has(to) && !known.has(to) ? rename.get(to) : to;
    if (!known.has(f) || !known.has(t)) { dropped.push({ from, to, reason: 'такого узла нет в файле' }); continue; }
    if (f === t) { dropped.push({ from: f, to: t, reason: 'связь узла на самого себя' }); continue; }
    const key = f + ' ' + t;
    if (pairs.has(key)) { dropped.push({ from: f, to: t, reason: 'дубликат' }); continue; }
    pairs.add(key);
    doc.links.push({ id: l.id || uid('l'), from: f, to: t, type: linkType(doc, l.type, warnings) });
  }

  // Круги ищем ПОСЛЕ импорта и только предупреждаем: файл уже такой, и выбрасывать
  // из него связи молча хуже, чем показать проблему на холсте.
  const cyc = firstCycle(doc);
  if (cyc.length) {
    warnings.push('в зависимостях есть круг: ' + cyc.slice(0, 4).join(' → ') +
      (cyc.length > 4 ? ' → …' : '') + '. Приложение покажет его в «Проверить доску»');
  }

  for (const f of (Array.isArray(src.frames) ? src.frames : [])) doc.frames.push({ ...f, id: f.id || uid('f') });
  for (const t of (Array.isArray(src.notes) ? src.notes : [])) doc.notes.push({ ...t, id: t.id || uid('t') });

  // Пустой холст в файле — почти всегда след «создал и забыл». Сами не удаляем,
  // но говорим: dry_run для того и нужен, чтобы это увидеть до создания доски.
  for (const p of doc.pages) {
    if (p.kind !== 'canvas' && p.kind !== 'space') continue;
    const pinned = doc.nodes.filter(n => n.p && n.p[p.id]).length;
    const cfg = p.canvas || p.space || {};
    if (p.kind === 'space' && !pinned) {
      warnings.push(`страница «${p.name}» (${p.id}) — пустая свободная схема: на ней нет ни одного узла. ` +
        'Если она не нужна, передайте её id в drop_pages');
    } else if (p.kind === 'canvas' && !pinned && !cfg.intro && !(cfg.lanes || []).length) {
      warnings.push(`страница «${p.name}» (${p.id}) — холст без настроек и без закреплённых узлов`);
    }
  }

  return {
    doc,
    report: {
      nodes_created: doc.nodes.length,
      nodes_renamed: renamed,
      links_created: doc.links.length,
      links_dropped: dropped,
      pages_created: doc.pages.map(p => ({ id: p.id, name: p.name, kind: p.kind })),
      pages_dropped: dropped_pages,
      frames_created: doc.frames.length,
      notes_created: doc.notes.length,
      warnings,
    },
  };
}

// Первый найденный круг по блокирующим связям — чтобы было что показать в отчёте.
function firstCycle(doc) {
  const blocking = new Set((doc.schema.linkTypes || []).filter(t => t.blocking).map(t => t.key));
  const out = {};
  for (const l of doc.links) if (blocking.has(l.type)) (out[l.from] = out[l.from] || []).push(l.to);
  const state = {}, path = [];
  const walk = id => {
    if (state[id] === 2) return null;
    if (state[id] === 1) return path.slice(path.indexOf(id));
    state[id] = 1; path.push(id);
    for (const nx of out[id] || []) { const c = walk(nx); if (c) return c; }
    path.pop(); state[id] = 2;
    return null;
  };
  for (const n of doc.nodes) { const c = walk(n.id); if (c) return c; }
  return [];
}
