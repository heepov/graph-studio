// Сокет — ручка React Flow с формой и цветом по виду связи (ТЗ §4.1):
// ▶ треугольник — порядок, ◆ ромб — применимость, ● круг — данные (цвет типа),
// ■ квадрат — вердикт (цвет вердикта).
import {useContext} from 'react';
import {Handle, Position} from '@xyflow/react';
import {FlowCtx} from '../ctx.js';

export default function Socket({nodeId, s, side, color, conn, style}) {
  const fx = useContext(FlowCtx);
  // Подсказка собирается лениво, при наведении: откуда приходит и куда уходит —
  // это обход всех связей, и делать его для каждого сокета на каждую отрисовку
  // значило бы платить за то, что человек никогда не увидит.
  const tip = e => { e.currentTarget.title = fx ? fx.socketTip(nodeId, s.id, side) : ''; };
  return (
    <Handle id={s.id} type={side === 'in' ? 'target' : 'source'}
      position={side === 'in' ? Position.Left : Position.Right}
      isConnectable={!(fx && fx.ro())}
      className={`fl-sock fl-s-${s.kind}${conn ? ' fl-on' : ''}`}
      style={Object.assign({'--sc': color}, style)}
      onPointerEnter={tip}/>
  );
}
