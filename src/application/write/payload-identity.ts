import { DomainError, ErrorCode } from "../../domain/errors.js";
import type { AssignedId, CandidateObjectWrite, JsonObject } from "./types.js";

/**
 * How a Candidate's object is named inside its own payload, whichever shape it
 * was written in. Relations within a payload resolve against this value, so
 * every reader of a Candidate has to agree on it; there is one implementation
 * rather than one per reader.
 */
export function payloadIdentity(object: CandidateObjectWrite): string {
  const identity = object.localId ?? object.id;
  if (identity === undefined || identity === "") {
    throw new DomainError(
      ErrorCode.PROVENANCE_REQUIRED,
      "candidate object has neither a local_id nor an id",
    );
  }
  return identity;
}

/**
 * The local-to-graph mapping recorded when an element of this group was
 * accepted earlier. A later sibling's relations still name the local handle,
 * because nothing rewrites a payload in place.
 */
export function assignedIdsFrom(resolution: JsonObject | null): readonly AssignedId[] {
  const assigned = resolution?.assignedIds;
  if (!Array.isArray(assigned)) return [];
  return assigned.filter(
    (entry): entry is AssignedId =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as AssignedId).localId === "string" &&
      typeof (entry as AssignedId).id === "string",
  );
}
