-- INV-1 through INV-15. Trust invariants live here, not only in application
-- code. INV-14 and INV-15 are already enforced on feature_labels in 002.

-- INV-1: scope_id is NOT NULL FK (003). Immutable after approval: whitelist
-- in inv7 does not include scope_id; changing it raises SCOPE_IMMUTABLE.

-- INV-7: append-only after approval. Explicit whitelist — any column not in
-- this list is content and is frozen once approved_at IS NOT NULL.
-- Whitelist: status, last_verified_at, review_required, superseded_by_id,
-- valid_to_version, lock_version.
CREATE FUNCTION knowledge_objects_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  whitelist text[] := ARRAY[
    'status',
    'last_verified_at',
    'review_required',
    'superseded_by_id',
    'valid_to_version',
    'lock_version'
  ];
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.type IS DISTINCT FROM OLD.type THEN
    RAISE EXCEPTION 'IMMUTABLE_AFTER_APPROVAL'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.approved_at IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.scope_id IS DISTINCT FROM OLD.scope_id THEN
    RAISE EXCEPTION 'SCOPE_IMMUTABLE'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF (to_jsonb(NEW) - whitelist) IS DISTINCT FROM (to_jsonb(OLD) - whitelist) THEN
    RAISE EXCEPTION 'IMMUTABLE_AFTER_APPROVAL'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER knowledge_objects_append_only
  BEFORE UPDATE ON knowledge_objects
  FOR EACH ROW
  EXECUTE FUNCTION knowledge_objects_append_only();

-- INV-8
CREATE FUNCTION knowledge_objects_forbid_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'DELETION_FORBIDDEN'
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER knowledge_objects_forbid_delete
  BEFORE DELETE ON knowledge_objects
  FOR EACH ROW
  EXECUTE FUNCTION knowledge_objects_forbid_delete();

-- INV-12 / MTS 7.5: derives_from, supersedes, requires are acyclic.
CREATE FUNCTION relations_reject_cycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  hit boolean;
BEGIN
  IF NEW.relation NOT IN ('derives_from', 'supersedes', 'requires') THEN
    RETURN NEW;
  END IF;

  IF NEW.source_id = NEW.target_id THEN
    RAISE EXCEPTION 'CYCLE_DETECTED'
      USING ERRCODE = 'check_violation';
  END IF;

  WITH RECURSIVE walk AS (
    SELECT r.target_id AS id, 1 AS depth
    FROM relations r
    WHERE r.source_id = NEW.target_id
      AND r.relation = NEW.relation
      AND r.valid_to_version IS NULL
    UNION ALL
    SELECT r.target_id, w.depth + 1
    FROM walk w
    INNER JOIN relations r
      ON r.source_id = w.id
     AND r.relation = NEW.relation
     AND r.valid_to_version IS NULL
    WHERE w.depth < 64
  )
  SELECT TRUE INTO hit FROM walk WHERE id = NEW.source_id OR depth >= 64 LIMIT 1;

  IF hit THEN
    RAISE EXCEPTION 'CYCLE_DETECTED'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER relations_reject_cycle
  BEFORE INSERT ON relations
  FOR EACH ROW
  EXECUTE FUNCTION relations_reject_cycle();

-- INV-13: each feature_label_ids member exists in the owning Project registry
-- as of valid_from_version. Labels are not a single-column FK target.
CREATE FUNCTION project_scope_id_of(p_scope_id text)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT s.id
  FROM scopes s
  WHERE s.kind = 'project'
    AND s.path @> (SELECT t.path FROM scopes t WHERE t.id = p_scope_id)
  LIMIT 1;
$$;

CREATE FUNCTION knowledge_objects_labels_in_registry()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  label_id text;
  project_id text;
BEGIN
  IF NEW.feature_label_ids IS NULL OR cardinality(NEW.feature_label_ids) = 0 THEN
    RETURN NEW;
  END IF;

  project_id := project_scope_id_of(NEW.scope_id);
  IF project_id IS NULL THEN
    RAISE EXCEPTION 'UNKNOWN_LABEL'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  FOREACH label_id IN ARRAY NEW.feature_label_ids LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM feature_labels f
      WHERE f.id = label_id
        AND f.project_scope_id = project_id
        AND feature_label_active_at(
          f.valid_from_version,
          f.valid_to_version,
          NEW.valid_from_version
        )
    ) THEN
      RAISE EXCEPTION 'UNKNOWN_LABEL'
        USING ERRCODE = 'foreign_key_violation';
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

CREATE TRIGGER knowledge_objects_labels_in_registry
  BEFORE INSERT OR UPDATE OF feature_label_ids, scope_id, valid_from_version
  ON knowledge_objects
  FOR EACH ROW
  EXECUTE FUNCTION knowledge_objects_labels_in_registry();

-- INV-3: Decision has ≥1 derives_from. Edges are written with the object.
CREATE FUNCTION knowledge_objects_decision_origin()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.type = 'decision' THEN
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

CREATE CONSTRAINT TRIGGER knowledge_objects_decision_origin
  AFTER INSERT OR UPDATE OF type ON knowledge_objects
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.type = 'decision')
  EXECUTE FUNCTION knowledge_objects_decision_origin();

-- INV-4: Constraint derives from a Decision or axiomatic = true.
CREATE FUNCTION knowledge_objects_constraint_parent()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.type = 'constraint' AND COALESCE((NEW.attributes ->> 'axiomatic')::boolean, false) IS NOT TRUE THEN
    IF NOT EXISTS (
      SELECT 1
      FROM relations r
      INNER JOIN knowledge_objects d ON d.id = r.target_id
      WHERE r.source_id = NEW.id
        AND r.relation = 'derives_from'
        AND r.valid_to_version IS NULL
        AND d.type = 'decision'
    ) THEN
      RAISE EXCEPTION 'CONSTRAINT_PARENT_REQUIRED'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER knowledge_objects_constraint_parent
  AFTER INSERT OR UPDATE OF type, attributes ON knowledge_objects
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.type = 'constraint')
  EXECUTE FUNCTION knowledge_objects_constraint_parent();

-- INV-6: predecessor is marked superseded in the same transaction.
CREATE FUNCTION knowledge_objects_supersession_pair()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  pred knowledge_objects%ROWTYPE;
BEGIN
  IF NEW.supersedes_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO pred FROM knowledge_objects WHERE id = NEW.supersedes_id;
  IF NOT FOUND
     OR pred.superseded_by_id IS DISTINCT FROM NEW.id
     OR pred.status <> 'superseded' THEN
    RAISE EXCEPTION 'SUPERSESSION_CONFLICT'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM relations r
    WHERE r.source_id = NEW.id
      AND r.relation = 'supersedes'
      AND r.target_id = NEW.supersedes_id
      AND r.valid_to_version IS NULL
  ) THEN
    RAISE EXCEPTION 'SUPERSESSION_CONFLICT'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER knowledge_objects_supersession_pair
  AFTER INSERT OR UPDATE OF supersedes_id ON knowledge_objects
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.supersedes_id IS NOT NULL)
  EXECUTE FUNCTION knowledge_objects_supersession_pair();

-- INV-10: Requirement superseded or withdrawn flags derived active Decisions.
CREATE FUNCTION knowledge_objects_requirement_impact()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.type = 'requirement'
     AND NEW.status IN ('superseded', 'withdrawn')
     AND (OLD.status IS DISTINCT FROM NEW.status) THEN
    UPDATE knowledge_objects d
    SET review_required = true
    FROM relations r
    WHERE r.source_id = d.id
      AND r.target_id = NEW.id
      AND r.relation = 'derives_from'
      AND r.valid_to_version IS NULL
      AND d.type = 'decision'
      AND d.status = 'active';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER knowledge_objects_requirement_impact
  AFTER UPDATE OF status ON knowledge_objects
  FOR EACH ROW
  WHEN (NEW.type = 'requirement')
  EXECUTE FUNCTION knowledge_objects_requirement_impact();

-- INV-5 is the Observation JSONB key CHECK in 003.
-- INV-9 is the length CHECK in 003.
-- INV-2 is the approved_class CHECK in 003.
-- INV-11 is version-windowed selection at read (no write trigger).
-- INV-14 delete-forbidden and INV-15 redirect acyclicity: 002.
