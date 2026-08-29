-- Pack selection reads `status`, which is on the append-only whitelist and
-- carries no history. Superseding or transitioning an object therefore changed
-- what every earlier pack in its scope chain selected, and those packs failed
-- their own reproduction check with PACK_HASH_MISMATCH.
--
-- Master Tech Spec 2 justified one row per identity on the premise that "their
-- only status changes after approval are to terminal states, and terminal
-- states are excluded from packs". Amendment A1 made terminal states
-- pack-visible and the premise stopped holding. The one-row design is kept;
-- this table supplies what the premise assumed.

CREATE TABLE knowledge_object_status_history (
  object_id text NOT NULL REFERENCES knowledge_objects (id) ON DELETE RESTRICT,
  graph_version bigint NOT NULL REFERENCES graph_versions (version) ON DELETE RESTRICT,
  status knowledge_object_status NOT NULL,
  PRIMARY KEY (object_id, graph_version)
);

CREATE INDEX knowledge_object_status_history_lookup
  ON knowledge_object_status_history (object_id, graph_version DESC);

-- Recorded by the database rather than by each caller. Three code paths change
-- status today and a fourth would otherwise have to remember; the invariant is
-- that no status change goes unrecorded, so the database owns it (TD-18, and
-- the same reasoning as the other append-only triggers).
CREATE OR REPLACE FUNCTION knowledge_objects_record_status()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  recorded_version bigint;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  /*
   * An insert is recorded at its own opening version. An update is recorded at
   * the curation transaction's allocated version, which is visible here because
   * allocateVersion inserts that graph_versions row before any object write.
   */
  recorded_version := CASE
    WHEN TG_OP = 'INSERT' THEN NEW.valid_from_version
    ELSE COALESCE((SELECT max(version) FROM graph_versions), NEW.valid_from_version)
  END;

  INSERT INTO knowledge_object_status_history (object_id, graph_version, status)
  VALUES (NEW.id, recorded_version, NEW.status)
  ON CONFLICT (object_id, graph_version)
  DO UPDATE SET status = EXCLUDED.status;

  RETURN NEW;
END;
$$;

CREATE TRIGGER knowledge_objects_record_status
AFTER INSERT OR UPDATE OF status ON knowledge_objects
FOR EACH ROW
EXECUTE FUNCTION knowledge_objects_record_status();

-- Backfill. This is not a reconstruction: the prior status of an object that
-- has already been superseded or transitioned is not recorded anywhere, so
-- there is nothing to recover it from. Each object is recorded at its opening
-- version with the status it holds now, which is correct for every object that
-- has never changed status and wrong for every object that has. It does not
-- repair packs that already fail to reproduce, and it is not intended to.
INSERT INTO knowledge_object_status_history (object_id, graph_version, status)
SELECT id, valid_from_version, status
FROM knowledge_objects
ON CONFLICT (object_id, graph_version) DO NOTHING;

-- A closed window is not a retroactive change: closing at w leaves every
-- version below w selecting exactly as before. Reopening one is, and that is
-- what a hand-run repair did at v9, retroactively changing what the graph at
-- v6 and v8 contained. Windows may close once; they may not reopen or move.
CREATE OR REPLACE FUNCTION knowledge_objects_window_closes_once()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.valid_to_version IS NOT NULL
     AND NEW.valid_to_version IS DISTINCT FROM OLD.valid_to_version THEN
    RAISE EXCEPTION 'VALIDITY_WINDOW_CLOSED'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER knowledge_objects_window_closes_once
BEFORE UPDATE OF valid_to_version ON knowledge_objects
FOR EACH ROW
EXECUTE FUNCTION knowledge_objects_window_closes_once();
