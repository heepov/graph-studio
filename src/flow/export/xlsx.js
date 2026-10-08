// Выгрузка xlsx в формате исходного листа «Скоринг» с расширением (ТЗ §10.1).
// Строится из контракта kycflow/1 — тем же, что JSON и Markdown, поэтому три
// выгрузки не расходятся. Модуль ленивый: exceljs весит сотни килобайт и
// грузится только по кнопке, в основной бандл он не попадает.
import ExcelJS from 'exceljs';
import * as R from '../rules.js';

const HEAD = ['#', 'Что проверяем', 'Как проверяем', 'Зачем проверяем', 'Источник', 'Статус согласования', 'Комментарий',
  'Применимость', 'Вердикты', 'Коды факторов', 'Норматив', 'Исполнитель', 'Волна'];
const WIDTHS = [6, 34, 46, 38, 26, 18, 24, 22, 18, 14, 16, 12, 8];
const STAGE_FILL = {type: 'pattern', pattern: 'solid', fgColor: {argb: 'FFEEF1F8'}};
const GREY = {color: {argb: 'FF9AA1B2'}};

function sheet(wb, name, head, widths) {
  const ws = wb.addWorksheet(name, {views: [{state: 'frozen', ySplit: 1}]});
  ws.columns = head.map((h, i) => ({header: h, width: widths[i] || 20}));
  ws.getRow(1).font = {bold: true};
  ws.autoFilter = {from: {row: 1, column: 1}, to: {row: 1, column: head.length}};
  return ws;
}
const wrapAll = ws => ws.eachRow(r => r.eachCell(c => { c.alignment = Object.assign({wrapText: true, vertical: 'top'}, c.alignment); }));

export async function buildXlsx(doc, page, contract) {
  const flow = page.flow, lib = doc.flowLib;
  const nodeOf = id => flow.nodes.find(n => n.k === 'check' && n.ref === id);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Heepov Board · KYC Flow';
  wb.created = new Date();

  /* --- Проверки: шапка, строка этапа перед его проверками, гейт курсивом --- */
  const ws = sheet(wb, 'Проверки', HEAD, WIDTHS);
  const full = r => ws.mergeCells(r.number, 1, r.number, HEAD.length);
  for (const st of contract.stages) {
    if (st.gateBefore) {
      const r = ws.addRow(['Гейт: ' + st.gateBefore.text]);
      full(r); r.font = {italic: true};
    }
    const sr = ws.addRow([st.num ? `${st.num}. ${st.name}` : st.name]);
    full(sr); sr.font = {bold: true};
    sr.getCell(1).fill = STAGE_FILL;
    for (const ch of st.checks) {
      const n = nodeOf(ch.id);
      const verdicts = ch.verdicts.map(v => R.verdictOf(lib, v.verdict).name).concat(ch.verdictTbd ? ['не определён'] : []);
      const r = ws.addRow([ch.code, ch.name, ch.how, ch.why, n ? R.sourceText(flow, lib, n) : '',
        R.nameOf(R.BANK_STATUSES, ch.bank.status), (lib.checks.find(x => x.id === ch.id) || {}).comment || '',
        n ? R.condText(flow, lib, n.id) : 'все', verdicts.join(', '), ch.factors.join(', '), ch.norm,
        R.nameOf(R.ACTORS, ch.actor), ch.wave]);
      if (ch.muted) r.font = GREY;
    }
  }
  wrapAll(ws);

  /* --- Источники --- */
  const used = {};
  for (const st of contract.stages) for (const ch of st.checks) for (const inp of ch.inputs) for (const s of inp.sources) {
    (used[s.source] = used[s.source] || new Set()).add(ch.code);
  }
  const byCode = set => [...(set || [])].sort((a, b) => String(a).localeCompare(String(b), 'ru', {numeric: true}));
  const wsS = sheet(wb, 'Источники', ['Название', 'Вид', 'Доступ', 'Режим', 'Статус', 'Провайдеры', 'Поля', 'Используется в проверках'],
    [30, 18, 14, 14, 20, 30, 40, 26]);
  for (const s of contract.dictionaries.sources) {
    wsS.addRow([s.name, R.nameOf(R.SOURCE_KINDS, s.kind), R.nameOf(R.SOURCE_ACCESS, s.access), R.nameOf(R.SOURCE_MODES, s.mode),
      R.nameOf(R.SOURCE_STATUSES, s.status), s.providers, s.fields.map(f => `${f.name} (${f.type})`).join('\n'), byCode(used[s.id]).join(', ')]);
  }
  wrapAll(wsS);

  /* --- Профили: проверки × сохранённые профили --- */
  const profs = flow.profiles || [];
  const wsP = sheet(wb, 'Профили', ['#', 'Проверка', ...profs.map(p => p.name)], [6, 40, ...profs.map(() => 16)]);
  const acts = profs.map(p => R.activity(flow, lib, p.sel));
  const totals = profs.map(() => 0);
  for (const st of contract.stages) for (const ch of st.checks) {
    const n = nodeOf(ch.id);
    wsP.addRow([ch.code, ch.name, ...acts.map((a, i) => { const on = !!(n && a.nodes.has(n.id)); if (on) totals[i]++; return on ? '✓' : ''; })]);
  }
  const tr = wsP.addRow(['', 'Итого проверок', ...totals]);
  tr.font = {bold: true};
  wrapAll(wsP);

  /* --- Поля: кто какое поле читает --- */
  const readers = {};
  for (const st of contract.stages) for (const ch of st.checks) for (const inp of ch.inputs) for (const s of inp.sources) {
    const k = s.source + '\u0000' + s.field;
    (readers[k] = readers[k] || new Set()).add(ch.code);
  }
  const wsF = sheet(wb, 'Поля', ['Поле', 'Тип', 'Источник', 'Проверки, которые его читают'], [34, 12, 30, 30]);
  for (const s of contract.dictionaries.sources) for (const f of s.fields) {
    wsF.addRow([f.name, f.type, s.name, byCode(readers[s.id + '\u0000' + f.id]).join(', ')]);
  }
  wrapAll(wsF);

  return wb.xlsx.writeBuffer();
}
