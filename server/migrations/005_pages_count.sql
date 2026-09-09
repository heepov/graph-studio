-- Число страниц доски в списке.
--
-- Без него, чтобы понять «та ли это доска», приходится читать документ целиком:
-- сотни килобайт ради одного числа. Считается там же, где узлы и связи —
-- в единственной точке записи (boards.js), поэтому разъехаться не может.
ALTER TABLE boards ADD COLUMN pages_count INTEGER NOT NULL DEFAULT 0;

-- Заполняем существующие. json_valid — страховка: одна битая строка не должна
-- ронять миграцию, а вместе с ней и весь контейнер.
UPDATE boards SET pages_count = COALESCE(json_array_length(doc, '$.pages'), 0) WHERE json_valid(doc);
