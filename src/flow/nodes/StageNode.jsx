// Этап — рамка-группа (родительская нода React Flow). Проверки внутри рамки
// исполняются параллельно, если между ними нет связей порядка; порядок этапов —
// цепочка ▶ между рамками и гейтами. Рамка подгоняется под содержимое (fit:1),
// пока её не растянули руками.
import {memo, useContext} from 'react';
import {NodeResizer} from '@xyflow/react';
import Socket from './Socket.jsx';
import {FlowCtx} from '../ctx.js';
import {cls, InlineEdit} from './parts.jsx';
import {SIZE} from '../rules.js';

export default memo(function StageNode({id, data, selected}) {
  const fx = useContext(FlowCtx);
  const s = data.socks || {};
  return (
    <div className={cls(data, selected, 'fl-stage')}>
      {selected && !data.ro ? <NodeResizer minWidth={SIZE.STAGE.MINW} minHeight={SIZE.STAGE.MINH}
        lineClassName="fl-rsz" handleClassName="fl-rszh"
        onResizeEnd={(e, p) => fx && fx.resized(id, p)}/> : null}
      <div className="fl-st-hd" onDoubleClick={e => { if (fx && !data.ro) { e.stopPropagation(); fx.rename(id); } }}>
        {s.in ? <Socket nodeId={id} s={s.in} side="in" color={s.in.color} conn={s.in.conn}/> : null}
        <span className="fl-st-num">{data.code || '·'}</span>
        {data.editing ? <InlineEdit id={id} value={data.title} cls="fl-st-ed"/>
          : <span className="fl-st-name" title={data.title}>{data.title || 'Этап'}</span>}
        {(data.badges || []).map((b, i) => <span key={i} className={'fl-bdg ' + (b.c || '')} title={b.title}>{b.t}</span>)}
        {s.out ? <Socket nodeId={id} s={s.out} side="out" color={s.out.color} conn={s.out.conn}/> : null}
      </div>
      <div className="fl-st-sub">
        {s.cond ? <Socket nodeId={id} s={s.cond} side="in" color={s.cond.color} conn={s.cond.conn}/> : null}
        <span className="fl-st-when">◆ Когда</span>
        <span className="fl-st-point" title={data.body}>{data.body}</span>
      </div>
    </div>
  );
});
