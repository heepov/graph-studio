// «Список» — тот же конвейер без проводов: этапы разделами в порядке исполнения,
// в строке проверки — для кого она, откуда данные и куда ведут вердикты. Читается
// как исходный xls, только живой: клик открывает проверку в инспекторе (там же
// форма связей), двойной клик — показывает её на схеме.
//
// Схема под списком не размонтируется: выделение, отмена и инспектор у них общие.
import {useState} from 'react';
import * as R from '../rules.js';

const norm = s => String(s || '').toLowerCase().replace(/ё/g, 'е');
const CHECKS = n => (n % 10 === 1 && n % 100 !== 11 ? 'проверка' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'проверки' : 'проверок');

// Исход, в который ведёт вердикт, — сквозь точки перегиба.
function outcomeOf(flow, lib, nodeId, key) {
  const seen = new Set();
  let e = flow.edges.find(x => x.s === nodeId && x.sh === 'v:' + key);
  while (e && !seen.has(e.t)) {
    seen.add(e.t);
    const t = flow.nodes.find(x => x.id === e.t);
    if (!t) return null;
    if (t.k === 'outcome') { const it = R.itemOf(lib, t); return it ? it.name : t.ref; }
    if (t.k !== 'reroute') return null;
    e = flow.edges.find(x => x.s === t.id);
  }
  return null;
}

function Row({fx, n, flow, lib, act, sel, ro}) {
  const it = R.itemOf(lib, n) || {code: '', name: n.ref, inputs: [], verdicts: []};
  const off = act && !act.nodes.has(n.id);
  const who = R.whoText(flow, lib, n.id);
  return (
    <div className={'fl-lrow' + (sel ? ' on' : '') + (off ? ' fl-loff' : '') + (n.muted ? ' fl-lmuted' : '')} data-row={n.id}
         onClick={() => fx.selectNode(n.id)} onDoubleClick={() => fx.showOnScheme(n.id)}
         title="Клик — открыть в инспекторе, двойной клик — показать на схеме">
      <span className="fl-lcode">{it.code || '—'}</span>
      <span className="fl-lmain"><b>{it.name}</b>{it.how ? <small>{it.how}</small> : null}</span>
      <span className={'fl-lwho' + (who === 'для всех' ? ' fl-lall' : '')}>{who}</span>
      <span className="fl-lsrc">
        {(it.inputs || []).map(inp => {
          const src = R.inputSources(flow, lib, n.id, 'in:' + inp.id);
          return <span key={inp.id} className={src.length ? '' : 'fl-miss'}>
            {src.length ? [...new Set(src.map(x => (x.item ? x.item.name : x.source)))].join(' → ') : inp.name + ': нет источника'}</span>;
        })}
        {!(it.inputs || []).length ? <span className="fl-mut">входов нет</span> : null}
      </span>
      <span className="fl-lver">
        {(it.verdicts || []).map(k => {
          const v = R.verdictOf(lib, k), to = outcomeOf(flow, lib, n.id, k);
          return <span key={k} className="fl-vpill" style={{'--vc': v.color}} title={to ? `${v.name} → ${to}` : `${v.name} — никуда не ведёт`}>
            <i/>{to || v.name}</span>;
        })}
        {it.verdictTbd ? <span className="fl-vpill fl-vtbd">? не определён</span> : null}
      </span>
    </div>
  );
}

export default function ListView({fx, flow, lib, act, hideOff, selId, ro}) {
  const [q, setQ] = useState('');
  const N = new Map(flow.nodes.map(n => [n.id, n]));
  const {stages, gateBefore} = R.stageOrder(flow);
  const words = norm(q).split(/\s+/).filter(Boolean);
  const visible = n => {
    if (hideOff && act && !act.nodes.has(n.id)) return false;
    if (!words.length) return true;
    const it = R.itemOf(lib, n) || {};
    const hay = norm([it.code, it.name, it.how, R.sourceText(flow, lib, n)].join(' '));
    return words.every(w => hay.includes(w));
  };
  const byCode = (a, b) => R.codeCompare(R.itemOf(lib, a), R.itemOf(lib, b));
  const checksIn = sid => flow.nodes.filter(n => n.k === 'check' && n.parent === sid).sort(byCode);
  const loose = flow.nodes.filter(n => n.k === 'check' && !(n.parent && N.get(n.parent))).sort(byCode);
  const total = flow.nodes.filter(n => n.k === 'check').length;
  const section = (key, head, list, sid) => {
    const rows = list.filter(visible);
    if (words.length && !rows.length) return null;
    return (
      <section key={key} className="fl-lst" data-stage={sid || ''}>
        {head}
        {rows.length ? rows.map(n => <Row key={n.id} fx={fx} n={n} flow={flow} lib={lib} act={act} sel={n.id === selId} ro={ro}/>)
          : <div className="fl-lempty">{list.length ? 'Все проверки этапа скрыты профилем' : 'В этапе пока нет проверок'}</div>}
      </section>
    );
  };
  return (
    <div className="fl-list fl-nowheel" data-view="list">
      <div className="fl-lhead">
        <input type="text" className="fl-lq" placeholder="Найти проверку: код, название, источник" value={q}
          onChange={e => setQ(e.target.value)} onKeyDown={e => e.stopPropagation()}/>
        <span className="fl-mut" title="Клик по строке — открыть в инспекторе, двойной клик — показать на схеме">{total} {CHECKS(total)}</span>
      </div>
      {!total && !stages.length ? <div className="fl-lempty fl-lempty-big">На схеме пока нет проверок.
        {!ro ? <> <button className="btn sm pri" onClick={() => fx.createAt('check')}>+ Проверка</button></> : null}</div> : null}
      {stages.map(sid => {
        const st = N.get(sid), d = st.data || {};
        const list = checksIn(sid);
        const head = <>
          {(gateBefore.get(sid) || []).map(g => <div key={g} className="fl-lgate" onClick={() => fx.selectNode(g)}>
            <i>⤷</i> Условие перехода: {((N.get(g) || {}).data || {}).text || '—'}</div>)}
          <header className={'fl-lst-h' + (selId === sid ? ' on' : '')} onClick={() => fx.selectNode(sid)}>
            <span className="fl-st-num">{d.num || '·'}</span><b>{d.name || 'Этап'}</b>
            <span className="fl-lst-m">{list.length} {CHECKS(list.length)} · {R.whoText(flow, lib, sid)}{d.point ? ' · ' + d.point : ''}</span>
            {!ro ? <button className="btn sm" data-a="list-add" onClick={e => { e.stopPropagation(); fx.newCheckIn(sid); }}>+ Проверка</button> : null}
          </header>
        </>;
        return section(sid, head, list, sid);
      })}
      {loose.length ? section('__loose', <header className="fl-lst-h"><b>Вне этапов</b>
        <span className="fl-lst-m">{loose.length} {CHECKS(loose.length)} — в выгрузке пойдут отдельным этапом</span></header>, loose) : null}
    </div>
  );
}
