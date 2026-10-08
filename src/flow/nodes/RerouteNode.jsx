// Точка перегиба: вход и выход в одной точке. Принимает тип первой подключённой
// связи и дальше ведёт себя как сокет этого типа (rules.js, rerouteSig).
import {memo} from 'react';
import Socket from './Socket.jsx';
import {cls} from './parts.jsx';

export default memo(function RerouteNode({id, data, selected}) {
  const s = data.socks || {};
  return (
    <div className={cls(data, selected, 'fl-rr')} style={{'--sc': data.color}}>
      {s.in ? <Socket nodeId={id} s={s.in} side="in" color={data.color} conn={s.in.conn}/> : null}
      {s.out ? <Socket nodeId={id} s={s.out} side="out" color={data.color} conn={s.out.conn}/> : null}
    </div>
  );
});
