// Корень конструктора: холст React Flow и всё, что вокруг него.
//
// Документ P — единственный источник правды. React Flow держит СВОЁ состояние
// нод (позиции во время жеста, выделение, измеренные размеры), а мы на каждую
// правку P пересобираем его заново из документа (deriveNodes/deriveEdges),
// сохраняя то, чего в документе нет: выделение и измерения. Нода, у которой
// ничего не поменялось, переиспользуется как есть — иначе React Flow заново
// принимал бы её, сбрасывая внутренние замеры.
//
// Правка документа — только через edit(): снимок для отмены ДО изменения,
// save() после. Позиции пишутся на отпускании, а не на каждый кадр жеста —
// иначе снимок снимался бы с уже сдвинутого состояния и Ctrl+Z не возвращал бы
// ноду на место (те же грабли, что были у областей в 1.2.1).
import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {ReactFlow, ReactFlowProvider, Background, Controls, MiniMap, useReactFlow,
  applyNodeChanges, applyEdgeChanges} from '@xyflow/react';
import * as R from './rules.js';
import * as M from './model.js';
import {FlowCtx} from './ctx.js';
import {nodeTypes} from './nodes/index.js';
import TypedEdge from './edges/TypedEdge.jsx';
import ConnLine from './edges/ConnLine.jsx';
import AddMenu from './panels/AddMenu.jsx';

const edgeTypes = {typed: TypedEdge};
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
// Те же клампы, что у холста приложения (SPEC §6): иначе одна и та же доска
// на соседних страницах масштабировалась бы в разных пределах.
const MIN_K = 0.08, MAX_K = 3;
const CLIP_KEY = 'gs_flow_clip';
const BANK_MARK = {accepted: '✓', accepted_comments: '✎', discussion: '⇄', rejected: '✕'};
// На пальце одно касание по пустому месту двигает холст, а не тянет рамку
// выделения — так же, как на холсте приложения.
const COARSE = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
const MULTI_KEYS = ['Shift', 'Meta', 'Control'];
// Сверка по e.code: в русской раскладке e.key у той же клавиши другой.
const K = (e, code, letter) => e.code === code || (!!e.key && e.key.toLowerCase() === letter);
const typing = t => { const tag = (t.tagName || '').toLowerCase(); return tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable; };

// Камера — личное состояние человека: localStorage, формат {x, y, k} как у остальных
// страниц. В документ не пишется — иначе панорама одного меняла бы экран другому.
function readVp(key) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || 'null');
    if (v && isFinite(v.x) && isFinite(v.y) && isFinite(v.k)) return {x: v.x, y: v.y, zoom: clamp(v.k, MIN_K, MAX_K)};
  } catch (e) { /* испорченная запись — просто впишем схему заново */ }
  return null;
}
function writeVp(key, vp) {
  try { localStorage.setItem(key, JSON.stringify({x: Math.round(vp.x), y: Math.round(vp.y), k: +(+vp.zoom).toFixed(4)})); }
  catch (e) { /* квота или приватный режим: камера просто не запомнится */ }
}

/* ---------- документ → React Flow ---------- */

function sockColor(s, lib) {
  if (!s) return '';
  if (s.kind === 'data' || s.kind === 'any') return R.typeOf(s.type || 'any').color;
  if (s.kind === 'cond') return R.COND_COLOR;
  if (s.kind === 'verdict') return R.verdictOf(lib, s.verdict).color;
  if (s.kind === 'vin') return '#8a94a6';
  return '';   // порядок — цветом темы, его ставит CSS
}

export function nodeLabel(lib, n) {
  if (!n) return '';
  const it = R.itemOf(lib, n), d = n.data || {};
  if (n.k === 'check') return it ? `${it.code} ${it.name}` : n.ref;
  if (it) return it.name;
  if (n.k === 'stage') return `Этап ${d.num || ''} ${d.name || ''}`.trim();
  if (n.k === 'gate') return 'Гейт: ' + (d.text || '');
  if (n.k === 'anyof') return d.label || 'Один из';
  if (n.k === 'calc') return d.name || 'Показатель';
  return R.KIND_NAMES[n.k] || n.k;
}

function nodeData(n, c, conn, opt) {
  const {flow, lib} = c;
  const it = R.itemOf(lib, n), d = n.data || {};
  const dec = s => s && Object.assign({}, s, {color: sockColor(s, lib), conn: conn.has(n.id + '\u0000' + s.id)});
  const base = {k: n.k, ro: !!opt.ro, muted: !!n.muted, collapsed: !!n.collapsed};
  if (n.k === 'stage') {
    const s = R.socketsOf(flow, lib, n);
    const f = n.fit ? R.fitStage(flow, lib, n, opt.sizeOf) : null;
    return Object.assign(base, {code: d.num || '', title: d.name || '', body: d.point || '',
      w: f ? f.w : (+n.w || R.SIZE.W.stage), h: f ? f.h : (+n.h || 200), fit: !!n.fit,
      socks: {in: dec(s.ins[0]), cond: dec(s.ins[1]), out: dec(s.outs[0])}});
  }
  if (n.k === 'note') return Object.assign(base, {body: d.text || '', w: +n.w || 240, h: +n.h || 120});
  if (n.k === 'reroute') {
    const s = R.socketsOf(flow, lib, n);
    return Object.assign(base, {color: sockColor(s.outs[0], lib) || '#8a94a6', socks: {in: dec(s.ins[0]), out: dec(s.outs[0])}});
  }
  const rows = R.nodeRows(flow, lib, n).map(r => ({l: dec(r.l), r: r.r && r.r.kind === 'tbd' ? r.r : dec(r.r), add: !!r.add}));
  const out = Object.assign(base, {rows, w: R.SIZE.W[n.k] || 220, color: R.KIND_COLORS[n.k] || '#6b7280', badges: []});
  const lost = R.LIB_KINDS[n.k] && !it;
  if (lost) return Object.assign(out, {title: 'Нет в библиотеке: ' + n.ref, color: '#9aa1b2', body: null});
  switch (n.k) {
    case 'dim':
      return Object.assign(out, {title: it.name, code: it.code || '', body: null, plus: 'Добавить значение'});
    case 'source': {
      const st = it.status || 'unknown';
      if (st !== 'live') out.badges.push({t: R.nameOf(R.SOURCE_STATUSES, st).toLowerCase(),
        c: R.BAD_STATUS.has(st) ? 'fl-b-bad' : 'fl-b-warn', title: 'Статус подключения'});
      return Object.assign(out, {title: it.name, body: null, plus: 'Добавить поле'});
    }
    case 'check': {
      const b = (it.bank || {}).status;
      if (BANK_MARK[b]) out.badges.push({t: BANK_MARK[b], c: 'fl-b-bank fl-bank-' + b, title: 'Согласование банком: ' + R.nameOf(R.BANK_STATUSES, b)});
      if (it.verdictTbd) out.badges.push({t: '?', c: 'fl-b-tbd', title: 'Вердикт не определён'});
      if (it.wave && +it.wave !== 1) out.badges.push({t: 'W' + it.wave, c: 'fl-b-wave', title: 'Волна ' + it.wave});
      const h = R.checkHoles(flow, lib, n);
      if (h.unwired.length || h.noAccess.length) out.badges.push({t: '', c: 'fl-b-red', title: [
        h.unwired.length ? 'Вход без источника: ' + h.unwired.join(', ') : '',
        h.noAccess.length ? 'Источник без доступа' : ''].filter(Boolean).join('; ')});
      return Object.assign(out, {title: it.name, code: it.code || '', body: it.how || ''});
    }
    case 'outcome':
      return Object.assign(out, {title: it.name, color: R.verdictOf(lib, it.verdict).color, body: it.desc || ''});
    case 'gate':
      return Object.assign(out, {title: 'Гейт', body: d.text || ''});
    case 'anyof':
      return Object.assign(out, {title: d.label || 'Один из (по порядку)', body: null});
    case 'calc':
      return Object.assign(out, {title: d.name || 'Показатель', body: d.formula || ''});
    default:
      return out;
  }
}

function deriveNodes(c, prev, opt) {
  const {flow} = c;
  const prevById = new Map(prev.map(n => [n.id, n]));
  const conn = new Set();
  for (const e of flow.edges) { conn.add(e.s + '\u0000' + e.sh); conn.add(e.t + '\u0000' + e.th); }
  const known = new Set(flow.nodes.map(n => n.id));
  const pick = opt.pick;
  // Рамки — раньше детей: React Flow требует родителя до потомков.
  const order = flow.nodes.filter(n => n.k === 'stage').concat(flow.nodes.filter(n => n.k !== 'stage'));
  return order.map(n => {
    const data = nodeData(n, c, conn, opt);
    const sig = JSON.stringify(data);
    const p = prevById.get(n.id);
    const parentId = n.parent && known.has(n.parent) && n.parent !== n.id ? n.parent : undefined;
    const position = {x: +n.x || 0, y: +n.y || 0};
    const selected = pick ? pick.has(n.id) : !!(p && p.selected);
    // Идёт жест над этой нодой — позицию и размер держит React Flow, не трогаем.
    if (p && (p.dragging || p.resizing)) return Object.assign({}, p, {data, __sig: sig});
    if (p && p.__sig === sig && p.parentId === parentId && p.selected === selected
        && p.position.x === position.x && p.position.y === position.y) return p;
    // Слои: рамки — под всем (-1), остальные ноды — на 2. React Flow поднимает
    // связь, у которой конец сидит в рамке, до z этого конца; без общего z=2 такие
    // связи ложились бы поверх гейтов, источников и исходов верхнего уровня.
    const o = {id: n.id, type: n.k, position, data, __sig: sig, parentId, selected,
      zIndex: n.k === 'stage' ? -1 : 2,
      draggable: !opt.ro, connectable: !opt.ro && n.k !== 'note', deletable: false};
    if (p && p.measured) o.measured = p.measured;
    if (n.k === 'stage' || n.k === 'note') { o.style = {width: data.w, height: data.h}; o.width = data.w; o.height = data.h; }
    return o;
  });
}

function deriveEdges(c, prev, opt) {
  const {flow, lib} = c;
  const prevById = new Map(prev.map(e => [e.id, e]));
  const show = flow.show || {};
  const known = new Set(flow.nodes.map(n => n.id));
  const out = [];
  for (const e of flow.edges) {
    if (!known.has(e.s) || !known.has(e.t)) continue;
    const kind = R.edgeKind(flow, lib, e);
    const mode = show[kind] == null ? 1 : +show[kind];
    const hidden = mode === 0 || (mode === 2 && !opt.sel.has(e.s) && !opt.sel.has(e.t));
    const hv = opt.hover;
    const data = {kind, color: R.edgeColor(flow, lib, e), neg: !!e.neg,
      hl: !!hv && (e.s === hv || e.t === hv), dim: !!hv && e.s !== hv && e.t !== hv};
    const sig = JSON.stringify(data) + (hidden ? 'h' : '');
    const p = prevById.get(e.id);
    if (p && p.__sig === sig && p.source === e.s && p.target === e.t && p.sourceHandle === e.sh && p.targetHandle === e.th) { out.push(p); continue; }
    out.push({id: e.id, source: e.s, sourceHandle: e.sh, target: e.t, targetHandle: e.th, type: 'typed',
      data, hidden, __sig: sig, selected: !!(p && p.selected), deletable: false});
  }
  return out;
}

/* ---------- компонент ---------- */

export default function FlowApp(props) {
  return <ReactFlowProvider><FlowView {...props}/></ReactFlowProvider>;
}

function FlowView({ctx, pageId, rev, api}) {
  const rf = useReactFlow();
  const cur = useCallback(() => {
    const P = ctx.P();
    const pg = P && (P.pages || []).find(p => p.id === pageId);
    return {P, pg, flow: pg && pg.flow, lib: P && P.flowLib};
  }, [ctx, pageId]);
  const c0 = cur();
  const ro = ctx.ro();
  const rootRef = useRef(null), paneRef = useRef(null), tipRef = useRef(null);
  const ptr = useRef({x: 0, y: 0});
  const pend = useRef(null), pick = useRef(null), lastReject = useRef('');
  const [tick, setTick] = useState(0);
  const bump = useCallback(() => setTick(t => t + 1), []);
  const [menu, setMenu] = useState(null);
  const [hover, setHover] = useState(null);

  // Тема следует за body.dark. Наблюдатель, а не вызов из applyTheme(): так
  // приложению не нужно знать, что где-то есть React, а при размонтировании
  // наблюдатель снимается вместе с компонентом.
  const [dark, setDark] = useState(ctx.isDark());
  useEffect(() => {
    const mo = new MutationObserver(() => setDark(ctx.isDark()));
    mo.observe(document.body, {attributes: true, attributeFilter: ['class']});
    return () => mo.disconnect();
  }, [ctx]);

  // Размер ноды: измеренный, если React Flow её уже нарисовал, иначе оценка
  // из rules.js (та же, что у сервера). Нужен рамкам: они подгоняются под детей.
  const sizeOf = useCallback(n => {
    const ni = rf.getInternalNode(n.id);
    const m = ni && ni.measured;
    if (m && m.width && m.height && n.k !== 'stage' && n.k !== 'note') return {w: m.width, h: m.height};
    const c = cur();
    return R.nodeSize(c.flow, c.lib, n);
  }, [rf, cur]);

  /* ---------- состояние React Flow ---------- */
  const [nodes, setNodes] = useState(() => (c0.flow ? deriveNodes(c0, [], {ro, sizeOf: n => R.nodeSize(c0.flow, c0.lib, n)}) : []));
  const [edges, setEdges] = useState(() => (c0.flow ? deriveEdges(c0, [], {sel: new Set(), hover: null}) : []));
  const [fitTick, setFitTick] = useState(0);
  const selKey = useMemo(() => nodes.filter(n => n.selected).map(n => n.id).join('\u0001'), [nodes]);
  useLayoutEffect(() => {
    const c = cur(); if (!c.flow) return;
    const want = pick.current; pick.current = null;
    setNodes(prev => deriveNodes(c, prev, {ro, sizeOf, pick: want}));
  }, [rev, tick, ro, fitTick, cur, sizeOf]);
  useLayoutEffect(() => {
    const c = cur(); if (!c.flow) return;
    setEdges(prev => deriveEdges(c, prev, {sel: new Set(selKey ? selKey.split('\u0001') : []), hover}));
  }, [rev, tick, selKey, hover, cur]);

  const onNodesChange = useCallback(ch => {
    // Нода получила размеры — рамкам с fit:1 пора подогнаться. Во время ресайза
    // не трогаем: перерасчёт спорил бы с рукой.
    const measured = ch.some(x => x.type === 'dimensions' && !x.resizing);
    setNodes(ns => applyNodeChanges(ch, ns));
    if (measured) setFitTick(t => t + 1);
  }, []);
  const onEdgesChange = useCallback(ch => setEdges(es => applyEdgeChanges(ch, es)), []);

  /* ---------- правка документа ---------- */
  const edit = useCallback((fn) => {
    if (ctx.ro()) { ctx.toast('Только просмотр'); return undefined; }
    const c = cur(); if (!c.flow) return undefined;
    ctx.snapNow();
    const r = fn(c);
    ctx.save();
    bump();
    return r;
  }, [ctx, cur, bump]);
  const selIds = useCallback(() => rf.getNodes().filter(n => n.selected).map(n => n.id), [rf]);
  const selectOnly = useCallback(ids => { pick.current = new Set(ids); bump(); }, [bump]);

  /* ---------- камера ---------- */
  const vkey = ctx.viewKey(pageId);
  const initialVp = useMemo(() => readVp(vkey), [vkey]);
  const vpSave = useRef({t: null, vp: null});
  const saveVp = useCallback(vp => {
    if (ctx.viewer || !vp) return;
    const s = vpSave.current;
    s.vp = vp;
    clearTimeout(s.t);
    s.t = setTimeout(() => { writeVp(vkey, vp); s.vp = null; }, 500);
  }, [ctx, vkey]);
  // Ушли со страницы раньше, чем истёк дебаунс, — дописываем сразу,
  // иначе быстрый переход между страницами терял бы последнее движение.
  useEffect(() => () => {
    const s = vpSave.current;
    clearTimeout(s.t);
    if (s.vp) writeVp(vkey, s.vp);
  }, [vkey]);

  // Колесо — как на холсте приложения: само колесо панорамирует, Ctrl/Cmd+колесо
  // и щипок трекпада масштабируют к курсору с клампом фактора 0.82…1.22.
  // Собственный d3-zoom React Flow на Mac умножает дельту щипка на 10, и одно
  // синтетическое событие улетало в предельный масштаб (грабли SPEC §8 п. 5).
  // Слушатель нативный и в фазе захвата: React вешает wheel пассивным, и
  // preventDefault из onWheel не сработал бы.
  useEffect(() => {
    const el = paneRef.current;
    if (!el) return undefined;
    const onWheel = e => {
      if (e.target.closest && e.target.closest('.fl-nowheel')) return;
      e.preventDefault(); e.stopPropagation();
      const vp = rf.getViewport();
      let next;
      if (e.ctrlKey || e.metaKey) {
        const f = clamp(Math.exp(-e.deltaY * 0.01), 0.82, 1.22);
        const r = el.getBoundingClientRect();
        const k2 = clamp(vp.zoom * f, MIN_K, MAX_K);
        const px = e.clientX - r.left, py = e.clientY - r.top;
        const wx = (px - vp.x) / vp.zoom, wy = (py - vp.y) / vp.zoom;
        next = {x: px - wx * k2, y: py - wy * k2, zoom: k2};
      } else {
        next = {x: vp.x - e.deltaX, y: vp.y - e.deltaY, zoom: vp.zoom};
      }
      rf.setViewport(next);
      saveVp(next);
    };
    el.addEventListener('wheel', onWheel, {passive: false, capture: true});
    return () => el.removeEventListener('wheel', onWheel, {capture: true});
  }, [rf, saveVp]);

  /* ---------- соединения ---------- */
  const orient = (from, to) => (from.type === 'source'
    ? {source: from.nodeId, sourceHandle: from.id, target: to.nodeId, targetHandle: to.id}
    : {source: to.nodeId, sourceHandle: to.id, target: from.nodeId, targetHandle: from.id});
  const isValidConnection = useCallback(conn => {
    if (ctx.ro()) return false;
    const c = cur();
    return !!c.flow && R.canConnect(c.flow, c.lib, conn).ok;
  }, [ctx, cur]);
  const doConnect = useCallback((conn, extra) => {
    const c = cur();
    const chk = R.canConnect(c.flow, c.lib, conn);
    if (!chk.ok) { lastReject.current = chk.reason; ctx.toast(chk.reason); return chk; }
    return edit(x => M.connect(x.flow, x.lib, conn, extra));
  }, [ctx, cur, edit]);
  const onConnect = useCallback(conn => { doConnect(conn); }, [doConnect]);

  const connTip = useCallback(reason => {
    const t = tipRef.current, root = rootRef.current;
    if (root) root.classList.toggle('fl-badconn', !!reason);
    if (!t) return;
    if (!reason) { t.style.display = 'none'; return; }
    t.textContent = reason;
    t.style.display = 'block';
    t.style.left = (ptr.current.x + 14) + 'px';
    t.style.top = (ptr.current.y + 16) + 'px';
  }, []);

  // Ctrl+тянуть из занятого сокета — перенос всех его связей на другой сокет
  // той же стороны (как в Unreal). Каждая переносимая связь проверяется заново.
  // Ручка под курсором — по геометрии, а не elementFromPoint: во время протягивания
  // React Flow снимает pointer-events со всех ручек, которые не могут стать концом
  // связи, и ручка той же стороны для elementFromPoint невидима.
  const handleAt = (x, y, side) => {
    let best = null, bd = 16 * 16;
    for (const h of rootRef.current.querySelectorAll('.react-flow__handle.' + side)) {
      const r = h.getBoundingClientRect();
      const d = (r.left + r.width / 2 - x) ** 2 + (r.top + r.height / 2 - y) ** 2;
      if (d < bd) { bd = d; best = h; }
    }
    return best;
  };
  const relink = useCallback((p, pt) => {
    const h = handleAt(pt.clientX, pt.clientY, p.handleType);
    if (!h) return false;
    const nodeId = h.getAttribute('data-nodeid'), hid = h.getAttribute('data-handleid');
    if (nodeId === p.nodeId && hid === p.handleId) return false;
    const c = cur();
    const moving = c.flow.edges.filter(e => (p.handleType === 'source'
      ? e.s === p.nodeId && e.sh === p.handleId : e.t === p.nodeId && e.th === p.handleId));
    if (!moving.length) return false;
    edit(x => {
      let moved = 0, skipped = 0;
      for (const e of moving) {
        x.flow.edges = x.flow.edges.filter(y => y.id !== e.id);
        const conn = p.handleType === 'source'
          ? {source: nodeId, sourceHandle: hid, target: e.t, targetHandle: e.th}
          : {source: e.s, sourceHandle: e.sh, target: nodeId, targetHandle: hid};
        const r = M.connect(x.flow, x.lib, conn, e.neg ? {neg: 1} : null);
        if (r.ok) moved++; else { x.flow.edges.push(e); skipped++; }
      }
      ctx.toast(`Перенесено связей: ${moved}` + (skipped ? `, не подошло по правилам: ${skipped}` : ''));
    });
    return true;
  }, [ctx, cur, edit]);

  const onConnectStart = useCallback((e, p) => {
    pend.current = Object.assign({}, p, {ctrl: !!(e.ctrlKey || e.metaKey)});
  }, []);
  const onConnectEnd = useCallback((e, st) => {
    const p = pend.current; pend.current = null;
    connTip('');
    if (!p || ctx.ro()) return;
    const pt = e.changedTouches && e.changedTouches[0] ? e.changedTouches[0] : e;
    if (p.ctrl) { relink(p, pt); return; }
    if (st.isValid) return;                           // соединит onConnect
    if (st.toHandle) {
      const c = cur();
      const r = R.canConnect(c.flow, c.lib, orient(st.fromHandle, st.toHandle));
      if (!r.ok) { lastReject.current = r.reason; ctx.toast(r.reason); }
      return;
    }
    // Брошено в пустоту — меню, отфильтрованное по совместимым сокетам:
    // выбранная нода встанет под курсором и сразу соединится.
    openMenu(pt.clientX, pt.clientY, {from: p});
  }, [ctx, cur, relink, connTip]);   // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------- создание нод ---------- */
  const proto = (k, ref, from) => {
    const n = {id: '__new', k};
    if (ref) n.ref = ref;
    const c = cur();
    const ft = from ? R.socketOf(c.flow, c.lib, from.nodeId, from.handleId, from.handleType === 'source' ? 'out' : 'in') : null;
    const dt = ft && ft.kind === 'data' && ft.type !== 'any' ? ft.type : null;
    if (k === 'stage') Object.assign(n, {w: 360, h: 200, fit: 1, data: {num: '', name: 'Новый этап', point: ''}});
    if (k === 'gate') n.data = {text: 'Условие перехода'};
    if (k === 'anyof') n.data = {type: dt || 'any', label: 'Один из (по порядку)', n: 2};
    if (k === 'calc') n.data = {name: 'Показатель', formula: '', inputs: [{id: 'a', name: 'Вход', type: dt || 'number'}], type: dt || 'number'};
    if (k === 'note') Object.assign(n, {w: 240, h: 120, data: {text: ''}});
    return n;
  };
  // Подходящий сокет новой ноды для связи, брошенной в пустоту.
  const matchSocket = (flow, lib, node, from) => {
    const s = R.socketsOf(flow, lib, node);
    if (from.handleType === 'source') {
      return s.ins.find(x => R.canConnect(flow, lib, {source: from.nodeId, sourceHandle: from.handleId, target: node.id, targetHandle: x.id}).ok);
    }
    return s.outs.find(x => R.canConnect(flow, lib, {source: node.id, sourceHandle: x.id, target: from.nodeId, targetHandle: from.handleId}).ok);
  };
  const placeNode = useCallback((spec, pt, from) => {
    const c = cur();
    // Проверка стоит на странице один раз (ТЗ §6.3 п. 2): уже стоящую не
    // дублируем, а подводим к ней камеру — или сразу соединяем с ней.
    if (spec.k === 'check') {
      const have = c.flow.nodes.find(n => n.k === 'check' && n.ref === spec.ref);
      if (have) {
        if (from) {
          const s = matchSocket(c.flow, c.lib, have, from);
          if (s) doConnect(from.handleType === 'source'
            ? {source: from.nodeId, sourceHandle: from.handleId, target: have.id, targetHandle: s.id}
            : {source: have.id, sourceHandle: s.id, target: from.nodeId, targetHandle: from.handleId});
          return have.id;
        }
        selectOnly([have.id]);
        rf.fitView({nodes: [{id: have.id}], padding: 0.6, maxZoom: 1.2, duration: 300});
        ctx.toast('Эта проверка уже стоит на схеме');
        return have.id;
      }
    }
    const pos = rf.screenToFlowPosition({x: pt.x, y: pt.y});
    let made = null;
    edit(x => {
      const n = proto(spec.k, spec.ref, from);
      n.id = M.newId('n', new Set(x.flow.nodes.map(y => y.id)));
      const sz = R.nodeSize(x.flow, x.lib, n);
      n.x = Math.round(pos.x - (from && from.handleType === 'target' ? sz.w : from ? 0 : sz.w / 2));
      n.y = Math.round(pos.y - (from ? 30 : Math.min(sz.h / 2, 60)));
      x.flow.nodes.push(n);
      if (n.k === 'stage') M.orderStages(x.flow);
      M.refit(x.flow, x.lib, M.reparent(x.flow, x.lib, n, sizeOf), sizeOf);
      if (from) {
        const s = matchSocket(x.flow, x.lib, n, from);
        if (s) M.connect(x.flow, x.lib, from.handleType === 'source'
          ? {source: from.nodeId, sourceHandle: from.handleId, target: n.id, targetHandle: s.id}
          : {source: n.id, sourceHandle: s.id, target: from.nodeId, targetHandle: from.handleId});
      }
      made = n.id;
    });
    if (made) selectOnly([made]);
    return made;
  }, [ctx, cur, edit, rf, sizeOf, doConnect, selectOnly]);   // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------- меню добавления ---------- */
  const menuItems = useCallback(from => {
    const c = cur(), {flow, lib} = c;
    const onPage = new Set(flow.nodes.filter(n => n.k === 'check').map(n => n.ref));
    const items = [];
    const put = (group, label, hint, color, k, ref, existing) => items.push({key: group + '|' + (ref || k) + '|' + items.length,
      group, label, hint, color, k, ref, existing});
    for (const [k, label, hint] of [['stage', 'Этап', 'рамка: проверки внутри идут параллельно'], ['gate', 'Гейт', 'условие перехода между этапами'],
      ['anyof', 'Один из', 'резерв источников по приоритету'], ['calc', 'Показатель', 'вычисляемая величина'],
      ['note', 'Заметка', ''], ['reroute', 'Точка перегиба', 'чтобы развести связи']]) {
      put('Ноды', label, hint, R.KIND_COLORS[k] || '#9aa1b2', k);
    }
    for (const d of lib.dims) put('Измерения', d.name, d.code ? 'ось ' + d.code : '', R.KIND_COLORS.dim, 'dim', d.id);
    for (const s of lib.sources) put('Источники', s.name, R.nameOf(R.SOURCE_STATUSES, s.status || 'unknown'), R.KIND_COLORS.source, 'source', s.id);
    for (const ch of lib.checks) put('Проверки', `${ch.code || ''} ${ch.name}`.trim(), onPage.has(ch.id) ? 'уже на схеме' : '', R.KIND_COLORS.check, 'check', ch.id, onPage.has(ch.id));
    for (const o of lib.outcomes) put('Исходы', o.name, R.verdictOf(lib, o.verdict).name, R.verdictOf(lib, o.verdict).color, 'outcome', o.id);
    let list = items;
    if (from) {
      list = items.filter(it => {
        if (it.k === 'check' && it.existing) {
          const have = flow.nodes.find(n => n.k === 'check' && n.ref === it.ref);
          return have && have.id !== from.nodeId && !!matchSocket(flow, lib, have, from);
        }
        const n = proto(it.k, it.ref, from);
        const tmp = {nodes: flow.nodes.concat([n]), edges: flow.edges};
        return !!matchSocket(tmp, lib, n, from);
      });
    }
    return list;
  }, [cur]);   // eslint-disable-line react-hooks/exhaustive-deps

  const openMenu = useCallback((cx, cy, opt) => {
    if (ctx.ro()) return;
    const r = rootRef.current.getBoundingClientRect();
    const from = opt && opt.from;
    const items = menuItems(from).map(it => Object.assign(it, {run: () => placeNode({k: it.k, ref: it.ref}, {x: cx, y: cy}, from)}));
    const W = 320, H = 380;
    setMenu({x: clamp(cx - r.left, 4, Math.max(4, r.width - W - 4)), y: clamp(cy - r.top, 4, Math.max(4, r.height - H - 4)),
      title: from ? 'Подходящие для связи' : 'Добавить', items});
  }, [ctx, menuItems, placeNode]);

  /* ---------- операции над выделенным ---------- */
  const toggleFlag = useCallback(field => {
    const ids = selIds(); if (!ids.length) return;
    edit(x => {
      const ns = x.flow.nodes.filter(n => ids.includes(n.id));
      const on = !ns.every(n => n[field]);
      for (const n of ns) { if (on) n[field] = 1; else delete n[field]; }
      M.refit(x.flow, x.lib, ns.map(n => n.parent).filter(Boolean), sizeOf);
    });
  }, [selIds, edit, sizeOf]);
  // Ctrl+H: спрятать несоединённые сокеты, повторно — показать все.
  const toggleHide = useCallback(() => {
    const ids = selIds(); if (!ids.length) return;
    edit(x => {
      for (const n of x.flow.nodes.filter(y => ids.includes(y.id))) {
        if ((n.hide || []).length) { delete n.hide; continue; }
        const s = R.socketsOf(x.flow, x.lib, n);
        const free = s.ins.concat(s.outs).map(y => y.id).filter(h => !R.isConnected(x.flow, n.id, h));
        if (free.length) n.hide = free;
      }
      M.refit(x.flow, x.lib, x.flow.nodes.filter(y => ids.includes(y.id)).map(y => y.parent).filter(Boolean), sizeOf);
    });
  }, [selIds, edit, sizeOf]);
  const deleteSel = useCallback(() => {
    const ns = selIds(), es = rf.getEdges().filter(e => e.selected).map(e => e.id);
    if (!ns.length && !es.length) return;
    edit(x => {
      const parents = x.flow.nodes.filter(n => ns.includes(n.id) && n.parent).map(n => n.parent);
      const a = M.deleteEdges(x.flow, es), b = M.deleteNodes(x.flow, ns);
      M.refit(x.flow, x.lib, parents, sizeOf);
      ctx.toast(`Удалено со схемы: ${b.nodes} нод, ${a + b.edges} связей · блоки остались в библиотеке`);
    });
  }, [ctx, rf, selIds, edit, sizeOf]);
  const wrapSel = useCallback(() => {
    const ids = selIds(); if (!ids.length) return;
    let st = null;
    edit(x => { st = M.wrapInStage(x.flow, x.lib, ids, sizeOf); });
    if (st) selectOnly([st.id]); else ctx.toast('В этап оборачиваются проверки, показатели, «один из» и заметки');
  }, [ctx, selIds, edit, sizeOf, selectOnly]);
  const copySel = useCallback(() => {
    const ids = selIds(); if (!ids.length) return null;
    const c = cur();
    const clip = M.copyNodes(c.P, c.flow, ids);
    try { localStorage.setItem(CLIP_KEY, JSON.stringify(clip)); } catch (e) { ctx.toast('Буфер не записался: ' + e.message); }
    ctx.toast(`Скопировано: ${clip.nodes.length} нод, ${clip.edges.length} связей`);
    return clip;
  }, [ctx, cur, selIds]);
  const pasteClip = useCallback((clip, at) => {
    if (!clip) { try { clip = JSON.parse(localStorage.getItem(CLIP_KEY) || 'null'); } catch (e) { clip = null; } }
    if (!clip || clip.kind !== 'kycflow-clip') { ctx.toast('В буфере нет блоков конструктора'); return; }
    let r = null;
    edit(x => { r = M.pasteClip(x.P, x.flow, clip, at); });
    if (!r) return;
    if (r.added.length) selectOnly(r.added);
    if (r.skipped.length) ctx.toast(`Проверка стоит на схеме один раз — пропущено: ${r.skipped.length}`);
  }, [ctx, edit, selectOnly]);
  const viewCenter = () => {
    const el = paneRef.current.getBoundingClientRect();
    return rf.screenToFlowPosition({x: el.left + el.width / 2, y: el.top + el.height / 2});
  };
  const fitSel = useCallback(() => {
    const ids = selIds();
    rf.fitView({nodes: ids.length ? ids.map(id => ({id})) : undefined, padding: 0.12, maxZoom: ids.length ? 1.3 : MAX_K, duration: 0});
    saveVp(rf.getViewport());
  }, [rf, selIds, saveVp]);

  const toggleNeg = useCallback(id => edit(x => {
    const e = x.flow.edges.find(y => y.id === id);
    if (e) { if (e.neg) delete e.neg; else e.neg = 1; }
  }), [edit]);
  const insertReroute = useCallback((id, pt) => {
    const pos = rf.screenToFlowPosition(pt);
    edit(x => {
      const e = x.flow.edges.find(y => y.id === id); if (!e) return;
      const taken = new Set(x.flow.nodes.map(y => y.id));
      const r = {id: M.newId('n', taken), k: 'reroute', x: Math.round(pos.x - 6), y: Math.round(pos.y - 6)};
      x.flow.nodes.push(r);
      const et = new Set(x.flow.edges.map(y => y.id));
      const e1 = {id: M.newId('e', et), s: e.s, sh: e.sh, t: r.id, th: 'in'};
      et.add(e1.id);
      // «Кроме» остаётся на последнем отрезке — на том, что входит в cond-in.
      const e2 = Object.assign({id: M.newId('e', et), s: r.id, sh: 'out', t: e.t, th: e.th}, e.neg ? {neg: 1} : {});
      x.flow.edges = x.flow.edges.filter(y => y.id !== id).concat([e1, e2]);
      M.refit(x.flow, x.lib, M.reparent(x.flow, x.lib, r, sizeOf), sizeOf);
    });
  }, [rf, edit, sizeOf]);

  /* ---------- жесты ---------- */
  const onNodeDragStop = useCallback((e, node, dragged) => {
    const c = cur(); if (!c.flow || ctx.ro()) return;
    const list = (dragged && dragged.length ? dragged : [node]);
    const moved = list.filter(d => {
      const n = c.flow.nodes.find(x => x.id === d.id);
      return n && (Math.round(d.position.x) !== +n.x || Math.round(d.position.y) !== +n.y);
    });
    if (!moved.length) return;
    edit(x => {
      const touched = [];
      for (const d of list) {
        const n = x.flow.nodes.find(y => y.id === d.id); if (!n) continue;
        n.x = Math.round(d.position.x); n.y = Math.round(d.position.y);
        if (n.parent) touched.push(n.parent);
        touched.push(...M.reparent(x.flow, x.lib, n, sizeOf));
      }
      M.refit(x.flow, x.lib, touched, sizeOf);
    });
  }, [ctx, cur, edit, sizeOf]);

  // Конец ресайза рамки или заметки: рамка, растянутая руками, перестаёт
  // подгоняться сама (fit:0). Детей React Flow держит на местах сам — их
  // координаты относительно рамки берём из его состояния.
  const resized = useCallback((id, p) => {
    edit(x => {
      const n = x.flow.nodes.find(y => y.id === id); if (!n) return;
      n.x = Math.round(p.x); n.y = Math.round(p.y); n.w = Math.round(p.width); n.h = Math.round(p.height);
      if (n.k === 'stage') {
        n.fit = 0;
        for (const k of x.flow.nodes) {
          if (k.parent !== id) continue;
          const rn = rf.getNode(k.id);
          if (rn) { k.x = Math.round(rn.position.x); k.y = Math.round(rn.position.y); }
        }
      }
    });
  }, [rf, edit]);

  /* ---------- контекстные меню ---------- */
  const onPaneContextMenu = useCallback(e => { e.preventDefault(); openMenu(e.clientX, e.clientY); }, [openMenu]);
  const onNodeContextMenu = useCallback((e, node) => {
    e.preventDefault();
    // На Mac Ctrl+нажатие — это правая кнопка: Ctrl+тянуть из сокета открывало бы
    // ещё и меню ноды поверх начатого переноса связей.
    if (pend.current) return;
    if (!node.selected) selectOnly([node.id]);
    if (ctx.ro()) return;
    const n = cur().flow.nodes.find(x => x.id === node.id);
    ctx.showCtx(e.clientX, e.clientY, [
      [n && n.collapsed ? 'Развернуть' : 'Свернуть', () => toggleFlag('collapsed'), null, 'H'],
      [n && n.muted ? 'Включить' : 'Выключить', () => toggleFlag('muted'), null, 'M'],
      [n && (n.hide || []).length ? 'Показать все сокеты' : 'Скрыть пустые сокеты', toggleHide, null, 'Ctrl+H'],
      ['Обернуть в этап', wrapSel, null, 'Ctrl+J'],
      ['Дублировать', () => { const cl = copySel(); if (cl) pasteClip(cl, null); }, null, 'Ctrl+D'],
      ['—'],
      ['Удалить со схемы', deleteSel, null, 'Del', 1],
    ]);
  }, [ctx, cur, selectOnly, toggleFlag, toggleHide, wrapSel, copySel, pasteClip, deleteSel]);
  const onEdgeContextMenu = useCallback((e, edge) => {
    e.preventDefault();
    if (ctx.ro()) return;
    const c = cur(), fe = c.flow.edges.find(x => x.id === edge.id); if (!fe) return;
    const cond = R.edgeKind(c.flow, c.lib, fe) === 'cond';
    ctx.showCtx(e.clientX, e.clientY, [
      ...(cond ? [[fe.neg ? 'Включить это значение' : 'Исключить это значение', () => toggleNeg(fe.id)]] : []),
      ['Вставить точку перегиба', () => insertReroute(fe.id, {x: e.clientX, y: e.clientY}), null, 'двойной клик'],
      ['—'],
      ['Удалить связь', () => edit(x => { M.deleteEdges(x.flow, [fe.id]); }), null, 'Alt+клик', 1],
    ]);
  }, [ctx, cur, edit, toggleNeg, insertReroute]);
  const onEdgeClick = useCallback((e, edge) => {
    if (e.altKey && !ctx.ro()) { e.preventDefault(); edit(x => { M.deleteEdges(x.flow, [edge.id]); }); }
  }, [ctx, edit]);
  const onEdgeDoubleClick = useCallback((e, edge) => {
    if (ctx.ro()) return;
    e.preventDefault(); e.stopPropagation();
    insertReroute(edge.id, {x: e.clientX, y: e.clientY});
  }, [ctx, insertReroute]);

  /* ---------- клавиши ---------- */
  // Клавиши слушаются на СВОЁМ контейнере: глобальный обработчик приложения
  // на этой странице отвечает только за Esc, Ctrl+K, Ctrl+Z, Ctrl+S и Ctrl+B (main.js).
  const onKeyDown = useCallback(e => {
    if (typing(e.target)) return;
    const mod = e.ctrlKey || e.metaKey;
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    if (e.key === 'Escape') {
      if (menu) { stop(); setMenu(null); return; }
      selectOnly([]);
      return;
    }
    if (!mod && e.shiftKey && K(e, 'KeyA', 'a')) { stop(); openMenu(ptr.current.x, ptr.current.y); return; }
    if (!mod && !e.shiftKey && K(e, 'KeyF', 'f')) { stop(); fitSel(); return; }
    if (mod && K(e, 'KeyC', 'c')) { stop(); copySel(); return; }
    if (mod && K(e, 'KeyA', 'a')) { stop(); selectOnly(rf.getNodes().map(n => n.id)); return; }
    if (ctx.ro()) return;
    if (!mod && K(e, 'KeyM', 'm')) { stop(); toggleFlag('muted'); return; }
    if (!mod && K(e, 'KeyH', 'h')) { stop(); toggleFlag('collapsed'); return; }
    if (mod && K(e, 'KeyH', 'h')) { stop(); toggleHide(); return; }
    if (mod && K(e, 'KeyJ', 'j')) { stop(); wrapSel(); return; }
    if (mod && K(e, 'KeyV', 'v')) { stop(); pasteClip(null, viewCenter()); return; }
    if (mod && K(e, 'KeyD', 'd')) { stop(); const cl = M.copyNodes(cur().P, cur().flow, selIds()); if (cl.nodes.length) pasteClip(cl, null); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { stop(); deleteSel(); }
  }, [ctx, rf, menu, cur, openMenu, fitSel, copySel, pasteClip, toggleFlag, toggleHide, wrapSel, deleteSel, selIds, selectOnly]);   // eslint-disable-line react-hooks/exhaustive-deps
  // Фокус в контейнер — по нажатию на холст, иначе клавиши уходили бы в body
  // и до обработчика выше не доезжали.
  const onPointerDownCapture = useCallback(e => {
    if (typing(e.target) || (e.target.closest && e.target.closest('.fl-add'))) return;
    if (rootRef.current && !rootRef.current.contains(document.activeElement)) rootRef.current.focus({preventScroll: true});
    else if (rootRef.current && document.activeElement !== rootRef.current && !typing(document.activeElement)) rootRef.current.focus({preventScroll: true});
  }, []);
  const onPointerMove = useCallback(e => { ptr.current = {x: e.clientX, y: e.clientY}; }, []);

  /* ---------- контекст для нод ---------- */
  const fxRef = useRef({});
  const fx = fxRef.current;
  Object.assign(fx, {
    ro: () => ctx.ro(),
    socketTip(nodeId, hid, side) {
      const c = cur(); if (!c.flow) return '';
      const s = R.socketOf(c.flow, c.lib, nodeId, hid, side); if (!s) return '';
      const kind = {exec: 'порядок исполнения', cond: 'применимость', verdict: 'вердикт', vin: 'вердикт или порядок', any: 'любой'}[s.kind];
      const head = (s.name ? s.name + ' · ' : '') + (s.kind === 'data' ? 'тип ' + R.typeOf(s.type).name.toLowerCase() + ' (' + s.type + ')' : kind || s.kind);
      const lines = [head];
      for (const e of c.flow.edges) {
        if (side === 'in' && e.t === nodeId && e.th === hid) {
          const o = c.flow.nodes.find(n => n.id === e.s);
          const os = R.socketOf(c.flow, c.lib, e.s, e.sh, 'out');
          lines.push('← ' + nodeLabel(c.lib, o) + (os && os.name ? ' · ' + os.name : '') + (e.neg ? ' (кроме)' : ''));
        }
        if (side === 'out' && e.s === nodeId && e.sh === hid) {
          const o = c.flow.nodes.find(n => n.id === e.t);
          const os = R.socketOf(c.flow, c.lib, e.t, e.th, 'in');
          lines.push('→ ' + nodeLabel(c.lib, o) + (os && os.name ? ' · ' + os.name : ''));
        }
      }
      if (lines.length === 1) lines.push(side === 'in' ? 'ни откуда не приходит' : 'никуда не уходит');
      return lines.join('\n');
    },
    reasonFor(from, to) {
      const c = cur(); if (!c.flow || !from || !to) return '';
      const r = R.canConnect(c.flow, c.lib, orient(from, to));
      return r.ok ? '' : r.reason;
    },
    lineColor(from) {
      const c = cur(); if (!c.flow || !from || from.type !== 'source') return '';
      return R.edgeColor(c.flow, c.lib, {s: from.nodeId, sh: from.id});
    },
    connTip,
    plus(id) {
      edit(x => {
        const n = x.flow.nodes.find(y => y.id === id); if (!n) return;
        const it = R.itemOf(x.lib, n);
        if (n.k === 'anyof') { n.data = n.data || {}; n.data.n = Math.min(12, (+n.data.n || 2) + 1); }
        else if (n.k === 'dim' && it) it.values.push({id: M.newId('v_', new Set(it.values.map(v => v.id))), code: '', name: 'Значение ' + (it.values.length + 1), desc: '', wave: 1});
        else if (n.k === 'source' && it) it.fields.push({id: M.newId('f_', new Set(it.fields.map(f => f.id))), name: 'Поле ' + (it.fields.length + 1), type: 'text', desc: ''});
        M.refit(x.flow, x.lib, [n.parent].filter(Boolean), sizeOf);
      });
    },
    rename(id) {
      const c = cur(); const n = c.flow.nodes.find(y => y.id === id); if (!n) return;
      const it = R.itemOf(c.lib, n), d = n.data || {};
      const field = it ? 'name' : n.k === 'stage' ? 'name' : n.k === 'gate' || n.k === 'note' ? 'text' : n.k === 'calc' || n.k === 'anyof' ? (n.k === 'calc' ? 'name' : 'label') : null;
      if (!field) return;
      const was = it ? it.name : d[field] || '';
      ctx.promptBox(R.KIND_NAMES[n.k], it ? 'Название (блок библиотеки — меняется на всех схемах)' : 'Текст', was, v => edit(x => {
        const nn = x.flow.nodes.find(y => y.id === id); if (!nn) return;
        const ii = R.itemOf(x.lib, nn);
        if (ii) ii.name = v; else { nn.data = nn.data || {}; nn.data[field] = v; }
      }));
    },
    resized,
  });

  /* ---------- крючки для тестов ---------- */
  useEffect(() => {
    api.state = () => {
      const vp = rf.getViewport(), c = cur();
      return {nodes: c.flow ? c.flow.nodes.length : 0, edges: c.flow ? c.flow.edges.length : 0,
        rfNodes: rf.getNodes().length, rfEdges: rf.getEdges().length,
        selected: rf.getNodes().filter(n => n.selected).map(n => n.id),
        viewport: {x: Math.round(vp.x), y: Math.round(vp.y), k: +vp.zoom.toFixed(4)},
        readonly: ctx.ro(), dark: ctx.isDark(), menu: menu ? {title: menu.title, items: menu.items.map(i => i.label)} : null,
        lastReject: lastReject.current};
    };
    api.setViewport = vp => { const v = {x: vp.x, y: vp.y, zoom: vp.k != null ? vp.k : vp.zoom}; rf.setViewport(v); saveVp(v); return true; };
    api.fit = () => { rf.fitView({padding: 0.12, duration: 0}); saveVp(rf.getViewport()); return true; };
    // Соединение тем же путём, что и мышью: from/to — «нода.ручка».
    api.connect = (from, to) => {
      const [s, sh] = String(from).split(/\.(.+)/), [t, th] = String(to).split(/\.(.+)/);
      const conn = {source: s, sourceHandle: sh, target: t, targetHandle: th};
      const c = cur(), chk = R.canConnect(c.flow, c.lib, conn);
      if (!chk.ok) { lastReject.current = chk.reason; return {ok: false, reason: chk.reason}; }
      const r = doConnect(conn);
      return {ok: !!(r && r.ok), id: r && r.edge && r.edge.id};
    };
    api.place = (spec, at) => {
      const el = paneRef.current.getBoundingClientRect();
      return placeNode(spec, at || {x: el.left + el.width / 2, y: el.top + el.height / 2}, null);
    };
    api.select = ids => { selectOnly(ids || []); return true; };
    api.openAdd = () => {
      const el = paneRef.current.getBoundingClientRect();
      openMenu(el.left + el.width / 2, el.top + el.height / 3);
      return true;
    };
    api.handleXY = (nodeId, hid) => {
      const el = rootRef.current.querySelector(`.react-flow__handle[data-nodeid="${CSS.escape(nodeId)}"][data-handleid="${CSS.escape(hid)}"]`);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2)};
    };
    // Середина связи на экране — чтобы тест кликал по самой линии, как человек.
    api.edgeXY = edgeId => {
      const g = rootRef.current.querySelector(`.react-flow__edge[data-id="${CSS.escape(edgeId)}"] path.react-flow__edge-path`);
      if (!g || !g.getTotalLength) return null;
      const p = g.getPointAtLength(g.getTotalLength() / 2), m = g.getScreenCTM();
      return {x: Math.round(p.x * m.a + p.y * m.c + m.e), y: Math.round(p.x * m.b + p.y * m.d + m.f)};
    };
    api.nodeXY = nodeId => {
      const el = rootRef.current.querySelector(`.react-flow__node[data-id="${CSS.escape(nodeId)}"]`);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)};
    };
  });

  const flow = c0.flow;
  if (!flow) return <div className="fl-root fl-missing">Страница-конструктор не найдена</div>;
  const empty = !flow.nodes.length;

  return (
    <FlowCtx.Provider value={fx}>
      <div className={'fl-root' + (ro ? ' fl-ro' : '')} ref={rootRef} tabIndex={-1}
           onKeyDown={onKeyDown} onPointerDownCapture={onPointerDownCapture} onPointerMove={onPointerMove}>
        <div className="fl-pane" ref={paneRef}>
          <ReactFlow
            nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
            onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
            onConnect={onConnect} onConnectStart={onConnectStart} onConnectEnd={onConnectEnd}
            isValidConnection={isValidConnection} connectionLineComponent={ConnLine} connectionRadius={18}
            onNodeDragStop={onNodeDragStop}
            onNodeMouseEnter={(e, n) => setHover(n.id)} onNodeMouseLeave={() => setHover(null)}
            onPaneContextMenu={onPaneContextMenu} onNodeContextMenu={onNodeContextMenu}
            onEdgeContextMenu={onEdgeContextMenu} onEdgeClick={onEdgeClick} onEdgeDoubleClick={onEdgeDoubleClick}
            onPaneClick={() => setMenu(null)}
            colorMode={dark ? 'dark' : 'light'}
            defaultViewport={initialVp || {x: 40, y: 40, zoom: 1}}
            fitView={!initialVp && !empty}
            fitViewOptions={{padding: 0.12}}
            minZoom={MIN_K} maxZoom={MAX_K}
            onMoveEnd={(e, vp) => saveVp(vp)}
            zoomOnScroll={false} panOnScroll={false} zoomOnDoubleClick={false}
            selectionOnDrag={!COARSE} panOnDrag={COARSE ? true : [1]} multiSelectionKeyCode={MULTI_KEYS}
            deleteKeyCode={null} elevateNodesOnSelect={false}
            nodesDraggable={!ro} nodesConnectable={!ro} elementsSelectable
            onlyRenderVisibleElements
            attributionPosition="top-right"
          >
            <Background gap={22} size={1.2}/>
            <Controls showInteractive={false} position="bottom-left"/>
            <MiniMap pannable zoomable position="bottom-right" className="fl-mini"
              nodeColor={n => (n.type === 'stage' ? 'rgba(51,85,209,.10)' : (n.data && n.data.color) || '#c4c9d4')}
              nodeStrokeColor={n => (n.type === 'stage' ? 'rgba(51,85,209,.45)' : 'transparent')}/>
          </ReactFlow>
          {empty && (
            <div className="fl-empty">
              <div className="ttl">Схема пока пустая</div>
              <div className="txt">{ro
                ? 'Автор ещё ничего сюда не поставил.'
                : <><b>Shift+A</b> — добавить блок, библиотека слева.<br/>Колесо — панорама, <b>Ctrl</b> + колесо — масштаб.</>}</div>
            </div>
          )}
          {menu ? <AddMenu x={menu.x} y={menu.y} title={menu.title} items={menu.items} onClose={() => setMenu(null)}/> : null}
        </div>
        <div className="fl-ctip" ref={tipRef}/>
      </div>
    </FlowCtx.Provider>
  );
}
