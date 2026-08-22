-- A-BF-1: backfill-only provenance and historical import mode.
ALTER TABLE graph_versions
  ADD COLUMN backfill_mode boolean NOT NULL DEFAULT false;

ALTER TABLE knowledge_objects
  ALTER CONSTRAINT knowledge_objects_supersedes_id_fkey
    DEFERRABLE INITIALLY IMMEDIATE,
  ALTER CONSTRAINT knowledge_objects_superseded_by_id_fkey
    DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE knowledge_objects
  ADD CONSTRAINT knowledge_objects_origin_marker CHECK (
    NOT (attributes ? 'origin')
    OR (
      type = 'decision'
      AND attributes ->> 'origin' = 'unrecoverable'
    )
  );

CREATE FUNCTION knowledge_objects_backfill_origin()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  is_backfill boolean;
BEGIN
  IF NOT (NEW.attributes ? 'origin') THEN
    RETURN NEW;
  END IF;

  IF NEW.type <> 'decision'
     OR NEW.attributes ->> 'origin' <> 'unrecoverable' THEN
    RAISE EXCEPTION 'INVALID_ORIGIN_MARKER'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT backfill_mode
  INTO is_backfill
  FROM graph_versions
  WHERE version = NEW.valid_from_version;

  IF is_backfill IS NOT TRUE THEN
    RAISE EXCEPTION 'BACKFILL_ORIGIN_FORBIDDEN'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER knowledge_objects_backfill_origin
  BEFORE INSERT OR UPDATE OF type, attributes, valid_from_version
  ON knowledge_objects
  FOR EACH ROW
  EXECUTE FUNCTION knowledge_objects_backfill_origin();

CREATE OR REPLACE FUNCTION knowledge_objects_decision_origin()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  is_backfill boolean;
BEGIN
  IF NEW.type = 'decision' THEN
    SELECT backfill_mode
    INTO is_backfill
    FROM graph_versions
    WHERE version = NEW.valid_from_version;

    IF NEW.attributes ->> 'origin' = 'unrecoverable'
       AND is_backfill IS TRUE THEN
      IF EXISTS (
        SELECT 1
        FROM relations r
        WHERE r.source_id = NEW.id
          AND r.relation = 'derives_from'
          AND r.valid_to_version IS NULL
      ) THEN
        RAISE EXCEPTION 'ORIGIN_MARKER_WITH_EDGE'
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM relations r
      WHERE r.source_id = NEW.id
        AND r.relation = 'derives_from'
        AND r.valid_to_version IS NULL
    ) THEN
      RAISE EXCEPTION 'DECISION_ORIGIN_REQUIRED'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
