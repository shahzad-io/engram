export class DomainError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}

export type DomainFailure = {
  readonly code: string;
  readonly message: string;
  readonly objectId?: string;
};

/**
 * Carries every rejection from a validation pass. `code` and `message` are the
 * first failure's, so callers that only key on those behave exactly as they did
 * when validation threw on the first problem.
 */
export class AggregateDomainError extends DomainError {
  readonly failures: readonly DomainFailure[];

  constructor(failures: readonly DomainFailure[]) {
    const first = failures[0];
    if (first === undefined) {
      throw new Error("AggregateDomainError requires at least one failure");
    }
    super(first.code, first.message);
    this.name = "AggregateDomainError";
    this.failures = failures;
  }
}

/**
 * Runs one rule and records its rejection instead of propagating it. Returns
 * false when the rule failed, so callers can skip checks that would otherwise
 * read data the failed rule just reported as missing.
 */
export function recordFailure(
  failures: DomainFailure[],
  objectId: string | undefined,
  rule: () => void,
): boolean {
  try {
    rule();
    return true;
  } catch (error) {
    if (!(error instanceof DomainError)) {
      throw error;
    }
    failures.push({
      code: error.code,
      message: error.message,
      ...(objectId === undefined ? {} : { objectId }),
    });
    return false;
  }
}

export const ErrorCode = {
  SCOPE_NOT_FOUND: "SCOPE_NOT_FOUND",
  SCOPE_CHAIN_INVALID: "SCOPE_CHAIN_INVALID",
  SCOPE_REQUIRED: "SCOPE_REQUIRED",
  SCOPE_IMMUTABLE: "SCOPE_IMMUTABLE",
  INVALID_LABEL: "INVALID_LABEL",
  LABEL_REDIRECT_CYCLE: "LABEL_REDIRECT_CYCLE",
  UNKNOWN_LABEL: "UNKNOWN_LABEL",
  ILLEGAL_RELATION: "ILLEGAL_RELATION",
  ILLEGAL_TRANSITION: "ILLEGAL_TRANSITION",
  CYCLE_DETECTED: "CYCLE_DETECTED",
  IMMUTABLE_AFTER_APPROVAL: "IMMUTABLE_AFTER_APPROVAL",
  DELETION_FORBIDDEN: "DELETION_FORBIDDEN",
  PROVENANCE_REQUIRED: "PROVENANCE_REQUIRED",
  KNOWLEDGE_CLASS_MISMATCH: "KNOWLEDGE_CLASS_MISMATCH",
  RAW_APPROVAL_FORBIDDEN: "RAW_APPROVAL_FORBIDDEN",
  REQUIRED_ATTRIBUTES_MISSING: "REQUIRED_ATTRIBUTES_MISSING",
  DECISION_ORIGIN_REQUIRED: "DECISION_ORIGIN_REQUIRED",
  BACKFILL_ORIGIN_FORBIDDEN: "BACKFILL_ORIGIN_FORBIDDEN",
  INVALID_ORIGIN_MARKER: "INVALID_ORIGIN_MARKER",
  ORIGIN_MARKER_WITH_EDGE: "ORIGIN_MARKER_WITH_EDGE",
  CONSTRAINT_PARENT_REQUIRED: "CONSTRAINT_PARENT_REQUIRED",
  OBSERVATION_EVIDENCE_REQUIRED: "OBSERVATION_EVIDENCE_REQUIRED",
  SUPERSESSION_CONFLICT: "SUPERSESSION_CONFLICT",
  LENGTH_CAP_EXCEEDED: "LENGTH_CAP_EXCEEDED",
  INTENT_UNKNOWN: "INTENT_UNKNOWN",
  MISSING_ARGUMENT: "MISSING_ARGUMENT",
  INVALID_USAGE: "INVALID_USAGE",
  INVALID_ARGUMENT: "INVALID_ARGUMENT",
  INVALID_PAYLOAD: "INVALID_PAYLOAD",
  CANDIDATE_NOT_FOUND: "CANDIDATE_NOT_FOUND",
  CANDIDATE_NOT_PENDING: "CANDIDATE_NOT_PENDING",
  CANDIDATE_NOT_IN_GROUP: "CANDIDATE_NOT_IN_GROUP",
  CANDIDATE_SELECTION_INVALID: "CANDIDATE_SELECTION_INVALID",
  CANDIDATE_EDIT_INVALID: "CANDIDATE_EDIT_INVALID",
  CANDIDATE_CONFLICT: "CANDIDATE_CONFLICT",
  EDITOR_UNAVAILABLE: "EDITOR_UNAVAILABLE",
  EDITOR_FAILED: "EDITOR_FAILED",
  EDIT_UNCHANGED: "EDIT_UNCHANGED",
  EDIT_INVALID_JSON: "EDIT_INVALID_JSON",
  OBJECT_NOT_FOUND: "OBJECT_NOT_FOUND",
  PACK_NOT_FOUND: "PACK_NOT_FOUND",
  PACK_BUDGET_INSUFFICIENT: "PACK_BUDGET_INSUFFICIENT",
  PACK_HASH_MISMATCH: "PACK_HASH_MISMATCH",
  PACK_GRAPH_VERSION_NOT_FOUND: "PACK_GRAPH_VERSION_NOT_FOUND",
  GLOSSARY_ENTRY_NOT_FOUND: "GLOSSARY_ENTRY_NOT_FOUND",
  PACK_DIFF_INCOMPATIBLE: "PACK_DIFF_INCOMPATIBLE",
} as const;
