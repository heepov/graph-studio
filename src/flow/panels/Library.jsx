// Библиотека доски: измерения, источники, проверки, исходы и вердикты — общие
// для всех конвейеров. Отсюда блок перетаскивают на холст (своим жестом на
// указателе, а не HTML5 drag-and-drop: тот не работает пальцем), здесь же
// заводят новый и открывают табличный редактор.
import {useState} from 'react';
import * as R from '../rules.js';

const TABS = [['dims', 'Измер.', 'Измерения'], ['sources', 'Ист.', 'Источники'], ['checks', 'Пров.', 'Проверки'], ['outcomes', 'Исх.', 'Исходы']];
const NEW = {dims: '+ Новое', sources: '+ Новый', checks: '+ Новая', outcomes: '+ Новый'};
const KIND = {dims: 'dim', sources: 'source', checks: 'check', outcomes: 'outcome'};
const STATUS_COLOR = {live: '#2e9d58', contract: '#e6a700', planned: '#e6a700', no_access: '#e0473a', no_source: '#e0473a', unknown: '#9aa1b2'};
const norm = s => String(s || '').toLowerCase().replace(/ё/g, 'е');

export default function Library({fx, flow, lib, sel, ro, gen}) {
  const [tab, setTab] = useState('checks');
  const [q, setQ] = useState('');
  const [free, setFree] = useState(false);
  const placed = new Set(flow.nodes.filter(n => n.k === KIND[tab]).map(n => n.ref));
  const words = norm(q).split(/\s+/).filter(Boolean);
  let list = (lib[tab] || []).slice();
  if (tab === 'checks') list.sort(R.codeCompare);
  list = list.filter(it => {
    if (free && placed.has(it.id)) return false;
    const hay = norm((it.code || '') + ' ' + it.name);
    return words.every(w => hay.includes(w));
  });
  const holes = {};
  if (tab === 'checks') {
    for (const n of flow.nodes) {
      if (n.k !== 'check') continue;
      const h = R.checkHoles(flow, lib, n);
      if (h.unwired.length || h.noAccess.length) holes[n.ref] = 1;
    }
  }
  const meta = it => {
    if (tab === 'dims') return (it.code ? 'ось ' + it.code + ' · ' : '') + it.values.length + ' знач.';
    if (tab === 'sources') return it.fields.length + ' пол.';
    if (tab === 'outcomes') return R.verdictOf(lib, it.verdict).name;
    return '';
  };
  const dot = it => (tab === 'sources' ? STATUS_COLOR[it.status || 'unknown'] || '#9aa1b2'
    : tab === 'outcomes' ? R.verdictOf(lib, it.verdict).color : R.KIND_COLORS[KIND[tab]]);
  return (
    <div className="fl-lib fl-nowheel">
      <div className="fl-ph"><b>Библиотека</b><span className="fl-sp"/>
        <button className="fl-ib" title="Свернуть панель" onClick={() => fx.panel('lib', false)}>‹</button></div>
      <div className="fl-tabs">
        {TABS.map(([k, short, full]) => <button data-tab={k} key={k} className={'fl-tab' + (tab === k ? ' on' : '')} title={full}
          onClick={() => setTab(k)}>{short}<span className="fl-cnt">{(lib[k] || []).length}</span></button>)}
      </div>
      <div className="fl-lq">
        <input type="text" placeholder="Поиск по коду и названию" value={q} onChange={e => setQ(e.target.value)}/>
        <label className="fl-chk" title="Блоки, которых нет на этой странице"><input type="checkbox" checked={free}
          onChange={e => setFree(e.target.checked)}/>не на схеме</label>
      </div>
      <div className="fl-ll">
        {list.map(it => (
          <div key={it.id} className={'fl-li' + (sel && sel.sec === tab && sel.id === it.id ? ' on' : '') + (placed.has(it.id) ? ' fl-placed' : '')}
               data-lib={tab + ':' + it.id}
               onPointerDown={e => fx.libDrag(e, {k: KIND[tab], ref: it.id, label: (it.code ? it.code + ' ' : '') + it.name})}
               onClick={() => fx.pickLib(tab, it.id)}>
            <i style={{background: dot(it)}}/>
            {it.code ? <span className="fl-lcode">{it.code}</span> : null}
            <span className="fl-lname" title={it.name}>{it.name}</span>
            {holes[it.id] ? <span className="fl-b-red fl-ldot" title="Вход без источника или источник без доступа"/> : null}
            <span className="fl-lmeta">{meta(it)}</span>
          </div>
        ))}
        {!list.length ? <div className="fl-lempty">{(lib[tab] || []).length ? 'Ничего не подходит' : 'Пока пусто — заведите первый блок'}</div> : null}
        {tab === 'outcomes' ? <Verdicts fx={fx} lib={lib} ro={ro} gen={gen}/> : null}
      </div>
      <div className="fl-lf">
        <button className="btn sm" disabled={ro} onClick={() => fx.createBlock(tab)}>{NEW[tab]}</button>
        <span className="fl-sp"/>
        <button className="btn sm" data-a="table" onClick={() => fx.openTable(tab === 'sources' ? 'sources' : 'checks')}>Таблица</button>
      </div>
    </div>
  );
}

// Вердикты — виды последствий. Ключ генерируется и не меняется: на него
// ссылаются проверки, исходы и сокеты v:<ключ> на всех схемах.
function Verdicts({fx, lib, ro, gen}) {
  return (
    <div className="fl-vd">
      <div className="fl-vh"><b>Вердикты</b><span className="fl-sp"/>
        <button className="fl-ib" disabled={ro} title="Новый вердикт" onClick={() => fx.createBlock('verdicts')}>+</button></div>
      {lib.verdicts.map(v => (
        <div key={v.key + ':' + gen} className="fl-vr" data-verdict={v.key}>
          <input type="color" value={v.color} disabled={ro} onChange={e => fx.set(() => { v.color = e.target.value; })}/>
          <input type="text" defaultValue={v.name} disabled={ro} onInput={e => fx.text(v, 'name', e.target.value)}/>
          <button className="fl-ib fl-x" disabled={ro} title="Удалить вердикт" onClick={() => fx.dropVerdict(v.key)}>×</button>
        </div>
      ))}
    </div>
  );
}
