// «Один из»: резерв источников, порядок входов — приоритет.
import {memo} from 'react';
import {Block} from './parts.jsx';

export default memo(function AnyOfNode(props) { return <Block {...props}/>; });
