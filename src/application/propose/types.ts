import type {
  AuthoredBy,
  KnowledgeObjectType,
} from "../../domain/entity/types.js";
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

export type ProposalPayload = {
  readonly objects: readonly KnowledgeObjectWrite[];
  readonly relations?: readonly RelationWrite[];
};

export type ResolveDiscussionInput = {
  readonly discussion: KnowledgeObjectWrite;
  readonly proposal: ProposalPayload;
};

export type ProposalValidationResult = {
  readonly valid: true;
  readonly objectIds: readonly string[];
  readonly relationCount: number;
};

export type ResolveDiscussionResult = {
  readonly graphVersion: number;
  readonly validation: ProposalValidationResult;
  readonly candidateId: string;
  readonly candidateIds: readonly string[];
  readonly discussionId: string;
};
