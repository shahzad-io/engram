-- Master Tech Spec 2.2. ONE row per id. Do not copy the label composite PK.
-- Terminal status and closing valid_to_version are the same event.

CREATE TYPE knowledge_object_type AS ENUM (
  'requirement',
  'discussion',
  'observation',
  'hypothesis',
  'decision',
  'open_question',
  'constraint',
  'glossary_entry',
  'artifact'
);

CREATE TYPE knowledge_class AS ENUM ('raw', 'reviewed', 'operational');

CREATE TYPE knowledge_object_status AS ENUM (
  'active',
  'superseded',
  'withdrawn',
  'recorded',
  'distilled',
  'archived',
  'observed',
  'promoted_to_question',
  'promoted_to_hypothesis',
  'absorbed',
  'stale',
  'explored',
  'rejected',
  'revived',
  'reverted',
  'open',
  'resolved',
  'obsolete',
  'lifted',
  'deprecated',
  'current'
);

CREATE TYPE authored_by AS ENUM ('human', 'ai');

CREATE TABLE knowledge_objects (
  id text PRIMARY KEY,
  type knowledge_object_type NOT NULL,
  knowledge_class knowledge_class GENERATED ALWAYS AS (
    CASE type
      WHEN 'discussion' THEN 'raw'::knowledge_class
      WHEN 'observation' THEN 'raw'::knowledge_class
      WHEN 'constraint' THEN 'operational'::knowledge_class
      WHEN 'glossary_entry' THEN 'operational'::knowledge_class
      ELSE 'reviewed'::knowledge_class
    END
  ) STORED,
  scope_id text NOT NULL REFERENCES scopes (id),
  feature_label_ids text[] NOT NULL DEFAULT '{}',
  title text NOT NULL,
  body text NOT NULL,
  status knowledge_object_status NOT NULL,
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  authored_by authored_by NOT NULL,
  source_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  last_verified_at timestamptz,
  supersedes_id text REFERENCES knowledge_objects (id),
  superseded_by_id text REFERENCES knowledge_objects (id),
  review_required boolean NOT NULL DEFAULT false,
  valid_from_version bigint NOT NULL REFERENCES graph_versions (version),
  valid_to_version bigint REFERENCES graph_versions (version),
  lock_version integer NOT NULL DEFAULT 0,
  CONSTRAINT knowledge_objects_version_window CHECK (
    valid_to_version IS NULL OR valid_to_version > valid_from_version
  ),
  CONSTRAINT knowledge_objects_no_self_supersede CHECK (
    supersedes_id IS NULL OR supersedes_id <> id
  ),
  CONSTRAINT knowledge_objects_id_prefix CHECK (
    (type = 'requirement' AND id ~ '^REQ-[0-9]{4,}$')
    OR (type = 'discussion' AND id ~ '^DSC-[0-9]{4,}$')
    OR (type = 'observation' AND id ~ '^OBS-[0-9]{4,}$')
    OR (type = 'hypothesis' AND id ~ '^HYP-[0-9]{4,}$')
    OR (type = 'decision' AND id ~ '^DEC-[0-9]{4,}$')
    OR (type = 'open_question' AND id ~ '^OQU-[0-9]{4,}$')
    OR (type = 'constraint' AND id ~ '^CON-[0-9]{4,}$')
    OR (type = 'glossary_entry' AND id ~ '^GLO-[0-9]{4,}$')
    OR (type = 'artifact' AND id ~ '^ART-[0-9]{4,}$')
  ),
  CONSTRAINT knowledge_objects_status_for_type CHECK (
    (type = 'requirement' AND status IN ('active', 'superseded', 'withdrawn'))
    OR (type = 'discussion' AND status IN ('recorded', 'distilled', 'archived'))
    OR (
      type = 'observation'
      AND status IN (
        'observed',
        'promoted_to_question',
        'promoted_to_hypothesis',
        'absorbed',
        'stale'
      )
    )
    OR (type = 'hypothesis' AND status IN ('explored', 'rejected', 'revived'))
    OR (type = 'decision' AND status IN ('active', 'superseded', 'reverted'))
    OR (type = 'open_question' AND status IN ('open', 'resolved', 'obsolete'))
    OR (type = 'constraint' AND status IN ('active', 'superseded', 'lifted'))
    OR (type = 'glossary_entry' AND status IN ('active', 'superseded', 'deprecated'))
    OR (type = 'artifact' AND status IN ('current', 'superseded'))
  ),
  -- INV-2
  CONSTRAINT knowledge_objects_approved_class CHECK (
    (knowledge_class = 'raw' AND approved_at IS NULL AND last_verified_at IS NULL)
    OR (
      knowledge_class <> 'raw'
      AND approved_at IS NOT NULL
      AND last_verified_at IS NOT NULL
    )
  ),
  -- Required JSONB keys per type (MTS 2.3). INV-5 on Observation.
  CONSTRAINT knowledge_objects_attribute_keys CHECK (
    CASE type
      WHEN 'requirement' THEN attributes ?& ARRAY['source', 'rationale']
      WHEN 'discussion' THEN attributes ?& ARRAY['medium', 'occurred_at', 'content_ref']
      WHEN 'observation' THEN attributes ?& ARRAY['observed_at', 'evidence_ref', 'review_by']
      WHEN 'hypothesis' THEN attributes ?& ARRAY['what_was_tried', 'why_it_failed', 'evidence_ref']
      WHEN 'decision' THEN attributes ?& ARRAY['statement', 'rationale', 'reversibility', 'alternatives_rejected']
      WHEN 'open_question' THEN attributes ?& ARRAY['question', 'blocking']
      WHEN 'constraint' THEN attributes ?& ARRAY['rule', 'enforcement', 'axiomatic']
      WHEN 'glossary_entry' THEN attributes ?& ARRAY['term', 'definition', 'axiomatic']
      WHEN 'artifact' THEN attributes ?& ARRAY['kind', 'version', 'location', 'content_hash', 'summary']
    END
  ),
  -- INV-9 operational caps. Artifact summary is the stored, never-regenerated cap.
  CONSTRAINT knowledge_objects_length_caps CHECK (
    (type <> 'constraint' OR char_length(attributes ->> 'rule') <= 280)
    AND (type <> 'glossary_entry' OR char_length(attributes ->> 'definition') <= 200)
    AND (type <> 'artifact' OR char_length(attributes ->> 'summary') <= 500)
  )
);

-- INV-6: at most one predecessor, at most one successor (open identity is the row).
CREATE UNIQUE INDEX knowledge_objects_supersedes_id
  ON knowledge_objects (supersedes_id)
  WHERE supersedes_id IS NOT NULL;

CREATE UNIQUE INDEX knowledge_objects_superseded_by_id
  ON knowledge_objects (superseded_by_id)
  WHERE superseded_by_id IS NOT NULL;

CREATE INDEX knowledge_objects_scope_class_active
  ON knowledge_objects (scope_id, knowledge_class)
  WHERE valid_to_version IS NULL;

CREATE INDEX knowledge_objects_type_status
  ON knowledge_objects (type, status)
  WHERE valid_to_version IS NULL;

CREATE INDEX knowledge_objects_feature_labels
  ON knowledge_objects USING gin (feature_label_ids);

CREATE INDEX knowledge_objects_version_window
  ON knowledge_objects (valid_from_version, valid_to_version);

CREATE INDEX knowledge_objects_last_verified
  ON knowledge_objects (last_verified_at)
  WHERE valid_to_version IS NULL;

CREATE INDEX knowledge_objects_attributes
  ON knowledge_objects USING gin (attributes jsonb_path_ops);

CREATE UNIQUE INDEX glossary_active_term
  ON knowledge_objects (scope_id, lower(attributes ->> 'term'))
  WHERE type = 'glossary_entry'
    AND status = 'active'
    AND valid_to_version IS NULL;
