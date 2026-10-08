// Виды нод React Flow. Объект — на уровне модуля: React Flow требует стабильную
// ссылку, новый объект на каждую отрисовку пересоздавал бы все ноды.
import DimNode from './DimNode.jsx';
import SourceNode from './SourceNode.jsx';
import CheckNode from './CheckNode.jsx';
import OutcomeNode from './OutcomeNode.jsx';
import StageNode from './StageNode.jsx';
import GateNode from './GateNode.jsx';
import AnyOfNode from './AnyOfNode.jsx';
import CalcNode from './CalcNode.jsx';
import NoteNode from './NoteNode.jsx';
import RerouteNode from './RerouteNode.jsx';

export const nodeTypes = {
  dim: DimNode, source: SourceNode, check: CheckNode, outcome: OutcomeNode, stage: StageNode,
  gate: GateNode, anyof: AnyOfNode, calc: CalcNode, note: NoteNode, reroute: RerouteNode,
};
