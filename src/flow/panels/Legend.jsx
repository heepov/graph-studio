// Легенда оверлея: что значит цвет рамки проверки и сколько проверок каждого
// цвета. У «Покрытия источниками» — ещё и список дыр с переходом к ноде.
import {OVERLAYS} from './ProfileBar.jsx';

export const OV = {
  bank: {accepted: ['#2e9d58', 'принято'], accepted_comments: ['#8fbf3a', 'принято с комментариями'],
    discussion: ['#e08a1e', 'обсуждение'], rejected: ['#e0473a', 'отклонено'], none: ['#9aa1b2', 'не выносилось']},
  coverage: {red: ['#e0473a', 'вход без связи или источник без доступа'], yellow: ['#e6a700', 'источник планируется, договор или не выяснено'],
    green: ['#2e9d58', 'все источники подключены'], none: ['#9aa1b2', 'входов нет']},
  tbd: {tbd: ['#e6a700', 'вердикт не определён'], ok: ['#9aa1b2', 'вердикт задан']},
  wave: {1: ['#3355d1', 'Волна 1'], 2: ['#8b46c9', 'Волна 2'], 3: ['#d2740c', 'Волна 3'], 0: ['#9aa1b2', 'вне волн']},
  actor: {system: ['#3355d1', 'Система'], verifier: ['#0f9f8f', 'Верификатор'], km: ['#c26a00', 'Клиентский менеджер'],
    compliance: ['#9d174d', 'Комплаенс'], client: ['#6b7280', 'Клиент']},
};

export default function Legend({fx, overlay, counts, holes}) {
  if (!overlay || !OV[overlay]) return null;
  const title = (OVERLAYS.find(o => o[0] === overlay) || [])[1];
  return (
    <div className="fl-legend fl-nowheel" data-overlay={overlay}>
      <div className="fl-lg-h">{title}<button className="fl-ib" title="Выключить оверлей" onClick={() => fx.setOverlay('')}>×</button></div>
      {Object.entries(OV[overlay]).map(([k, [color, label]]) => (
        <div key={k} className="fl-lg-r" data-key={k}><i style={{background: color}}/><span>{label}</span><b>{counts[k] || 0}</b></div>
      ))}
      {overlay === 'coverage' && holes.length ? <div className="fl-lg-holes">
        <div className="fl-lg-sh">Дыры</div>
        {holes.map(h => <button key={h.id + h.why} className="fl-sl-i" onClick={() => fx.focusNode(h.id)}>{h.label}<small> · {h.why}</small></button>)}
      </div> : null}
    </div>
  );
}
