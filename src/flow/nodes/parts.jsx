// Общие части нод: оболочка, шапка, строки сокетов. Раскладку строк считает
// rules.js (nodeRows) — та же функция, по которой сервер оценивает размеры,
// поэтому здесь только отрисовка, без собственных решений «что в какой строке».
import {useContext} from 'react';
import Socket from './Socket.jsx';
import {FlowCtx} from '../ctx.js';

export function cls(data, selected, extra) {
  return ['fl-node', 'fl-k-' + data.k, extra, selected && 'fl-sel', data.muted && 'fl-muted',
    data.off && 'fl-off', data.collapsed && 'fl-col', data.ov && 'fl-ov', data.ovfill && 'fl-ovfill'].filter(Boolean).join(' ');
}

// Правка «на месте»: поле поверх подписи. Фиксируется на Enter и уходе фокуса,
// Esc отменяет. Класс nodrag — иначе нажатие в поле начинало бы тащить ноду.
export function InlineEdit({id, value, area, cls}) {
  const fx = useContext(FlowCtx);
  const done = (e, ok) => { if (fx) fx.renameDone(id, ok ? e.target.value : null); };
  const p = {className: 'nodrag nopan fl-inl ' + (cls || ''), defaultValue: value || '', autoFocus: true,
    onFocus: e => e.target.select(), onBlur: e => done(e, true), onPointerDown: e => e.stopPropagation(),
    onKeyDown: e => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); done(e, false); }
      else if (e.key === 'Enter' && (!area || e.ctrlKey || e.metaKey)) { e.preventDefault(); done(e, true); }
    }};
  return area ? <textarea {...p}/> : <input type="text" {...p}/>;
}

// Шапка. У проверки в неё же встаёт строка порядка (▶ вход и выход): подписей
// у этой строки нет, а шапке нужна высота под название в две строки — так
// высота ноды остаётся прежней (rules.nodeSize), а название не обрезается.
export function Header({id, data, top}) {
  const fx = useContext(FlowCtx);
  return (
    <div className={'fl-hd' + (top ? ' fl-hd2' : '')} title={data.kname ? data.kname + ': ' + (data.title || '') : undefined}
         onDoubleClick={e => { if (fx && !data.ro) { e.stopPropagation(); fx.rename(id); } }}>
      {top && top.l ? <Socket nodeId={id} s={top.l} side="in" color={top.l.color} conn={top.l.conn}/> : null}
      {data.code ? <span className="fl-code">{data.code}</span> : null}
      {data.editing === 'title' ? <InlineEdit id={id} value={data.title}/>
        : <span className="fl-ttl">{data.title || '—'}</span>}
      {(data.badges || []).map((b, i) => <span key={i} className={'fl-bdg ' + (b.c || '')} title={b.title}>{b.t}</span>)}
      {top && top.r ? <Socket nodeId={id} s={top.r} side="out" color={top.r.color} conn={top.r.conn}/> : null}
    </div>
  );
}

// Подпись строки. Тип данных на ноде не пишется — его несёт цвет сокета
// и подсказка при наведении; «bool» и «text» в каждой строке читались как шум.
const label = s => {
  if (s.text) return s.text;
  if (s.kind === 'exec') return s.name || '';
  if (s.kind === 'tbd') return '? ' + s.name;
  return s.name || '';
};
const lcls = s => 'fl-lbl' + (s.kind === 'cond' ? ' fl-who' : '') + (s.miss ? ' fl-miss' : '');

export function Rows({id, rows}) {
  const fx = useContext(FlowCtx);
  return (
    <div className="fl-rows">
      {rows.map((r, i) => (
        <div className="fl-row" key={i}>
          {r.l ? <Socket nodeId={id} s={r.l} side="in" color={r.l.color} conn={r.l.conn}/> : null}
          {r.l ? <span className={lcls(r.l)} title={r.l.tip || r.l.text || r.l.name}>{label(r.l)}</span> : null}
          <span className="fl-sp"/>
          {r.r ? <span className={lcls(r.r) + ' fl-rl' + (r.r.kind === 'tbd' ? ' fl-tbd' : '')} title={r.r.tip || r.r.name}>{label(r.r)}</span> : null}
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
  const r0 = data.rows[0];
  const top = data.k === 'check' && !data.collapsed && r0 && r0.l && r0.l.kind === 'exec' ? r0 : null;
  const style = {width: data.w, '--kc': data.color};
  if (data.ov) style['--ov'] = data.ov;
  return (
    <div className={cls(data, selected)} style={style}>
      <Header id={id} data={data} top={top}/>
      {data.collapsed ? <Folded id={id} rows={data.rows}/> : <>
        <Rows id={id} rows={top ? data.rows.slice(1) : data.rows}/>
        {data.editing === 'body' ? <div className="fl-body fl-body-ed"><InlineEdit id={id} value={data.body} area/></div>
          : data.body != null ? <div className="fl-body" title={data.body}
              onDoubleClick={e => { if (fx && !data.ro) { e.stopPropagation(); fx.rename(id); } }}>{data.body}</div> : null}
      </>}
      {data.plus && !data.ro && !data.collapsed
        ? <button className="fl-plus nodrag" title={data.plus} onClick={e => { e.stopPropagation(); fx.plus(id); }}>+</button> : null}
    </div>
  );
}
