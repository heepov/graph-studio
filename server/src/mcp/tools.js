// Инструменты MCP: всё, что можно сделать с доской из приложения, можно сделать
// и отсюда — доски, страницы-холсты, схема, узлы, связи, области, заметки,
// расстановка на холсте, история.
//
// Каждый инструмент правит документ и сохраняет его тем же путём, что и браузер
// (boards.saveBoard): версия, запись в историю и рассылка живой правки достаются
// бесплатно. Открытая вкладка обновляется на глазах, пока Claude правит доску.
import * as D from './doc.js';
import { importDoc } from './import.js';
import * as F from './flow.js';
import { LIB_SECTIONS, NODE_KINDS } from './flow-rules.js';

const S = (desc, extra = {}) => ({ type: 'string', description: desc, ...extra });
const N = (desc) => ({ type: 'number', description: desc });
const B = (desc) => ({ type: 'boolean', description: desc });
const A = (desc, items) => ({ type: 'array', description: desc, items });
const O = (desc, properties, required) => ({ type: 'object', description: desc, properties, ...(required ? { required } : {}) });

const BOARD = S('Доска: её id или название. Название можно неточное — совпадение по началу.');

// Вид страницы отдаётся enum'ом, а не только строкой описания: список видов должен
// быть машиночитаемым, иначе модель узнаёт о допустимых значениях лишь из отказа.
const PAGE_KIND = S('canvas — карта зависимостей по колонкам, space — свободная схема, jam — свободная доска (стикеры, фигуры, стрелки, рисунки), flow — нодовый конструктор проверок KYC (блоки библиотеки и связи сокетов, правится инструментами flow_*), table — таблица, board — канбан, dash — дашборд',
  { enum: ['canvas', 'space', 'jam', 'flow', 'table', 'board', 'dash'] });

// Описания узла в двух видах: при создании имя обязательно, при правке — id.
const NODE_FIELDS = {
  name: S('Название'),
  sub: S('Подпись под названием — одна строка уточнения'),
  body: S('Развёрнутое описание'),
  status: S('Статус: ключ или название из схемы доски'),
  category: S('Категория: ключ или название из схемы доски'),
  type: S('Тип узла: ключ или название из схемы доски'),
  draft: B('Черновик — узел виден, но помечен как непроработанный'),
  fields: O('Свои поля доски: {ключ_или_подпись: значение}', {}),
  checks: A('Вехи внутри узла', O('Веха', {
    text: S('Что должно случиться'),
    status: S('Статус вехи'),
    blocking: B('Веха держит весь узел'),
    note: S('Пояснение'),
  }, ['text'])),
};

export const TOOLS = [
  /* ---------- доски ---------- */
  {
    name: 'list_boards',
    title: 'Список досок',
    description: 'Все доски: свои и те, к которым дали доступ. Начинать стоит отсюда — дальше доска указывается по названию или id.',
    inputSchema: O('', {}),
    handler: (ctx) => {
      const mine = ctx.db.prepare(`SELECT id, name, nodes_count, links_count, pages_count, version, updated_at, 'owner' AS role
        FROM boards WHERE owner_id = ? AND deleted = 0 ORDER BY updated_at DESC`).all(ctx.user.id);
      const shared = ctx.db.prepare(`SELECT b.id, b.name, b.nodes_count, b.links_count, b.pages_count, b.version, b.updated_at, m.role
        FROM board_members m JOIN boards b ON b.id = m.board_id
        WHERE m.user_id = ? AND b.deleted = 0 AND b.owner_id != ? ORDER BY b.updated_at DESC`).all(ctx.user.id, ctx.user.id);
      const row = b => ({ id: b.id, name: b.name, nodes: b.nodes_count, links: b.links_count,
        pages: b.pages_count, version: b.version, role: b.role, updated: new Date(b.updated_at).toISOString() });
      return { boards: [...mine.map(row), ...shared.map(row)] };
    },
  },
  {
    name: 'get_board',
    title: 'Прочитать доску',
    description: 'Содержимое доски: схема, страницы, узлы, связи, области, заметки. По умолчанию без длинных описаний и без раскладки — их включают отдельно, чтобы ответ не раздувался.',
    inputSchema: O('', {
      board: BOARD,
      include_body: B('Включить развёрнутые описания узлов (по умолчанию нет: они длинные)'),
      include_metrics: B('Посчитать вес узлов, что чем заблокировано и что можно брать сейчас'),
      include_layout: B('Включить раскладку: колонку узла (lane), его закреплённые координаты и размеры по страницам, а у холстов — nodes_pinned (сколько узлов имеют сохранённую позицию) и nodes_visible (сколько реально показывается с учётом фильтра страницы). Эти два числа различаются, если фильтр отсекает часть узлов'),
      pages_only: B('Только схема и страницы, без узлов и связей — быстро проверить структуру'),
    }, ['board']),
    handler: (ctx, a) => {
      const { board, doc } = ctx.load(a.board);
      const out = D.summarize(doc, { body: !!a.include_body, layout: !!a.include_layout, pagesOnly: !!a.pages_only });
      out.id = board.id;
      out.version = board.version;
      if (a.include_metrics && !a.pages_only) out.metrics = D.metrics(doc);
      return out;
    },
  },
  {
    name: 'create_board',
    title: 'Создать доску',
    description: 'Новая пустая доска с нужной схемой и страницами. Узлы добавляются отдельно — add_nodes.',
    inputSchema: O('', {
      name: S('Название доски'),
      description: S('Описание'),
      statuses: A('Статусы. Если не задать — «готово / в работе / заблокировано / не начато»',
        O('', { name: S('Название'), color: S('Цвет #rrggbb') }, ['name'])),
      categories: A('Категории (направления). Если не задать — одна «Общее»',
        O('', { name: S('Название'), color: S('Цвет #rrggbb') }, ['name'])),
      node_types: A('Типы узлов. Если не задать — «Узел» и «Гейт»',
        O('', { name: S('Название'), shape: S('rect | pill | diamond') }, ['name'])),
      pages: A('Страницы. Если не задать — холст, таблица и дашборд',
        O('', { name: S('Название'), kind: PAGE_KIND }, ['name', 'kind'])),
    }, ['name']),
    handler: (ctx, a) => {
      const doc = blankDoc(a);
      const r = ctx.boards.createBoard(ctx.user, doc, { summary: 'создана из Claude' });
      return { id: r.id, name: doc.name, url: ctx.publicUrl + '/b/' + r.id,
        pages: doc.pages.map(p => ({ id: p.id, name: p.name, kind: p.kind })) };
    },
  },
  {
    name: 'import_board',
    title: 'Импортировать проект целиком',
    description: 'Создаёт доску из целого документа проекта (то, что отдаёт «Экспорт → JSON доски»). ' +
      'Импортирует ровно то, что в файле: идентификаторы узлов сохраняются как есть, все связи ' +
      'переносятся, страницы создаются только те, что описаны. Возвращает отчёт: что создано, ' +
      'что переименовано, что отброшено и почему. Собирать доску по частям (create_board → ' +
      'add_nodes → link_nodes) для готового файла НЕ нужно: так теряются id и связи.',
    inputSchema: O('', {
      doc: O('Документ проекта целиком: name, schema, nodes, links, pages, frames, notes', {}),
      json: S('То же самое строкой JSON — если удобнее передать текстом файла'),
      name: S('Название доски. По умолчанию берётся из документа'),
      dry_run: B('Ничего не создавать, только вернуть отчёт: что получилось бы'),
      drop_pages: A('id страниц из файла, которые не надо создавать. Пустые страницы отмечаются в warnings при dry_run — чистить исходный JSON руками не нужно', S('id страницы')),
    }),
    handler: (ctx, a) => {
      let src = a.doc;
      if (!src && a.json) {
        try { src = JSON.parse(a.json); }
        catch (e) { throw new D.DocError('не разобрал JSON: ' + e.message); }
      }
      const { doc, report } = importDoc(src, { name: a.name, dropPages: a.drop_pages });
      if (a.dry_run) return { dry_run: true, name: doc.name, ...report };
      const r = ctx.boards.createBoard(ctx.user, doc, { summary: 'импорт из Claude' });
      return { id: r.id, name: doc.name, url: ctx.publicUrl + '/b/' + r.id, ...report };
    },
  },
  {
    name: 'update_board',
    title: 'Переименовать доску',
    description: 'Название и описание доски.',
    inputSchema: O('', { board: BOARD, name: S('Новое название'), description: S('Новое описание') }, ['board']),
    handler: (ctx, a) => ctx.edit(a.board, doc => {
      if (a.name !== undefined) doc.name = String(a.name);
      if (a.description !== undefined) doc.desc = String(a.description);
      return { summary: 'переименована', result: { name: doc.name } };
    }),
  },
  {
    name: 'delete_board',
    title: 'Убрать доску в корзину',
    description: 'Доска уходит в корзину — оттуда её можно вернуть. Совсем удалить можно только в приложении.',
    inputSchema: O('', { board: BOARD }, ['board']),
    handler: (ctx, a) => {
      const { board, role } = ctx.load(a.board);
      if (role !== 'owner') throw new D.DocError('удалять доску может только владелец');
      ctx.db.prepare('UPDATE boards SET deleted = 1, updated_at = ? WHERE id = ?').run(Date.now(), board.id);
      return { deleted: board.name };
    },
  },

  /* ---------- узлы ---------- */
  {
    name: 'add_nodes',
    title: 'Добавить узлы',
    description: 'Добавляет узлы на доску. Узлы общие для всех страниц: страница — это фильтр и способ показа, а не отдельный набор данных.',
    inputSchema: O('', {
      board: BOARD,
      nodes: A('Узлы', O('Узел', { id: S('Свой идентификатор. Любая строка, кириллица допустима. Если не задать — сервер присвоит свой; если такой id уже занят, тоже присвоит свой'), ...NODE_FIELDS }, ['name'])),
    }, ['board', 'nodes']),
    handler: (ctx, a) => ctx.edit(a.board, doc => {
      const made = D.addNodes(doc, a.nodes);
      return { summary: `+${made.length} узл. из Claude`, result: { added: made } };
    }),
  },
  {
    name: 'update_nodes',
    title: 'Изменить узлы',
    description: 'Меняет поля существующих узлов. Присылать нужно только то, что меняется — остальное останется как было.',
    inputSchema: O('', {
      board: BOARD,
      nodes: A('Узлы', O('Узел', { id: S('id узла'), ...NODE_FIELDS,
        lane: N('Колонка на холсте с авто-раскладкой: индекс в списке lanes страницы. null — вернуть на автоматическую глубину зависимости. Поле общее для доски, а не для одной страницы'),
      }, ['id'])),
    }, ['board', 'nodes']),
    handler: (ctx, a) => ctx.edit(a.board, doc => {
      const ids = D.updateNodes(doc, a.nodes);
      return { summary: `изменено ${ids.length} узл. из Claude`, result: { updated: ids } };
    }),
  },
  {
    name: 'delete_nodes',
    title: 'Удалить узлы',
    description: 'Удаляет узлы вместе с их связями.',
    inputSchema: O('', { board: BOARD, ids: A('id узлов', S('id')) }, ['board', 'ids']),
    handler: (ctx, a) => ctx.edit(a.board, doc => {
      const r = D.deleteNodes(doc, a.ids);
      return { summary: `−${r.nodes.length} узл. из Claude`,
        result: { deleted: r.nodes, links_removed: r.links_removed } };
    }),
  },

  /* ---------- связи ---------- */
  {
    name: 'link_nodes',
    title: 'Связать узлы',
    description: 'Создаёт зависимости. Направление: from держит to — то есть to нельзя закрыть, пока не закрыт from. Связь, замыкающая круг, отклоняется: в круге ни один узел нельзя сделать первым. Круг считается по ВСЕМ связям, включая не-блокирующие, — ровно как в приложении.',
    inputSchema: O('', {
      board: BOARD,
      links: A('Связи', O('', { from: S('id узла, который держит'), to: S('id узла, который ждёт'),
        type: S('Тип связи. Если такого типа в схеме нет — он будет заведён (сплошная линия, не считается зависимостью), а не связь отброшена') }, ['from', 'to'])),
      on_duplicate: S('Что делать с уже существующей связью: skip (по умолчанию, повторный вызов безопасен) или error'),
    }, ['board', 'links']),
    handler: (ctx, a) => ctx.edit(a.board, doc => {
      const r = D.addLinks(doc, a.links, { onDuplicate: a.on_duplicate });
      return { summary: `+${r.made.length} связ. из Claude`,
        result: { added: r.made, skipped: r.skipped, warnings: r.warnings } };
    }),
  },
  {
    name: 'unlink_nodes',
    title: 'Убрать связи',
    description: 'Удаляет зависимости между узлами.',
    inputSchema: O('', {
      board: BOARD,
      links: A('Связи', O('', { from: S('id'), to: S('id') }, ['from', 'to'])),
    }, ['board', 'links']),
    handler: (ctx, a) => ctx.edit(a.board, doc => {
      const n = D.deleteLinks(doc, a.links);
      return { summary: `−${n} связ. из Claude`, result: { removed: n } };
    }),
  },

  /* ---------- страницы ---------- */
  {
    name: 'add_page',
    title: 'Добавить страницу',
    description: 'Новый вид на те же узлы: canvas — карта зависимостей по колонкам, space — свободная схема, table — таблица, board — канбан, dash — дашборд.',
    inputSchema: O('', {
      board: BOARD,
      name: S('Название страницы'),
      kind: PAGE_KIND,
      layout: S('Только для canvas: auto (раскладка по зависимостям) или free (руками)'),
      lanes: A('Только для canvas: подписи колонок', S('')),
      groupBy: S('Только для board: по чему раскладывать колонки (status, cat, type, step или f.<поле>)'),
      columns: A('Только для table: колонки', S('')),
      filter: O('Что показывать на странице', {
        query: S('Текстовый поиск'),
        categories: A('Категории', S('')),
        statuses: A('Статусы', S('')),
        types: A('Типы узлов', S('')),
        blockersOnly: B('Только блокеры'),
        fields: O('Свои поля: {ключ: [значения]}', {}),
      }),
    }, ['board', 'name', 'kind']),
    handler: (ctx, a) => ctx.edit(a.board, doc => {
      const p = D.addPage(doc, a);
      return { summary: 'добавлена страница из Claude', result: p };
    }),
  },
  {
    name: 'update_page',
    title: 'Изменить страницу',
    description: 'Название, фильтр, раскладка, колонки, пояснение над холстом.',
    inputSchema: O('', {
      board: BOARD, page: S('id страницы'),
      name: S('Новое название'),
      layout: S('canvas: auto | free'),
      lanes: A('canvas: подписи колонок', S('')),
      intro: S('Пояснение над холстом — HTML допускается'),
      groupBy: S('board: по чему колонки'),
      columns: A('table: колонки', S('')),
      sort: S('table: по какой колонке сортировать'),
      group: S('table: по чему группировать'),
      filter: O('Фильтр страницы', {}),
    }, ['board', 'page']),
    handler: (ctx, a) => ctx.edit(a.board, doc => {
      const p = D.updatePage(doc, a.page, a);
      return { summary: 'изменена страница из Claude', result: p };
    }),
  },
  {
    name: 'delete_page',
    title: 'Удалить страницу',
    description: 'Удаляет вид. Узлы остаются — пропадает только страница.',
    inputSchema: O('', { board: BOARD, page: S('id страницы') }, ['board', 'page']),
    handler: (ctx, a) => ctx.edit(a.board, doc => {
      const p = D.deletePage(doc, a.page);
      return { summary: 'убрана страница из Claude', result: p };
    }),
  },
  {
    name: 'reorder_pages',
    title: 'Порядок страниц',
    description: 'Переставляет страницы. Не перечисленные остаются в конце.',
    inputSchema: O('', { board: BOARD, order: A('id страниц по порядку', S('')) }, ['board', 'order']),
    handler: (ctx, a) => ctx.edit(a.board, doc => ({
      summary: 'порядок страниц из Claude', result: { pages: D.reorderPages(doc, a.order) },
    })),
  },

  /* ---------- расстановка на холсте ---------- */
  {
    name: 'place_nodes',
    title: 'Расставить узлы на холсте',
    description: 'Ставит узлы в конкретные координаты на конкретной странице-холсте и закрепляет их там. Координаты в единицах холста, шаг сетки 20; узел по умолчанию 210×64. Позиция своя у каждой страницы.',
    inputSchema: O('', {
      board: BOARD, page: S('id страницы-холста'),
      positions: A('Куда какой узел', O('', {
        node: S('id узла'), x: N('X'), y: N('Y'), w: N('Ширина'), h: N('Высота'),
      }, ['node', 'x', 'y'])),
    }, ['board', 'page', 'positions']),
    handler: (ctx, a) => ctx.edit(a.board, doc => {
      const ids = D.placeNodes(doc, a.page, a.positions);
      return { summary: `расставлено ${ids.length} узл. из Claude`, result: { placed: ids } };
    }),
  },
  {
    name: 'auto_layout',
    title: 'Вернуть авто-раскладку',
    description: 'Снимает ручные позиции на странице — узлы снова раскладываются по глубине зависимости.',
    inputSchema: O('', { board: BOARD, page: S('id страницы'), ids: A('Только эти узлы (по умолчанию все)', S('')) }, ['board', 'page']),
    handler: (ctx, a) => ctx.edit(a.board, doc => {
      const n = D.unplaceNodes(doc, a.page, a.ids);
      return { summary: 'авто-раскладка из Claude', result: { unpinned: n } };
    }),
  },

  /* ---------- схема ---------- */
  {
    name: 'edit_schema',
    title: 'Править схему доски',
    description: 'Типы узлов, статусы, категории и типы связей. При удалении узлы переезжают на первое оставшееся значение, а не теряются.',
    inputSchema: O('', {
      board: BOARD,
      op: S('add | update | delete'),
      kind: S('nodeType | status | category | linkType'),
      key: S('Ключ — для update и delete'),
      name: S('Название'),
      color: S('Цвет #rrggbb'),
      shape: S('nodeType: rect | pill | diamond'),
      style: S('linkType: solid | dashed'),
      blocking: B('linkType: считается зависимостью (по умолчанию да). Мягкая связь рисуется, но в вес узла не идёт'),
    }, ['board', 'op', 'kind']),
    handler: (ctx, a) => ctx.edit(a.board, doc => {
      let result;
      if (a.op === 'add') result = D.addSchemaItem(doc, a.kind, a);
      else if (a.op === 'update') result = D.updateSchemaItem(doc, a.kind, a.key, a);
      else if (a.op === 'delete') result = D.deleteSchemaItem(doc, a.kind, a.key);
      else throw new D.DocError('op должен быть add, update или delete');
      return { summary: 'правка схемы из Claude', result };
    }),
  },
  {
    name: 'edit_fields',
    title: 'Свои поля доски',
    description: 'Добавляет или убирает произвольные поля узлов (срок, ответственный, волна и что угодно ещё).',
    inputSchema: O('', {
      board: BOARD,
      op: S('add | delete'),
      key: S('Ключ поля — для delete'),
      label: S('Подпись поля'),
      type: S('text | longtext | select | list | number | date'),
      options: A('Для select: варианты', S('')),
      showOnCard: B('Показывать прямо на карточке узла'),
    }, ['board', 'op']),
    handler: (ctx, a) => ctx.edit(a.board, doc => {
      const result = a.op === 'add' ? D.addField(doc, a) : D.deleteField(doc, a.key);
      return { summary: 'правка полей из Claude', result };
    }),
  },

  /* ---------- области и заметки ---------- */
  {
    name: 'edit_frames',
    title: 'Области на холсте',
    description: 'Прямоугольные области, которыми группируют узлы на холсте.',
    inputSchema: O('', {
      board: BOARD, op: S('add | update | delete'), id: S('id области — для update и delete'),
      name: S('Подпись'), x: N('X'), y: N('Y'), w: N('Ширина'), h: N('Высота'), color: S('Цвет #rrggbb'),
    }, ['board', 'op']),
    handler: (ctx, a) => ctx.edit(a.board, doc => {
      const result = a.op === 'add' ? D.addFrame(doc, a)
        : a.op === 'update' ? D.updateFrame(doc, a.id, a) : D.deleteFrame(doc, a.id);
      return { summary: 'правка областей из Claude', result };
    }),
  },
  {
    name: 'edit_notes',
    title: 'Заметки на холсте',
    description: 'Свободные заметки поверх холста.',
    inputSchema: O('', {
      board: BOARD, op: S('add | update | delete'), id: S('id заметки — для update и delete'),
      text: S('Текст'), x: N('X'), y: N('Y'), w: N('Ширина'), h: N('Высота'), color: S('Цвет #rrggbb'),
    }, ['board', 'op']),
    handler: (ctx, a) => ctx.edit(a.board, doc => {
      const result = a.op === 'add' ? D.addNote(doc, a)
        : a.op === 'update' ? D.updateNote(doc, a.id, a) : D.deleteNote(doc, a.id);
      return { summary: 'правка заметок из Claude', result };
    }),
  },

  /* ---------- свободная доска ---------- */
  {
    name: 'jam_add',
    title: 'Свободная доска: положить объекты',
    description: 'Стикеры, фигуры, текст, рисунки и коннекторы на страницу kind=jam. '
      + 'Координаты — в единицах холста, начало в левом верхнем углу, ось Y вниз. '
      + 'Порядок в ответе = порядок наложения: что добавлено позже, лежит выше. '
      + 'Коннектор здесь — ЛИНИЯ, а не зависимость: на слои, вес узла и критический путь он не влияет.',
    inputSchema: O('', {
      board: BOARD,
      page: S('id страницы-доски'),
      items: A('Что положить', O('', {
        kind: S('sticky — стикер, shape — фигура, text — текст, draw — рисунок, conn — коннектор, section — секция',
          { enum: ['sticky', 'shape', 'text', 'draw', 'conn', 'section'] }),
        x: N('X'), y: N('Y'), w: N('Ширина'), h: N('Высота'),
        text: S('Текст внутри объекта'),
        fill: S('Заливка #rrggbb'),
        stroke: S('Цвет линии #rrggbb'),
        sw: N('Толщина линии'),
        rotation: N('Поворот в градусах'),
        shape: S('Форма для kind=shape', { enum: ['rect', 'roundrect', 'ellipse', 'diamond', 'triangle', 'star', 'arrow'] }),
        points: S('Для kind=draw: пары «x,y» через пробел, ОТНОСИТЕЛЬНО x/y объекта. Например «0,0 20,18 44,6»'),
        from: S('Для kind=conn: id объекта доски, либо node:<id узла графа>, положенного на эту доску'),
        to: S('Для kind=conn: то же, что from'),
        style: S('Для kind=conn', { enum: ['curve', 'ortho', 'line'] }),
        cap_start: S('Наконечник в начале', { enum: ['none', 'arrow', 'dot'] }),
        cap_end: S('Наконечник в конце', { enum: ['none', 'arrow', 'dot'] }),
      }, ['kind'])),
    }, ['board', 'page', 'items']),
    handler: (ctx, a) => ctx.edit(a.board, doc => {
      const added = D.jamAdd(doc, a.page, a.items);
      return { summary: `+${added.length} об. на доске из Claude`, result: { added, count: added.length } };
    }),
  },
  {
    name: 'jam_update',
    title: 'Свободная доска: править объекты',
    description: 'Меняет только те поля, что присланы. Остальные, включая незнакомые, не трогаются.',
    inputSchema: O('', {
      board: BOARD, page: S('id страницы-доски'),
      items: A('Что поменять', O('', {
        id: S('id объекта'),
        x: N('X'), y: N('Y'), w: N('Ширина'), h: N('Высота'),
        text: S('Текст'), fill: S('Заливка #rrggbb'), stroke: S('Цвет линии #rrggbb'), sw: N('Толщина'),
        rotation: N('Поворот в градусах'), lock: B('Запретить правку мышью'),
        shape: S('Форма', { enum: ['rect', 'roundrect', 'ellipse', 'diamond', 'triangle', 'star', 'arrow'] }),
        points: S('Точки рисунка'),
        from: S('Начало коннектора'), to: S('Конец коннектора'),
        style: S('Стиль линии', { enum: ['curve', 'ortho', 'line'] }),
        cap_start: S('Наконечник в начале', { enum: ['none', 'arrow', 'dot'] }),
        cap_end: S('Наконечник в конце', { enum: ['none', 'arrow', 'dot'] }),
      }, ['id'])),
    }, ['board', 'page', 'items']),
    handler: (ctx, a) => ctx.edit(a.board, doc => {
      const updated = D.jamUpdate(doc, a.page, a.items);
      return { summary: `правка ${updated.length} об. на доске из Claude`, result: { updated } };
    }),
  },
  {
    name: 'jam_delete',
    title: 'Свободная доска: убрать объекты',
    description: 'Коннекторы, у которых пропал конец, удаляются вместе с объектом — линия в никуда смысла не имеет.',
    inputSchema: O('', {
      board: BOARD, page: S('id страницы-доски'), items: A('id объектов', S('id')),
    }, ['board', 'page', 'items']),
    handler: (ctx, a) => ctx.edit(a.board, doc => {
      const result = D.jamDelete(doc, a.page, a.items);
      return { summary: `−${result.removed} об. с доски из Claude`, result };
    }),
  },
  {
    name: 'jam_read',
    title: 'Свободная доска: прочитать объекты',
    description: 'Объекты одной доски. Отдельный вызов, а не часть get_board: объектов на доске '
      + 'бывает больше, чем всего остального документа, и тащить их в каждое чтение доски — жечь контекст.',
    inputSchema: O('', { board: BOARD, page: S('id страницы-доски') }, ['board', 'page']),
    handler: (ctx, a) => {
      const { board, doc } = ctx.load(a.board);
      const items = D.jamRead(doc, a.page);
      return { board: board.id, page: a.page, count: items.length, items };
    },
  },
  {
    name: 'jam_arrange',
    title: 'Свободная доска: разложить объекты',
    description: 'Выравнивание, раскладка в ряд, в столбец и в сетку, а также порядок наложения. '
      + 'Без items берёт все объекты доски.',
    inputSchema: O('', {
      board: BOARD, page: S('id страницы-доски'),
      items: A('id объектов; без него — все', S('id')),
      op: S('Что сделать', { enum: ['front', 'back', 'align_left', 'align_right', 'align_top', 'align_bottom', 'stack_h', 'stack_v', 'grid'] }),
      gap: N('Промежуток для stack_* и grid, по умолчанию 40'),
    }, ['board', 'page', 'op']),
    handler: (ctx, a) => ctx.edit(a.board, doc => {
      const result = D.jamArrange(doc, a.page, a.items, a.op, a.gap);
      return { summary: `раскладка доски (${a.op}) из Claude`, result };
    }),
  },
  /* ---------- конструктор KYC Flow ---------- */
  {
    name: 'flow_lib_read',
    title: 'Конструктор: прочитать библиотеку',
    description: 'Библиотека блоков конструктора — общая для всех страниц kind=flow доски: измерения клиента (dims), '
      + 'источники с полями (sources), проверки со входами и вердиктами (checks), исходы (outcomes), виды вердиктов (verdicts). '
      + 'Без section — вся библиотека; ids сужает выборку.',
    inputSchema: O('', {
      board: BOARD,
      section: S('Раздел', { enum: LIB_SECTIONS }),
      ids: A('id блоков (у вердиктов — key)', S('id')),
    }, ['board']),
    handler: (ctx, a) => {
      const { board, doc } = ctx.load(a.board);
      return { board: board.id, ...F.libRead(doc, a.section, a.ids) };
    },
  },
  {
    name: 'flow_lib_upsert',
    title: 'Конструктор: создать или изменить блоки библиотеки',
    description: 'Блок с известным id (у вердиктов — key) правится: меняются только присланные поля. Без id или с новым id — создаётся, '
      + 'тогда name обязателен. Поля: dims — code, name, desc, values[{id?, name, code?, desc?, wave?}]; '
      + 'sources — name, kind, access, mode, status, providers, url, cost, note, fields[{id?, name, type, desc?}]; '
      + 'checks — code, name, how, why, rule, norm, factors[], inputs[{id?, name, type}], verdicts[ключи], verdictTbd, '
      + 'bank{status, comment}, wave, actor, note, comment, srcText, tags[]; outcomes — name, verdict, desc; verdicts — name, color. '
      + 'Списки values/fields/inputs приходят ЦЕЛИКОМ: элемент с известным id правится, без id — создаётся, '
      + 'пропавший — удаляется вместе со связями к его сокету на всех схемах (их перечислит dropped_edges). '
      + 'Типы данных: bool, text, number, money, date, list, person, file, any. Правка общая: блок меняется на всех страницах.',
    inputSchema: O('', {
      board: BOARD,
      section: S('Раздел', { enum: LIB_SECTIONS }),
      items: A('Блоки', O('Блок раздела; набор полей — в описании инструмента', {
        id: S('id блока; без него — новый'), key: S('Для вердикта — ключ'), name: S('Название'),
      })),
    }, ['board', 'section', 'items']),
    handler: (ctx, a) => ctx.edit(a.board, doc => {
      const r = F.libUpsert(doc, a.section, a.items);
      const parts = [r.created.length ? '+' + F.plural(r.created.length, 'блок', 'блока', 'блоков') : '',
        r.updated.length ? 'изменено ' + r.updated.length : ''].filter(Boolean).join(', ');
      return { summary: `библиотека конструктора: ${parts} из Claude`, result: r };
    }),
  },
  {
    name: 'flow_lib_delete',
    title: 'Конструктор: удалить блоки библиотеки',
    description: 'Без force отказывает, если блок стоит на схемах, и перечисляет где. С force=true блок удаляется вместе '
      + 'со своими нодами на всех страницах и их связями. Вердикт с force снимается с проверок, а исходы переходят на первый оставшийся.',
    inputSchema: O('', {
      board: BOARD,
      section: S('Раздел', { enum: LIB_SECTIONS }),
      ids: A('id блоков (у вердиктов — key)', S('id')),
      force: B('Удалить и с нод на схемах'),
    }, ['board', 'section', 'ids']),
    handler: (ctx, a) => ctx.edit(a.board, doc => {
      const r = F.libDelete(doc, a.section, a.ids, !!a.force);
      return { summary: `библиотека конструктора: −${F.plural(r.deleted.length, 'блок', 'блока', 'блоков')} из Claude`, result: r };
    }),
  },
  {
    name: 'flow_read',
    title: 'Конструктор: прочитать схему',
    description: 'detail=summary (по умолчанию) — счётчики, этапы в порядке исполнения с кодами проверок, профили и находки валидатора. '
      + 'detail=full — ещё все ноды с сокетами (h — имя сокета для flow_connect) и все связи в виде «нода.сокет».',
    inputSchema: O('', {
      board: BOARD,
      page: S('Страница-конструктор: id или название'),
      detail: S('Подробность', { enum: ['summary', 'full'] }),
    }, ['board', 'page']),
    handler: (ctx, a) => {
      const { board, doc } = ctx.load(a.board);
      return { board: board.id, ...F.flowRead(doc, F.flowPage(doc, a.page), a.detail) };
    },
  },
  {
    name: 'flow_add',
    title: 'Конструктор: поставить ноды',
    description: 'Ноды измерения, источника, проверки и исхода (dim, source, check, outcome) ставятся по ref — id блока библиотеки; '
      + 'проверка стоит на странице один раз. Остальные виды несут data: stage {num, name, point}, gate {text}, '
      + 'anyof {type, n, label}, calc {name, formula, type, inputs[{id?, name, type}]}, note {text}; reroute — без данных. '
      + 'parent — id рамки этапа (в неё кладутся check, calc, anyof, note, reroute), тогда x/y — относительно рамки. '
      + 'Без x/y нода встаёт в столбец справа от схемы, а ребёнок рамки — в её столбец под последней нодой. '
      + 'В ответе у каждой ноды сокеты — по ним соединяет flow_connect.',
    inputSchema: O('', {
      board: BOARD,
      page: S('Страница-конструктор: id или название'),
      nodes: A('Ноды', O('', {
        k: S('Вид ноды', { enum: NODE_KINDS }),
        ref: S('id блока библиотеки — для dim, source, check, outcome'),
        id: S('Свой id ноды; без него — n_<ref>'),
        x: N('X'), y: N('Y'),
        parent: S('id рамки этапа'),
        data: O('Данные ноды не из библиотеки — см. описание', {}),
        w: N('Ширина — только stage и note'), h: N('Высота — только stage и note'),
        collapsed: B('Свернуть'), muted: B('Выключить: нода остаётся на схеме, но не участвует'),
      }, ['k'])),
    }, ['board', 'page', 'nodes']),
    handler: (ctx, a) => ctx.edit(a.board, doc => {
      const pg = F.flowPage(doc, a.page);
      const r = F.flowAdd(doc, pg, a.nodes);
      return { summary: `+${F.plural(r.added.length, 'нода', 'ноды', 'нод')} на схеме «${pg.name}» из Claude`, result: { page: pg.id, ...r } };
    }),
  },
  {
    name: 'flow_update',
    title: 'Конструктор: изменить ноды',
    description: 'Положение, рамка, свёртка, выключение и данные нод не из библиотеки. parent=null вынимает из рамки; '
      + 'смена рамки без x/y сохраняет место ноды на экране. data сливается с прежними данными, null в поле удаляет его. '
      + 'Содержимое блоков библиотеки (название проверки, поля источника) правится через flow_lib_upsert.',
    inputSchema: O('', {
      board: BOARD,
      page: S('Страница-конструктор: id или название'),
      nodes: A('Что поменять', O('', {
        id: S('id ноды'),
        x: N('X'), y: N('Y'),
        parent: { type: ['string', 'null'], description: 'id рамки этапа; null — вынуть из рамки' },
        data: O('Данные ноды не из библиотеки', {}),
        w: N('Ширина — только stage и note'), h: N('Высота — только stage и note'),
        fit: B('Рамка подгоняется под содержимое'),
        collapsed: B('Свернуть'), muted: B('Выключить'),
      }, ['id'])),
    }, ['board', 'page', 'nodes']),
    handler: (ctx, a) => ctx.edit(a.board, doc => {
      const pg = F.flowPage(doc, a.page);
      const r = F.flowUpdate(doc, pg, a.nodes);
      return { summary: `правка ${F.plural(r.updated.length, 'ноды', 'нод', 'нод')} на схеме «${pg.name}» из Claude`, result: { page: pg.id, ...r } };
    }),
  },
  {
    name: 'flow_delete',
    title: 'Конструктор: удалить ноды',
    description: 'Удаляет ноды со схемы вместе с их связями. Блоки библиотеки остаются. Дети удалённой рамки остаются на своих местах.',
    inputSchema: O('', {
      board: BOARD, page: S('Страница-конструктор: id или название'), ids: A('id нод', S('id')),
    }, ['board', 'page', 'ids']),
    handler: (ctx, a) => ctx.edit(a.board, doc => {
      const pg = F.flowPage(doc, a.page);
      const r = F.flowDelete(doc, pg, a.ids);
      return { summary: `−${F.plural(r.removed, 'нода', 'ноды', 'нод')} со схемы «${pg.name}» из Claude`, result: { page: pg.id, ...r } };
    }),
  },
  {
    name: 'flow_connect',
    title: 'Конструктор: соединить сокеты',
    description: 'Связь — «нода.сокет» → «нода.сокет», по тем же правилам, что в приложении: тип данных совпадает, '
      + 'в исход ведут только вердикт или порядок, порядок исполнения без циклов. Сокеты: источник — out:<поле>; '
      + 'проверка — входы exec-in, cond-in, in:<вход>, выходы exec-out, v:<вердикт>; измерение — val:<значение>; '
      + 'исход — vin; рамка — exec-in, cond-in, exec-out; гейт — exec-in, exec-out (да), exec-no (нет); '
      + 'один из — in:0…, out; показатель — in:<вход>, out; reroute — in, out. Префикс можно опустить: '
      + '«n_src_egrul.f_inn» = «n_src_egrul.out:f_inn», «exec» и «cond» — порядок и применимость. '
      + 'neg — «кроме» на связи применимости (значение измерения → cond-in). Новая связь во вход данных заменяет старую. '
      + 'Что не подошло, попадает в skipped с причиной; повтор существующей связи — тоже skipped, версия доски при этом не растёт.',
    inputSchema: O('', {
      board: BOARD,
      page: S('Страница-конструктор: id или название'),
      edges: A('Связи', O('', {
        from: S('«нода.сокет» — откуда'), to: S('«нода.сокет» — куда'),
        neg: B('«кроме»: проверка применима ко всем значениям, кроме этого'),
      }, ['from', 'to'])),
    }, ['board', 'page', 'edges']),
    handler: (ctx, a) => ctx.edit(a.board, doc => {
      const pg = F.flowPage(doc, a.page);
      const r = F.flowConnect(doc, pg, a.edges);
      return { summary: `+${F.plural(r.added.length, 'связь', 'связи', 'связей')} схемы «${pg.name}» из Claude`, result: { page: pg.id, ...r } };
    }),
  },
  {
    name: 'flow_disconnect',
    title: 'Конструктор: разорвать связи',
    description: 'Удаляет связи по id (id видны в flow_read с detail=full и в ответе flow_connect).',
    inputSchema: O('', {
      board: BOARD, page: S('Страница-конструктор: id или название'), ids: A('id связей', S('id')),
    }, ['board', 'page', 'ids']),
    handler: (ctx, a) => ctx.edit(a.board, doc => {
      const pg = F.flowPage(doc, a.page);
      const r = F.flowDisconnect(doc, pg, a.ids);
      return { summary: `−${F.plural(r.removed, 'связь', 'связи', 'связей')} схемы «${pg.name}» из Claude`, result: { page: pg.id, ...r } };
    }),
  },
  {
    name: 'flow_layout',
    title: 'Конструктор: разложить схему',
    description: 'Авто-раскладка (ELK) — та же, что у кнопки «Разложить»: слоями слева направо, проверки в рамке этапа — столбцом по коду.',
    inputSchema: O('', { board: BOARD, page: S('Страница-конструктор: id или название') }, ['board', 'page']),
    handler: async (ctx, a) => {
      const { doc } = ctx.load(a.board);
      const lay = await F.layoutPlan(doc, F.flowPage(doc, a.page));
      return ctx.edit(a.board, d => {
        const pg = F.flowPage(d, a.page);
        return { summary: `раскладка схемы «${pg.name}» из Claude`, result: { page: pg.id, ...F.layoutApply(pg, lay) } };
      });
    },
  },
  {
    name: 'flow_profile',
    title: 'Конструктор: профиль клиента',
    description: 'Что участвует для данного профиля клиента: активные проверки, нужные источники, достижимые исходы и входы без источника — '
      + 'те же числа, что в сводке над схемой. profile — id или название сохранённого профиля страницы; '
      + 'или sel — выбор значений измерений {измерение: [значения]} (id или названия). Пустое измерение = любое значение. '
      + 'Без обоих — вся схема.',
    inputSchema: O('', {
      board: BOARD,
      page: S('Страница-конструктор: id или название'),
      profile: S('Сохранённый профиль: id или название'),
      sel: O('Выбор значений измерений: {dim_ctype: ["v_ip"]}', {}),
    }, ['board', 'page']),
    handler: (ctx, a) => {
      const { board, doc } = ctx.load(a.board);
      return { board: board.id, ...F.flowProfile(doc, F.flowPage(doc, a.page), a) };
    },
  },
  {
    name: 'flow_export',
    title: 'Конструктор: контракт kycflow/1',
    description: 'JSON-контракт страницы: этапы в порядке исполнения, у каждого входа проверки — источники по приоритету, '
      + 'у вердикта — куда он ведёт, словари и замечания (issues). С profile — только применимые к профилю проверки.',
    inputSchema: O('', {
      board: BOARD,
      page: S('Страница-конструктор: id или название'),
      profile: S('Сохранённый профиль: id или название'),
    }, ['board', 'page']),
    handler: (ctx, a) => {
      const { doc } = ctx.load(a.board);
      return F.flowExport(doc, F.flowPage(doc, a.page), a);
    },
  },

  /* ---------- история и доступ ---------- */
  {
    name: 'board_history',
    title: 'История доски',
    description: 'Кто и когда что менял. Любую версию можно вернуть — restore_version. Недавняя история хранится целиком; версии старше недели прореживаются (час/день/неделя), самая первая остаётся всегда.',
    inputSchema: O('', { board: BOARD }, ['board']),
    handler: (ctx, a) => {
      const { board } = ctx.load(a.board);
      return {
        current: board.version,
        versions: ctx.db.prepare(`SELECT v.version, v.at, v.summary, v.nodes, v.links, u.email AS author
          FROM board_versions v LEFT JOIN users u ON u.id = v.actor_id
          WHERE v.board_id = ? ORDER BY v.version DESC LIMIT 40`).all(board.id)
          .map(v => ({ version: v.version, at: new Date(v.at).toISOString(), summary: v.summary,
            nodes: v.nodes, links: v.links, author: v.author })),
      };
    },
  },
  {
    name: 'restore_version',
    title: 'Вернуть версию',
    description: 'Возвращает доску к прежней версии. История при этом не стирается: поверх ложится новая версия.',
    inputSchema: O('', { board: BOARD, version: N('Номер версии') }, ['board', 'version']),
    handler: (ctx, a) => {
      const { board, role } = ctx.load(a.board);
      if (!ctx.boards.canEdit(role)) throw new D.DocError('эту доску вам разрешено только смотреть');
      const row = ctx.db.prepare('SELECT * FROM board_versions WHERE board_id = ? AND version = ?').get(board.id, +a.version);
      if (!row) throw new D.DocError('этой версии уже нет в истории');
      const r = ctx.boards.saveBoard(board, ctx.user, JSON.parse(ctx.boards.versionDoc(row)),
        { summary: `возврат к версии ${row.version} из Claude` });
      return { restored: row.version, version: r.version };
    },
  },
  {
    name: 'share_board',
    title: 'Ссылка на доску',
    description: 'Создаёт ссылку: на просмотр (открывается без входа) или на правку (требует входа, чтобы у изменений был автор).',
    inputSchema: O('', {
      board: BOARD,
      role: S('viewer — только смотреть, editor — можно править'),
      days: N('Через сколько дней ссылка перестанет работать (0 — бессрочно)'),
    }, ['board']),
    handler: (ctx, a) => {
      const { board, role } = ctx.load(a.board);
      if (role !== 'owner' && role !== 'admin') throw new D.DocError('делиться доской может только владелец');
      const wanted = a.role === 'editor' ? 'editor' : 'viewer';
      const token = ctx.newToken();
      const days = +(a.days || 0);
      ctx.db.prepare('INSERT INTO share_links (token, board_id, role, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?)')
        .run(token, board.id, wanted, ctx.user.id, Date.now(), days > 0 ? Date.now() + days * 864e5 : null);
      return { url: ctx.publicUrl + (wanted === 'editor' ? '/e/' : '/s/') + token, role: wanted };
    },
  },
];

/* ---------- заготовка новой доски ---------- */
function blankDoc(a) {
  const mk = (list, fallback, extra) => (Array.isArray(list) && list.length ? list : fallback)
    .map((x, i) => {
      const name = String(x.name || x);
      return { key: D.keyFrom(name, []) + (i ? '_' + i : ''), name, ...extra(x, i) };
    });
  const statuses = mk(a.statuses, [
    { name: 'готово', color: '#18a558' }, { name: 'в работе', color: '#8a5d00' },
    { name: 'заблокировано', color: '#b3261e' }, { name: 'не начато', color: '#5f6673' },
  ], x => ({ color: /^#[0-9a-f]{6}$/i.test(x.color || '') ? x.color : '#9aa1b2' }));
  const categories = mk(a.categories, [{ name: 'Общее', color: '#2f6fed' }],
    x => ({ color: /^#[0-9a-f]{6}$/i.test(x.color || '') ? x.color : '#2f6fed' }));
  const nodeTypes = mk(a.node_types, [{ name: 'Узел', shape: 'rect' }, { name: 'Гейт', shape: 'pill' }],
    x => ({ shape: D.SHAPES.includes(x.shape) ? x.shape : 'rect' }));

  const doc = {
    name: String(a.name), desc: String(a.description || ''),
    created: new Date().toISOString().slice(0, 10), updated: new Date().toISOString().slice(0, 10),
    schema: {
      nodeTypes, statuses, categories,
      linkTypes: [
        { key: 'hard', name: 'Жёсткая блокировка', color: '#9aa1b2', style: 'solid', blocking: 1 },
        { key: 'soft', name: 'Мягкая связь', color: '#c9a227', style: 'dashed', blocking: 0 },
      ],
      fields: [],
    },
    nodes: [], links: [], frames: [], notes: [], pages: [],
  };
  const pages = Array.isArray(a.pages) && a.pages.length ? a.pages
    : [{ name: 'Карта', kind: 'canvas' }, { name: 'Все узлы', kind: 'table' }, { name: 'Обзор', kind: 'dash' }];
  for (const p of pages) D.addPage(doc, p);
  return doc;
}
