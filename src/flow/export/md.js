// Markdown-архив для Obsidian (ТЗ §10.4): индекс конвейера, по файлу на проверку
// и на источник, ссылки [[…]] между ними. Строится из контракта kycflow/1.
// Модуль ленивый — fflate грузится только по кнопке.
import {zipSync, strToU8} from 'fflate';
import * as R from '../rules.js';

// Имена файлов — без / \ : * ? " < > | (их не переносят ни ОС, ни Obsidian).
export const safeFile = s => String(s || '').replace(/[/\\:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'без названия';
const cell = s => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const yamlStr = s => JSON.stringify(String(s == null ? '' : s));
const yamlList = a => '[' + (a || []).map(yamlStr).join(', ') + ']';

export function buildMdZip(doc, page, contract) {
  const flow = page.flow, lib = doc.flowLib, today = contract.exported.slice(0, 10);
  const root = safeFile('KYC — ' + page.name);
  const srcById = new Map(contract.dictionaries.sources.map(s => [s.id, s]));
  const outById = new Map(contract.dictionaries.outcomes.map(o => [o.id, o]));
  const checkFile = ch => safeFile(`${ch.code} ${ch.name}`);
  const srcFile = s => safeFile(s.name);
  const front = extra => ['---', `date_created: ${today}`, `date_updated: ${today}`, 'domain: ДБО', 'status: draft', 'type: spec', ...extra, '---', ''].join('\n');
  const files = {};
  const used = {};

  for (const st of contract.stages) {
    for (const ch of st.checks) {
      const n = flow.nodes.find(x => x.k === 'check' && x.ref === ch.id);
      const srcIds = [...new Set(ch.inputs.flatMap(i => i.sources.map(s => s.source)))];
      for (const id of srcIds) (used[id] = used[id] || []).push(ch);
      const it = lib.checks.find(x => x.id === ch.id) || {};
      const lines = [front([`code: ${yamlStr(ch.code)}`, `stage: ${yamlStr(st.num ? st.num + '. ' + st.name : st.name)}`,
        `bank_status: ${ch.bank.status}`, `wave: ${ch.wave}`, `verdicts: ${yamlList(ch.verdicts.map(v => v.verdict).concat(ch.verdictTbd ? ['tbd'] : []))}`,
        `factors: ${yamlList(ch.factors)}`, `sources: ${yamlList(srcIds.map(id => (srcById.get(id) || {name: id}).name))}`]),
        `# ${ch.code} ${ch.name}`, '',
        '## Как проверяем', '', ch.how || '—', '',
        '## Зачем', '', ch.why || '—', '',
        '## Правило', '', ch.rule || '—', '',
        '## Входы', '', '| Вход | Тип | Источник → поле |', '|---|---|---|',
        ...ch.inputs.map(i => `| ${cell(i.name)} | ${i.type} | ${i.missing ? '🔴 источник не определён'
          : i.sources.map(s => { const so = srcById.get(s.source); const f = so && so.fields.find(x => x.id === s.field);
            return `[[${srcFile(so || {name: s.source})}]] → ${cell(f ? f.name : s.field)}`; }).join(' / ')} |`),
        '', '## Применимость', '', n ? R.condText(flow, lib, n.id) : 'все', '',
        '## Вердикты → исходы', '',
        ...(ch.verdicts.length ? ch.verdicts.map(v => `- ${R.verdictOf(lib, v.verdict).name} → ${v.outcome ? (outById.get(v.outcome) || {name: v.outcome}).name : '—'}`) : ['—']),
        ...(ch.verdictTbd ? ['- вердикт не определён'] : []), '',
        '## Норматив', '', ch.norm || '—', '',
        '## Примечание', '', it.note || '—', ''];
      files[`${root}/Проверки/${checkFile(ch)}.md`] = lines.join('\n');
    }
  }

  for (const s of contract.dictionaries.sources) {
    const list = used[s.id] || [];
    files[`${root}/Источники/${srcFile(s)}.md`] = [front([`kind: ${s.kind}`, `access: ${s.access}`, `source_status: ${s.status}`]),
      `# ${s.name}`, '',
      `- **Вид:** ${R.nameOf(R.SOURCE_KINDS, s.kind)}`, `- **Доступ:** ${R.nameOf(R.SOURCE_ACCESS, s.access)}`,
      `- **Режим:** ${R.nameOf(R.SOURCE_MODES, s.mode)}`, `- **Статус:** ${R.nameOf(R.SOURCE_STATUSES, s.status)}`,
      ...(s.providers ? [`- **Провайдеры:** ${s.providers}`] : []), ...(s.url ? [`- **URL:** ${s.url}`] : []),
      ...(s.cost ? [`- **Стоимость:** ${s.cost}`] : []), ...(s.note ? ['', s.note] : []), '',
      '## Поля', '', '| Поле | Тип |', '|---|---|', ...s.fields.map(f => `| ${cell(f.name)} | ${f.type} |`), '',
      '## Используется в проверках', '', ...(list.length ? [...new Set(list)].map(ch => `- [[${checkFile(ch)}]]`) : ['—']), ''].join('\n');
  }

  const profs = flow.profiles || [];
  const acts = profs.map(p => R.activity(flow, lib, p.sel));
  const idx = [front([`pipeline: ${yamlStr(page.name)}`, `format: ${contract.format}`]), `# KYC — ${page.name}`, '',
    `Выгрузка ${contract.exported}${contract.profileFilter ? ` · только для профиля «${contract.profileFilter.name}»` : ''}.`, ''];
  for (const st of contract.stages) {
    if (st.gateBefore) idx.push(`> Гейт: ${st.gateBefore.text}`, '');
    idx.push(`## ${st.num ? st.num + '. ' : ''}${st.name}`, '', ...(st.point ? [st.point, ''] : []),
      '| # | Проверка | Источник | Вердикты |', '|---|---|---|---|',
      ...st.checks.map(ch => { const n = flow.nodes.find(x => x.k === 'check' && x.ref === ch.id);
        return `| ${ch.code} | [[${checkFile(ch)}]] | ${cell(n ? R.sourceText(flow, lib, n) : '')} | ${cell(ch.verdicts.map(v => R.verdictOf(lib, v.verdict).name).concat(ch.verdictTbd ? ['не определён'] : []).join(', '))} |`; }), '');
  }
  if (profs.length) {
    idx.push('## Профили', '', '| Профиль | Проверок | Источников |', '|---|---|---|',
      ...profs.map((p, i) => { const s = R.profileStats(flow, lib, p.sel, acts[i]); return `| ${cell(p.name)} | ${s.checks.on}/${s.checks.all} | ${s.sources.on}/${s.sources.all} |`; }), '');
  }
  if (contract.issues.length) {
    idx.push('## Замечания', '', ...contract.issues.map(i => `- ${i.level === 'error' ? '🔴' : '⚠'} ${i.code}: ${i.message}`), '');
  }
  files[`${root}/${root}.md`] = idx.join('\n');

  const z = {};
  for (const [k, v] of Object.entries(files)) z[k] = strToU8(v);
  return zipSync(z, {level: 6});
}
