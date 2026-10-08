// Меню добавления (Shift+A, правая кнопка по пустому месту, связь, брошенная
// в пустоту). Поиск по всему списку сразу: виды нод, блоки библиотеки
// и «создать новый…». Список собирает FlowView — меню о модели не знает.
import {useEffect, useMemo, useRef, useState} from 'react';

const norm = s => String(s || '').toLowerCase().replace(/ё/g, 'е');

export default function AddMenu({x, y, title, items, onClose}) {
  const [q, setQ] = useState('');
  const [cur, setCur] = useState(0);
  const inp = useRef(null), list = useRef(null);
  useEffect(() => { const t = setTimeout(() => inp.current && inp.current.focus(), 0); return () => clearTimeout(t); }, []);
  const shown = useMemo(() => {
    const words = norm(q).split(/\s+/).filter(Boolean);
    return items.filter(it => {
      const hay = norm(it.label + ' ' + (it.hint || '') + ' ' + (it.group || ''));
      return words.every(w => hay.includes(w));
    }).slice(0, 80);
  }, [q, items]);
  useEffect(() => setCur(0), [q]);
  useEffect(() => {
    const el = list.current && list.current.querySelector('.fl-ai.on');
    if (el && el.scrollIntoView) el.scrollIntoView({block: 'nearest'});
  }, [cur]);
  const pick = it => { if (!it) return; onClose(); it.run(); };
  const onKey = e => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setCur(c => Math.min(shown.length - 1, c + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCur(c => Math.max(0, c - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(shown[cur]); }
  };
  let lastGroup = null;
  return (
    <div className="fl-add fl-nowheel" style={{left: x, top: y}} onPointerDown={e => e.stopPropagation()}
         onContextMenu={e => e.preventDefault()}>
      {title ? <div className="fl-add-t">{title}</div> : null}
      <input ref={inp} className="fl-add-q" placeholder="Найти блок или вид ноды…" value={q}
             onChange={e => setQ(e.target.value)} onKeyDown={onKey}/>
      <div className="fl-add-l" ref={list}>
        {shown.length ? shown.map((it, i) => {
          const g = it.group !== lastGroup ? (lastGroup = it.group) : null;
          return [
            g ? <div className="fl-ag" key={'g' + i}>{g}</div> : null,
            <div key={it.key} className={'fl-ai' + (i === cur ? ' on' : '')} onMouseEnter={() => setCur(i)}
                 onClick={() => pick(it)}>
              <i style={{background: it.color || 'var(--line-str)'}}/>
              <span className="fl-ai-l">{it.label}</span>
              {it.hint ? <span className="fl-ai-h">{it.hint}</span> : null}
            </div>,
          ];
        }) : <div className="fl-ai fl-none">Ничего не подходит</div>}
      </div>
    </div>
  );
}
