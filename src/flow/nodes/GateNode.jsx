// Гейт: условие перехода между этапами, выходы «да» и «нет».
import {memo} from 'react';
import {Block} from './parts.jsx';

export default memo(function GateNode(props) { return <Block {...props}/>; });
