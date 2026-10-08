// Ленивая часть интерфейса с подгрузкой заранее. React.lazy сам по себе не годится:
// он начинает грузить чанк только при первой отрисовке и показывает содержимое
// Suspense не чаще раза в 300 мс — первое Shift+A открывало бы меню с задержкой,
// и набранные сразу буквы терялись бы. Здесь: preload() грузит чанк в фоне, а когда
// он загружен, компонент рисуется напрямую, без Suspense.
import {createElement, lazy} from 'react';

export function lazyPart(factory) {
  let Comp = null, p = null;
  const load = () => (p = p || factory().then(m => { Comp = m.default; return m; }));
  const L = lazy(load);
  function Part(props) { return createElement(Comp || L, props); }
  Part.preload = () => load().catch(() => null);
  return Part;
}
