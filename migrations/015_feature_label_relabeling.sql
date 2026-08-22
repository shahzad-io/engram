-- A17: feature labels are mutable filing metadata, not approved content.
-- Relabelling remains a curation transaction and records a graph version.
CREATE OR REPLACE FUNCTION knowledge_objects_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  whitelist text[] := ARRAY[
    'status',
    'last_verified_at',
    'review_required',
    'feature_label_ids',
    'superseded_by_id',
    'valid_to_version',
    'lock_version',
    'knowledge_class',
    'search_vector'
  ];
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.type IS DISTINCT FROM OLD.type THEN
    RAISE EXCEPTION 'IMMUTABLE_AFTER_APPROVAL'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.approved_at IS DISTINCT FROM OLD.approved_at THEN
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

CREATE OR REPLACE FUNCTION knowledge_objects_labels_in_registry()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  label_id text;
  project_id text;
  validation_version bigint;
BEGIN
  IF NEW.feature_label_ids IS NULL OR cardinality(NEW.feature_label_ids) = 0 THEN
    RETURN NEW;
  END IF;

  project_id := project_scope_id_of(NEW.scope_id);
  IF project_id IS NULL THEN
    RAISE EXCEPTION 'UNKNOWN_LABEL'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  /*
   * New objects are validated at their insertion version. A relabelling
   * update is validated at the curation transaction's allocated version,
   * which is visible here because that graph_versions row was inserted first.
   * The object envelope intentionally does not carry a label-assignment
   * version; this is the accepted v1 reproduction limitation.
   */
  validation_version := CASE
    WHEN TG_OP = 'INSERT' THEN NEW.valid_from_version
    ELSE COALESCE((SELECT max(version) FROM graph_versions), NEW.valid_from_version)
  END;

  FOREACH label_id IN ARRAY NEW.feature_label_ids LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM feature_labels f
      WHERE f.id = label_id
        AND f.project_scope_id = project_id
        AND feature_label_active_at(
          f.valid_from_version,
          f.valid_to_version,
          validation_version
        )
    ) THEN
      RAISE EXCEPTION 'UNKNOWN_LABEL'
        USING ERRCODE = 'foreign_key_violation';
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;
