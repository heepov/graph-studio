// Исход: принимает вердикты и порядок, шапка — цветом своего вердикта.
import {memo} from 'react';
import {Block} from './parts.jsx';

export default memo(function OutcomeNode(props) { return <Block {...props}/>; });
