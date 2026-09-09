-- Пользователи. Регистрация только по приглашению или по ссылке на доску:
-- сайт открыт в интернете, и открытая регистрация означала бы чужие аккаунты
-- на личном сервере.
CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name        TEXT NOT NULL DEFAULT '',
  pass_hash   TEXT NOT NULL,
  is_admin    INTEGER NOT NULL DEFAULT 0,
  blocked     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER
);

-- Сессии в таблице, а не JWT: разлогинить и заблокировать человека нужно
-- немедленно, а отозвать выданный JWT нельзя.
CREATE TABLE sessions (
  token       TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  user_agent  TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_exp  ON sessions(expires_at);

-- Доска = проект Graph Studio. Документ хранится как есть, текстом:
-- сервер его не разбирает, кроме подсчёта пары чисел для списка.
CREATE TABLE boards (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL DEFAULT '',
  doc         TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  nodes_count INTEGER NOT NULL DEFAULT 0,
  links_count INTEGER NOT NULL DEFAULT 0,
  deleted     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_boards_owner ON boards(owner_id, deleted);

-- Доступ конкретного человека к доске.
CREATE TABLE board_members (
  board_id  TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  added_at  INTEGER NOT NULL,
  PRIMARY KEY (board_id, user_id)
);
CREATE INDEX idx_members_user ON board_members(user_id);

-- Ссылки-доступы: /s/<token> на просмотр, /e/<token> на правку.
-- Правка требует входа — иначе у изменения не будет настоящего автора
-- и история «кто что поменял» превратится в «гость по ссылке».
CREATE TABLE share_links (
  token       TEXT PRIMARY KEY,
  board_id    TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER,
  revoked     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_share_board ON share_links(board_id);

-- Приглашения: единственный способ завести аккаунт помимо ссылки на доску.
CREATE TABLE invites (
  token       TEXT PRIMARY KEY,
  email       TEXT COLLATE NOCASE,
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER,
  used_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  used_at     INTEGER
);

-- История изменений. Заполняется этапом 4, таблица заводится сразу,
-- чтобы не мигрировать боевую базу ради неё отдельно.
CREATE TABLE events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id   TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  actor_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  at         INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  entity     TEXT,
  payload    TEXT
);
CREATE INDEX idx_events_board ON events(board_id, seq);

-- Журнал доступа админа к чужим доскам: отдельная сущность, чтобы «админ смотрел»
-- не смешивалось с обычной работой и было видно в аудите.
CREATE TABLE admin_access_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  board_id  TEXT NOT NULL,
  at        INTEGER NOT NULL,
  action    TEXT NOT NULL
);
