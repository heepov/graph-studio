// Данные конструктора: нормализация, идентификаторы, операции над библиотекой.
// В отличие от rules.js, модуль знает про документ доски целиком (страницы,
// P.flowLib), но по-прежнему без DOM и React — его зовёт и normalize() приложения.
import {defaultFlow, defaultLib, DEFAULT_VERDICTS, LIB_KINDS} from './rules.js';

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
