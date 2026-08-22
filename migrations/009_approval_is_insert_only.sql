-- Approval is assigned when a durable object is inserted. It is not an
-- UPDATE transition, including for rows that are still raw.
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
    'knowledge_class'
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
