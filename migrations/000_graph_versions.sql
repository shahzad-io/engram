-- Master Tech Spec 8.1. Graph version is allocated once per committed
-- curation transaction. Every later table that carries valid_from_version
-- / valid_to_version refers here.
CREATE TYPE graph_version_actor AS ENUM ('curator', 'system');

CREATE TABLE graph_versions (
  version bigserial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  action text NOT NULL,
  actor graph_version_actor NOT NULL,
  object_ids text[] NOT NULL DEFAULT '{}'
);

COMMENT ON COLUMN graph_versions.object_ids IS
  'Identities whose validity window changed: knowledge objects, relations, and registry rows. Mixed namespaces; type-tagged ids (DEC-, FTL-) and relation bigserials as text. Not knowledge-objects-only.';
