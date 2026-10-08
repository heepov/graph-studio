// Проверка: порядок, «Когда», входы данных слева; порядок и вердикты справа.
import {memo} from 'react';
import {Block} from './parts.jsx';

export default memo(function CheckNode(props) { return <Block {...props}/>; });
