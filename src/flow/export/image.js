// PNG и SVG схемы — по рецепту документации React Flow: html-to-image снимает
// .react-flow__viewport с трансформом, при котором вся схема помещается в кадр.
// Версия html-to-image зафиксирована 1.11.11: в документации React Flow сказано,
// что более поздние ломают экспорт. SVG при этом получается с foreignObject —
// ноды это HTML, а не векторные примитивы; это ограничение подхода, не ошибка.
// Модуль ленивый: грузится только по кнопке.
import {toPng, toSvg} from 'html-to-image';

// Холст браузера не бывает больше ~16 тыс. пикселей по стороне, а большая
// схема в 2× легко его превышает — тогда масштаб уменьшается, а не падает.
const MAX_SIDE = 15000, MAX_AREA = 60e6;

export async function snapshot(el, fmt, box, bg) {
  const {width, height, x, y, zoom} = box;
  const opts = {
    backgroundColor: bg, width, height, cacheBust: true,
    style: {width: width + 'px', height: height + 'px', transform: `translate(${x}px, ${y}px) scale(${zoom})`},
  };
  if (fmt === 'svg') return toSvg(el, opts);
  let ratio = 2;
  while (ratio > 0.5 && (width * ratio > MAX_SIDE || height * ratio > MAX_SIDE || width * height * ratio * ratio > MAX_AREA)) ratio /= 1.25;
  return toPng(el, Object.assign(opts, {pixelRatio: ratio}));
}
