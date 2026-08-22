-- INV-10 / MTS 8.6: walk reverse derives_from edges through Decision
-- chains, then flag every active Decision reached by the requirement change.
CREATE OR REPLACE FUNCTION knowledge_objects_requirement_impact()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.type = 'requirement'
     AND NEW.status IN ('superseded', 'withdrawn')
     AND (OLD.status IS DISTINCT FROM NEW.status) THEN
    WITH RECURSIVE affected(id, depth) AS (
      SELECT r.source_id, 1
      FROM relations r
      WHERE r.target_id = NEW.id
        AND r.relation = 'derives_from'
        AND r.valid_to_version IS NULL

      UNION ALL

      SELECT r.source_id, affected.depth + 1
      FROM relations r
      INNER JOIN affected ON affected.id = r.target_id
      WHERE r.relation = 'derives_from'
        AND r.valid_to_version IS NULL
        AND affected.depth < 64
    )
    UPDATE knowledge_objects d
    SET review_required = true
    WHERE d.id IN (SELECT DISTINCT id FROM affected)
      AND d.type = 'decision'
      AND d.status = 'active';
  END IF;
  RETURN NEW;
END;
$$;
