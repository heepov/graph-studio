// Мини-валидатор JSON Schema — ровно для тех ключевых слов, что использует
// docs/kycflow.schema.json: type, enum, const, required, properties,
// additionalProperties (булево или схема), items, minItems, minimum, pattern
// и $ref на #/$defs. Тесты здесь без зависимостей (только Node), поэтому ajv
// не тянем. Незнакомое ключевое слово — ошибка самого валидатора, а не молчание:
// иначе схема «проходила» бы за счёт того, что её никто не проверял.
const KNOWN = new Set(['$schema', '$id', 'title', 'description', '$defs', 'type', 'enum', 'const', 'required', 'properties',
  'additionalProperties', 'items', 'minItems', 'minimum', 'pattern', '$ref']);

function typeOk(v, t) {
  if (t === 'null') return v === null;
  if (t === 'array') return Array.isArray(v);
  if (t === 'object') return v !== null && typeof v === 'object' && !Array.isArray(v);
  if (t === 'integer') return Number.isInteger(v);
  if (t === 'number') return typeof v === 'number' && isFinite(v);
  return typeof v === t;
}

function validate(root, data) {
  const errors = [];
  const walk = (s, v, at) => {
    if (errors.length > 50) return;
    if (s.$ref) {
      const m = s.$ref.match(/^#\/\$defs\/(.+)$/);
      if (!m || !root.$defs[m[1]]) throw new Error('валидатор: не разрешил ' + s.$ref);
      return walk(root.$defs[m[1]], v, at);
    }
    for (const k of Object.keys(s)) if (!KNOWN.has(k)) throw new Error('валидатор не знает ключевого слова ' + k);
    if (s.type) {
      const ts = Array.isArray(s.type) ? s.type : [s.type];
      if (!ts.some(t => typeOk(v, t))) { errors.push(`${at}: ожидался ${ts.join('|')}`); return; }
    }
    if (s.const !== undefined && v !== s.const) errors.push(`${at}: должно быть ${JSON.stringify(s.const)}`);
    if (s.enum && !s.enum.includes(v)) errors.push(`${at}: ${JSON.stringify(v)} нет в перечне`);
    if (typeof v === 'string' && s.pattern && !new RegExp(s.pattern).test(v)) errors.push(`${at}: не подходит под ${s.pattern}`);
    if (typeof v === 'number' && s.minimum !== undefined && v < s.minimum) errors.push(`${at}: меньше ${s.minimum}`);
    if (Array.isArray(v)) {
      if (s.minItems !== undefined && v.length < s.minItems) errors.push(`${at}: элементов меньше ${s.minItems}`);
      if (s.items) v.forEach((x, i) => walk(s.items, x, `${at}[${i}]`));
    }
    if (typeOk(v, 'object')) {
      for (const r of s.required || []) if (!(r in v)) errors.push(`${at}: нет поля ${r}`);
      const props = s.properties || {};
      for (const [k, x] of Object.entries(v)) {
        if (props[k]) walk(props[k], x, `${at}.${k}`);
        else if (s.additionalProperties === false) errors.push(`${at}: лишнее поле ${k}`);
        else if (s.additionalProperties && typeof s.additionalProperties === 'object') walk(s.additionalProperties, x, `${at}.${k}`);
      }
    }
  };
  walk(root, data, '$');
  return errors;
}

module.exports = { validate };
