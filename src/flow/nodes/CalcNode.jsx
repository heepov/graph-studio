// Показатель: вычисляемая величина, формула — текстом, входы типизированы.
import {memo} from 'react';
import {Block} from './parts.jsx';

export default memo(function CalcNode(props) { return <Block {...props}/>; });
