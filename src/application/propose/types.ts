import type { AuthoredBy, KnowledgeObjectType } from "../../domain/entity/types.js";
import type { RelationTargetKind, RelationVerb } from "../../domain/relation/legality.js";

export type JsonObject = Record<string, unknown>;

export type KnowledgeObjectWrite = {
  readonly id: string;
  readonly type: KnowledgeObjectType;
  readonly scopeId: string;
  readonly featureLabelIds?: readonly string[];
  readonly title: string;
  readonly body: string;
  readonly status: string;
  readonly attributes: JsonObject;
  readonly authoredBy: AuthoredBy;
  readonly sourceRef?: string | null;
  readonly supersedesId?: string | null;
  readonly supersededById?: string | null;
};

export type RelationWrite = {
  readonly sourceId: string;
  readonly relation: RelationVerb;
  readonly targetId: string;
  readonly targetKind: RelationTargetKind;
};

/**
 * Proposed objects are not knowledge and have no graph identity. `localId`
 * names one inside this payload so relations can reach it; Engram assigns the
 * graph id if a curator accepts it.
 */
export type ProposalObjectWrite = Omit<KnowledgeObjectWrite, "id"> & {
  readonly localId: string;
};

export type ProposalPayload = {
  readonly objects: readonly ProposalObjectWrite[];
  readonly relations?: readonly RelationWrite[];
};

export type StoredProposalPayload = {
  readonly objects: readonly ProposalObjectWrite[];
  readonly relations: readonly RelationWrite[];
};

/**
 * The caller does not name the discussion: Engram allocates its id inside the
 * curation transaction. `localId` is a handle with meaning only inside one
 * payload, so relations can point at the discussion before it has an id.
 */
export type DiscussionWrite = Omit<KnowledgeObjectWrite, "id"> & {
  readonly localId: string;
};

export type ResolveDiscussionInput = {
  readonly discussion: DiscussionWrite;
  readonly proposal: ProposalPayload;
};

export type ProposalValidationResult = {
  readonly valid: true;
  /** Handles the caller chose. Graph ids do not exist until a curator accepts. */
  readonly localIds: readonly string[];
  readonly relationCount: number;
};

export type PreparedDiscussionProposal = {
  readonly validation: ProposalValidationResult;
  readonly discussion: KnowledgeObjectWrite;
  readonly proposal: StoredProposalPayload;
};

export type ResolveDiscussionResult = {
  readonly graphVersion: number;
  readonly validation: ProposalValidationResult;
  readonly candidateId: string;
  readonly candidateIds: readonly string[];
  readonly discussionId: string;
};
