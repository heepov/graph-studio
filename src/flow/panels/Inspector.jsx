// Инспектор блока под выделением. Правки блока библиотеки применяются ко всем
// конвейерам доски сразу. Текстовые поля — неуправляемые и пишут по input БЕЗ
// пересборки панели (SPEC §8 п. 4): иначе каждая буква крала бы фокус. Панель
// пересоздаётся, только когда документ сменили снаружи (отмена, чужая правка):
// ключ формы включает поколение документа.
import {useEffect, useRef} from 'react';
import * as R from '../rules.js';

const TYPE_OPTS = R.TYPES.map(t => [t.key, t.name + ' · ' + t.key]);
const WAVES = [['0', 'вне волн'], ['1', 'Волна 1'], ['2', 'Волна 2'], ['3', 'Волна 3']];

function Txt({label, obj, k, area, ro, fx, focus, ph}) {
  const ref = useRef(null);
  useEffect(() => {
    if (!focus || !ref.current) return;
    ref.current.focus(); if (ref.current.select) ref.current.select();
    fx.focusDone();
  }, [focus]);   // eslint-disable-line react-hooks/exhaustive-deps
  const v = obj[k] == null ? '' : String(obj[k]);
  const p = {ref, defaultValue: v, disabled: ro, placeholder: ph || '', 'data-f': k, onInput: e => fx.text(obj, k, e.target.value)};
  return <label className="fl-f"><span>{label}</span>{area ? <textarea rows={area} {...p}/> : <input type="text" {...p}/>}</label>;
}
function Sel({label, value, opts, on, ro, f}) {
  return <label className="fl-f"><span>{label}</span>
    <select value={value == null ? '' : String(value)} disabled={ro} data-f={f} onChange={e => on(e.target.value)}>
      {opts.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select></label>;
}
function Chk({label, on, value, ro, f}) {
  return <label className="fl-chk"><input type="checkbox" checked={!!value} disabled={ro} data-f={f} onChange={e => on(e.target.checked)}/>{label}</label>;
}

// Перестановка строк списка перетаскиванием за ручку ⋮⋮. На указателе, а не
// HTML5 drag: работает и пальцем, и в headless-тесте обычными событиями мыши.
function grip(e, box, from, onMove) {
  e.preventDefault();
  const rows = [...box.querySelectorAll(':scope > .fl-lr')];
  const row = rows[from]; if (!row) return;
  row.classList.add('fl-drag');
  // to — индекс строки, ПЕРЕД которой встанет перетаскиваемая (rows.length — в конец).
  let to = from;
  const mv = ev => {
    to = rows.length;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      if (ev.clientY < r.top + r.height / 2) { to = i; break; }
    }
    rows.forEach((r2, i) => r2.classList.toggle('fl-dropat', i === to && to !== from && to !== from + 1));
  };
  const up = () => {
    window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up);
    rows.forEach(r2 => r2.classList.remove('fl-drag', 'fl-dropat'));
    // Индекс считается по списку БЕЗ переносимой строки — иначе при переносе
    // вниз она встаёт на одну позицию дальше (та же грабля, что у колонок таблицы).
    const dest = to > from ? to - 1 : to;
    if (dest !== from) onMove(from, dest);
  };
  window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
}
function List({title, items, render, onAdd, onMove, ro, addLabel}) {
  const box = useRef(null);
  return (
    <div className="fl-sec">
      <div className="fl-sh">{title}<span className="fl-cnt">{items.length}</span></div>
      <div ref={box}>
        {items.map((it, i) => (
          <div key={it.id} className="fl-lr" data-row={it.id}>
            {!ro && onMove ? <span className="fl-grip" title="Перетащить — поменять порядок" onPointerDown={e => grip(e, box.current, i, onMove)}>⋮⋮</span> : null}
            {render(it, i)}
          </div>
        ))}
      </div>
      {!ro && onAdd ? <button className="btn sm fl-add1" onClick={onAdd}>{addLabel}</button> : null}
    </div>
  );
}
const move = (arr, a, b) => { const [x] = arr.splice(a, 1); arr.splice(b, 0, x); };

export default function Inspector({fx, t, P, flow, lib, ro, gen, focus}) {
  if (!t) {
    return <div className="fl-insp fl-nowheel"><Head fx={fx} title="Инспектор"/>
      <div className="fl-iempty">Выделите блок на схеме или в библиотеке — здесь появятся его поля.
        <br/><br/><b>Shift+A</b> — добавить блок, <b>двойной клик</b> по шапке — переименовать.</div></div>;
  }
  if (t.multi) {
    return <div className="fl-insp fl-nowheel"><Head fx={fx} title={`Выделено: ${t.multi.length}`}/>
      <div className="fl-acts">{ro ? null : <>
        <button className="btn sm" onClick={() => fx.op('collapsed')}>Свернуть · H</button>
        <button className="btn sm" onClick={() => fx.op('muted')}>Выключить · M</button>
        <button className="btn sm" onClick={() => fx.op('wrap')}>В этап · Ctrl+J</button>
        <button className="btn sm dgr" onClick={() => fx.op('delete')}>Убрать со схемы</button></>}</div></div>;
  }
  if (t.edge) return <EdgeInsp fx={fx} e={t.edge} flow={flow} lib={lib} ro={ro}/>;
  const n = t.node, sec = t.sec || (n && R.LIB_KINDS[n.k]);
  const it = sec ? (lib[sec] || []).find(x => x.id === (t.id || (n && n.ref))) : null;
  const kind = n ? n.k : {dims: 'dim', sources: 'source', checks: 'check', outcomes: 'outcome'}[sec];
  const key = (it ? it.id : n.id) + ':' + gen;
  const uses = it ? fx.usages(sec, it.id) : [];
  const pages = new Set(uses.map(u => u.page)).size;
  const fp = focus || null;
  return (
    <div className="fl-insp fl-nowheel" data-insp={kind}>
      <Head fx={fx} title={R.KIND_NAMES[kind]} sub={it ? `Блок библиотеки · используется на ${pages} ${pages === 1 ? 'схеме' : 'схемах'}` : 'Нода этой схемы'}/>
      <div className="fl-ibody" key={key}>
        {sec && !it ? <div className="fl-iempty">Блока нет в библиотеке: {n && n.ref}. Удалите ноду или почините её в проверке доски.</div> : null}
        {kind === 'check' && it ? <CheckF fx={fx} it={it} lib={lib} ro={ro} fp={fp}/> : null}
        {kind === 'source' && it ? <SourceF fx={fx} it={it} ro={ro} fp={fp} P={P}/> : null}
        {kind === 'dim' && it ? <DimF fx={fx} it={it} ro={ro} fp={fp}/> : null}
        {kind === 'outcome' && it ? <>
          <Txt label="Название" obj={it} k="name" ro={ro} fx={fx} focus={fp}/>
          <Sel label="Вердикт" value={it.verdict} f="verdict" ro={ro} opts={lib.verdicts.map(v => [v.key, v.name])}
            on={v => fx.set(() => { it.verdict = v; })}/>
          <Txt label="Описание" obj={it} k="desc" area={3} ro={ro} fx={fx}/></> : null}
        {n && !sec ? <NodeF fx={fx} n={n} ro={ro} flow={flow} lib={lib} fp={fp}/> : null}
        {n && !ro ? <div className="fl-sec fl-flags">
          <Chk label="Выключена (M)" value={n.muted} f="muted" on={() => fx.op('muted', [n.id])}/>
          {n.k !== 'stage' && n.k !== 'note' && n.k !== 'reroute' ? <Chk label="Свёрнута (H)" value={n.collapsed} f="collapsed" on={() => fx.op('collapsed', [n.id])}/> : null}
        </div> : null}
        {it ? <Uses fx={fx} uses={uses} sec={sec} it={it} P={P}/> : null}
        {!ro ? <div className="fl-acts">
          {it ? <button className="btn sm" onClick={() => fx.dupBlock(sec, it.id)}>Дубликат блока</button> : null}
          {n ? <button className="btn sm" onClick={() => fx.op('delete', [n.id])}>Убрать со схемы</button> : null}
          {it ? <button className="btn sm dgr" onClick={() => fx.delBlock(sec, it.id)}>Удалить из библиотеки</button> : null}
        </div> : null}
      </div>
    </div>
  );
}

function Head({fx, title, sub}) {
  return <div className="fl-ph fl-ihd" onPointerDown={e => fx.inspGrip && e.target.classList.contains('fl-igrip') && fx.inspGrip(e)}>
    <div className="fl-igrip" title="Потянуть — ширина панели"/>
    <div className="fl-ititle"><b>{title}</b>{sub ? <span>{sub}</span> : null}</div>
    <span className="fl-sp"/>
    <button className="fl-ib" title="Свернуть панель" onClick={() => fx.panel('insp', false)}>›</button></div>;
}

function CheckF({fx, it, lib, ro, fp}) {
  const factorsObj = {get f() { return (it.factors || []).join(', '); }};
  const bank = it.bank || (it.bank = {status: 'none', comment: ''});
  return <>
    <div className="fl-row2">
      <Txt label="Код" obj={it} k="code" ro={ro} fx={fx}/>
      <Sel label="Волна" value={it.wave == null ? 1 : it.wave} f="wave" ro={ro} opts={WAVES} on={v => fx.set(() => { it.wave = +v; })}/>
    </div>
    <Txt label="Что проверяем" obj={it} k="name" ro={ro} fx={fx} focus={fp}/>
    <Txt label="Как проверяем" obj={it} k="how" area={3} ro={ro} fx={fx}/>
    <Txt label="Зачем" obj={it} k="why" area={2} ro={ro} fx={fx}/>
    <Txt label="Правило" obj={it} k="rule" area={3} ro={ro} fx={fx} ph="текстом: проверки не исполняются"/>
    <Txt label="Норматив" obj={it} k="norm" ro={ro} fx={fx}/>
    <label className="fl-f"><span>Коды факторов</span>
      <input type="text" defaultValue={factorsObj.f} disabled={ro} data-f="factors" placeholder="E-09, S16"
        onInput={e => fx.text(it, 'factors', e.target.value.split(/[,;\s]+/).filter(Boolean))}/></label>
    {(it.factors || []).length ? <div className="fl-chips">{it.factors.map(f => <span key={f} className="fl-chip">{f}</span>)}</div> : null}
    <div className="fl-row2">
      <Sel label="Исполнитель" value={it.actor || 'system'} f="actor" ro={ro} opts={R.ACTORS} on={v => fx.set(() => { it.actor = v; })}/>
      <Sel label="Согласование банком" value={bank.status || 'none'} f="bank" ro={ro} opts={R.BANK_STATUSES} on={v => fx.set(() => { bank.status = v; })}/>
    </div>
    <Txt label="Комментарий банка" obj={bank} k="comment" ro={ro} fx={fx}/>
    <div className="fl-sec"><div className="fl-sh">Вердикты</div>
      <div className="fl-verd">{lib.verdicts.map(v => (
        <label key={v.key} className="fl-chk fl-vchk" data-verdict={v.key}><input type="checkbox" disabled={ro} checked={(it.verdicts || []).includes(v.key)}
          onChange={e => fx.toggleVerdict(it, v.key, e.target.checked)}/><i style={{background: v.color}}/>{v.name}</label>))}</div>
      <Chk label="Вердикт не определён" value={it.verdictTbd} f="verdictTbd" ro={ro} on={v => fx.set(() => { it.verdictTbd = v ? 1 : 0; })}/>
    </div>
    <List title="Входы" items={it.inputs || []} ro={ro} addLabel="+ Вход"
      onAdd={() => fx.addInput(it)} onMove={(a, b) => fx.set(() => move(it.inputs, a, b))}
      render={inp => <>
        <input type="text" className="fl-grow" defaultValue={inp.name} disabled={ro} data-f="input-name" onInput={e => fx.text(inp, 'name', e.target.value)}/>
        <select value={inp.type || 'any'} disabled={ro} data-f="input-type" onChange={e => fx.retype('check', it, 'inputs', inp, e.target.value)}>
          {TYPE_OPTS.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select>
        {!ro ? <button className="fl-ib fl-x" title="Удалить вход" onClick={() => fx.dropSocket('check', it, 'inputs', inp)}>×</button> : null}
      </>}/>
    <Txt label="Примечание" obj={it} k="note" area={3} ro={ro} fx={fx}/>
    <Txt label="Комментарий" obj={it} k="comment" area={2} ro={ro} fx={fx}/>
    {it.srcText ? <div className="fl-f"><span>Исходный текст «Источник» (xls)</span><div className="fl-ro">{it.srcText}</div></div> : null}
  </>;
}

function SourceF({fx, it, ro, fp, P}) {
  const readers = fx.fieldReaders(it.id);
  return <>
    <Txt label="Название" obj={it} k="name" ro={ro} fx={fx} focus={fp}/>
    <div className="fl-row2">
      <Sel label="Вид" value={it.kind || 'gov'} f="kind" ro={ro} opts={R.SOURCE_KINDS} on={v => fx.set(() => { it.kind = v; })}/>
      <Sel label="Статус" value={it.status || 'unknown'} f="status" ro={ro} opts={R.SOURCE_STATUSES} on={v => fx.set(() => { it.status = v; })}/>
    </div>
    <div className="fl-row2">
      <Sel label="Доступ" value={it.access || 'api'} f="access" ro={ro} opts={R.SOURCE_ACCESS} on={v => fx.set(() => { it.access = v; })}/>
      <Sel label="Режим" value={it.mode || 'sync'} f="mode" ro={ro} opts={R.SOURCE_MODES} on={v => fx.set(() => { it.mode = v; })}/>
    </div>
    <Txt label="Провайдеры" obj={it} k="providers" ro={ro} fx={fx} ph="Дадата → Контур.Фокус"/>
    <div className="fl-row2"><Txt label="URL" obj={it} k="url" ro={ro} fx={fx}/><Txt label="Стоимость" obj={it} k="cost" ro={ro} fx={fx}/></div>
    <Txt label="Примечание" obj={it} k="note" area={2} ro={ro} fx={fx}/>
    <List title="Поля" items={it.fields || []} ro={ro} addLabel="+ Поле"
      onAdd={() => fx.addField(it)} onMove={(a, b) => fx.set(() => move(it.fields, a, b))}
      render={f => <>
        <div className="fl-grow fl-col2">
          <input type="text" defaultValue={f.name} disabled={ro} data-f="field-name" onInput={e => fx.text(f, 'name', e.target.value)}/>
          {(readers[f.id] || []).length ? <small>читают: {readers[f.id].join(', ')}</small> : <small className="fl-mut">никто не читает</small>}
        </div>
        <select value={f.type || 'any'} disabled={ro} data-f="field-type" onChange={e => fx.retype('source', it, 'fields', f, e.target.value)}>
          {TYPE_OPTS.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select>
        {!ro ? <button className="fl-ib fl-x" title="Удалить поле" onClick={() => fx.dropSocket('source', it, 'fields', f)}>×</button> : null}
      </>}/>
  </>;
}

function DimF({fx, it, ro, fp}) {
  return <>
    <div className="fl-row2"><Txt label="Название" obj={it} k="name" ro={ro} fx={fx} focus={fp}/><Txt label="Код оси" obj={it} k="code" ro={ro} fx={fx} ph="A, D, G…"/></div>
    <Txt label="Описание" obj={it} k="desc" area={2} ro={ro} fx={fx}/>
    <List title="Значения" items={it.values || []} ro={ro} addLabel="+ Значение"
      onAdd={() => fx.addValue(it)} onMove={(a, b) => fx.set(() => move(it.values, a, b))}
      render={v => <>
        <input type="text" className="fl-code-in" defaultValue={v.code} disabled={ro} placeholder="код" data-f="value-code" onInput={e => fx.text(v, 'code', e.target.value)}/>
        <input type="text" className="fl-grow" defaultValue={v.name} disabled={ro} data-f="value-name" onInput={e => fx.text(v, 'name', e.target.value)}/>
        <select value={String(v.wave == null ? 1 : v.wave)} disabled={ro} onChange={e => fx.set(() => { v.wave = +e.target.value; })}>
          {WAVES.map(([k, n]) => <option key={k} value={k}>{k === '0' ? '—' : 'W' + k}</option>)}</select>
        {!ro ? <button className="fl-ib fl-x" title="Удалить значение" onClick={() => fx.dropSocket('dim', it, 'values', v)}>×</button> : null}
      </>}/>
  </>;
}

function NodeF({fx, n, ro, flow, lib, fp}) {
  const d = n.data || (n.data = {});
  if (n.k === 'stage') return <>
    <div className="fl-row2"><Txt label="Номер" obj={d} k="num" ro={ro} fx={fx}/><Txt label="Точка процесса" obj={d} k="point" ro={ro} fx={fx}/></div>
    <Txt label="Название этапа" obj={d} k="name" ro={ro} fx={fx} focus={fp}/>
    <Chk label="Подгонять рамку под содержимое" value={n.fit} f="fit" ro={ro} on={v => fx.set(() => { if (v) n.fit = 1; else n.fit = 0; }, {refit: [n.id]})}/>
    <div className="fl-hint">Проверки внутри рамки идут параллельно, если между ними нет связей порядка ▶.</div>
  </>;
  if (n.k === 'gate') return <Txt label="Условие перехода" obj={d} k="text" area={3} ro={ro} fx={fx} focus={fp}/>;
  if (n.k === 'note') return <Txt label="Текст заметки" obj={d} k="text" area={6} ro={ro} fx={fx} focus={fp}/>;
  if (n.k === 'anyof') return <>
    <Txt label="Подпись" obj={d} k="label" ro={ro} fx={fx} focus={fp}/>
    <div className="fl-row2">
      <Sel label="Тип данных" value={d.type || 'any'} f="anyof-type" ro={ro} opts={TYPE_OPTS} on={v => fx.anyofType(n, v)}/>
      <Sel label="Источников по приоритету" value={String(d.n || 2)} f="anyof-n" ro={ro} opts={[2, 3, 4, 5, 6, 7, 8].map(x => [String(x), String(x)])} on={v => fx.anyofN(n, +v)}/>
    </div>
    <div className="fl-hint">Порядок входов — приоритет: первый подключённый источник основной, следующие — резерв.</div>
  </>;
  if (n.k === 'calc') return <>
    <Txt label="Показатель" obj={d} k="name" ro={ro} fx={fx} focus={fp}/>
    <Txt label="Формула (текстом)" obj={d} k="formula" area={3} ro={ro} fx={fx} ph="Долг / EBITDA"/>
    <Sel label="Тип результата" value={d.type || 'number'} f="calc-type" ro={ro} opts={TYPE_OPTS} on={v => fx.set(() => { d.type = v; })}/>
    <List title="Входы" items={d.inputs || (d.inputs = [])} ro={ro} addLabel="+ Вход"
      onAdd={() => fx.calcInput(n)} onMove={(a, b) => fx.set(() => move(d.inputs, a, b))}
      render={inp => <>
        <input type="text" className="fl-grow" defaultValue={inp.name} disabled={ro} onInput={e => fx.text(inp, 'name', e.target.value)}/>
        <select value={inp.type || 'number'} disabled={ro} onChange={e => fx.calcRetype(n, inp, e.target.value)}>
          {TYPE_OPTS.map(([k, nm]) => <option key={k} value={k}>{nm}</option>)}</select>
        {!ro ? <button className="fl-ib fl-x" onClick={() => fx.calcDrop(n, inp)}>×</button> : null}
      </>}/>
  </>;
  if (n.k === 'reroute') {
    const s = R.socketsOf(flow, lib, n).outs[0] || {};
    return <div className="fl-hint">Точка перегиба ведёт связь дальше как сокет своего типа: {s.kind === 'data' ? 'данные · ' + s.type : s.kind === 'any' ? 'пока не подключена' : s.kind}.</div>;
  }
  return null;
}

function EdgeInsp({fx, e, flow, lib, ro}) {
  const kind = R.edgeKind(flow, lib, e);
  const a = flow.nodes.find(n => n.id === e.s), b = flow.nodes.find(n => n.id === e.t);
  const so = R.socketOf(flow, lib, e.s, e.sh, 'out'), ti = R.socketOf(flow, lib, e.t, e.th, 'in');
  return <div className="fl-insp fl-nowheel"><Head fx={fx} title="Связь" sub={{exec: 'порядок исполнения', cond: 'применимость', data: 'данные', verdict: 'вердикт'}[kind]}/>
    <div className="fl-ibody">
      <div className="fl-f"><span>Откуда</span><div className="fl-ro">{fx.label(a)}{so && so.name ? ' · ' + so.name : ''}</div></div>
      <div className="fl-f"><span>Куда</span><div className="fl-ro">{fx.label(b)}{ti && ti.name ? ' · ' + ti.name : ''}</div></div>
      {kind === 'cond' && !ro ? <Chk label="Кроме этого значения (⊘)" value={e.neg} f="neg" on={() => fx.op('neg', [e.id])}/> : null}
      {!ro ? <div className="fl-acts"><button className="btn sm dgr" onClick={() => fx.op('dropEdge', [e.id])}>Удалить связь</button></div> : null}
    </div></div>;
}

function Uses({fx, uses, sec, it, P}) {
  if (!uses.length) return <div className="fl-sec fl-uses"><div className="fl-sh">Используется</div><div className="fl-mut">Ни на одной схеме — перетащите блок из библиотеки на холст.</div></div>;
  return <div className="fl-sec fl-uses"><div className="fl-sh">Используется</div>
    {uses.map(u => <button key={u.page + u.node} className="fl-use" onClick={() => fx.goNode(u.page, u.node)}>
      {u.pageName}{u.stage ? ` (этап ${u.stage})` : ''}</button>)}</div>;
}
