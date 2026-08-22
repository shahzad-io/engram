import type {
  AuthoredBy,
  KnowledgeClass,
  KnowledgeObject,
  KnowledgeObjectType,
} from "../entity/types.js";
import type { RelationVerb } from "../relation/legality.js";
import type { StalenessMarker, PackWorkingSet } from "../pack/types.js";

export type RetrievalDirection = "outgoing" | "incoming" | "both";

export type RetrievalRequest = {
  readonly scopeId?: string;
  readonly featureLabelIds?: readonly string[];
  readonly types?: readonly KnowledgeObjectType[];
  readonly classes?: readonly KnowledgeClass[];
  readonly statuses?: readonly KnowledgeObject["status"][];
  readonly text?: string;
  readonly seedObjectId?: string;
  readonly relation?: RelationVerb;
  readonly direction?: RetrievalDirection;
  readonly asOfVersion: number;
  readonly currentVersion: number;
  readonly followSupersession?: boolean;
  readonly evaluatedAt?: Date;
};

export type RetrievalProvenance = {
  readonly authoredBy: AuthoredBy;
  readonly approvedAt: Date | null;
  readonly lastVerifiedAt: Date | null;
  readonly reviewRequired: boolean;
};

export type RetrievalResult = {
  readonly object: KnowledgeObject;
  readonly tier: 1 | 2 | 3;
  readonly scopeDepth: number;
  readonly staleness: StalenessMarker;
  readonly provenance: RetrievalProvenance;
  readonly evidenceReferenceIds: readonly string[];
};

export type RetrievalResponse = {
  readonly results: readonly RetrievalResult[];
  readonly tier: 1 | 2 | 3 | null;
  readonly tierEscalations: readonly string[];
};

export type RetrievalWorkingSet = PackWorkingSet;
