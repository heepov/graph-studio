// Правила нодового конструктора KYC Flow. ЧИСТЫЙ модуль: ни DOM, ни React,
// ни импортов. Им пользуются три стороны сразу — интерфейс (src/flow), сервер
// (server/src/mcp/flow-rules.js — байт-в-байт копия, её делает
// scripts/sync-flow-rules.mjs) и тесты на node. Поэтому всё, что решает «можно ли»
// и «что получится», живёт здесь, а не в компонентах: иначе Claude через MCP
// и человек мышью получали бы разные ответы на один и тот же вопрос.

/* ---------- справочники, зашитые в код ---------- */

// Типы данных полей и входов. От них зависят цвет сокета и совместимость связей,
// поэтому список фиксирован: свой тип в 2.9.0 не заводится (ТЗ §9.2).
export const TYPES = [
  {key: 'bool', name: 'Да/нет', color: '#e0567a'},
  {key: 'text', name: 'Текст', color: '#4fa3e0'},
  {key: 'number', name: 'Число', color: '#3fb37f'},
  {key: 'money', name: 'Сумма', color: '#c9a227'},
  {key: 'date', name: 'Дата', color: '#f08a3c'},
  {key: 'list', name: 'Набор', color: '#6b7fd7'},
  {key: 'person', name: 'Физлицо', color: '#14b8a6'},
  {key: 'file', name: 'Документ', color: '#9ca3af'},
  {key: 'any', name: 'Любой', color: '#c4c9d4'},
];
export const TYPE_KEYS = TYPES.map(t => t.key);
export const typeOf = k => TYPES.find(t => t.key === k) || TYPES[TYPES.length - 1];

// Вердикты по умолчанию. В отличие от типов, список редактируется — это данные
// библиотеки (flowLib.verdicts), а здесь только стартовое наполнение.
export const DEFAULT_VERDICTS = [
  {key: 'ok', name: 'Продолжить / открыть', color: '#2e9d58'},
  {key: 'stop_a', name: 'Отказ обязателен (группа А)', color: '#9f1d16'},
  {key: 'stop_b', name: 'Отказ возможен (группа Б)', color: '#e0473a'},
  {key: 'freeze', name: 'Замораживание + ФЭС', color: '#1f2433'},
  {key: 'manual', name: 'Ручной разбор', color: '#c26a00'},
  {key: 'risk', name: 'Повышение степени риска', color: '#e6a700'},
  {key: 'clarify', name: 'Запрос пояснений', color: '#3b82f6'},
  {key: 'neutral', name: 'Нейтральный экран', color: '#8a94a6'},
  {key: 'info', name: 'Информация, без последствия', color: '#b8bfcc'},
];

// Виды нод и цвет шапки. Исход красится цветом своего вердикта, этап — заливкой.
export const NODE_KINDS = ['dim', 'source', 'check', 'outcome', 'stage', 'gate', 'anyof', 'calc', 'note', 'reroute'];
export const KIND_NAMES = {
  dim: 'Измерение', source: 'Источник', check: 'Проверка', outcome: 'Исход', stage: 'Этап',
  gate: 'Гейт', anyof: 'Один из', calc: 'Показатель', note: 'Заметка', reroute: 'Точка перегиба',
};
export const KIND_COLORS = {
  dim: '#7c5cff', source: '#0f9f8f', check: '#3355d1', stage: '#3355d1',
  gate: '#6b7280', anyof: '#a16207', calc: '#0e7490',
};
export const COND_COLOR = '#7c5cff';
// Блоки библиотеки и их разделы в flowLib. Остальные виды живут только в странице.
export const LIB_KINDS = {dim: 'dims', source: 'sources', check: 'checks', outcome: 'outcomes'};
export const LIB_SECTIONS = ['dims', 'sources', 'checks', 'outcomes', 'verdicts'];

export const SOURCE_KINDS = [['gov', 'Госреестр'], ['commercial', 'Коммерческий сервис'], ['bank', 'Система банка'],
  ['internal', 'Внутренняя система'], ['client', 'Клиент'], ['staff', 'Сотрудник']];
export const SOURCE_ACCESS = [['api', 'API'], ['bulk', 'Выгрузка'], ['cabinet', 'Личный кабинет'], ['manual', 'Вручную'], ['none', 'Нет доступа']];
export const SOURCE_MODES = [['sync', 'Синхронно'], ['async', 'Асинхронно'], ['daily', 'Раз в сутки']];
export const SOURCE_STATUSES = [['live', 'Подключён'], ['contract', 'Договор, не подключён'], ['planned', 'Планируется'],
  ['no_access', 'Нет доступа'], ['no_source', 'Источника нет'], ['unknown', 'Не выяснено']];
export const BANK_STATUSES = [['none', 'Не выносилось'], ['accepted', 'Принято'], ['accepted_comments', 'Принято с комментариями'],
  ['discussion', 'Обсуждение'], ['rejected', 'Отклонено']];
export const ACTORS = [['system', 'Система'], ['verifier', 'Верификатор'], ['km', 'Клиентский менеджер'],
  ['compliance', 'Комплаенс'], ['client', 'Клиент']];
export const nameOf = (list, key) => (list.find(x => x[0] === key) || [key, key || '—'])[1];

/* ---------- умолчания ---------- */

// Единственное место, где описано «пустое»: normalize в приложении и addPage
// на сервере берут умолчания отсюда, а не держат по своей копии.
export function defaultFlow() {
  return {nodes: [], edges: [], profiles: [], profile: null,
    show: {exec: 1, data: 1, cond: 1, verdict: 1}, overlay: ''};
}
export function defaultLib() {
  return {v: 1, dims: [], sources: [], checks: [], outcomes: [],
    verdicts: DEFAULT_VERDICTS.map(v => ({...v}))};
}
