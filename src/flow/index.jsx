// Точка входа нодового конструктора для приложения (src/main.js).
//
// Приложение рисует страницы строками и функциями, конструктор — React Flow.
// Граница между ними узкая и односторонняя: main.js зовёт четыре функции ниже
// и передаёт ctx — набор своих функций (save, snapNow, toast…). Сюда приложение
// больше не заглядывает, а модуль не трогает DOM за пределами своего контейнера
// и полосы #flowBar.
//
// Источник правды — документ P. Модуль не держит своей копии данных: после
// отмены, чужой правки или возврата версии main.js зовёт updateFlow(), и всё
// пересчитывается из P заново.
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import '@xyflow/react/dist/style.css';
import './flow.css';
import FlowApp from './FlowView.jsx';

// Один корень на приложение: страница-конструктор на экране максимум одна.
let R = null;   // {root, container, ctx, pageId, docId, rev, api}

function paint() {
  if (!R) return;
  const r = R;
  // Синхронно: после renderPage() разметка обязана уже соответствовать P —
  // на это рассчитывают и тесты, и код приложения, который читает DOM следом.
  flushSync(() => r.root.render(<FlowApp ctx={r.ctx} pageId={r.pageId} rev={r.rev} api={r.api}/>));
}

// Смонтирован ли конструктор, и именно для этой страницы этой доски.
export function flowMounted(pageId, docId) {
  if (!R || !R.container.isConnected) return false;
  if (pageId === undefined) return true;
  return R.pageId === pageId && R.docId === docId;
}

export function mountFlow(container, ctx, pg) {
  unmountFlow();
  R = {root: createRoot(container), container, ctx, pageId: pg.id, docId: (ctx.P() || {}).id, rev: 0, api: {}};
  paint();
}

// Перерисовка той же страницы БЕЗ пересоздания: иначе терялись бы камера,
// выделение и начатый жест.
export function updateFlow(pg) {
  if (!R || !pg || pg.id !== R.pageId) return;
  R.rev++;
  paint();
}

export function unmountFlow() {
  if (!R) return;
  const r = R;
  R = null;
  try { r.root.unmount(); } catch (e) { /* контейнер уже вынесен из DOM — React это переживёт */ }
}

// Картинка схемы (PNG/SVG) — делегат меню «Картинка» и экспорта приложения.
export async function flowExportImage(fmt) {
  if (!R || !R.api.exportImage) return false;
  return R.api.exportImage(fmt);
}

// Крючки для тестов и отладки из консоли. Ничего из этого не нужно интерфейсу:
// они читают то же состояние, что видит человек, и ходят теми же путями.
export const FLOW = {
  state() {
    if (!R) return {mounted: false};
    const a = R.api;
    return Object.assign({mounted: true, pageId: R.pageId, rev: R.rev}, a.state ? a.state() : {});
  },
  api() { return R ? R.api : null; },
  call(name, ...args) {
    if (!R || typeof R.api[name] !== 'function') throw new Error('конструктор не смонтирован или нет ' + name);
    return R.api[name](...args);
  },
};
