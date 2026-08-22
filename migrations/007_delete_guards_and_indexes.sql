-- Close the TRUNCATE and durable-row DELETE holes left by 006.
-- knowledge_objects_forbid_delete() raises DELETION_FORBIDDEN for either
-- row-level DELETE or statement-level TRUNCATE.

CREATE TRIGGER knowledge_objects_forbid_truncate
  BEFORE TRUNCATE ON knowledge_objects
  FOR EACH STATEMENT
  EXECUTE FUNCTION knowledge_objects_forbid_delete();

CREATE TRIGGER relations_forbid_delete
  BEFORE DELETE ON relations
  FOR EACH ROW
  EXECUTE FUNCTION knowledge_objects_forbid_delete();

CREATE TRIGGER relations_forbid_truncate
  BEFORE TRUNCATE ON relations
  FOR EACH STATEMENT
  EXECUTE FUNCTION knowledge_objects_forbid_delete();

CREATE TRIGGER feature_labels_forbid_truncate
  BEFORE TRUNCATE ON feature_labels
  FOR EACH STATEMENT
  EXECUTE FUNCTION knowledge_objects_forbid_delete();

CREATE TRIGGER feature_label_aliases_forbid_truncate
  BEFORE TRUNCATE ON feature_label_aliases
  FOR EACH STATEMENT
  EXECUTE FUNCTION knowledge_objects_forbid_delete();

CREATE TRIGGER graph_versions_forbid_delete
  BEFORE DELETE ON graph_versions
  FOR EACH ROW
  EXECUTE FUNCTION knowledge_objects_forbid_delete();

CREATE TRIGGER graph_versions_forbid_truncate
  BEFORE TRUNCATE ON graph_versions
  FOR EACH STATEMENT
  EXECUTE FUNCTION knowledge_objects_forbid_delete();

-- The open validity window, rather than the current status value, identifies
-- the row that owns a glossary term at a graph version.
DROP INDEX glossary_active_term;

CREATE UNIQUE INDEX glossary_active_term
  ON knowledge_objects (scope_id, lower(attributes ->> 'term'))
  WHERE type = 'glossary_entry'
    AND valid_to_version IS NULL;
