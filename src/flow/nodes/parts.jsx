// Общие части нод: оболочка, шапка, строки сокетов. Раскладку строк считает
// rules.js (nodeRows) — та же функция, по которой сервер оценивает размеры,
// поэтому здесь только отрисовка, без собственных решений «что в какой строке».
import {useContext} from 'react';
import Socket from './Socket.jsx';
import {FlowCtx} from '../ctx.js';

export function cls(data, selected, extra) {
  return ['fl-node', 'fl-k-' + data.k, extra, selected && 'fl-sel', data.muted && 'fl-muted',
    data.off && 'fl-off', data.collapsed && 'fl-col', data.ovl].filter(Boolean).join(' ');
}

export function Header({id, data}) {
  const fx = useContext(FlowCtx);
  return (
    <div className="fl-hd" style={{background: data.muted ? undefined : data.color}}
         onDoubleClick={e => { if (fx && !data.ro) { e.stopPropagation(); fx.rename(id); } }}>
      {data.code ? <span className="fl-code">{data.code}</span> : null}
      <span className="fl-ttl" title={data.title}>{data.title || '—'}</span>
      {(data.badges || []).map((b, i) => <span key={i} className={'fl-bdg ' + (b.c || '')} title={b.title}>{b.t}</span>)}
    </div>
  );
}

const label = s => {
  if (s.kind === 'exec') return s.name || '';
  if (s.kind === 'tbd') return '? ' + s.name;
  return s.name || '';
};

export function Rows({id, rows}) {
  const fx = useContext(FlowCtx);
  return (
    <div className="fl-rows">
      {rows.map((r, i) => (
        <div className="fl-row" key={i}>
          {r.l ? <Socket nodeId={id} s={r.l} side="in" color={r.l.color} conn={r.l.conn}/> : null}
          {r.l ? <span className="fl-lbl" title={r.l.name}>{label(r.l)}{r.l.kind === 'data' && r.l.type
            ? <span className="fl-ty">{r.l.type}</span> : null}</span> : null}
          <span className="fl-sp"/>
          {r.r ? <span className={'fl-lbl fl-rl' + (r.r.kind === 'tbd' ? ' fl-tbd' : '')} title={r.r.name}>
            {r.r.kind === 'data' && r.r.type ? <span className="fl-ty">{r.r.type}</span> : null}{label(r.r)}</span> : null}
          {r.r && r.r.kind !== 'tbd' ? <Socket nodeId={id} s={r.r} side="out" color={r.r.color} conn={r.r.conn}/> : null}
          {r.add ? <button className="fl-addin nodrag" disabled={!fx || fx.ro()}
            onClick={e => { e.stopPropagation(); fx.plus(id); }}>+ вход</button> : null}
        </div>
      ))}
    </div>
  );
}

// Свёрнутая нода: все сокеты собраны в одну точку на каждой стороне —
// связи остаются видны и приходят в шапку.
export function Folded({id, rows}) {
  const ins = [], outs = [];
  for (const r of rows) { if (r.l) ins.push(r.l); if (r.r && r.r.kind !== 'tbd') outs.push(r.r); }
  return (
    <div className="fl-fold">
      {ins.map((s, i) => <Socket key={s.id} nodeId={id} s={s} side="in" color={s.color} conn={s.conn} style={i ? {opacity: 0} : null}/>)}
      {outs.map((s, i) => <Socket key={s.id} nodeId={id} s={s} side="out" color={s.color} conn={s.conn} style={i ? {opacity: 0} : null}/>)}
    </div>
  );
}

// Обычный блок: шапка, строки сокетов, тело. Им рисуются измерение, источник,
// проверка, исход, гейт, «один из» и показатель — различаются они данными,
// которые собирает FlowView, а не разметкой.
export function Block({id, data, selected}) {
  const fx = useContext(FlowCtx);
  return (
    <div className={cls(data, selected)} style={{width: data.w}}>
      <Header id={id} data={data}/>
      {data.collapsed ? <Folded id={id} rows={data.rows}/> : <>
        <Rows id={id} rows={data.rows}/>
        {data.body != null ? <div className="fl-body" title={data.body}>{data.body}</div> : null}
      </>}
      {data.plus && !data.ro && !data.collapsed
        ? <button className="fl-plus nodrag" title={data.plus} onClick={e => { e.stopPropagation(); fx.plus(id); }}>+</button> : null}
    </div>
  );
}
