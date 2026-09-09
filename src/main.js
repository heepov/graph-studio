import { api, ApiError, parseRoute } from './api.js';
import * as cloud from './cloud.js';
import * as home from './home.js';
import * as live from './live.js';
/* ==========================================================================
   GRAPH STUDIO — редактор графов зависимостей, роадмапов и схем
   Один файл. Проекты в IndexedDB. Экспорт/импорт JSON, CSV, Markdown, viewer.
   ========================================================================== */
// TEMPLATE (снимок собственного исходника через document.documentElement.outerHTML)
// убран: после перехода на сборку он ссылался бы на внешние /assets/*.js и *.css,
// а не содержал бы их. Просмотрщик теперь берётся из dist/viewer-template.html,
// который собирается scripts/pack-viewer.mjs. См. exportViewer().
const SEED = JSON.parse(document.getElementById('seed').textContent);
const VIEWER = !!window.VIEWER;
// Отметка сборки, подставляется Vite. Нужна проверке боевого адреса после деплоя
// и просто чтобы понимать, что открыто, когда что-то ведёт себя странно.
const BUILD = typeof __BUILD__ !== 'undefined' ? __BUILD__ : {version: 'dev', sha: 'dev'};
// Режим «только чтение» ВНУТРИ обычного приложения: доска открыта по ссылке на просмотр
// или человеку выдали роль viewer. Отличается от VIEWER (это выгруженный файл-просмотрщик,
// который решается один раз при загрузке страницы и больше не меняется).
// ro() — единственная проверка во всех точках, которые что-то меняют.
let RO = false;
const ro = () => VIEWER || RO;
function setReadonly(on, why) {
  RO = !!on;
  document.body.classList.toggle('readonly', !!on);
  if (on && why) toast(why);
}

/* ---------- мелочи ---------- */
const $ = id => document.getElementById(id);
const qs = (s, r) => (r || document).querySelector(s);
const qsa = (s, r) => [...(r || document).querySelectorAll(s)];
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const clone = o => JSON.parse(JSON.stringify(o));
const uniq = a => [...new Set(a)];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const today = () => new Date().toISOString().slice(0, 10);
const nowStr = () => new Date().toLocaleString('ru-RU');
let _uid = Date.now() % 1e7;
const uid = p => (p || 'x') + (++_uid).toString(36) + Math.floor(Math.random() * 1296).toString(36);
const dl = (name, text, mime) => {
  const b = new Blob([text], {type: (mime || 'text/plain') + ';charset=utf-8'});
  const u = URL.createObjectURL(b), a = document.createElement('a');
  a.href = u; a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => {URL.revokeObjectURL(u); a.remove();}, 500);
};
let toastT;
// Тост с необязательной кнопкой действия. Она закрывает целый класс проблем:
// удаление узла, сброс раскладки и массовые правки были необратимы иначе как Ctrl+Z,
// про который никто не знает (а до этого он ещё и не работал в русской раскладке).
// «21 узлов», «1 строк», «2 связей» — склонение по-русски, а не наивное «+ов».
const plural = (n, forms) => {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
};
const nOf = (n, forms) => n + ' ' + plural(n, forms);
const NODES = ['узел', 'узла', 'узлов'], LINKS = ['связь', 'связи', 'связей'];
const ROWS = ['строка', 'строки', 'строк'], OBJS = ['объект', 'объекта', 'объектов'];
function toast(m, action) {
  const t = $('toast');
  t.innerHTML = esc(m) + (action ? ` <button class="tact">${esc(action.label)}</button>` : '');
  t.classList.toggle('act', !!action);
  if (action) {
    const btn = qs('.tact', t);
    btn.onclick = () => {t.classList.remove('on', 'act'); clearTimeout(toastT); action.run();};
  }
  t.classList.add('on');
  clearTimeout(toastT);
  // с кнопкой держим дольше: на 2.8 с человек не успевает прочитать и нажать
  toastT = setTimeout(() => t.classList.remove('on', 'act'), action ? 7000 : 2800);
}
function pickFile(accept, cb) {
  const i = $('fpick'); i.value = ''; i.accept = accept;
  i.onchange = () => {const f = i.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => cb(r.result, f.name); r.readAsText(f, 'utf-8');};
  i.click();
}
function modal(html, wire) { $('mbox').innerHTML = html; $('modal').classList.add('open'); if (wire) wire($('mbox')); }
function closeModal() { $('modal').classList.remove('open'); }
$('modal').addEventListener('click', e => {if (e.target.id === 'modal') closeModal();});
function confirmBox(text, ok, okLabel) {
  modal(`<h3>Подтверждение</h3><div class="kv" style="font-size:13px">${esc(text)}</div>
    <div class="mfoot"><button class="btn" data-a="c">Отмена</button><button class="btn dgr" data-a="ok">${esc(okLabel || 'Да')}</button></div>`,
    b => {b.querySelector('[data-a=c]').onclick = closeModal; b.querySelector('[data-a=ok]').onclick = () => {closeModal(); ok();};});
}
function promptBox(title, label, val, ok) {
  modal(`<h3>${esc(title)}</h3><div class="f"><label>${esc(label)}</label><input type="text" id="pbin" value="${esc(val || '')}"></div>
    <div class="mfoot"><button class="btn" data-a="c">Отмена</button><button class="btn pri" data-a="ok">Ок</button></div>`, b => {
    b.querySelector('[data-a=c]').onclick = closeModal;
    const go = () => {const v = $('pbin').value.trim(); if (v) {closeModal(); ok(v);}};
    b.querySelector('[data-a=ok]').onclick = go;
    $('pbin').onkeydown = e => {if (e.key === 'Enter') go();};
    setTimeout(() => {$('pbin').focus(); $('pbin').select();}, 30);
  });
}
function opts(list, cur, none) {
  let h = none !== undefined ? `<option value="">${esc(none)}</option>` : '';
  return h + list.map(o => {
    const [v, l] = Array.isArray(o) ? o : [o, o];
    return `<option value="${esc(v)}"${String(v) === String(cur == null ? '' : cur) ? ' selected' : ''}>${esc(l)}</option>`;
  }).join('');
}

/* ---------- хранилище: IndexedDB ---------- */
const DBNAME = 'graphstudio', STORE = 'projects', META = 'meta', SNAP = 'snaps';
let idb = null;
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DBNAME, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, {keyPath: 'id'});
      if (!d.objectStoreNames.contains(META)) d.createObjectStore(META, {keyPath: 'k'});
      if (!d.objectStoreNames.contains(SNAP)) d.createObjectStore(SNAP, {keyPath: 'id'});
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function tx(store, mode, fn) {
  return new Promise((res, rej) => {
    if (!idb) return rej(new Error('нет БД'));
    const t = idb.transaction(store, mode), s = t.objectStore(store);
    const rq = fn(s);
    t.oncomplete = () => res(rq && rq.result);
    t.onerror = () => rej(t.error);
  });
}
const dbPut = (store, v) => tx(store, 'readwrite', s => s.put(v));
const dbGet = (store, k) => tx(store, 'readonly', s => s.get(k));
const dbAll = store => tx(store, 'readonly', s => s.getAll());
const dbDel = (store, k) => tx(store, 'readwrite', s => s.delete(k));

/* ---------- состояние ---------- */
let P = null;                 // активный проект
let PROJECTS = [];            // [{id,name,desc,updated,nodes,links}]
const UI = {
  page: null, sel: new Set(), selNotes: new Set(), selFrames: new Set(), selLink: null, insp: null,
  // Выделенные объекты доски. Отдельное множество, а не подмешивание в UI.sel:
  // там лежат id узлов графа, и смешать их значило бы искать узел по id стикера.
  selItems: new Set(),
  // открываем сразу в правке: раньше умолчанием была «Карточка», и до любого поля
  // было два клика — половина жалобы «неудобно редактировать ноды» была про это.
  // В режиме просмотра вкладка правки скрыта, openNode() сам падает обратно на карточку.
  iTab: 'edit',
  // чем занят инспектор: 'node' | 'link' | 'frame' | null. Раньше openLink/openFrame
  // ставили UI.insp = null, и по одному этому полю нельзя было понять, открыт ли он вообще —
  // из-за чего undo() и edit() «теряли» инспектор связи и области.
  inspKind: null, inspRef: null,
  view: {}, hover: null, linkType: null, spaceDown: false, dirty: false, lastSave: null,
  // Номер версии, которую человек сейчас РАССМАТРИВАЕТ из истории. Пока он не null,
  // доска только читается и чужие правки её не подменяют.
  viewVersion: null
};
const undoS = [], redoS = [];
// Глубина отмены ограничена ДВУМЯ пределами, и байтовый здесь главный. Снимок —
// это весь документ строкой; у карты зависимостей он весит десятки килобайт, а
// у доски со стикерами и рисунками — сотни, и шестьдесят таких копий держали бы
// во вкладке десятки мегабайт строк. Число шагов остаётся вторым пределом,
// чтобы на маленьком проекте история отмены не стала короче привычной.
const UNDO_STEPS = 60, UNDO_BYTES = 24 * 1024 * 1024;
let undoBytes = 0;
function undoPush(str) {
  undoS.push(str); undoBytes += str.length;
  while (undoS.length > UNDO_STEPS || (undoBytes > UNDO_BYTES && undoS.length > 1)) {
    undoBytes -= undoS.shift().length;
  }
}
// Снимать со стека и чистить его нужно ТОЛЬКО через эти две: иначе счётчик байт
// разъедется с содержимым и глубина отмены начнёт врать в любую сторону.
function undoPop() { const str = undoS.pop(); if (str !== undefined) undoBytes -= str.length; return str; }
function undoReset() { undoS.length = 0; redoS.length = 0; undoBytes = 0; }
let snapArmed = true, snapT = null;
function snapshot() {
  if (!snapArmed || !P) return;
  undoPush(JSON.stringify(P));
  redoS.length = 0; snapArmed = false;
  clearTimeout(snapT); snapT = setTimeout(() => snapArmed = true, 650);
}
function snapNow() { snapArmed = true; snapshot(); }
let saveT = null;
function save(immediate) {
  if (ro() || !P) return;
  P.updated = today(); UI.dirty = true; paintSave();
  // Серверная доска: локальная копия остаётся кэшем, а правка уезжает на сервер
  // своей очередью — сеть медленнее локальной записи и может ответить конфликтом.
  if (cloud.boundToServer()) cloud.schedulePush(() => P, onPushState, buildPreview);
  clearTimeout(saveT);
  const go = async () => {
    try { await dbPut(STORE, P); UI.lastSave = new Date(); paintSave(); refreshProjMeta(); }
    catch (e) { toast('Ошибка сохранения: ' + e.message); }
  };
  if (immediate) go(); else saveT = setTimeout(go, 420);
}
// Что делать с ответом сервера на попытку сохранить.
/* ---------- слияние правок доски ----------
   На доске одновременная правка — не исключение, а весь смысл: четверо на воркшопе
   клеят стикеры в одну минуту. Модалка «взять серверную» здесь означала бы «потерять
   свой стикер», и она выскакивала бы постоянно.

   Слияние трёхстороннее и ПО ИДЕНТИФИКАТОРУ объекта, а не CRDT: у объектов есть id,
   и этого хватает. Конфликт остаётся ровно там, где двое правят ОДИН объект, — там
   честно побеждает последний. */
function jamSnapshot(doc) {
  const items = {}, npos2 = {};
  for (const p of (doc.pages || [])) {
    if (p.kind !== 'jam') continue;
    const m = {};
    for (const it of (((p.jam || {}).items) || [])) m[it.id] = JSON.stringify(it);
    items[p.id] = m;
    // Узел, положенный на доску, двигают там же и так же часто — его позиция
    // на ЭТОЙ странице сливается вместе с объектами.
    for (const n of (doc.nodes || [])) {
      const slot = n.p && n.p[p.id];
      if (slot) npos2[n.id + '\u0000' + p.id] = JSON.stringify(slot);
    }
  }
  return {items, npos: npos2};
}
// Документ без всего, что умеет сливаться. Если эта часть у меня не менялась,
// значит мои правки целиком лежат в объектах доски — и слияние ничего не потеряет.
function jamRest(doc) {
  const c = JSON.parse(JSON.stringify(doc));
  const jamIds = new Set((c.pages || []).filter(p => p.kind === 'jam').map(p => p.id));
  for (const p of (c.pages || [])) if (p.kind === 'jam' && p.jam) p.jam.items = [];
  for (const n of (c.nodes || [])) if (n.p) for (const id of jamIds) delete n.p[id];
  return JSON.stringify(c);
}
function jamBase(doc) { const s2 = jamSnapshot(doc); return {items: s2.items, npos: s2.npos, rest: jamRest(doc)}; }

// Возвращает слитый документ или null, если сливать нельзя и нужен разговор с человеком.
function mergeJamDocs(base, mine, theirs) {
  if (!base || !theirs || !Array.isArray(theirs.pages)) return null;
  // Меняли ли ВНЕ объектов доски? Тогда автоматика молча потеряла бы эти правки.
  if (jamRest(mine) !== base.rest) return null;
  const out = JSON.parse(JSON.stringify(theirs));
  const mineSnap = jamSnapshot(mine);
  let touched = 0;

  for (const p of (out.pages || [])) {
    if (p.kind !== 'jam') continue;
    p.jam = p.jam || {items: [], bg: 'dots'};
    if (!Array.isArray(p.jam.items)) p.jam.items = [];
    const was = base.items[p.id] || {};
    const now = (mineSnap.items || {})[p.id];
    if (!now) continue;                       // этой доски у меня нет — не мне и решать
    const theirById = new Map(p.jam.items.map(it => [it.id, it]));

    // мои удаления: было в базе, у меня нет
    for (const id of Object.keys(was)) {
      if (now[id] === undefined && theirById.has(id)) { theirById.delete(id); touched++; }
    }
    // мои добавления и правки: у меня отличается от базы
    for (const id of Object.keys(now)) {
      if (was[id] === now[id]) continue;      // я это не трогал
      theirById.set(id, JSON.parse(now[id]));
      touched++;
    }
    // Порядок наложения берём МОЙ для того, что я трогал, остальное — как у них.
    const mineOrder = (mine.pages.find(x => x.id === p.id).jam.items || []).map(it => it.id);
    const seen = new Set();
    const merged = [];
    for (const id of mineOrder) { const it = theirById.get(id); if (it) { merged.push(it); seen.add(id); } }
    for (const it of p.jam.items) if (!seen.has(it.id) && theirById.has(it.id)) merged.push(theirById.get(it.id));
    p.jam.items = merged;
  }

  // позиции узлов на досках
  const byId = new Map((out.nodes || []).map(n => [n.id, n]));
  for (const key of Object.keys(mineSnap.npos || {})) {
    if (base.npos[key] === mineSnap.npos[key]) continue;
    const [nid, pid] = key.split('\u0000');
    const n = byId.get(nid); if (!n) continue;
    n.p = n.p || {}; n.p[pid] = JSON.parse(mineSnap.npos[key]); touched++;
  }
  for (const key of Object.keys(base.npos || {})) {
    if (mineSnap.npos[key] !== undefined) continue;   // я убрал узел с доски
    const [nid, pid] = key.split('\u0000');
    const n = byId.get(nid); if (n && n.p) { delete n.p[pid]; touched++; }
  }
  return touched ? out : null;
}
function onPushState(st) {
  if (!st) return;
  if (st.ok) { UI.cloudSaved = new Date(); paintSave(); return; }
  if (st.error) { UI.cloudError = st.error; paintSave(); toast('Не сохранилось на сервере: ' + st.error); return; }
  if (!st.conflict) return;
  const srv = st.server || {};
  // Сначала пробуем слить сами. Получается ровно тогда, когда мои правки целиком
  // лежат в объектах доски, — то есть в самом частом и самом болезненном случае.
  const merged = (() => {
    try { return mergeJamDocs(cloud.getBaseJam(), P, srv.doc); } catch (e) { return null; }
  })();
  if (merged) {
    P = normalize(merged);
    cloud.bindBoard(Object.assign({}, cloud.CLOUD.board, {version: srv.version}));
    cloud.setBaseline(fingerprint(P), jamBase(P));
    gInval(); renderPages(); renderPage();
    save();   // отправит слитое поверх серверной версии
    toast('Правки на доске слиты с чужими');
    return;
  }
  // Слить не вышло — молча взять чью-то сторону нельзя: любой выбор здесь стирает
  // чью-то работу. Спрашиваем и показываем, что именно разошлось.
  const mine = `${P.nodes.length} узлов, ${P.links.length} связей`;
  const theirs = srv.doc ? `${srv.doc.nodes.length} узлов, ${srv.doc.links.length} связей` : 'не удалось прочитать';
  modal(`<h3>Доску изменил кто-то ещё</h3>
    <div class="kv" style="font-size:13px">Пока вы правили, на сервере появилась более новая версия${
      srv.updated_at ? ' (от ' + esc(new Date(srv.updated_at).toLocaleString('ru-RU')) + ')' : ''}.
      Слить автоматически нельзя — выберите, что оставить.</div>
    <div class="kv" style="font-size:12.5px;margin-top:8px">У вас: <b>${esc(mine)}</b><br>На сервере: <b>${esc(theirs)}</b></div>
    <div class="hint" style="margin-top:8px">«Скачать свою копию» сохранит ваш вариант файлом — так ничего не потеряется в любом случае.</div>
    <div class="mfoot">
      <button class="btn" data-a="dl">Скачать свою копию</button>
      <button class="btn" data-a="theirs">Взять серверную</button>
      <button class="btn dgr" data-a="mine">Отправить свою поверх</button>
    </div>`, b => {
    b.querySelector('[data-a=dl]').onclick = () => exportProject();
    b.querySelector('[data-a=theirs]').onclick = () => {
      closeModal();
      if (!srv.doc) return;
      snapNow();
      P = normalize(srv.doc);
      cloud.bindBoard(Object.assign({}, cloud.CLOUD.board, {version: srv.version}));
      // Без этого слепок остаётся от ПРЕЖНЕГО документа, и следующая подпись
      // «что поменялось» считается от того, чего уже нет.
      cloud.setBaseline(fingerprint(P), jamBase(P));
      gInval(); save(1); renderPages(); renderPage();
      toast('Взята версия с сервера');
    };
    b.querySelector('[data-a=mine]').onclick = async () => {
      closeModal();
      try {
        const r = await api.boardPut(cloud.CLOUD.board.id, P, srv.version);
        cloud.bindBoard(Object.assign({}, cloud.CLOUD.board, {version: r.version}));
        toast('Ваша версия отправлена');
        paintSave();
      } catch (e) { toast('Не удалось отправить: ' + (e.message || e)); }
    };
  });
}
// Превью для карточки доски на главной. Считается из НАСТОЯЩИХ координат узлов,
// которые уже посчитала раскладка текущей страницы, — рисовать по счётчикам значило бы
// показывать картинку, не имеющую отношения к доске.
//
// Возвращает undefined, если считать не из чего (открыта таблица, канбан, дашборд).
// Сервер трактует undefined как «не трогай прежнее превью»: иначе переход на таблицу
// стирал бы картинку у доски, которая на самом деле не изменилась.
const PREVIEW_NODES = 90, PREVIEW_EDGES = 140;
// Превью доски: те же прямоугольники и линии, что у карты, но собранные
// из объектов страницы. Формат общий — {v:1, n:[[x,y,w,h,color]], e:[[x1,y1,x2,y2]]},
// его уже умеет рисовать previewSVG() в home.js.
function jamPreview(pg) {
  const n = [], mid = {};
  const items = jamItems(pg);
  for (const it of items) {
    if (n.length >= PREVIEW_NODES) break;
    if (it.kind === 'conn') continue;
    const b = it.kind === 'draw' ? drawBox(it) : itemBox(it);
    if (!b) continue;
    mid[it.id] = [Math.round(b.x + b.w / 2), Math.round(b.y + b.h / 2)];
    const c = it.kind === 'section' ? '#e5e8f0' : (it.fill || (it.kind === 'draw' ? (it.stroke || '#1b1f2a') : '#ffd93b'));
    n.push([Math.round(b.x), Math.round(b.y), Math.round(b.w), Math.round(b.h), c]);
  }
  // Узлы графа, положенные на доску, — тоже её содержимое
  for (const nd of cvNodes || []) {
    if (n.length >= PREVIEW_NODES) break;
    const pos = cvPos[nd.id]; if (!pos) continue;
    const sz = nsize(nd, pg.id);
    mid['n:' + nd.id] = [Math.round(pos.x + sz.w / 2), Math.round(pos.y + sz.h / 2)];
    n.push([Math.round(pos.x), Math.round(pos.y), Math.round(sz.w), Math.round(sz.h),
            (catOf(nd.cat) || {}).color || '#9aa1b2']);
  }
  if (!n.length) return undefined;
  const e = [];
  for (const it of items) {
    if (it.kind !== 'conn' || e.length >= PREVIEW_EDGES) continue;
    const a = connEndKey(it.a), b = connEndKey(it.b);
    const pa = a && mid[a], pb = b && mid[b];
    if (!pa || !pb) continue;
    e.push([pa[0], pa[1], pb[0], pb[1]]);
  }
  return {v: 1, n, e};
}
/* ---------- геометрия коннекторов доски ---------- */
// Конец коннектора ссылается на ТРИ разные вещи: объект доски, положенный на неё
// узел графа или просто точку в пустоте. Последнее — не прихоть: в FigJam стрелку
// можно вывести в никуда, и без этого «нарисовать схему» превращается в «сначала
// создай все прямоугольники».
function connAnchor(pg, end) {
  if (!end) return null;
  if (end.x != null && end.y != null && !end.item && !end.node) return {x: +end.x, y: +end.y, box: null};
  let box = null;
  if (end.item) {
    const it = jamItemById(pg, end.item);
    if (!it) return null;
    box = it.kind === 'draw' ? drawBox(it) : itemBox(it);
  } else if (end.node) {
    const p2 = cvPos[end.node]; if (!p2) return null;
    const sz = nsize(nodeById(end.node) || {}, pg.id);
    box = {x: p2.x, y: p2.y, w: sz.w, h: sz.h};
  }
  if (!box) return null;
  return {x: box.x + box.w / 2, y: box.y + box.h / 2, box};
}
// Точка выхода на границе объекта. Сторона 'c' (или не задана) означает «выбери сам»,
// и тогда она считается по взаимному расположению концов — как edgePathAuto для узлов.
function connSide(box, side, toward) {
  if (!box) return null;
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  let s = side;
  if (!s || s === 'c') {
    const dx = toward.x - cx, dy = toward.y - cy;
    s = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'r' : 'l') : (dy > 0 ? 'b' : 't');
  }
  if (s === 'l') return {x: box.x, y: cy, s};
  if (s === 'r') return {x: box.x + box.w, y: cy, s};
  if (s === 't') return {x: cx, y: box.y, s};
  return {x: cx, y: box.y + box.h, s};
}
function connGeom(pg, it) {
  const A = connAnchor(pg, it.a), B = connAnchor(pg, it.b);
  if (!A || !B) return null;
  const p1 = A.box ? connSide(A.box, (it.a || {}).side, B) : {x: A.x, y: A.y, s: null};
  const p2 = B.box ? connSide(B.box, (it.b || {}).side, A) : {x: B.x, y: B.y, s: null};
  return {p1, p2};
}
const PULL = (p1, p2) => Math.max(40, Math.min(160, (Math.abs(p2.x - p1.x) + Math.abs(p2.y - p1.y)) / 2.5));
function connPath(pg, it) {
  const g = connGeom(pg, it); if (!g) return '';
  const {p1, p2} = g, style = it.style || 'curve';
  if (style === 'line') return `M${p1.x},${p1.y} L${p2.x},${p2.y}`;
  if (style === 'ortho') {
    // Выход из стороны на 24px, затем Z-образный ход. Обхода препятствий нет
    // и не планируется: FigJam тоже не обходит.
    const out = 24;
    const a1 = stepOut(p1, out), a2 = stepOut(p2, out);
    const horiz = (p1.s === 'l' || p1.s === 'r' || !p1.s);
    const mid = horiz ? (a1.x + a2.x) / 2 : (a1.y + a2.y) / 2;
    const pts = horiz
      ? [p1, a1, {x: mid, y: a1.y}, {x: mid, y: a2.y}, a2, p2]
      : [p1, a1, {x: a1.x, y: mid}, {x: a2.x, y: mid}, a2, p2];
    return pts.map((q, i) => (i ? 'L' : 'M') + Math.round(q.x) + ',' + Math.round(q.y)).join(' ');
  }
  const pull = PULL(p1, p2);
  const c1 = offBy(p1, pull), c2 = offBy(p2, pull);
  return `M${p1.x},${p1.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${p2.x},${p2.y}`;
}
function stepOut(p, d) {
  if (p.s === 'l') return {x: p.x - d, y: p.y};
  if (p.s === 'r') return {x: p.x + d, y: p.y};
  if (p.s === 't') return {x: p.x, y: p.y - d};
  if (p.s === 'b') return {x: p.x, y: p.y + d};
  return {x: p.x, y: p.y};
}
const offBy = (p, d) => stepOut(p, d);
function connBox(it) {
  const pg = curPage();
  const g = connGeom(pg, it); if (!g) return null;
  const x0 = Math.min(g.p1.x, g.p2.x), y0 = Math.min(g.p1.y, g.p2.y);
  return {x: x0, y: y0, w: Math.abs(g.p2.x - g.p1.x) || 1, h: Math.abs(g.p2.y - g.p1.y) || 1};
}
// Конец коннектора ссылается либо на объект доски, либо на узел графа,
// либо просто на точку. Ключ нужен, чтобы найти его середину в одной таблице.
function connEndKey(end) {
  if (!end) return null;
  if (end.item) return end.item;
  if (end.node) return 'n:' + end.node;
  return null;
}
function buildPreview() {
  try {
    const pg = curPage();
    if (!P || !pg || !isSpatial(pg)) return undefined;
    // У доски своё содержимое: считать превью по одним узлам графа значит вернуть
    // undefined, а undefined сервер понимает как «не трогай прежнее» — картинка
    // доски на главной замерла бы на том, что было до её появления.
    if (isJam(pg)) return jamPreview(pg);
    if (!cvNodes || !cvNodes.length) return undefined;
    const n = [], mid = {};
    for (const nd of cvNodes.slice(0, PREVIEW_NODES)) {
      const pos = cvPos[nd.id]; if (!pos) continue;
      const sz = nsize(nd, pg.id);
      const c = (catOf(nd.cat) || {}).color || (statusOf(nd.status) || {}).color || '#9aa1b2';
      mid[nd.id] = [Math.round(pos.x + sz.w / 2), Math.round(pos.y + sz.h / 2)];
      n.push([Math.round(pos.x), Math.round(pos.y), Math.round(sz.w), Math.round(sz.h), c]);
    }
    if (!n.length) return undefined;
    const e = [];
    for (const l of P.links) {
      const a = mid[l.from], b = mid[l.to];
      if (!a || !b) continue;
      e.push([a[0], a[1], b[0], b[1]]);
      if (e.length >= PREVIEW_EDGES) break;
    }
    return {v: 1, n, e};
  } catch { return undefined; }
}

/* ==========================================================================
   ЧТО ИМЕННО ПОМЕНЯЛОСЬ
   --------------------------------------------------------------------------
   Строка истории «изменено 09:41» не отвечает ни на один вопрос, ради которого
   в историю заходят. Разницу считает клиент: сервер документ не разбирает,
   и знание про узлы, связи и статусы у него заводить незачем.

   Храним не копию документа, а слепок — id → подпись полей, которые видно.
   Вторая копия доски в памяти ради подписи к строчке истории того не стоит.
   ========================================================================== */
function fingerprint(doc) {
  if (!doc) return null;
  const n = {};
  for (const x of doc.nodes || []) {
    n[x.id] = [x.name, x.sub, x.status, x.cat, x.type, x.draft ? 1 : 0,
      (x.checks || []).length, JSON.stringify(x.f || {}), (x.body || '').length].join('\u0001');
  }
  const l = {};
  for (const x of doc.links || []) l[x.from + '>' + x.to] = x.type || '';
  return {name: doc.name || '', n, l, pages: (doc.pages || []).length};
}

function summarize(base, doc) {
  const cur = fingerprint(doc);
  if (!base || !cur) return null;
  let added = 0, removed = 0, changed = 0;
  for (const id in cur.n) { if (!(id in base.n)) added++; else if (base.n[id] !== cur.n[id]) changed++; }
  for (const id in base.n) if (!(id in cur.n)) removed++;
  let la = 0, lr = 0;
  for (const k in cur.l) if (!(k in base.l)) la++;
  for (const k in base.l) if (!(k in cur.l)) lr++;
  const parts = [];
  if (added) parts.push('+' + nOf(added, NODES));
  if (removed) parts.push('−' + nOf(removed, NODES));
  if (changed) parts.push('изменено ' + nOf(changed, NODES));
  if (la) parts.push('+' + nOf(la, LINKS));
  if (lr) parts.push('−' + nOf(lr, LINKS));
  if (base.name !== cur.name) parts.push('переименована');
  if (base.pages !== cur.pages) parts.push(cur.pages > base.pages ? 'добавлена страница' : 'убрана страница');
  // Двинули узел, поправили описание, покрутили фильтр — по подписи это неотличимо
  // от «ничего», а версия всё равно записана. Честнее сказать «правки на холсте»,
  // чем нарисовать пустую строку и заставить гадать.
  return parts.length ? parts.join(', ') : 'правки на холсте';
}

function refreshProjMeta() {
  const m = PROJECTS.find(x => x.id === P.id);
  if (m) {m.name = P.name; m.desc = P.desc; m.updated = P.updated; m.nodes = P.nodes.length; m.links = P.links.length;}
}
/* ==========================================================================
   ЖИВОЙ КАНАЛ: чужая правка, курсоры, кто здесь
   ========================================================================== */
// Чужая правка приезжает сама. Применяем её ТОЛЬКО когда у нас нет неотправленного:
// иначе она затёрла бы работу, которую человек делает прямо сейчас. Если своё
// не ушло — молчим и даём отправке упереться в 409, где уже есть разбор конфликта.
function onLiveUpdate(m) {
  const b = cloud.CLOUD.board;
  if (!b || !m) return;
  if (m.version <= b.version) return;              // это наша же правка вернулась эхом
  // Пока человек смотрит старую версию, подменять её под ним нельзя: он потеряет
  // то, ради чего открыл историю. Актуальное состояние он увидит по «К текущей».
  if (UI.viewVersion) { toast(`${(m.by && m.by.name) || 'Коллега'} изменил доску`); return; }
  // Признак «есть неотправленное» — это очередь отправки, а НЕ UI.dirty:
  // dirty означает «не выгружено в файл» и не сбрасывается после сохранения,
  // так что по нему чужая правка не доезжала бы никогда.
  if (cloud.hasPending()) {
    toast(`${(m.by && m.by.name) || 'Коллега'} изменил доску — ваши правки ещё не отправлены`);
    return;
  }
  // Большая доска приезжает уведомлением без документа (см. LIVE_FULL_MAX
  // в server/src/live.js) — забираем свежую версию сами.
  if (!m.doc) { fetchLiveDoc(m); return; }
  applyLiveDoc(m, m.doc);
}
// Догрузка документа по уведомлению. Один запрос за раз и только за самой свежей
// версией: пока идёт загрузка, коллега успевает сохранить ещё несколько раз,
// и тянуть каждую промежуточную — значит гарантированно отстать.
let liveFetching = false, liveWanted = null;
async function fetchLiveDoc(m) {
  liveWanted = m;
  if (liveFetching) return;
  liveFetching = true;
  try {
    while (liveWanted) {
      const want = liveWanted; liveWanted = null;
      const b = cloud.CLOUD.board;
      if (!b || want.version <= b.version) continue;
      const r = await api.boardGet(b.id);
      // Пока ходили на сервер, всё могло измениться: человек начал править,
      // ушёл в историю или открыл другую доску. Тогда молча отступаем —
      // своё дороже чужого, и упереться в 409 честнее, чем затереть.
      if (!cloud.CLOUD.board || cloud.CLOUD.board.id !== b.id) continue;
      if (UI.viewVersion || cloud.hasPending()) continue;
      if (r.version <= cloud.CLOUD.board.version) continue;
      applyLiveDoc({version: r.version, by: want.by, summaryText: want.summaryText}, r.doc);
    }
  } catch (e) {
    toast('Не удалось получить свежую версию: ' + e.message);
  } finally { liveFetching = false; }
}
function applyLiveDoc(m, doc) {
  const b = cloud.CLOUD.board; if (!b) return;
  const keepPage = UI.page, keepView = UI.view, keepSel = [...UI.sel], keepInsp = UI.insp;
  P = normalize(doc);
  cloud.bindBoard(Object.assign({}, b, {version: m.version}));
  cloud.setBaseline(fingerprint(P), jamBase(P));
  gInval();
  UI.view = keepView;
  if (P.pages.some(p => p.id === keepPage)) UI.page = keepPage;
  UI.sel = new Set(keepSel.filter(id => nodeById(id)));
  renderPages(); renderPage();
  if (keepInsp && nodeById(keepInsp)) openNode(keepInsp);
  else if (keepInsp) closeInsp();
  UI.lastSave = new Date(); UI.dirty = false; paintSave();
  dbPut(STORE, P).catch(() => {});
  toast(`${(m.by && m.by.name) || 'Коллега'}: ${m.summaryText || 'доска обновлена'}`);
}

// Стопка аватаров в шапке — это те, кто на доске ПРЯМО СЕЙЧАС. Показывать здесь
// список тех, у кого есть доступ, было бы обещанием присутствия, которого нет:
// «кому открыто» живёт в окне «Поделиться».
function paintPeers() {
  const box = $('tbMembers'); if (!box) return;
  const others = live.peersOther();
  box.innerHTML = others.map(p => `<span class="avat sm" style="background:${esc(p.color)}"
    title="${esc(p.name)} — сейчас на доске">${esc(home.initialsOf(p))}</span>`).join('');
  box.classList.toggle('hidden', !others.length);
}

// Чужие курсоры живут в собственном слое внутри сцены: так они едут вместе
// с холстом при панораме и зуме, без пересчёта на каждый кадр.
function paintCursors(cursors) {
  const layer = $('lyCursors'); if (!layer) return;
  const pid = UI.page, k = view().k || 1;
  const now = Date.now();
  const items = Object.entries(cursors || {})
    .filter(([, c]) => c.page === pid && now - c.at < 15000);
  layer.innerHTML = items.map(([id, c]) => `<div class="curs" style="left:${c.x}px;top:${c.y}px;
    transform:scale(${(1 / k).toFixed(3)});color:${esc(c.color)}">
    <svg viewBox="0 0 12 18" width="14" height="20"><path d="M1 1l10 9.5-4.6.5 2.6 5.2-2.2 1.1L4.3 12 1 15z"
      fill="currentColor" stroke="#fff" stroke-width="1.2"/></svg>
    <span class="nm" style="background:${esc(c.color)}">${esc(c.name)}</span></div>`).join('');
}

function paintSave() {
  const el = $('saveState'); if (!el) return;
  if (VIEWER) {el.textContent = 'режим просмотра'; return;}
  // Где именно живёт доска, должно быть видно всегда: «сохранено» без указания места
  // не отвечает на главный вопрос — переживёт ли правка закрытие браузера.
  let where = '';
  if (cloud.boundToServer()) {
    const b = cloud.CLOUD.board;
    where = UI.cloudError
      ? '<br><span style="color:var(--red)" title="' + esc(UI.cloudError) + '">⚠ не ушло на сервер</span>'
      // Номер версии — сам по себе вход в историю: человек, который спрашивает
      // «а что тут менялось», смотрит именно на него.
      : '<br><span class="verlink" title="версия ' + (b.version || '?') + ' · открыть историю изменений">' +
        '☁ на сервере · v' + (b.version || '?') +
        (b.role === 'viewer' ? ' · только просмотр' : '') + (b.asAdmin ? ' · вы админ' : '') + '</span>';
  } else if (cloud.CLOUD.account) {
    where = '<br><span style="color:var(--muted)" title="проект хранится только в этом браузере">только здесь</span>';
  }
  el.innerHTML = `${nOf(P ? P.nodes.length : 0, NODES)} · ${nOf(P ? P.links.length : 0, LINKS)}<br>сохранено ${UI.lastSave ? UI.lastSave.toLocaleTimeString('ru-RU').slice(0, 5) : '—'}${where}`;
  const vl = qs('.verlink', el);
  if (vl) vl.onclick = () => showHistory();
  const nm = $('bName');
  if (nm) { nm.textContent = P ? (P.name || 'Без названия') : '—'; nm.title = ro() ? (P ? P.name : '') : 'Переименовать доску'; }
  const nh = $('navHistory');
  if (nh) nh.classList.toggle('hidden', !cloud.boundToServer());
  const sh = $('bShare');
  if (sh) sh.classList.toggle('hidden', !cloud.boundToServer() || cloud.CLOUD.board.role === 'viewer');
  // В режиме просмотра (демо, ссылка-просмотр) вместо органов правки предлагаем вход:
  // иначе человек видит только запертые кнопки и не понимает, что делать дальше.
  const lg = $('bLogin');
  if (lg) lg.classList.toggle('hidden', !(ro() && !VIEWER && !cloud.CLOUD.account));
  $('bUndo').disabled = !undoS.length; $('bRedo').disabled = !redoS.length;
}
function undo() {
  if (!undoS.length) return;
  redoS.push(JSON.stringify(P)); P = JSON.parse(undoPop());
  gInval(); save(1); if (UI.insp && !nodeById(UI.insp)) closeInsp();
  renderPages(); renderPage(); if (UI.insp) openNode(UI.insp);
  toast('Отменено');
}
function redo() {
  if (!redoS.length) return;
  undoPush(JSON.stringify(P)); P = JSON.parse(redoS.pop());
  gInval(); save(1); renderPages(); renderPage(); toast('Возвращено');
}
function edit(fn, opt) {
  snapshot(); fn(); gInval(); save();
  if (!opt || opt.render !== false) renderPage();
  if (UI.insp && (!opt || opt.insp !== false)) openNode(UI.insp, true);
}

/* ---------- доступ к схеме ---------- */
const nodeById = id => P.nodes.find(n => n.id === id);
const linkById = id => P.links.find(l => l.id === id);
const statusOf = k => P.schema.statuses.find(s => s.key === k) || {key: k, name: k || '—', color: '#a8aebd'};
const catOf = k => P.schema.categories.find(c => c.key === k) || {key: k, name: k || '—', color: '#9aa1b2'};
const typeOf = k => P.schema.nodeTypes.find(t => t.key === k) || {key: k, name: k || '—', shape: 'rect'};
const ltOf = k => P.schema.linkTypes.find(t => t.key === k) || P.schema.linkTypes[0] || {key: k, name: k, color: '#9aa1b2', style: 'solid', blocking: 1};
const fieldOf = k => P.schema.fields.find(f => f.key === k);
const pageById = id => P.pages.find(p => p.id === id);
const curPage = () => pageById(UI.page) || P.pages[0];
const nBlockers = n => (n.checks || []).filter(c => c.b).length;
function fval(n, key) {
  if (key === 'name') return n.name; if (key === 'sub') return n.sub;
  if (key === 'status') return n.status; if (key === 'cat') return n.cat; if (key === 'type') return n.type;
  if (key === 'body') return n.body;
  if (key.startsWith('f.')) return (n.f || {})[key.slice(2)];
  return (n.f || {})[key];
}
function fset(n, key, v) {
  if (['name', 'sub', 'status', 'cat', 'type', 'body'].includes(key)) {n[key] = v; return;}
  const k = key.startsWith('f.') ? key.slice(2) : key;
  n.f = n.f || {};
  if (v === '' || v == null) delete n.f[k]; else n.f[k] = v;
}
/* поля, доступные для фильтров/группировок/колонок */
function allFields() {
  return [{key: 'name', label: 'Название', type: 'text'}, {key: 'sub', label: 'Подпись', type: 'text'},
    {key: 'type', label: 'Тип', type: 'enum', enum: () => P.schema.nodeTypes.map(t => [t.key, t.name])},
    {key: 'status', label: 'Статус', type: 'enum', enum: () => P.schema.statuses.map(t => [t.key, t.name])},
    {key: 'cat', label: 'Категория', type: 'enum', enum: () => P.schema.categories.map(t => [t.key, t.name])},
    ...P.schema.fields.map(f => ({key: 'f.' + f.key, label: f.label, type: f.type, options: f.options}))];
}
const COLMETA = {
  name: 'Название', sub: 'Подпись', type: 'Тип', status: 'Статус', cat: 'Категория',
  step: 'Шаг', weight: 'Вес', checks: 'Вехи', blockers: 'Блокеры', deps: 'Держат', kids: 'Открывает', id: 'ID', body: 'Описание'
};
const colLabel = c => COLMETA[c] || (fieldOf(c.replace(/^f\./, '')) || {}).label || c;

/* ---------- граф: слои, вес, критический путь ---------- */
let _g = null;
function gInval() { _g = null; }
function G() {
  if (_g) return _g;
  const ids = new Set(P.nodes.map(n => n.id));
  const kids = {}, par = {}, layer = {}, hardPar = {};
  P.nodes.forEach(n => {kids[n.id] = []; par[n.id] = []; hardPar[n.id] = [];});
  P.links.forEach(l => {
    if (!ids.has(l.from) || !ids.has(l.to)) return;
    const blocking = !!ltOf(l.type).blocking;
    kids[l.from].push({id: l.to, lid: l.id, soft: !blocking});
    par[l.to].push({id: l.from, lid: l.id, soft: !blocking});
    if (blocking) hardPar[l.to].push(l.from);
  });
  const seen = {};
  const L = id => {
    if (layer[id] !== undefined) return layer[id];
    if (seen[id]) return 0; seen[id] = 1;
    const d = hardPar[id] || [];
    layer[id] = d.length ? Math.max(...d.map(L)) + 1 : 0;
    return layer[id];
  };
  P.nodes.forEach(n => L(n.id));
  const reach = (id, map) => {
    const s = new Set(), st = map[id].map(x => x.id);
    while (st.length) {const x = st.pop(); if (s.has(x)) continue; s.add(x); (map[x] || []).forEach(y => st.push(y.id));}
    return s;
  };
  const DESC = {}, ANC = {};
  P.nodes.forEach(n => {DESC[n.id] = reach(n.id, kids); ANC[n.id] = reach(n.id, par);});
  const W = id => (DESC[id] || new Set()).size;
  const memo = {}, nxt = {};
  const f = id => {
    if (memo[id] !== undefined) return memo[id];
    memo[id] = 0; let best = 0, b = null;
    kids[id].filter(k => !k.soft).forEach(k => {const v = f(k.id); if (v > best) {best = v; b = k.id;}});
    nxt[id] = b; memo[id] = best + DESC[id].size + 1; return memo[id];
  };
  P.nodes.forEach(n => f(n.id));
  let start = null, len = -1;
  P.nodes.filter(n => par[n.id].length === 0).forEach(n => {if (memo[n.id] > len) {len = memo[n.id]; start = n.id;}});
  const crit = new Set(); let c = start; while (c) {crit.add(c); c = nxt[c];}
  _g = {kids, par, layer, DESC, ANC, W, crit, hardPar};
  return _g;
}
const stepOf = n => (n.lane != null && n.lane !== '') ? +n.lane : G().layer[n.id];
function hasCycle() {
  const st = {}; let cyc = false;
  const ids = new Set(P.nodes.map(n => n.id));
  const adj = {}; P.nodes.forEach(n => adj[n.id] = []);
  P.links.forEach(l => {if (ids.has(l.from) && ids.has(l.to)) adj[l.from].push(l.to);});
  const go = id => {
    if (st[id] === 2) return; if (st[id] === 1) {cyc = true; return;}
    st[id] = 1; adj[id].forEach(go); st[id] = 2;
  };
  P.nodes.forEach(n => go(n.id));
  return cyc;
}

/* ---------- фильтр страницы ---------- */
function matchFilter(n, flt) {
  if (!flt) return true;
  if (flt.cats && flt.cats.length && !flt.cats.includes(n.cat)) return false;
  if (flt.statuses && flt.statuses.length && !flt.statuses.includes(n.status)) return false;
  if (flt.types && flt.types.length && !flt.types.includes(n.type)) return false;
  if (flt.blockersOnly && !nBlockers(n)) return false;
  if (flt.f) for (const k in flt.f) {
    const want = flt.f[k]; if (!want || !want.length) continue;
    const v = (n.f || {})[k];
    if (Array.isArray(v)) {if (!v.some(x => want.includes(x))) return false;}
    else if (!want.includes(v)) return false;
  }
  if (flt.q) {
    const q = flt.q.toLowerCase();
    const hay = [n.name, n.sub, n.id, n.body, ...Object.values(n.f || {}).flat(), ...(n.checks || []).map(c => c.t + ' ' + c.z)].join(' ').toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}
// Две пространственные страницы с общим движком камеры, но разным смыслом:
//   canvas — «в каком порядке это физически может поехать»: колонка = глубина зависимости,
//            видны все узлы проекта, прошедшие фильтр, раскладку считает граф;
//   space  — «как это устроено»: свободная схема, на ней лежит только то, что положили,
//            позиции и размеры руками.
// Механика холста (камера, перетаскивание, копипаст, клавиши) общая — её и разводит isSpatial.
//
// Предикатов ТРИ, и путать их дорого:
//   isSpatial — «страница с камерой»: зум, панорама, перетаскивание, копипаст,
//               клавиши, курсоры коллег. Сюда входит и доска.
//   isGraphCv — «холст графа»: там, где смысл именно в узлах и зависимостях
//               (диспетчер отрисовки, экспорт картинки, клавиша N).
//   isJam     — свободная доска: свои объекты, свои инструменты.
const isSpatial = pg => !!pg && (pg.kind === 'canvas' || pg.kind === 'space' || pg.kind === 'jam');
const isJam = pg => !!pg && pg.kind === 'jam';
const isGraphCv = pg => !!pg && (pg.kind === 'canvas' || pg.kind === 'space');
function pageNodes(pg) {
  // на свободной схеме присутствие узла = наличие его позиции для этой страницы.
  // Иначе на неё вываливались бы все узлы проекта кучей, чего от доски никто не ждёт.
  // На схеме и на доске присутствие узла = наличие его позиции для этой страницы.
  // Иначе на них вываливались бы все узлы проекта кучей, чего от доски никто не ждёт.
  if (pg.kind === 'space' || pg.kind === 'jam') return P.nodes.filter(n => npos(n, pg.id) && matchFilter(n, pg.filter));
  return P.nodes.filter(n => matchFilter(n, pg.filter));
}


/* ==========================================================================
   ХОЛСТ
   ========================================================================== */
const NW = 212, NH = 74, COLGAP = 108, SUBGAP = 34, ROWGAP = 12, PADX = 60, PADY = 70;
const GRID = 8;
let drag = null, cvNodes = [], cvPos = {}, laneInfo = [];
// Состояние жеста живёт на уровне модуля, а не внутри wireCanvas: она вызывается
// на КАЖДУЮ отрисовку холста, и обработчики на window копились бы с каждой.
const ptrs = new Map();   // активные пальцы: pointerId -> {x, y}
let pinch = null, cvClearLong = () => {};
// Текущий инструмент доски и его настройки. На уровне модуля, а НЕ внутри wireCanvas
// и не в документе: инструмент — это состояние руки, а не свойство доски, и переживать
// перерисовку он обязан, а уезжать в общий документ и историю версий — нет.
const JAM = {
  tool: 'sel',            // sel|hand|sticky|text|shape|pen|hl|eraser|conn|section
  shape: 'roundrect',
  fill: '#ffd93b',
  stroke: '#1b1f2a',
  sw: 3,
  size: 15,
  sticky: false,          // инструмент залипает: ставить объекты подряд
};
// Палитра доски. Цвет хранится значением, а не ключом: у доски нет схемы проекта,
// и привязывать стикер к типу узла было бы натяжкой.
const JAM_FILLS = ['#ffd93b', '#ffc0cb', '#c9e3ff', '#c7f0cd', '#e5d4ff', '#ffd8b0', '#e5e8f0', '#ffffff'];
// Отпускание слушаем на window, а не на холсте: палец может уйти за его край,
// и тогда pointerup до холста не доедет — счётчик пальцев останется грязным,
// а следующий жест начнётся с «уже два пальца» и не сработает.
const endPtr = e => {
  cvClearLong();
  ptrs.delete(e.pointerId);
  if (ptrs.size < 2) pinch = null;
};
window.addEventListener('pointerup', endPtr);
window.addEventListener('pointercancel', endPtr);

function npos(n, pid) { return (n.p && n.p[pid]) || null; }
function setNpos(n, pid, x, y) { n.p = n.p || {}; n.p[pid] = {x: Math.round(x), y: Math.round(y)}; }
function isPinned(n, pid) { return !!(n.p && n.p[pid]); }
// Размер узла. Хранится ПО СТРАНИЦАМ, в n.p[pid].w/h — рядом с позицией.
// В корень ноды (n.w/n.h) не пишем: это повторило бы техдолг n.x/n.y, когда размер
// один на все страницы. Два запасных источника — оба легаси: n.w/n.h из старых файлов
// и n.sz[pid], куда до 2.5.0 писал place_nodes из коннектора (см. migrateNodeSizes).
function nsize(n, pid) {
  const p = (n.p || {})[pid] || {}, z = (n.sz || {})[pid] || {};
  return {w: p.w || z.w || n.w || NW, h: p.h || z.h || n.h || NH};
}
function setNsize(n, pid, w, h) {
  n.p = n.p || {}; n.p[pid] = n.p[pid] || {x: 0, y: 0};
  n.p[pid].w = Math.round(w); n.p[pid].h = Math.round(h);
}
// Камера — личное состояние человека, а не часть документа. Под общим сервером
// панорамирование одного не должно писать в проект и порождать конфликты и события истории.
// pg.view остаётся читаемым (старые проекты и импорт), но больше не записывается.
const viewKey = pid => `gs_view:${(P && P.id) || '-'}:${pid}`;
function readView(pid) {
  try {
    const raw = localStorage.getItem(viewKey(pid));
    if (raw) {
      const v = JSON.parse(raw);
      if (isFinite(v.x) && isFinite(v.y) && isFinite(v.k)) return {x: v.x, y: v.y, k: clamp(v.k, .08, 3), _done: 1};
    }
  } catch (e) {}
  return null;
}
function view() {
  const id = UI.page;
  if (!UI.view[id]) {
    const pg = pageById(id), sv = pg && pg.view;
    const loc = readView(id);
    if (loc) UI.view[id] = loc;
    else if (sv && isFinite(sv.x) && isFinite(sv.y) && isFinite(sv.k)) {
      UI.view[id] = {x: sv.x, y: sv.y, k: clamp(sv.k, .08, 3), _done: 1};
    } else UI.view[id] = {x: 40, y: 40, k: 1};
  }
  return UI.view[id];
}
const cvRect = () => $('cv').getBoundingClientRect();
// Ширина инспектора, когда он открыт. Оверлей не меняет размер #cv, поэтому
// камеру надо считать по ВИДИМОЙ части, иначе выбранный узел уезжает под панель.
function inspW() {
  const el = $('insp');
  return el && el.classList.contains('open') ? el.getBoundingClientRect().width : 0;
}
function visibleRect() {
  const r = cvRect(), w = Math.min(inspW(), Math.max(0, r.width - 200));
  return {left: r.left, top: r.top, width: r.width - w, height: r.height};
}
function toWorld(cx, cy) {const v = view(), r = cvRect(); return {x: (cx - r.left - v.x) / v.k, y: (cy - r.top - v.y) / v.k};}
const GRIDBG = 22;   // шаг точечной сетки в мировых координатах
function applyView() {
  if ($('lyCursors')) paintCursors(live.LIVE.cursors);
  const v = view(), s = $('scene');
  if (s) s.style.transform = `translate(${v.x}px,${v.y}px) scale(${v.k})`;
  const z = $('zval'); if (z) z.textContent = Math.round(v.k * 100) + '%';
  // Сетка нарисована фоном на #cv, а #cv камерой не двигается — раньше точки стояли
  // намертво и при панораме «плыли» относительно узлов. Двигаем и масштабируем фон сами.
  const cv = $('cv');
  if (cv) {
    let step = GRIDBG * v.k;
    while (step > 0 && step < 11) step *= 2;      // на мелком зуме точки сливались бы в кашу
    while (step > 90) step /= 2;                  // на крупном — расползались бы
    cv.style.backgroundSize = `${step}px ${step}px, auto`;
    cv.style.backgroundPosition = `${v.x % step}px ${v.y % step}px, 0 0`;
  }
  drawMini();
  // Панель свойств стоит над выделением в ЭКРАННЫХ координатах: при панораме
  // и зуме её надо пересчитать, иначе она отвязывается от объекта.
  if ($('jprops') && UI.selItems.size) paintProps();
  scheduleViewSave(UI.page);
}
let viewSaveT = null;
function scheduleViewSave(pid) {
  if (VIEWER) return;
  clearTimeout(viewSaveT);
  viewSaveT = setTimeout(() => persistView(pid), 1000);
}
// Камера у каждого своя и хранится в браузере. В документах, пришедших из старых
// версий, она осталась лежать полем page.view — и с тех пор ездила в каждом экспорте
// и в каждой копии доски: чужой зум годичной давности, который никогда не обновится.
// Читаем такое значение один раз, переносим себе в браузер и убираем из документа.
function migrateLegacyViews() {
  if (VIEWER || !P || ro()) return;
  let moved = 0;
  for (const pg of P.pages || []) {
    const v = pg.view;
    if (!v || !isFinite(v.x) || !isFinite(v.y) || !isFinite(v.k)) continue;
    try {
      if (!localStorage.getItem(viewKey(pg.id))) {
        localStorage.setItem(viewKey(pg.id), JSON.stringify({x: Math.round(v.x), y: Math.round(v.y), k: +(+v.k).toFixed(4)}));
      }
    } catch (e) {}
    delete pg.view;
    moved++;
  }
  if (moved) save();
}

function persistView(pid) {
  if (VIEWER || !P) return;
  const pg = pageById(pid); if (!isSpatial(pg)) return;
  const v = UI.view[pid]; if (!v) return;
  const nv = {x: Math.round(v.x), y: Math.round(v.y), k: +(+v.k).toFixed(4)};
  try {localStorage.setItem(viewKey(pid), JSON.stringify(nv));} catch (e) {}
}
function zoomAt(cx, cy, factor) {
  const v = view(), r = cvRect();
  const k2 = clamp(v.k * factor, .08, 3);
  const wx = (cx - r.left - v.x) / v.k, wy = (cy - r.top - v.y) / v.k;
  v.x = cx - r.left - wx * k2; v.y = cy - r.top - wy * k2; v.k = k2;
  applyView();
}

/* ---------- авто-раскладка ---------- */
function autoLayout(nodes) {
  const g = G(), ids = new Set(nodes.map(n => n.id));
  const pos = {};
  if (!nodes.length) return {pos, lanes: []};
  const dl = {}, sn = {};
  const DL = id => {
    if (dl[id] !== undefined) return dl[id];
    if (sn[id]) return 0; sn[id] = 1;
    const d = (g.hardPar[id] || []).filter(x => ids.has(x));
    const lv = x => {const nx = nodeById(x); return (nx.lane != null && nx.lane !== '') ? +nx.lane : DL(x);};
    dl[id] = d.length ? Math.max(...d.map(lv)) + 1 : 0; return dl[id];
  };
  nodes.forEach(n => DL(n.id));
  const CO = n => (n.lane != null && n.lane !== '') ? +n.lane : dl[n.id];
  const maxL = Math.max(...nodes.map(CO), 0);
  const raw = []; for (let i = 0; i <= maxL; i++) raw[i] = nodes.filter(n => CO(n) === i);
  const cols = [], capIdx = [];
  raw.forEach((c, i) => {if (c.length) {cols.push(c); capIdx.push(i);}});
  const ord = {};
  cols.forEach((c, li) => {
    const inCol = new Set(c.map(n => n.id)), lv = {}, s2 = {};
    const LV = id => {
      if (lv[id] !== undefined) return lv[id];
      if (s2[id]) return 0; s2[id] = 1;
      const d = (g.hardPar[id] || []).filter(x => inCol.has(x));
      lv[id] = d.length ? Math.max(...d.map(LV)) + 1 : 0; return lv[id];
    };
    c.forEach(n => LV(n.id));
    c.sort((a, b) => (li ? lv[a.id] - lv[b.id] : 0) || g.W(b.id) - g.W(a.id) || String(a.cat).localeCompare(String(b.cat)));
    c.forEach((n, i) => {ord[n.id] = i; n._lv = lv[n.id] || 0;});
  });
  for (let it = 0; it < 6; it++) {
    const dir = it % 2 === 0, seq = dir ? cols : [...cols].reverse();
    seq.forEach(c => {
      c.forEach(n => {
        const r = (dir ? g.par[n.id] : g.kids[n.id]).filter(x => ids.has(x.id)).map(x => ord[x.id]);
        n._bc = r.length ? r.reduce((a, b) => a + b, 0) / r.length : ord[n.id];
      });
      c.sort((a, b) => (a._lv || 0) - (b._lv || 0) || g.W(b.id) - g.W(a.id) || a._bc - b._bc);
      c.forEach((n, i) => ord[n.id] = i);
    });
  }
  const subs = cols.map(c => {
    const mx = Math.max(...c.map(n => n._lv || 0), 0), gg = [];
    for (let i = 0; i <= mx; i++) gg.push(c.filter(n => (n._lv || 0) === i).sort((a, b) => ord[a.id] - ord[b.id]));
    return gg;
  });
  const maxRows = Math.max(...subs.flat().map(x => x.length), 1);
  const colX = []; let x = PADX;
  subs.forEach(gr => {colX.push(x); x += gr.length * NW + (gr.length - 1) * SUBGAP + COLGAP;});
  subs.forEach((gr, li) => gr.forEach((grp, si) => {
    const total = grp.length * (NH + ROWGAP) - ROWGAP;
    const y0 = PADY + (maxRows * (NH + ROWGAP) - ROWGAP - total) / 2;
    grp.forEach((n, i) => pos[n.id] = {x: colX[li] + si * (NW + SUBGAP), y: y0 + i * (NH + ROWGAP)});
  }));
  const H = PADY + maxRows * (NH + ROWGAP) + 40;
  return {pos, lanes: colX.map((cx, i) => ({x: cx, idx: capIdx[i], h: H}))};
}
// Засев позиций для свободной раскладки. Вызывается ТОЛЬКО по явному действию —
// создание страницы, переключение раскладки. Раньше это делала отрисовка, из-за чего
// открытие страницы само по себе меняло проект: под общим документом это дало бы
// конкурирующие записи у всех, кто открыл доску одновременно.
function seedFreePositions(pg) {
  if (!pg || pg.kind !== 'canvas' || !pg.canvas || pg.canvas.layout !== 'free') return false;
  const nodes = pageNodes(pg), auto = autoLayout(nodes);
  let seeded = false;
  nodes.forEach(n => {
    if (npos(n, pg.id)) return;
    const p = (n.x != null && n.y != null) ? {x: n.x, y: n.y} : (auto.pos[n.id] || {x: 0, y: 0});
    setNpos(n, pg.id, p.x, p.y); seeded = true;
  });
  return seeded;
}
function layoutPage(pg, nodes) {
  const pid = pg.id;
  if (pg.kind === 'space' || pg.kind === 'jam') {
    // никакой авто-раскладки: узел стоит там, где его положили
    const pos = {};
    nodes.forEach(n => {const p = npos(n, pid); if (p) pos[n.id] = {x: p.x, y: p.y};});
    laneInfo = [];
    return pos;
  }
  const auto = autoLayout(nodes);
  const pos = {};
  if ((pg.canvas || {}).layout === 'auto') {
    nodes.forEach(n => pos[n.id] = npos(n, pid) || (n.pinned && n.x != null ? {x: n.x, y: n.y} : (auto.pos[n.id] || {x: 0, y: 0})));
    laneInfo = auto.lanes;
  } else {
    // Отрисовка НИЧЕГО не пишет в проект: узел без своей позиции просто берёт
    // расчётную. Засев позиций — явное действие, см. seedFreePositions().
    nodes.forEach(n => {
      const p = npos(n, pid) ||
        ((n.x != null && n.y != null) ? {x: n.x, y: n.y} : (auto.pos[n.id] || {x: 0, y: 0}));
      pos[n.id] = {x: p.x, y: p.y};
    });
    laneInfo = [];
  }
  return pos;
}

/* ---------- отрисовка ---------- */
// Разметка холста, общая для карты зависимостей, схемы и доски. Вынесена из
// renderCanvas, потому что третий вид внутри неё вывел бы её за пределы читаемости:
// она и так прошита особыми случаями pg.canvas / pg.space.
//
// Слои внутри #scene идут сзади вперёд: секции доски → её объекты → связи →
// узлы графа → курсоры коллег. #marq, панели и миникарта лежат ВНЕ #scene:
// они не должны ездить и масштабироваться вместе с камерой.
function canvasShell(pg, cfg, opts) {
  const jam = !!(opts && opts.jam);
  const rail = jam ? '' : `<div id="toolrail" class="noview">
      <button data-tool="node" title="Новый узел · двойной клик по холсту">＋</button>
      <button data-tool="frame" title="Область: рамка вокруг группы узлов">▭</button>
      <button data-tool="note" title="Заметка">✎</button>
      <div class="rsep"></div>
      <button data-tool="fit" title="Показать всё целиком">⤢</button>
    </div>`;
  return `<div id="cvstack"${jam ? ' class="jam"' : ''}>
    ${cfg.intro && !cfg.introOff ? `<div id="cvintro">${cfg.intro}<span class="x" id="introX" title="скрыть">×</span></div>` : ''}
    <div id="cvhost"><div id="cv"${jam ? ` class="bg-${esc(cfg.bg || 'dots')}"` : ''}>
    <div id="scene">
      ${jam ? '<div id="lySect"></div>' : ''}
      <div id="lyFrames"></div>
      ${jam ? '<div id="lyItems"></div><svg id="lyDraw"></svg>' : ''}
      <svg id="edges"></svg>
      <div id="lyNodes"></div>
      <div id="lyNotes"></div>
      <div id="lyCursors"></div>
    </div>
    <div id="marq"></div>
    ${rail}
    ${jam ? `<div id="jambar" class="noview">
      <button data-t="sel" title="Выбрать · V">&#9655;</button>
      <button data-t="hand" title="Рука · H · или пробел">&#9995;</button>
      <span class="jsep"></span>
      <button data-t="sticky" title="Стикер · N">&#128441;</button>
      <button data-t="text" title="Текст · T">T</button>
      <button data-t="shape" title="Фигура · R">&#9645;</button>
      <button data-t="conn" title="Коннектор · X">&#8599;</button>
      <button data-t="pen" title="Перо · P">&#9998;</button>
      <button data-t="eraser" title="Ластик · E">&#9723;</button>
      <button data-t="section" title="Секция · F">&#11036;</button>
      <span class="jsep"></span>
      <button data-t="fit" title="Показать всё">&#10530;</button>
    </div>
    <div id="jprops" class="noview"></div>` : ''}
    <div id="zoombar">
      <button class="btn ico sm" id="zOut">−</button><span id="zval" class="hint" style="width:38px;text-align:center">100%</span>
      <button class="btn ico sm" id="zIn">＋</button><span class="sep"></span>
      <button class="btn sm" id="zFit">По размеру</button>
      <button class="btn sm" id="z100">1:1</button>
    </div>
    <canvas id="mini" width="264" height="176"></canvas>
  </div></div></div>`;
}
// Пояснение над холстом и первичный подгон камеры — тоже общие.
function wireCanvasShell(pg, cfg) {
  const ix = $('introX');
  if (ix) ix.onclick = e => {e.stopPropagation(); cfg.introOff = 1; save(); renderPage();};
  // На узком экране пояснение показывается началом: касание разворачивает его
  // целиком. Прятать текст без возможности прочитать — не решение.
  const intro = $('cvintro');
  if (intro) intro.onclick = () => intro.classList.toggle('open');
  if (!UI.view[pg.id] || !UI.view[pg.id]._done) {
    view()._done = 1; fitAll();
    // повторный fit на следующем кадре — на случай, если контейнер ещё не получил размеры (первый рендер/viewer)
    const refit = () => {
      const c = $('cv');
      if (c && c.getBoundingClientRect().width > 50 && c.getBoundingClientRect().height > 50
          && curPage() && curPage().id === pg.id) fitAll();
    };
    requestAnimationFrame(refit);
    // Ещё раз чуть позже: пояснение над холстом и панели меняют его высоту уже
    // после первого кадра, и карта оставалась прижатой к низу с пустотой сверху.
    setTimeout(refit, 120);
  }
}
function renderCanvas(pg) {
  // умолчания проставляет normalize() при загрузке — отрисовка проект не трогает
  const space = pg.kind === 'space';
  if (!space && !pg.canvas) pg.canvas = {layout: 'auto', lanes: []};
  if (space && !pg.space) pg.space = {};
  const cfg = space ? pg.space : pg.canvas;   // общая часть: пояснение над холстом
  const nodes = pageNodes(pg);
  cvNodes = nodes;
  $('view').innerHTML = canvasShell(pg, cfg, {jam: false});
  cvPos = layoutPage(pg, nodes);
  paintFrames(); paintNodes(); paintEdges(); paintNotes();
  applyView();
  wireCanvas();
  paintEmptyHint(pg, nodes);
  wireCanvasShell(pg, cfg);
}
// Свободная доска. Отдельный рендерер, а не ветка в renderCanvas: набор слоёв,
// набор объектов и панель инструментов у неё свои.
//
// paintFrames() и paintNotes() здесь НЕ зовутся сознательно: P.frames и P.notes
// лежат в корне документа и не привязаны к странице — на доску вывалились бы все
// области и заметки проекта разом.
function renderJam(pg) {
  pg.jam = pg.jam || {items: [], bg: 'dots'};
  const cfg = pg.jam;
  const nodes = pageNodes(pg);
  cvNodes = nodes;
  $('view').innerHTML = canvasShell(pg, cfg, {jam: true});
  cvPos = layoutPage(pg, nodes);
  paintItems(); paintNodes(); paintEdges();
  applyView();
  wireCanvas();
  wireJam();
  paintEmptyHint(pg, nodes);
  wireCanvasShell(pg, cfg);
}
/* ---------- инструменты доски ---------- */
// Инструмент одноразовый: поставил объект — вернулся к стрелке. Так работают
// и FigJam, и Miro, и без этого доска ощущается векторным редактором, а не доской.
// Закрепить инструмент, чтобы ставить подряд, — двойной клик по кнопке.
function setTool(t) {
  if (ro() && t !== 'sel' && t !== 'hand') { toast('Только просмотр'); return; }
  JAM.tool = t;
  qsa('#jambar button').forEach(b => b.classList.toggle('on', b.dataset.t === t));
  const cv = $('cv');
  if (cv) {
    cv.classList.toggle('jdraw', t === 'pen' || t === 'eraser');
    cv.classList.toggle('jplace', ['sticky', 'text', 'shape', 'section', 'conn'].includes(t));
    cv.classList.toggle('pan', t === 'hand');
  }
  const sh = $('jshapes'); if (sh) sh.classList.toggle('open', t === 'shape');
}
function wireJam() {
  qsa('#jambar button').forEach(b => {
    b.onclick = () => {
      const t = b.dataset.t;
      if (t === 'fit') { fitAll(); return; }
      // Повторный клик по уже выбранной фигуре перебирает набор форм —
      // отдельное подменю ради семи вариантов не окупается.
      if (t === 'shape' && JAM.tool === 'shape') {
        const forms = ['roundrect', 'rect', 'ellipse', 'diamond', 'triangle', 'star', 'arrow'];
        JAM.shape = forms[(forms.indexOf(JAM.shape) + 1) % forms.length];
        toast('Фигура: ' + JAM.shape);
      }
      JAM.sticky = false;
      setTool(t);
    };
    b.ondblclick = () => {
      if (['sel', 'hand', 'fit'].includes(b.dataset.t)) return;
      JAM.sticky = true; setTool(b.dataset.t);
      toast('Инструмент закреплён — Esc, чтобы отпустить');
    };
  });
  setTool(JAM.tool);
}
// Любая правка доски идёт через это: снимок для отмены ДО изменения, затем
// сохранение и перерисовка. Порядок тот же, что у edit() для узлов.
function jamEdit(fn) {
  if (ro()) { toast('Только просмотр'); return; }
  snapNow(); fn(); save();
  paintItems(); paintEdges(); applyHi(); drawMini();
}
// Порядок наложения — это порядок в массиве items, отдельного поля z нет:
// нечем разъехаться, нечего перенормировывать, отмена бесплатна.
function jamRaise(where) {
  const pg = curPage(); if (!isJam(pg) || !UI.selItems.size) return;
  jamEdit(() => {
    const keep = jamItems(pg).filter(it => UI.selItems.has(it.id));
    const rest = jamItems(pg).filter(it => !UI.selItems.has(it.id));
    if (where === 'front') pg.jam.items = rest.concat(keep);
    else pg.jam.items = keep.concat(rest);
  });
}
/* ---------- плавающая панель свойств ---------- */
// Панель едет за выделением, а не живёт в #insp. Инспектор — оверлей во всю высоту,
// он съедает камеру, и открывать его на каждый клик по стикеру означало бы вернуть
// поведение, от которого в проекте уже отказались (см. onDown).
function paintProps() {
  const el = $('jprops'); if (!el) return;
  const pg = curPage(), list = selItemsArr();
  if (!isJam(pg) || !list.length || ro()) { el.classList.remove('open'); el.innerHTML = ''; return; }
  const kinds = new Set(list.map(i => i.kind));
  const colored = list.some(i => ['sticky', 'shape', 'section', 'text'].includes(i.kind));
  const stroked = list.some(i => ['draw', 'conn', 'shape'].includes(i.kind));
  let h = '';
  if (colored) {
    h += '<div class="jrow">' + JAM_FILLS.map(c =>
      `<button class="jsw" data-fill="${c}" style="background:${c}" title="${c}"></button>`).join('') + '</div>';
  }
  if (stroked) {
    h += '<div class="jrow">' + [2, 4, 8].map(w =>
      `<button class="jw" data-sw="${w}" title="толщина ${w}"><i style="height:${w}px"></i></button>`).join('') + '</div>';
  }
  h += `<div class="jrow">
    <button class="jb" data-act="front" title="На передний план · Ctrl+]">&#9633;&#8593;</button>
    <button class="jb" data-act="back" title="На задний план · Ctrl+[">&#9633;&#8595;</button>
    <button class="jb" data-act="dup" title="Дублировать · Ctrl+D">&#10697;</button>
    <button class="jb" data-act="del" title="Удалить · Delete">&#10005;</button>
  </div>`;
  el.innerHTML = h;
  el.classList.add('open');
  // Позиция — над рамкой выделения, в экранных координатах холста.
  const b = itemsBBox(list), v = view();
  el.style.left = Math.round(b.x * v.k + v.x + (b.w * v.k) / 2) + 'px';
  el.style.top = Math.round(b.y * v.k + v.y - 12) + 'px';
  qsa('#jprops [data-fill]').forEach(bt => bt.onclick = () => jamEdit(() => {
    JAM.fill = bt.dataset.fill;
    for (const it of selItemsArr()) if (it.kind !== 'draw' && it.kind !== 'conn') it.fill = bt.dataset.fill;
  }));
  qsa('#jprops [data-sw]').forEach(bt => bt.onclick = () => jamEdit(() => {
    JAM.sw = +bt.dataset.sw;
    for (const it of selItemsArr()) it.sw = +bt.dataset.sw;
  }));
  qsa('#jprops [data-act]').forEach(bt => bt.onclick = () => {
    const a = bt.dataset.act;
    if (a === 'front' || a === 'back') return jamRaise(a);
    if (a === 'dup') return jamDuplicate();
    if (a === 'del') return jamDelete();
  });
}
function itemsBBox(list) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const it of list) {
    const b = it.kind === 'draw' ? drawBox(it) : (it.kind === 'conn' ? connBox(it) : itemBox(it));
    if (!b) continue;
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
  }
  if (!isFinite(x0)) return {x: 0, y: 0, w: 0, h: 0};
  return {x: x0, y: y0, w: x1 - x0, h: y1 - y0};
}
function jamDelete() {
  const pg = curPage(); if (!isJam(pg) || !UI.selItems.size) return;
  const n = UI.selItems.size;
  jamEdit(() => {
    // Коннектор без конца не имеет смысла: удаляем вместе с объектом, к которому он шёл.
    pg.jam.items = jamItems(pg).filter(it => !UI.selItems.has(it.id));
    pg.jam.items = pg.jam.items.filter(it => it.kind !== 'conn'
      || (!UI.selItems.has((it.a || {}).item) && !UI.selItems.has((it.b || {}).item)));
    UI.selItems.clear();
  });
  toast(`Удалено: ${nOf(n, OBJS)}`);
}
function jamDuplicate() {
  const pg = curPage(); if (!isJam(pg) || !UI.selItems.size) return;
  const made = [];
  jamEdit(() => {
    const map = {};
    for (const it of selItemsArr()) {
      if (it.kind === 'conn') continue;
      const c = clone(it); c.id = uid('i'); c.x = (+it.x || 0) + 24; c.y = (+it.y || 0) + 24;
      map[it.id] = c.id; pg.jam.items.push(c); made.push(c.id);
    }
    UI.selItems = new Set(made);
  });
}
// Объекты доски. Порядок в массиве = порядок наложения, поэтому рисуем как лежит.
function paintItems() {
  const pg = curPage(); if (!isJam(pg)) return;
  const items = jamItems(pg);
  const sect = [], body = [], draw = [];
  for (const it of items) {
    if (it.kind === 'section') sect.push(sectionHTML(it));
    else if (it.kind === 'draw') draw.push(drawHTML(it));
    else if (it.kind === 'conn') continue;      // коннекторы рисует paintEdges
    else body.push(itemHTML(it));
  }
  const ls = $('lySect'), li = $('lyItems'), ld = $('lyDraw');
  if (ls) ls.innerHTML = sect.join('');
  if (li) li.innerHTML = body.join('');
  if (ld) ld.innerHTML = draw.join('');
}
const jamItems = pg => (pg && pg.jam && Array.isArray(pg.jam.items)) ? pg.jam.items : [];
const jamItemById = (pg, id) => jamItems(pg).find(x => x.id === id) || null;
// Прямоугольник объекта в мировых координатах — нужен и рамке выделения,
// и миникарте, и «показать всё», и коннекторам.
function itemBox(it) {
  return {x: +it.x || 0, y: +it.y || 0, w: Math.max(1, +it.w || 0), h: Math.max(1, +it.h || 0)};
}
function itemHTML(it) {
  const b = itemBox(it);
  const cls = it.kind === 'sticky' ? 'jsticky' : it.kind === 'text' ? 'jtext' : 'jshape';
  const shape = it.kind === 'shape' ? ' shp-' + (it.shape || 'roundrect') : '';
  const st = [`left:${b.x}px`, `top:${b.y}px`, `width:${b.w}px`, `height:${b.h}px`];
  if (it.fill) st.push('background:' + it.fill);
  if (it.stroke) st.push('border-color:' + it.stroke);
  if (it.rot) st.push(`transform:rotate(${it.rot}deg)`);
  if (it.size) st.push('font-size:' + it.size + 'px');
  if (it.align) st.push('text-align:' + it.align);
  return `<div class="jitem ${cls}${shape}${it.lock ? ' lock' : ''}" data-i="${esc(it.id)}" style="${st.join(';')}">
    <div class="jtxt">${esc(it.text || '')}</div>${it.lock ? '' : '<div class="jrs" title="потянуть, чтобы изменить размер"></div>'}</div>`;
}
function sectionHTML(it) {
  const b = itemBox(it);
  const st = [`left:${b.x}px`, `top:${b.y}px`, `width:${b.w}px`, `height:${b.h}px`];
  if (it.fill) st.push('background:' + it.fill);
  return `<div class="jsect" data-i="${esc(it.id)}" style="${st.join(';')}">
    <div class="jsh">${esc(it.text || 'Секция')}</div><div class="jrs"></div></div>`;
}
// Штрих хранится строкой относительных целых точек — «0,0 8,3 15,9». Так он в разы
// компактнее массива объектов, а перемещение штриха это правка двух чисел (x, y),
// а не переписывание всего пути.
function drawPath(it) {
  const pts = String(it.d || '').trim().split(/\s+/);
  if (!pts.length || !pts[0]) return '';
  const x = +it.x || 0, y = +it.y || 0;
  let d = '';
  for (let i = 0; i < pts.length; i++) {
    const c = pts[i].split(',');
    if (c.length < 2) continue;
    d += (d ? 'L' : 'M') + (x + (+c[0] || 0)) + ',' + (y + (+c[1] || 0));
  }
  return d;
}
function drawHTML(it) {
  const d = drawPath(it); if (!d) return '';
  const w = Math.max(1, +it.sw || 3);
  // Невидимый дубль пути шириной не меньше 14 — чтобы в тонкий штрих можно было
  // попасть курсором. Тот же приём, что у #edges path.hit.
  return `<path class="jhit" data-i="${esc(it.id)}" d="${d}" stroke-width="${Math.max(14, w * 2)}"/>`
    + `<path class="jdraw" data-i="${esc(it.id)}" d="${d}" stroke="${esc(it.stroke || '#1b1f2a')}" stroke-width="${w}"/>`;
}
// Пустой холст раньше показывал только точки — что делать дальше, узнать было неоткуда.
// Три разных пустых состояния: страница совсем пустая, фильтр всё отсёк, схема без узлов.
// Пустое состояние для таблицы и канбана. Раньше таблица рисовала шапку и пустое
// тело, канбан — пустые колонки: человек не отличал «здесь ничего нет» от
// «я включил фильтр и всё скрыл».
// Кнопка «Сбросить фильтр» из пустого блока: обработчик фильтров живёт внутри
// своего меню, а блок рисуется в #view — связываем делегатом один раз.
document.addEventListener('click', e => {
  if (!e.target || e.target.id !== 'emptyClear' || !P) return;
  const pg = curPage(); if (!pg) return;
  pg.filter = {q: '', cats: [], statuses: [], types: [], f: {}, blockersOnly: 0};
  save(); renderPage();
  toast('Фильтр сброшен');
});
function emptyBlock(pg, total) {
  // activeFilterCount() считает только фасеты (категории, статусы, типы, свои поля):
  // он питает счётчик на кнопке «Фильтр», а строка поиска живёт отдельным полем.
  // Для пустого состояния важно и то, и другое.
  const hasFilter = activeFilterCount(pg.filter) > 0 || !!(pg.filter && (pg.filter.q || '').trim());
  return `<div class="emptybox">
    <div class="ttl">${hasFilter ? 'Под фильтр не попал ни один узел' : 'В проекте пока нет узлов'}</div>
    <div class="txt">${hasFilter
      ? `Всего в проекте ${nOf(total, NODES)}, но текущие условия не пропустили ни одного.`
      : 'Создайте узлы на странице-холсте — они появятся здесь автоматически.'}</div>
    ${hasFilter && !VIEWER ? '<button class="btn" id="emptyClear" style="margin-top:10px">Сбросить фильтр</button>' : ''}
  </div>`;
}
function paintEmptyHint(pg, nodes) {
  const host = $('cvhost'); if (!host) return;
  const old = $('cvempty'); if (old) old.remove();
  // На доске «пусто» — это когда нет НИ объектов, ни положенных узлов: она пустая
  // не по фильтру, а по содержимому.
  if (isJam(pg)) {
    if (nodes.length || jamItems(pg).length) return;
    const el2 = document.createElement('div');
    el2.id = 'cvempty';
    el2.innerHTML = `<div class="ttl">Доска пока пустая</div><div class="txt">${VIEWER
      ? 'Автор ещё ничего сюда не положил.'
      : 'Возьмите инструмент внизу и щёлкните по холсту.<br>' +
        '<b>N</b> — стикер, <b>T</b> — текст, <b>R</b> — фигура, <b>P</b> — перо.<br>' +
        'Колесо — панорама, <b>Ctrl</b> + колесо — масштаб.'}</div>`;
    host.appendChild(el2);
    el2.onmousedown = e => e.stopPropagation();
    return;
  }
  if (nodes.length) return;
  const total = P.nodes.length;
  const filtered = total > 0 && pg.kind !== 'space';
  let title, body;
  if (pg.kind === 'space') {
    title = 'Схема пока пустая';
    body = VIEWER ? 'Автор ещё ничего сюда не положил.'
      : 'Положите на неё узлы проекта кнопкой <b>↧ Положить узел</b> в панели сверху ' +
        'или создайте новый: <b>двойной клик</b> по пустому месту.';
  } else if (filtered) {
    title = 'Фильтр не пропустил ни одного узла';
    body = `В проекте ${total} узлов, но под текущий фильтр не подошёл ни один. Снимите условия в «Фильтр» сверху.`;
  } else {
    title = 'Здесь пока пусто';
    body = VIEWER ? 'В этом проекте ещё нет узлов.'
      : '<b>Двойной клик</b> по пустому месту — новый узел.<br>' +
        'Связь тянется от <b>кружка на краю</b> узла к другому узлу.<br>' +
        'Колесо — панорама, <b>Ctrl</b> + колесо — масштаб.';
  }
  const el = document.createElement('div');
  el.id = 'cvempty';
  el.innerHTML = `<div class="ttl">${esc(title)}</div><div class="txt">${body}</div>`;
  host.appendChild(el);
  el.onmousedown = e => e.stopPropagation();   // клики по подсказке не должны начинать рамку выделения
}
function nodeHTML(n) {
  const g = G(), w = g.W(n.id), blk = nBlockers(n), st = statusOf(n.status), ty = typeOf(n.type);
  const shape = ty.shape === 'pill' ? ' shp-pill' : ty.shape === 'diamond' ? ' shp-di' : '';
  const p = cvPos[n.id] || {x: 0, y: 0};
  const _sz = nsize(n, curPage().id), wd = _sz.w, ht = _sz.h;
  const badges = [];
  // curPage().canvas на странице-схеме отсутствует: без проверки здесь TypeError
  // и холст не рисуется вообще
  const _cvcfg = curPage().canvas;
  if (_cvcfg && _cvcfg.layout === 'auto' && isPinned(n, curPage().id)) badges.push('<span class="b pin" title="позиция закреплена вручную">📌</span>');
  if (blk) badges.push(`<span class="b blk" title="блокеров внутри">⚠${blk}</span>`);
  if (w >= 3) badges.push(`<span class="b wt" title="разблокирует узлов">${w}</span>`);
  const subBits = [];
  P.schema.fields.filter(f => f.card).forEach(f => {const v = (n.f || {})[f.key]; if (v) subBits.push(`<b class="fbadge">${esc(Array.isArray(v) ? v[0] : v)}</b>`);});
  return `<div class="nd${shape}" data-n="${esc(n.id)}" style="left:${p.x}px;top:${p.y}px;width:${wd}px;height:${ht}px">
    <div class="bar" style="background:${catOf(n.cat).color}"></div>
    <div class="bdg">${badges.join('')}</div>
    <div class="nt"><span class="dot" style="background:${st.color}"></span>${esc(n.name)}</div>
    <div class="ns">${subBits.join(' ')} ${esc(n.sub || '')}</div>
    <div class="port l" data-port="l"></div><div class="port r" data-port="r"></div>
    <div class="port t" data-port="t"></div><div class="port b" data-port="b"></div>
    ${(curPage().kind === 'space' || curPage().kind === 'jam') && !ro() ? '<div class="rs" title="потянуть, чтобы изменить размер"></div>' : ''}
  </div>`;
}
function paintNodes() {
  $('lyNodes').innerHTML = cvNodes.map(nodeHTML).join('');
  paintLanes(); applyHi();
}
function paintLanes() {
  const pg = curPage();
  qsa('.lanebg,.lanecap').forEach(e => e.remove());
  // колонки — принадлежность холста-зависимостей; на схеме pg.canvas вообще нет
  if (!pg.canvas || pg.canvas.layout !== 'auto' || !laneInfo.length) return;
  const H = Math.max(...Object.values(cvPos).map(p => p.y), 200) + 200;
  const fr = document.createDocumentFragment();
  laneInfo.forEach((l, i) => {
    if (i > 0) {
      const d = document.createElement('div'); d.className = 'lanebg';
      d.style.cssText = `left:${l.x - COLGAP / 2}px;top:0;height:${H}px`; fr.appendChild(d);
    }
    const c = document.createElement('div'); c.className = 'lanecap';
    c.style.cssText = `left:${l.x}px;top:26px`;
    c.textContent = ((pg.canvas || {}).lanes || [])[l.idx] || (l.idx === 0 ? 'блокировки' : 'этап ' + l.idx);
    fr.appendChild(c);
  });
  $('lyNodes').appendChild(fr);
}
// Стрелка на ХОЛСТЕ-ЗАВИСИМОСТЯХ: всегда правый край источника → левый край цели.
// Это не небрежность, а смысл: колонка = глубина зависимости, и поток слева направо
// читается как «сначала это, потом то». Менять здесь нечего.
function edgePath(a, b, aw, ah, bw, bh) {
  const x1 = a.x + aw, y1 = a.y + ah / 2, x2 = b.x, y2 = b.y + bh / 2;
  if (x2 > x1 + 10) {const m = (x1 + x2) / 2; return `M${x1},${y1} C${m},${y1} ${m},${y2} ${x2},${y2}`;}
  const off = Math.max(70, Math.abs(y2 - y1) / 2 + 50);
  return `M${x1},${y1} C${x1 + off},${y1 + off} ${x2 - off},${y2 + off} ${x2},${y2}`;
}
// Стрелка на СВОБОДНОЙ СХЕМЕ: сторона выбирается по взаимному расположению узлов.
// Здесь порядок «слева направо» ничего не значит, а жёсткое правило правый→левый
// заставляло дальние связи заворачивать петлёй вокруг узла.
function edgePathAuto(a, b, aw, ah, bw, bh) {
  const acx = a.x + aw / 2, acy = a.y + ah / 2;
  const bcx = b.x + bw / 2, bcy = b.y + bh / 2;
  const dx = bcx - acx, dy = bcy - acy;
  let p1, p2, c1, c2;
  const pull = Math.max(40, Math.min(160, (Math.abs(dx) + Math.abs(dy)) / 2.5));
  if (Math.abs(dx) >= Math.abs(dy)) {                      // расходятся по горизонтали
    const right = dx > 0;
    p1 = {x: right ? a.x + aw : a.x, y: acy};
    p2 = {x: right ? b.x : b.x + bw, y: bcy};
    c1 = {x: p1.x + (right ? pull : -pull), y: p1.y};
    c2 = {x: p2.x + (right ? -pull : pull), y: p2.y};
  } else {                                                 // по вертикали
    const down = dy > 0;
    p1 = {x: acx, y: down ? a.y + ah : a.y};
    p2 = {x: bcx, y: down ? b.y : b.y + bh};
    c1 = {x: p1.x, y: p1.y + (down ? pull : -pull)};
    c2 = {x: p2.x, y: p2.y + (down ? -pull : pull)};
  }
  return `M${p1.x},${p1.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${p2.x},${p2.y}`;
}
// какую геометрию использовать для страницы
const edgeFor = pg => (pg && (pg.kind === 'space' || pg.kind === 'jam')) ? edgePathAuto : edgePath;
function paintEdges() {
  const svg = $('edges'); if (!svg) return;
  const pid = UI.page;                       // размеры узлов хранятся по страницам
  const ep = edgeFor(curPage());
  const vis = new Set(cvNodes.map(n => n.id));
  const mk = {}; P.schema.linkTypes.forEach(t => mk[t.key] = 'mk' + t.key.replace(/\W/g, ''));
  let defs = P.schema.linkTypes.map(t =>
    `<marker id="${mk[t.key]}" markerWidth="7" markerHeight="7" refX="6.5" refY="2.5" orient="auto"><path d="M0,0 L6.5,2.5 L0,5 z" fill="${t.color}"/></marker>`).join('');
  let h = `<defs>${defs}</defs>`;
  P.links.forEach(l => {
    if (!vis.has(l.from) || !vis.has(l.to)) return;
    const a = cvPos[l.from], b = cvPos[l.to]; if (!a || !b) return;
    const na = nodeById(l.from), nb = nodeById(l.to);
    const t = ltOf(l.type);
    const sa = nsize(na, pid), sb = nsize(nb, pid);
    const d = ep(a, b, sa.w, sa.h, sb.w, sb.h);
    const dash = t.style === 'dashed' ? 'stroke-dasharray="6,5"' : t.style === 'dotted' ? 'stroke-dasharray="2,4"' : '';
    h += `<path class="hit" data-l="${l.id}" d="${d}"/>`;
    h += `<path class="edge" data-l="${l.id}" data-a="${l.from}" data-b="${l.to}" d="${d}" fill="none" stroke="${t.color}" stroke-width="1.6" ${dash} marker-end="url(#${mk[l.type] || mk[P.schema.linkTypes[0].key]})"/>`;
    if (l.label) {
      const m = midOf(d);
      h += `<text x="${m.x}" y="${m.y - 5}" text-anchor="middle" font-size="10" fill="${t.color}" style="font-weight:600">${esc(l.label)}</text>`;
    }
  });
  // Коннекторы доски рисуются в ЭТОТ ЖЕ svg, вторым проходом. Отдельный слой
  // означал бы второй набор маркеров-стрелок и разъехавшийся порядок наложения.
  // Отличаются они атрибутом: у связи графа data-l, у коннектора доски data-c.
  const pgJ = curPage();
  if (isJam(pgJ)) {
    const caps = new Set();
    let cp = '';
    for (const it of jamItems(pgJ)) {
      if (it.kind !== 'conn') continue;
      const d = connPath(pgJ, it); if (!d) continue;
      const col = it.stroke || '#5a6172', w = Math.max(1, +it.sw || 2);
      const capB = it.capB === undefined ? 'arrow' : it.capB;
      const mk2 = (cap, at) => {
        if (!cap || cap === 'none') return '';
        const key = 'c' + cap + col.replace(/\W/g, '') + at;
        caps.add(key + '\u0000' + cap + '\u0000' + col + '\u0000' + at);
        return ` marker-${at}="url(#${key})"`;
      };
      const dash = it.dash ? ` stroke-dasharray="${esc(it.dash)}"` : '';
      cp += `<path class="hit" data-c="${esc(it.id)}" d="${d}"/>`;
      cp += `<path class="conn" data-c="${esc(it.id)}" d="${d}" fill="none" stroke="${esc(col)}" stroke-width="${w}"${dash}`
        + mk2(it.capA, 'start') + mk2(capB, 'end') + '/>';
      if (it.text) {
        const m = (it.style === 'curve' || !it.style) ? midOf(d) : midOfLine(d);
        cp += `<text x="${m.x}" y="${m.y - 5}" text-anchor="middle" font-size="10" fill="${esc(col)}" style="font-weight:600">${esc(it.text)}</text>`;
      }
    }
    // Маркеры заводятся ПО КЛЮЧУ, а не по коннектору: иначе на сотне стрелок
    // одного цвета получилась бы сотня одинаковых <marker>.
    let extra = '';
    for (const key of caps) {
      const [id, cap, col, at] = key.split('\u0000');
      const flip = at === 'start' ? ' transform="rotate(180 3.25 2.5)"' : '';
      const body = cap === 'dot'
        ? `<circle cx="2.5" cy="2.5" r="2.5" fill="${col}"/>`
        : `<path d="M0,0 L6.5,2.5 L0,5 z" fill="${col}"${flip}/>`;
      extra += `<marker id="${id}" markerWidth="7" markerHeight="7" refX="${at === 'start' ? 0.5 : 6.5}" refY="2.5" orient="auto">${body}</marker>`;
    }
    if (extra) h = h.replace('</defs>', extra + '</defs>');
    h += cp;
  }
  h += '<path id="tmpLink" fill="none" stroke="#3355d1" stroke-width="2" stroke-dasharray="5,4" style="display:none"/>';
  svg.innerHTML = h;
}
// Для прямой и ортогональной линии середину считаем арифметически: midOf() создаёт
// <path> вне DOM на КАЖДУЮ подпись при каждой отрисовке, и на десятке подписанных
// коннекторов это заметно.
function midOfLine(d) {
  const nums = d.match(/-?\d+(\.\d+)?/g) || [];
  if (nums.length < 4) return {x: 0, y: 0};
  const x1 = +nums[0], y1 = +nums[1], x2 = +nums[nums.length - 2], y2 = +nums[nums.length - 1];
  return {x: (x1 + x2) / 2, y: (y1 + y2) / 2};
}
function midOf(d) {
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', d);
  try {const l = p.getTotalLength(); return p.getPointAtLength(l / 2);} catch (e) {return {x: 0, y: 0};}
}
function paintFrames() {
  $('lyFrames').innerHTML = (P.frames || []).map(f => `<div class="fr${f.kind === 'lane' ? ' lane' : ''}" data-f="${f.id}"
    style="left:${f.x}px;top:${f.y}px;width:${f.w}px;height:${f.h}px;${f.color ? 'border-color:' + f.color : ''}">
    <div class="fh" style="${f.color ? 'color:' + f.color : ''}">${esc(f.name)}</div><div class="rs"></div></div>`).join('');
}
function paintNotes() {
  $('lyNotes').innerHTML = (P.notes || []).map(n => `<div class="stk" data-t="${n.id}"
    style="left:${n.x}px;top:${n.y}px;width:${n.w || 190}px;height:${n.h || 90}px;${n.color ? 'background:' + n.color : ''}">
    <div class="txt">${esc(n.text)}</div><div class="rs"></div></div>`).join('');
}
function applyHi() {
  const pgJ = curPage();
  // Объекты доски подсвечиваются всегда, независимо от графа.
  if (isJam(pgJ)) {
    qsa('.jitem').forEach(e => e.classList.toggle('sel', UI.selItems.has(e.dataset.i)));
    qsa('.jsect').forEach(e => e.classList.toggle('sel', UI.selItems.has(e.dataset.i)));
    qsa('#lyDraw path.jdraw').forEach(e => e.classList.toggle('sel', UI.selItems.has(e.dataset.i)));
    qsa('#edges .conn').forEach(e => e.classList.toggle('sel', UI.selItems.has(e.dataset.c)));
    paintProps();
    // Гонять G() — построение всего графа проекта — на каждое движение мыши над
    // стикером незачем: узлов графа на доске может не быть вовсе.
    if (!UI.sel.size && !UI.hover) return;
  }
  const focus = UI.hover || (UI.sel.size === 1 ? [...UI.sel][0] : null);
  const g = G();
  // Режимы «критический путь» и «доступное сейчас» — акцент, а не фильтр:
  // остальные узлы остаются на месте, но гаснут.
  const pg = curPage(), cv = (pg && pg.canvas) || {};
  const accent = pg && pg.kind === 'canvas' && (cv.crit || cv.ready)
    ? (cv.crit ? id => g.crit.has(id) : id => (g.par[id] || []).length === 0)
    : null;
  qsa('.stk').forEach(e => e.classList.toggle('sel', UI.selNotes.has(e.dataset.t)));
  qsa('.fr').forEach(e => e.classList.toggle('sel', UI.selFrames.has(e.dataset.f)));
  qsa('.nd').forEach(e => {
    e.classList.remove('dim', 'anc', 'dsc');
    e.classList.toggle('sel', UI.sel.has(e.dataset.n));
  });
  qsa('#edges .edge').forEach(e => {e.style.opacity = 1; e.style.strokeWidth = 1.6;});
  if (accent) {
    qsa('.nd').forEach(e => e.classList.toggle('acc', accent(e.dataset.n)));
    qsa('.nd').forEach(e => {if (!accent(e.dataset.n)) e.classList.add('dim');});
    qsa('#edges .edge').forEach(e => {
      const on = accent(e.dataset.a) && accent(e.dataset.b);
      e.style.opacity = on ? 1 : .1; e.style.strokeWidth = on ? 2.6 : 1.4;
    });
  } else qsa('.nd').forEach(e => e.classList.remove('acc'));
  if (!focus || !nodeById(focus)) return;
  const a = g.ANC[focus] || new Set(), d = g.DESC[focus] || new Set();
  qsa('.nd').forEach(e => {
    const i = e.dataset.n;
    if (i === focus) return;
    if (a.has(i)) e.classList.add('anc'); else if (d.has(i)) e.classList.add('dsc'); else e.classList.add('dim');
  });
  qsa('#edges .edge').forEach(e => {
    const A = e.dataset.a, B = e.dataset.b;
    const on = A === focus || B === focus || (a.has(A) && (a.has(B) || B === focus)) || (d.has(B) && (d.has(A) || A === focus));
    e.style.opacity = on ? 1 : .12; e.style.strokeWidth = on ? 2.6 : 1.4;
  });
}
function updatePositions(ids) {
  ids.forEach(id => {
    const el = qs(`.nd[data-n="${CSS.escape(id)}"]`); const p = cvPos[id];
    if (el && p) {el.style.left = p.x + 'px'; el.style.top = p.y + 'px';}
  });
  paintEdges();
}

/* ---------- миникарта ---------- */
// Всё, что занимает место на текущей странице: узлы графа, области — и объекты
// доски. Без этой ветки fitAll() на доске без узлов каждый раз сбрасывал бы камеру
// в {40,40,1}, а миникарта оставалась бы пустой: обе строили список только по cvNodes.
function sceneBoxes(pg) {
  const out = cvNodes.map(n => ({...cvPos[n.id], ...nsize(n, UI.page), c: catOf(n.cat).color}));
  if (isJam(pg)) {
    for (const it of jamItems(pg)) {
      if (it.kind === 'conn') continue;                  // у стрелки нет своих габаритов
      if (it.kind === 'draw') { const b = drawBox(it); if (b) out.push({...b, c: it.stroke || '#1b1f2a'}); continue; }
      out.push({...itemBox(it), c: it.kind === 'section' ? null : (it.fill || '#ffd93b')});
    }
  } else {
    (P.frames || []).forEach(f => out.push({x: f.x, y: f.y, w: f.w, h: f.h, c: null}));
  }
  return out.filter(i => isFinite(i.x) && isFinite(i.y) && isFinite(i.w) && isFinite(i.h));
}
// Габариты штриха считаются по точкам: ширины и высоты у него в документе нет.
function drawBox(it) {
  const pts = String(it.d || '').trim().split(/\s+/);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p2 of pts) {
    const c = p2.split(','); if (c.length < 2) continue;
    const px = +c[0] || 0, py = +c[1] || 0;
    if (px < x0) x0 = px; if (py < y0) y0 = py;
    if (px > x1) x1 = px; if (py > y1) y1 = py;
  }
  if (!isFinite(x0)) return null;
  const pad = Math.max(1, +it.sw || 3);
  return {x: (+it.x || 0) + x0 - pad, y: (+it.y || 0) + y0 - pad,
          w: (x1 - x0) + pad * 2, h: (y1 - y0) + pad * 2};
}
function drawMini() {
  const c = $('mini'); if (!c) return;
  const ctx = c.getContext('2d'), W = c.width, H = c.height;
  ctx.clearRect(0, 0, W, H);
  const items = sceneBoxes(curPage());
  if (!items.length) return;
  const x0 = Math.min(...items.map(i => i.x)) - 60, y0 = Math.min(...items.map(i => i.y)) - 60;
  const x1 = Math.max(...items.map(i => i.x + i.w)) + 60, y1 = Math.max(...items.map(i => i.y + i.h)) + 60;
  const k = Math.min(W / (x1 - x0), H / (y1 - y0));
  c._m = {x0, y0, k};
  items.forEach(i => {
    if (!i.c) {ctx.strokeStyle = '#d7dbe6'; ctx.lineWidth = 1; ctx.strokeRect((i.x - x0) * k, (i.y - y0) * k, i.w * k, i.h * k); return;}
    ctx.fillStyle = i.c; ctx.globalAlpha = .75;
    ctx.fillRect((i.x - x0) * k, (i.y - y0) * k, Math.max(2, i.w * k), Math.max(2, i.h * k));
    ctx.globalAlpha = 1;
  });
  const v = view(), r = cvRect();
  ctx.strokeStyle = '#3355d1'; ctx.lineWidth = 2;
  ctx.strokeRect((-v.x / v.k - x0) * k, (-v.y / v.k - y0) * k, (r.width / v.k) * k, (r.height / v.k) * k);
}
function fitAll() {
  const items = sceneBoxes(curPage());
  if (!items.length) {const v = view(); v.x = 40; v.y = 40; v.k = 1; applyView(); return;}
  const r = visibleRect();
  const x0 = Math.min(...items.map(i => i.x)), y0 = Math.min(...items.map(i => i.y));
  const x1 = Math.max(...items.map(i => i.x + i.w)), y1 = Math.max(...items.map(i => i.y + i.h));
  const v = view();
  v.k = clamp(Math.min((r.width - 70) / (x1 - x0), (r.height - 70) / (y1 - y0)), .08, 1.6);
  v.x = (r.width - (x1 - x0) * v.k) / 2 - x0 * v.k;
  v.y = (r.height - (y1 - y0) * v.k) / 2 - y0 * v.k;
  applyView();
}
function flyTo(id) {
  const p = cvPos[id]; if (!p) return;
  const r = visibleRect(), v = view();
  v.k = Math.max(v.k, .75);
  v.x = r.width / 2 - (p.x + NW / 2) * v.k; v.y = r.height / 2 - (p.y + NH / 2) * v.k;
  applyView();
  const el = qs(`.nd[data-n="${CSS.escape(id)}"]`);
  if (el) {el.style.transition = 'box-shadow .3s'; el.classList.add('sel'); }
}

/* ---------- события холста ---------- */
function wireCanvas() {
  const cv = $('cv');
  $('zIn').onclick = () => {const r = cvRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1.25);};
  // Панель инструментов слева. Раньше область и заметку можно было создать только
  // из контекстного меню — то есть их не существовало для того, кто его не открывал.
  qsa('#toolrail button').forEach(b => b.onclick = () => {
    if (b.dataset.tool === 'fit') return fitAll();
    if (ro()) return toast('Только просмотр');
    if (b.dataset.tool === 'node') addNode();
    else if (b.dataset.tool === 'frame') addFrame('frame');
    else if (b.dataset.tool === 'note') addNote();
  });
  $('zOut').onclick = () => {const r = cvRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, .8);};
  $('zFit').onclick = fitAll;
  $('z100').onclick = () => {const v = view(); const r = cvRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1 / v.k);};
  cv.addEventListener('wheel', e => {
    e.preventDefault();
    const v = view();
    if (e.ctrlKey || e.metaKey) zoomAt(e.clientX, e.clientY, clamp(Math.exp(-e.deltaY * .01), .82, 1.22));
    else {v.x -= e.deltaX; v.y -= e.deltaY; applyView();}
  }, {passive: false});
  cv.addEventListener('contextmenu', e => {e.preventDefault(); ctxMenu(e);});

  /* ---------- указатель: мышь, палец, перо одним кодом ----------
     Раньше холст слушал только mouse*: с телефона и планшета он не работал вообще —
     ни подвинуть карту, ни открыть узел. Pointer-события дают то же самое для мыши
     и заодно приносят пальцы, а `touch-action:none` на #cv отбирает у браузера
     собственные жесты, иначе прокрутка страницы съедала бы панораму. */
  let longT = null, lastTap = 0, lastTapXY = null;
  const clearLong = () => { clearTimeout(longT); longT = null; };
  ptrs.clear(); pinch = null;      // новая отрисовка холста — новый жест

  cv.addEventListener('pointerdown', e => {
    if (e.pointerType === 'touch') {
      ptrs.set(e.pointerId, {x: e.clientX, y: e.clientY});
      if (ptrs.size === 2) {
        // Второй палец отменяет начатое перетаскивание: человек передумал двигать
        // узел и хочет масштаб. Оставить оба жеста разом — значит утащить узел
        // куда-то за экран, пока он сводит пальцы.
        // Перерисовывать страницу здесь НЕЛЬЗЯ: renderPage() заменяет #cv на новый
        // элемент, вместе с ним пропадают эти обработчики, и щипок умирает,
        // не начавшись.
        cancelDrag();
        clearLong();
        const [a, b] = [...ptrs.values()], v = view();
        pinch = {d: Math.hypot(a.x - b.x, a.y - b.y) || 1, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2,
          k: v.k, vx: v.x, vy: v.y};
        cv.classList.remove('panning', 'linking');
        return;
      }
      if (ptrs.size > 2) return;

      // Двойное касание = двойной клик: dblclick по тачу браузеры дают не всегда
      // и не сразу, а создание узла и переименование висят именно на нём.
      const now = Date.now();
      if (now - lastTap < 320 && lastTapXY &&
          Math.abs(e.clientX - lastTapXY.x) + Math.abs(e.clientY - lastTapXY.y) < 26) {
        lastTap = 0; onDoubleTap(e); return;
      }
      lastTap = now; lastTapXY = {x: e.clientX, y: e.clientY};

      // Долгое нажатие = правая кнопка. Без него на тач-устройстве контекстное
      // меню недостижимо, а в нём живут выравнивание, дублирование и удаление.
      const lx = e.clientX, ly = e.clientY, target = e.target;
      longT = setTimeout(() => {
        longT = null;
        if (drag && drag.moved) return;
        cancelDrag();
        ctxMenu({target, clientX: lx, clientY: ly, preventDefault() {}, stopPropagation() {}});
      }, 500);
    }
    onDown(e);
  });

  cv.addEventListener('pointermove', e => {
    if (e.pointerType === 'touch' && ptrs.has(e.pointerId)) {
      const p = ptrs.get(e.pointerId);
      if (Math.abs(p.x - e.clientX) + Math.abs(p.y - e.clientY) > 8) clearLong();
      ptrs.set(e.pointerId, {x: e.clientX, y: e.clientY});
    }
    if (pinch && ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      const d2 = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const r = cvRect(), v = view();
      // Мир под серединой между пальцами остаётся на месте: так масштаб «щипком»
      // ощущается как растягивание самой карты, а не как прыжок камеры.
      const k2 = clamp(pinch.k * (d2 / pinch.d), .08, 3);
      const wx = (pinch.cx - r.left - pinch.vx) / pinch.k, wy = (pinch.cy - r.top - pinch.vy) / pinch.k;
      v.k = k2; v.x = mx - r.left - wx * k2; v.y = my - r.top - wy * k2;
      applyView();
      return;
    }
    // Свой курсор коллегам. Шлём и во время перетаскивания: именно тогда чужое
    // движение и интересно — видно, что человек делает, а не что он замер.
    if (live.LIVE.on && e.pointerType !== 'touch') {
      const w = toWorld(e.clientX, e.clientY); live.sendCursor(w.x, w.y, UI.page);
    }
    if (drag) return;
    const nd = e.target.closest('.nd');
    const id = nd ? nd.dataset.n : null;
    if (id !== UI.hover) {UI.hover = id; applyHi();}
  });

  cvClearLong = clearLong;   // общий сброс долгого нажатия для оконных обработчиков

  cv.addEventListener('dblclick', e => { if (e.pointerType !== 'touch') onDoubleTap(e); });

  const mini = $('mini');
  mini.addEventListener('pointerdown', e => {
    const go = ev => {
      const m = mini._m; if (!m) return;
      const r = mini.getBoundingClientRect(), v = view(), cr = cvRect();
      const wx = (ev.clientX - r.left) / m.k + m.x0, wy = (ev.clientY - r.top) / m.k + m.y0;
      v.x = cr.width / 2 - wx * v.k; v.y = cr.height / 2 - wy * v.k; applyView();
    };
    go(e);
    const mv = ev => go(ev), up = () => {
      window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
    e.stopPropagation();
  });
}

// Двойной клик и двойное касание делают одно и то же — переименовать под курсором
// или создать узел на пустом месте.
function onDoubleTap(e) {
  if (VIEWER) return;
  // На доске двойной клик по пустому месту даёт СТИКЕР, а не узел графа: функция
  // про тип страницы раньше не знала вовсе и создавала узел где угодно.
  const pgD = curPage();
  if (isJam(pgD)) {
    const jt = e.target.closest('.jitem');
    if (jt) { jamInlineText(jt); return; }
    const sh = e.target.closest('.jsect .jsh');
    if (sh) {
      const it = jamItemById(pgD, sh.closest('[data-i]').dataset.i);
      if (it) promptBox('Секция', 'Название', it.text || '', v => jamEdit(() => { it.text = v; }));
      return;
    }
    if (ro()) return;
    const w2 = toWorld(e.clientX, e.clientY), def = jamDefaults('sticky');
    const it = Object.assign({id: uid('i'), kind: 'sticky', text: ''}, def,
      {x: Math.round(w2.x - def.w / 2), y: Math.round(w2.y - def.h / 2)});
    jamEdit(() => { pgD.jam.items.push(it); });
    setSelItems([it.id]);
    const el = qs(`.jitem[data-i="${CSS.escape(it.id)}"]`);
    if (el) jamInlineText(el);
    return;
  }
  const nd = e.target.closest('.nd');
  if (nd) {inlineRename(nd); return;}
  const stk = e.target.closest('.stk');
  if (stk) {inlineNote(stk); return;}
  if (e.target.closest('.fr')) return;
  const w = toWorld(e.clientX, e.clientY);
  addNode({x: Math.round(w.x - NW / 2), y: Math.round(w.y - NH / 2)});
}
// Бросить начатое перетаскивание, ничего не применяя и НЕ перерисовывая страницу.
// Перерисовка здесь заменила бы #cv новым элементом вместе со всеми обработчиками
// текущего жеста.
function cancelDrag() {
  if (!drag) return;
  const wasMove = drag.mode === 'move' && drag.moved && drag.orig;
  const ids = wasMove ? drag.nodeIds : null;
  if (wasMove) ids.forEach(i => {cvPos[i] = {x: drag.orig[i].x, y: drag.orig[i].y};});
  drag = null;
  const cv = $('cv'); if (cv) cv.classList.remove('panning', 'linking');
  const m = $('marq'); if (m) m.style.display = 'none';
  const tl = $('tmpLink'); if (tl) tl.style.display = 'none';
  qsa('.nd').forEach(el => el.classList.remove('drag', 'droptgt'));
  if (ids) {updatePositions(ids); paintEdges();}
}

/* ---------- жесты доски ---------- */
// Что под курсором: объект доски, узел графа — или ничего (тогда конец коннектора
// повиснет в точке, и это законно: в FigJam стрелку можно вывести в пустоту).
function jamEndAt(e, pg) {
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const jt = el && el.closest && el.closest('.jitem, .jsect');
  if (jt && jt.dataset.i) return {item: jt.dataset.i, side: 'c'};
  const nd = el && el.closest && el.closest('.nd');
  if (nd) return {node: nd.dataset.n, side: 'c'};
  return null;
}
function jamDefaults(kind) {
  if (kind === 'sticky') return {w: 180, h: 180, fill: JAM.fill, size: JAM.size};
  if (kind === 'text') return {w: 300, h: 56, size: 16};
  if (kind === 'section') return {w: 600, h: 400, fill: '#f2f4f9', text: 'Секция'};
  return {w: 220, h: 120, fill: '#c9e3ff', stroke: '#7fa8d8', shape: JAM.shape};
}
function jamToolDown(e, pg) {
  const w = toWorld(e.clientX, e.clientY), t = JAM.tool;
  if (t === 'eraser') {
    drag = {mode: 'jerase', hit: new Set()};
    jamEraseAt(e);
    e.preventDefault(); return;
  }
  if (t === 'pen') {
    // Точки копятся относительно начала штриха и целыми: так строка d выходит
    // в разы компактнее, а перемещение штриха — это правка двух чисел.
    drag = {mode: 'jdraw', x0: w.x, y0: w.y, pts: [[0, 0]], last: w};
    e.preventDefault(); return;
  }
  if (t === 'conn') {
    drag = {mode: 'jconn', from: jamEndAt(e, pg) || {x: Math.round(w.x), y: Math.round(w.y)}, w};
    const tl = $('tmpLink'); if (tl) tl.style.display = '';
    e.preventDefault(); return;
  }
  drag = {mode: 'jplace', kind: t, sx: e.clientX, sy: e.clientY, x0: w.x, y0: w.y, moved: false};
  e.preventDefault();
}
function jamEraseAt(e) {
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const t = el && el.closest && el.closest('#lyDraw path.jhit, .jitem, #edges .hit[data-c]');
  const id = t && (t.dataset.i || t.dataset.c);
  if (!id || (drag && drag.hit && drag.hit.has(id))) return;
  if (drag && drag.hit) drag.hit.add(id);
  // Ластик доски объектный: стирается штрих целиком, а не его кусок. Так же в FigJam.
  const pg = curPage();
  jamEdit(() => { pg.jam.items = jamItems(pg).filter(x => x.id !== id); });
}
// Упрощение полилинии (Рамер—Дуглас—Пейкер). Без него один штрих — это 300-400 точек,
// а документ уезжает на сервер и в стек отмены ЦЕЛИКОМ на каждую правку.
function rdp(pts, eps) {
  if (pts.length < 3) return pts;
  let idx = 0, max = 0;
  const [ax, ay] = pts[0], [bx, by] = pts[pts.length - 1];
  const dx = bx - ax, dy = by - ay, den = Math.hypot(dx, dy) || 1;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + bx * ay - by * ax) / den;
    if (d > max) { max = d; idx = i; }
  }
  if (max <= eps) return [pts[0], pts[pts.length - 1]];
  return rdp(pts.slice(0, idx + 1), eps).slice(0, -1).concat(rdp(pts.slice(idx), eps));
}
function selArr() { return [...UI.sel].map(nodeById).filter(Boolean); }
function setSel(ids, add) {
  if (!add) {UI.sel.clear(); UI.selNotes.clear(); UI.selFrames.clear(); UI.selItems.clear();}
  ids.forEach(i => UI.sel.add(i));
  UI.selLink = null;
  applyHi(); syncBulk();
}
// Выделение объектов доски. Симметрично setSel: без add снимает всё остальное,
// иначе стикер и узел графа оказались бы выделены одновременно и Delete унёс бы оба.
function setSelItems(ids, add) {
  if (!add) {UI.sel.clear(); UI.selNotes.clear(); UI.selFrames.clear(); UI.selItems.clear(); UI.selLink = null;}
  ids.forEach(i => UI.selItems.add(i));
  applyHi(); syncBulk();
}
// Объекты текущего выделения — в порядке документа, а не выделения: так операции
// над группой (порядок наложения, выравнивание) дают предсказуемый результат.
function selItemsArr() {
  const pg = curPage(); if (!isJam(pg)) return [];
  return jamItems(pg).filter(it => UI.selItems.has(it.id));
}
function startMove(e) {
  const movN = new Set(UI.sel);
  UI.selFrames.forEach(fid => {
    const f = (P.frames || []).find(x => x.id === fid); if (!f) return;
    cvNodes.forEach(n => {const p = cvPos[n.id]; if (!p) return;
      const sz = nsize(n, UI.page);
      if (p.x >= f.x - 4 && p.y >= f.y - 4 && p.x + sz.w <= f.x + f.w + 4 && p.y + sz.h <= f.y + f.h + 4) movN.add(n.id);});
  });
  const nodeIds = [...movN].filter(i => cvPos[i]);
  drag = {mode: 'move', sx: e.clientX, sy: e.clientY, moved: false,
    nodeIds, notes: [...UI.selNotes], frames: [...UI.selFrames],
    items: [...UI.selItems], orig: {}, noteOrig: {}, frameOrig: {}, itemOrig: {}};
  // Секция тащит вложенное: объекты, целиком лежащие внутри неё, едут вместе.
  const pgM = curPage();
  if (isJam(pgM)) {
    for (const id of [...UI.selItems]) {
      const sec = jamItemById(pgM, id);
      if (!sec || sec.kind !== 'section') continue;
      const b = itemBox(sec);
      for (const it of jamItems(pgM)) {
        if (it.id === id || it.kind === 'conn' || drag.items.includes(it.id)) continue;
        const q = it.kind === 'draw' ? drawBox(it) : itemBox(it);
        if (!q) continue;
        if (q.x >= b.x - 4 && q.y >= b.y - 4 && q.x + q.w <= b.x + b.w + 4 && q.y + q.h <= b.y + b.h + 4) drag.items.push(it.id);
      }
    }
    drag.items.forEach(id => {
      const it = jamItemById(pgM, id); if (it) drag.itemOrig[id] = {x: +it.x || 0, y: +it.y || 0};
    });
  }
  nodeIds.forEach(i => drag.orig[i] = {...cvPos[i]});
  drag.notes.forEach(id => {const t = (P.notes || []).find(x => x.id === id); if (t) drag.noteOrig[id] = {x: t.x, y: t.y};});
  drag.frames.forEach(id => {const f = (P.frames || []).find(x => x.id === id); if (f) drag.frameOrig[id] = {x: f.x, y: f.y};});
  qsa('.nd').forEach(el => {if (nodeIds.includes(el.dataset.n)) el.classList.add('drag');});
}
function onDown(e) {
  if (e.button === 2) return;
  const cv = $('cv');
  // ДОСКА: выбранный инструмент важнее попадания. Нажатие пером по стикеру должно
  // рисовать, а не тащить его, — поэтому ветка идёт до всех остальных проверок.
  const pgJ = curPage();
  if (isJam(pgJ) && !ro() && JAM.tool !== 'sel' && JAM.tool !== 'hand') {
    jamToolDown(e, pgJ); return;
  }
  const touch = e.pointerType === 'touch';
  // Одним пальцем по пустому месту холст ВОЗИТСЯ, а не выделяется рамкой:
  // иначе карту на телефоне нечем двигать, а рамка там почти не нужна.
  const emptyTouch = touch && !e.target.closest('.nd, .stk, .fr, .port, #edges .hit');
  const pan = e.button === 1 || UI.spaceDown || emptyTouch || (isJam(pgJ) && JAM.tool === 'hand');
  const port = e.target.closest('.port');
  const nd = e.target.closest('.nd');
  const frh = e.target.closest('.fr .fh'), frs = e.target.closest('.fr .rs');
  const stk = e.target.closest('.stk'), sts = e.target.closest('.stk .rs');
  const hit = e.target.closest('#edges .hit');
  if (pan) {
    drag = {mode: 'pan', sx: e.clientX, sy: e.clientY, vx: view().x, vy: view().y};
    cv.classList.add('panning'); e.preventDefault(); return;
  }
  // Ресайз объекта доски — ДО ветки самого объекта, иначе он просто начнёт двигаться.
  const jrs = e.target.closest('.jitem .jrs, .jsect .jrs');
  if (isJam(pgJ) && jrs && !ro()) {
    const host = jrs.closest('[data-i]'), it = jamItemById(pgJ, host.dataset.i);
    if (it) {
      drag = {mode: 'jitemRS', it, sx: e.clientX, sy: e.clientY, w: itemBox(it).w, h: itemBox(it).h};
      e.preventDefault(); return;
    }
  }
  // Коннектор доски и штрих: попадание ловят их невидимые дубли.
  const chit = e.target.closest('#edges .hit[data-c], #lyDraw path.jhit');
  if (isJam(pgJ) && chit) {
    setSelItems([chit.dataset.c || chit.dataset.i], e.shiftKey || e.metaKey || e.ctrlKey);
    e.preventDefault(); return;
  }
  const jit = e.target.closest('.jitem, .jsect .jsh');
  if (isJam(pgJ) && jit) {
    const host = jit.closest('[data-i]'), id = host.dataset.i;
    const it = jamItemById(pgJ, id);
    if (it && it.lock) { e.preventDefault(); return; }
    const addKey = e.shiftKey || e.metaKey || e.ctrlKey;
    if (addKey) {
      if (UI.selItems.has(id)) UI.selItems.delete(id); else UI.selItems.add(id);
      applyHi(); syncBulk();
    } else if (!UI.selItems.has(id)) setSelItems([id]);
    if (VIEWER) return;
    startMove(e); e.preventDefault(); return;
  }
  if (hit && !ro()) { selectLink(hit.dataset.l); e.preventDefault(); return; }
  if (port && !ro()) {
    const from = port.closest('.nd').dataset.n;
    drag = {mode: 'link', from, side: port.dataset.port};
    $('tmpLink').style.display = ''; cv.classList.add('linking');
    e.preventDefault(); return;
  }
  // Ресайз узла — только на схеме: на холсте-зависимостях раскладку считает граф
  // из констант NW/NH, и разные размеры узлов её сломали бы.
  // Проверка идёт ДО ветки .nd, иначе узел просто начнёт перетаскиваться.
  const nrs = e.target.closest('.nd .rs');
  if (nrs && !ro()) {
    const rn = nodeById(nrs.closest('.nd').dataset.n);
    if (rn) {
      const sz = nsize(rn, curPage().id);
      drag = {mode: 'nodeRS', n: rn, sx: e.clientX, sy: e.clientY, w: sz.w, h: sz.h};
      e.preventDefault(); return;
    }
  }
  if (nd) {
    const id = nd.dataset.n;
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      if (UI.sel.has(id)) UI.sel.delete(id); else UI.sel.add(id);
      applyHi(); syncBulk();
    } else if (!UI.sel.has(id)) setSel([id]);
    // На mousedown панель НЕ открываем: иначе она вылетала даже когда узел просто тащат.
    // Открывает клик — то есть mouseup без движения, см. ниже в обработчике mouseup.
    if (UI.insp || UI.inspKind) openNode(id);   // уже открыта — просто следует за выбором
    if (VIEWER) return;
    startMove(e); e.preventDefault(); return;
  }
  if (frs && !ro()) {
    const f = (P.frames || []).find(x => x.id === frs.closest('.fr').dataset.f);
    drag = {mode: 'frameRS', f, sx: e.clientX, sy: e.clientY, w: f.w, h: f.h}; e.preventDefault(); return;
  }
  if (frh && !ro()) {
    const f = (P.frames || []).find(x => x.id === frh.closest('.fr').dataset.f);
    const id = f.id, addKey = e.shiftKey || e.metaKey || e.ctrlKey;
    if (addKey) {
      if (UI.selFrames.has(id)) UI.selFrames.delete(id); else UI.selFrames.add(id);
      UI.selLink = UI.selFrames.size === 1 ? 'frame:' + [...UI.selFrames][0] : null;
      applyHi(); syncBulk();
    } else if (!UI.selFrames.has(id)) {
      UI.sel.clear(); UI.selNotes.clear(); UI.selFrames.clear(); UI.selFrames.add(id);
      UI.selLink = 'frame:' + id; applyHi(); syncBulk(); openFrame(f);
    }
    startMove(e); e.preventDefault(); return;
  }
  if (sts && !ro()) {
    const t = (P.notes || []).find(x => x.id === sts.closest('.stk').dataset.t);
    drag = {mode: 'noteRS', t, sx: e.clientX, sy: e.clientY, w: t.w || 190, h: t.h || 90}; e.preventDefault(); return;
  }
  if (stk && !ro()) {
    const id = stk.dataset.t, addKey = e.shiftKey || e.metaKey || e.ctrlKey;
    if (addKey) {
      if (UI.selNotes.has(id)) UI.selNotes.delete(id); else UI.selNotes.add(id);
      applyHi(); syncBulk();
    } else if (!UI.selNotes.has(id)) {
      UI.sel.clear(); UI.selNotes.clear(); UI.selFrames.clear(); UI.selNotes.add(id);
      UI.selLink = null; closeInsp(); applyHi(); syncBulk();
    }
    startMove(e); e.preventDefault(); return;
  }
  // пустое место — рамка выделения
  if (!e.shiftKey) { setSel([]); closeInsp(); }
  const w = toWorld(e.clientX, e.clientY);
  drag = {mode: 'marq', sx: e.clientX, sy: e.clientY, wx: w.x, wy: w.y, add: e.shiftKey};
  e.preventDefault();
}
window.addEventListener('pointermove', e => {
  if (!drag) return;
  const v = view();
  if (drag.mode === 'jdraw') {
    const w = toWorld(e.clientX, e.clientY);
    // Прореживание на лету: pointermove при медленном движении выдаёт десятки точек
    // на один пиксель. Порог в мировых единицах, чтобы он не зависел от зума.
    const min = 2 / v.k;
    if (Math.hypot(w.x - drag.last.x, w.y - drag.last.y) < min) return;
    drag.last = w;
    drag.pts.push([Math.round(w.x - drag.x0), Math.round(w.y - drag.y0)]);
    const ld = $('lyDraw');
    if (ld) {
      const d = drag.pts.map((q, i) => (i ? 'L' : 'M') + (drag.x0 + q[0]) + ',' + (drag.y0 + q[1])).join(' ');
      let tmp = qs('#jtmp', ld);
      if (!tmp) { ld.insertAdjacentHTML('beforeend',
        `<path id="jtmp" class="jdraw" fill="none" stroke="${esc(JAM.stroke)}" stroke-width="${JAM.sw}"/>`); tmp = qs('#jtmp', ld); }
      if (tmp) tmp.setAttribute('d', d);
    }
    return;
  }
  if (drag.mode === 'jerase') { jamEraseAt(e); return; }
  if (drag.mode === 'jplace') {
    // Клик ставит объект умолчательного размера, протяжка — по нарисованной рамке.
    const m = $('marq'), r = cvRect();
    if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 4) drag.moved = true;
    if (!drag.moved || !m) return;
    m.style.cssText += `display:block;left:${Math.min(drag.sx, e.clientX) - r.left}px;top:${Math.min(drag.sy, e.clientY) - r.top}px;`
      + `width:${Math.abs(e.clientX - drag.sx)}px;height:${Math.abs(e.clientY - drag.sy)}px`;
    return;
  }
  if (drag.mode === 'jconn') {
    const w = toWorld(e.clientX, e.clientY);
    const pg = curPage();
    const a = connAnchor(pg, drag.from) || {x: drag.from.x, y: drag.from.y, box: null};
    const p1 = a.box ? connSide(a.box, drag.from.side, w) : {x: a.x, y: a.y};
    const tl = $('tmpLink');
    if (tl) tl.setAttribute('d', `M${p1.x},${p1.y} L${w.x},${w.y}`);
    const over = jamEndAt(e, pg);
    qsa('.jitem, .nd').forEach(x => x.classList.toggle('droptgt',
      !!over && (x.dataset.i === over.item || x.dataset.n === over.node)));
    return;
  }
  if (drag.mode === 'jitemRS') {
    // По ходу жеста меняется ТОЛЬКО DOM: снимок для отмены снимается на отпускании,
    // иначе он уже содержал бы новый размер и Ctrl+Z ресайз не отменял бы.
    drag.cw = Math.max(40, Math.round((drag.w + (e.clientX - drag.sx) / v.k) / GRID) * GRID);
    drag.ch = Math.max(40, Math.round((drag.h + (e.clientY - drag.sy) / v.k) / GRID) * GRID);
    const el = qs(`[data-i="${CSS.escape(drag.it.id)}"]`);
    if (el) { el.style.width = drag.cw + 'px'; el.style.height = drag.ch + 'px'; }
    return;
  }
  if (drag.mode === 'pan') {
    v.x = drag.vx + (e.clientX - drag.sx); v.y = drag.vy + (e.clientY - drag.sy); applyView(); return;
  }
  if (drag.mode === 'move') {
    const dx = (e.clientX - drag.sx) / v.k, dy = (e.clientY - drag.sy) / v.k;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3 / v.k) return;
    drag.moved = true;
    const snap = z => Math.round(z / GRID) * GRID;
    (drag.items || []).forEach(id => {
      const o = drag.itemOrig[id]; if (!o) return;
      const el = qs(`[data-i="${CSS.escape(id)}"]`);
      if (el) { el.style.left = snap(o.x + dx) + 'px'; el.style.top = snap(o.y + dy) + 'px'; }
    });
    drag.nodeIds.forEach(i => {const o = drag.orig[i]; cvPos[i] = {x: snap(o.x + dx), y: snap(o.y + dy)};});
    updatePositions(drag.nodeIds);
    // заметки/области двигаем только визуально; в P пишем на mouseup, чтобы undo работал
    drag.notes.forEach(id => {const o = drag.noteOrig[id]; if (!o) return;
      const el = qs(`.stk[data-t="${CSS.escape(id)}"]`); if (el) {el.style.left = snap(o.x + dx) + 'px'; el.style.top = snap(o.y + dy) + 'px';}});
    drag.frames.forEach(id => {const o = drag.frameOrig[id]; if (!o) return;
      const el = qs(`.fr[data-f="${CSS.escape(id)}"]`); if (el) {el.style.left = snap(o.x + dx) + 'px'; el.style.top = snap(o.y + dy) + 'px';}});
    return;
  }
  if (drag.mode === 'link') {
    const a = cvPos[drag.from], n = nodeById(drag.from);
    const w = toWorld(e.clientX, e.clientY);
    const sz = nsize(n, UI.page);
    const x1 = a.x + sz.w, y1 = a.y + sz.h / 2;
    $('tmpLink').setAttribute('d', `M${x1},${y1} L${w.x},${w.y}`);
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const tgt = el && el.closest && el.closest('.nd');
    qsa('.nd').forEach(x => x.classList.toggle('droptgt', !!tgt && x === tgt && x.dataset.n !== drag.from));
    return;
  }
  if (drag.mode === 'marq') {
    const m = $('marq'), r = cvRect();
    const x = Math.min(drag.sx, e.clientX) - r.left, y = Math.min(drag.sy, e.clientY) - r.top;
    m.style.display = 'block';
    m.style.cssText += `display:block;left:${x}px;top:${y}px;width:${Math.abs(e.clientX - drag.sx)}px;height:${Math.abs(e.clientY - drag.sy)}px`;
    const w2 = toWorld(e.clientX, e.clientY);
    const bx = [Math.min(drag.wx, w2.x), Math.max(drag.wx, w2.x)], by = [Math.min(drag.wy, w2.y), Math.max(drag.wy, w2.y)];
    const hits = cvNodes.filter(n => {
      const p = cvPos[n.id], sz = nsize(n, UI.page);
      return p.x < bx[1] && p.x + sz.w > bx[0] && p.y < by[1] && p.y + sz.h > by[0];
    }).map(n => n.id);
    setSel(hits, drag.add); // очищает selNotes/selFrames, если !add
    (P.notes || []).forEach(t => {
      const w = t.w || 190, h = t.h || 90;
      if (t.x < bx[1] && t.x + w > bx[0] && t.y < by[1] && t.y + h > by[0]) UI.selNotes.add(t.id);
    });
    (P.frames || []).forEach(f => {
      if (f.x < bx[1] && f.x + f.w > bx[0] && f.y < by[1] && f.y + f.h > by[0]) UI.selFrames.add(f.id);
    });
    // Рамка ловит по КАСАНИЮ, а не по полному покрытию — так в обоих продуктах.
    const pgQ = curPage();
    if (isJam(pgQ)) {
      for (const it of jamItems(pgQ)) {
        if (it.lock) continue;
        const q = it.kind === 'draw' ? drawBox(it) : (it.kind === 'conn' ? connBox(it) : itemBox(it));
        if (!q) continue;
        if (q.x < bx[1] && q.x + q.w > bx[0] && q.y < by[1] && q.y + q.h > by[0]) UI.selItems.add(it.id);
      }
    }
    applyHi(); syncBulk();
    return;
  }
  if (drag.mode === 'nodeRS') {
    // по ходу жеста меняем только DOM; в документ размер уходит на mouseup
    drag.cw = Math.max(120, Math.round((drag.w + (e.clientX - drag.sx) / v.k) / GRID) * GRID);
    drag.ch = Math.max(56, Math.round((drag.h + (e.clientY - drag.sy) / v.k) / GRID) * GRID);
    const el = qs(`.nd[data-n="${CSS.escape(drag.n.id)}"]`);
    if (el) {el.style.width = drag.cw + 'px'; el.style.height = drag.ch + 'px';}
    return;
  }
  if (drag.mode === 'frameRS') {
    // по ходу жеста меняем только DOM; в документ размер уходит на mouseup
    drag.cw = Math.max(120, Math.round((drag.w + (e.clientX - drag.sx) / v.k) / GRID) * GRID);
    drag.ch = Math.max(90, Math.round((drag.h + (e.clientY - drag.sy) / v.k) / GRID) * GRID);
    const el = qs(`.fr[data-f="${drag.f.id}"]`); el.style.width = drag.cw + 'px'; el.style.height = drag.ch + 'px'; return;
  }
  if (drag.mode === 'noteRS') {
    drag.cw = Math.max(110, Math.round(drag.w + (e.clientX - drag.sx) / v.k));
    drag.ch = Math.max(60, Math.round(drag.h + (e.clientY - drag.sy) / v.k));
    const el = qs(`.stk[data-t="${drag.t.id}"]`); el.style.width = drag.cw + 'px'; el.style.height = drag.ch + 'px'; return;
  }
});
window.addEventListener('pointerup', e => {
  if (!drag) return;
  const d = drag; drag = null;
  if (d.mode === 'jdraw' || d.mode === 'jplace' || d.mode === 'jconn' || d.mode === 'jitemRS' || d.mode === 'jerase') {
    jamGestureUp(d, e); return;
  }
  const cv = $('cv'); if (cv) cv.classList.remove('panning', 'linking');
  qsa('.nd').forEach(el => el.classList.remove('drag', 'droptgt'));
  const m = $('marq'); if (m) m.style.display = 'none';
  // Клик по узлу (нажали и отпустили, не сдвинув) открывает его карточку.
  // Это самый привычный жест: раньше клик не делал ничего, а двойной клик занят
  // переименованием на месте — узнать, где смотреть детали, было неоткуда.
  if (d.mode === 'move' && !d.moved && !ro() && d.nodeIds && d.nodeIds.length === 1) {
    openNode(d.nodeIds[0]);
  }
  if (d.mode === 'move' && d.moved) {
    snapNow();
    const v2 = view(), pid = curPage().id;
    const dx = (e.clientX - d.sx) / v2.k, dy = (e.clientY - d.sy) / v2.k, snap = z => Math.round(z / GRID) * GRID;
    d.nodeIds.forEach(i => {const n = nodeById(i); if (n) setNpos(n, pid, cvPos[i].x, cvPos[i].y);});
    d.notes.forEach(id => {const t = (P.notes || []).find(x => x.id === id), o = d.noteOrig[id]; if (t && o) {t.x = snap(o.x + dx); t.y = snap(o.y + dy);}});
    d.frames.forEach(id => {const f = (P.frames || []).find(x => x.id === id), o = d.frameOrig[id]; if (f && o) {f.x = snap(o.x + dx); f.y = snap(o.y + dy);}});
    const pgU = curPage();
    (d.items || []).forEach(id => {
      const it = jamItemById(pgU, id), o = d.itemOrig[id];
      if (it && o) { it.x = snap(o.x + dx); it.y = snap(o.y + dy); }
    });
    save(); paintNodes(); paintEdges(); paintNotes(); paintFrames(); paintItems(); drawMini(); applyHi();
  }
  if (d.mode === 'link') {
    const t = $('tmpLink'); if (t) t.style.display = 'none';
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const tgt = el && el.closest && el.closest('.nd');
    if (tgt && tgt.dataset.n !== d.from) {
      const types = P.schema.linkTypes;
      const def = UI.linkType || types[0].key;
      const alt = types.find(t2 => t2.key !== def);
      addLink(d.from, tgt.dataset.n, e.shiftKey && alt ? alt.key : def);
    }
  }
  if (d.mode === 'nodeRS' && d.cw != null) {
    snapNow();
    setNsize(d.n, curPage().id, d.cw, d.ch);
    save(); paintNodes(); paintEdges(); drawMini(); applyHi();
  }
  if (['frameRS', 'noteRS'].includes(d.mode)) {
    // snapNow() ДО записи: раньше размер менялся прямо в mousemove, поэтому снимок
    // для undo уже содержал новый размер и отмена ресайза не работала
    if (d.cw != null) {
      snapNow();
      const o = d.mode === 'frameRS' ? d.f : d.t;
      o.w = d.cw; o.h = d.ch;
      save();
    }
    drawMini();
  }
  drawMini();
});
// Завершение жестов доски. Всё, что меняет документ, происходит ЗДЕСЬ, а не по ходу
// движения: иначе снимок для отмены снимался бы уже с изменённого состояния.
function jamGestureUp(d, e) {
  const pg = curPage(); if (!isJam(pg)) return;
  const cv = $('cv'); if (cv) cv.classList.remove('linking');
  const m = $('marq'); if (m) m.style.display = 'none';
  const tl = $('tmpLink'); if (tl) tl.style.display = 'none';
  qsa('.jitem, .nd').forEach(x => x.classList.remove('droptgt'));
  const tmp = qs('#jtmp'); if (tmp) tmp.remove();

  if (d.mode === 'jerase') { doneTool(); return; }

  if (d.mode === 'jitemRS') {
    if (d.cw != null) jamEdit(() => { d.it.w = d.cw; d.it.h = d.ch; });
    return;
  }

  if (d.mode === 'jdraw') {
    // 400 сырых точек ужимаются до полусотни: штрих ≈ 500 байт вместо нескольких КБ.
    const pts = rdp(d.pts, 0.6);
    if (pts.length < 2) { doneTool(); return; }
    jamEdit(() => {
      pg.jam.items.push({id: uid('i'), kind: 'draw', x: Math.round(d.x0), y: Math.round(d.y0),
        stroke: JAM.stroke, sw: JAM.sw, d: pts.map(q => q[0] + ',' + q[1]).join(' ')});
    });
    doneTool(); return;
  }

  if (d.mode === 'jconn') {
    const w = toWorld(e.clientX, e.clientY);
    const to = jamEndAt(e, pg) || {x: Math.round(w.x), y: Math.round(w.y)};
    const same = d.from.item && to.item && d.from.item === to.item;
    if (!same) {
      jamEdit(() => {
        pg.jam.items.push({id: uid('i'), kind: 'conn', a: d.from, b: to,
          style: 'curve', capB: 'arrow', stroke: '#5a6172', sw: 2});
      });
    }
    doneTool(); return;
  }

  // jplace
  const w = toWorld(e.clientX, e.clientY);
  const def = jamDefaults(d.kind);
  const snap = z => Math.round(z / GRID) * GRID;
  let box;
  if (d.moved) {
    box = {x: snap(Math.min(d.x0, w.x)), y: snap(Math.min(d.y0, w.y)),
           w: Math.max(40, snap(Math.abs(w.x - d.x0))), h: Math.max(40, snap(Math.abs(w.y - d.y0)))};
  } else {
    box = {x: snap(d.x0 - def.w / 2), y: snap(d.y0 - def.h / 2), w: def.w, h: def.h};
  }
  const it = Object.assign({id: uid('i'), kind: d.kind, text: ''}, def, box);
  jamEdit(() => { pg.jam.items.push(it); });
  setSelItems([it.id]);
  doneTool();
  // Каретка появляется сразу: «создать → выделить → двойной клик» это три действия
  // там, где в FigJam одно.
  if (d.kind !== 'section') {
    const el = qs(`.jitem[data-i="${CSS.escape(it.id)}"]`);
    if (el) jamInlineText(el);
  }
}
// Инструмент одноразовый, если его не закрепили двойным кликом.
function doneTool() { if (!JAM.sticky) setTool('sel'); }
// Правка текста на месте. contentEditable на .jtxt, запись — на blur:
// перерисовка по каждому символу крала бы каретку.
function jamInlineText(el) {
  const pg = curPage(); if (!isJam(pg) || ro()) return;
  const id = el.dataset.i, it = jamItemById(pg, id); if (!it || it.lock) return;
  const t = qs('.jtxt', el); if (!t) return;
  t.contentEditable = 'true';
  t.focus();
  const r = document.createRange(); r.selectNodeContents(t);
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
  const commit = () => {
    t.contentEditable = 'false';
    const v = t.textContent.trim();
    if (v !== (it.text || '')) { snapNow(); it.text = v; save(); }
    paintItems(); paintEdges(); applyHi();
  };
  t.onblur = commit;
  t.onkeydown = ev => {
    ev.stopPropagation();
    if (ev.key === 'Escape') { ev.preventDefault(); t.textContent = it.text || ''; t.blur(); }
    // Enter переносит строку — стикер растёт вниз. Завершает ввод Escape или клик мимо.
  };
}
function addLink(from, to, type) {
  if (P.links.some(l => l.from === from && l.to === to)) {toast('Такая связь уже есть'); return;}
  snapNow();
  P.links.push({id: uid('l'), from, to, type});
  gInval();
  if (hasCycle()) {P.links.pop(); gInval(); undoPop(); toast('Отклонено: получился цикл зависимостей'); return;}
  save(); renderPage(); toast('Связь: ' + ltOf(type).name.toLowerCase());
}
function selectLink(id) {
  UI.sel.clear(); UI.selLink = id; applyHi();
  qsa('#edges .edge').forEach(e => {e.style.strokeWidth = e.dataset.l === id ? 3.4 : 1.4; e.style.opacity = e.dataset.l === id ? 1 : .35;});
  openLink(id);
}
function inlineRename(el) {
  const id = el.dataset.n, n = nodeById(id), t = qs('.nt', el);
  t.contentEditable = 'true'; t.classList.add('nte'); t.focus();
  const rng = document.createRange(); rng.selectNodeContents(t);
  const s = getSelection(); s.removeAllRanges(); s.addRange(rng);
  const done = () => {
    t.contentEditable = 'false'; t.classList.remove('nte');
    const v = t.textContent.trim();
    if (v && v !== n.name) {snapNow(); n.name = v; save(); renderPage(); if (UI.insp === id) openNode(id);}
    else paintNodes();
  };
  t.onblur = done;
  t.onkeydown = ev => {if (ev.key === 'Enter') {ev.preventDefault(); t.blur();} if (ev.key === 'Escape') {t.textContent = n.name; t.blur();} ev.stopPropagation();};
}
function inlineNote(el) {
  const t = (P.notes || []).find(x => x.id === el.dataset.t), tx = qs('.txt', el);
  tx.contentEditable = 'true'; tx.focus();
  tx.onblur = () => {tx.contentEditable = 'false'; snapNow(); t.text = tx.textContent; save();};
  tx.onkeydown = ev => ev.stopPropagation();
}
/* ---------- создание объектов ---------- */
function addNode(at) {
  const pg = curPage();
  const p = at || centerWorld();
  snapNow();
  const n = {id: uid('n'), name: 'Новый узел', sub: '', type: P.schema.nodeTypes[0].key,
    status: (P.schema.statuses.find(s => s.key === 'na') || P.schema.statuses[P.schema.statuses.length - 1]).key,
    cat: (P.schema.categories[0] || {key: ''}).key, body: '', draft: 0, lane: null,
    x: null, y: null, p: {}, f: {}, checks: []};
  if (isSpatial(pg)) setNpos(n, pg.id, Math.round(p.x / GRID) * GRID, Math.round(p.y / GRID) * GRID);
  // наследуем значения фильтра страницы, чтобы узел не пропал из вида
  const flt = pg.filter || {};
  if (flt.cats && flt.cats.length) n.cat = flt.cats[0];
  if (flt.statuses && flt.statuses.length) n.status = flt.statuses[0];
  if (flt.types && flt.types.length) n.type = flt.types[0];
  if (flt.f) for (const k in flt.f) if (flt.f[k] && flt.f[k].length) n.f[k] = flt.f[k][0];
  P.nodes.push(n); gInval(); save();
  renderPage(); setSel([n.id]); UI.iTab = 'edit'; openNode(n.id);
  if (isSpatial(pg)) {const el = qs(`.nd[data-n="${CSS.escape(n.id)}"]`); if (el) el.scrollIntoView({block: 'center', inline: 'center'});}
  toast('Узел создан');
}
function centerWorld() {
  if (!$('cv')) return {x: 100, y: 100};
  const r = visibleRect();
  return toWorld(r.left + r.width / 2 - NW / 2, r.top + r.height / 2 - NH / 2);
}
function addFrame(kind) {
  const c = centerWorld();
  snapNow();
  const sel = selArr();
  let f = {id: uid('f'), name: kind === 'lane' ? 'Дорожка' : 'Область', kind: kind || 'frame',
    x: Math.round(c.x - 160), y: Math.round(c.y - 120), w: 460, h: 320, color: ''};
  if (sel.length) {
    const xs = sel.map(n => cvPos[n.id].x), ys = sel.map(n => cvPos[n.id].y);
    f.x = Math.min(...xs) - 26; f.y = Math.min(...ys) - 26;
    f.w = Math.max(...sel.map(n => cvPos[n.id].x + nsize(n, UI.page).w)) - f.x + 26;
    f.h = Math.max(...sel.map(n => cvPos[n.id].y + nsize(n, UI.page).h)) - f.y + 26;
  }
  P.frames = P.frames || []; P.frames.push(f); save(); renderPage(); openFrame(f);
}
function addNote() {
  const c = centerWorld(); snapNow();
  P.notes = P.notes || [];
  const t = {id: uid('t'), text: 'Заметка', x: Math.round(c.x), y: Math.round(c.y), w: 200, h: 96, color: ''};
  P.notes.push(t); save(); renderPage();
  setTimeout(() => {const el = qs(`.stk[data-t="${t.id}"]`); if (el) inlineNote(el);}, 60);
}
function deleteSelection() {
  if (UI.selLink && !UI.selLink.startsWith('frame:')) {
    snapNow(); P.links = P.links.filter(l => l.id !== UI.selLink); UI.selLink = null;
    gInval(); save(); renderPage(); closeInsp(); toast('Связь удалена'); return;
  }
  const ids = [...UI.sel];
  const noteSel = [...UI.selNotes];
  const frameSel = [...new Set([...UI.selFrames, ...((UI.selLink || '').startsWith('frame:') ? [UI.selLink.slice(6)] : [])])];
  const total = ids.length + noteSel.length + frameSel.length;
  if (!total) return;
  const go = () => {
    snapNow();
    if (ids.length) {
      P.nodes = P.nodes.filter(n => !ids.includes(n.id));
      P.links = P.links.filter(l => !ids.includes(l.from) && !ids.includes(l.to));
    }
    if (noteSel.length) P.notes = (P.notes || []).filter(n => !noteSel.includes(n.id));
    if (frameSel.length) P.frames = (P.frames || []).filter(f => !frameSel.includes(f.id));
    UI.sel.clear(); UI.selNotes.clear(); UI.selFrames.clear(); UI.selLink = null;
    gInval(); save(); closeInsp(); renderPage();
    toast('Удалено: ' + nOf(total, OBJS), {label: 'Вернуть', run: undo});
  };
  if (total > 1) confirmBox(`Удалить ${total} объектов${ids.length ? ' (узлы — вместе со связями)' : ''}?`, go, 'Удалить');
  else go();
}
function duplicateSelection() {
  const arr = selArr(); if (!arr.length) return;
  snapNow();
  const map = {};
  arr.forEach(n => {
    const c = clone(n); c.id = uid('n'); c.name = n.name + ' (копия)';
    const bp = cvPos[n.id] || {x: 40, y: 40};
    c.p = {}; if (isSpatial(curPage())) setNpos(c, curPage().id, bp.x + 26, bp.y + 26);
    map[n.id] = c.id; P.nodes.push(c);
  });
  P.links.slice().forEach(l => {
    if (map[l.from] && map[l.to]) P.links.push({id: uid('l'), from: map[l.from], to: map[l.to], type: l.type});
  });
  gInval(); save(); renderPage(); setSel(Object.values(map)); toast('Скопировано: ' + arr.length);
}
/* ---------- копирование и вставка (буфер в localStorage, работает между проектами) ---------- */
const CLIP_KEY = 'gs_clip';
let pasteShift = 0;
function copySelection() {
  const arr = selArr(); if (!arr.length) return;
  const ids = new Set(arr.map(n => n.id));
  const links = P.links.filter(l => ids.has(l.from) && ids.has(l.to)).map(l => ({from: l.from, to: l.to, type: l.type, label: l.label || ''}));
  const usedStatus = new Set(), usedCat = new Set(), usedType = new Set(), usedField = new Set(), usedLink = new Set();
  arr.forEach(n => {usedStatus.add(n.status); usedCat.add(n.cat); usedType.add(n.type); Object.keys(n.f || {}).forEach(k => usedField.add(k));});
  links.forEach(l => usedLink.add(l.type));
  const pick = (list, set) => (list || []).filter(x => set.has(x.key));
  const pid = isSpatial(curPage()) ? curPage().id : null;
  let minx = Infinity, miny = Infinity;
  const posMap = {};
  if (pid) arr.forEach(n => {const p = (typeof cvPos !== 'undefined' && cvPos[n.id]) || (n.p && n.p[pid]); if (p) {posMap[n.id] = p; minx = Math.min(minx, p.x); miny = Math.min(miny, p.y);}});
  const nodes = arr.map(n => {
    const c = clone(n); c.p = {}; c.x = null; c.y = null;
    const p = posMap[n.id]; c._rel = p ? {dx: p.x - minx, dy: p.y - miny} : null;
    return c;
  });
  const buf = {v: 1, from: P.id, nodes, links, schema: {
    statuses: pick(P.schema.statuses, usedStatus), categories: pick(P.schema.categories, usedCat),
    nodeTypes: pick(P.schema.nodeTypes, usedType), linkTypes: pick(P.schema.linkTypes, usedLink),
    fields: pick(P.schema.fields, usedField)}};
  try {localStorage.setItem(CLIP_KEY, JSON.stringify(buf)); toast('Скопировано узлов: ' + arr.length + (links.length ? ', связей: ' + links.length : ''));}
  catch (e) {toast('Не удалось скопировать: ' + e.message);}
}
function pasteSelection() {
  if (VIEWER) return;
  let buf; try {buf = JSON.parse(localStorage.getItem(CLIP_KEY) || 'null');} catch (e) {buf = null;}
  if (!buf || !buf.nodes || !buf.nodes.length) {toast('Буфер пуст — сначала Ctrl+C'); return;}
  snapNow();
  ['statuses', 'categories', 'nodeTypes', 'linkTypes', 'fields'].forEach(k => {
    ((buf.schema && buf.schema[k]) || []).forEach(it => {if (!P.schema[k].some(x => x.key === it.key)) P.schema[k].push(clone(it));});
  });
  const pg = curPage(), canvas = isSpatial(pg);
  const anchor = canvas ? centerWorld() : null;
  pasteShift = (pasteShift + 1) % 6;
  const off = 24 + pasteShift * 16;
  const map = {}, newNodes = [];
  buf.nodes.forEach(n => {
    const c = clone(n), rel = c._rel; delete c._rel;
    const nid = P.nodes.some(x => x.id === n.id) ? uid('n') : n.id;
    map[n.id] = nid; c.id = nid; c.p = {};
    if (canvas && anchor) setNpos(c, pg.id, Math.round((anchor.x + (rel ? rel.dx : 0) + off) / GRID) * GRID, Math.round((anchor.y + (rel ? rel.dy : 0) + off) / GRID) * GRID);
    P.nodes.push(c); newNodes.push(c.id);
  });
  buf.links.forEach(l => {if (map[l.from] && map[l.to]) P.links.push({id: uid('l'), from: map[l.from], to: map[l.to], type: l.type, label: l.label || ''});});
  gInval(); save(); renderPage(); setSel(newNodes);
  if (newNodes.length === 1) {UI.iTab = 'card'; openNode(newNodes[0]);}
  toast('Вставлено узлов: ' + newNodes.length);
}
function alignSel(how) {
  const arr = selArr(); if (arr.length < 2) return;
  snapNow();
  const ps = arr.map(n => ({n, p: cvPos[n.id], ...nsize(n, UI.page)}));
  if (how === 'l') {const v = Math.min(...ps.map(x => x.p.x)); ps.forEach(x => x.p.x = v);}
  if (how === 'r') {const v = Math.max(...ps.map(x => x.p.x + x.w)); ps.forEach(x => x.p.x = v - x.w);}
  if (how === 'cx') {const v = ps.reduce((a, x) => a + x.p.x + x.w / 2, 0) / ps.length; ps.forEach(x => x.p.x = Math.round(v - x.w / 2));}
  if (how === 't') {const v = Math.min(...ps.map(x => x.p.y)); ps.forEach(x => x.p.y = v);}
  if (how === 'b') {const v = Math.max(...ps.map(x => x.p.y + x.h)); ps.forEach(x => x.p.y = v - x.h);}
  if (how === 'cy') {const v = ps.reduce((a, x) => a + x.p.y + x.h / 2, 0) / ps.length; ps.forEach(x => x.p.y = Math.round(v - x.h / 2));}
  if (how === 'dv') {
    ps.sort((a, b) => a.p.y - b.p.y);
    const y0 = ps[0].p.y, y1 = ps[ps.length - 1].p.y, st = (y1 - y0) / (ps.length - 1);
    ps.forEach((x, i) => x.p.y = Math.round(y0 + st * i));
  }
  if (how === 'dh') {
    ps.sort((a, b) => a.p.x - b.p.x);
    const x0 = ps[0].p.x, x1 = ps[ps.length - 1].p.x, st = (x1 - x0) / (ps.length - 1);
    ps.forEach((x, i) => x.p.x = Math.round(x0 + st * i));
  }
  ps.forEach(x => setNpos(x.n, curPage().id, x.p.x, x.p.y));
  save(); renderPage();
}
function ctxMenu(e) {
  const nd = e.target.closest('.nd');
  const items = [];
  if (nd) {
    const id = nd.dataset.n;
    if (!UI.sel.has(id)) setSel([id]);
    const n = nodeById(id);
    items.push(['Открыть карточку', () => {UI.iTab = 'card'; openNode(id);}]);
    if (!VIEWER) {
      items.push(['Редактировать', () => {UI.iTab = 'edit'; openNode(id);}]);
      items.push(['—']);
      items.push(['Статус ▸', null, P.schema.statuses.map(s => [s.name, () => bulkSet('status', s.key)])]);
      items.push(['Категория ▸', null, P.schema.categories.map(s => [s.name, () => bulkSet('cat', s.key)])]);
      items.push(['—']);
      items.push(['Дублировать', duplicateSelection, null, 'Ctrl+D']);
      // на схеме pg.canvas отсутствует — без проверки здесь TypeError и меню не открывается
      if ((curPage().canvas || {}).layout === 'auto')
        items.push([n.pinned ? 'Открепить позицию' : 'Закрепить позицию', () => {
          snapNow(); selArr().forEach(x => x.pinned = n.pinned ? 0 : 1); save(); renderPage();
        }]);
      items.push(['Обвести областью', () => addFrame('frame'), null, 'Ctrl+G']);
      items.push(['—']);
      items.push(['Удалить', deleteSelection, null, 'Del', 1]);
    }
  } else {
    if (VIEWER) return;
    const w = toWorld(e.clientX, e.clientY);
    items.push(['Новый узел здесь', () => addNode({x: w.x - NW / 2, y: w.y - NH / 2})]);
    items.push(['Новая заметка', addNote]);
    items.push(['Новая область', () => addFrame('frame')]);
    items.push(['Новая дорожка', () => addFrame('lane')]);
    items.push(['—']);
    items.push(['Выделить всё', () => setSel(cvNodes.map(n => n.id)), null, 'Ctrl+A']);
    items.push(['Показать всё', fitAll]);
  }
  showCtx(e.clientX, e.clientY, items);
}
function showCtx(x, y, items) {
  const c = $('ctx'), l = qs('.mlist', c);
  const build = its => its.map(it => {
    if (it[0] === '—') return '<hr>';
    return `<div class="mi${it[4] ? ' dgr' : ''}" data-k="${esc(it[0])}">${esc(it[0])}${it[3] ? `<span class="k">${it[3]}</span>` : ''}</div>`;
  }).join('');
  l.innerHTML = build(items);
  c.style.left = x + 'px'; c.style.top = y + 'px'; c.classList.add('open');
  const r = l.getBoundingClientRect();
  if (r.right > innerWidth) c.style.left = (x - r.width) + 'px';
  if (r.bottom > innerHeight) c.style.top = (y - r.height) + 'px';
  qsa('.mi', l).forEach(el => el.onclick = () => {
    const it = items.find(i => i[0] === el.dataset.k);
    if (!it) return;
    if (it[2]) {
      const sub = it[2].map(s => `<div class="mi" data-k2="${esc(s[0])}">${esc(s[0])}</div>`).join('');
      l.innerHTML = sub;
      qsa('.mi', l).forEach(e2 => e2.onclick = () => {
        const s = it[2].find(z => z[0] === e2.dataset.k2); if (s) s[1](); hideCtx();
      });
      return;
    }
    hideCtx(); it[1] && it[1]();
  });
}
function hideCtx() { $('ctx').classList.remove('open'); }
document.addEventListener('pointerdown', e => {if (!e.target.closest('#ctx')) hideCtx();});


/* ==========================================================================
   ИНСПЕКТОР
   ========================================================================== */
function closeInsp() {
  const f = $('ifoot'); if (f) {f.classList.remove('on'); f.innerHTML = '';}
  UI.insp = null; UI.inspKind = null; UI.inspRef = null;
  $('insp').classList.remove('open'); document.body.classList.remove('inspopen');
  if (isSpatial(curPage())) applyHi();
}
$('iclose').onclick = () => {closeInsp(); setSel([]);};
$('itabs').addEventListener('click', e => {
  const t = e.target.closest('.t'); if (!t) return;
  UI.iTab = t.dataset.i;
  if (UI.insp) openNode(UI.insp);
});
function inspOpen() { $('insp').classList.add('open'); document.body.classList.add('inspopen'); }

// Узкий режим боковой панели. Состояние — настройка человека, живёт в meta рядом
// с темой и шириной инспектора, а не в проекте.
const SIDE_FULL = 236, SIDE_RAIL = 52;
function applySideRail(on) {
  const was = $('app').classList.contains('siderail');
  $('app').classList.toggle('siderail', !!on);
  const b = $('sideToggle');
  if (b) b.title = on ? 'Развернуть панель (Ctrl+B)' : 'Свернуть панель (Ctrl+B)';
  // Холст сдвигается вместе с панелью, а камера остаётся прежней — мир визуально
  // уезжает на 184 px. Компенсируем сдвигом камеры, чтобы под курсором осталось то же.
  if (P && was !== !!on && isSpatial(curPage()) && $('cv')) {
    const d = (SIDE_FULL - SIDE_RAIL) * (on ? 1 : -1);
    const v = view(); v.x += d;
    setTimeout(() => {applyView(); drawMini();}, 180);
  }
}
function toggleSideRail() {
  const on = !$('app').classList.contains('siderail');
  applySideRail(on);
  if (VIEWER) return;
  dbGet(META, 'ui').catch(() => null).then(rec => {
    const v = Object.assign({}, (rec && rec.v) || {}, {sideRail: on});
    dbPut(META, {k: 'ui', v}).catch(() => {});
  });
}
if ($('sideToggle')) $('sideToggle').onclick = e => {e.stopPropagation(); toggleSideRail();};
if ($('bShare')) $('bShare').onclick = () => {
  if (!cloud.boundToServer()) { toast('Сначала отправьте доску на сервер'); return; }
  cloud.showShare(cloud.CLOUD.board.id, P.name);
};
// Выход из доски наверх. Раньше вернуться к списку можно было только через
// название проекта в боковой панели — то есть никак, если панель свёрнута.
if ($('bHome')) $('bHome').onclick = goHome;
if ($('bName')) $('bName').onclick = () => { if (!ro()) renameProject(); };
if ($('bAvatar')) $('bAvatar').onclick = home.accountMenu;
if ($('bLogin')) $('bLogin').onclick = () => home.showAuthPage({then: () => home.showHome('all')});
// Кнопки браузера «назад» и «вперёд» должны работать: у приложения теперь свои адреса.
window.addEventListener('popstate', () => { if (P || cloud.CLOUD.account) routeBoot(); });
// правая кнопка по названию проекта — переименование и описание
if ($('projBtn')) $('projBtn').oncontextmenu = e => {
  if (VIEWER || !P) return;
  e.preventDefault();
  showCtx(e.clientX, e.clientY, [
    ['Переименовать проект…', renameProject],
    ['—'],
    ['Все доски', goHome],
  ]);
};
// Ширина инспектора — настройка человека, а не проекта: хранится в meta рядом с темой,
// а не в P, иначе уехала бы в экспорт и в выгруженный просмотрщик.
const INSP_MIN = 300, INSP_MAX = 720;
function applyInspW(px) {
  document.documentElement.style.setProperty('--insp-w', clamp(Math.round(px), INSP_MIN, INSP_MAX) + 'px');
}
async function loadInspW() {
  try {
    const rec = await dbGet(META, 'ui');
    if (rec && rec.v && rec.v.inspW) applyInspW(rec.v.inspW);
    if (rec && rec.v && rec.v.sects) UI.sects = rec.v.sects;
    if (rec && rec.v && rec.v.sideRail) applySideRail(true);
  } catch (e) {}
}
function saveInspW(px) {
  if (VIEWER) return;
  dbGet(META, 'ui').catch(() => null).then(rec => {
    const v = Object.assign({}, (rec && rec.v) || {}, {inspW: clamp(Math.round(px), INSP_MIN, INSP_MAX)});
    dbPut(META, {k: 'ui', v}).catch(() => {});
  });
}
(function wireInspGrip() {
  const grip = $('inspGrip'); if (!grip) return;
  grip.addEventListener('pointerdown', e => {
    e.preventDefault(); e.stopPropagation();
    const startX = e.clientX, startW = $('insp').getBoundingClientRect().width;
    document.body.classList.add('inspdrag');
    const move = ev => applyInspW(startW + (startX - ev.clientX));
    const up = () => {
      document.body.classList.remove('inspdrag');
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      saveInspW($('insp').getBoundingClientRect().width);
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  });
})();
const pillOf = s => {const x = statusOf(s); return `<span class="pill" style="color:${x.color};background:${x.color}18"><i style="background:${x.color}"></i>${esc(x.name)}</span>`;};

function openNode(id, keepScroll) {
  const n = nodeById(id); if (!n) return;
  const sc = keepScroll ? $('ib').scrollTop : 0;
  UI.insp = id; UI.inspKind = 'node'; UI.inspRef = null;
  const g = G();
  $('ititle').textContent = n.name;
  const st = stepOf(n);
  // Шапка была свалкой жаргона: статус, категория, тип, «шаг 3», сырой ID моноширинным
  // и «блокеров внутри», неотличимое от блокеров-зависимостей. Оставляем то, что
  // человек читает каждый раз, остальное — во вторую строку мелким.
  const blk = nBlockers(n);
  $('imeta').innerHTML = `${pillOf(n.status)} <b style="color:${catOf(n.cat).color}">${esc(catOf(n.cat).name)}</b>
    <div class="imetrics">
      <span title="столько узлов ждут этот, прямо или через цепочку">Разблокирует <b>${nOf(g.W(id), NODES)}</b></span>
      ${blk ? `<span title="пункты внутри узла, отмеченные как блокирующие">Не закрыто внутри: <b>${blk}</b></span>` : ''}
      <span title="глубина по зависимостям: столько шагов до него от начала">Шаг ${st}</span>
    </div>`;
  qsa('#itabs .t').forEach(t => t.classList.toggle('on', t.dataset.i === UI.iTab));
  if (UI.iTab === 'edit' && !ro()) editForm(n); else cardView(n, g);
  paintInspFoot(n);
  inspOpen(); $('ib').scrollTop = sc;
}
// Кнопки, которые нужны регулярно и должны быть видны всегда, а не в конце
// прокрутки внутри свёрнутого раздела.
function paintInspFoot(n) {
  const f = $('ifoot'); if (!f) return;
  if (VIEWER || !n) {f.classList.remove('on'); f.innerHTML = ''; return;}
  f.innerHTML = `<button class="btn" id="fDup">Дублировать</button>
    <span style="flex:1"></span>
    <button class="btn dgr" id="fDel">Удалить узел</button>`;
  f.classList.add('on');
  $('fDup').onclick = () => {setSel([n.id]); duplicateSelection();};
  $('fDel').onclick = () => {setSel([n.id]); deleteSelection();};
}
function cardView(n, g) {
  const ups = g.par[n.id] || [], dns = g.kids[n.id] || [];
  let h = '';
  P.schema.fields.forEach(f => {
    const v = (n.f || {})[f.key];
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) return;
    if (f.type === 'longtext') h += `<div class="sect">${esc(f.label)}</div><div class="kv" style="margin-top:0;white-space:pre-wrap">${esc(v)}</div>`;
    else if (f.type === 'list') h += `<div class="sect">${esc(f.label)} (${v.length})</div><ul style="margin:4px 0 0;padding-left:17px;font-size:12.3px;color:var(--ink2)">${v.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`;
    else h += `<div class="kv" style="margin-top:7px"><b>${esc(f.label)}:</b> ${esc(Array.isArray(v) ? v.join(', ') : v)}</div>`;
  });
  if (n.body) h += `<div class="sect">Описание${n.draft ? ' <span class="draft">черновик</span>' : ''}</div><div class="body">${esc(n.body)}</div>`;
  h += `<div class="sect">Что держит (${ups.length})</div>`;
  h += ups.length ? ups.map(u => `<span class="tag" data-go="${u.id}">${ltOf((linkById(u.lid) || {}).type).blocking ? '' : '⇢ '}${esc(nodeById(u.id).name)}</span>`).join('') : '<div class="kv">Входящих зависимостей нет — можно брать сейчас.</div>';
  h += `<div class="sect">Что откроет напрямую (${dns.length})</div>`;
  h += dns.length ? dns.map(u => `<span class="tag" data-go="${u.id}">${ltOf((linkById(u.lid) || {}).type).blocking ? '' : '⇢ '}${esc(nodeById(u.id).name)}</span>`).join('') : '<div class="kv">—</div>';
  h += `<div class="sect">Вехи и блокеры (${(n.checks || []).length})</div>`;
  h += (n.checks || []).map(c => `<div class="chk${c.b ? ' blk' : ''}"><div class="t">${c.b ? '⚠ ' : ''}${esc(c.t)} ${pillOf(c.s)}</div>${c.z ? `<div class="z">${esc(c.z)}</div>` : ''}</div>`).join('') || '<div class="kv">—</div>';
  if (!VIEWER) h += `<div style="margin-top:18px;display:flex;gap:7px"><button class="btn" id="toEdit">✎ Редактировать</button>
    <button class="btn" id="goCanvas">Показать на холсте</button></div>`;
  $('ib').innerHTML = h;
  const te = $('toEdit'); if (te) te.onclick = () => {UI.iTab = 'edit'; openNode(n.id);};
  const gc = $('goCanvas'); if (gc) gc.onclick = () => jumpToNode(n.id);
}
$('ib').addEventListener('click', e => {
  const g = e.target.closest('[data-go]'); if (g) {openNode(g.dataset.go); if (isSpatial(curPage())) {setSel([g.dataset.go]); flyTo(g.dataset.go);}}
});
const SCHEMA_PALETTE = ['#3355d1', '#0f8f6a', '#8b46c9', '#d2740c', '#b3261e', '#136c33', '#2f6fed', '#8a5d00', '#0e7490', '#9d174d', '#6b7280', '#b08900', '#4338ca', '#c2410c', '#18a558'];
function nextColor(list) {
  const used = new Set((list || []).map(x => x.color));
  return SCHEMA_PALETTE.find(c => !used.has(c)) || SCHEMA_PALETTE[(list || []).length % SCHEMA_PALETTE.length];
}
function schemaKey(arr, name, prefix) {
  const base = String(name || '').toLowerCase().replace(/[^0-9a-zа-яё]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 16) || prefix;
  let key = base, i = 1;
  while (arr.some(x => x.key === key)) key = base + '_' + (++i);
  return key;
}
// Инлайн-создание типа/статуса/категории прямо из инспектора (полное оформление — в «Схеме проекта»).
function createSchemaItem(kind, n) {
  const meta = {type: {arr: 'nodeTypes', word: 'тип узла'}, status: {arr: 'statuses', word: 'статус'}, cat: {arr: 'categories', word: 'категория'}}[kind];
  if (!meta) return;
  promptBox('Новый — ' + meta.word, 'Название', '', name => {
    const arr = P.schema[meta.arr];
    const key = schemaKey(arr, name, kind);
    snapNow();
    if (kind === 'type') arr.push({key, name, shape: 'rect'});
    else arr.push({key, name, color: nextColor(arr)});
    n[kind] = key;
    gInval(); save(); renderPage(); openNode(n.id);
    toast('Добавлено: «' + name + '». Цвет/форму можно поменять в «Схеме проекта».');
  });
}
// Инлайн-добавление значения в пользовательское поле-список прямо из инспектора.
function createFieldOption(key, n) {
  const f = fieldOf(key); if (!f) return;
  promptBox('Новое значение — ' + (f.label || key), 'Значение', '', val => {
    val = val.trim(); if (!val) return;
    snapNow();
    f.options = f.options || [];
    if (!f.options.includes(val)) f.options.push(val);
    fset(n, 'f.' + key, val);
    save(); renderPage(); openNode(n.id);
    toast('Добавлено значение: «' + val + '»');
  });
}
// Инлайн-создание колонки холста: добавляет подпись колонки и закрепляет узел в ней.
function createLane(n) {
  const pg = curPage();
  if (!pg || pg.kind !== 'canvas') {toast('Колонки есть только на холсте'); return;}
  pg.canvas = pg.canvas || {layout: 'auto', lanes: []};
  promptBox('Новая колонка', 'Название колонки', 'этап ' + ((pg.canvas.lanes || []).length), label => {
    snapNow();
    pg.canvas.lanes = pg.canvas.lanes || [];
    pg.canvas.lanes.push(label);
    n.lane = pg.canvas.lanes.length - 1;
    gInval(); save(); renderPage(); openNode(n.id);
    toast('Колонка добавлена: «' + label + '»');
  });
}
// Состояние свёрнутости разделов инспектора. Хранится в meta вместе с шириной панели:
// это настройка человека, а не проекта.
// Свои поля открыты по умолчанию: в реальном проекте это «Доска», «Волна», «Гейт» —
// ровно то, чем продакт пользуется каждый день, а свёрнутыми они были не видны.
const SECT_DEFAULT = {main: 1, desc: 1, links: 1, fields: 1, checks: 0, more: 0};
function sectOpen(key) {
  const v = (UI.sects || {})[key];
  return v === undefined ? !!SECT_DEFAULT[key] : !!v;
}
function saveSects() {
  if (VIEWER) return;
  dbGet(META, 'ui').catch(() => null).then(rec => {
    const v = Object.assign({}, (rec && rec.v) || {}, {sects: UI.sects});
    dbPut(META, {k: 'ui', v}).catch(() => {});
  });
}

function editForm(n) {
  const sts = P.schema.statuses.map(s => [s.key, s.name]);
  const cats = P.schema.categories.map(s => [s.key, s.name]);
  const tys = P.schema.nodeTypes.map(s => [s.key, s.name]);
  const g = G();
  const lanes = (curPage().canvas || {}).lanes || [];
  const newOpt = t => `<option value="__new__">＋ ${t}…</option>`;

  // раздел: заголовок со счётчиком + сворачиваемое тело
  const sect = (key, title, count, inner, hint) => {
    const open = sectOpen(key);
    return `<div class="isect${open ? '' : ' closed'}" data-sect="${key}">
        <span class="ttl">${esc(title)}</span>${count ? `<span class="cnt">${count}</span>` : ''}
        <span class="chev">▼</span></div>
      <div class="ibody${open ? '' : ' hidden'}" data-sbody="${key}">
        ${hint ? `<div class="ihint">${hint}</div>` : ''}${inner}</div>`;
  };

  // --- главное: то, что правят чаще всего ---
  let main = `<div class="f" style="margin-top:2px"><label>Название</label><input type="text" data-k="name" value="${esc(n.name)}"></div>
    <div class="f"><label>Подпись под названием</label><input type="text" data-k="sub" value="${esc(n.sub || '')}" placeholder="одна строка контекста"></div>
    <div class="frow">
      <div class="f"><label>Статус</label><select data-k="status">${opts(sts, n.status)}${newOpt('Новый статус')}</select></div>
      <div class="f"><label>Категория</label><select data-k="cat">${opts(cats, n.cat)}${newOpt('Новая категория')}</select></div>
    </div>
    <div class="f"><label>Тип узла — задаёт форму карточки на холсте</label>
      <select data-k="type">${opts(tys, n.type)}${newOpt('Новый тип')}</select></div>`;

  // --- описание ---
  const desc = `<div class="f" style="margin-top:2px"><textarea data-k="body" style="min-height:110px" placeholder="Зачем это нужно, что входит, на что влияет">${esc(n.body || '')}</textarea>
    <label class="cbx" style="margin-top:6px"><input type="checkbox" data-k="draft" ${n.draft ? 'checked' : ''}>черновик — ещё выверить</label></div>`;

  // --- связи: один блок вместо четырёх ---
  const ins = P.links.filter(l => l.to === n.id);
  const outs = P.links.filter(l => l.from === n.id);
  const chip = (l, dir) => {
    const other = dir === 'in' ? l.from : l.to, o = nodeById(other), t = ltOf(l.type);
    return `<span class="dchip" title="${esc(t.name)} · ${esc(other)}" style="border-color:${t.color}55;background:${t.color}14;color:var(--ink2)">
      <span style="color:${t.color};font-weight:800">${dir === 'in' ? '←' : '→'}</span>
      <span class="nm">${esc(o ? o.name : other)}</span>
      <i data-depdel="${esc(dir)}|${esc(l.type)}|${esc(other)}" title="убрать связь">×</i></span>`;
  };
  const linkBody = `<div class="deps">${ins.map(l => chip(l, 'in')).join('')}${outs.map(l => chip(l, 'out')).join('')}${!ins.length && !outs.length ? '<div class="dempty">Связей пока нет</div>' : ''}</div>
    <div class="depadd" data-depadd>
      <div class="frow" style="margin-top:6px">
        <div class="f" style="margin-top:0"><label>Направление</label>
          <select data-depdir><option value="in">← держит этот узел</option><option value="out">→ откроется после него</option></select></div>
        <div class="f" style="margin-top:0"><label>Тип связи</label>
          <select data-deptype>${P.schema.linkTypes.map(t => `<option value="${esc(t.key)}">${esc(t.name)}</option>`).join('')}</select></div>
      </div>
      <input type="text" placeholder="＋ добавить связь: название или id узла" data-depq style="margin-top:6px">
      <div class="deplist hidden"></div>
    </div>`;

  // --- свои поля схемы ---
  let fields = '';
  let filled = 0;
  P.schema.fields.forEach(f => {
    const v = (n.f || {})[f.key];
    if (v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)) filled++;
    fields += `<div class="f"><label>${esc(f.label)}</label>`;
    if (f.type === 'select') fields += `<select data-f="${esc(f.key)}">${opts(f.options || [], v || '', '— нет —')}${newOpt('Новое значение')}</select>`;
    else if (f.type === 'longtext') fields += `<textarea data-f="${esc(f.key)}">${esc(v || '')}</textarea>`;
    else if (f.type === 'number') fields += `<input type="number" data-f="${esc(f.key)}" value="${esc(v == null ? '' : v)}">`;
    else if (f.type === 'date') fields += `<input type="date" data-f="${esc(f.key)}" value="${esc(v || '')}">`;
    else if (f.type === 'checkbox') fields += `<label class="cbx"><input type="checkbox" data-f="${esc(f.key)}" ${v ? 'checked' : ''}>да</label>`;
    else if (f.type === 'list') {
      fields += `<div data-list="${esc(f.key)}">${(v || []).map((x, i) => `<div class="lrw"><input type="text" data-li="${i}" value="${esc(x)}"><button class="ib dgr" data-ldel="${i}">×</button></div>`).join('')}</div>
        <button class="btn sm" data-ladd="${esc(f.key)}">＋ пункт</button>`;
    } else fields += `<input type="text" data-f="${esc(f.key)}" value="${esc(v || '')}">`;
    fields += `</div>`;
  });
  if (!P.schema.fields.length) fields = '<div class="ihint">Своих полей в проекте нет. Завести их можно в «Схеме проекта».</div>';

  // --- вехи ---
  let checks = '<div id="chkList">';
  (n.checks || []).forEach((c, i) => {
    checks += `<div class="crow" data-ci="${i}">
      <div class="h"><span style="font-size:10px;font-weight:800;color:var(--muted);width:14px">${i + 1}</span>
        <select class="cellsel" data-c="s" style="border-color:var(--line)">${opts(sts, c.s)}</select>
        <label class="cbx" style="font-size:11.5px"><input type="checkbox" data-c="b" ${c.b ? 'checked' : ''}>блокер</label>
        <span style="flex:1"></span>
        <button class="ib" data-cup>↑</button><button class="ib" data-cdn>↓</button><button class="ib dgr" data-cdel>×</button></div>
      <input type="text" data-c="t" value="${esc(c.t)}" placeholder="что сделать">
      <input type="text" data-c="z" value="${esc(c.z || '')}" placeholder="комментарий" style="margin-top:5px;font-size:12px">
    </div>`;
  });
  checks += '</div><button class="btn sm" id="chkAdd">＋ веха</button>';

  // --- редкое и служебное ---
  const more = `<div class="frow" style="margin-top:2px">
      <div class="f" style="margin-top:0"><label>Шаг на холсте</label><select data-k="lane">${opts(lanes.map((l, i) => [i, i + ' — ' + l]), n.lane == null ? '' : n.lane, 'авто · сейчас ' + g.layer[n.id])}${curPage().kind === 'canvas' ? newOpt('Новый шаг') : ''}</select></div>
      <div class="f" style="margin-top:0"><label>Позиция на странице</label><button class="btn sm" id="unpin" style="width:100%;padding:6px" ${isPinned(n, UI.page) ? '' : 'disabled'}>${isPinned(n, UI.page) ? '📌 открепить' : 'авто'}</button></div>
    </div>
    <div class="f"><label>Идентификатор — им узел упоминается в экспорте и импорте</label>
      <input type="text" id="idf" value="${esc(n.id)}"></div>`;

  const h =
    sect('main', 'Главное', 0, main) +
    sect('desc', 'Описание', 0, desc) +
    sect('links', 'Связи', ins.length + outs.length, linkBody,
      '<b>←</b> — что должно быть готово до этого узла. <b>→</b> — что откроется, когда он будет готов.') +
    sect('fields', 'Свои поля', P.schema.fields.length ? `${filled} / ${P.schema.fields.length}` : 0, fields) +
    sect('checks', 'Пункты внутри узла', (n.checks || []).length, checks,
      'Что нужно сделать внутри самого узла. Отмеченные «блокер» показываются бейджем ⚠ на карточке — ' +
      'это не то же самое, что зависимости от других узлов.') +
    sect('more', 'Положение на холсте', 0, more,
      'Шаг — глубина по зависимостям. «Авто» значит, что он считается сам: столько шагов до узла от начала.');

  $('ib').innerHTML = h;
  wireEdit(n);
}
function wireEdit(n) {
  const B = $('ib');
  const soft = () => {save(); paintNodesSafe(); stalePages();};
  qsa('[data-k]', B).forEach(el => {
    const k = el.dataset.k;
    const rd = () => el.type === 'checkbox' ? (el.checked ? 1 : 0) : el.value;
    if (el.tagName === 'SELECT' || el.type === 'checkbox') el.onchange = () => {
      if (el.value === '__new__') {
        if (k === 'lane') {el.value = n.lane == null ? '' : n.lane; createLane(n);}
        else {el.value = n[k] || ''; createSchemaItem(k, n);}
        return;
      }
      snapNow();
      if (k === 'lane') {const v = rd(); if (v === '') n.lane = null; else n.lane = +v;}
      else n[k] = rd();
      gInval(); save(); renderPage(); openNode(n.id);
    };
    else el.oninput = () => {snapshot(); n[k] = el.value; if (k === 'name') $('ititle').textContent = el.value; soft();};
  });
  qsa('[data-f]', B).forEach(el => {
    const k = el.dataset.f, f = fieldOf(k);
    const rd = () => f.type === 'checkbox' ? (el.checked ? 1 : 0) : f.type === 'number' ? (el.value === '' ? '' : +el.value) : el.value;
    if (el.tagName === 'SELECT' || el.type === 'checkbox') el.onchange = () => {
      if (el.value === '__new__') {el.value = (n.f || {})[k] || ''; createFieldOption(k, n); return;}
      snapNow(); fset(n, 'f.' + k, rd()); save(); renderPage(); openNode(n.id);
    };
    else el.oninput = () => {snapshot(); fset(n, 'f.' + k, rd()); soft();};
  });
  qsa('[data-list]', B).forEach(box => {
    const k = box.dataset.list;
    qsa('[data-li]', box).forEach(el => el.oninput = () => {snapshot(); n.f[k][+el.dataset.li] = el.value; save();});
    qsa('[data-ldel]', box).forEach(el => el.onclick = () => {snapNow(); n.f[k].splice(+el.dataset.ldel, 1); save(); openNode(n.id);});
  });
  qsa('[data-ladd]', B).forEach(el => el.onclick = () => {
    snapNow(); const k = el.dataset.ladd; n.f = n.f || {}; n.f[k] = n.f[k] || []; n.f[k].push(''); save(); openNode(n.id);
  });
  // --- сворачивание разделов ---
  qsa('[data-sect]', B).forEach(head => head.onclick = () => {
    const key = head.dataset.sect;
    UI.sects = UI.sects || {};
    UI.sects[key] = !sectOpen(key);
    head.classList.toggle('closed', !UI.sects[key]);
    const bodyEl = qs(`[data-sbody="${key}"]`, B);
    if (bodyEl) bodyEl.classList.toggle('hidden', !UI.sects[key]);
    saveSects();
  });

  // --- зависимости: удаление чипом и добавление поиском ---
  const relink = (dir, type, other, add) => {
    // dir: 'in' — other → n, 'out' — n → other
    const from = dir === 'in' ? other : n.id, to = dir === 'in' ? n.id : other;
    snapNow();
    const before = P.links;
    P.links = P.links.filter(l => !(l.from === from && l.to === to && l.type === type));
    if (add) P.links.push({id: uid('l'), from, to, type});
    gInval();
    if (hasCycle()) {
      P.links = before; gInval();
      toast('Отклонено: получился бы цикл зависимостей');
      return false;
    }
    save(); renderPage(); openNode(n.id, true);
    // форма пересобрана — возвращаем курсор в поле поиска и восстанавливаем выбор
    // направления и типа, иначе подряд несколько связей не добавить
    const box2 = qs('[data-depadd]', $('ib'));
    if (box2) {
      const d2 = qs('[data-depdir]', box2), t2 = qs('[data-deptype]', box2);
      if (d2) d2.value = dir;
      if (t2) t2.value = type;
      const back = qs('[data-depq]', box2);
      if (back) back.focus();
    }
    return true;
  };
  qsa('[data-depdel]', B).forEach(el => el.onclick = () => {
    const [dir, type, other] = el.dataset.depdel.split('|');
    relink(dir, type, other, false);
  });
  // others считается здесь заново: editForm() и wireEdit() — разные функции,
  // и её область видимости сюда не дотягивается
  const others = P.nodes.filter(x => x.id !== n.id);
  qsa('[data-depadd]', B).forEach(box => {
    // направление и тип берутся из селекторов рядом, а не из четырёх отдельных блоков:
    // раньше на каждый тип связи × каждое направление рисовалось своё поле поиска
    const dirSel = qs('[data-depdir]', box), typeSel = qs('[data-deptype]', box);
    const inp = qs('[data-depq]', box), list = qs('.deplist', box);
    const cur = () => ({dir: dirSel.value, type: typeSel.value});
    const linkedNow = () => {
      const {dir, type} = cur();
      return new Set(dir === 'in'
        ? P.links.filter(l => l.to === n.id && l.type === type).map(l => l.from)
        : P.links.filter(l => l.from === n.id && l.type === type).map(l => l.to));
    };
    let idx = -1, shown = [];
    const close = () => {list.classList.add('hidden'); idx = -1; shown = [];};
    const paint = () => {
      const q = inp.value.trim().toLowerCase();
      const linked = linkedNow();
      shown = others
        .filter(o => !linked.has(o.id))
        .filter(o => !q || o.name.toLowerCase().includes(q) || o.id.toLowerCase().includes(q)
                       || (o.sub || '').toLowerCase().includes(q))
        .slice(0, 12);
      if (!shown.length) {
        list.innerHTML = `<div class="di" style="cursor:default;color:var(--muted)">${q ? 'ничего не нашлось' : 'все узлы уже связаны'}</div>`;
      } else {
        list.innerHTML = shown.map((o, i) => `<div class="di${i === idx ? ' on' : ''}" data-pick="${esc(o.id)}">
          <span class="dt" style="width:7px;height:7px;border-radius:50%;background:${catOf(o.cat).color}"></span>
          <span class="nm">${esc(o.name)}</span><span class="id">${esc(o.id)}</span></div>`).join('');
        qsa('[data-pick]', list).forEach(d => d.onmousedown = ev => {
          ev.preventDefault();
          const {dir, type} = cur();
          if (relink(dir, type, d.dataset.pick, true)) close();
        });
      }
      list.classList.remove('hidden');
    };
    inp.oninput = paint;
    inp.onfocus = paint;
    inp.onblur = () => setTimeout(close, 120);
    inp.onkeydown = ev => {
      if (ev.key === 'Escape') {close(); inp.blur(); return;}
      if (!shown.length) return;
      if (ev.key === 'ArrowDown') {ev.preventDefault(); idx = Math.min(idx + 1, shown.length - 1); paint();}
      else if (ev.key === 'ArrowUp') {ev.preventDefault(); idx = Math.max(idx - 1, 0); paint();}
      else if (ev.key === 'Enter') {
        ev.preventDefault();
        const pick = shown[idx >= 0 ? idx : 0];
        const {dir, type} = cur();
        if (pick && relink(dir, type, pick.id, true)) close();
      }
    };
  });
  qsa('.crow', B).forEach(row => {
    const i = +row.dataset.ci;
    qsa('[data-c]', row).forEach(el => {
      const k = el.dataset.c;
      const set = () => {n.checks[i][k] = el.type === 'checkbox' ? (el.checked ? 1 : 0) : el.value;};
      if (el.tagName === 'SELECT' || el.type === 'checkbox') el.onchange = () => {snapNow(); set(); save(); renderPage(); openNode(n.id);};
      else el.oninput = () => {snapshot(); set(); soft();};
    });
    row.querySelector('[data-cup]').onclick = () => {if (i) {snapNow(); const t = n.checks[i - 1]; n.checks[i - 1] = n.checks[i]; n.checks[i] = t; save(); openNode(n.id);}};
    row.querySelector('[data-cdn]').onclick = () => {if (i < n.checks.length - 1) {snapNow(); const t = n.checks[i + 1]; n.checks[i + 1] = n.checks[i]; n.checks[i] = t; save(); openNode(n.id);}};
    row.querySelector('[data-cdel]').onclick = () => {snapNow(); n.checks.splice(i, 1); save(); renderPage(); openNode(n.id);};
  });
  $('chkAdd').onclick = () => {
    snapNow(); n.checks = n.checks || [];
    n.checks.push({t: 'Новая веха', s: P.schema.statuses[P.schema.statuses.length - 1].key, z: '', b: 0});
    save(); renderPage(); openNode(n.id);
  };
  $('unpin').onclick = () => {snapNow(); if (n.p) delete n.p[UI.page]; n.pinned = 0; save(); renderPage(); openNode(n.id);};
  $('idf').onchange = () => {
    const v = $('idf').value.trim();
    if (!v || v === n.id) {$('idf').value = n.id; return;}
    if (nodeById(v)) {toast('ID уже занят'); $('idf').value = n.id; return;}
    snapNow();
    P.links.forEach(l => {if (l.from === n.id) l.from = v; if (l.to === n.id) l.to = v;});
    const old = n.id; n.id = v;
    if (UI.sel.has(old)) {UI.sel.delete(old); UI.sel.add(v);}
    gInval(); save(); renderPage(); openNode(v); toast('ID изменён, связи обновлены');
  };
  // «Дублировать» и «Удалить» переехали в постоянный футер панели — см. paintInspFoot()
}
function paintNodesSafe() { if (isSpatial(curPage()) && $('lyNodes')) {paintNodes(); paintEdges();} }
let staleT = null;
function stalePages() {
  const pg = curPage();
  if (!pg || (pg.kind !== 'table' && pg.kind !== 'board')) return;
  clearTimeout(staleT);
  staleT = setTimeout(() => {
    const p = curPage(); if (!p || (p.kind !== 'table' && p.kind !== 'board')) return;
    const sc = qs('#view .scroller'), st = sc ? sc.scrollTop : 0;
    const kb = qs('#view .kb'), kx = kb ? kb.scrollLeft : 0;
    renderPage(); // не трогает #insp, поэтому фокус в инспекторе сохраняется
    const sc2 = qs('#view .scroller'); if (sc2) sc2.scrollTop = st;
    const kb2 = qs('#view .kb'); if (kb2) kb2.scrollLeft = kx;
  }, 160);
}
function jumpToNode(id) {
  const n = nodeById(id); if (!n) return;
  const pg = P.pages.find(p => p.kind === 'canvas' && matchFilter(n, p.filter));
  if (pg && pg.id !== UI.page) {gotoPage(pg.id); setTimeout(() => {setSel([id]); flyTo(id); openNode(id);}, 60); return;}
  if (isSpatial(curPage())) {setSel([id]); flyTo(id);}
  openNode(id);
}
/* ---------- инспектор связи и области ---------- */
function openLink(lid) {
  const l = linkById(lid); if (!l) return;
  UI.insp = null; UI.inspKind = 'link'; UI.inspRef = lid;
  $('ititle').textContent = 'Связь';
  $('imeta').innerHTML = `<b>${esc(nodeById(l.from).name)}</b> → <b>${esc(nodeById(l.to).name)}</b>`;
  qsa('#itabs .t').forEach(t => t.classList.remove('on'));
  const dis = VIEWER ? 'disabled' : '';
  $('ib').innerHTML = `<div class="f"><label>Тип связи</label><select id="lt" ${dis}>${opts(P.schema.linkTypes.map(t => [t.key, t.name]), l.type)}</select></div>
    <div class="f"><label>Подпись на стрелке</label><input type="text" id="ll" value="${esc(l.label || '')}" ${dis}></div>
    <div class="kv" style="margin-top:12px">${ltOf(l.type).blocking ? 'Жёсткая: влияет на слои и вес узла.' : 'Мягкая: не влияет на слои.'}</div>
    ${VIEWER ? '' : `<div style="display:flex;gap:8px;margin-top:16px"><button class="btn" id="lrev">⇄ Развернуть</button><button class="btn dgr" id="ldel">Удалить связь</button></div>`}`;
  inspOpen();
  if (VIEWER) return;
  $('lt').onchange = () => {snapNow(); l.type = $('lt').value; gInval(); save(); renderPage(); selectLink(lid);};
  $('ll').oninput = () => {snapshot(); l.label = $('ll').value; save(); if ($('edges')) paintEdges();};
  $('lrev').onclick = () => {
    snapNow(); const f = l.from; l.from = l.to; l.to = f; gInval();
    if (hasCycle()) {l.to = l.from; l.from = f; gInval(); toast('Разворот создал бы цикл'); return;}
    save(); renderPage(); selectLink(lid);
  };
  $('ldel').onclick = () => {UI.selLink = lid; deleteSelection();};
}
function openFrame(f) {
  UI.insp = null; UI.inspKind = 'frame'; UI.inspRef = f.id;
  $('ititle').textContent = f.kind === 'lane' ? 'Дорожка' : 'Область';
  $('imeta').innerHTML = `${f.w}×${f.h}`;
  qsa('#itabs .t').forEach(t => t.classList.remove('on'));
  const dis = VIEWER ? 'disabled' : '';
  $('ib').innerHTML = `<div class="f"><label>Название</label><input type="text" id="fn" value="${esc(f.name)}" ${dis}></div>
    <div class="frow"><div class="f"><label>Вид</label><select id="fk" ${dis}>${opts([['frame', 'Область'], ['lane', 'Дорожка']], f.kind)}</select></div>
    <div class="f"><label>Цвет</label><input type="color" id="fc" class="swatch" style="width:100%;height:32px" value="${f.color || '#d7dbe6'}" ${dis}></div></div>
    ${VIEWER ? '' : `<button class="btn dgr" id="fdel" style="margin-top:16px">Удалить</button>`}`;
  inspOpen();
  if (VIEWER) return;
  $('fn').oninput = () => {snapshot(); f.name = $('fn').value; save(); const el = qs(`.fr[data-f="${f.id}"] .fh`); if (el) el.textContent = f.name;};
  $('fk').onchange = () => {snapNow(); f.kind = $('fk').value; save(); renderPage();};
  $('fc').oninput = () => {snapshot(); f.color = $('fc').value; save(); renderPage();};
  $('fdel').onclick = () => {snapNow(); P.frames = P.frames.filter(x => x.id !== f.id); save(); renderPage(); closeInsp();};
}

/* ==========================================================================
   ГРУППОВЫЕ ДЕЙСТВИЯ
   ========================================================================== */
function syncBulk() {
  let b = $('bulk');
  const n = UI.sel.size, extra = UI.selNotes.size + UI.selFrames.size, total = n + extra;
  if (!b) {
    b = document.createElement('div'); b.id = 'bulk'; $('view').appendChild(b);
  }
  if (!total || VIEWER) {b.classList.remove('on'); document.body.classList.remove('bulkon'); return;}
  const canvas = isSpatial(curPage());
  const label = extra ? `${total} выбрано${n ? ` (узлов ${n})` : ''}` : `${n} выбрано`;
  b.innerHTML = `<b style="font-size:12.5px">${label}</b>
    ${n ? `<select id="blkSt"><option value="">Статус…</option>${opts(P.schema.statuses.map(s => [s.key, s.name]), '_')}</select>
    <select id="blkCat"><option value="">Категория…</option>${opts(P.schema.categories.map(s => [s.key, s.name]), '_')}</select>
    <select id="blkTy"><option value="">Тип…</option>${opts(P.schema.nodeTypes.map(s => [s.key, s.name]), '_')}</select>` : ''}
    ${canvas && n ? `<span class="sep"></span>
    <button class="btn sm" data-al="l" title="по левому краю">⇤</button><button class="btn sm" data-al="cx" title="по центру">↔</button>
    <button class="btn sm" data-al="r" title="по правому краю">⇥</button>
    <button class="btn sm" data-al="t" title="по верху">⇧</button><button class="btn sm" data-al="cy" title="по середине">↕</button>
    <button class="btn sm" data-al="b" title="по низу">⇩</button>
    <button class="btn sm" data-al="dh" title="разложить по горизонтали">⇹</button><button class="btn sm" data-al="dv" title="разложить по вертикали">⇳</button>
    <button class="btn sm" id="blkFrame">Обвести</button>` : ''}
    <span class="sep"></span>
    ${n ? '<button class="btn sm" id="blkDup">Дублировать</button>' : ''}
    <button class="btn sm" id="blkDel" style="color:#ff9a92">Удалить</button>
    <button class="btn sm" id="blkNone">Снять</button>`;
  b.classList.add('on'); document.body.classList.add('bulkon');
  const st = $('blkSt'); if (st) st.onchange = e => {if (e.target.value) bulkSet('status', e.target.value); e.target.value = '';};
  const ct = $('blkCat'); if (ct) ct.onchange = e => {if (e.target.value) bulkSet('cat', e.target.value); e.target.value = '';};
  const ty = $('blkTy'); if (ty) ty.onchange = e => {if (e.target.value) bulkSet('type', e.target.value); e.target.value = '';};
  qsa('[data-al]', b).forEach(el => el.onclick = () => alignSel(el.dataset.al));
  const bf = $('blkFrame'); if (bf) bf.onclick = () => addFrame('frame');
  const bd = $('blkDup'); if (bd) bd.onclick = duplicateSelection;
  $('blkDel').onclick = deleteSelection;
  $('blkNone').onclick = () => {setSel([]); if (!isSpatial(curPage())) renderPage();};
}
function bulkSet(key, val) {
  const arr = selArr(); if (!arr.length) return;
  snapNow(); arr.forEach(n => fset(n, key, val));
  gInval(); save(); renderPage();
  if (UI.insp) openNode(UI.insp);
  toast(`Изменено узлов: ${arr.length}`);
}

/* ==========================================================================
   КЛАВИАТУРА
   ========================================================================== */
// Сочетания сверяются по e.code — ФИЗИЧЕСКОЙ клавише, а не по введённому символу.
// Раньше стояло e.key.toLowerCase() === 'z', а в русской раскладке та же клавиша
// даёт 'я'. То есть у человека с русским интерфейсом, который печатает по-русски,
// НЕ РАБОТАЛИ вообще все сочетания: Ctrl+Z, Ctrl+K, Ctrl+C/V, Ctrl+D, Ctrl+A,
// Ctrl+G, Ctrl+S и клавиша N — при том что справка и подсказки их обещают.
// e.key оставлен запасным вариантом для раскладок с нестандартными кодами.
const isKey = (e, code, letter) => e.code === code || e.key.toLowerCase() === letter;
document.addEventListener('keydown', e => {
  const tag = (e.target.tagName || '').toLowerCase();
  const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;
  if (e.code === 'Space' && !typing) {UI.spaceDown = true; const c = $('cv'); if (c) c.classList.add('pan');}
  const mod = e.ctrlKey || e.metaKey;
  const started = !!P && !home.homeOpen();
  if (e.key === 'Escape') {
    if ($('pal').classList.contains('open')) {$('pal').classList.remove('open'); return;}
    if ($('modal').classList.contains('open')) {closeModal(); return;}
    // На доске Esc сначала отпускает инструмент и только потом снимает выделение:
    // иначе выйти из режима рисования было бы нечем.
    if (P && isJam(curPage()) && (JAM.tool !== 'sel' || JAM.sticky)) {
      JAM.sticky = false; setTool('sel'); return;
    }
    if (home.homeOpen() && P) {home.hideAll(); return;}
    if (!started) return;
    setSel([]); closeInsp(); return;
  }
  // До открытия проекта половина обработчиков читает P.pages / curPage() и падает
  // с TypeError — а пустая база это самое первое, что видит новый человек.
  if (!started) return;
  if (mod && isKey(e, 'KeyK', 'k')) {e.preventDefault(); openPalette(); return;}
  if (typing) return;
  if (mod && isKey(e, 'KeyZ', 'z')) {e.preventDefault(); e.shiftKey ? redo() : undo(); return;}
  // Ctrl+S — мышечная память «сохранить». Доска сохраняется сама, поэтому сочетание
  // просто досохраняет немедленно и говорит об этом. Раньше оно открывало диалог
  // скачивания файла, что на «сохранить» совсем не похоже.
  if (mod && isKey(e, 'KeyS', 's')) {
    e.preventDefault();
    save(1);
    toast(cloud.boundToServer() ? 'Сохранено на сервере' : 'Сохранено');
    return;
  }
  if (VIEWER) return;
  // Буквы-инструменты доски. Раскладка взята у Miro (её знает больше людей),
  // сверка — по e.code, иначе в русской раскладке не работает ни одна.
  if (!mod && isJam(curPage())) {
    const TOOLS = {KeyV: 'sel', KeyH: 'hand', KeyN: 'sticky', KeyT: 'text', KeyR: 'shape',
                   KeyP: 'pen', KeyE: 'eraser', KeyX: 'conn', KeyF: 'section'};
    const t = TOOLS[e.code];
    if (t) {e.preventDefault(); JAM.sticky = false; setTool(t); return;}
  }
  if (mod && isJam(curPage()) && (e.code === 'BracketRight' || e.code === 'BracketLeft')) {
    e.preventDefault(); jamRaise(e.code === 'BracketRight' ? 'front' : 'back'); return;
  }
  if (mod && isKey(e, 'KeyA', 'a') && isJam(curPage())) {
    e.preventDefault();
    setSelItems(jamItems(curPage()).filter(i => !i.lock).map(i => i.id));
    cvNodes.forEach(n => UI.sel.add(n.id));
    applyHi(); syncBulk(); return;
  }
  if (mod && isKey(e, 'KeyA', 'a') && isSpatial(curPage())) {e.preventDefault(); setSel(cvNodes.map(n => n.id)); return;}
  if (mod && isKey(e, 'KeyD', 'd')) {
    e.preventDefault();
    if (isJam(curPage()) && UI.selItems.size) jamDuplicate(); else duplicateSelection();
    return;
  }
  if (mod && isKey(e, 'KeyC', 'c') && UI.sel.size) {e.preventDefault(); copySelection(); return;}
  if (mod && isKey(e, 'KeyV', 'v')) {e.preventDefault(); pasteSelection(); return;}
  if (mod && isKey(e, 'KeyB', 'b')) {e.preventDefault(); toggleSideRail(); return;}
  if (mod && isKey(e, 'KeyG', 'g')) {e.preventDefault(); if (UI.sel.size) addFrame('frame'); return;}
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    // Забыть здесь UI.selItems значило бы «стикер выделен, но клавишей не удаляется» —
    // ровно та половинчатость, которую замечают в первую минуту.
    if (isJam(curPage()) && UI.selItems.size) jamDelete();
    if (UI.sel.size || UI.selNotes.size || UI.selFrames.size) deleteSelection();
    return;
  }
  if (!mod && isKey(e, 'KeyN', 'n') && isGraphCv(curPage())) {addNode(); return;}
  // Панель больше не открывается сама по клику (см. onDown), поэтому нужен явный способ.
  if (e.key === 'Enter' && UI.sel.size === 1) {
    e.preventDefault();
    const only = [...UI.sel][0];
    if (UI.insp === only) closeInsp(); else openNode(only);
    return;
  }
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)
      && (UI.sel.size || UI.selItems.size) && isSpatial(curPage())) {
    e.preventDefault();
    const d = e.shiftKey ? 1 : GRID;
    const dx = e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0;
    const dy = e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0;
    snapshot();
    selArr().forEach(n => {
      cvPos[n.id].x += dx; cvPos[n.id].y += dy; setNpos(n, curPage().id, cvPos[n.id].x, cvPos[n.id].y);
      if ((curPage().canvas || {}).layout === 'auto') n.pinned = 1;
    });
    selItemsArr().forEach(it => {it.x = (+it.x || 0) + dx; it.y = (+it.y || 0) + dy;});
    updatePositions([...UI.sel]);
    if (isJam(curPage())) {paintItems(); paintEdges(); applyHi();}
    save();
  }
});
document.addEventListener('keyup', e => {
  if (e.code === 'Space') {UI.spaceDown = false; const c = $('cv'); if (c) c.classList.remove('pan');}
});

/* ==========================================================================
   ПАЛИТРА КОМАНД / ПОИСК
   ========================================================================== */
let palItems = [], palIdx = 0;
// Имя проекта задавалось один раз шаблоном и дальше только читалось — проект
// навсегда оставался «Новым проектом». Ни в одном меню переименования не было.
function renameProject() {
  if (!P || VIEWER) return;
  modal(`<h3>Проект</h3>
    <div class="f"><label>Название</label><input type="text" id="prn" value="${esc(P.name || '')}"></div>
    <div class="f"><label>Описание — одна строка для карточки в списке</label>
      <input type="text" id="prd" value="${esc(P.desc || '')}"></div>
    <div class="mfoot"><button class="btn" data-a="c">Отмена</button><button class="btn pri" data-a="ok">Сохранить</button></div>`, b => {
    b.querySelector('[data-a=c]').onclick = closeModal;
    const go = () => {
      const nm = $('prn').value.trim();
      if (!nm) {toast('Название не может быть пустым'); return;}
      snapNow(); P.name = nm; P.desc = $('prd').value.trim();
      save(1); refreshProjMeta(); renderPages(); closeModal();
      document.title = P.name + ' — Graph Studio';
      toast('Проект переименован', {label: 'Вернуть', run: undo});
    };
    b.querySelector('[data-a=ok]').onclick = go;
    $('prn').onkeydown = e => {if (e.key === 'Enter') go();};
    setTimeout(() => {$('prn').focus(); $('prn').select();}, 30);
  });
}
function openPalette() {
  palItems = [];
  P.pages.forEach(p => palItems.push({t: p.name, s: 'страница · ' + kindName(p.kind), go: () => gotoPage(p.id)}));
  P.nodes.forEach(n => palItems.push({t: n.name, s: catOf(n.cat).name + ' · ' + statusOf(n.status).name, go: () => jumpToNode(n.id)}));
  if (!VIEWER) {
    // Половина возможностей закопана в модалке «Экспорт и импорт» — проверку проекта
    // и снимки версий там никто не найдёт. Палитра должна быть единой точкой входа.
    const cmd = (t, s2, go) => palItems.push({t, s: s2, go});
    cmd('Новый узел', 'команда · N', () => addNode());
    cmd('Новая страница', 'команда', newPage);
    cmd('Переименовать проект', 'команда', renameProject);
    cmd('Схема проекта', 'команда · типы, статусы, категории, связи', () => showSchema());
    cmd('Проверить проект', 'команда · битые связи, дубли, циклы', showValidator);
    cmd('Снимки версий', 'команда · сохранить или восстановить', showSnaps);
    cmd('Экспорт и импорт', 'команда · JSON, CSV, картинка, просмотрщик', () => showExport());
    cmd('Все доски', 'команда', goHome);
    cmd('Свернуть боковую панель', 'команда · Ctrl+B', toggleSideRail);
    cmd('Тёмная или светлая тема', 'команда', toggleTheme);
    cmd('Справка', 'команда', showHelp);
    if (cloud.boundToServer()) cmd('История изменений', 'команда', () => showHistory());
    cmd('Показать всё на холсте', 'команда', () => {if (isSpatial(curPage())) fitAll();});
  }
  $('pal').classList.add('open'); $('palin').value = ''; palIdx = 0; palRender('');
  setTimeout(() => $('palin').focus(), 30);
}
function palRender(q) {
  q = q.toLowerCase();
  const list = palItems.filter(i => (i.t + ' ' + i.s).toLowerCase().includes(q)).slice(0, 60);
  palIdx = clamp(palIdx, 0, Math.max(0, list.length - 1));
  $('pallist').innerHTML = list.map((i, k) => `<div class="pr${k === palIdx ? ' on' : ''}" data-k="${k}">${esc(i.t)}<span class="s">${esc(i.s)}</span></div>`).join('')
    || '<div class="pr" style="color:var(--muted)">Ничего не найдено</div>';
  qsa('.pr', $('pallist')).forEach(el => el.onclick = () => {const i = list[+el.dataset.k]; if (i) {$('pal').classList.remove('open'); i.go();}});
  $('pallist')._list = list;
}
$('palin').oninput = () => {palIdx = 0; palRender($('palin').value);};
$('palin').onkeydown = e => {
  const list = $('pallist')._list || [];
  if (e.key === 'ArrowDown') {palIdx = Math.min(list.length - 1, palIdx + 1); palRender($('palin').value); e.preventDefault();}
  if (e.key === 'ArrowUp') {palIdx = Math.max(0, palIdx - 1); palRender($('palin').value); e.preventDefault();}
  if (e.key === 'Enter') {const i = list[palIdx]; if (i) {$('pal').classList.remove('open'); i.go();}}
};
$('pal').onclick = e => {if (e.target.id === 'pal') $('pal').classList.remove('open');};
$('bFind').onclick = openPalette;


/* ==========================================================================
   СТРАНИЦЫ
   ========================================================================== */
// Каталог видов страницы. Пояснение (d) лежит ЗДЕСЬ, а не в шаблоне диалога
// «Новая страница»: иначе каждый новый вид требует правки в трёх разных местах,
// и одно из них обязательно забывается.
const KIND = {
  canvas: {n: 'Холст', i: '◇', d: 'колонка = глубина зависимости'},
  space: {n: 'Схема', i: '⬚', d: 'свободная схема: кладёшь что хочешь и куда хочешь'},
  jam: {n: 'Доска', i: '▩', d: 'стикеры, фигуры, стрелки и рисунки на бесконечном холсте'},
  table: {n: 'Таблица', i: '▤', d: 'строки, колонки, правка в ячейках'},
  board: {n: 'Канбан', i: '▥', d: 'карточки по колонкам, drag&drop'},
  dash: {n: 'Дашборд', i: '◎', d: 'плитки и сводка из данных'},
};
const kindName = k => (KIND[k] || {n: k}).n;

function renderPages() {
  $('pageList').innerHTML = P.pages.map(p =>
    `<div class="pgi${p.id === UI.page ? ' on' : ''}" data-p="${p.id}" title="${esc(p.name)} · ${esc(kindName(p.kind))}" draggable="${VIEWER ? 'false' : 'true'}">
      <span class="ic">${KIND[p.kind] ? KIND[p.kind].i : '•'}</span><span class="nm">${esc(p.name)}</span>
      <span class="mo noview" data-mo="${p.id}">⋯</span></div>`).join('');
  qsa('#pageList .pgi').forEach(el => {
    el.onclick = e => {if (e.target.dataset.mo) {pageMenu(e, e.target.dataset.mo); return;} gotoPage(el.dataset.p);};
    // Правая кнопка — второй вход в меню страницы. В узком режиме панели «⋯» скрыт,
    // и без этого переименовать, продублировать или удалить страницу было бы нельзя.
    el.oncontextmenu = e => {if (VIEWER) return; e.preventDefault(); pageMenu(e, el.dataset.p);};
    el.ondragstart = e => {e.dataTransfer.setData('text/plain', el.dataset.p);};
    el.ondragover = e => {e.preventDefault(); el.classList.add('drop');};
    el.ondragleave = () => el.classList.remove('drop');
    el.ondrop = e => {
      e.preventDefault(); el.classList.remove('drop');
      const from = e.dataTransfer.getData('text/plain'), to = el.dataset.p;
      if (from === to) return;
      snapNow();
      const a = P.pages.findIndex(x => x.id === from), b = P.pages.findIndex(x => x.id === to);
      const [m] = P.pages.splice(a, 1); P.pages.splice(b, 0, m);
      save(); renderPages();
    };
  });
  $('projBtn').querySelector('.pn').textContent = P.name;
}
function gotoPage(id) {
  // Инструмент — состояние руки на КОНКРЕТНОЙ доске. Утёкший на холст-граф «ластик»
  // означал бы, что ветка инструмента в onDown перехватывает нажатия там, где её не ждут.
  JAM.tool = 'sel'; JAM.sticky = false;
  UI.page = id; UI.sel.clear(); UI.selNotes.clear(); UI.selFrames.clear(); UI.selItems.clear(); UI.selLink = null; closeInsp();
  renderPages(); renderPage();
}
function renderPage() {
  const pg = curPage(); if (!pg) return;
  UI.page = pg.id;
  $('pgTitle').textContent = pg.name;
  const ns = pageNodes(pg);
  // «из 32 узлов», а не «из 32 узла»: после предлога «из» нужен родительный падеж,
  // а nOf() даёт форму, согласованную с числительным в именительном
  $('pgSub').textContent = `${kindName(pg.kind)} · ${ns.length} из ${P.nodes.length} узлов`;
  renderPageBar(pg);
  const old = $('bulk'); if (old) old.remove();
  if (isJam(pg)) renderJam(pg);
  else if (isGraphCv(pg)) renderCanvas(pg);
  else if (pg.kind === 'table') renderTable(pg);
  else if (pg.kind === 'board') renderBoard(pg);
  else if (pg.kind === 'dash') renderDash(pg);
  // неизвестный тип раньше молча рисовался дашбордом — теперь это видно
  else {$('view').innerHTML = `<div class="scroller"><div class="hint">Неизвестный тип страницы: ${esc(pg.kind)}</div></div>`;}
  syncBulk(); paintSave();
}
/* ---------- панель страницы ---------- */
function renderPageBar(pg) {
  const bar = $('pagebar');
  const flt = pg.filter = pg.filter || {q: '', cats: [], statuses: [], types: [], f: {}};
  let h = `<input type="text" id="fq" placeholder="Фильтр по тексту…" value="${esc(flt.q || '')}" style="width:190px">`;
  h += `<div class="menu" id="mFilter"><button class="btn${activeFilterCount(flt) ? ' act' : ''}">Фильтр${activeFilterCount(flt) ? ' · ' + activeFilterCount(flt) : ''} ▾</button><div class="mlist left" style="min-width:270px;max-height:60vh;overflow:auto"></div></div>`;
  if (pg.kind === 'canvas') {
    h += `<span class="sep"></span>
      <div class="menu" id="mLay"><button class="btn">${pg.canvas.layout === 'auto' ? '⚙ Авто-раскладка' : '✋ Свободно'} ▾</button>
        <div class="mlist left"><div class="mi" data-l="auto">Авто по зависимостям<small>колонка = глубина зависимости</small></div>
        <div class="mi" data-l="free">Свободная<small>узлы стоят там, где поставил</small></div><hr>
        <div class="mi noview" data-l="reset">Пересчитать раскладку<small>снять закрепление позиций</small></div>
        <div class="mi noview" data-l="lanes">Подписи колонок…</div></div></div>`;
    h += `<div class="menu noview" id="mAddObj"><button class="btn">＋ Объект ▾</button><div class="mlist left">
      <div class="mi" data-o="node">Узел<span class="k">N</span></div><div class="mi" data-o="note">Заметка</div>
      <div class="mi" data-o="frame">Область<span class="k">Ctrl+G</span></div><div class="mi" data-o="lane">Дорожка</div></div></div>`;
    h += `<div class="menu noview" id="mLType"><button class="btn">Связь: <b id="ltName"></b> ▾</button><div class="mlist left"></div></div>`;
    h += `<div class="menu" id="mImg"><button class="btn">⤓ Картинка ▾</button><div class="mlist left">
      <div class="mi" data-img="png">Экспорт в PNG<small>2× — для презентации</small></div>
      <div class="mi" data-img="svg">Экспорт в SVG<small>вектор — для правки</small></div></div></div>`;
    h += `<span class="spacer"></span><button class="chip" id="cCrit">Критический путь</button><button class="chip" id="cReady">Доступное сейчас</button>`;
  }
  if (pg.kind === 'space') {
    h += `<span class="sep"></span>
      <div class="menu noview" id="mAddObj"><button class="btn">＋ Объект ▾</button><div class="mlist left">
        <div class="mi" data-o="node">Новый узел<span class="k">N</span></div><div class="mi" data-o="note">Заметка</div>
        <div class="mi" data-o="frame">Область<span class="k">Ctrl+G</span></div></div></div>`;
    h += `<div class="menu noview" id="mPut"><button class="btn">↧ Положить узел ▾</button>
      <div class="mlist left" style="min-width:300px;padding:6px">
        <input type="text" id="putq" placeholder="найти узел проекта…" style="width:100%">
        <div id="putlist" style="max-height:240px;overflow:auto;margin-top:5px"></div></div></div>`;
    h += `<div class="menu noview" id="mLType"><button class="btn">Связь: <b id="ltName"></b> ▾</button><div class="mlist left"></div></div>`;
    h += `<div class="menu" id="mImg"><button class="btn">⤓ Картинка ▾</button><div class="mlist left">
      <div class="mi" data-img="png">Экспорт в PNG<small>2× — для презентации</small></div>
      <div class="mi" data-img="svg">Экспорт в SVG<small>вектор — для правки</small></div></div></div>`;
    h += `<span class="spacer"></span><span class="hint">Свободная схема: узлы лежат там, где положил</span>`;
  }
  if (pg.kind === 'jam') {
    // Тот же поиск, что на схеме: доска показывает только положенное, и должен
    // быть способ вынести на неё существующий узел проекта — ради этого гибрид.
    h += `<span class="sep"></span>
      <div class="menu noview" id="mPut"><button class="btn">↧ Положить узел ▾</button>
      <div class="mlist left" style="min-width:300px;padding:6px">
        <input type="text" id="putq" placeholder="найти узел проекта…" style="width:100%">
        <div id="putlist" style="max-height:240px;overflow:auto;margin-top:5px"></div></div></div>`;
    h += `<div class="menu noview" id="mBg"><button class="btn">Фон ▾</button><div class="mlist left">
      <div class="mi" data-bg="dots">Точки</div><div class="mi" data-bg="grid">Клетка</div>
      <div class="mi" data-bg="none">Без сетки</div></div></div>`;
    h += `<span class="spacer"></span><span class="hint">Инструменты внизу · V стрелка, N стикер, T текст, R фигура, P перо</span>`;
  }
  if (pg.kind === 'table') {
    h += `<div class="menu" id="mCols"><button class="btn">Колонки ▾</button><div class="mlist left" style="max-height:60vh;overflow:auto"></div></div>`;
    h += `<div class="menu" id="mGrp"><button class="btn">Группировка ▾</button><div class="mlist left"></div></div>`;
    h += `<span class="spacer"></span><span class="hint" id="tblCount"></span>`;
  }
  if (pg.kind === 'board') {
    h += `<div class="menu" id="mGby"><button class="btn">Колонки по: <b id="gbyName"></b> ▾</button><div class="mlist left"></div></div>`;
    h += `<span class="spacer"></span><span class="hint">Перетаскивай карточки между колонками</span>`;
  }
  bar.innerHTML = h;
  // Каретка улетала в конец строки: после дебаунса шла полная перерисовка, и позиция
  // курсора восстанавливалась как value.length. Правишь слово в середине запроса —
  // через 280 мс курсор в хвосте. Запоминаем реальную позицию выделения.
  $('fq').oninput = deb(() => {
    const src = $('fq');
    const ss = src ? src.selectionStart : null, se = src ? src.selectionEnd : null;
    pg.filter.q = src.value; save(); renderPage();
    const el = $('fq');
    if (el) {el.focus(); if (ss != null) el.setSelectionRange(ss, se);}
  }, 280);
  buildFilterMenu(pg);
  if (pg.kind === 'canvas') {
    qsa('#mLay .mi').forEach(el => el.onclick = () => {
      const l = el.dataset.l;
      if (l === 'reset') {
        snapNow();
        const cnt = pageNodes(pg).filter(n => n.p && n.p[pg.id]).length;
        pageNodes(pg).forEach(n => {if (n.p) delete n.p[pg.id]; n.pinned = 0;});
        save(); renderPage(); fitAll();
        toast(`Позиции сброшены: ${nOf(cnt, NODES)}`, {label: 'Вернуть', run: undo});
        return;
      }
      if (l === 'lanes') {editLanes(pg); return;}
      snapNow();
      // Возврат в «Авто» раньше ничего не менял: переключение в «Свободно» прописывает
      // позицию каждому узлу, а авто-раскладка отдаёт приоритет сохранённой позиции.
      // Человек возвращался в «Авто» и видел ту же кашу, решая, что раскладка сломана.
      if (l === 'auto') pageNodes(pg).forEach(n => {if (n.p) delete n.p[pg.id]; n.pinned = 0;});
      pg.canvas.layout = l;
      seedFreePositions(pg);
      save(); renderPage(); fitAll();
      if (l === 'auto') toast('Раскладка считается по зависимостям', {label: 'Вернуть', run: undo});
    });
    qsa('#mAddObj .mi').forEach(el => el.onclick = () => {
      const o = el.dataset.o;
      if (o === 'node') addNode(); if (o === 'note') addNote();
      if (o === 'frame') addFrame('frame'); if (o === 'lane') addFrame('lane');
    });
    qsa('#mImg .mi').forEach(el => el.onclick = () => {el.dataset.img === 'png' ? exportCanvasPNG() : exportCanvasSVG();});
    UI.linkType = UI.linkType && P.schema.linkTypes.some(t => t.key === UI.linkType) ? UI.linkType : P.schema.linkTypes[0].key;
    $('ltName').textContent = ltOf(UI.linkType).name;
    qs('#mLType .mlist').innerHTML = P.schema.linkTypes.map(t =>
      `<div class="mi" data-lt="${esc(t.key)}"><span style="width:22px;border-top:2px ${t.style} ${t.color};display:inline-block"></span>${esc(t.name)}</div>`).join('')
      + '<hr><div class="mi" data-lt="__">Настроить типы связей…</div>';
    qsa('#mLType .mi').forEach(el => el.onclick = () => {
      if (el.dataset.lt === '__') {showSchema('links'); return;}
      UI.linkType = el.dataset.lt; $('ltName').textContent = ltOf(UI.linkType).name;
    });
    $('cCrit').classList.toggle('on', !!pg.canvas.crit);
    $('cReady').classList.toggle('on', !!pg.canvas.ready);
    // не перерисовываем страницу и не двигаем камеру: это переключение акцента,
    // а не смена содержимого — раньше здесь был fitAll() и карта прыгала
    $('cCrit').onclick = () => {
      pg.canvas.crit = !pg.canvas.crit; pg.canvas.ready = false;
      save(); $('cCrit').classList.toggle('on', !!pg.canvas.crit); $('cReady').classList.remove('on'); applyHi();
    };
    $('cReady').onclick = () => {
      pg.canvas.ready = !pg.canvas.ready; pg.canvas.crit = false;
      save(); $('cReady').classList.toggle('on', !!pg.canvas.ready); $('cCrit').classList.remove('on'); applyHi();
    };
  }
  if (pg.kind === 'jam') {
    qsa('#mBg .mi').forEach(el => el.onclick = () => {
      pg.jam.bg = el.dataset.bg; save(); renderPage();
    });
  }
  if (pg.kind === 'space' || pg.kind === 'jam') {
    qsa('#mAddObj .mi').forEach(el => el.onclick = () => {
      const o = el.dataset.o;
      if (o === 'node') addNode(); if (o === 'note') addNote(); if (o === 'frame') addFrame('frame');
    });
    qsa('#mImg .mi').forEach(el => el.onclick = () => {el.dataset.img === 'png' ? exportCanvasPNG() : exportCanvasSVG();});
    // Поиск «положить узел» общий со схемой, а вот выбор типа связи — нет:
    // на доске стрелка это линия, а не зависимость, и меню типов там не рисуется.
    if ($('ltName')) {
    UI.linkType = UI.linkType && P.schema.linkTypes.some(t => t.key === UI.linkType) ? UI.linkType : P.schema.linkTypes[0].key;
    $('ltName').textContent = ltOf(UI.linkType).name;
    qs('#mLType .mlist').innerHTML = P.schema.linkTypes.map(t =>
      `<div class="mi" data-lt="${esc(t.key)}"><span style="width:22px;border-top:2px ${t.style} ${t.color};display:inline-block"></span>${esc(t.name)}</div>`).join('')
      + '<hr><div class="mi" data-lt="__">Настроить типы связей…</div>';
    qsa('#mLType .mi').forEach(el => el.onclick = () => {
      if (el.dataset.lt === '__') {showSchema('links'); return;}
      UI.linkType = el.dataset.lt; $('ltName').textContent = ltOf(UI.linkType).name;
    });
    }
    // «Положить узел»: схема и доска показывают только то, что на них положили, поэтому
    // должен быть способ вынести на неё уже существующий узел проекта
    const putq = $('putq'), putlist = $('putlist');
    const paintPut = () => {
      const q = (putq.value || '').trim().toLowerCase();
      const free = P.nodes.filter(n => !npos(n, pg.id))
        .filter(n => !q || n.name.toLowerCase().includes(q) || n.id.toLowerCase().includes(q)
                       || (n.sub || '').toLowerCase().includes(q))
        .slice(0, 40);
      putlist.innerHTML = free.length
        ? free.map(n => `<div class="di" data-put="${esc(n.id)}" style="display:flex;align-items:center;gap:7px;padding:5px 7px;border-radius:6px;font-size:12.2px;cursor:pointer">
            <span style="width:7px;height:7px;border-radius:50%;background:${catOf(n.cat).color}"></span>
            <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(n.name)}</span>
            <span style="font-size:9.6px;color:var(--muted);font-family:ui-monospace,Menlo,monospace">${esc(n.id)}</span></div>`).join('')
        : `<div class="kv" style="padding:4px 6px">${q ? 'ничего не нашлось' : 'все узлы проекта уже здесь'}</div>`;
      qsa('[data-put]', putlist).forEach(el => {
        el.onmouseenter = () => el.style.background = 'var(--accent-bg)';
        el.onmouseleave = () => el.style.background = '';
        el.onclick = () => {
          const n = nodeById(el.dataset.put); if (!n) return;
          snapNow();
          const c = centerWorld();
          // раскладываем каскадом, чтобы несколько подряд не легли друг на друга
          const k = pageNodes(pg).length;
          setNpos(n, pg.id, Math.round((c.x + (k % 5) * 40) / GRID) * GRID,
                            Math.round((c.y + Math.floor(k / 5) * 30) / GRID) * GRID);
          save(); renderPage(); setSel([n.id]);
          toast((isJam(pg) ? 'Узел на доске: ' : 'Узел на схеме: ') + n.name);
        };
      });
    };
    putq.oninput = paintPut;
    paintPut();
  }
  if (pg.kind === 'table') buildColsMenu(pg);
  if (pg.kind === 'board') buildGbyMenu(pg);
  qsa('.menu > .btn').forEach(b => b.onclick = e => {
    e.stopPropagation();
    const m = b.parentElement, was = m.classList.contains('open');
    qsa('.menu').forEach(x => x.classList.remove('open'));
    m.classList.toggle('open', !was);
  });
}
function deb(fn, ms) {let t; return (...a) => {clearTimeout(t); t = setTimeout(() => fn(...a), ms || 250);};}
document.addEventListener('click', e => {if (!e.target.closest('.menu')) qsa('.menu').forEach(x => x.classList.remove('open'));});
function activeFilterCount(f) {
  let n = (f.cats || []).length + (f.statuses || []).length + (f.types || []).length + (f.blockersOnly ? 1 : 0);
  for (const k in (f.f || {})) n += (f.f[k] || []).length;
  return n;
}
// Сколько узлов ТЕКУЩЕЙ страницы (после её фильтра) имеют каждое значение фасета.
// Пустые для страницы значения (0) прячутся, пока не включён «показать все».
function facetCounts(pg) {
  const base = pageNodes(pg);
  const c = {cats: {}, statuses: {}, types: {}, f: {}};
  base.forEach(n => {
    c.cats[n.cat] = (c.cats[n.cat] || 0) + 1;
    c.statuses[n.status] = (c.statuses[n.status] || 0) + 1;
    c.types[n.type] = (c.types[n.type] || 0) + 1;
    Object.keys(n.f || {}).forEach(k => {
      c.f[k] = c.f[k] || {};
      const v = n.f[k], vals = Array.isArray(v) ? v : [v];
      vals.forEach(x => {if (x != null && x !== '') c.f[k][x] = (c.f[k][x] || 0) + 1;});
    });
  });
  return c;
}
function buildFilterMenu(pg) {
  const f = pg.filter, box = qs('#mFilter .mlist');
  const showAll = !!UI.filterShowAll;
  const FC = facetCounts(pg);
  let hiddenN = 0;
  const grp = (cap, list, cur, onT, cmap) => {
    cmap = cmap || {};
    const items = list.map(([k, l, c]) => {
      const cnt = cmap[k] || 0, sel = cur.includes(k);
      if (!sel && !cnt) { if (!showAll) {hiddenN++; return '';} }
      return `<div class="mi" data-ft="${esc(onT)}|${esc(k)}">
        <input type="checkbox" ${sel ? 'checked' : ''} style="pointer-events:none">
        ${c ? `<span class="dt" style="width:8px;height:8px;border-radius:50%;background:${c};display:inline-block"></span>` : ''}
        <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis">${esc(l)}</span>
        <span style="font-size:10.5px;color:var(--muted)${!cnt ? ';opacity:.4' : ''}">${cnt}</span></div>`;
    }).filter(Boolean).join('');
    return items ? `<div class="cap">${esc(cap)}</div>` + items : '';
  };
  let body = grp('Категория', P.schema.categories.map(c => [c.key, c.name, c.color]), f.cats || [], 'cats', FC.cats);
  body += grp('Статус', P.schema.statuses.map(c => [c.key, c.name, c.color]), f.statuses || [], 'statuses', FC.statuses);
  body += grp('Тип', P.schema.nodeTypes.map(c => [c.key, c.name]), f.types || [], 'types', FC.types);
  P.schema.fields.filter(x => x.type === 'select').forEach(fl => {
    body += grp(fl.label, (fl.options || []).map(o => [o, o]), ((f.f || {})[fl.key] || []), 'f.' + fl.key, FC.f[fl.key]);
  });
  let h = '';
  if (showAll || hiddenN) h = `<div class="mi" data-ft="toggleAll|1" style="color:var(--accent);font-weight:650">${showAll ? '▾ Скрыть пустые' : '▸ Показать все значения' + (hiddenN ? ' (+' + hiddenN + ')' : '')}</div><hr>`;
  h += body;
  h += `<hr><div class="mi" data-ft="blockersOnly|1"><input type="checkbox" ${f.blockersOnly ? 'checked' : ''} style="pointer-events:none">Только с блокерами</div>`;
  h += `<div class="mi" data-ft="clear|1">Сбросить фильтр</div>`;
  box.innerHTML = h;
  qsa('.mi', box).forEach(el => el.onclick = ev => {
    ev.stopPropagation();
    const [t, k] = el.dataset.ft.split('|');
    if (t === 'toggleAll') { UI.filterShowAll = !UI.filterShowAll; buildFilterMenu(pg); return; }
    if (t === 'clear') {pg.filter = {q: pg.filter.q, cats: [], statuses: [], types: [], f: {}};}
    else if (t === 'blockersOnly') pg.filter.blockersOnly = pg.filter.blockersOnly ? 0 : 1;
    else if (t.startsWith('f.')) {
      const key = t.slice(2); f.f = f.f || {}; f.f[key] = f.f[key] || [];
      f.f[key] = f.f[key].includes(k) ? f.f[key].filter(x => x !== k) : f.f[key].concat(k);
    } else {
      f[t] = f[t] || [];
      f[t] = f[t].includes(k) ? f[t].filter(x => x !== k) : f[t].concat(k);
    }
    save(); renderPage();
    setTimeout(() => {const m = $('mFilter'); if (m) m.classList.add('open');}, 10);
  });
}
function editLanes(pg) {
  modal(`<h3>Подписи колонок</h3><div class="kv">Колонка 0 — то, что ни от чего не зависит. Дальше по глубине зависимостей.</div>
    <div class="f"><label>Через «;»</label><input type="text" id="lnin" value="${esc((pg.canvas.lanes || []).join('; '))}"></div>
    <div class="f"><label>Пояснение над холстом (можно HTML)</label><textarea id="lnintro">${esc(pg.canvas.intro || '')}</textarea></div>
    <div class="mfoot"><button class="btn" data-a="c">Отмена</button><button class="btn pri" data-a="ok">Сохранить</button></div>`, b => {
    b.querySelector('[data-a=c]').onclick = closeModal;
    b.querySelector('[data-a=ok]').onclick = () => {
      snapNow(); pg.canvas.lanes = $('lnin').value.split(';').map(s => s.trim()).filter(Boolean);
      pg.canvas.intro = $('lnintro').value; save(); closeModal(); renderPage();
    };
  });
}

/* ==========================================================================
   ТАБЛИЦА
   ========================================================================== */
function cellValue(n, c) {
  const g = G();
  if (c === 'step') {const s = stepOf(n); return s === 0 ? '0' : String(s);}
  if (c === 'weight') return g.W(n.id);
  if (c === 'checks') return (n.checks || []).length;
  if (c === 'blockers') return nBlockers(n);
  if (c === 'deps') return (g.par[n.id] || []).length;
  if (c === 'kids') return (g.kids[n.id] || []).length;
  if (c === 'id') return n.id;
  const v = fval(n, c);
  return Array.isArray(v) ? v.join(', ') : (v == null ? '' : v);
}
function renderTable(pg) {
  pg.table = pg.table || {cols: ['name', 'cat', 'type', 'status', 'step', 'weight', 'checks'], sort: 'step', dir: 1, group: ''};
  const t = pg.table, cols = t.cols;
  let ns = pageNodes(pg);
  const g = G();
  const key = n => {
    const v = cellValue(n, t.sort);
    return typeof v === 'number' ? v : String(v).toLowerCase();
  };
  ns.sort((a, b) => {const x = key(a), y = key(b); return (x > y ? 1 : x < y ? -1 : 0) * (t.dir || 1) || String(a.name).localeCompare(b.name);});
  const groups = t.group ? uniq(ns.map(n => String(cellValue(n, t.group)))).sort() : [''];
  const th = cols.map(c => `<th data-c="${esc(c)}">${esc(colLabel(c))}${t.sort === c ? ` <span class="ar">${t.dir > 0 ? '▲' : '▼'}</span>` : ''}</th>`).join('');
  let rows = '';
  groups.forEach(gr => {
    const list = t.group ? ns.filter(n => String(cellValue(n, t.group)) === gr) : ns;
    if (t.group) rows += `<tr class="grouphd"><td colspan="${cols.length + 1}">${esc(colLabel(t.group))}: ${esc(gr || '—')} · ${list.length}</td></tr>`;
    list.forEach(n => {
      rows += `<tr data-r="${esc(n.id)}" class="${UI.sel.has(n.id) ? 'selrow' : ''}">` + cols.map(c => `<td>${cellHTML(n, c)}</td>`).join('') +
        `<td style="width:30px"><button class="ib" data-open="${esc(n.id)}" title="карточка">↗</button></td></tr>`;
    });
  });
  $('view').innerHTML = ns.length
    ? `<div class="scroller"><div class="tblwrap"><table class="grid">
      <thead><tr>${th}<th></th></tr></thead><tbody>${rows}</tbody></table></div>
      ${VIEWER ? '' : `<div style="margin-top:10px"><button class="btn" id="tAdd">＋ Узел</button></div>`}
      </div>`
    : `<div class="scroller">${emptyBlock(pg, P.nodes.length)}</div>`;
  $('tblCount').textContent = nOf(ns.length, ROWS);
  qsa('#view th[data-c]').forEach(el => el.onclick = () => {
    if (t.sort === el.dataset.c) t.dir = (t.dir || 1) * -1; else {t.sort = el.dataset.c; t.dir = 1;}
    save(); renderPage();
  });
  qsa('#view tr[data-r]').forEach(tr => {
    const n = nodeById(tr.dataset.r);
    tr.onclick = e => {
      if (e.target.closest('input,select,button')) return;
      if (e.shiftKey || e.metaKey || e.ctrlKey) {UI.sel.has(n.id) ? UI.sel.delete(n.id) : UI.sel.add(n.id);}
      else {UI.sel.clear(); UI.sel.add(n.id);}
      qsa('#view tr[data-r]').forEach(x => x.classList.toggle('selrow', UI.sel.has(x.dataset.r)));
      syncBulk(); openNode(n.id);
    };
    qsa('[data-e]', tr).forEach(el => {
      const c = el.dataset.e;
      if (el.tagName === 'SELECT') el.onchange = () => {snapNow(); fset(n, c, el.value); gInval(); save(); renderPage(); if (UI.insp === n.id) openNode(n.id);};
      else el.oninput = () => {snapshot(); fset(n, c, el.value); save(); if (UI.insp === n.id) $('ititle').textContent = n.name;};
    });
    const ob = tr.querySelector('[data-open]'); if (ob) ob.onclick = ev => {ev.stopPropagation(); UI.iTab = 'card'; openNode(n.id);};
  });
  const ta = $('tAdd'); if (ta) ta.onclick = () => addNode();
}
function cellHTML(n, c) {
  const ro = VIEWER;
  if (c === 'name') return `<span class="catdot" style="background:${catOf(n.cat).color}"></span>` +
    (ro ? `<b>${esc(n.name)}</b>` : `<input class="cellin" data-e="name" value="${esc(n.name)}" style="width:calc(100% - 12px);font-weight:650">`);
  if (c === 'sub') return ro ? esc(n.sub || '') : `<input class="cellin" data-e="sub" value="${esc(n.sub || '')}">`;
  if (c === 'status') return ro ? pillOf(n.status) : `<select class="cellsel" data-e="status" style="color:${statusOf(n.status).color}">${opts(P.schema.statuses.map(s => [s.key, s.name]), n.status)}</select>`;
  if (c === 'cat') return ro ? esc(catOf(n.cat).name) : `<select class="cellsel" data-e="cat" style="color:${catOf(n.cat).color}">${opts(P.schema.categories.map(s => [s.key, s.name]), n.cat)}</select>`;
  if (c === 'type') return ro ? esc(typeOf(n.type).name) : `<select class="cellsel" data-e="type">${opts(P.schema.nodeTypes.map(s => [s.key, s.name]), n.type)}</select>`;
  if (c === 'checks') {const b = nBlockers(n); return `${(n.checks || []).length}${b ? ` <b style="color:var(--red)">⚠${b}</b>` : ''}`;}
  if (c === 'weight') return `<b>${G().W(n.id)}</b>`;
  if (c === 'body') return `<span style="color:var(--ink2);font-size:11.6px">${esc((n.body || '').slice(0, 120))}${(n.body || '').length > 120 ? '…' : ''}</span>`;
  if (c.startsWith('f.')) {
    const f = fieldOf(c.slice(2)); const v = (n.f || {})[c.slice(2)];
    if (!ro && f && f.type === 'select') return `<select class="cellsel" data-e="${esc(c)}">${opts(f.options || [], v || '', '—')}</select>`;
    if (!ro && f && (f.type === 'text' || f.type === 'number')) return `<input class="cellin" data-e="${esc(c)}" value="${esc(v == null ? '' : v)}">`;
    return esc(Array.isArray(v) ? v.join(', ') : (v == null ? '' : v));
  }
  return esc(cellValue(n, c));
}
function buildColsMenu(pg) {
  const t = pg.table, box = qs('#mCols .mlist');
  const avail = ['name', 'sub', 'cat', 'type', 'status', 'step', 'weight', 'checks', 'blockers', 'deps', 'kids', 'body', 'id']
    .concat(P.schema.fields.map(f => 'f.' + f.key));
  box.innerHTML = avail.map(c => `<div class="mi" data-col="${esc(c)}"><input type="checkbox" ${t.cols.includes(c) ? 'checked' : ''} style="pointer-events:none">${esc(colLabel(c))}</div>`).join('');
  qsa('.mi', box).forEach(el => el.onclick = ev => {
    ev.stopPropagation();
    const c = el.dataset.col;
    t.cols = t.cols.includes(c) ? t.cols.filter(x => x !== c) : t.cols.concat(c);
    if (!t.cols.length) t.cols = ['name'];
    save(); renderPage(); setTimeout(() => $('mCols').classList.add('open'), 10);
  });
  const gb = qs('#mGrp .mlist');
  const gcols = [['', 'без группировки'], ['cat', 'Категория'], ['status', 'Статус'], ['type', 'Тип'], ['step', 'Шаг']]
    .concat(P.schema.fields.filter(f => f.type === 'select').map(f => ['f.' + f.key, f.label]));
  gb.innerHTML = gcols.map(([k, l]) => `<div class="mi" data-g="${esc(k)}">${t.group === k ? '● ' : ''}${esc(l)}</div>`).join('');
  qsa('.mi', gb).forEach(el => el.onclick = () => {t.group = el.dataset.g; if (t.group) {t.sort = t.group; } save(); renderPage();});
}

/* ==========================================================================
   КАНБАН
   ========================================================================== */
function boardCols(pg) {
  const by = pg.board.groupBy;
  if (by === 'status') return P.schema.statuses.map(s => ({k: s.key, n: s.name, c: s.color}));
  if (by === 'cat') return P.schema.categories.map(s => ({k: s.key, n: s.name, c: s.color}));
  if (by === 'type') return P.schema.nodeTypes.map(s => ({k: s.key, n: s.name}));
  if (by === 'step') return uniq(pageNodes(pg).map(stepOf)).sort((a, b) => a - b).map(s => ({k: String(s), n: 'шаг ' + s}));
  const f = fieldOf(by.replace(/^f\./, ''));
  return ((f && f.options) || []).map(o => ({k: o, n: o})).concat([{k: '', n: '— пусто —'}]);
}
function renderBoard(pg) {
  pg.board = pg.board || {groupBy: 'status'};
  const cols = boardCols(pg), by = pg.board.groupBy;
  const ns = pageNodes(pg), g = G();
  const val = n => by === 'step' ? String(stepOf(n)) : String(fval(n, by) == null ? '' : fval(n, by));
  let h = '<div class="kb">';
  cols.forEach(c => {
    const list = ns.filter(n => val(n) === String(c.k)).sort((a, b) => g.W(b.id) - g.W(a.id));
    h += `<div class="kbcol" data-k="${esc(c.k)}">
      <div class="kbh">${c.c ? `<span class="dt" style="background:${c.c};width:9px;height:9px;border-radius:50%"></span>` : ''}${esc(c.n)}<span class="n">${list.length}</span></div>
      <div class="kbl">${list.map(n => `<div class="kc" data-n="${esc(n.id)}" draggable="${VIEWER ? 'false' : 'true'}">
        <div class="bar" style="background:${catOf(n.cat).color}"></div>
        <div class="t">${esc(n.name)}</div>${n.sub ? `<div class="s">${esc(n.sub)}</div>` : ''}
        <div class="m">${by !== 'status' ? pillOf(n.status) : ''}
          ${nBlockers(n) ? `<span class="pill" style="color:var(--red);background:var(--red-bg)">⚠${nBlockers(n)}</span>` : ''}
          ${g.W(n.id) >= 3 ? `<span class="pill" style="color:var(--accent);background:var(--accent-bg)">${g.W(n.id)}</span>` : ''}</div>
      </div>`).join('')}</div>
      ${VIEWER ? '' : `<button class="btn sm" data-add="${esc(c.k)}" style="margin-top:6px;width:100%;justify-content:center">＋</button>`}
    </div>`;
  });
  h += '</div>';
  $('view').innerHTML = ns.length
    ? `<div class="scroller" style="padding-bottom:20px">${h}</div>`
    : `<div class="scroller">${emptyBlock(pg, P.nodes.length)}</div>`;
  // Перенос карточки в другую колонку. Одна функция на оба способа: HTML5 drag&drop
  // (мышь) и перетаскивание пальцем. Раньше был только первый, и на телефоне канбан
  // работал ровно наполовину — посмотреть можно, передвинуть нельзя.
  const dropTo = (id, col) => {
    const n = nodeById(id); if (!n || ro()) return;
    snapNow();
    if (by === 'step') n.lane = +col.dataset.k; else fset(n, by, col.dataset.k);
    gInval(); save(); renderPage(); if (UI.insp === id) openNode(id);
  };

  qsa('.kc').forEach(el => {
    el.onclick = () => {setSel([el.dataset.n]); openNode(el.dataset.n);};
    el.ondragstart = e => {e.dataTransfer.setData('text/plain', el.dataset.n); el.classList.add('drag');};
    el.ondragend = () => el.classList.remove('drag');
    if (VIEWER) return;
    el.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'touch' || ro()) return;
      const startX = e.clientX, startY = e.clientY;
      let ghost = null, over = null, moved = false;
      const move = ev => {
        const dx = ev.clientX - startX, dy = ev.clientY - startY;
        if (!moved && Math.abs(dx) + Math.abs(dy) < 12) return;
        if (!moved) {
          moved = true;
          el.classList.add('drag');
          ghost = el.cloneNode(true);
          ghost.className = 'kc kghost';
          ghost.style.width = el.offsetWidth + 'px';
          document.body.appendChild(ghost);
        }
        ev.preventDefault();
        ghost.style.left = (ev.clientX - el.offsetWidth / 2) + 'px';
        ghost.style.top = (ev.clientY - 18) + 'px';
        // Колонку ищем под пальцем, а не по пересечению прямоугольников: колонки
        // прокручиваются вбок, и их координаты в разметке не совпадают с видимыми.
        ghost.style.pointerEvents = 'none';
        const under = document.elementFromPoint(ev.clientX, ev.clientY);
        const col = under && under.closest('.kbcol');
        if (col !== over) {
          if (over) over.classList.remove('over');
          over = col; if (over) over.classList.add('over');
        }
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        el.classList.remove('drag');
        if (ghost) ghost.remove();
        if (over) { over.classList.remove('over'); if (moved) dropTo(el.dataset.n, over); }
      };
      window.addEventListener('pointermove', move, {passive: false});
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
  });
  qsa('.kbcol').forEach(col => {
    col.ondragover = e => {e.preventDefault(); col.classList.add('over');};
    col.ondragleave = () => col.classList.remove('over');
    col.ondrop = e => {
      e.preventDefault(); col.classList.remove('over');
      dropTo(e.dataTransfer.getData('text/plain'), col);
    };
    const ab = col.querySelector('[data-add]');
    if (ab) ab.onclick = () => {
      addNode();
      const n = P.nodes[P.nodes.length - 1];
      if (by === 'step') n.lane = +col.dataset.k; else fset(n, by, col.dataset.k);
      gInval(); save(); renderPage(); openNode(n.id);
    };
  });
}
function buildGbyMenu(pg) {
  const box = qs('#mGby .mlist');
  const list = [['status', 'Статус'], ['cat', 'Категория'], ['type', 'Тип'], ['step', 'Шаг']]
    .concat(P.schema.fields.filter(f => f.type === 'select').map(f => ['f.' + f.key, f.label]));
  $('gbyName').textContent = (list.find(x => x[0] === pg.board.groupBy) || ['', '?'])[1];
  box.innerHTML = list.map(([k, l]) => `<div class="mi" data-g="${esc(k)}">${pg.board.groupBy === k ? '● ' : ''}${esc(l)}</div>`).join('');
  qsa('.mi', box).forEach(el => el.onclick = () => {snapNow(); pg.board.groupBy = el.dataset.g; save(); renderPage();});
}

/* ==========================================================================
   ДАШБОРД
   ========================================================================== */
function renderDash(pg) {
  const ns = pageNodes(pg), g = G();
  const links = P.links.filter(l => ns.some(n => n.id === l.from) && ns.some(n => n.id === l.to));
  const blk = ns.reduce((a, n) => a + nBlockers(n), 0);
  const checks = ns.reduce((a, n) => a + (n.checks || []).length, 0);
  const ready = ns.filter(n => (g.par[n.id] || []).length === 0);
  const drafts = ns.filter(n => n.draft).length;
  const byStatus = P.schema.statuses.map(s => ({...s, n: ns.filter(x => x.status === s.key).length})).filter(x => x.n);
  const byCat = P.schema.categories.map(c => ({...c, n: ns.filter(x => x.cat === c.key).length})).filter(x => x.n).sort((a, b) => b.n - a.n);
  const top = ns.slice().sort((a, b) => g.W(b.id) - g.W(a.id)).slice(0, 12);
  const crit = ns.filter(n => g.crit.has(n.id)).sort((a, b) => stepOf(a) - stepOf(b));
  const blkList = [];
  ns.forEach(n => (n.checks || []).filter(c => c.b).forEach(c => blkList.push({n, c})));
  blkList.sort((a, b) => g.W(b.n.id) - g.W(a.n.id));
  const maxW = Math.max(1, ...top.map(n => g.W(n.id)));
  const bar = (label, n, max, color, id) => `<div class="barrow"><div class="lb" ${id ? `data-jump="${esc(id)}"` : ''}>${esc(label)}</div>
    <div class="bw"><i style="width:${Math.max(3, n / max * 100)}%;background:${color}"></i></div><div class="vv">${n}</div></div>`;
  let h = '';
  if (pg.dash && pg.dash.intro) h += `<div class="intro">${pg.dash.intro}</div>`;
  h += `<div class="tiles">
    <div class="tile"><div class="n">${ns.length}</div><div class="l">узлов</div></div>
    <div class="tile"><div class="n">${links.length}</div><div class="l">связей</div></div>
    <div class="tile"><div class="n" style="color:var(--red)">${blk}</div><div class="l">блокеров</div></div>
    <div class="tile"><div class="n">${checks}</div><div class="l">вех всего</div></div>
    <div class="tile"><div class="n" style="color:var(--amber)">${ready.length}</div><div class="l">без входящих — можно брать</div></div>
    <div class="tile"><div class="n">${crit.length}</div><div class="l">на критическом пути</div></div>
    ${drafts ? `<div class="tile"><div class="n" style="color:var(--amber)">${drafts}</div><div class="l">черновиков</div></div>` : ''}
  </div>`;
  h += `<div class="cards2">
    <div class="card"><h3>Топ по весу — что разблокирует больше всего</h3>${top.map(n => bar(n.name, g.W(n.id), maxW, catOf(n.cat).color, n.id)).join('')}</div>
    <div class="card"><h3>Статусы</h3>${byStatus.map(s => bar(s.name, s.n, Math.max(...byStatus.map(x => x.n)), s.color)).join('')}
      <h3 style="margin-top:16px">Категории</h3>${byCat.map(c => bar(c.name, c.n, Math.max(...byCat.map(x => x.n)), c.color)).join('')}</div>
  </div>`;
  h += `<div class="cards2">
    <div class="card"><h3>Критический путь (${crit.length})</h3>
      ${crit.map(n => `<div class="lrow"><span class="catdot" style="background:${catOf(n.cat).color}"></span>
        <span class="t" data-jump="${esc(n.id)}">${esc(n.name)}</span>${pillOf(n.status)}</div>`).join('') || '<div class="kv">—</div>'}</div>
    <div class="card"><h3>Можно брать сейчас (${ready.length})</h3>
      ${ready.sort((a, b) => g.W(b.id) - g.W(a.id)).slice(0, 14).map(n => `<div class="lrow"><span class="catdot" style="background:${catOf(n.cat).color}"></span>
        <span class="t" data-jump="${esc(n.id)}">${esc(n.name)}</span><b style="font-size:11.5px">${g.W(n.id)}</b>${pillOf(n.status)}</div>`).join('') || '<div class="kv">—</div>'}</div>
  </div>`;
  if (blkList.length) h += `<div class="card"><h3>Блокеры (${blkList.length})</h3>
    <table class="grid"><thead><tr><th>Блокер</th><th>Держит</th><th>Статус</th><th>Последствие</th></tr></thead><tbody>
    ${blkList.map(x => `<tr><td class="nm">${esc(x.c.t)}${x.c.z ? `<div style="font-weight:400;font-size:11.4px;color:var(--muted)">${esc(x.c.z)}</div>` : ''}</td>
      <td><span class="t" data-jump="${esc(x.n.id)}" style="cursor:pointer;color:var(--accent);font-weight:650">${esc(x.n.name)}</span></td>
      <td>${pillOf(x.c.s)}</td>
      <td style="font-size:11.8px;color:var(--ink2)">→ ${g.W(x.n.id)} узлов ниже</td></tr>`).join('')}
    </tbody></table></div>`;
  $('view').innerHTML = `<div class="scroller">${h}</div>`;
  qsa('[data-jump]').forEach(el => el.onclick = () => jumpToNode(el.dataset.jump));
}

/* ---------- фильтры критического пути на холсте ---------- */
// Здесь был monkey-patch поверх pageNodes: при включённом «Критическом пути»
// он ВЫБРАСЫВАЛ остальные узлы из списка. Человек нажимал «посмотреть критический
// путь» и видел, как с карты пропало 25 узлов из 32 — единственным следом было
// «6 из 32 узлов» серым в подзаголовке. Теперь это подсветка, см. applyHi(),
// а переопределение функции (техдолг №11 из ТЗ) больше не нужно.


/* ==========================================================================
   УПРАВЛЕНИЕ СТРАНИЦАМИ
   ========================================================================== */
function newPage() {
  modal(`<h3>Новая страница</h3>
    <div class="f"><label>Название</label><input type="text" id="npn" value="Новая страница"></div>
    <div class="f"><label>Тип</label>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:4px">
      ${Object.keys(KIND).map((k, i) => `<label class="pk" style="border:1px solid var(--line);border-radius:9px;padding:9px 11px">
        <input type="radio" name="npk" value="${k}" ${i === 0 ? 'checked' : ''}>
        <span><b>${KIND[k].i} ${KIND[k].n}</b><br><small style="color:var(--muted)">${
          KIND[k].d}</small></span></label>`).join('')}
      </div></div>
    <div class="f"><label>Копировать фильтр с текущей страницы</label>
      <label class="cbx"><input type="checkbox" id="npf">да</label></div>
    <div class="mfoot"><button class="btn" data-a="c">Отмена</button><button class="btn pri" data-a="ok">Создать</button></div>`, b => {
    b.querySelector('[data-a=c]').onclick = closeModal;
    b.querySelector('[data-a=ok]').onclick = () => {
      const kind = qs('input[name=npk]:checked').value;
      snapNow();
      const pg = {id: uid('p'), name: $('npn').value.trim() || KIND[kind].n, kind,
        filter: $('npf').checked ? clone(curPage().filter) : {q: '', cats: [], statuses: [], types: [], f: {}}};
      if (kind === 'canvas') pg.canvas = {layout: 'free', lanes: ['блокировки', 'этап 1', 'этап 2', 'этап 3', 'этап 4', 'этап 5']};
      if (kind === 'space') pg.space = {};
      if (kind === 'jam') pg.jam = {items: [], bg: 'dots'};
      if (kind === 'table') pg.table = {cols: ['name', 'cat', 'status', 'step', 'weight', 'checks'], sort: 'name', dir: 1, group: ''};
      if (kind === 'board') pg.board = {groupBy: 'status'};
      P.pages.push(pg); seedFreePositions(pg); save(); closeModal(); gotoPage(pg.id);
    };
  });
}
$('addPage').onclick = newPage;
// Копия страницы. Дословный clone() здесь неверен по двум причинам, и обе тихие:
// позиции узлов лежат снаружи страницы (в n.p[старыйId]) и не копируются, из-за чего
// копия холста приходит пустой; а объекты доски лежат ВНУТРИ и копируются вместе
// со своими id — два набора с одинаковыми идентификаторами, и коннекторы копии
// указывают в оригинал.
function duplicatePage(pg) {
  const c = clone(pg);
  c.id = uid('p');
  c.name = pg.name + ' (копия)';
  // раскладка узлов переезжает на новый ключ страницы
  for (const n of P.nodes) {
    const slot = n.p && n.p[pg.id];
    if (slot) {n.p[c.id] = clone(slot);}
  }
  // объекты доски получают новые id, ссылки коннекторов переписываются на них
  if (c.jam && Array.isArray(c.jam.items)) {
    const map = {};
    for (const it of c.jam.items) {const nid = uid('i'); map[it.id] = nid; it.id = nid;}
    for (const it of c.jam.items) {
      if (it.kind !== 'conn') continue;
      for (const end of ['a', 'b']) {
        const e2 = it[end];
        if (e2 && e2.item && map[e2.item]) e2.item = map[e2.item];
      }
    }
  }
  return c;
}
function pageMenu(e, id) {
  e.stopPropagation();
  const pg = pageById(id);
  const i = P.pages.findIndex(x => x.id === id);
  // Порядок страниц меняется и мышью (перетаскиванием), и отсюда. Только
  // перетаскивание значило бы, что с телефона и с клавиатуры порядок не поменять.
  const swap = d => {
    const j = i + d; if (j < 0 || j >= P.pages.length) return;
    snapNow();
    const t = P.pages[i]; P.pages[i] = P.pages[j]; P.pages[j] = t;
    save(); renderPages();
  };
  showCtx(e.clientX, e.clientY, [
    ['Переименовать', () => promptBox('Страница', 'Название', pg.name, v => {snapNow(); pg.name = v; save(); renderPages(); renderPage();})],
    ['Дублировать', () => {snapNow(); const c = duplicatePage(pg); P.pages.push(c); save(); gotoPage(c.id);}],
    ['—'],
    ...(i > 0 ? [['Переместить выше', () => swap(-1)]] : []),
    ...(i < P.pages.length - 1 ? [['Переместить ниже', () => swap(1)]] : []),
    ['—'],
    ['Удалить', () => {
      if (P.pages.length < 2) {toast('Последнюю страницу удалить нельзя'); return;}
      confirmBox(`Удалить страницу «${pg.name}»? Узлы останутся — удалится только вид.`, () => {
        snapNow();
        P.pages = P.pages.filter(x => x.id !== id);
        // Позиции и размеры узлов живут в n.p[pageId] — без этой уборки они остаются
        // в документе навсегда и уезжают в каждый экспорт. Серверный deletePage
        // так делает давно, приложение — нет.
        for (const n of P.nodes) if (n.p) delete n.p[id];
        save();
        if (UI.page === id) gotoPage(P.pages[0].id); else renderPages();
      }, 'Удалить');
    }, null, null, 1]
  ]);
}

/* ==========================================================================
   СХЕМА ПРОЕКТА
   ========================================================================== */
function showSchema(tab) {
  const S = P.schema;
  const secs = {
    types: ['Типы узлов', () => S.nodeTypes.map((t, i) => `<div class="crow" data-i="${i}" data-s="nodeTypes">
      <div class="h"><input type="text" data-k="name" value="${esc(t.name)}" style="flex:1">
        <select data-k="shape" style="width:130px">${opts([['rect', 'прямоугольник'], ['pill', 'скруглённый'], ['diamond', 'акцентный']], t.shape)}</select>
        <button class="ib dgr" data-del>×</button></div>
      <div class="hint">ключ <code>${esc(t.key)}</code> · узлов: ${P.nodes.filter(n => n.type === t.key).length}</div></div>`).join(''), 'nodeTypes'],
    statuses: ['Статусы', () => S.statuses.map((t, i) => `<div class="crow" data-i="${i}" data-s="statuses">
      <div class="h"><input type="color" class="swatch" data-k="color" value="${esc(t.color)}">
        <input type="text" data-k="name" value="${esc(t.name)}" style="flex:1"><button class="ib dgr" data-del>×</button></div>
      <div class="hint">ключ <code>${esc(t.key)}</code> · узлов: ${P.nodes.filter(n => n.status === t.key).length}</div></div>`).join(''), 'statuses'],
    cats: ['Категории', () => S.categories.map((t, i) => `<div class="crow" data-i="${i}" data-s="categories">
      <div class="h"><input type="color" class="swatch" data-k="color" value="${esc(t.color)}">
        <input type="text" data-k="name" value="${esc(t.name)}" style="flex:1"><button class="ib dgr" data-del>×</button></div>
      <div class="hint">ключ <code>${esc(t.key)}</code> · узлов: ${P.nodes.filter(n => n.cat === t.key).length}</div></div>`).join(''), 'categories'],
    links: ['Типы связей', () => S.linkTypes.map((t, i) => `<div class="crow" data-i="${i}" data-s="linkTypes">
      <div class="h"><input type="color" class="swatch" data-k="color" value="${esc(t.color)}">
        <input type="text" data-k="name" value="${esc(t.name)}" style="flex:1">
        <select data-k="style" style="width:110px">${opts([['solid', 'сплошная'], ['dashed', 'пунктир'], ['dotted', 'точки']], t.style)}</select>
        <button class="ib dgr" data-del>×</button></div>
      <label class="cbx" style="margin-top:5px"><input type="checkbox" data-k="blocking" ${t.blocking ? 'checked' : ''}>жёсткая: влияет на слои и вес</label>
      <div class="hint">связей: ${P.links.filter(l => l.type === t.key).length}</div></div>`).join(''), 'linkTypes'],
    fields: ['Свои поля', () => S.fields.map((t, i) => `<div class="crow" data-i="${i}" data-s="fields">
      <div class="h"><input type="text" data-k="label" value="${esc(t.label)}" style="flex:1">
        <select data-k="type" style="width:130px">${opts([['text', 'текст'], ['longtext', 'многострочный'], ['select', 'список значений'], ['number', 'число'], ['date', 'дата'], ['checkbox', 'галочка'], ['list', 'список строк']], t.type)}</select>
        <button class="ib dgr" data-del>×</button></div>
      ${t.type === 'select' ? `<input type="text" data-k="options" value="${esc((t.options || []).join('; '))}" placeholder="значения через ;" style="margin-top:5px">` : ''}
      <label class="cbx" style="margin-top:5px"><input type="checkbox" data-k="card" ${t.card ? 'checked' : ''}>показывать на карточке узла</label>
      <div class="hint">ключ <code>${esc(t.key)}</code></div></div>`).join(''), 'fields']
  };
  const cur = tab || 'statuses';
  const body = () => `<div style="display:flex;gap:4px;margin-bottom:12px;flex-wrap:wrap">
      ${Object.keys(secs).map(k => `<button class="btn${k === (window._schTab || cur) ? ' act' : ''}" data-tab="${k}">${secs[k][0]}</button>`).join('')}</div>
    <div id="schBody">${secs[window._schTab || cur][1]()}</div>
    <button class="btn" id="schAdd">＋ Добавить</button>`;
  window._schTab = tab || window._schTab || cur;
  modal(`<h3>Схема проекта</h3><div class="kv" style="margin-bottom:10px">Что можно описывать в этом проекте: типы узлов, статусы, категории, типы связей и свои поля.</div>
    <div id="schWrap">${body()}</div>
    <div class="mfoot"><button class="btn pri" data-a="c">Готово</button></div>`, b => {
    const rewire = () => {
      $('schWrap').innerHTML = body();
      qsa('[data-tab]', b).forEach(el => el.onclick = () => {window._schTab = el.dataset.tab; rewire();});
      qsa('.crow', b).forEach(row => {
        const arr = P.schema[row.dataset.s], i = +row.dataset.i, it = arr[i];
        qsa('[data-k]', row).forEach(el => {
          const k = el.dataset.k;
          const rd = () => el.type === 'checkbox' ? (el.checked ? 1 : 0) : el.value;
          const set = () => {
            snapshot();
            if (k === 'options') it.options = el.value.split(';').map(s => s.trim()).filter(Boolean);
            else it[k] = rd();
            gInval(); save(); renderPage();
          };
          if (el.tagName === 'SELECT' || el.type === 'checkbox') el.onchange = () => {set(); rewire();};
          else el.oninput = set;
        });
        row.querySelector('[data-del]').onclick = () => {
          const s = row.dataset.s;
          const used = s === 'nodeTypes' ? P.nodes.filter(n => n.type === it.key).length
            : s === 'statuses' ? P.nodes.filter(n => n.status === it.key).length
            : s === 'categories' ? P.nodes.filter(n => n.cat === it.key).length
            : s === 'linkTypes' ? P.links.filter(l => l.type === it.key).length
            : P.nodes.filter(n => (n.f || {})[it.key] != null).length;
          const go = () => {snapNow(); arr.splice(i, 1); gInval(); save(); rewire(); renderPage();};
          if (used) confirmBox(`Используется в ${used} местах. Всё равно удалить? Значения останутся, но потеряют оформление.`, go, 'Удалить');
          else go();
        };
      });
      $('schAdd').onclick = () => {
        snapNow();
        const t = window._schTab;
        const key = uid(t.slice(0, 2));
        if (t === 'types') P.schema.nodeTypes.push({key, name: 'Новый тип', shape: 'rect'});
        if (t === 'statuses') P.schema.statuses.push({key, name: 'Новый статус', color: '#6b7280'});
        if (t === 'cats') P.schema.categories.push({key, name: 'Новая категория', color: '#3355d1'});
        if (t === 'links') P.schema.linkTypes.push({key, name: 'Новый тип связи', color: '#9aa1b2', style: 'solid', blocking: 0});
        if (t === 'fields') P.schema.fields.push({key, label: 'Новое поле', type: 'text', options: [], card: 0});
        save(); rewire(); renderPage();
      };
    };
    rewire();
    b.querySelector('[data-a=c]').onclick = () => {closeModal(); renderPage();};
  });
}
$('navSchema').onclick = () => showSchema();

/* ==========================================================================
   ЭКСПОРТ / ИМПОРТ
   ========================================================================== */
const fname = (ext) => (P.name || 'project').replace(/[^\wа-яА-ЯёЁ\- ]/g, '').trim().replace(/\s+/g, '_') + '_' + today() + '.' + ext;
function exportProject() {dl(fname('json'), JSON.stringify(P, null, 1), 'application/json'); UI.dirty = false; toast('Проект сохранён в файл');}
const csvCell = v => {v = v == null ? '' : String(v); return /[";\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;};
const toCsv = rows => '﻿' + rows.map(r => r.map(csvCell).join(';')).join('\r\n');
function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const l0 = text.split('\n')[0];
  const sep = l0.split(';').length >= l0.split(',').length ? ';' : ',';
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {if (c === '"') {if (text[i + 1] === '"') {cur += '"'; i++;} else q = false;} else cur += c;}
    else if (c === '"') q = true;
    else if (c === sep) {row.push(cur); cur = '';}
    else if (c === '\n') {row.push(cur); rows.push(row); row = []; cur = '';}
    else if (c !== '\r') cur += c;
  }
  if (cur !== '' || row.length) {row.push(cur); rows.push(row);}
  return rows.filter(r => r.some(x => x !== ''));
}
function csvNodes() {
  const g = G();
  const fk = P.schema.fields.map(f => f.key);
  const rows = [['id', 'name', 'sub', 'type', 'status', 'category', 'step', 'weight', 'checks', 'blockers', 'deps', 'draft', 'body', ...fk]];
  P.nodes.forEach(n => rows.push([n.id, n.name, n.sub, typeOf(n.type).name, statusOf(n.status).name, catOf(n.cat).name,
    stepOf(n), g.W(n.id), (n.checks || []).length, nBlockers(n),
    P.links.filter(l => l.to === n.id).map(l => l.from).join(' '), n.draft ? 1 : 0, n.body,
    ...fk.map(k => {const v = (n.f || {})[k]; return Array.isArray(v) ? v.join(' | ') : (v == null ? '' : v);})]));
  dl(fname('nodes.csv'), toCsv(rows), 'text/csv');
}
function csvChecks() {
  const g = G();
  const rows = [['node_id', 'node', 'category', 'node_status', 'step', 'check', 'check_status', 'is_blocker', 'comment', 'weight']];
  P.nodes.forEach(n => (n.checks || []).forEach(c => rows.push([n.id, n.name, catOf(n.cat).name, statusOf(n.status).name, stepOf(n),
    c.t, statusOf(c.s).name, c.b ? 1 : 0, c.z, g.W(n.id)])));
  dl(fname('checks.csv'), toCsv(rows), 'text/csv');
}
function csvLinks() {
  const rows = [['from_id', 'from', 'link_type', 'blocking', 'to_id', 'to', 'cross_category', 'label']];
  P.links.forEach(l => {
    const a = nodeById(l.from), b = nodeById(l.to); if (!a || !b) return;
    rows.push([a.id, a.name, ltOf(l.type).name, ltOf(l.type).blocking ? 1 : 0, b.id, b.name, a.cat !== b.cat ? 1 : 0, l.label || '']);
  });
  dl(fname('links.csv'), toCsv(rows), 'text/csv');
}
function exportMd() {
  const g = G();
  let o = `# ${P.name}\n\n> Graph Studio · ${today()} · ${P.nodes.length} узлов, ${P.links.length} связей\n\n${P.desc || ''}\n`;
  const steps = uniq(P.nodes.map(stepOf)).sort((a, b) => a - b);
  steps.forEach(s => {
    o += `\n## Шаг ${s}\n\n`;
    P.nodes.filter(n => stepOf(n) === s).sort((a, b) => g.W(b.id) - g.W(a.id)).forEach(n => {
      o += `### ${n.name}${n.type !== P.schema.nodeTypes[0].key ? ' `' + typeOf(n.type).name + '`' : ''}\n\n`;
      o += `- **Статус:** ${statusOf(n.status).name} · **Категория:** ${catOf(n.cat).name} · **Разблокирует:** ${g.W(n.id)}\n`;
      if (n.sub) o += `- **Кратко:** ${n.sub}\n`;
      P.schema.fields.forEach(f => {
        const v = (n.f || {})[f.key]; if (v == null || v === '' || (Array.isArray(v) && !v.length)) return;
        o += `- **${f.label}:** ${Array.isArray(v) ? v.join('; ') : v}\n`;
      });
      const ups = (g.par[n.id] || []).map(p => nodeById(p.id).name);
      if (ups.length) o += `- **Держит:** ${ups.join('; ')}\n`;
      if (n.body) o += `\n${n.body}\n`;
      if ((n.checks || []).length) o += `\n| | Веха | Статус | Комментарий |\n|---|---|---|---|\n` +
        n.checks.map(c => `| ${c.b ? '⚠' : ''} | ${c.t} | ${statusOf(c.s).name} | ${(c.z || '').replace(/\|/g, '\\|')} |`).join('\n') + '\n';
      o += '\n';
    });
  });
  dl(fname('md'), o, 'text/markdown');
}
async function exportViewer() {
  let tpl;
  try {
    const r = await fetch(new URL('viewer-template.html', location.href));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    tpl = await r.text();
  } catch (e) {
    // в режиме разработки (vite dev) шаблона нет — он появляется только после сборки
    toast('Просмотрщик собирается только в собранной версии: ' + e.message);
    return;
  }
  const marker = '<script id="seed" type="application/json">';
  const i = tpl.indexOf(marker), j = tpl.indexOf('<' + '/script>', i);
  if (i < 0 || j < 0) {toast('Не найден блок данных'); return;}
  let out = tpl.slice(0, i + marker.length) + JSON.stringify(P) + tpl.slice(j);
  out = out.replace('window.VIEWER=false;', 'window.VIEWER=true;');
  dl(fname('viewer.html'), out, 'text/html');
  toast('viewer.html собран — только просмотр');
}
/* ---------- экспорт холста в SVG / PNG ---------- */
const svgEsc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;'}[c]));
function wrapLines(s, maxChars, maxLines) {
  const words = String(s || '').trim().split(/\s+/).filter(Boolean);
  const lines = []; let cur = '';
  for (let i = 0; i < words.length; i++) {
    const w = words[i], cand = cur ? cur + ' ' + w : w;
    if (cand.length <= maxChars || !cur) cur = cand;
    else {lines.push(cur); cur = w;}
    if (lines.length >= maxLines) {cur = words.slice(i).join(' '); break;}
  }
  if (lines.length < maxLines && cur) {lines.push(cur); cur = '';}
  if (cur && lines.length) {
    let last = lines[lines.length - 1];
    if (last.length > maxChars - 1) last = last.slice(0, Math.max(1, maxChars - 1));
    lines[lines.length - 1] = last + '…';
  }
  return lines;
}
const SF = 'font-family="-apple-system,Segoe UI,Roboto,sans-serif"';
function buildCanvasSVG() {
  const pg = curPage();
  if (!isGraphCv(pg)) {toast('Экспорт карты доступен только на холсте или схеме'); return null;}
  if (!cvNodes || !cvNodes.length) {toast('Нет узлов для экспорта'); return null;}
  const PAD = 64;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const ext = (x, y, w, h) => {if (x < minX) minX = x; if (y < minY) minY = y; if (x + w > maxX) maxX = x + w; if (y + h > maxY) maxY = y + h;};
  cvNodes.forEach(n => {const p = cvPos[n.id]; if (p) {const sz = nsize(n, pg.id); ext(p.x, p.y, sz.w, sz.h);}});
  (P.frames || []).forEach(f => ext(f.x, f.y, f.w, f.h));
  (P.notes || []).forEach(t => ext(t.x, t.y, t.w || 190, t.h || 90));
  // pg.canvas на схеме отсутствует: колонки-этапы — принадлежность холста зависимостей
  const auto = (pg.canvas || {}).layout === 'auto' && laneInfo && laneInfo.length;
  minX -= PAD; minY -= PAD; maxX += PAD; maxY += PAD;
  const W = Math.max(1, Math.round(maxX - minX)), H = Math.max(1, Math.round(maxY - minY));
  const off = (x, y) => [Math.round((x - minX) * 10) / 10, Math.round((y - minY) * 10) / 10];
  let body = `<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>`;
  if (auto) laneInfo.forEach((l, i) => {
    if (i > 0) {const [lx] = off(l.x - COLGAP / 2, 0); body += `<line x1="${lx}" y1="0" x2="${lx}" y2="${H}" stroke="#dfe3ec" stroke-width="1" stroke-dasharray="4,5"/>`;}
    const [cx, cy] = off(l.x, 26);
    const cap = ((pg.canvas || {}).lanes || [])[l.idx] || (l.idx === 0 ? 'блокировки' : 'этап ' + l.idx);
    body += `<text x="${cx}" y="${cy}" ${SF} font-size="10.5" font-weight="700" letter-spacing="0.5" fill="#aeb4c3">${svgEsc(cap.toUpperCase())}</text>`;
  });
  (P.frames || []).forEach(f => {
    const [fx, fy] = off(f.x, f.y);
    const dash = f.kind === 'lane' ? ' stroke-dasharray="6,5"' : '';
    body += `<rect x="${fx}" y="${fy}" width="${f.w}" height="${f.h}" rx="12" fill="none" stroke="${f.color || '#d7dbe6'}" stroke-width="1.5"${dash}/>`;
    if (f.name) body += `<text x="${fx + 4}" y="${fy - 7}" ${SF} font-size="11" font-weight="700" fill="${f.color || '#767d8f'}">${svgEsc(f.name)}</text>`;
  });
  (P.notes || []).forEach(t => {
    const [tx, ty] = off(t.x, t.y), w = t.w || 190, h = t.h || 90;
    body += `<rect x="${tx}" y="${ty}" width="${w}" height="${h}" rx="8" fill="${t.color || '#fff8c8'}" stroke="#eadf9a" stroke-width="1"/>`;
    wrapLines(t.text, Math.floor((w - 16) / 6.2), Math.max(1, Math.floor((h - 14) / 15))).forEach((ln, i) =>
      body += `<text x="${tx + 9}" y="${ty + 18 + i * 15}" ${SF} font-size="12" fill="#3a3a2a">${svgEsc(ln)}</text>`);
  });
  const mk = {}; P.schema.linkTypes.forEach(t => mk[t.key] = 'xmk' + t.key.replace(/\W/g, ''));
  const defs = P.schema.linkTypes.map(t =>
    `<marker id="${mk[t.key]}" markerWidth="7" markerHeight="7" refX="6.5" refY="2.5" orient="auto"><path d="M0,0 L6.5,2.5 L0,5 z" fill="${t.color}"/></marker>`).join('');
  const vis = new Set(cvNodes.map(n => n.id));
  let edges = '';
  P.links.forEach(l => {
    if (!vis.has(l.from) || !vis.has(l.to)) return;
    const a = cvPos[l.from], b = cvPos[l.to]; if (!a || !b) return;
    const na = nodeById(l.from), nb = nodeById(l.to), t = ltOf(l.type);
    const [ax, ay] = off(a.x, a.y), [bx, by] = off(b.x, b.y);
    const sa2 = nsize(na, pg.id), sb2 = nsize(nb, pg.id);
    const d = edgeFor(pg)({x: ax, y: ay}, {x: bx, y: by}, sa2.w, sa2.h, sb2.w, sb2.h);
    const dash = t.style === 'dashed' ? ' stroke-dasharray="6,5"' : t.style === 'dotted' ? ' stroke-dasharray="2,4"' : '';
    edges += `<path d="${d}" fill="none" stroke="${t.color}" stroke-width="1.6"${dash} marker-end="url(#${mk[l.type] || mk[P.schema.linkTypes[0].key]})"/>`;
    if (l.label) {const m = midOf(d); edges += `<text x="${m.x}" y="${m.y - 5}" text-anchor="middle" font-size="10" font-weight="600" fill="${t.color}">${svgEsc(l.label)}</text>`;}
  });
  const g = G();
  let nds = '';
  cvNodes.forEach(n => {
    const p = cvPos[n.id]; if (!p) return;
    const [x, y] = off(p.x, p.y), {w, h} = nsize(n, pg.id);
    const ty = typeOf(n.type), st = statusOf(n.status);
    let bg = '#ffffff', br = '#e4e7ef', rx = 10;
    if (ty.shape === 'pill') {bg = '#fffdf6'; br = '#ecd8a0'; rx = Math.min(22, h / 2);}
    else if (ty.shape === 'diamond') {bg = '#f7f4ff'; br = '#ded3f6';}
    nds += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${bg}" stroke="${br}" stroke-width="1"/>`;
    nds += `<rect x="${x}" y="${y}" width="4" height="${h}" rx="2" fill="${catOf(n.cat).color}"/>`;
    nds += `<circle cx="${x + 16}" cy="${y + 15}" r="3.5" fill="${st.color}"/>`;
    const titleLines = wrapLines(n.name, Math.floor((w - 58) / 6.4), 2);
    titleLines.forEach((ln, i) => nds += `<text x="${x + 25}" y="${y + 19 + i * 15}" ${SF} font-size="12.4" font-weight="700" fill="#15181f">${svgEsc(ln)}</text>`);
    const subY = y + 19 + titleLines.length * 15 + 2;
    if (n.sub) wrapLines(n.sub, Math.floor((w - 24) / 5.6), 2).forEach((ln, i) =>
      nds += `<text x="${x + 13}" y="${subY + i * 13}" ${SF} font-size="10.5" fill="#8b91a1">${svgEsc(ln)}</text>`);
    const wt = g.W(n.id), blk = nBlockers(n);
    let bx = x + w - 8;
    if (wt >= 3) {const s = String(wt), bw = 12 + s.length * 7; bx -= bw;
      nds += `<rect x="${bx}" y="${y + 7}" width="${bw}" height="15" rx="7" fill="#eef1fc" stroke="#d3dcf7"/><text x="${bx + bw / 2}" y="${y + 17.6}" text-anchor="middle" font-size="9.4" font-weight="800" fill="#3355d1">${s}</text>`;
      bx -= 4;
    }
    if (blk) {const s = String(blk), bw = 20 + s.length * 7; bx -= bw;
      nds += `<rect x="${bx}" y="${y + 7}" width="${bw}" height="15" rx="7" fill="#fdecea" stroke="#f0c7c2"/><text x="${bx + bw / 2}" y="${y + 17.6}" text-anchor="middle" font-size="9" font-weight="800" fill="#b3261e">!${s}</text>`;
    }
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs>${defs}</defs>${body}${edges}${nds}</svg>`;
  return {svg, w: W, h: H};
}
function exportCanvasSVG() {
  const r = buildCanvasSVG(); if (!r) return;
  dl(fname('svg'), r.svg, 'image/svg+xml');
  toast('SVG экспортирован');
}
function exportCanvasPNG() {
  const r = buildCanvasSVG(); if (!r) return;
  const scale = 2, img = new Image();
  const url = URL.createObjectURL(new Blob([r.svg], {type: 'image/svg+xml;charset=utf-8'}));
  img.onload = () => {
    const cvs = document.createElement('canvas');
    cvs.width = r.w * scale; cvs.height = r.h * scale;
    const ctx = cvs.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, cvs.width, cvs.height);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    cvs.toBlob(b => {
      if (!b) {toast('Ошибка PNG'); return;}
      const u = URL.createObjectURL(b), a = document.createElement('a');
      a.href = u; a.download = fname('png'); document.body.appendChild(a); a.click();
      setTimeout(() => {URL.revokeObjectURL(u); a.remove();}, 500);
      toast('PNG экспортирован (2×)');
    }, 'image/png');
  };
  img.onerror = () => {URL.revokeObjectURL(url); toast('Не удалось отрисовать PNG');};
  img.src = url;
}
function showExport() {
  const cap = t => `<div class="cap" style="font-size:11px;font-weight:800;text-transform:uppercase;` +
    `letter-spacing:.6px;color:var(--muted);margin-top:18px">${t}</div>`;
  const row = 'display:flex;gap:8px;flex-wrap:wrap;margin-top:7px';
  const online = !!cloud.CLOUD.account;
  modal(`<h3>Экспорт и импорт</h3>
    <div class="kv" style="margin-bottom:6px">Доска «${esc(P.name)}» · ${P.nodes.length} узлов, ${P.links.length} связей.</div>
    ${cap('Выгрузить эту доску')}
    <div style="${row}">
      <button class="btn pri" data-x="json">JSON доски</button>
      <button class="btn" data-x="viewer">viewer.html</button>
      <button class="btn" data-x="md">Markdown</button>
      <button class="btn" data-x="csvn">CSV: узлы</button>
      <button class="btn" data-x="csvc">CSV: вехи</button>
      <button class="btn" data-x="csvl">CSV: связи</button>
    </div>
    ${cap('Картинка холста')}
    <div style="${row}">
      <button class="btn" data-x="png">PNG (2×)</button>
      <button class="btn" data-x="svg">SVG</button>
      <span class="hint" style="align-self:center">${isGraphCv(curPage()) ? 'экспорт текущего холста' : 'откройте холст или схему'}</span>
    </div>
    ${VIEWER ? '' : `${cap('Загрузить файл')}
    <div style="${row}">
      <button class="btn" data-x="imp">JSON новой доской</button>
      <button class="btn" data-x="merge">JSON слить в текущую</button>
      <button class="btn" data-x="csvimp">CSV узлов в текущую</button>
    </div>
    <div class="hint" style="margin-top:9px">
      ${online
        ? 'Загруженная доска сразу оказывается на сервере — файл остаётся у вас копией, а не вторым хранилищем.'
        : 'Сейчас нет входа: доска ляжет только в этот браузер. После входа её можно будет перенести на сервер.'}
      Импорт понимает и формат Graph Studio, и старый файл Roadmap Studio (nodes/deps/soft).
    </div>

    ${cap('Все доски')}
    <div style="${row}">
      <button class="btn" data-x="all">Скачать все доски</button>
      <button class="btn" data-x="restore">Восстановить из бэкапа</button>
    </div>
    <div class="hint" style="margin-top:9px">Один файл со всеми вашими досками — чтобы копия жила и вне сервера.</div>

    ${cap(cloud.boundToServer() ? 'История и проверка' : 'Версии и проверка')}
    <div style="${row}">
      ${cloud.boundToServer()
        ? '<button class="btn" data-x="hist">История изменений…</button>'
        : '<button class="btn" data-x="snapnew">Создать снимок</button>' +
          '<button class="btn" data-x="snaps">Снимки версий…</button>'}
      <button class="btn" data-x="check">Проверить доску</button>
    </div>`}
    <div class="mfoot"><button class="btn" data-a="c">Закрыть</button></div>`, b => {
    b.querySelector('[data-a=c]').onclick = closeModal;
    qsa('[data-x]', b).forEach(el => el.onclick = () => {
      const a = el.dataset.x;
      if (a === 'json') exportProject(); if (a === 'viewer') exportViewer(); if (a === 'md') exportMd();
      if (a === 'csvn') csvNodes(); if (a === 'csvc') csvChecks(); if (a === 'csvl') csvLinks();
      if (a === 'png') {closeModal(); exportCanvasPNG();} if (a === 'svg') {closeModal(); exportCanvasSVG();}
      if (a === 'all') backupAll();
      if (a === 'restore') {closeModal(); importJson('new');}
      if (a === 'snapnew') promptBox('Новый снимок', 'Название', 'Снимок ' + nowStr(), makeSnap);
      if (a === 'snaps') {closeModal(); showSnaps();}
      if (a === 'hist') {closeModal(); showHistory();}
      if (a === 'check') {closeModal(); showValidator();}
      if (a === 'imp') {closeModal(); importJson('new');}
      if (a === 'merge') {closeModal(); importJson('merge');}
      if (a === 'csvimp') {closeModal(); importCsv();}
    });
  });
}
$('navExport').onclick = showExport;
// История — не про файлы, и её место не внутри «Экспорта и импорта». Отдельный пункт
// рядом со «Схемой проекта»: искать «кто это поменял» идут в панель, а не в диалог
// про JSON и CSV.
if ($('navHistory')) $('navHistory').onclick = () => showHistory();
async function backupAll() {
  // Копия ВСЕГО, что у человека есть, одним файлом.
  //
  // Раньше бэкап брал только IndexedDB. С момента, когда доски переехали на сервер,
  // такой файл молча не содержал бы главного — самих досок. Теперь берём их с сервера
  // (свои, не чужие: бэкап — это копия своего, а не выгрузка всего, что видно),
  // а локальные проекты прежней версии добавляем к ним.
  toast('Собираю копию…');
  const projects = [];
  let failed = 0;
  if (cloud.CLOUD.account) {
    try {
      const list = await api.boards();
      for (const b of (list.mine || [])) {
        try { projects.push(Object.assign(normalize((await api.boardGet(b.id)).doc), {id: 'srv_' + b.id})); }
        catch { failed++; }
      }
    } catch (e) { toast('Не удалось получить список досок: ' + (e.message || e)); return; }
  }
  // Кэш открытых серверных досок (srv_<id>) в копию не идёт: сами доски уже взяты
  // с сервера выше, и второй раз они попали бы туда устаревшей версией.
  for (const pr of await dbAll(STORE)) if (!isCache(pr.id)) projects.push(pr);
  const snaps = (await dbAll(SNAP).catch(() => [])) || [];
  dl('graphstudio_backup_' + today() + '.json',
     JSON.stringify({graphstudio: 2, exported: nowStr(), projects, snaps}), 'application/json');
  await dbPut(META, {k: 'lastBackup', v: Date.now()}).catch(() => {});
  const live = projects.filter(p => !p.deleted).length, trash = projects.length - live;
  toast(`Копия: досок ${live}${trash ? ', в корзине ' + trash : ''}${failed ? ', не прочиталось ' + failed : ''}`);
}

/* ==========================================================================
   ИСТОРИЯ ИЗМЕНЕНИЙ СЕРВЕРНОЙ ДОСКИ
   --------------------------------------------------------------------------
   Список «изменено 09:41» не отвечает ни на один вопрос, ради которого в историю
   заходят: что поменялось, кто это сделал и как вернуть. Поэтому у каждой версии
   есть автор, короткая подпись и обе кнопки — посмотреть и вернуть.

   Возврат не стирает историю: старая версия остаётся, поверх ложится новая.
   Иначе «вернуть» само стало бы необратимым действием.
   ========================================================================== */
async function showHistory(msg) {
  const b = cloud.CLOUD.board;
  if (!b) { showSnaps(); return; }          // локальный проект — свои снимки
  let data = null;
  try { data = await api.versions(b.id); }
  catch (e) { toast('Не удалось получить историю: ' + (e.message || e)); return; }

  const when = t => {
    const d = new Date(t), today0 = new Date(); today0.setHours(0, 0, 0, 0);
    return (t >= today0.getTime() ? 'сегодня ' : d.toLocaleDateString('ru-RU') + ' ')
      + d.toLocaleTimeString('ru-RU').slice(0, 5);
  };
  const rows = data.versions.map(v => `<div class="lrw" style="align-items:center;gap:10px">
    <span class="chip" style="cursor:default;min-width:52px;justify-content:center">v${v.version}</span>
    <div style="flex:1;min-width:0">
      <div style="font-size:13px">${esc(v.summary || 'правки')}${
        v.version === data.current ? ' <span style="color:var(--green);font-weight:700">· сейчас</span>' : ''}</div>
      <div class="hint">${esc(when(v.at))} · ${esc(v.actor_name || v.actor_email || 'кто-то')} · ${
        nOf(v.nodes, NODES)}</div>
    </div>
    <button class="btn sm" data-see="${v.version}">Посмотреть</button>
    ${v.version === data.current || ro() ? '' : `<button class="btn sm" data-back="${v.version}">Вернуть</button>`}
  </div>`).join('');

  modal(`<h3>История изменений</h3>
    <div class="kv" style="font-size:12.5px">«${esc(P.name)}» · сейчас версия ${data.current}</div>
    ${msg ? `<div class="kv" style="color:var(--green);font-size:12.5px">${esc(msg)}</div>` : ''}
    ${rows || '<div class="hint">История пока пустая — она пишется с каждым сохранением.</div>'}
    <div class="hint" style="margin-top:10px">Правки за последнюю неделю хранятся все.
      Дальше история прореживается — по одной версии в час, затем в день, затем в неделю;
      самая первая версия остаётся всегда. Возврат историю не стирает: прежняя версия
      остаётся на месте.</div>
    <div class="mfoot"><button class="btn" data-a="c">Закрыть</button></div>`, box => {
    box.querySelector('[data-a=c]').onclick = closeModal;
    qsa('[data-see]', box).forEach(el => el.onclick = () => viewVersion(+el.dataset.see));
    qsa('[data-back]', box).forEach(el => el.onclick = () => {
      const v = +el.dataset.back;
      confirmBox(`Вернуть версию ${v}? Текущая версия останется в истории — вернуться обратно можно так же.`,
        () => restoreVersion(v), 'Вернуть');
    });
  });
}

// Просмотр старой версии прямо на холсте: по списку строк понять, та ли это версия,
// нельзя — надо увидеть саму карту. Доска на это время только читается.
async function viewVersion(v) {
  const b = cloud.CLOUD.board; if (!b) return;
  try {
    const r = await api.version(b.id, v);
    closeModal();
    UI.viewVersion = v;
    P = normalize(r.doc); gInval();
    UI.sel.clear(); UI.selNotes.clear(); UI.selFrames.clear(); closeInsp();
    if (!P.pages.some(p => p.id === UI.page)) UI.page = (P.pages[0] || {}).id;
    setReadonly(true);
    renderPages(); renderPage(); paintSave();
    paintVersionBar();
  } catch (e) { toast('Не удалось открыть версию: ' + (e.message || e)); }
}

// Полоса поверх холста: без неё человек смотрит на старую доску и не понимает,
// почему ничего не сохраняется.
function paintVersionBar() {
  const old = $('verbar'); if (old) old.remove();
  if (!UI.viewVersion) return;
  const el = document.createElement('div');
  el.id = 'verbar';
  el.innerHTML = `<span>Версия ${UI.viewVersion} — только просмотр</span>
    <button class="btn sm" data-a="back">Вернуть эту версию</button>
    <button class="btn sm" data-a="now">К текущей</button>`;
  document.getElementById('main').appendChild(el);
  el.querySelector('[data-a=now]').onclick = () => exitVersionView();
  el.querySelector('[data-a=back]').onclick = () => {
    const v = UI.viewVersion;
    confirmBox(`Вернуть версию ${v}? Текущая версия останется в истории.`, () => restoreVersion(v), 'Вернуть');
  };
}

async function exitVersionView() {
  const b = cloud.CLOUD.board; if (!b) return;
  UI.viewVersion = null;
  const bar = $('verbar'); if (bar) bar.remove();
  await openServerBoard(b.id, {keepUrl: true});
}

async function restoreVersion(v) {
  const b = cloud.CLOUD.board; if (!b) return;
  try {
    const r = await api.versionRestore(b.id, v);
    UI.viewVersion = null;
    const bar = $('verbar'); if (bar) bar.remove();
    P = normalize(r.doc); gInval();
    cloud.bindBoard(Object.assign({}, cloud.CLOUD.board, {version: r.version}));
    cloud.setBaseline(fingerprint(P), jamBase(P));
    undoReset();
    setReadonly(cloud.CLOUD.board.role === 'viewer');
    if (!P.pages.some(p => p.id === UI.page)) UI.page = (P.pages[0] || {}).id;
    renderPages(); renderPage(); paintSave();
    dbPut(STORE, P).catch(() => {});
    toast(`Вернули версию ${r.from}. Она стала версией ${r.version}, прежняя осталась в истории`);
  } catch (e) { toast('Не удалось вернуть версию: ' + (e.message || e)); }
}

/* --- снимки версий (store SNAP) --- */
const SNAP_CAP = 10;
async function snapList(pid) {
  const all = await dbAll(SNAP).catch(() => []);
  return (all || []).filter(s => s.proj === (pid || P.id)).sort((a, b) => b.at - a.at);
}
async function makeSnap(name) {
  if (VIEWER || !P) return;
  const rec = {id: uid('snap'), proj: P.id, name: (name || '').trim() || ('Снимок ' + nowStr()),
    at: Date.now(), nodes: P.nodes.length, links: P.links.length, data: JSON.stringify(P)};
  await dbPut(SNAP, rec);
  for (const old of (await snapList()).slice(SNAP_CAP)) await dbDel(SNAP, old.id);
  toast('Снимок создан'); showSnaps();
}
async function restoreSnap(id) {
  const rec = await dbGet(SNAP, id); if (!rec) {toast('Снимок не найден'); return;}
  closeModal();
  P = normalize(JSON.parse(rec.data));
  undoReset(); snapArmed = true;
  gInval(); await dbPut(STORE, P); refreshProjMeta();
  UI.view = {}; UI.sel.clear(); UI.selNotes && UI.selNotes.clear(); UI.selFrames && UI.selFrames.clear();
  UI.insp = null; closeInsp();
  UI.page = pageById(UI.page) ? UI.page : (P.pages[0] || {}).id;
  renderPages(); renderPage(); paintSave();
  toast('Восстановлено из снимка «' + rec.name + '»');
}
/* --- валидатор проекта --- */
function validateProject() {
  const issues = [];
  const idset = new Set(P.nodes.map(n => n.id));
  const sk = new Set(P.schema.statuses.map(s => s.key));
  const ck = new Set(P.schema.categories.map(c => c.key));
  const tk = new Set(P.schema.nodeTypes.map(t => t.key));
  const g = G();
  const seen = {}; P.nodes.forEach(n => seen[n.id] = (seen[n.id] || 0) + 1);
  Object.keys(seen).filter(id => seen[id] > 1).forEach(id =>
    issues.push({level: 'error', cat: 'Дубли ID', msg: `ID «${id}» встречается ${seen[id]} раз(а) — граф работает непредсказуемо`, node: id}));
  P.links.forEach(l => {
    const bf = !idset.has(l.from), bt = !idset.has(l.to);
    if (bf || bt) issues.push({level: 'error', cat: 'Битая связь',
      msg: `${l.from} → ${l.to}: ${bf && bt ? 'нет обоих узлов' : bf ? 'нет источника' : 'нет цели'}`,
      fix: {label: 'Удалить связь', run: () => {P.links = P.links.filter(x => x.id !== l.id);}}});
  });
  const lseen = {};
  P.links.forEach(l => {const k = l.from + '→' + l.to + '·' + l.type; lseen[k] = (lseen[k] || 0) + 1;});
  Object.keys(lseen).filter(k => lseen[k] > 1).forEach(k =>
    issues.push({level: 'warn', cat: 'Дубли связей', msg: `Связь ${k} задана ${lseen[k]} раз(а)`,
      fix: {label: 'Свести к одной', run: () => {
        const parts = k.split('·'), tp = parts.pop(), ft = parts.join('·').split('→');
        let kept = false;
        P.links = P.links.filter(l => {
          if (l.from === ft[0] && l.to === ft[1] && l.type === tp) {if (kept) return false; kept = true;}
          return true;
        });
      }}}));
  if (hasCycle()) issues.push({level: 'error', cat: 'Цикл зависимостей',
    msg: 'В графе есть цикл — слои, вес и критический путь считаются неверно. Найдите и разверните лишнюю связь.'});
  const selectFields = P.schema.fields.filter(f => (f.type === 'select' || f.type === 'list') && (f.options || []).length);
  P.nodes.forEach(n => {
    const nm = n.name || n.id;
    if (!n.name || !String(n.name).trim()) issues.push({level: 'warn', cat: 'Пустое название',
      msg: `Узел ${n.id} без названия`, node: n.id, fix: {label: 'Назвать по ID', run: () => {n.name = n.id;}}});
    if (n.status && !sk.has(n.status)) issues.push({level: 'warn', cat: 'Статус вне схемы',
      msg: `${nm}: статус «${n.status}» отсутствует в схеме`, node: n.id,
      fix: {label: 'Сбросить', run: () => {n.status = P.schema.statuses[P.schema.statuses.length - 1].key;}}});
    if (n.cat && !ck.has(n.cat)) issues.push({level: 'warn', cat: 'Категория вне схемы',
      msg: `${nm}: категория «${n.cat}» отсутствует в схеме`, node: n.id,
      fix: {label: 'Сбросить', run: () => {n.cat = P.schema.categories[0].key;}}});
    if (n.type && !tk.has(n.type)) issues.push({level: 'warn', cat: 'Тип вне схемы',
      msg: `${nm}: тип «${n.type}» отсутствует в схеме`, node: n.id,
      fix: {label: 'Сбросить', run: () => {n.type = P.schema.nodeTypes[0].key;}}});
    selectFields.forEach(f => {
      const v = (n.f || {})[f.key]; if (v == null || v === '') return;
      const bad = (Array.isArray(v) ? v : [v]).filter(x => !(f.options || []).includes(x));
      if (bad.length) issues.push({level: 'warn', cat: 'Значение вне списка',
        msg: `${nm}: поле «${f.label}» = «${bad.join(', ')}» вне заданных вариантов`, node: n.id,
        fix: {label: 'Очистить', run: () => {fset(n, 'f.' + f.key, '');}}});
    });
    if (!(g.kids[n.id] || []).length && !(g.par[n.id] || []).length)
      issues.push({level: 'info', cat: 'Изолированный узел', msg: `${nm} не связан ни с чем`, node: n.id});
  });
  const order = {error: 0, warn: 1, info: 2};
  issues.sort((a, b) => order[a.level] - order[b.level]);
  return issues;
}
function showValidator() {
  const issues = validateProject();
  const cnt = l => issues.filter(i => i.level === l).length;
  const ic = l => l === 'error' ? '⛔' : l === 'warn' ? '⚠️' : 'ℹ️';
  const fixable = issues.filter(i => i.fix);
  const rows = issues.length ? issues.map((i, ix) => `<div class="lrow" style="align-items:flex-start;gap:9px">
      <span style="flex:0 0 auto;font-size:13px">${ic(i.level)}</span>
      <div class="t" style="white-space:normal;cursor:${i.node ? 'pointer' : 'default'}" ${i.node ? `data-go="${esc(i.node)}"` : ''}>
        <b>${esc(i.cat)}</b><br><span class="hint">${esc(i.msg)}${i.node ? ' · <span style="color:var(--accent)">перейти →</span>' : ''}</span></div>
      ${i.fix ? `<button class="btn sm" data-fix="${ix}">${esc(i.fix.label)}</button>` : ''}
    </div>`).join('') : '<div class="kv" style="color:var(--green);margin-top:14px;font-size:13px">✓ Проблем не найдено — проект целостный.</div>';
  modal(`<h3>Проверка проекта</h3>
    <div class="kv">${cnt('error')} ошибок · ${cnt('warn')} предупреждений · ${cnt('info')} заметок.</div>
    <div style="margin-top:12px;max-height:56vh;overflow:auto">${rows}</div>
    <div class="mfoot">
      ${fixable.length ? `<button class="btn" data-a="fixall">Починить всё возможное (${fixable.length})</button>` : ''}
      <button class="btn pri" data-a="c">Закрыть</button></div>`, b => {
    b.querySelector('[data-a=c]').onclick = closeModal;
    qsa('[data-go]', b).forEach(el => el.onclick = () => {closeModal(); jumpToNode(el.dataset.go);});
    qsa('[data-fix]', b).forEach(el => el.onclick = () => {
      snapNow(); issues[+el.dataset.fix].fix.run(); gInval(); save(1); renderPage(); showValidator();
    });
    const fa = b.querySelector('[data-a=fixall]');
    if (fa) fa.onclick = () => {
      snapNow(); fixable.forEach(i => {try {i.fix.run();} catch (e) {}}); gInval(); save(1); renderPage();
      toast('Исправлено находок: ' + fixable.length); showValidator();
    };
  });
}
async function showSnaps() {
  const list = await snapList();
  const rows = list.map(s => `<div class="lrow" style="gap:8px">
      <div class="t" style="cursor:default"><b>${esc(s.name)}</b><br>
        <span class="hint">${new Date(s.at).toLocaleString('ru-RU')} · ${s.nodes} узлов, ${s.links} связей</span></div>
      <button class="btn sm" data-a="rest" data-id="${s.id}">Восстановить</button>
      <button class="ib dgr" data-a="del" data-id="${s.id}" title="Удалить снимок">×</button>
    </div>`).join('') || '<div class="hint" style="padding:10px 0">Снимков пока нет. Создайте первую точку отката.</div>';
  modal(`<h3>Снимки версий</h3>
    <div class="kv">Точки отката для «${esc(P.name)}». Хранятся в этом браузере, максимум ${SNAP_CAP} на проект.</div>
    <div style="margin-top:12px;max-height:52vh;overflow:auto">${rows}</div>
    <div class="mfoot"><button class="btn" data-a="c">Закрыть</button><button class="btn pri" data-a="new">Создать снимок</button></div>`, b => {
    b.querySelector('[data-a=c]').onclick = closeModal;
    b.querySelector('[data-a=new]').onclick = () => promptBox('Новый снимок', 'Название', 'Снимок ' + nowStr(), makeSnap);
    qsa('[data-a=rest]', b).forEach(el => el.onclick = () => confirmBox(
      'Восстановить проект из снимка? Текущее состояние будет заменено, стек отмены очистится. Совет: создайте свежий снимок перед восстановлением.',
      () => restoreSnap(el.dataset.id), 'Восстановить'));
    qsa('[data-a=del]', b).forEach(el => el.onclick = () => dbDel(SNAP, el.dataset.id).then(showSnaps));
  });
}
/* --- конвертация старого формата --- */
function isLegacy(d) { return d && Array.isArray(d.nodes) && d.nodes.length && (d.nodes[0].deps !== undefined || d.nodes[0].t !== undefined) && !d.schema; }
function fromLegacy(d) {
  const boards = d.boards || [{id: 'main', name: 'Карта', lanes: []}];
  const pr = {
    id: uid('pr'), name: (d.meta && d.meta.title) || 'Импортированный проект',
    desc: (d.meta && d.meta.intro || '').replace(/<[^>]+>/g, '').slice(0, 200), created: today(), updated: today(),
    schema: {
      nodeTypes: [{key: 'stage', name: 'Этап', shape: 'rect'}, {key: 'gate', name: 'Гейт', shape: 'pill'}],
      statuses: Object.keys(d.statuses || {}).map(k => ({key: k, name: d.statuses[k].name, color: d.statuses[k].color})),
      categories: Object.keys(d.tracks || {}).map(k => ({key: k, name: d.tracks[k].name, color: d.tracks[k].color})),
      linkTypes: [{key: 'hard', name: 'Жёсткая блокировка', color: '#9aa1b2', style: 'solid', blocking: 1},
        {key: 'soft', name: 'Мягкая связь', color: '#c9a227', style: 'dashed', blocking: 0}],
      fields: [{key: 'board', label: 'Доска', type: 'select', options: boards.map(b => b.name), card: 0},
        {key: 'wave', label: 'Волна', type: 'select', options: d.waves || [], card: 1},
        {key: 'gate', label: 'Гейт на вход', type: 'text', card: 0},
        {key: 'note', label: 'Контекст', type: 'longtext', card: 0},
        {key: 'contains', label: 'Что входит', type: 'list', card: 0}]
    },
    nodes: [], links: [], frames: [], notes: [], pages: []
  };
  if (!pr.schema.statuses.length) pr.schema.statuses = [{key: 'na', name: 'без статуса', color: '#a8aebd'}];
  const bn = {}; boards.forEach(b => bn[b.id] = b.name);
  d.nodes.forEach(n => {
    const f = {board: bn[n.board] || boards[0].name};
    if (n.wv) f.wave = n.wv; if (n.gate) f.gate = n.gate; if (n.note) f.note = n.note;
    if ((n.cont || []).length) f.contains = n.cont;
    pr.nodes.push({id: n.id, name: n.t || n.name || n.id, sub: n.s || '', type: n.type || 'stage',
      status: n.st || 'na', cat: n.track || (pr.schema.categories[0] || {key: ''}).key,
      body: n.d || '', draft: n.draft ? 1 : 0, lane: n.col == null ? null : n.col,
      x: n.fx != null ? n.fx : null, y: n.fy != null ? n.fy : null, pinned: n.fx != null ? 1 : 0,
      f, checks: (n.m || []).map(m => ({t: m.v, s: m.s, b: m.b ? 1 : 0, z: m.z || ''}))});
  });
  d.nodes.forEach(n => {
    (n.deps || []).forEach(x => pr.links.push({id: uid('l'), from: x, to: n.id, type: 'hard'}));
    (n.soft || []).forEach(x => pr.links.push({id: uid('l'), from: x, to: n.id, type: 'soft'}));
  });
  pr.pages.push({id: uid('p'), name: 'Обзор', kind: 'dash', filter: {q: '', cats: [], statuses: [], types: [], f: {}}});
  boards.forEach(b => pr.pages.push({id: uid('p'), name: b.name, kind: 'canvas',
    filter: {q: '', cats: [], statuses: [], types: [], f: {board: [b.name]}},
    canvas: {layout: 'auto', lanes: b.lanes || [], intro: b.intro || ''}}));
  pr.pages.push({id: uid('p'), name: 'Все узлы', kind: 'table',
    filter: {q: '', cats: [], statuses: [], types: [], f: {}},
    table: {cols: ['name', 'cat', 'status', 'step', 'weight', 'checks'], sort: 'step', dir: 1, group: ''}});
  return pr;
}
// Размеры узлов, выставленные из коннектора до 2.5.0, лежат в отдельном n.sz[pid],
// которого редактор не знал: узел, которому Claude задал размер, рисовался обычным.
// Переносим к позиции и убираем поле, чтобы двух носителей размера не осталось.
function migrateNodeSizes(pr) {
  for (const n of pr.nodes || []) {
    if (!n.sz || typeof n.sz !== 'object') continue;
    for (const pid in n.sz) {
      const z = n.sz[pid]; if (!z) continue;
      const slot = (n.p[pid] = n.p[pid] || {x: 0, y: 0});
      if (slot.w == null && z.w) slot.w = z.w;
      if (slot.h == null && z.h) slot.h = z.h;
    }
    delete n.sz;
  }
}
function normalize(pr) {
  pr.id = pr.id || uid('pr'); pr.frames = pr.frames || []; pr.notes = pr.notes || []; pr.links = pr.links || [];
  pr.schema = pr.schema || {}; const S = pr.schema;
  S.nodeTypes = S.nodeTypes || [{key: 'stage', name: 'Узел', shape: 'rect'}];
  S.statuses = S.statuses || [{key: 'na', name: 'без статуса', color: '#a8aebd'}];
  S.categories = S.categories || [{key: 'gen', name: 'Общее', color: '#3355d1'}];
  S.linkTypes = S.linkTypes || [{key: 'hard', name: 'Жёсткая', color: '#9aa1b2', style: 'solid', blocking: 1}];
  S.fields = S.fields || [];
  pr.nodes.forEach(n => {n.f = n.f || {}; n.checks = n.checks || []; n.sub = n.sub || ''; n.body = n.body || ''; n.p = n.p || {};});
  migrateNodeSizes(pr);
  if (!pr.pages || !pr.pages.length) pr.pages = [{id: uid('p'), name: 'Холст', kind: 'canvas',
    filter: {q: '', cats: [], statuses: [], types: [], f: {}}, canvas: {layout: 'auto', lanes: []}}];
  pr.pages.forEach(p => {p.filter = p.filter || {q: '', cats: [], statuses: [], types: [], f: {}};
    if (p.kind === 'canvas') p.canvas = p.canvas || {layout: 'auto', lanes: []};
    if (p.kind === 'space') p.space = p.space || {};
    // Умолчания доски проставляются ТОЛЬКО здесь: версии документа нет, и всё,
    // что не досыпано в normalize, пришлось бы проверять в каждой точке чтения.
    if (p.kind === 'jam') {
      p.jam = p.jam || {};
      p.jam.items = Array.isArray(p.jam.items) ? p.jam.items.filter(it => it && it.kind && it.id) : [];
      p.jam.bg = p.jam.bg || 'dots';
    }});
  return pr;
}
// Восстановление бэкап-бандла. Общая точка для «Импорт → JSON» и для «Открыть файл»:
// dbPut идёт по keyPath 'id' и раньше ЗАТИРАЛ проект с тем же id молча, без подтверждения
// и без возможности отменить.
async function restoreBundle(d) {
  const list = (d.projects || []).filter(p => p && Array.isArray(p.nodes));
  if (!list.length) { toast('В файле нет досок'); return; }

  // Без входа — как раньше, в браузер. Это не запасной путь «на всякий случай»:
  // человек мог открыть приложение, когда сервер лежит, и потерять файл ему нельзя.
  if (!cloud.CLOUD.account) {
    for (const pr of list) { pr.id = pr.id || uid('pr'); await dbPut(STORE, normalize(pr)); }
    for (const sn of (d.snaps || [])) { try { await dbPut(SNAP, sn); } catch (e) {} }
    await loadProjects(); home.showHome('local');
    toast(`Восстановлено в этот браузер: ${list.length}. Войдите, чтобы перенести на сервер.`);
    return;
  }

  modal(`<h3>Восстановить из файла</h3>
    <div class="kv" style="font-size:13px">В файле досок: <b>${list.length}</b>${
      d.exported ? ` (копия от ${esc(d.exported)})` : ''}.<br>
      Они будут созданы на сервере как новые. Существующие доски не трогаются
      и ничего не перезаписывается: у восстановленной копии свой адрес.</div>
    <div class="kv" style="font-size:12.5px;margin-top:8px">${list.slice(0, 6).map(p =>
      '· ' + esc(p.name || 'Без названия') + ` <span style="color:var(--muted)">${p.nodes.length} узлов</span>`).join('<br>')}
      ${list.length > 6 ? '<br>· и ещё ' + (list.length - 6) : ''}</div>
    <div class="mfoot"><button class="btn" data-a="c">Отмена</button>
      <button class="btn pri" data-a="go">Создать на сервере</button></div>`, b => {
    b.querySelector('[data-a=c]').onclick = closeModal;
    b.querySelector('[data-a=go]').onclick = async () => {
      const btn = b.querySelector('[data-a=go]');
      btn.disabled = true;
      let done = 0, failed = 0, first = null;
      for (const pr of list) {
        btn.textContent = `Отправляю ${done + failed + 1} из ${list.length}…`;
        const doc = normalize(pr);
        delete doc.deleted; delete doc.deletedAt;
        try { const id = await cloud.uploadProject(doc); if (!first) first = id; done++; }
        catch { failed++; }
      }
      closeModal();
      await home.refreshBoards();
      home.showHome('all');
      toast(`Восстановлено на сервере: ${done}${failed ? ', не удалось ' + failed : ''}`);
    };
  });
}

// Разбор отделён от выбора файла: так путь «текст → доска на сервере» можно
// проверить тестом, не подсовывая браузеру фальшивый <input type=file>.
function importJson(mode) { pickFile('.json', txt => importText(txt, mode)); }

async function importText(txt, mode) {
  {
    let d; try {d = JSON.parse(txt);} catch (e) {toast('Не JSON: ' + e.message); return;}
    if (d.graphstudio && Array.isArray(d.projects)) { await restoreBundle(d); return; }
    const pr = isLegacy(d) ? fromLegacy(d) : normalize(d);
    if (mode === 'merge') {
      if (!P) { toast('Слить некуда: сначала откройте доску'); return; }
      if (ro()) { toast('Только просмотр — слить нельзя'); return; }
      snapNow();
      let a = 0, u = 0;
      pr.nodes.forEach(n => {const c = nodeById(n.id); if (c) {Object.assign(c, n); u++;} else {P.nodes.push(n); a++;}});
      pr.links.forEach(l => {if (!P.links.some(x => x.from === l.from && x.to === l.to)) P.links.push(l);});
      ['statuses', 'categories', 'nodeTypes', 'linkTypes', 'fields'].forEach(k =>
        (pr.schema[k] || []).forEach(it => {if (!P.schema[k].some(x => x.key === it.key)) P.schema[k].push(it);}));
      gInval(); save(1); renderPage(); toast(`Слито: обновлено ${u}, добавлено ${a}`);
      return;
    }
    // Импортированное сразу становится доской на сервере: файл — это способ занести
    // работу внутрь, а не второе место, где она живёт.
    if (cloud.CLOUD.account) {
      try {
        delete pr.deleted; delete pr.deletedAt;
        const id = await cloud.uploadProject(pr);
        await home.refreshBoards();
        await openServerBoard(id);
        toast(`Доска «${pr.name}» загружена на сервер: ${pr.nodes.length} узлов`);
      } catch (e) { toast('Не удалось загрузить на сервер: ' + (e.message || e)); }
      return;
    }
    pr.id = uid('pr'); await dbPut(STORE, pr); await loadProjects(); await openProject(pr.id);
    toast(`Доска «${pr.name}» открыта в браузере — войдите, чтобы она была на сервере`);
  }
}

function importCsv() {
  pickFile('.csv', txt => {
    const rows = parseCsv(txt); if (rows.length < 2) {toast('Пустой CSV'); return;}
    const head = rows[0].map(h => h.trim().toLowerCase());
    const ix = k => head.indexOf(k);
    const idc = ix('id') >= 0 ? ix('id') : -1, namec = ix('name') >= 0 ? ix('name') : ix('название');
    if (idc < 0 && namec < 0) {toast('Нужна колонка id или name'); return;}
    snapNow();
    let a = 0, u = 0;
    const findKey = (arr, v) => (arr.find(x => x.key === v) || arr.find(x => x.name.toLowerCase() === String(v).toLowerCase()) || {}).key;
    rows.slice(1).forEach(r => {
      const id = idc >= 0 ? (r[idc] || '').trim() : '';
      let n = id && nodeById(id);
      if (!n) {
        n = {id: id || uid('n'), name: namec >= 0 ? r[namec] : id, sub: '', type: P.schema.nodeTypes[0].key,
          status: P.schema.statuses[P.schema.statuses.length - 1].key, cat: P.schema.categories[0].key,
          body: '', draft: 0, lane: null, x: null, y: null, pinned: 0, f: {}, checks: []};
        P.nodes.push(n); a++;
      } else u++;
      const setIf = (col, fn) => {const c = ix(col); if (c >= 0 && r[c] !== undefined && r[c] !== '') fn(r[c].trim());};
      setIf('name', v => n.name = v); setIf('sub', v => n.sub = v); setIf('body', v => n.body = v);
      setIf('status', v => {const k = findKey(P.schema.statuses, v); if (k) n.status = k;});
      setIf('category', v => {const k = findKey(P.schema.categories, v); if (k) n.cat = k;});
      setIf('type', v => {const k = findKey(P.schema.nodeTypes, v); if (k) n.type = k;});
      P.schema.fields.forEach(f => setIf(f.key, v => n.f[f.key] = f.type === 'list' ? v.split('|').map(s => s.trim()) : v));
    });
    const dc = ix('deps');
    if (dc >= 0) rows.slice(1).forEach(r => {
      const id = idc >= 0 ? (r[idc] || '').trim() : null; if (!id || !nodeById(id)) return;
      (r[dc] || '').split(/[\s,;|]+/).filter(Boolean).forEach(from => {
        if (nodeById(from) && !P.links.some(l => l.from === from && l.to === id))
          P.links.push({id: uid('l'), from, to: id, type: P.schema.linkTypes[0].key});
      });
    });
    gInval(); save(1); renderPage(); toast(`CSV: добавлено ${a}, обновлено ${u}`);
  });
}

/* ==========================================================================
   ПРОЕКТЫ И ШАБЛОНЫ
   ========================================================================== */
const TPL = [
  {id: 'blank', name: 'Пустой проект', desc: 'Чистый холст: один тип узла, три статуса, одна категория.', make: () => ({
    name: 'Новый проект', desc: '',
    schema: {nodeTypes: [{key: 'n', name: 'Узел', shape: 'rect'}, {key: 'g', name: 'Ключевая точка', shape: 'pill'}],
      statuses: [{key: 'todo', name: 'не начато', color: '#8b91a1'}, {key: 'doing', name: 'в работе', color: '#8a5d00'}, {key: 'done', name: 'готово', color: '#18a558'}],
      categories: [{key: 'gen', name: 'Общее', color: '#3355d1'}],
      linkTypes: [{key: 'hard', name: 'Жёсткая связь', color: '#9aa1b2', style: 'solid', blocking: 1},
        {key: 'soft', name: 'Мягкая связь', color: '#c9a227', style: 'dashed', blocking: 0}],
      fields: []},
    nodes: [], links: [], frames: [], notes: [],
    pages: [{id: 'p1', name: 'Холст', kind: 'canvas', filter: {}, canvas: {layout: 'free', lanes: []}},
      {id: 'p2', name: 'Таблица', kind: 'table', filter: {}, table: {cols: ['name', 'cat', 'status'], sort: 'name', dir: 1, group: ''}}]
  })},
  {id: 'unlock', name: 'Карта разблокировок', desc: 'Что чем заблокировано: гейты, жёсткие и мягкие связи, вес узла, критический путь.', make: () => ({
    name: 'Карта разблокировок', desc: 'Колонка = глубина зависимости, а не календарь.',
    schema: {nodeTypes: [{key: 'stage', name: 'Этап / продукт', shape: 'rect'}, {key: 'gate', name: 'Гейт / блокировка', shape: 'pill'}],
      statuses: [{key: 'done', name: 'готово', color: '#18a558'}, {key: 'green', name: 'работает', color: '#136c33'},
        {key: 'amber', name: 'в работе', color: '#8a5d00'}, {key: 'red', name: 'заблокировано', color: '#b3261e'},
        {key: 'grey', name: 'discovery', color: '#5f6673'}, {key: 'na', name: 'статус не проставлен', color: '#a8aebd'}],
      categories: [{key: 'f', name: 'Фундамент', color: '#6b7280'}, {key: 'a', name: 'Направление A', color: '#2f6fed'},
        {key: 'b', name: 'Направление B', color: '#8b46c9'}],
      linkTypes: [{key: 'hard', name: 'Жёсткая блокировка', color: '#9aa1b2', style: 'solid', blocking: 1},
        {key: 'soft', name: 'Мягкая связь', color: '#c9a227', style: 'dashed', blocking: 0}],
      fields: [{key: 'gate', label: 'Гейт на вход', type: 'text', card: 0}, {key: 'owner', label: 'Ответственный', type: 'text', card: 0}]},
    nodes: [
      {id: 'n1', name: 'Условие, от которого всё зависит', sub: 'пример гейта', type: 'gate', status: 'red', cat: 'f', body: '', draft: 0, lane: null, x: 60, y: 120, pinned: 0, f: {}, checks: [{t: 'Договориться', s: 'red', b: 1, z: ''}]},
      {id: 'n2', name: 'Первый этап', sub: '', type: 'stage', status: 'amber', cat: 'a', body: '', draft: 0, lane: null, x: 400, y: 60, pinned: 0, f: {}, checks: []},
      {id: 'n3', name: 'Второй этап', sub: '', type: 'stage', status: 'na', cat: 'b', body: '', draft: 0, lane: null, x: 400, y: 200, pinned: 0, f: {}, checks: []}
    ],
    links: [{id: 'l1', from: 'n1', to: 'n2', type: 'hard'}, {id: 'l2', from: 'n1', to: 'n3', type: 'soft'}],
    frames: [], notes: [],
    pages: [{id: 'p0', name: 'Обзор', kind: 'dash', filter: {}},
      {id: 'p1', name: 'Карта', kind: 'canvas', filter: {}, canvas: {layout: 'auto', lanes: ['блокировки', 'этап 1', 'этап 2', 'этап 3', 'этап 4']}},
      {id: 'p2', name: 'Все узлы', kind: 'table', filter: {}, table: {cols: ['name', 'cat', 'status', 'step', 'weight', 'checks'], sort: 'step', dir: 1, group: ''}}]
  })},
  {id: 'roadmap', name: 'Роадмап по волнам', desc: 'Now / Next / Later, канбан по статусу, разбивка по волнам и командам.', make: () => ({
    name: 'Роадмап', desc: '',
    schema: {nodeTypes: [{key: 'feat', name: 'Фича', shape: 'rect'}, {key: 'epic', name: 'Эпик', shape: 'pill'}],
      statuses: [{key: 'idea', name: 'идея', color: '#8b91a1'}, {key: 'disc', name: 'discovery', color: '#5f6673'},
        {key: 'dev', name: 'в разработке', color: '#8a5d00'}, {key: 'rel', name: 'выпущено', color: '#18a558'},
        {key: 'block', name: 'заблокировано', color: '#b3261e'}],
      categories: [{key: 'core', name: 'Ядро', color: '#3355d1'}, {key: 'growth', name: 'Рост', color: '#0f8f6a'},
        {key: 'plat', name: 'Платформа', color: '#8b46c9'}],
      linkTypes: [{key: 'dep', name: 'Зависимость', color: '#9aa1b2', style: 'solid', blocking: 1},
        {key: 'rel', name: 'Связано', color: '#c9a227', style: 'dashed', blocking: 0}],
      fields: [{key: 'wave', label: 'Волна', type: 'select', options: ['Now', 'Next', 'Later'], card: 1},
        {key: 'team', label: 'Команда', type: 'text', card: 0}, {key: 'value', label: 'Ценность 1–5', type: 'number', card: 0}]},
    nodes: [], links: [], frames: [], notes: [],
    pages: [{id: 'p0', name: 'Обзор', kind: 'dash', filter: {}},
      {id: 'p1', name: 'Карта зависимостей', kind: 'canvas', filter: {}, canvas: {layout: 'auto', lanes: []}},
      {id: 'p2', name: 'Now / Next / Later', kind: 'board', filter: {}, board: {groupBy: 'f.wave'}},
      {id: 'p3', name: 'Бэклог', kind: 'table', filter: {}, table: {cols: ['name', 'f.wave', 'cat', 'status', 'f.value'], sort: 'f.value', dir: -1, group: 'f.wave'}}]
  })},
  {id: 'process', name: 'Процесс / воронка', desc: 'Шаги процесса на свободном холсте, области и заметки.', make: () => ({
    name: 'Процесс', desc: '',
    schema: {nodeTypes: [{key: 'step', name: 'Шаг', shape: 'rect'}, {key: 'dec', name: 'Развилка', shape: 'diamond'}],
      statuses: [{key: 'ok', name: 'работает', color: '#18a558'}, {key: 'weak', name: 'узкое место', color: '#8a5d00'}, {key: 'bad', name: 'сломано', color: '#b3261e'}],
      categories: [{key: 'user', name: 'Клиент', color: '#2f6fed'}, {key: 'ops', name: 'Операции', color: '#0f8f6a'}, {key: 'sys', name: 'Система', color: '#8b46c9'}],
      linkTypes: [{key: 'flow', name: 'Переход', color: '#9aa1b2', style: 'solid', blocking: 1},
        {key: 'alt', name: 'Альтернативный путь', color: '#c9a227', style: 'dashed', blocking: 0}],
      fields: [{key: 'sla', label: 'Срок / SLA', type: 'text', card: 1}, {key: 'owner', label: 'Ответственный', type: 'text', card: 0}]},
    nodes: [], links: [], frames: [], notes: [],
    pages: [{id: 'p1', name: 'Схема', kind: 'canvas', filter: {}, canvas: {layout: 'free', lanes: []}},
      {id: 'p2', name: 'Шаги', kind: 'table', filter: {}, table: {cols: ['name', 'cat', 'status', 'f.sla', 'f.owner'], sort: 'name', dir: 1, group: ''}}]
  })},
  {id: 'demo', name: 'Демо-проект', desc: 'Готовая карта на 32 узла — запуск маркетплейса с платёжным треком. Чтобы посмотреть, как всё работает.', make: () => clone(SEED)}
];
/* ---------- аккаунт ----------
   Живёт в модуле главной: аватар в правом верхнем углу — и на главной, и в редакторе.
   В подвале боковой панели «Войти» видел только тот, у кого уже открыт проект. */
function paintAccount() { home.paintAvatars(); }
function accountMenu(e) { return home.accountMenu(e); }

/* ---------- админка ---------- */
// Доступна только владельцу сервиса. Раздавать эту роль через интерфейс нельзя:
// это не «ещё одна роль», а полный доступ ко всем чужим доскам.
async function showAdmin() {
  if (!cloud.CLOUD.account) {
    home.showAuthPage({reason: 'Админка доступна после входа.', then: showAdmin});
    return;
  }
  if (!cloud.CLOUD.account.admin) { toast('Раздел только для администратора'); return; }

  const fmt = t => t ? new Date(t).toLocaleString('ru-RU').slice(0, 16) : '—';
  const draw = async (tab, msg) => {
    let stats = {}, users = [], boards = [], log = [];
    try {
      stats = (await api.adminStats());
      if (tab === 'users') users = (await api.adminUsers()).users;
      if (tab === 'boards') boards = (await api.adminBoards()).boards;
      if (tab === 'log') log = (await api.adminLog()).log;
    } catch (e) { msg = msg || (e.message || String(e)); }

    const tabs = [['users', 'Пользователи'], ['boards', 'Доски'], ['log', 'Журнал доступа']];
    let body = '';
    if (tab === 'users') {
      body = users.length ? `<table class="grid"><thead><tr>
        <th>Почта</th><th>Имя</th><th>Досок</th><th>Заходил</th><th></th></tr></thead><tbody>
        ${users.map(u => `<tr>
          <td>${u.is_admin ? '★ ' : ''}${esc(u.email)}${u.blocked ? ' <span style="color:var(--red)">заблокирован</span>' : ''}</td>
          <td>${esc(u.name || '')}</td><td>${u.boards}</td><td>${esc(fmt(u.last_seen))}</td>
          <td style="white-space:nowrap">
            <button class="btn sm" data-pw="${esc(u.id)}">Сбросить пароль</button>
            <button class="btn sm ${u.blocked ? '' : 'dgr'}" data-blk="${esc(u.id)}" data-on="${u.blocked ? 0 : 1}">${u.blocked ? 'Разблокировать' : 'Заблокировать'}</button>
          </td></tr>`).join('')}</tbody></table>
        <div style="margin-top:10px"><button class="btn" data-a="newuser">＋ Создать пользователя</button>
        <button class="btn" data-a="invite">＋ Выписать приглашение</button></div>`
        : '<div class="hint">Пользователей нет.</div>';
    } else if (tab === 'boards') {
      body = boards.length ? `<table class="grid"><thead><tr>
        <th>Доска</th><th>Владелец</th><th>Узлов</th><th>Изменена</th><th></th></tr></thead><tbody>
        ${boards.map(b => `<tr>
          <td>${b.deleted ? '🗑 ' : ''}${esc(b.name || b.id)}</td><td>${esc(b.owner_email || '—')}</td>
          <td>${b.nodes_count}</td><td>${esc(fmt(b.updated_at))}</td>
          <td><button class="btn sm" data-open="${esc(b.id)}">Открыть</button></td></tr>`).join('')}</tbody></table>
        <div class="hint" style="margin-top:8px">Открытие чужой доски записывается в журнал доступа.</div>`
        : '<div class="hint">Досок нет.</div>';
    } else {
      body = log.length ? `<table class="grid"><thead><tr>
        <th>Когда</th><th>Кто</th><th>Доска</th><th>Действие</th></tr></thead><tbody>
        ${log.map(l => `<tr><td>${esc(fmt(l.at))}</td><td>${esc(l.admin_email || '')}</td>
          <td>${esc(l.board_name || l.board_id)}</td><td>${esc(l.action)}</td></tr>`).join('')}</tbody></table>`
        : '<div class="hint">Записей нет — чужие доски пока не открывались.</div>';
    }

    modal(`<h3>Админка</h3>
      ${msg ? `<div class="kv" style="color:var(--red);font-size:12.5px">${esc(msg)}</div>` : ''}
      <div class="kv" style="font-size:12.5px">
        Пользователей: <b>${stats.users ?? '?'}</b> · Досок: <b>${stats.boards ?? '?'}</b>
        · В корзине: <b>${stats.trashed ?? '?'}</b> · Живых ссылок: <b>${stats.shares ?? '?'}</b>
        · Приглашений ждут: <b>${stats.invites ?? '?'}</b></div>
      <div id="itabs" style="margin:10px 0 8px">${tabs.map(([k, n]) =>
        `<div class="t${k === tab ? ' on' : ''}" data-tab="${k}">${n}</div>`).join('')}</div>
      <div style="max-height:52vh;overflow:auto">${body}</div>
      <div class="mfoot">
        <button class="btn" data-a="backup">Сделать копию базы</button>
        <button class="btn" data-a="c">Закрыть</button></div>`, b => {
      b.querySelector('[data-a=c]').onclick = closeModal;
      qsa('[data-tab]', b).forEach(el => el.onclick = () => draw(el.dataset.tab));
      const back = b.querySelector('[data-a=backup]');
      if (back) back.onclick = async () => {
        try { const r = await api.adminBackup(); toast('Копия создана: ' + r.file); }
        catch (e) { toast('Не удалось: ' + (e.message || e)); }
      };
      qsa('[data-pw]', b).forEach(el => el.onclick = () => {
        promptBox('Новый пароль', 'От 8 символов', '', async pw => {
          try { await api.adminUserPassword(el.dataset.pw, pw); draw(tab, 'Пароль изменён, сессии закрыты'); }
          catch (e) { draw(tab, e.message || String(e)); }
        });
      });
      qsa('[data-blk]', b).forEach(el => el.onclick = async () => {
        try { await api.adminUserBlock(el.dataset.blk, el.dataset.on === '1'); draw(tab); }
        catch (e) { draw(tab, e.message || String(e)); }
      });
      qsa('[data-open]', b).forEach(el => el.onclick = () => { closeModal(); openServerBoard(el.dataset.open); });
      const nu = b.querySelector('[data-a=newuser]');
      if (nu) nu.onclick = () => {
        modal(`<h3>Новый пользователь</h3>
          <div class="f"><label>Почта</label><input type="email" id="nuMail"></div>
          <div class="f"><label>Имя</label><input type="text" id="nuName"></div>
          <div class="f"><label>Пароль</label><input type="text" id="nuPass" placeholder="от 8 символов"></div>
          <div class="mfoot"><button class="btn" data-a="c">Отмена</button>
          <button class="btn pri" data-a="ok">Создать</button></div>`, bb => {
          bb.querySelector('[data-a=c]').onclick = () => draw(tab);
          bb.querySelector('[data-a=ok]').onclick = async () => {
            try {
              await api.adminUserCreate($('nuMail').value.trim(), $('nuPass').value, $('nuName').value.trim());
              draw(tab, 'Пользователь создан');
            } catch (e) { toast(e.message || String(e)); }
          };
        });
      };
      const inv = b.querySelector('[data-a=invite]');
      if (inv) inv.onclick = () => {
        promptBox('Приглашение', 'Почта (можно пустую — тогда подойдёт любая)', '', async mail => {
          try {
            const r = await api.inviteCreate(mail || null, 14);
            const link = location.origin + '/join/' + r.token;
            try { await navigator.clipboard.writeText(link); } catch {}
            draw(tab, 'Ссылка скопирована: ' + link);
          } catch (e) { draw(tab, e.message || String(e)); }
        });
      };
    });
  };
  draw('users');
}

/* ---------- серверные доски и маршруты ---------- */
// Открывает серверную доску: документ приходит с сервера, локальная копия
// становится кэшем (быстрый старт и переживание короткого обрыва связи).
async function openServerBoard(id, opts) {
  const o = opts || {};
  try {
    const r = await api.boardGet(id);
    P = normalize(r.doc);
    P.id = 'srv_' + id;                       // локальный ключ кэша, не путать с id доски
    cloud.bindBoard({id, version: r.version, role: r.role, asAdmin: !!r.asAdmin});
    try { await dbPut(STORE, P); await loadProjects(); } catch {}
    UI.page = (P.pages[0] || {}).id;
    undoReset();
    migrateLegacyViews();
    document.title = (P.name || 'Доска') + ' — Graph Studio';
    home.hideAll();
    renderPages(); renderPage(); paintSave();
    if (r.asAdmin) toast('Вы открыли чужую доску как администратор — это записано в журнал');
    setReadonly(r.role === 'viewer', r.role === 'viewer' ? 'Только просмотр: править эту доску вам не разрешили' : '');
    if (!o.keepUrl) cloud.goTo('/b/' + id, true);
    cloud.setBaseline(fingerprint(P), jamBase(P));
    live.connect(id);
    return true;
  } catch (e) {
    toast('Не удалось открыть доску: ' + (e.message || e));
    return false;
  }
}

// Переход по ссылке-доступу.
async function openShare(token, wantRole) {
  try {
    const r = await api.shareOpen(token);
    if (r.role === 'viewer' && r.doc) {
      // Просмотр без входа: документ пришёл сразу, в базу его не кладём —
      // это чужая доска, ей нечего делать в списке проектов гостя.
      P = normalize(r.doc);
      cloud.bindBoard(null);
      UI.page = (P.pages[0] || {}).id;
      setReadonly(true, 'Открыто только для просмотра — правки не сохранятся');
      document.title = (P.name || 'Доска') + ' — просмотр';
      home.hideAll();
      renderPages(); renderPage(); paintSave();
      toast('Открыто только для просмотра');
      return true;
    }
    return await openServerBoard(r.id, {keepUrl: true});
  } catch (e) {
    if (e instanceof ApiError && e.status === 401 && e.body && e.body.needAuth) {
      home.showAuthPage({
        reason: 'Эта ссылка даёт право править доску, поэтому нужен вход: у изменений должен быть автор.',
        then: () => openShare(token, wantRole),
      });
      return false;
    }
    toast('Ссылка недействительна: ' + (e.message || e));
    return false;
  }
}

// Разбор адреса при старте. Открытая ссылка обязана вести туда, куда обещает.
async function routeBoot() {
  const r = parseRoute(location.pathname);
  cloud.CLOUD.route = r;
  if (r.kind === 'share') return openShare(r.token, r.role);
  if (r.kind === 'board') return openServerBoard(r.id, {keepUrl: true});
  if (r.kind === 'join') {
    try {
      const info = await api.inviteInfo(r.token);
      home.showAuthPage({mode: 'register', invite: r.token, email: info.email || '',
        then: () => { cloud.goTo('/', true); home.showHome('all'); }});
    } catch (e) { toast('Приглашение недействительно: ' + (e.message || e)); }
    return false;
  }
  if (r.kind === 'login') { home.showAuthPage({then: () => { cloud.goTo('/', true); home.showHome('all'); }}); return true; }
  if (r.kind === 'admin') { showAdmin(); return false; }
  return false;
}

async function loadProjects() {
  const all = await dbAll(STORE);
  PROJECTS = all.map(p => ({id: p.id, name: p.name, desc: p.desc, updated: p.updated, created: p.created, nodes: p.nodes.length, links: p.links.length, deleted: !!p.deleted, deletedAt: p.deletedAt || null, movedTo: p.movedTo || null}))
    .sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
}
async function trashProject(id) {
  const pr = await dbGet(STORE, id); if (!pr) return;
  pr.deleted = true; pr.deletedAt = today(); await dbPut(STORE, pr); await loadProjects();
  if (P && P.id === id) { P = null; closeInsp(); }
  home.showHome();
  toast('Проект перемещён в «Удалённые»');
}
async function restoreProject(id) {
  const pr = await dbGet(STORE, id); if (!pr) return;
  delete pr.deleted; delete pr.deletedAt; await dbPut(STORE, pr); await loadProjects();
  home.showHome(); toast('Проект восстановлен');
}
async function purgeProject(id) {
  await dbDel(STORE, id);
  for (const s of await snapList(id)) await dbDel(SNAP, s.id);
  await loadProjects(); home.showHome(); toast('Удалено');
}
/* ==========================================================================
   ГЛАВНАЯ: досок больше нет в оверлее поверх редактора
   --------------------------------------------------------------------------
   Сервер — основное хранилище. Новая доска создаётся сразу на нём: до этого
   «＋ проект» клал файл в браузер, и человек узнавал, что доски нет на втором
   устройстве, уже потеряв её. Локальные проекты из старой версии никуда не
   деваются — они лежат отдельным разделом с кнопкой «перенести».
   ========================================================================== */
// Открытая серверная доска кэшируется в IndexedDB под ключом srv_<id>. Это кэш,
// а не «проект на этом компьютере»: без этого фильтра каждая открытая доска
// появлялась бы ещё и в разделе локальных, как будто у неё два дома.
const isCache = id => String(id).startsWith('srv_');
function localProjects() { return PROJECTS.filter(p => !isCache(p.id)); }

// Открыть серверную доску с главной.
async function openBoard(id) { await openServerBoard(id); }

// Открыть локальный проект из раздела «на этом компьютере».
async function openLocal(id) {
  live.disconnect(); cloud.unbindBoard(); UI.viewVersion = null;
  const bar = $('verbar'); if (bar) bar.remove();
  await openProject(id);
}

async function restoreLocal(id) { await restoreProject(id); }
async function purgeLocal(id) {
  const pr = PROJECTS.find(x => x.id === id);
  const moved = pr && pr.movedTo;
  confirmBox(moved
    ? `Убрать локальную копию «${pr.name}»? Доска останется на сервере, пропадёт только копия в этом браузере.`
    : `Стереть проект «${pr ? pr.name : ''}» НАВСЕГДА? Он нигде больше не хранится, снимки версий пропадут вместе с ним.`,
    () => purgeProject(id), moved ? 'Убрать копию' : 'Стереть');
}

// Отправка локального проекта на сервер. Ничего не удаляется: локальная копия
// остаётся на месте, пока человек сам не решит иначе.
async function uploadLocalProject(projectId) {
  const pr = await dbGet(STORE, projectId);
  if (!pr) throw new Error('проект не найден');
  const doc = normalize(pr);
  delete doc.deleted; delete doc.deletedAt; delete doc.movedTo;
  const id = await cloud.uploadProject(doc);
  // Помечаем локальную копию перенесённой, но НЕ удаляем: удалять единственный
  // экземпляр чужой работы за человека нельзя. Кнопка «убрать копию» рядом.
  pr.movedTo = id;
  await dbPut(STORE, pr);
  await loadProjects();
  return id;
}

async function uploadCurrentProject(projectId) {
  if (!cloud.CLOUD.account) {
    home.showAuthPage({reason: 'Чтобы держать доску на сервере и делиться ссылкой, нужен аккаунт.',
      then: () => uploadCurrentProject(projectId)});
    return;
  }
  try {
    const id = await uploadLocalProject(projectId);
    toast('Проект теперь на сервере');
    await home.refreshBoards();
    await openServerBoard(id);
  } catch (e) { toast('Не удалось отправить: ' + (e.message || e)); }
}

// Перенести всё разом: по одной кнопке на проект это ровно столько кликов,
// сколько проектов, и посреди списка легко бросить на середине.
async function uploadAllLocal() {
  if (!cloud.CLOUD.account) {
    home.showAuthPage({reason: 'Чтобы перенести доски на сервер, нужен вход.', then: uploadAllLocal});
    return;
  }
  const todo = PROJECTS.filter(p => !p.deleted && !p.movedTo);
  if (!todo.length) { toast('Переносить нечего'); return; }
  confirmBox(`Перенести на сервер ${nOf(todo.length, ['проект', 'проекта', 'проектов'])}? ` +
    'Локальные копии останутся на месте — их можно удалить отдельно.', async () => {
    let done = 0, failed = 0;
    for (const p of todo) {
      try { await uploadLocalProject(p.id); done++; } catch { failed++; }
    }
    await home.refreshBoards();
    home.showHome(done && !failed ? 'all' : 'local');
    toast(`Перенесено: ${done}${failed ? ', не удалось ' + failed : ''}`);
  }, 'Перенести');
}

// Создание доски из шаблона. С аккаунтом — сразу на сервере.
async function createFromTemplate(tplId) {
  const t = TPL.find(x => x.id === tplId);
  if (!t) return;
  const pr = normalize(t.make());
  pr.id = uid('pr'); pr.created = today(); pr.updated = today();
  if (cloud.CLOUD.account) {
    try {
      const id = await cloud.uploadProject(pr);
      await home.refreshBoards();
      await openServerBoard(id);
      toast('Доска создана');
    } catch (e) { toast('Не удалось создать доску: ' + (e.message || e)); }
    return;
  }
  // Сервер недоступен — работаем как раньше, локально. Это не тихая подмена:
  // человеку про это сказано прямо, и доска потом переносится одной кнопкой.
  await dbPut(STORE, pr);
  await loadProjects();
  await openProject(pr.id);
  toast('Сервер недоступен — доска создана только в этом браузере');
}

// Демо с витрины: показать, как устроено, не заводя аккаунт. Только просмотр —
// править то, что негде сохранить, значит обещать сохранение, которого не будет.
function openDemo() {
  home.hideAll();
  live.disconnect();
  cloud.unbindBoard();
  P = normalize(clone(SEED));
  P.id = 'demo_preview';
  gInval(); undoReset();
  UI.view = {}; UI.sel.clear(); UI.selNotes.clear(); UI.selFrames.clear(); UI.insp = null; closeInsp();
  UI.page = (P.pages[0] || {}).id;
  setReadonly(true, 'Демо-доска: смотреть можно всё, править — после входа');
  document.title = 'Демо — Graph Studio';
  renderPages(); renderPage(); paintSave();
}

// Наверх, к списку досок. Точка выхода из редактора, которой раньше не было.
function goHome() {
  live.disconnect();
  UI.viewVersion = null;
  const vb = $('verbar'); if (vb) vb.remove();
  cloud.goTo('/');
  if (cloud.CLOUD.account) home.showHome();
  else if (PROJECTS.filter(p => !p.deleted).length) home.showHome('local');
  else home.showLanding();
}

// Осталось ради старых точек вызова (палитра команд, контекстное меню названия).
function showProjects() { goHome(); }

// После выхода из аккаунта: серверных досок больше не видно, показывать их список
// нечестно. Локальные проекты остаются — если они есть, попадаем в их раздел.
function onSignedOut() {
  live.disconnect();
  P = null; closeInsp(); setReadonly(false);
  home.HOME.boards = null;
  cloud.goTo('/');
  paintAccount();
  if (PROJECTS.filter(p => !p.deleted).length) home.showHome('local');
  else home.showLanding();
}

async function openProject(id) {
  setReadonly(false);   // локальный проект всегда свой и правится
  const pr = await dbGet(STORE, id);
  if (!pr) {toast('Проект не найден'); return;}
  P = normalize(pr); gInval(); undoReset();
  UI.view = {}; UI.sel.clear(); UI.selNotes.clear(); UI.selFrames.clear(); UI.insp = null; closeInsp();
  await dbPut(META, {k: 'last', v: id});
  migrateLegacyViews();
  const mb = $('tbMembers'); if (mb) mb.innerHTML = '';
  home.hideAll();
  document.title = P.name + ' — Graph Studio';
  UI.page = (P.pages[0] || {}).id;
  renderPages(); renderPage();
}
$('projBtn').onclick = goHome;
// На дашборде и в таблице узел создавался «в никуда»: страница перерисовывалась,
// визуально не менялось ничего, а узел повисал в проекте. Уводим на холст.
$('bAdd').onclick = () => {
  if (!P) return;
  if (!isSpatial(curPage())) {
    const spatial = P.pages.find(p => isSpatial(p));
    if (spatial) {gotoPage(spatial.id); setTimeout(() => addNode(), 60); return;}
  }
  addNode();
};
$('bUndo').onclick = undo; $('bRedo').onclick = redo;

/* ==========================================================================
   СПРАВКА
   ========================================================================== */
function showHelp() {
  modal(`<h3>Как пользоваться</h3>
  <div class="kv" style="font-size:13px;line-height:1.65">
    <b>Модель.</b> Проект = узлы + связи + страницы. Узлы одни и те же на всех страницах — меняется только вид и фильтр.
    Типы узлов, статусы, категории, типы связей и свои поля настраиваются в «Схеме проекта».<br><br>
    <b>Холст.</b> Колесо — панорама, <span class="kbd">Ctrl</span>+колесо или пинч — зум к курсору, <span class="kbd">Space</span>+тяга или средняя кнопка — панорама.
    <ul style="margin:6px 0;padding-left:18px">
      <li>тяга от круглого порта на краю узла к другому узлу — новая связь (<span class="kbd">Shift</span> — вторым типом связи);</li>
      <li>клик по стрелке — тип связи, подпись, разворот, удаление;</li>
      <li>тяга по пустому месту — выделение рамкой, <span class="kbd">Shift</span> — добавить к выделению;</li>
      <li>двойной клик по пустому месту — новый узел, по узлу — переименование на месте;</li>
      <li>правая кнопка — контекстное меню; <span class="kbd">Ctrl+G</span> — обвести выделенное областью;</li>
      <li>раскладка: «Авто» считает колонки по глубине зависимостей, «Свободно» — как поставил. Перетащил узел в авто-режиме — он закрепляется (📌).</li>
    </ul>
    <b>Страницы.</b> ＋ в сайдбаре: холст, таблица, канбан или дашборд. У каждой свой фильтр — например «только категория X» или «только с блокерами». Порядок меняется перетаскиванием.<br><br>
    <b>Таблица.</b> Колонки выбираются кнопкой «Колонки», клик по заголовку — сортировка, группировка — любым полем. Правка прямо в ячейках, <span class="kbd">Shift</span>+клик — множественное выделение.<br><br>
    <b>Канбан.</b> Колонки строятся по любому полю-списку, перетаскивание карточки меняет значение.<br><br>
    <b>Групповые действия.</b> Выделил несколько узлов (можно вместе с заметками и областями — рамкой) — снизу появится панель: статус, категория, тип, выравнивание, дублирование, удаление. Всё выделенное двигается и удаляется вместе.<br><br>
    <b>Клавиши.</b> <span class="kbd">Ctrl+K</span> поиск и команды · <span class="kbd">Ctrl+Z</span> отмена · <span class="kbd">Ctrl+C</span>/<span class="kbd">Ctrl+V</span> копировать/вставить узлы (в т.ч. между проектами) · <span class="kbd">Ctrl+D</span> дублировать ·
    <span class="kbd">Ctrl+A</span> выделить всё · <span class="kbd">N</span> новый узел · <span class="kbd">Del</span> удалить · стрелки — сдвиг ·
    <span class="kbd">Ctrl+S</span> выгрузить JSON.<br><br>
    <b>Картинка холста.</b> На холсте — меню «⤓ Картинка»: экспорт карты в <b>PNG</b> (2×) или <b>SVG</b> для презентаций и слайдов.<br><br>
    <b>Тёмная тема.</b> Переключатель в левом нижнем углу; выбор запоминается.<br><br>
    <b>Хранение и безопасность.</b> Проекты лежат в этом браузере (IndexedDB) и сохраняются сами; позиция камеры на холсте тоже запоминается. В «Экспорт и импорт» — JSON, бэкап всех проектов, CSV, Markdown, PNG/SVG и <b>viewer.html</b> (самодостаточный файл только для просмотра). Там же — <b>снимки версий</b> (точки отката) и <b>проверка проекта</b> (битые связи, циклы, дубли). Удалённые проекты попадают в «Удалённые» и восстанавливаются.
  </div>
  <div class="mfoot"><button class="btn pri" data-a="c">Понятно</button></div>`,
    b => b.querySelector('[data-a=c]').onclick = closeModal);
}
$('navHelp').onclick = showHelp;

/* ---------- тёмная тема ---------- */
function applyTheme(dark) {
  document.body.classList.toggle('dark', !!dark);
  const el = $('navTheme'); if (el) el.querySelector('.nm').textContent = dark ? 'Светлая тема' : 'Тёмная тема';
  if (typeof drawMini === 'function' && P && UI.page && isSpatial(curPage())) try { drawMini(); } catch (e) {}
}
function toggleTheme() {
  const dark = !document.body.classList.contains('dark');
  applyTheme(dark);
  if (!VIEWER) dbPut(META, {k: 'theme', v: dark ? 'dark' : 'light'});
}
// Переключатель темы переехал в меню аккаунта: в подвале боковой панели его
// видел только тот, у кого уже открыт проект.

/* ==========================================================================
   СТАРТ
   ========================================================================== */
/* ==========================================================================
   ФАЙЛЫ
   --------------------------------------------------------------------------
   Синхронизация проекта с файлом на диске и папка-хранилище убраны в 2.1.
   Хранилище теперь одно — сервер, а две параллельные истины («в файле новее»
   против «на сервере новее») ставили бы вопрос, на который нечем ответить.

   Файлы остались тем, чем и должны быть: способом вынести доску наружу
   и занести обратно. Экспорт — exportProject / exportMd / csv* / exportViewer,
   импорт — importJson / importCsv, и всё импортированное сразу уезжает
   на сервер, а не оседает в браузере.
   ========================================================================== */
const safeName = s => ((s || 'graph').replace(/[^\wа-яА-ЯёЁ\- ]/g, '').trim().replace(/\s+/g, '_') || 'graph');

/* ==========================================================================
   PWA — установка и оффлайн (service worker)
   ========================================================================== */
let deferredInstall = null;
function refreshInstallUI() {
  const on = !!deferredInstall;
  const a = $('pInstall'), b = $('navInstall');
  if (a) a.classList.toggle('hidden', !on);
  if (b) b.classList.toggle('hidden', !on);
}
async function doInstall() {
  if (!deferredInstall) {
    toast('Установка станет доступна в Chrome/Edge при запуске по http(s) — не по file://');
    return;
  }
  deferredInstall.prompt();
  try { await deferredInstall.userChoice; } catch (e) {}
  deferredInstall = null; refreshInstallUI();
}
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; refreshInstallUI(); });
window.addEventListener('appinstalled', () => { deferredInstall = null; refreshInstallUI(); toast('Graph Studio установлен'); });
if ($('pInstall')) $('pInstall').onclick = doInstall;
if ($('navInstall')) $('navInstall').onclick = doInstall;
// Service worker больше не регистрируется: sw.js теперь kill-switch, см. комментарий в нём.
// Уже установленные воркеры браузер обновит сам при следующем переходе и они снимутся.
// Побочный эффект, который надо знать: без воркера установка как PWA может перестать
// предлагаться. Офлайн-режим всё равно уходит — сервер становится единственным хранилищем.

/* ============ МОСТ В WINDOW ============
   Сборка прячет объявления в область модуля, а тесты (test/smoke.js, test/legacy.js)
   и отладка из консоли обращаются к ним как к глобальным — так этот код и писался.
   Мост ставится ДО boot(), чтобы состояние было видно снаружи с первой миллисекунды.

   Переприсваиваемые переменные отдаются геттерами: простое присваивание положило бы
   в window копию, и после openProject() снаружи был бы виден предыдущий проект.

   Блок СГЕНЕРИРОВАН: scripts/gen-bridge.mjs (npm run bridge). Руками не правьте —
   добавили функцию верхнего уровня, перегенерируйте. */
Object.assign(window, {$, ApiError, BUILD, CLIP_KEY, COLGAP, COLMETA, DBNAME, G, GRID, GRIDBG, INSP_MAX, INSP_MIN, JAM, JAM_FILLS, KIND, LINKS, META, NH, NODES, NW, OBJS, PADX, PADY, PREVIEW_EDGES, PREVIEW_NODES, PULL, ROWGAP, ROWS, SCHEMA_PALETTE, SECT_DEFAULT, SEED, SF, SIDE_FULL, SIDE_RAIL, SNAP, SNAP_CAP, STORE, SUBGAP, TPL, UI, UNDO_BYTES, UNDO_STEPS, VIEWER, accountMenu, activeFilterCount, addFrame, addLink, addNode, addNote, alignSel, allFields, api, applyHi, applyInspW, applyLiveDoc, applySideRail, applyTheme, applyView, autoLayout, backupAll, boardCols, buildCanvasSVG, buildColsMenu, buildFilterMenu, buildGbyMenu, buildPreview, bulkSet, cancelDrag, canvasShell, cardView, catOf, cellHTML, cellValue, centerWorld, clamp, clone, closeInsp, closeModal, cloud, colLabel, confirmBox, connAnchor, connBox, connEndKey, connGeom, connPath, connSide, copySelection, createFieldOption, createFromTemplate, createLane, createSchemaItem, csvCell, csvChecks, csvLinks, csvNodes, ctxMenu, curPage, cvRect, dbAll, dbDel, dbGet, dbPut, deb, deleteSelection, dl, doInstall, doneTool, drawBox, drawHTML, drawMini, drawPath, duplicatePage, duplicateSelection, edgeFor, edgePath, edgePathAuto, edit, editForm, editLanes, emptyBlock, endPtr, esc, exitVersionView, exportCanvasPNG, exportCanvasSVG, exportMd, exportProject, exportViewer, facetCounts, fetchLiveDoc, fieldOf, fingerprint, fitAll, flyTo, fname, fromLegacy, fset, fval, gInval, goHome, gotoPage, hasCycle, hideCtx, home, importCsv, importJson, importText, inlineNote, inlineRename, inspOpen, inspW, isCache, isGraphCv, isJam, isKey, isLegacy, isPinned, isSpatial, itemBox, itemHTML, itemsBBox, jamBase, jamDefaults, jamDelete, jamDuplicate, jamEdit, jamEndAt, jamEraseAt, jamGestureUp, jamInlineText, jamItemById, jamItems, jamPreview, jamRaise, jamRest, jamSnapshot, jamToolDown, jumpToNode, kindName, layoutPage, linkById, live, loadInspW, loadProjects, localProjects, ltOf, makeSnap, matchFilter, mergeJamDocs, midOf, midOfLine, migrateLegacyViews, migrateNodeSizes, modal, nBlockers, nOf, newPage, nextColor, nodeById, nodeHTML, normalize, nowStr, npos, nsize, offBy, onDoubleTap, onDown, onLiveUpdate, onPushState, onSignedOut, openBoard, openDB, openDemo, openFrame, openLink, openLocal, openNode, openPalette, openProject, openServerBoard, openShare, opts, pageById, pageMenu, pageNodes, paintAccount, paintCursors, paintEdges, paintEmptyHint, paintFrames, paintInspFoot, paintItems, paintLanes, paintNodes, paintNodesSafe, paintNotes, paintPeers, paintProps, paintSave, paintVersionBar, palRender, parseCsv, parseRoute, pasteSelection, persistView, pickFile, pillOf, plural, promptBox, ptrs, purgeLocal, purgeProject, qs, qsa, rdp, readView, redo, redoS, refreshInstallUI, refreshProjMeta, renameProject, renderBoard, renderCanvas, renderDash, renderJam, renderPage, renderPageBar, renderPages, renderTable, restoreBundle, restoreLocal, restoreProject, restoreSnap, restoreVersion, ro, routeBoot, safeName, save, saveInspW, saveSects, sceneBoxes, scheduleViewSave, schemaKey, sectOpen, sectionHTML, seedFreePositions, selArr, selItemsArr, selectLink, setNpos, setNsize, setReadonly, setSel, setSelItems, setTool, showAdmin, showCtx, showExport, showHelp, showHistory, showProjects, showSchema, showSnaps, showValidator, snapList, snapNow, snapshot, stalePages, startMove, statusOf, stepOf, stepOut, summarize, svgEsc, syncBulk, toCsv, toWorld, toast, today, toggleSideRail, toggleTheme, trashProject, tx, typeOf, uid, undo, undoPop, undoPush, undoReset, undoS, uniq, updatePositions, uploadAllLocal, uploadCurrentProject, uploadLocalProject, validateProject, view, viewKey, viewVersion, visibleRect, wireCanvas, wireCanvasShell, wireEdit, wireJam, wrapLines, zoomAt});
Object.defineProperty(window, 'P', {get: () => P, set: v => {P = v;}, configurable: true});
Object.defineProperty(window, 'PROJECTS', {get: () => PROJECTS, set: v => {PROJECTS = v;}, configurable: true});
Object.defineProperty(window, 'RO', {get: () => RO, set: v => {RO = v;}, configurable: true});
Object.defineProperty(window, '_g', {get: () => _g, set: v => {_g = v;}, configurable: true});
Object.defineProperty(window, '_uid', {get: () => _uid, set: v => {_uid = v;}, configurable: true});
Object.defineProperty(window, 'cvClearLong', {get: () => cvClearLong, set: v => {cvClearLong = v;}, configurable: true});
Object.defineProperty(window, 'cvNodes', {get: () => cvNodes, set: v => {cvNodes = v;}, configurable: true});
Object.defineProperty(window, 'cvPos', {get: () => cvPos, set: v => {cvPos = v;}, configurable: true});
Object.defineProperty(window, 'deferredInstall', {get: () => deferredInstall, set: v => {deferredInstall = v;}, configurable: true});
Object.defineProperty(window, 'drag', {get: () => drag, set: v => {drag = v;}, configurable: true});
Object.defineProperty(window, 'idb', {get: () => idb, set: v => {idb = v;}, configurable: true});
Object.defineProperty(window, 'laneInfo', {get: () => laneInfo, set: v => {laneInfo = v;}, configurable: true});
Object.defineProperty(window, 'liveFetching', {get: () => liveFetching, set: v => {liveFetching = v;}, configurable: true});
Object.defineProperty(window, 'liveWanted', {get: () => liveWanted, set: v => {liveWanted = v;}, configurable: true});
Object.defineProperty(window, 'palIdx', {get: () => palIdx, set: v => {palIdx = v;}, configurable: true});
Object.defineProperty(window, 'palItems', {get: () => palItems, set: v => {palItems = v;}, configurable: true});
Object.defineProperty(window, 'pasteShift', {get: () => pasteShift, set: v => {pasteShift = v;}, configurable: true});
Object.defineProperty(window, 'pinch', {get: () => pinch, set: v => {pinch = v;}, configurable: true});
Object.defineProperty(window, 'saveT', {get: () => saveT, set: v => {saveT = v;}, configurable: true});
Object.defineProperty(window, 'snapArmed', {get: () => snapArmed, set: v => {snapArmed = v;}, configurable: true});
Object.defineProperty(window, 'snapT', {get: () => snapT, set: v => {snapT = v;}, configurable: true});
Object.defineProperty(window, 'staleT', {get: () => staleT, set: v => {staleT = v;}, configurable: true});
Object.defineProperty(window, 'toastT', {get: () => toastT, set: v => {toastT = v;}, configurable: true});
Object.defineProperty(window, 'undoBytes', {get: () => undoBytes, set: v => {undoBytes = v;}, configurable: true});
Object.defineProperty(window, 'viewSaveT', {get: () => viewSaveT, set: v => {viewSaveT = v;}, configurable: true});

// Модуль серверной части получает нужные функции явно, а не лезет в глобальные:
// иначе он превратился бы во вторую копию этого файла.
//
// Вызов стоит ЗДЕСЬ, а не в начале файла: $, esc, modal и остальные объявлены
// через const, и обращение к ним выше по тексту даёт TDZ-ReferenceError, который
// убивает весь скрипт до boot() — приложение молча не стартует.
cloud.initCloud({ $, esc, modal, closeModal, toast, confirmBox, promptBox, fingerprint, summarize, jamBase });

// Модуль главной получает ровно то, что ему нужно, — и ни одной внутренности
// редактора сверх этого. Иначе он превратился бы во вторую копию этого файла.
home.initHome({
  esc, modal, closeModal, toast, confirmBox, promptBox, showCtx, nOf, NODES, LINKS, TPL, cloud,
  goTo: (path, replace) => cloud.goTo(path, replace),
  isDark: () => document.body.classList.contains('dark'),
  toggleTheme,
  setBrowserTitle: t => { document.title = t; },
  showHelp, showAdmin, importJson,
  localProjects, openBoard, openLocal, uploadLocal: uploadCurrentProject, uploadAllLocal,
  restoreLocal, purgeLocal, createFromTemplate, openDemo, onSignedOut, backupAll,
});
home.wireHead();

// Живой канал знает только, что делать с приехавшим: применить чужую правку,
// перерисовать аватары, перерисовать курсоры. Про доски и адреса он не знает ничего.
live.initLive({
  onUpdate: onLiveUpdate,
  onPeers: paintPeers,
  onCursors: paintCursors,
  onError: msg => toast('Живой канал: ' + msg),
});

(async function boot() {
  if (VIEWER) {
    document.body.classList.add('viewer');
    P = normalize(SEED.project || SEED);
    document.title = P.name;
    $('projBtn').style.pointerEvents = 'none';
    UI.page = (P.pages[0] || {}).id;
    renderPages(); renderPage(); paintSave();
    return;
  }
  try { idb = await openDB(); } catch (e) { alert('Не удалось открыть локальную базу: ' + e.message); return; }
  try { const th = await dbGet(META, 'theme'); if (th && th.v === 'dark') applyTheme(true); } catch (e) {}
  await loadInspW();
  await loadProjects();

  // Кто мы на сервере. Сервера может не быть вообще (сеть отвалилась, открыт
  // собранный файл) — это НЕ ошибка: локальные проекты обязаны открываться всегда.
  await cloud.loadAccount();
  paintAccount();

  // Адрес мог указывать на конкретную доску, ссылку-доступ или приглашение.
  // Открытая ссылка обязана вести туда, куда обещает.
  const routed = await routeBoot();
  if (routed) return;

  // Дальше — главная. Приложение больше НЕ открывает молча последний проект:
  // человек попадал сразу в чужую (свою вчерашнюю) доску и не понимал, где он
  // и что здесь ещё есть. Список досок — первое, что видно.
  const live = PROJECTS.filter(p => !p.deleted);
  if (cloud.CLOUD.account) {
    home.showHome('all');
  } else if (live.length) {
    // Сервер не знает нас, но локальные проекты из старой версии есть —
    // показываем их, а не пустую витрину.
    home.showHome('local');
    if (cloud.CLOUD.online === false) toast('Сервер недоступен — открыты локальные копии');
  } else {
    home.showLanding();
  }
  const seen = await dbGet(META, 'seen');
  if (!seen && live.length) {await dbPut(META, {k: 'seen', v: 1});}

  // IndexedDB по умолчанию best-effort: браузер вправе вытеснить её при нехватке места
  // или при чистке сайтовых данных. Пока это единственная копия проектов — просим закрепить.
  try {
    if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) {
      await navigator.storage.persist();
    }
  } catch (e) {}

  // Напоминание про резервную копию: данные лежат в одном браузере и больше нигде.
  try {
    const lb = await dbGet(META, 'lastBackup');
    const days = lb && lb.v ? (Date.now() - lb.v) / 864e5 : Infinity;
    if (live.length && days > 14) {
      setTimeout(() => toast('Локальные проекты есть только в этом браузере. Перенесите их на сервер или сделайте копию.'), 2500);
    }
  } catch (e) {}
})();

