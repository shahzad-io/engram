-- MTS 14.3. Candidates are structurally separate from knowledge_objects.
CREATE TYPE candidate_status AS ENUM ('pending', 'accepted', 'rejected', 'expired');

CREATE TABLE candidates (
  id uuid PRIMARY KEY,
  proposed_type knowledge_object_type NOT NULL,
  payload jsonb NOT NULL,
  parent_id uuid REFERENCES candidates (id),
  source_ref text,
  proposed_by authored_by NOT NULL,
  status candidate_status NOT NULL DEFAULT 'pending',
  resolution jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CONSTRAINT candidates_resolution_window CHECK (
    (status = 'pending' AND resolved_at IS NULL)
    OR (status <> 'pending' AND resolved_at IS NOT NULL)
  )
);

CREATE INDEX candidates_pending
  ON candidates (created_at)
  WHERE status = 'pending';

CREATE INDEX candidates_parent
  ON candidates (parent_id)
  WHERE parent_id IS NOT NULL;

CREATE TRIGGER candidates_forbid_delete
  BEFORE DELETE ON candidates
  FOR EACH ROW
  EXECUTE FUNCTION knowledge_objects_forbid_delete();

CREATE TRIGGER candidates_forbid_truncate
  BEFORE TRUNCATE ON candidates
  FOR EACH STATEMENT
  EXECUTE FUNCTION knowledge_objects_forbid_delete();
