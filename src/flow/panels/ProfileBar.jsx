// Полоса конструктора в панели страницы приложения (#flowBar): профиль клиента,
// сводка по нему, оверлей, видимость связей, раскладка и поиск.
//
// Активный профиль — личное состояние (localStorage), а не документ: иначе
// переключение профиля одним человеком меняло бы экран другому. В документе
// живут только сохранённые профили и профиль по умолчанию — для ссылки и viewer.
import {useEffect, useRef, useState} from 'react';
import * as R from '../rules.js';

export const OVERLAYS = [['', 'нет'], ['bank', 'Согласование банка'], ['coverage', 'Покрытие источниками'],
  ['tbd', 'Вердикт не определён'], ['wave', 'Волна'], ['actor', 'Исполнитель']];
const EDGE_KINDS = [['exec', '▶', 'порядок'], ['data', '●', 'данные'], ['cond', '◆', 'применимость'], ['verdict', '■', 'вердикты']];
const SHOW_NAME = {1: 'все', 2: 'только у выделенной ноды', 0: 'скрыты'};

// Всплывающая панель под кнопкой; закрывается кликом мимо и по Esc.
function Pop({onClose, children, cls}) {
  const ref = useRef(null);
  useEffect(() => {
    const down = e => { if (ref.current && !ref.current.contains(e.target) && !e.target.closest('.fl-popbtn')) onClose(); };
    const key = e => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('pointerdown', down, true); document.removeEventListener('keydown', key, true); };
  }, [onClose]);
  return <div ref={ref} className={'fl-pop fl-nowheel ' + (cls || '')}>{children}</div>;
}

export default function ProfileBar({fx, flow, lib, prof, stats, overlay, show, ro, panels}) {
  const [pop, setPop] = useState(null);
  // Ctrl+F на холсте открывает поиск отсюда же.
  useEffect(() => { fx.openPop = setPop; return () => { if (fx.openPop === setPop) fx.openPop = null; }; }, [fx]);
  const close = () => setPop(null);
  const toggle = name => setPop(p => (p === name ? null : name));
  const sel = prof.sel || {};
  const custom = !prof.id && Object.values(sel).some(v => (v || []).length);
  const num = (name, label, a, b) => (
    <button className={'fl-num fl-popbtn' + (pop === name ? ' on' : '')} onClick={() => toggle(name)} data-stat={name}>
      {label} <b>{a}{b != null ? '/' + b : ''}</b></button>);
  return (
    <div className="fl-bar">
      <label className="fl-pf">Профиль:
        <select value={prof.id || (custom ? '__custom' : '')} data-f="profile" onChange={e => fx.setProfile(e.target.value)}>
          <option value="">все клиенты</option>
          {flow.profiles.map(p => <option key={p.id} value={p.id}>{p.name}{flow.profile === p.id ? ' · по умолчанию' : ''}</option>)}
          {custom ? <option value="__custom">свой выбор</option> : null}
        </select></label>
      <button className={'btn sm fl-popbtn' + (pop === 'edit' ? ' act' : '')} onClick={() => toggle('edit')}>Настроить</button>
      <span className="fl-stats">
        {num('checks', 'Проверок', stats.checks.on, stats.checks.all)}<span className="fl-dot">·</span>
        {num('sources', 'источников', stats.sources.on, stats.sources.all)}<span className="fl-dot">·</span>
        {num('outcomes', 'исходов', stats.outcomes.on, stats.outcomes.all)}<span className="fl-dot">·</span>
        {num('holes', 'входов без источника', stats.holes.length)}
      </span>
      <span className="fl-sep"/>
      <label className="fl-pf">Оверлей:
        <select value={overlay} data-f="overlay" onChange={e => fx.setOverlay(e.target.value)}>
          {OVERLAYS.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select></label>
      <span className="fl-eks" title="Видимость связей по видам: все → только у выделенной ноды → скрыть">Связи:
        {EDGE_KINDS.map(([k, g, n]) => <button key={k} className={'fl-ek fl-ek' + (show[k] == null ? 1 : show[k])} data-ek={k}
          title={`${n}: ${SHOW_NAME[show[k] == null ? 1 : show[k]]}`} onClick={() => fx.cycleShow(k)}>{g}</button>)}</span>
      {!ro ? <button className="btn sm" onClick={() => fx.layout()} title="Авто-раскладка ELK с учётом сокетов и рамок">Разложить</button> : null}
      <button className={'btn sm fl-popbtn' + (pop === 'find' ? ' act' : '')} onClick={() => toggle('find')} title="Поиск по схеме · Ctrl+F">Найти</button>
      <span className="fl-sp"/>
      <button className={'btn sm' + (panels.lib ? ' act' : '')} onClick={() => fx.panel('lib', !panels.lib)}>Библиотека</button>
      <button className="btn sm" data-a="table" onClick={() => fx.openTable('checks')}>Таблица</button>
      <button className="btn sm" data-a="export" title="xlsx, JSON-контракт, Markdown-архив, PNG, SVG" onClick={() => fx.showExport()}>Экспорт</button>
      <button className={'btn sm' + (panels.insp ? ' act' : '')} onClick={() => fx.panel('insp', !panels.insp)}>Инспектор</button>
      {pop === 'edit' ? <Pop onClose={close} cls="fl-pop-edit"><ProfileEdit fx={fx} flow={flow} lib={lib} prof={prof} ro={ro}/></Pop> : null}
      {pop === 'find' ? <Pop onClose={close} cls="fl-pop-find"><Search fx={fx} onDone={close}/></Pop> : null}
      {['checks', 'sources', 'outcomes', 'holes'].includes(pop) ? <Pop onClose={close} cls="fl-pop-list">
        <StatList fx={fx} what={pop} onDone={close}/></Pop> : null}
    </div>
  );
}

// Выбор значений по измерениям и сохранённые профили.
function ProfileEdit({fx, flow, lib, prof, ro}) {
  const sel = prof.sel || {};
  const saved = prof.id ? flow.profiles.find(p => p.id === prof.id) : null;
  return <>
    <div className="fl-pe-h">Значения профиля <span className="hint">внутри измерения — ИЛИ, между измерениями — И; пусто — «любое»</span></div>
    <div className="fl-pe-dims">
      {lib.dims.map(d => (
        <div key={d.id} className="fl-pe-dim" data-dim={d.id}>
          <b>{d.name}</b>
          {d.values.map(v => <label key={v.id} className="fl-chk" data-val={v.id}><input type="checkbox" checked={(sel[d.id] || []).includes(v.id)}
            onChange={e => fx.pickValue(d.id, v.id, e.target.checked)}/>{v.name}{v.code ? <small>{v.code}</small> : null}</label>)}
        </div>
      ))}
      {!lib.dims.length ? <div className="hint">В библиотеке нет измерений — заведите их на вкладке «Измер.».</div> : null}
    </div>
    <div className="fl-pe-f">
      <button className="btn sm" onClick={() => fx.clearProfile()}>Сбросить выбор</button>
      <span className="fl-sp"/>
      {!ro ? <>
        <button className="btn sm pri" data-a="saveas" onClick={() => fx.saveProfileAs()}>Сохранить как…</button>
        {saved ? <>
          <button className="btn sm" onClick={() => fx.overwriteProfile(saved.id)}>Перезаписать «{saved.name}»</button>
          <button className="btn sm" onClick={() => fx.renameProfile(saved.id)}>Переименовать</button>
          <button className="btn sm" onClick={() => fx.defaultProfile(saved.id)} title="Каким профилем открывается ссылка на просмотр и viewer.html">
            {flow.profile === saved.id ? 'По умолчанию ✓' : 'По умолчанию'}</button>
          <button className="btn sm dgr" onClick={() => fx.deleteProfile(saved.id)}>Удалить</button></> : null}
      </> : null}
    </div>
  </>;
}

// Каждое число сводки кликабельно — список с переходом к ноде.
function StatList({fx, what, onDone}) {
  const groups = fx.statList(what);
  return <>
    {groups.map(g => <div key={g.title} className="fl-sl">
      <div className="fl-sl-h">{g.title} <span className="fl-cnt">{g.items.length}</span></div>
      {g.items.map(it => <button key={it.id + (it.sub || '')} className={'fl-sl-i' + (it.off ? ' fl-mut' : '')}
        onClick={() => { onDone(); fx.focusNode(it.id); }}>{it.label}{it.sub ? <small> · {it.sub}</small> : null}</button>)}
      {!g.items.length ? <div className="hint">—</div> : null}
    </div>)}
  </>;
}

// Ctrl+F: поиск по коду, названию, полю и источнику с переходом к ноде.
function Search({fx, onDone}) {
  const [q, setQ] = useState('');
  const [cur, setCur] = useState(0);
  const res = q.trim() ? fx.search(q) : [];
  const go = r => { if (!r) return; onDone(); fx.focusNode(r.id); };
  return <>
    <input type="text" className="fl-add-q" autoFocus placeholder="Код, название, поле или источник" value={q}
      onChange={e => { setQ(e.target.value); setCur(0); }}
      onKeyDown={e => {
        e.stopPropagation();
        if (e.key === 'ArrowDown') { e.preventDefault(); setCur(c => Math.min(res.length - 1, c + 1)); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setCur(c => Math.max(0, c - 1)); }
        else if (e.key === 'Enter') { e.preventDefault(); go(res[cur]); }
        else if (e.key === 'Escape') { e.preventDefault(); onDone(); }
      }}/>
    <div className="fl-add-l">
      {res.map((r, i) => <div key={r.id + i} className={'fl-ai' + (i === cur ? ' on' : '')} onMouseEnter={() => setCur(i)} onClick={() => go(r)}>
        <i style={{background: R.KIND_COLORS[r.k] || '#9aa1b2'}}/><span className="fl-ai-l">{r.label}</span>
        {r.why ? <span className="fl-ai-h">{r.why}</span> : null}</div>)}
      {q.trim() && !res.length ? <div className="fl-ai fl-none">Ничего не нашлось</div> : null}
    </div>
  </>;
}
