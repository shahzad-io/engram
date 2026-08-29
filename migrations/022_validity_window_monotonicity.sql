-- Window monotonicity on every windowed table, not just knowledge_objects.
--
-- 021 established the rule and enforced it in one place. Four tables carry a
-- (valid_from_version, valid_to_version) window: knowledge_objects, relations,
-- feature_labels, feature_label_aliases. Only the first had a trigger, so on
-- the other three a closed window could still be reopened or moved by a plain
-- UPDATE. Measured on a fresh database before this migration: reopening
-- (valid_to -> NULL) and moving the close point were both accepted on
-- relations, feature_labels and feature_label_aliases.
--
-- Why it matters is the same argument as 021. Closing a window at w is not a
-- retroactive change, because active_at(from, to, v) for every v < w answers
-- as it did before. Reopening or moving a closed window is retroactive: it
-- changes what the graph contained at versions already committed, and packs
-- built at those versions stop reproducing. A relation is not a lesser case
-- here — traversal is how packs select, so a reopened edge changes pack
-- membership just as an object does.
--
-- valid_from_version is guarded too. Moving the opening version is retroactive
-- for exactly the same reason, and on the three tables added here nothing else
-- prevented it: they have no approval concept and so no append-only guard.
-- On knowledge_objects it was already blocked for approved rows by
-- knowledge_objects_append_only (valid_from_version is absent from its
-- whitelist), but that function returns early when approved_at IS NULL, so an
-- unapproved row's opening version could be moved. Nothing in src/ or tests/
-- has ever issued an UPDATE that sets valid_from_version, so guarding it
-- unconditionally forecloses the hole without foreclosing any live write.
--
-- The two live writers of valid_to_version both close an open window
-- (transaction.ts closeRelationInTransaction and migrateDecisionBlocks), which
-- this permits. Only one of them carries `AND valid_to_version IS NULL` in its
-- WHERE clause; the other relies on a SELECT taken earlier in the same
-- transaction. This trigger is the backstop for that asymmetry.

-- Generic over the four tables: the window columns are named identically on
-- all of them, so the function reads them out of to_jsonb(NEW/OLD) rather
-- than being written four times.
CREATE OR REPLACE FUNCTION validity_window_is_monotonic()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_from bigint := (to_jsonb(OLD) ->> 'valid_from_version')::bigint;
  new_from bigint := (to_jsonb(NEW) ->> 'valid_from_version')::bigint;
  old_to   bigint := (to_jsonb(OLD) ->> 'valid_to_version')::bigint;
  new_to   bigint := (to_jsonb(NEW) ->> 'valid_to_version')::bigint;
BEGIN
  IF new_from IS DISTINCT FROM old_from THEN
    RAISE EXCEPTION 'VALIDITY_WINDOW_START_IMMUTABLE'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF old_to IS NOT NULL AND new_to IS DISTINCT FROM old_to THEN
    RAISE EXCEPTION 'VALIDITY_WINDOW_CLOSED'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

-- Subsumed by the trigger below: it fired only on UPDATE OF valid_to_version
-- and checked only the closing version. Dropped rather than left in place so
-- there is one rule per table and one place to read it. The error code it
-- raised is preserved, so callers and tests matching VALIDITY_WINDOW_CLOSED
-- are unaffected.
DROP TRIGGER IF EXISTS knowledge_objects_window_closes_once ON knowledge_objects;
DROP FUNCTION IF EXISTS knowledge_objects_window_closes_once();

-- BEFORE UPDATE without a column list: `UPDATE OF valid_to_version` fires only
-- when that column appears in the SET list, which is the right test for it but
-- would miss a valid_from_version-only update.
CREATE TRIGGER knowledge_objects_window_is_monotonic
BEFORE UPDATE ON knowledge_objects
FOR EACH ROW
EXECUTE FUNCTION validity_window_is_monotonic();

CREATE TRIGGER relations_window_is_monotonic
BEFORE UPDATE ON relations
FOR EACH ROW
EXECUTE FUNCTION validity_window_is_monotonic();

CREATE TRIGGER feature_labels_window_is_monotonic
BEFORE UPDATE ON feature_labels
FOR EACH ROW
EXECUTE FUNCTION validity_window_is_monotonic();

CREATE TRIGGER feature_label_aliases_window_is_monotonic
BEFORE UPDATE ON feature_label_aliases
FOR EACH ROW
EXECUTE FUNCTION validity_window_is_monotonic();
