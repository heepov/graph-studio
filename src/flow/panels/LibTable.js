// Табличный редактор библиотеки — путь массовой правки «как в Excel».
// Не React-таблица, а разметка и классы страницы-таблицы приложения
// (.tblwrap, table.grid, .cellin): так он выглядит и ведёт себя как соседняя
// страница. Ячейки пишут по input без перерисовки таблицы — фокус не теряется;
// перерисовка только на сортировку и фильтр.
//
// wireColResize/wireColOrder приложения здесь не переиспользованы: они привязаны
// к #view и к настройкам страницы (pg.table.w), а у модалки нет ни того, ни другого.
import * as R from '../rules.js';

const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const opt = (list, cur) => list.map(([k, n]) => `<option value="${esc(k)}"${String(k) === String(cur) ? ' selected' : ''}>${esc(n)}</option>`).join('');
const WAVES = [['0', '—'], ['1', '1'], ['2', '2'], ['3', '3']];

// Колонки листа «Проверки» — как в xlsx §10.1, плюс этап на этой схеме.
function checkCols(api) {
  const {flow, lib} = api.cur();
  const nodeOf = id => flow.nodes.find(n => n.k === 'check' && n.ref === id);
  const stageOf = id => { const n = nodeOf(id), s = n && n.parent && flow.nodes.find(x => x.id === n.parent); return s ? `${(s.data || {}).num || ''} ${(s.data || {}).name || ''}`.trim() : (n ? 'вне этапа' : 'не на схеме'); };
  return [
    {k: 'code', t: '#', w: 54, edit: 'text'},
    {k: 'name', t: 'Что проверяем', w: 220, edit: 'text'},
    {k: 'how', t: 'Как проверяем', w: 260, edit: 'text'},
    {k: 'why', t: 'Зачем проверяем', w: 220, edit: 'text'},
    {k: 'src', t: 'Источник', w: 180, val: it => { const n = nodeOf(it.id); return n ? R.sourceText(flow, lib, n) : it.srcText || ''; }},
    {k: 'bank', t: 'Статус согласования', w: 150, edit: 'select', opts: R.BANK_STATUSES, get: it => (it.bank || {}).status || 'none',
      set: (it, v) => { it.bank = it.bank || {status: 'none', comment: ''}; it.bank.status = v; }, val: it => R.nameOf(R.BANK_STATUSES, (it.bank || {}).status || 'none')},
    {k: 'comment', t: 'Комментарий', w: 180, edit: 'text'},
    {k: 'cond', t: 'Применимость', w: 170, val: it => { const n = nodeOf(it.id); return n ? R.condText(flow, lib, n.id) : '—'; }},
    {k: 'verdicts', t: 'Вердикты', w: 170, val: it => (it.verdicts || []).map(v => R.verdictOf(lib, v).name).concat(it.verdictTbd ? ['не определён'] : []).join(', ')},
    {k: 'factors', t: 'Коды факторов', w: 110, edit: 'text', get: it => (it.factors || []).join(', '), set: (it, v) => { it.factors = v.split(/[,;\s]+/).filter(Boolean); }},
    {k: 'norm', t: 'Норматив', w: 120, edit: 'text'},
    {k: 'actor', t: 'Исполнитель', w: 130, edit: 'select', opts: R.ACTORS, get: it => it.actor || 'system', val: it => R.nameOf(R.ACTORS, it.actor || 'system')},
    {k: 'wave', t: 'Волна', w: 64, edit: 'select', opts: WAVES, get: it => String(it.wave == null ? 1 : it.wave), set: (it, v) => { it.wave = +v; }},
    {k: 'stage', t: 'Этап на этой схеме', w: 150, val: it => stageOf(it.id)},
  ];
}
function sourceCols(api) {
  const {P} = api.cur();
  return [
    {k: 'name', t: 'Название', w: 220, edit: 'text'},
    {k: 'kind', t: 'Вид', w: 150, edit: 'select', opts: R.SOURCE_KINDS, get: it => it.kind || 'gov', val: it => R.nameOf(R.SOURCE_KINDS, it.kind)},
    {k: 'access', t: 'Доступ', w: 120, edit: 'select', opts: R.SOURCE_ACCESS, get: it => it.access || 'api', val: it => R.nameOf(R.SOURCE_ACCESS, it.access)},
    {k: 'mode', t: 'Режим', w: 120, edit: 'select', opts: R.SOURCE_MODES, get: it => it.mode || 'sync', val: it => R.nameOf(R.SOURCE_MODES, it.mode)},
    {k: 'status', t: 'Статус', w: 150, edit: 'select', opts: R.SOURCE_STATUSES, get: it => it.status || 'unknown', val: it => R.nameOf(R.SOURCE_STATUSES, it.status)},
    {k: 'providers', t: 'Провайдеры', w: 200, edit: 'text'},
    {k: 'url', t: 'URL', w: 140, edit: 'text'},
    {k: 'cost', t: 'Стоимость', w: 100, edit: 'text'},
    {k: 'note', t: 'Примечание', w: 200, edit: 'text'},
    {k: 'fields', t: 'Поля', w: 220, val: it => (it.fields || []).map(f => `${f.name} (${f.type})`).join('; ')},
    {k: 'uses', t: 'Используется в проверках', w: 160, val: it => {
      const r = api.readers(it.id); return [...new Set(Object.values(r).flat())].sort((a, b) => String(a).localeCompare(String(b), 'ru', {numeric: true})).join(', ');
    }},
  ];
}

export function openLibTable(ctx, api, tab0) {
  let tab = tab0 === 'sources' ? 'sources' : 'checks';
  let sort = {k: tab === 'checks' ? 'code' : 'name', dir: 1};
  let filt = {};
  const ro = ctx.ro();
  ctx.modal(`<h3>Библиотека — таблица</h3>
    <div class="fl-tt"><button class="btn sm" data-tab="checks">Проверки</button><button class="btn sm" data-tab="sources">Источники</button>
      <span class="hint" data-cnt></span></div>
    <div class="tblwrap fl-tw"><table class="grid fixed fl-lt"><colgroup></colgroup><thead></thead><tbody></tbody></table></div>
    <div class="mfoot"><span class="hint">Правка в ячейке меняет блок на всех схемах доски.</span><span style="flex:1"></span>
      <button class="btn pri" data-a="c">Готово</button></div>`, box => {
    box.classList.add('fl-full');
    const tbl = box.querySelector('table'), thead = tbl.tHead, tbody = tbl.tBodies[0], cg = tbl.querySelector('colgroup');
    const cols = () => (tab === 'checks' ? checkCols(api) : sourceCols(api));
    const cellVal = (c, it) => (c.val ? c.val(it) : c.get ? c.get(it) : it[c.k]);
    const head = () => {
      const cs = cols();
      cg.innerHTML = cs.map(c => `<col style="width:${c.w}px">`).join('');
      thead.innerHTML = `<tr>${cs.map(c => `<th data-k="${c.k}" title="клик — сортировка">${esc(c.t)}${sort.k === c.k ? ` <span class="ar">${sort.dir > 0 ? '▲' : '▼'}</span>` : ''}</th>`).join('')}</tr>
        <tr class="fl-filt">${cs.map(c => `<th><input class="cellin" data-filt="${c.k}" placeholder="фильтр" value="${esc(filt[c.k] || '')}"></th>`).join('')}</tr>`;
      thead.querySelectorAll('th[data-k]').forEach(th => th.onclick = () => {
        sort = sort.k === th.dataset.k ? {k: sort.k, dir: -sort.dir} : {k: th.dataset.k, dir: 1};
        head(); body();
      });
      thead.querySelectorAll('[data-filt]').forEach(inp => inp.oninput = () => { filt[inp.dataset.filt] = inp.value; body(); });
      box.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('act', b.dataset.tab === tab));
    };
    const body = () => {
      const {lib} = api.cur(), cs = cols();
      let rows = (lib[tab] || []).slice();
      rows = rows.filter(it => cs.every(c => !filt[c.k] || String(cellVal(c, it) || '').toLowerCase().includes(filt[c.k].toLowerCase())));
      const sc = cs.find(c => c.k === sort.k);
      rows.sort((a, b) => (sort.k === 'code' ? R.codeCompare(a, b)
        : String(cellVal(sc, a) || '').localeCompare(String(cellVal(sc, b) || ''), 'ru', {numeric: true})) * sort.dir);
      box.querySelector('[data-cnt]').textContent = `${rows.length} из ${(lib[tab] || []).length}`;
      tbody.innerHTML = rows.map(it => `<tr data-id="${esc(it.id)}">${cs.map(c => {
        if (ro || !c.edit) return `<td title="${esc(cellVal(c, it))}">${esc(cellVal(c, it))}</td>`;
        if (c.edit === 'select') return `<td><select class="cellsel" data-k="${c.k}">${opt(c.opts, c.get ? c.get(it) : it[c.k])}</select></td>`;
        return `<td><input class="cellin" data-k="${c.k}" value="${esc(c.get ? c.get(it) : it[c.k])}"></td>`;
      }).join('')}</tr>`).join('');
      tbody.querySelectorAll('tr').forEach(tr => {
        const it = (api.cur().lib[tab] || []).find(x => x.id === tr.dataset.id);
        tr.querySelectorAll('[data-k]').forEach(el => {
          const c = cs.find(x => x.k === el.dataset.k);
          if (el.tagName === 'SELECT') el.onchange = () => api.edit(() => (c.set ? c.set(it, el.value) : (it[c.k] = el.value)));
          else el.oninput = () => (c.set ? api.textSet(() => c.set(it, el.value)) : api.text(it, c.k, el.value));
        });
      });
    };
    box.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => {
      tab = b.dataset.tab; sort = {k: tab === 'checks' ? 'code' : 'name', dir: 1}; filt = {}; head(); body();
    });
    box.querySelector('[data-a=c]').onclick = () => { ctx.closeModal(); api.closed(); };
    head(); body();
  }, {wide: true});
}
