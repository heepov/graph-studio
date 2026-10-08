// Действия библиотеки и инспектора. Отдельно от FlowView: это правка данных
// с подтверждениями, а не жесты холста. Получает набор функций холста (kit)
// и отдаёт обработчики, которые панели зовут через контекст.
//
// Блок библиотеки общий для всех конвейеров доски, поэтому всё, что рвёт связи
// (удаление входа, смена типа поля, снятый вердикт), считает связи на ВСЕХ
// страницах-конструкторах и удаляет их в той же операции отмены.
import * as R from './rules.js';
import * as M from './model.js';

const SEC_KIND = {dims: 'dim', sources: 'source', checks: 'check', outcomes: 'outcome'};
const LINKS = n => n % 10 === 1 && n % 100 !== 11 ? 'связь' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'связи' : 'связей';

export function makeActions(kit) {
  const {ctx, cur, edit, bump, setGen} = kit;
  // Подтверждение нужно только когда есть что терять: связей нет — делаем сразу.
  const guarded = (count, text, run) => (count ? ctx.confirmBox(text, run, 'Удалить') : run());
  const a = {
    // Текст — без снимка на каждую букву: snapshot() у приложения с дебаунсом,
    // одна пауза в наборе — один шаг отмены.
    text(obj, k, v) {
      if (ctx.ro()) return;
      ctx.snapshot(); obj[k] = v; ctx.save(); bump();
    },
    textSet(fn) {
      if (ctx.ro()) return;
      ctx.snapshot(); fn(); ctx.save(); bump(); setGen();
    },
    set(fn, opt) {
      edit(c => { fn(c); if (opt && opt.refit) M.refit(c.flow, c.lib, opt.refit, kit.sizeOf); });
    },
    usages: (sec, id) => M.usages(cur().P, sec, id),
    fieldReaders: id => M.fieldReaders(cur().P, id),

    toggleVerdict(it, key, on) {
      if (on) { edit(() => { it.verdicts = (it.verdicts || []).concat(key); }); return; }
      const list = M.socketEdges(cur().P, 'check', it.id, 'v:' + key, 'out');
      guarded(list.length, `От вердикта «${R.verdictOf(cur().lib, key).name}» уходит ${list.length} ${LINKS(list.length)} на схемах доски. Снять вердикт вместе с ними?`,
        () => edit(() => { it.verdicts = (it.verdicts || []).filter(v => v !== key); M.dropEdges(list); }));
    },
    addInput(it) {
      edit(() => { it.inputs.push({id: M.newId('in', new Set(it.inputs.map(x => x.id))), name: 'Вход ' + (it.inputs.length + 1), type: 'text'}); });
    },
    addField(it) {
      edit(() => { it.fields.push({id: M.newId('f_', new Set(it.fields.map(x => x.id))), name: 'Поле ' + (it.fields.length + 1), type: 'text', desc: ''}); });
    },
    addValue(it) {
      edit(() => { it.values.push({id: M.newId('v_', new Set(it.values.map(x => x.id))), code: '', name: 'Значение ' + (it.values.length + 1), desc: '', wave: 1}); });
    },
    // Смена типа входа или поля рвёт несовместимые связи — с подтверждением.
    retype(kind, it, listKey, entry, type) {
      const side = kind === 'check' ? 'in' : 'out', handle = (kind === 'check' ? 'in:' : 'out:') + entry.id;
      const bad = M.incompatibleAfter(cur().P, kind, it.id, handle, side, x => {
        const e = x[listKey].find(y => y.id === entry.id); if (e) e.type = type;
      });
      guarded(bad.length, `Тип «${type}» не подходит ${bad.length} ${LINKS(bad.length)} на схемах доски. Сменить тип и разорвать их?`,
        () => edit(() => { entry.type = type; M.dropEdges(bad); }));
    },
    dropSocket(kind, it, listKey, entry) {
      const handle = (kind === 'check' ? 'in:' : kind === 'source' ? 'out:' : 'val:') + entry.id;
      const list = M.socketEdges(cur().P, kind, it.id, handle, kind === 'check' ? 'in' : 'out');
      const what = kind === 'check' ? 'входу' : kind === 'source' ? 'полю' : 'значению';
      guarded(list.length, `К этому ${what} ведёт ${list.length} ${LINKS(list.length)} на схемах доски. Удалить вместе с ними?`,
        () => edit(() => { it[listKey] = it[listKey].filter(x => x.id !== entry.id); M.dropEdges(list); }));
    },

    // «Один из» и показатель — данные ноды, а не библиотеки: их связи только здесь.
    anyofType(n, t) {
      const {flow, lib} = cur();
      const was = (n.data || {}).type;
      n.data.type = t;
      const bad = flow.edges.filter(e => (e.t === n.id || e.s === n.id) && !R.canConnect({nodes: flow.nodes, edges: flow.edges.filter(x => x !== e)}, lib,
        {source: e.s, sourceHandle: e.sh, target: e.t, targetHandle: e.th}).ok).map(e => e.id);
      n.data.type = was;
      guarded(bad.length, `Тип «${t}» не подходит ${bad.length} ${LINKS(bad.length)}. Сменить и разорвать их?`,
        () => edit(x => { n.data.type = t; M.deleteEdges(x.flow, bad); }));
    },
    anyofN(n, k) {
      const {flow} = cur();
      const bad = flow.edges.filter(e => e.t === n.id && /^in:\d+$/.test(e.th) && +e.th.slice(3) >= k).map(e => e.id);
      guarded(bad.length, `У убираемых входов ${bad.length} ${LINKS(bad.length)}. Убрать вместе с ними?`,
        () => edit(x => { n.data.n = k; M.deleteEdges(x.flow, bad); M.refit(x.flow, x.lib, [n.parent].filter(Boolean), kit.sizeOf); }));
    },
    calcInput(n) {
      edit(() => { const l = n.data.inputs = n.data.inputs || []; l.push({id: M.newId('i', new Set(l.map(x => x.id))), name: 'Вход ' + (l.length + 1), type: 'number'}); });
    },
    calcRetype(n, inp, t) {
      const {flow, lib} = cur();
      const was = inp.type; inp.type = t;
      const bad = flow.edges.filter(e => e.t === n.id && e.th === 'in:' + inp.id && !R.canConnect({nodes: flow.nodes, edges: flow.edges.filter(x => x !== e)}, lib,
        {source: e.s, sourceHandle: e.sh, target: e.t, targetHandle: e.th}).ok).map(e => e.id);
      inp.type = was;
      guarded(bad.length, `Тип «${t}» не подходит ${bad.length} ${LINKS(bad.length)}. Сменить и разорвать?`,
        () => edit(x => { inp.type = t; M.deleteEdges(x.flow, bad); }));
    },
    calcDrop(n, inp) {
      const {flow} = cur();
      const bad = flow.edges.filter(e => e.t === n.id && e.th === 'in:' + inp.id).map(e => e.id);
      guarded(bad.length, `К входу ведёт ${bad.length} ${LINKS(bad.length)}. Удалить вместе с ними?`,
        () => edit(x => { n.data.inputs = n.data.inputs.filter(y => y !== inp); M.deleteEdges(x.flow, bad); }));
    },

    createBlock(sec) {
      let made = null;
      edit(c => { made = M.createBlock(c.lib, sec); });
      if (made && sec !== 'verdicts') kit.pickLib(sec, made.id, true);
    },
    dupBlock(sec, id) {
      let made = null;
      edit(c => { made = M.duplicateBlock(c.lib, sec, id); });
      if (made) kit.pickLib(sec, made.id, true);
    },
    delBlock(sec, id) {
      const {P, lib} = cur();
      const it = (lib[sec] || []).find(x => x.id === id); if (!it) return;
      const uses = M.usages(P, sec, id);
      let edges = 0;
      for (const pg of M.flowPages(P)) {
        const ids = new Set(pg.flow.nodes.filter(n => n.k === SEC_KIND[sec] && n.ref === id).map(n => n.id));
        edges += pg.flow.edges.filter(e => ids.has(e.s) || ids.has(e.t)).length;
      }
      const pages = new Set(uses.map(u => u.page)).size;
      const text = uses.length
        ? `«${it.name}» стоит на ${pages} ${pages === 1 ? 'схеме' : 'схемах'}. Удалить блок вместе с ${uses.length} ${uses.length === 1 ? 'нодой' : 'нодами'} и ${edges} ${edges === 1 ? 'связью' : 'связями'}?`
        : `Удалить «${it.name}» из библиотеки?`;
      ctx.confirmBox(text, () => { edit(c => M.deleteBlock(c.P, sec, id)); kit.pickLib(null); }, 'Удалить');
    },
    dropVerdict(key) {
      const {lib} = cur();
      const n = M.verdictUses(lib, key);
      if (n) { ctx.toast(`Вердикт используется: ${n} — сначала снимите его с проверок и исходов`); return; }
      if (lib.verdicts.length < 2) { ctx.toast('Последний вердикт удалить нельзя'); return; }
      edit(c => { c.lib.verdicts = c.lib.verdicts.filter(v => v.key !== key); });
      setGen();
    },
  };
  return a;
}
