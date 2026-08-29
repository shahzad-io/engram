-- Probes whether each windowed table refuses a retroactive window change.
-- Intended to be run against a THROWAWAY CLONE of the graph: it mutates rows
-- and does not roll back, so an accepted mutation is visibly accepted rather
-- than hidden by a rollback.
--
-- Reports ACCEPTED / REFUSED / VACUOUS per case. VACUOUS means the statement
-- ran but matched zero rows. It is reported separately because an earlier
-- version of this probe counted that as ACCEPTED, which made unguarded tables
-- look guarded; and because case order matters here — a reopen that succeeds
-- leaves no closed row for a later case to probe, so the closed-window cases
-- run before the reopens.
--
-- Target versions are literals that exist in graph_versions (1..10 on the
-- validation graph) rather than `valid_from + 1`, which lands on version 11
-- for the newest rows and is then refused by a foreign key — a refusal that
-- looks like the rule working when it is not.

\set ON_ERROR_STOP off
\pset pager off

CREATE OR REPLACE FUNCTION probe_case(label text, statement text)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  affected bigint;
BEGIN
  EXECUTE statement;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected = 0 THEN
    RAISE NOTICE '% -> VACUOUS (statement ran, matched 0 rows)', label;
  ELSE
    RAISE NOTICE '% -> ACCEPTED (% row(s))', label, affected;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE '% -> REFUSED (%)', label, SQLERRM;
END;
$$;

DO $$
DECLARE
  seeded bigint;
  closed_relations bigint;
  closed_objects bigint;
BEGIN
  INSERT INTO feature_label_aliases (label_id, alias, project_scope_id, valid_from_version, valid_to_version)
  VALUES ('FTL-0001', 'probe-alias-closed', 'project_mira', 3, NULL),
         ('FTL-0001', 'probe-alias-open', 'project_mira', 3, NULL)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS seeded = ROW_COUNT;

  SELECT count(*) INTO closed_relations FROM relations WHERE valid_to_version IS NOT NULL;
  SELECT count(*) INTO closed_objects FROM knowledge_objects WHERE valid_to_version IS NOT NULL;

  -- Assert the starting state, so a probe run on an unexpected graph fails
  -- loudly instead of reporting VACUOUS for half its cases.
  IF seeded <> 2 THEN
    RAISE EXCEPTION 'SEED FAILED: expected 2 alias rows, inserted %', seeded;
  END IF;
  IF closed_relations < 1 OR closed_objects < 1 THEN
    RAISE EXCEPTION 'SEED FAILED: need a closed relation and a closed object, have %, %',
      closed_relations, closed_objects;
  END IF;
END;
$$;

\echo '--- legitimate close: must be ACCEPTED before and after (monotonicity, not immutability)'

SELECT probe_case('feature_labels legitimate close',
  $$UPDATE feature_labels SET valid_to_version = 10
    WHERE id = 'FTL-0002' AND valid_to_version IS NULL$$);

SELECT probe_case('feature_label_aliases legitimate close',
  $$UPDATE feature_label_aliases SET valid_to_version = 10
    WHERE alias = 'probe-alias-closed' AND valid_to_version IS NULL$$);

\echo '--- move an already-closed window: retroactive, must be REFUSED after 022'

SELECT probe_case('knowledge_objects move close point',
  $$UPDATE knowledge_objects SET valid_to_version = 8
    WHERE id = 'ART-0200' AND valid_to_version = 7$$);

SELECT probe_case('relations move close point',
  $$UPDATE relations SET valid_to_version = 8
    WHERE id = 8 AND valid_to_version = 7$$);

SELECT probe_case('feature_labels move close point',
  $$UPDATE feature_labels SET valid_to_version = 9
    WHERE id = 'FTL-0002' AND valid_to_version = 10$$);

SELECT probe_case('feature_label_aliases move close point',
  $$UPDATE feature_label_aliases SET valid_to_version = 9
    WHERE alias = 'probe-alias-closed' AND valid_to_version = 10$$);

\echo '--- reopen a closed window: retroactive, must be REFUSED after 022'

SELECT probe_case('knowledge_objects reopen',
  $$UPDATE knowledge_objects SET valid_to_version = NULL
    WHERE id = 'ART-0200' AND valid_to_version IS NOT NULL$$);

SELECT probe_case('relations reopen',
  $$UPDATE relations SET valid_to_version = NULL
    WHERE id = 8 AND valid_to_version IS NOT NULL$$);

SELECT probe_case('feature_labels reopen',
  $$UPDATE feature_labels SET valid_to_version = NULL
    WHERE id = 'FTL-0002' AND valid_to_version IS NOT NULL$$);

SELECT probe_case('feature_label_aliases reopen',
  $$UPDATE feature_label_aliases SET valid_to_version = NULL
    WHERE alias = 'probe-alias-closed' AND valid_to_version IS NOT NULL$$);

\echo '--- move the opening version: retroactive, must be REFUSED after 022'

SELECT probe_case('knowledge_objects move start',
  $$UPDATE knowledge_objects SET valid_from_version = 2
    WHERE id = (SELECT id FROM knowledge_objects
                WHERE valid_to_version IS NULL AND valid_from_version <> 2
                ORDER BY id LIMIT 1)$$);

SELECT probe_case('relations move start',
  $$UPDATE relations SET valid_from_version = 2
    WHERE valid_to_version IS NULL AND valid_from_version <> 2$$);

SELECT probe_case('feature_labels move start',
  $$UPDATE feature_labels SET valid_from_version = 4
    WHERE id = 'FTL-0001' AND valid_from_version <> 4$$);

SELECT probe_case('feature_label_aliases move start',
  $$UPDATE feature_label_aliases SET valid_from_version = 4
    WHERE alias = 'probe-alias-open' AND valid_from_version <> 4$$);

DROP FUNCTION probe_case(text, text);
