// Связь конструктора: кривая Безье цветом сокета-источника (тип данных,
// фиолетовая применимость, цвет вердикта; порядок — цветом темы).
// «Кроме» (neg) — пунктир со знаком ⊘ посередине. Выделенная — вдвое толще.
import {memo} from 'react';
import {BaseEdge, getBezierPath} from '@xyflow/react';

export default memo(function TypedEdge(p) {
  const d = p.data || {};
  const [path, lx, ly] = getBezierPath({sourceX: p.sourceX, sourceY: p.sourceY, sourcePosition: p.sourcePosition,
    targetX: p.targetX, targetY: p.targetY, targetPosition: p.targetPosition});
  const base = d.kind === 'exec' ? 2.2 : d.kind === 'verdict' ? 1.8 : 1.6;
  const cl = ['fl-e', 'fl-e-' + d.kind, d.neg && 'fl-neg', d.off && 'fl-off', d.hl && 'fl-hl', d.dim && 'fl-dim',
    p.selected && 'fl-esel'].filter(Boolean).join(' ');
  return (
    <>
      <BaseEdge id={p.id} path={path} className={cl} interactionWidth={14}
        style={{stroke: d.color || undefined, strokeWidth: base * (p.selected ? 2 : 1),
          strokeDasharray: d.neg ? '7 5' : d.kind === 'exec' ? undefined : undefined}}/>
      {d.neg ? (
        <g className={'fl-negmark' + (d.off ? ' fl-off' : '')} transform={`translate(${lx},${ly})`}>
          <circle r="7.5" style={{stroke: d.color}}/>
          <path d="M-4.2,4.2 L4.2,-4.2" style={{stroke: d.color}}/>
        </g>
      ) : null}
    </>
  );
});
