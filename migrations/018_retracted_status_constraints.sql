-- Domain Spec Amendment A19: permit `retracted` on every Knowledge Object type.

ALTER TABLE knowledge_objects DROP CONSTRAINT knowledge_objects_status_for_type;

ALTER TABLE knowledge_objects ADD CONSTRAINT knowledge_objects_status_for_type CHECK (
  (type = 'requirement' AND status IN ('active', 'superseded', 'withdrawn', 'retracted'))
  OR (type = 'discussion' AND status IN ('recorded', 'distilled', 'archived', 'retracted'))
  OR (
    type = 'observation'
    AND status IN (
      'observed',
      'promoted_to_question',
      'promoted_to_hypothesis',
      'absorbed',
      'stale',
      'retracted'
    )
  )
  OR (type = 'hypothesis' AND status IN ('explored', 'rejected', 'revived', 'retracted'))
  OR (type = 'decision' AND status IN ('active', 'superseded', 'reverted', 'retracted'))
  OR (type = 'open_question' AND status IN ('open', 'resolved', 'obsolete', 'retracted'))
  OR (type = 'constraint' AND status IN ('active', 'superseded', 'lifted', 'retracted'))
  OR (type = 'glossary_entry' AND status IN ('active', 'superseded', 'deprecated', 'retracted'))
  OR (type = 'artifact' AND status IN ('current', 'superseded', 'retracted'))
);
