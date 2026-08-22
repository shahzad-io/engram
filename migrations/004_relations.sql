-- Master Tech Spec 7.1. ONE row per id (bigserial). Version window on the
-- same row. Do not copy the label composite PK.
-- External references are relation targets only (MTS 2.3).

CREATE TYPE relation_verb AS ENUM (
  'derives_from',
  'supersedes',
  'references',
  'blocks',
  'requires',
  'invalidates',
  'explains',
  'implemented_by'
);

CREATE TYPE relation_target_kind AS ENUM (
  'knowledge_object',
  'external_reference'
);

CREATE TYPE external_reference_system AS ENUM (
  'git',
  'tracker',
  'docs',
  'design',
  'dashboard',
  'logs',
  'other'
);

CREATE TABLE external_references (
  id text PRIMARY KEY,
  system external_reference_system NOT NULL,
  identifier text NOT NULL,
  location text,
  symbol text,
  last_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT external_references_id_format CHECK (id ~ '^XRF-[0-9]{4,}$')
);

CREATE TABLE relations (
  id bigserial PRIMARY KEY,
  source_id text NOT NULL REFERENCES knowledge_objects (id),
  relation relation_verb NOT NULL,
  target_id text NOT NULL,
  target_kind relation_target_kind NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  valid_from_version bigint NOT NULL REFERENCES graph_versions (version),
  valid_to_version bigint REFERENCES graph_versions (version),
  CONSTRAINT relations_version_window CHECK (
    valid_to_version IS NULL OR valid_to_version > valid_from_version
  ),
  CONSTRAINT relations_no_self_edge CHECK (source_id <> target_id)
);

CREATE UNIQUE INDEX relations_triple
  ON relations (source_id, relation, target_id);

-- INV-6 / MTS 7.4: one open supersedes edge per source and per target.
CREATE UNIQUE INDEX relations_supersedes_source
  ON relations (source_id)
  WHERE relation = 'supersedes' AND valid_to_version IS NULL;

CREATE UNIQUE INDEX relations_supersedes_target
  ON relations (target_id)
  WHERE relation = 'supersedes' AND valid_to_version IS NULL;

CREATE INDEX relations_forward
  ON relations (source_id, relation)
  WHERE valid_to_version IS NULL;

CREATE INDEX relations_reverse
  ON relations (target_id, relation)
  WHERE valid_to_version IS NULL;

CREATE INDEX relations_supersedes_target_all
  ON relations (target_id)
  WHERE relation = 'supersedes';
