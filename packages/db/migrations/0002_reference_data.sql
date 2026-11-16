-- 0002_reference_data (hand-written; drizzle-kit --custom)
-- Reference data mirrored from @lekvero/shared (PRIZE_CATEGORIES, PRIZE_STRUCTURES).
-- An integration test asserts this data equals the shared constants.
-- No prize AMOUNTS are stored here (ADR-0001 / ADR-0002 D2).
-- Recovery: additive migration on a new database (M3). Not reversible in place; recover by
-- dropping/recreating the database (local/test) or restoring a backup (hosted). See docs/runbooks/database.md §3.

INSERT INTO source (code, name, base_url, licence, terms_url, is_authoritative) VALUES
  ('glo_api', 'Government Lottery Office (GLO) public API', 'https://www.glo.or.th/api',
   'Creative Commons Non-Commercial (Any) per gdcatalog dataset_c4-9_01; usage terms unconfirmed - see docs/legal/',
   NULL, true);
--> statement-breakpoint

INSERT INTO prize_category (code, name_th, name_en, match_type, digits, sort_order) VALUES
  ('first',  'รางวัลที่ 1',                 'First prize',              'EXACT6',  6, 1),
  ('near1',  'รางวัลข้างเคียงรางวัลที่ 1',    'Adjacent to first prize',  'EXACT6',  6, 2),
  ('second', 'รางวัลที่ 2',                 'Second prize',             'EXACT6',  6, 3),
  ('third',  'รางวัลที่ 3',                 'Third prize',              'EXACT6',  6, 4),
  ('fourth', 'รางวัลที่ 4',                 'Fourth prize',             'EXACT6',  6, 5),
  ('fifth',  'รางวัลที่ 5',                 'Fifth prize',              'EXACT6',  6, 6),
  ('last3f', 'รางวัลเลขหน้า 3 ตัว',          'First three digits',       'PREFIX3', 3, 7),
  ('last3b', 'รางวัลเลขท้าย 3 ตัว',          'Last three digits',        'SUFFIX3', 3, 8),
  ('last2',  'รางวัลเลขท้าย 2 ตัว',          'Last two digits',          'SUFFIX2', 2, 9);
--> statement-breakpoint

-- Observed dates are informational only (archived fixtures), never used for inference (D1).
INSERT INTO prize_structure (code, description, first_observed_draw, last_observed_draw) VALUES
  ('LEGACY_LAST3X4', 'Older structure: four "last three digits" prizes, no "first three digits" prize.', '2011-02-01', '2015-01-16'),
  ('MODERN_FRONT3_BACK3', 'Current structure: two "first three digits" and two "last three digits" prizes.', '2020-01-17', NULL);
--> statement-breakpoint

INSERT INTO prize_structure_rule (prize_structure_id, prize_category_id, expected_count)
SELECT s.id, c.id, v.cnt
FROM (VALUES
  ('LEGACY_LAST3X4','first',1), ('LEGACY_LAST3X4','near1',2), ('LEGACY_LAST3X4','second',5),
  ('LEGACY_LAST3X4','third',10), ('LEGACY_LAST3X4','fourth',50), ('LEGACY_LAST3X4','fifth',100),
  ('LEGACY_LAST3X4','last3b',4), ('LEGACY_LAST3X4','last2',1),
  ('MODERN_FRONT3_BACK3','first',1), ('MODERN_FRONT3_BACK3','near1',2), ('MODERN_FRONT3_BACK3','second',5),
  ('MODERN_FRONT3_BACK3','third',10), ('MODERN_FRONT3_BACK3','fourth',50), ('MODERN_FRONT3_BACK3','fifth',100),
  ('MODERN_FRONT3_BACK3','last3f',2), ('MODERN_FRONT3_BACK3','last3b',2), ('MODERN_FRONT3_BACK3','last2',1)
) AS v(structure, category, cnt)
JOIN prize_structure s ON s.code = v.structure
JOIN prize_category c ON c.code = v.category;
