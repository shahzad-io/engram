-- Master Tech Spec 3.4.1. Version-windowed registry + aliases.
-- Composite PK (id, valid_from_version): a merge closes the old window and
-- inserts a new row with the same identity, so packs at the prior version
-- still resolve the pre-redirect label (3.4.4). Partial unique index on
-- open id. redirects_to_id cannot be an FK (partial unique is not a valid
-- FK target; composite PK is the wrong target) and is enforced by trigger.

CREATE TYPE feature_label_status AS ENUM ('active', 'deprecated');

CREATE TABLE feature_labels (
  id text NOT NULL,
  project_scope_id text NOT NULL REFERENCES scopes (id),
  canonical_name text NOT NULL,
  status feature_label_status NOT NULL,
  redirects_to_id text,
  valid_from_version bigint NOT NULL REFERENCES graph_versions (version),
  valid_to_version bigint REFERENCES graph_versions (version),
  PRIMARY KEY (id, valid_from_version),
  CONSTRAINT feature_labels_version_window CHECK (
    valid_to_version IS NULL OR valid_to_version > valid_from_version
  ),
  CONSTRAINT feature_labels_id_format CHECK (id ~ '^FTL-[0-9]{4,}$'),
  CONSTRAINT feature_labels_name_normalised CHECK (
    canonical_name ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
  ),
  CONSTRAINT feature_labels_no_self_redirect CHECK (
    redirects_to_id IS NULL OR redirects_to_id <> id
  )
);

CREATE UNIQUE INDEX feature_labels_open_id
  ON feature_labels (id)
  WHERE valid_to_version IS NULL;

CREATE UNIQUE INDEX feature_labels_active_name
  ON feature_labels (project_scope_id, canonical_name)
  WHERE valid_to_version IS NULL;

CREATE TABLE feature_label_aliases (
  label_id text NOT NULL,
  alias text NOT NULL,
  project_scope_id text NOT NULL REFERENCES scopes (id),
  valid_from_version bigint NOT NULL REFERENCES graph_versions (version),
  valid_to_version bigint REFERENCES graph_versions (version),
  PRIMARY KEY (project_scope_id, alias, valid_from_version),
  CONSTRAINT feature_label_aliases_version_window CHECK (
    valid_to_version IS NULL OR valid_to_version > valid_from_version
  ),
  CONSTRAINT feature_label_aliases_normalised CHECK (
    alias ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
  )
);

CREATE UNIQUE INDEX feature_label_aliases_active
  ON feature_label_aliases (project_scope_id, alias)
  WHERE valid_to_version IS NULL;

CREATE INDEX feature_label_aliases_label
  ON feature_label_aliases (label_id);

CREATE FUNCTION feature_label_active_at(from_version bigint, to_version bigint, v bigint)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT from_version <= v AND (to_version IS NULL OR to_version > v);
$$;

CREATE FUNCTION feature_labels_enforce()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  scope_kind_found scope_kind;
  hop_id text;
  seen text[];
  hops integer;
  hop_redirect text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'DELETION_FORBIDDEN'
      USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT kind INTO scope_kind_found FROM scopes WHERE id = NEW.project_scope_id;
  IF scope_kind_found IS DISTINCT FROM 'project' THEN
    RAISE EXCEPTION 'feature label registry is Project-scoped'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.redirects_to_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM feature_labels f
      WHERE f.id = NEW.redirects_to_id
        AND f.project_scope_id = NEW.project_scope_id
        AND feature_label_active_at(
          f.valid_from_version,
          f.valid_to_version,
          NEW.valid_from_version
        )
    ) THEN
      RAISE EXCEPTION 'UNKNOWN_LABEL'
        USING ERRCODE = 'foreign_key_violation';
    END IF;

    hop_id := NEW.redirects_to_id;
    seen := ARRAY[NEW.id];
    hops := 0;
    WHILE hop_id IS NOT NULL LOOP
      hops := hops + 1;
      IF hops > 16 OR hop_id = ANY (seen) THEN
        RAISE EXCEPTION 'LABEL_REDIRECT_CYCLE'
          USING ERRCODE = 'check_violation';
      END IF;
      seen := seen || hop_id;
      SELECT f.redirects_to_id INTO hop_redirect
      FROM feature_labels f
      WHERE f.id = hop_id
        AND feature_label_active_at(f.valid_from_version, f.valid_to_version, NEW.valid_from_version)
      ORDER BY f.valid_from_version DESC
      LIMIT 1;
      hop_id := hop_redirect;
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER feature_labels_enforce
  BEFORE INSERT OR UPDATE OR DELETE ON feature_labels
  FOR EACH ROW
  EXECUTE FUNCTION feature_labels_enforce();

CREATE FUNCTION feature_label_aliases_enforce()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  scope_kind_found scope_kind;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'DELETION_FORBIDDEN'
      USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT kind INTO scope_kind_found FROM scopes WHERE id = NEW.project_scope_id;
  IF scope_kind_found IS DISTINCT FROM 'project' THEN
    RAISE EXCEPTION 'feature label registry is Project-scoped'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM feature_labels WHERE id = NEW.label_id) THEN
    RAISE EXCEPTION 'alias target % does not exist', NEW.label_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER feature_label_aliases_enforce
  BEFORE INSERT OR UPDATE OR DELETE ON feature_label_aliases
  FOR EACH ROW
  EXECUTE FUNCTION feature_label_aliases_enforce();
