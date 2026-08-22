-- Domain Spec Amendment A19: add terminal status `retracted`.
-- Enum values must be committed before use in constraints (PostgreSQL 55P04).

ALTER TYPE knowledge_object_status ADD VALUE IF NOT EXISTS 'retracted';
