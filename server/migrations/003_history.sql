-- История изменений доски.
--
-- Зачем отдельная таблица с полным документом, а не только события: чтобы
-- «вернуть эту версию» была не обещанием, а работающей кнопкой. Событие без
-- документа отвечает на вопрос «что изменилось», но не на «верни как было».
--
-- Хранится последние N версий на доску (прореживает сам код при записи):
-- документ по сотне-другой килобайт, и держать их бесконечно значит незаметно
-- растить базу до размера, при котором бэкап перестанет быть дешёвым.
--
-- summary — короткая фраза «что поменялось» — приходит ОТ КЛИЕНТА. Сервер
-- документ не разбирает (см. boards.js), и считать разницу здесь значило бы
-- завести вторую реализацию формата, которая начнёт отставать от первой.
CREATE TABLE board_versions (
  board_id  TEXT    NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  version   INTEGER NOT NULL,
  at        INTEGER NOT NULL,
  actor_id  TEXT    REFERENCES users(id) ON DELETE SET NULL,
  summary   TEXT,
  nodes     INTEGER NOT NULL DEFAULT 0,
  links     INTEGER NOT NULL DEFAULT 0,
  doc       TEXT    NOT NULL,
  PRIMARY KEY (board_id, version)
);
CREATE INDEX idx_bv_board ON board_versions(board_id, version DESC);
