// Источник: поля — выходы ● данных, слева необязательное «Когда».
import {memo} from 'react';
import {Block} from './parts.jsx';

export default memo(function SourceNode(props) { return <Block {...props}/>; });
