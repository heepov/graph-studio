-- OAuth для MCP-коннектора.
--
-- Claude-коннектор ходит к доскам от имени человека, а не «вообще». Без входа
-- сервер не знает, чьи доски показывать, и любой, кто узнал адрес, получил бы
-- к ним доступ. Поэтому здесь честный OAuth 2.1: код с PKCE, токен с привязкой
-- к аудитории, отзыв через удаление строки.
--
-- Секреты и токены лежат ХЭШАМИ. Утечка дампа базы не должна давать доступ
-- к чужим доскам — ровно по той же причине, по которой рядом лежат scrypt-хэши
-- паролей, а не пароли.

-- Клиент регистрируется сам (RFC 7591): у Claude нет заранее выданного client_id,
-- а выдавать его руками каждому устройству — это ручная работа на каждый телефон.
CREATE TABLE oauth_clients (
  id            TEXT PRIMARY KEY,          -- client_id
  secret_hash   TEXT,                      -- NULL для публичного клиента (PKCE без секрета)
  name          TEXT NOT NULL DEFAULT '',
  redirect_uris TEXT NOT NULL,             -- JSON-массив, сверяется точным совпадением
  created_at    INTEGER NOT NULL,
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL
);

-- Код живёт минуты и сгорает при первом обмене: повторное использование кода —
-- признак кражи, и такой код не должен работать второй раз.
CREATE TABLE oauth_codes (
  code           TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,            -- только S256
  scope          TEXT NOT NULL DEFAULT '',
  resource       TEXT,                     -- RFC 8707: для какого ресурса просят токен
  expires_at     INTEGER NOT NULL,
  used           INTEGER NOT NULL DEFAULT 0
);

-- Токены доступа и обновления в одной таблице: различаются полем kind.
-- Отзыв аккаунта или смена пароля должны выкидывать и коннектор тоже,
-- поэтому строки привязаны к пользователю каскадом.
CREATE TABLE oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  client_id  TEXT NOT NULL,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope      TEXT NOT NULL DEFAULT '',
  audience   TEXT,                          -- токен годен только для этого ресурса
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  last_used  INTEGER
);
CREATE INDEX idx_oauth_tokens_user ON oauth_tokens(user_id, kind);
