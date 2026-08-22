-- Master Tech Spec 7.3. Seed is the frozen triple table including A-REL-1.
-- Insert trigger rejects any triple absent from this table (ILLEGAL_RELATION).

CREATE TABLE relation_legality (
  source_type knowledge_object_type NOT NULL,
  relation relation_verb NOT NULL,
  target_type text NOT NULL,
  target_kind relation_target_kind NOT NULL,
  PRIMARY KEY (source_type, relation, target_type, target_kind)
);

INSERT INTO relation_legality (source_type, relation, target_type, target_kind)
VALUES
  ('decision', 'derives_from', 'requirement', 'knowledge_object'),
  ('decision', 'derives_from', 'discussion', 'knowledge_object'),
  ('decision', 'derives_from', 'observation', 'knowledge_object'),
  ('decision', 'derives_from', 'open_question', 'knowledge_object'),
  ('decision', 'derives_from', 'decision', 'knowledge_object'),
  ('requirement', 'derives_from', 'requirement', 'knowledge_object'),
  ('requirement', 'derives_from', 'discussion', 'knowledge_object'),
  ('requirement', 'derives_from', 'artifact', 'knowledge_object'),
  ('constraint', 'derives_from', 'decision', 'knowledge_object'),
  ('glossary_entry', 'derives_from', 'decision', 'knowledge_object'),
  ('glossary_entry', 'derives_from', 'artifact', 'knowledge_object'),
  ('hypothesis', 'derives_from', 'discussion', 'knowledge_object'),
  ('hypothesis', 'derives_from', 'observation', 'knowledge_object'),
  ('hypothesis', 'derives_from', 'open_question', 'knowledge_object'),
  ('open_question', 'derives_from', 'discussion', 'knowledge_object'),
  ('open_question', 'derives_from', 'observation', 'knowledge_object'),
  ('open_question', 'derives_from', 'requirement', 'knowledge_object'),
  ('decision', 'supersedes', 'decision', 'knowledge_object'),
  ('requirement', 'supersedes', 'requirement', 'knowledge_object'),
  ('constraint', 'supersedes', 'constraint', 'knowledge_object'),
  ('glossary_entry', 'supersedes', 'glossary_entry', 'knowledge_object'),
  ('artifact', 'supersedes', 'artifact', 'knowledge_object'),
  ('requirement', 'references', 'artifact', 'knowledge_object'),
  ('requirement', 'references', 'external_reference', 'external_reference'),
  ('requirement', 'references', 'discussion', 'knowledge_object'),
  ('discussion', 'references', 'artifact', 'knowledge_object'),
  ('discussion', 'references', 'external_reference', 'external_reference'),
  ('discussion', 'references', 'discussion', 'knowledge_object'),
  ('observation', 'references', 'artifact', 'knowledge_object'),
  ('observation', 'references', 'external_reference', 'external_reference'),
  ('observation', 'references', 'discussion', 'knowledge_object'),
  ('hypothesis', 'references', 'artifact', 'knowledge_object'),
  ('hypothesis', 'references', 'external_reference', 'external_reference'),
  ('hypothesis', 'references', 'discussion', 'knowledge_object'),
  ('decision', 'references', 'artifact', 'knowledge_object'),
  ('decision', 'references', 'external_reference', 'external_reference'),
  ('decision', 'references', 'discussion', 'knowledge_object'),
  ('open_question', 'references', 'artifact', 'knowledge_object'),
  ('open_question', 'references', 'external_reference', 'external_reference'),
  ('open_question', 'references', 'discussion', 'knowledge_object'),
  ('constraint', 'references', 'artifact', 'knowledge_object'),
  ('constraint', 'references', 'external_reference', 'external_reference'),
  ('constraint', 'references', 'discussion', 'knowledge_object'),
  ('glossary_entry', 'references', 'artifact', 'knowledge_object'),
  ('glossary_entry', 'references', 'external_reference', 'external_reference'),
  ('glossary_entry', 'references', 'discussion', 'knowledge_object'),
  ('artifact', 'references', 'artifact', 'knowledge_object'),
  ('artifact', 'references', 'external_reference', 'external_reference'),
  ('artifact', 'references', 'discussion', 'knowledge_object'),
  ('open_question', 'blocks', 'decision', 'knowledge_object'),
  ('open_question', 'blocks', 'requirement', 'knowledge_object'),
  ('hypothesis', 'blocks', 'decision', 'knowledge_object'),
  ('decision', 'requires', 'decision', 'knowledge_object'),
  ('decision', 'requires', 'constraint', 'knowledge_object'),
  ('requirement', 'requires', 'requirement', 'knowledge_object'),
  ('hypothesis', 'invalidates', 'decision', 'knowledge_object'),
  ('hypothesis', 'invalidates', 'hypothesis', 'knowledge_object'),
  ('decision', 'invalidates', 'constraint', 'knowledge_object'),
  ('decision', 'invalidates', 'hypothesis', 'knowledge_object'),
  ('observation', 'invalidates', 'decision', 'knowledge_object'),
  ('observation', 'invalidates', 'constraint', 'knowledge_object'),
  ('constraint', 'invalidates', 'constraint', 'knowledge_object'),
  ('decision', 'explains', 'observation', 'knowledge_object'),
  ('hypothesis', 'explains', 'observation', 'knowledge_object'),
  ('decision', 'implemented_by', 'external_reference', 'external_reference'),
  ('requirement', 'implemented_by', 'external_reference', 'external_reference');

CREATE FUNCTION relations_enforce_legality()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_t knowledge_object_type;
  target_t text;
BEGIN
  SELECT type INTO source_t FROM knowledge_objects WHERE id = NEW.source_id;
  IF source_t IS NULL THEN
    RAISE EXCEPTION 'ILLEGAL_RELATION'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NEW.target_kind = 'knowledge_object' THEN
    SELECT type::text INTO target_t FROM knowledge_objects WHERE id = NEW.target_id;
    IF target_t IS NULL THEN
      RAISE EXCEPTION 'ILLEGAL_RELATION'
        USING ERRCODE = 'foreign_key_violation';
    END IF;
  ELSIF NEW.target_kind = 'external_reference' THEN
    IF NOT EXISTS (SELECT 1 FROM external_references WHERE id = NEW.target_id) THEN
      RAISE EXCEPTION 'ILLEGAL_RELATION'
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    target_t := 'external_reference';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM relation_legality
    WHERE source_type = source_t
      AND relation = NEW.relation
      AND target_type = target_t
      AND target_kind = NEW.target_kind
  ) THEN
    RAISE EXCEPTION 'ILLEGAL_RELATION'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER relations_enforce_legality
  BEFORE INSERT ON relations
  FOR EACH ROW
  EXECUTE FUNCTION relations_enforce_legality();
