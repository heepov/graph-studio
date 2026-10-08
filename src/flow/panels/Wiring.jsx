// Связи этой схемы формой: «Для кого», «Откуда данные», «Куда ведёт вердикт».
// Это те же связи, что тянутся мышью от сокета к сокету, — только выбором из
// списка. Протягивать провод через всю схему, чтобы сказать «проверка — для ИП»,
// человеку не нужно; схема остаётся картинкой потока, а не единственным пультом.
import {useState} from 'react';
import * as R from '../rules.js';

const NEXT = {'': 'pos', pos: 'neg', neg: ''};
const SEP = '::';

// Исход, в который ведёт связь, — сквозь точки перегиба.
function outcomeAt(flow, lib, id, d = 0) {
  const n = flow.nodes.find(x => x.id === id);
  if (!n || d > 12) return null;
  if (n.k === 'outcome') { const it = R.itemOf(lib, n); return {ref: n.ref, name: it ? it.name : n.ref, direct: d === 0}; }
  if (n.k !== 'reroute') return null;
  const e = flow.edges.find(x => x.s === n.id);
  return e ? outcomeAt(flow, lib, e.t, d + 1) : null;
}

export function WhoSection({fx, n, flow, lib, ro}) {
  const cond = R.condOf(flow, lib, n.id);
  const dims = lib.dims || [];
  // Незаданные измерения свёрнуты: в seed их девять на сорок одно значение,
  // и развёрнутые разом они отодвигали бы «Откуда данные» за край панели.
  const [all, setAll] = useState(false);
  const head = <div className="fl-sh">Для кого <span className="fl-wsum" data-who>{R.whoText(flow, lib, n.id)}</span></div>;
  if (!dims.length) return <div className="fl-sec fl-wire" data-wire="who">{head}
    <div className="fl-mut">В библиотеке нет измерений клиента — заведите их на вкладке «Измер.» библиотеки.</div></div>;
  // Измерения, по которым уже что-то задано, — первыми.
  const used = dims.filter(d => cond[d.id]), rest = dims.filter(d => !cond[d.id]);
  const order = all ? used.concat(rest) : used;
  return (
    <div className="fl-sec fl-wire" data-wire="who">{head}
      {all || used.length ? <div className="fl-hint">Клик — «для», второй — «кроме», третий — снять. Не задано по измерению — подходит любое значение.</div> : null}
      {order.map(d => (
        <div key={d.id} className="fl-wdim" data-dim={d.id}>
          <span className="fl-wdim-n">{d.name}</span>
          <span className="fl-wvals">{(d.values || []).map(v => {
            const c = cond[d.id], st = c ? (c.pos.includes(v.id) ? 'pos' : c.neg.includes(v.id) ? 'neg' : '') : '';
            return <button key={v.id} className={'fl-wv' + (st ? ' fl-wv-' + st : '')} data-val={v.id} disabled={ro}
              title={st === 'pos' ? 'Проверка — для этого значения' : st === 'neg' ? 'Проверка — для всех, кроме этого значения' : 'Не задано'}
              onClick={() => fx.setWho(n.id, d.id, v.id, NEXT[st])}>{st === 'neg' ? '⊘ ' : ''}{v.name}</button>;
          })}</span>
        </div>))}
      {rest.length ? <button className="fl-wmore" data-a="who-more" onClick={() => setAll(v => !v)}>
        {all ? 'Свернуть незаданные' : used.length ? `Ещё измерения (${rest.length})` : `Задать, для кого (${rest.length} ${rest.length === 1 ? 'измерение' : rest.length < 5 ? 'измерения' : 'измерений'})`}</button> : null}
    </div>
  );
}

export function DataSection({fx, n, it, flow, lib, ro}) {
  const inputs = (it && it.inputs) || [];
  if (!inputs.length) return null;
  const onPage = new Set(flow.nodes.filter(x => x.k === 'source').map(x => x.ref));
  return (
    <div className="fl-sec fl-wire" data-wire="data"><div className="fl-sh">Откуда данные</div>
      {inputs.map(inp => {
        const th = 'in:' + inp.id;
        const direct = flow.edges.filter(e => e.t === n.id && e.th === th);
        const srcs = R.inputSources(flow, lib, n.id, th);
        // Через «Резерв источников» или показатель — это уже маленькая схема, ей место на холсте.
        const via = direct.some(e => { const s = flow.nodes.find(x => x.id === e.s); return s && s.k !== 'source'; });
        const cur = !via && srcs[0] ? srcs[0].source + SEP + srcs[0].field : '';
        const opts = [];
        for (const s of lib.sources || []) {
          for (const f of s.fields || []) {
            if (inp.type && inp.type !== 'any' && f.type !== inp.type && f.type !== 'any') continue;
            opts.push({v: s.id + SEP + f.id, label: `${s.name} → ${f.name}`, on: onPage.has(s.id)});
          }
        }
        opts.sort((a, b) => b.on - a.on);
        return (
          <div key={inp.id} className="fl-wrow" data-input={inp.id}>
            <span className={'fl-wname' + (srcs.length ? '' : ' fl-miss')} title={R.typeOf(inp.type).name}>{inp.name}</span>
            {via ? <span className="fl-wvia" title="Связь идёт через «Резерв источников» или показатель — она правится на схеме">
              по приоритету: {srcs.map(x => (x.item ? x.item.name : x.source)).join(' → ') || '—'}</span>
              : <select value={cur} disabled={ro} data-f="input-src" onChange={e => {
                  const [source, field] = e.target.value.split(SEP);
                  fx.setInput(n.id, inp.id, e.target.value ? {source, field} : null);
                }}>
                <option value="">{opts.length ? '— не подключён —' : `нет полей типа «${R.typeOf(inp.type).name}»`}</option>
                {opts.map(o => <option key={o.v} value={o.v}>{o.label}{o.on ? '' : ' · встанет на схему'}</option>)}
              </select>}
          </div>
        );
      })}
    </div>
  );
}

export function VerdictSection({fx, n, it, flow, lib, ro}) {
  const keys = (it && it.verdicts) || [];
  if (!keys.length) return null;
  const onPage = new Set(flow.nodes.filter(x => x.k === 'outcome').map(x => x.ref));
  return (
    <div className="fl-sec fl-wire" data-wire="verdict"><div className="fl-sh">Куда ведёт вердикт</div>
      {keys.map(k => {
        const v = R.verdictOf(lib, k);
        const ends = flow.edges.filter(e => e.s === n.id && e.sh === 'v:' + k).map(e => outcomeAt(flow, lib, e.t)).filter(Boolean);
        const editable = ends.length === 0 || (ends.length === 1 && ends[0].direct);
        // Исходы того же вердикта — первыми: «Ручной разбор» ведут в исход ручного разбора.
        const opts = (lib.outcomes || []).slice().sort((a, b) => (b.verdict === k) - (a.verdict === k));
        return (
          <div key={k} className="fl-wrow" data-verdict={k}>
            <span className="fl-wname"><i className="fl-wdot" style={{background: v.color}}/>{v.name}</span>
            {editable ? <select value={ends[0] ? ends[0].ref : ''} disabled={ro} data-f="verdict-to"
                onChange={e => fx.setVerdict(n.id, k, e.target.value || null)}>
                <option value="">— никуда —</option>
                {opts.map(o => <option key={o.id} value={o.id}>{o.name}{onPage.has(o.id) ? '' : ' · встанет на схему'}</option>)}
              </select>
              : <span className="fl-wvia">{ends.map(x => x.name).join(', ')}</span>}
          </div>
        );
      })}
    </div>
  );
}

// Ленивый вход для инспектора: все три раздела — одним чанком.
export default function Wiring({kind, fx, n, it, flow, lib, ro}) {
  if (kind === 'check') return <>
    <WhoSection fx={fx} n={n} flow={flow} lib={lib} ro={ro}/>
    <DataSection fx={fx} n={n} it={it} flow={flow} lib={lib} ro={ro}/>
    <VerdictSection fx={fx} n={n} it={it} flow={flow} lib={lib} ro={ro}/>
  </>;
  return <WhoSection fx={fx} n={n} flow={flow} lib={lib} ro={ro}/>;
}
