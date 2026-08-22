-- 05 §3.3, §3.1: ltree for scope paths. vector is not created.
CREATE EXTENSION IF NOT EXISTS ltree;

CREATE TYPE scope_kind AS ENUM ('global', 'project', 'workstream', 'phase');

-- Master Tech Spec 3.1. path and depth are assigned by trigger on insert.
CREATE TABLE scopes (
  id text PRIMARY KEY,
  kind scope_kind NOT NULL,
  parent_id text REFERENCES scopes (id),
  name text NOT NULL,
  path ltree NOT NULL DEFAULT 'pending',
  depth smallint NOT NULL DEFAULT 0,
  CONSTRAINT scopes_depth_range CHECK (depth >= 0 AND depth <= 3),
  CONSTRAINT scopes_global_root CHECK (
    (kind = 'global' AND parent_id IS NULL AND depth = 0)
    OR (kind <> 'global' AND parent_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX scopes_one_global ON scopes (kind) WHERE kind = 'global';
CREATE UNIQUE INDEX scopes_path_unique ON scopes (path);
CREATE INDEX scopes_path_gist ON scopes USING gist (path);

CREATE FUNCTION scope_path_label(id text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT regexp_replace(id, '[^A-Za-z0-9_]', '_', 'g');
$$;

CREATE FUNCTION scopes_assign_tree()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent scopes%ROWTYPE;
  expected_parent_kind scope_kind;
  label text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.kind IS DISTINCT FROM OLD.kind
       OR NEW.parent_id IS DISTINCT FROM OLD.parent_id THEN
      RAISE EXCEPTION 'scope reparenting is rejected in V1'
        USING ERRCODE = 'restrict_violation';
    END IF;
    NEW.depth := OLD.depth;
    NEW.path := OLD.path;
    RETURN NEW;
  END IF;

  label := scope_path_label(NEW.id);
  IF label !~ '^[A-Za-z_][A-Za-z0-9_]*$' THEN
    RAISE EXCEPTION 'scope id % cannot form an ltree label', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.kind = 'global' THEN
    NEW.parent_id := NULL;
    NEW.depth := 0;
    NEW.path := text2ltree(label);
    RETURN NEW;
  END IF;

  IF NEW.parent_id IS NULL THEN
    RAISE EXCEPTION 'non-global scope % requires a parent', NEW.id
      USING ERRCODE = 'not_null_violation';
  END IF;

  SELECT * INTO parent FROM scopes WHERE id = NEW.parent_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SCOPE_NOT_FOUND'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  expected_parent_kind := CASE NEW.kind
    WHEN 'project' THEN 'global'::scope_kind
    WHEN 'workstream' THEN 'project'::scope_kind
    WHEN 'phase' THEN 'workstream'::scope_kind
  END;

  IF parent.kind IS DISTINCT FROM expected_parent_kind THEN
    RAISE EXCEPTION 'illegal parent kind % for %', parent.kind, NEW.kind
      USING ERRCODE = 'check_violation';
  END IF;

  NEW.depth := parent.depth + 1;
  IF NEW.depth > 3 THEN
    RAISE EXCEPTION 'scope depth must be <= 3'
      USING ERRCODE = 'check_violation';
  END IF;

  NEW.path := parent.path || text2ltree(label);
  RETURN NEW;
END;
$$;

CREATE TRIGGER scopes_assign_tree
  BEFORE INSERT OR UPDATE ON scopes
  FOR EACH ROW
  EXECUTE FUNCTION scopes_assign_tree();

CREATE FUNCTION scopes_forbid_global_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.kind = 'global' THEN
    RAISE EXCEPTION 'DELETION_FORBIDDEN'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER scopes_forbid_global_delete
  BEFORE DELETE ON scopes
  FOR EACH ROW
  EXECUTE FUNCTION scopes_forbid_global_delete();

-- The tree cannot exist without a root. Curator-created scopes attach under this row.
INSERT INTO scopes (id, kind, name) VALUES ('global', 'global', 'Global');
