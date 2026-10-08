// Корень конструктора: холст React Flow и всё, что вокруг него.
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {ReactFlow, ReactFlowProvider, Background, Controls, MiniMap, useReactFlow} from '@xyflow/react';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
// Те же клампы, что у холста приложения (SPEC §6): иначе одна и та же доска
// на соседних страницах масштабировалась бы в разных пределах.
const MIN_K = 0.08, MAX_K = 3;

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

export default function FlowApp(props) {
  return <ReactFlowProvider><FlowView {...props}/></ReactFlowProvider>;
}

function FlowView({ctx, pageId, rev, api}) {
  const P = ctx.P();
  const pg = (P && P.pages || []).find(p => p.id === pageId);
  const flow = pg && pg.flow;
  const ro = ctx.ro();
  const rf = useReactFlow();
  const rootRef = useRef(null), paneRef = useRef(null);

  // Тема следует за body.dark. Наблюдатель, а не вызов из applyTheme(): так
  // приложению не нужно знать, что где-то есть React, а при размонтировании
  // наблюдатель снимается вместе с компонентом.
  const [dark, setDark] = useState(ctx.isDark());
  useEffect(() => {
    const mo = new MutationObserver(() => setDark(ctx.isDark()));
    mo.observe(document.body, {attributes: true, attributeFilter: ['class']});
    return () => mo.disconnect();
  }, [ctx]);

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

  /* ---------- клавиши ---------- */
  // Клавиши слушаются на СВОЁМ контейнере: глобальный обработчик приложения
  // на этой странице отвечает только за Esc, Ctrl+K, Ctrl+Z и Ctrl+S (main.js).
  // Сверка по e.code: в русской раскладке e.key даёт другую букву.
  const onKeyDown = useCallback(e => {
    const t = e.target, tag = (t.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable) return;
    const mod = e.ctrlKey || e.metaKey;
    if (!mod && !e.altKey && e.code === 'KeyF') {
      e.preventDefault();
      rf.fitView({padding: 0.12, duration: 0});
      saveVp(rf.getViewport());
    }
  }, [rf, saveVp]);
  // Фокус в контейнер — по нажатию на холст, иначе клавиши уходили бы в body
  // и до обработчика выше не доезжали.
  const onPointerDownCapture = useCallback(e => {
    const t = e.target, tag = (t.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable) return;
    if (rootRef.current && document.activeElement !== rootRef.current && !rootRef.current.contains(document.activeElement)) {
      rootRef.current.focus({preventScroll: true});
    }
  }, []);

  /* ---------- крючки для тестов ---------- */
  useEffect(() => {
    api.state = () => {
      const vp = rf.getViewport();
      return {nodes: flow ? flow.nodes.length : 0, edges: flow ? flow.edges.length : 0,
        viewport: {x: Math.round(vp.x), y: Math.round(vp.y), k: +vp.zoom.toFixed(4)},
        readonly: ctx.ro(), dark: ctx.isDark()};
    };
    api.setViewport = vp => { const v = {x: vp.x, y: vp.y, zoom: vp.k != null ? vp.k : vp.zoom}; rf.setViewport(v); saveVp(v); return true; };
    api.fit = () => { rf.fitView({padding: 0.12, duration: 0}); saveVp(rf.getViewport()); return true; };
  });

  if (!flow) return <div className="fl-root fl-missing">Страница-конструктор не найдена</div>;
  const empty = !flow.nodes.length;

  return (
    <div className={'fl-root' + (ro ? ' fl-ro' : '')} ref={rootRef} tabIndex={-1}
         onKeyDown={onKeyDown} onPointerDownCapture={onPointerDownCapture}>
      <div className="fl-pane" ref={paneRef}>
        <ReactFlow
          nodes={[]} edges={[]}
          colorMode={dark ? 'dark' : 'light'}
          defaultViewport={initialVp || {x: 40, y: 40, zoom: 1}}
          fitView={!initialVp && !empty}
          fitViewOptions={{padding: 0.12}}
          minZoom={MIN_K} maxZoom={MAX_K}
          onMoveEnd={(e, vp) => saveVp(vp)}
          zoomOnScroll={false} panOnScroll={false} zoomOnDoubleClick={false}
          deleteKeyCode={null}
          nodesDraggable={!ro} nodesConnectable={!ro} elementsSelectable
          onlyRenderVisibleElements
          attributionPosition="top-right"
        >
          <Background gap={22} size={1.2}/>
          <Controls showInteractive={false} position="bottom-left"/>
          <MiniMap pannable zoomable position="bottom-right" className="fl-mini"/>
        </ReactFlow>
        {empty && (
          <div className="fl-empty">
            <div className="ttl">Схема пока пустая</div>
            <div className="txt">{ro
              ? 'Автор ещё ничего сюда не поставил.'
              : <><b>Shift+A</b> — добавить блок, библиотека слева.<br/>Колесо — панорама, <b>Ctrl</b> + колесо — масштаб.</>}</div>
          </div>
        )}
      </div>
    </div>
  );
}
