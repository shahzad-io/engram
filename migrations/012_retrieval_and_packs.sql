-- Retrieval and Context Pack persistence.
-- Pack assembly remains a domain-layer pure function; this migration stores
-- only the reproducible recipe and adds the tier-3 search index.
-- This replacement preserves migration 009's insert-only approval guard while
-- extending the generated-column whitelist for search_vector.

CREATE OR REPLACE FUNCTION knowledge_objects_append_only()
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

ALTER TABLE knowledge_objects
  ADD CONSTRAINT knowledge_objects_blocking_open_question_length CHECK (
    type <> 'open_question'
    OR (attributes ->> 'blocking') IS DISTINCT FROM 'true'
    OR char_length(COALESCE(attributes ->> 'question', '')) <= 280
  );

ALTER TABLE knowledge_objects
  ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector(
      'simple'::regconfig,
      coalesce(title, '') || ' ' || coalesce(body, '')
    )
  ) STORED;

CREATE INDEX knowledge_objects_search_vector
  ON knowledge_objects USING gin (search_vector);

CREATE INDEX knowledge_objects_explored_review
  ON knowledge_objects (created_at, id)
  WHERE type = 'hypothesis'
    AND status = 'explored'
    AND valid_to_version IS NULL;

CREATE TABLE context_packs (
  id uuid PRIMARY KEY,
  scope_id text NOT NULL REFERENCES scopes (id),
  feature_label_ids text[] NOT NULL DEFAULT '{}',
  glossary_entry_ids text[] NOT NULL DEFAULT '{}',
  intent text NOT NULL CHECK (
    intent IN (
      'implementation',
      'review',
      'debug',
      'architecture',
      'onboarding',
      'planning'
    )
  ),
  budget integer NOT NULL CHECK (budget > 0),
  graph_version bigint NOT NULL REFERENCES graph_versions (version),
  built_at timestamptz NOT NULL,
  ordered_object_ids text[] NOT NULL DEFAULT '{}',
  dropped_object_ids text[] NOT NULL DEFAULT '{}',
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX context_packs_request
  ON context_packs (scope_id, graph_version, intent);
