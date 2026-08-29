import { DomainError, ErrorCode } from "../domain/errors.js";
import type { RelationTargetKind, RelationVerb } from "../domain/relation/legality.js";

/*
 * One reader for `target_kind`, shared by every surface that accepts a
 * written relation. There used to be three private copies of this — MCP,
 * `supersede --file`, and the backfill parser — and a fourth surface,
 * `triage edit --payload`, was added without one. An omitted kind therefore
 * reached a BEFORE INSERT trigger and came back as a bare `ILLEGAL_RELATION`
 * for a relation that was legal. Copies are how that happened, so there is
 * one copy now.
 *
 * Absence means `knowledge_object`, which is what the three surfaces that
 * did fill it in already promised. Whether a value that is *present* is
 * meaningful is not decided here: the domain layer decides that, once, in
 * `checkLegality`, where the message can name the edge and the field.
 */

export const DEFAULT_RELATION_TARGET_KIND = "knowledge_object";

/** The target kind a relation carries, in either spelling. */
export function readRelationTargetKind(value: Record<string, unknown>): string {
  const written = value.targetKind ?? value.target_kind;
  return written === undefined || written === null
    ? DEFAULT_RELATION_TARGET_KIND
    : String(written);
}

/**
 * Structural, so the two callers can keep their own `RelationWrite` aliases
 * and `src/mcp/` need not import anything under `src/application/write/`.
 */
export type RelationWriteFields = {
  readonly sourceId: string;
  readonly relation: RelationVerb;
  readonly targetId: string;
  readonly targetKind: RelationTargetKind;
};

function requireField(value: unknown, context: string, field: string): string {
  if (typeof value !== "string" || value === "") {
    throw new DomainError(
      ErrorCode.MISSING_ARGUMENT,
      `missing ${field} on a ${context} relation`,
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `context` names the surface, so a caller told a field is missing knows
 * which document to look in.
 */
export function normaliseRelationWrite(value: unknown, context: string): RelationWriteFields {
  if (!isRecord(value)) {
    throw new DomainError(ErrorCode.INVALID_PAYLOAD, `${context} relations must be objects`);
  }
  return {
    sourceId: requireField(value.sourceId ?? value.source_id, context, "sourceId"),
    relation: requireField(value.relation, context, "relation") as RelationVerb,
    targetId: requireField(value.targetId ?? value.target_id, context, "targetId"),
    targetKind: readRelationTargetKind(value) as RelationTargetKind,
  };
}
