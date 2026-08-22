-- A20 / graph-version provenance: relation identities must not look like
-- knowledge-object ids. Historical graph versions stored relation bigserials
-- as bare text in object_ids, so normalise those identities once and make
-- every future write use the same REL- namespace.
UPDATE graph_versions AS version_row
SET object_ids = ARRAY(
  SELECT CASE
    WHEN identity ~ '^[0-9]+$' THEN 'REL-' || identity
    ELSE identity
  END
  FROM unnest(version_row.object_ids) AS identities(identity)
)
WHERE EXISTS (
  SELECT 1
  FROM unnest(version_row.object_ids) AS identities(identity)
  WHERE identity ~ '^[0-9]+$'
);

COMMENT ON COLUMN graph_versions.object_ids IS
  'Identities whose validity window or graph filing changed. Knowledge objects use their stable ids; scopes use SCP-, labels use FTL-, external references use XRF-, and relations use REL- followed by the relation bigserial. Namespaces are distinguishable even though they share this provenance array.';
