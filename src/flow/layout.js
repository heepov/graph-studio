// Авто-раскладка схемы. ELK тяжёлый (около полумегабайта), поэтому грузится
// только по кнопке «Разложить» — в основной бандл он не попадает. План и запись
// результата — общие с сервером, в rules.js.
import {layoutPlan, applyLayout} from './rules.js';

export async function runLayout(flow, lib, sizeOf) {
  const {default: ELK} = await import('elkjs/lib/elk.bundled.js');
  const plan = layoutPlan(flow, lib, sizeOf);
  const result = await new ELK().layout(plan.graph);
  return {plan, result, apply: f => applyLayout(f, plan, result)};
}
