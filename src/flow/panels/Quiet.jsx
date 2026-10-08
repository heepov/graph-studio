// Граница для ленивых частей: чанк не загрузился (офлайн-просмотрщик, обрыв сети) —
// часть просто не показывается, а не роняет весь конструктор.
import {Component} from 'react';

export class Quiet extends Component {
  constructor(p) { super(p); this.state = {err: false}; }
  static getDerivedStateFromError() { return {err: true}; }
  componentDidCatch(e) { console.warn('[flow] часть интерфейса не загрузилась:', e && (e.message || e)); }
  render() { return this.state.err ? (this.props.fallback || null) : this.props.children; }
}
