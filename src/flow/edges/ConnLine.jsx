// Линия тянущейся связи. Над неподходящим сокетом она краснеет, а у курсора
// появляется причина отказа («date → money: типы не совпадают») — ровно та,
// что вернул rules.canConnect. Подсказка живёт вне SVG холста: внутри она
// масштабировалась бы вместе с камерой и на мелком зуме была бы нечитаема.
import {useContext, useEffect} from 'react';
import {getBezierPath} from '@xyflow/react';
import {FlowCtx} from '../ctx.js';

export default function ConnLine(p) {
  const fx = useContext(FlowCtx);
  const bad = p.connectionStatus === 'invalid' && !!p.toHandle;
  const reason = bad && fx ? fx.reasonFor(p.fromHandle, p.toHandle) : '';
  useEffect(() => { if (fx) fx.connTip(reason); }, [fx, reason]);
  useEffect(() => () => { if (fx) fx.connTip(''); }, [fx]);
  const [path] = getBezierPath({sourceX: p.fromX, sourceY: p.fromY, sourcePosition: p.fromPosition,
    targetX: p.toX, targetY: p.toY, targetPosition: p.toPosition});
  const color = bad ? '#e0473a' : (fx ? fx.lineColor(p.fromHandle) : '') || 'var(--ink2)';
  return <path d={path} fill="none" className={'fl-cline' + (bad ? ' fl-bad' : '')}
    style={{stroke: color}} strokeWidth={2} strokeDasharray={bad ? '5 4' : undefined}/>;
}
