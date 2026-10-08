// Заметка — стикер, как на доске: текст и размер, без сокетов.
import {memo, useContext} from 'react';
import {NodeResizer} from '@xyflow/react';
import {FlowCtx} from '../ctx.js';
import {cls, InlineEdit} from './parts.jsx';

export default memo(function NoteNode({id, data, selected}) {
  const fx = useContext(FlowCtx);
  return (
    <div className={cls(data, selected, 'fl-note')}
         onDoubleClick={e => { if (fx && !data.ro) { e.stopPropagation(); fx.rename(id); } }}>
      {selected && !data.ro ? <NodeResizer minWidth={120} minHeight={60} lineClassName="fl-rsz" handleClassName="fl-rszh"
        onResizeEnd={(e, p) => fx && fx.resized(id, p)}/> : null}
      {data.editing ? <InlineEdit id={id} value={data.body} area cls="fl-note-ed"/>
        : <div className="fl-note-t">{data.body || (data.ro ? '' : 'Двойной клик — написать')}</div>}
    </div>
  );
});
