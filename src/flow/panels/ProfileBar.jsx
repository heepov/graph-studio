// Полоса конструктора в панели страницы приложения (#flowBar): профиль клиента,
// сводка по нему, подсветка, видимость связей и раскладка. Поиск по схеме —
// кнопкой «Поиск» в шапке приложения и Ctrl+F, здесь его второй копии нет.
//
// Активный профиль — личное состояние (localStorage), а не документ: иначе
// переключение профиля одним человеком меняло бы экран другому. В документе
// живут только сохранённые профили и профиль по умолчанию — для ссылки и viewer.
import {useEffect, useRef, useState} from 'react';
import * as R from '../rules.js';

// Подписи короткие: ширину списка задаёт самый длинный пункт, а полоса над схемой
// должна влезать в одну строку. Полное название — заголовком легенды.
export const OVERLAYS = [['', 'нет'], ['bank', 'Согласование'], ['coverage', 'Покрытие'],
  ['tbd', 'Без вердикта'], ['wave', 'Волна'], ['actor', 'Исполнитель']];
export const OVERLAY_TITLE = {bank: 'Согласование банком', coverage: 'Покрытие источниками', tbd: 'Вердикт не определён',
  wave: 'Волна', actor: 'Исполнитель'};
const EDGE_KINDS = [['exec', '▶', 'Порядок этапов'], ['data', '●', 'Данные: источник → проверка'],
  ['cond', '◆', 'Для кого: клиент → проверка'], ['verdict', '■', 'Вердикт → исход']];
const MODES = [[1, 'все'], [2, 'у выделенной'], [0, 'скрыть']];
const plural = (n, f) => { const a = Math.abs(n) % 100, b = a % 10; return f[a > 10 && a < 20 ? 2 : b === 1 ? 0 : b >= 2 && b <= 4 ? 1 : 2]; };

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

export default function ProfileBar({fx, flow, lib, prof, stats, overlay, show, ro, panels, view}) {
  const [pop, setPop] = useState(null);
  // Ctrl+F на холсте и «Поиск» в шапке открывают поиск отсюда же.
  useEffect(() => { fx.openPop = setPop; return () => { if (fx.openPop === setPop) fx.openPop = null; }; }, [fx]);
  const close = () => setPop(null);
  const toggle = name => setPop(p => (p === name ? null : name));
  const sel = prof.sel || {};
  const custom = !prof.id && Object.values(sel).some(v => (v || []).length);
  // Число впереди, слово после и в нужном падеже: «45/55 проверок», «22/24 источника».
  const num = (name, a, b, forms, cls) => (
    <button className={'fl-num fl-popbtn' + (pop === name ? ' on' : '') + (cls ? ' ' + cls : '')} onClick={() => toggle(name)} data-stat={name}>
      <b>{a}</b>{b != null ? '/' + b : ''} {plural(b != null ? b : a, forms)}</button>);
  const mode = k => (show[k] == null ? 1 : +show[k]);
  const allShown = EDGE_KINDS.filter(([k]) => mode(k) === 1).length;
  return (
    <div className="fl-bar">
      {view ? <span className="fl-seg fl-viewseg" title="Схема — блоки и связи; список — этапы и проверки строками">
        <button className={view !== 'list' ? 'on' : ''} data-a="view-graph" onClick={() => fx.setView('graph')}>Схема</button>
        <button className={view === 'list' ? 'on' : ''} data-a="view-list" onClick={() => fx.setView('list')}>Список</button>
      </span> : null}
      <label className="fl-pf" title="Профиль клиента: для кого показать проверки">Клиент
        <select value={prof.id || (custom ? '__custom' : '')} data-f="profile" onChange={e => fx.setProfile(e.target.value)}>
          <option value="">все клиенты</option>
          {flow.profiles.map(p => <option key={p.id} value={p.id}>{p.name}{flow.profile === p.id ? ' · по умолчанию' : ''}</option>)}
          {custom ? <option value="__custom">свой выбор</option> : null}
        </select></label>
      <button className={'btn sm fl-popbtn' + (pop === 'edit' ? ' act' : '')} onClick={() => toggle('edit')}
        title="Выбрать значения измерений и сохранить профиль">Настроить</button>
      <span className="fl-stats">
        {num('checks', stats.checks.on, stats.checks.all, ['проверка', 'проверки', 'проверок'])}<span className="fl-dot">·</span>
        {num('sources', stats.sources.on, stats.sources.all, ['источник', 'источника', 'источников'])}
        {stats.holes.length ? <><span className="fl-dot">·</span>
          {num('holes', stats.holes.length, null, ['без источника', 'без источника', 'без источника'], 'fl-num-bad')}</> : null}
      </span>
      <span className="fl-sep"/>
      <label className="fl-pf">Подсветка
        <select value={overlay} data-f="overlay" onChange={e => fx.setOverlay(e.target.value)}>
          {OVERLAYS.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select></label>
      <button className={'btn sm fl-popbtn' + (pop === 'edges' ? ' act' : '')} data-a="edges" onClick={() => toggle('edges')}
        title="Какие связи показывать">Связи{allShown === EDGE_KINDS.length ? ': все' : allShown ? '' : ': у выделенной'}</button>
      {!ro ? <button className="btn sm" data-a="layout" onClick={() => fx.layout()} title="Разложить блоки слоями слева направо, проверки в этапе — по коду">Разложить</button> : null}
      <span className="fl-sp"/>
      {/* Библиотека и инспектор — вкладками по краям холста, таблица библиотеки — кнопкой внизу библиотеки. */}
      <button className="btn sm" data-a="export" title="xlsx, JSON-контракт, Markdown-архив, PNG, SVG" onClick={() => fx.showExport()}>Экспорт</button>
      {pop === 'edit' ? <Pop onClose={close} cls="fl-pop-edit"><ProfileEdit fx={fx} flow={flow} lib={lib} prof={prof} ro={ro}/></Pop> : null}
      {pop === 'find' ? <Pop onClose={close} cls="fl-pop-find"><Search fx={fx} onDone={close}/></Pop> : null}
      {pop === 'edges' ? <Pop onClose={close} cls="fl-pop-edges"><EdgeVis fx={fx} mode={mode}/></Pop> : null}
      {['checks', 'sources', 'outcomes', 'holes'].includes(pop) ? <Pop onClose={close} cls="fl-pop-list">
        <StatList fx={fx} what={pop} onDone={close}/></Pop> : null}
    </div>
  );
}

// Какие связи показывать: по видам, словами, а не значками с тремя скрытыми состояниями.
function EdgeVis({fx, mode}) {
  return <>
    <div className="fl-pe-h">Какие связи показывать</div>
    {EDGE_KINDS.map(([k, g, n]) => (
      <div key={k} className="fl-ev" data-ek={k}>
        <span className="fl-ev-n"><i className={'fl-evg fl-evg-' + k}>{g}</i>{n}</span>
        <span className="fl-seg">{MODES.map(([v, t]) => <button key={v} className={mode(k) === v ? 'on' : ''} data-mode={v}
          onClick={() => fx.setShow(k, v)}>{t}</button>)}</span>
      </div>))}
    <div className="hint fl-ev-hint">«У выделенной» — линии видны у выделенного блока и у блока под курсором.</div>
  </>;
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
