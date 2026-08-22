import type { Client } from "pg";
import type {
  AuthoredBy,
  ExternalReferenceSystem,
  KnowledgeObject,
  KnowledgeObjectType,
} from "../../domain/entity/types.js";
import type { FeatureLabelStatus } from "../../domain/label/types.js";
import type { RelationTargetKind, RelationVerb } from "../../domain/relation/legality.js";
import type { ScopeKind } from "../../domain/scope/types.js";

export type JsonObject = Record<string, unknown>;

/**
 * The storage-shaped input accepted by the curation primitive.
 *
 * Approval timestamps and validity windows are assigned by the transaction;
 * callers cannot use a Candidate to smuggle an already-approved row into the
 * graph with a different history.
 */
export type KnowledgeObjectWrite = {
  readonly id: string;
  readonly type: KnowledgeObjectType;
  readonly scopeId: string;
  readonly featureLabelIds?: readonly string[];
  readonly title: string;
  readonly body: string;
  readonly status: KnowledgeObject["status"];
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

export type FeatureLabelWrite = {
  readonly id: string;
  readonly projectScopeId: string;
  readonly canonicalName: string;
  readonly status?: FeatureLabelStatus;
  readonly redirectsToId?: string | null;
  readonly aliases?: readonly string[];
};

export type FeatureLabelAliasWrite = {
  readonly labelId: string;
  readonly projectScopeId: string;
  readonly alias: string;
};

export type FeatureLabelAssignment = {
  readonly objectId: string;
  readonly featureLabelIds: readonly string[];
};

export type ScopeWrite = {
  readonly id: string;
  readonly kind: ScopeKind;
  readonly parentId: string | null;
  readonly name: string;
};

export type ExternalReferenceWrite = {
  readonly id: string;
  readonly system: ExternalReferenceSystem;
  readonly identifier: string;
  readonly location?: string | null;
  readonly symbol?: string | null;
  readonly lastVerifiedAt?: Date | null;
};

export type CandidatePayload = {
  readonly objects: readonly KnowledgeObjectWrite[];
  readonly relations?: readonly RelationWrite[];
};

export type CandidateElement = {
  readonly object: KnowledgeObjectWrite;
  readonly relations?: readonly RelationWrite[];
};

export type CreateCandidateInput = {
  readonly id?: string;
  readonly payload?: CandidatePayload;
  readonly elements?: readonly CandidateElement[];
  readonly sourceRef?: string | null;
  readonly proposedBy?: AuthoredBy;
};

export type CandidateRecord = {
  readonly id: string;
  readonly proposedType: KnowledgeObjectType;
  readonly payload: CandidatePayload;
  readonly parentId: string | null;
  readonly sourceRef: string | null;
  readonly proposedBy: AuthoredBy;
  readonly status: "pending" | "accepted" | "rejected" | "expired";
  readonly resolution: JsonObject | null;
  readonly createdAt: Date;
  readonly resolvedAt: Date | null;
};

export type CurationTransactionOptions = {
  readonly action: string;
  readonly actor?: "curator" | "system";
};

export type CurationResult<T> = {
  readonly version: number;
  readonly value: T;
};

export type CurationWork = {
  readonly client: Client;
  readonly version: number;
  readonly backfillMode: boolean;
  readonly insertObject: (object: KnowledgeObjectWrite, authoredBy?: AuthoredBy) => Promise<void>;
  readonly insertFeatureLabel: (label: FeatureLabelWrite) => Promise<void>;
  readonly insertFeatureLabelAlias: (alias: FeatureLabelAliasWrite) => Promise<void>;
  readonly relabelObject: (objectId: string, featureLabelIds: readonly string[]) => Promise<void>;
  readonly insertScope: (scope: ScopeWrite) => Promise<void>;
  readonly insertExternalReference: (reference: ExternalReferenceWrite) => Promise<void>;
  readonly insertRelation: (relation: RelationWrite) => Promise<string>;
  readonly closeRelation: (
    sourceId: string,
    relation: RelationWrite["relation"],
    targetId: string,
  ) => Promise<void>;
  readonly repointRelation: (
    sourceId: string,
    relation: RelationWrite["relation"],
    oldTargetId: string,
    newTargetId: string,
    targetKind: RelationTargetKind,
  ) => Promise<string>;
  readonly supersede: (predecessorId: string, successorId: string) => Promise<void>;
  readonly transition: (
    objectId: string,
    status: KnowledgeObject["status"],
    transitionAt?: Date,
  ) => Promise<void>;
  readonly addGraphIdentity: (identity: string) => void;
};

export type VerifyResult = {
  readonly object: Record<string, unknown>;
  readonly alsoReview: readonly Record<string, unknown>[];
};

export type CandidateTriageResult = {
  readonly action: "accept" | "edit_and_accept" | "merge";
  readonly candidateIds: readonly string[];
  readonly objectIds: readonly string[];
  readonly version: number;
};
