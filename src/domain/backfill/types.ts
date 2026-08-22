import type {
  ExternalReference,
  ExternalReferenceSystem,
  KnowledgeObject,
  KnowledgeObjectType,
} from "../entity/types.js";
import type { FeatureLabel, FeatureLabelAlias } from "../label/types.js";
import type { Relation } from "../relation/legality.js";
import type { Scope } from "../scope/types.js";

export type BackfillObjectDraft = {
  readonly sourcePath: string;
  readonly id: string;
  readonly type: string;
  readonly scopeId: string;
  readonly scopeIds: readonly string[];
  readonly featureLabels: readonly string[];
  readonly title: string;
  readonly body: string;
  readonly status: string;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly supersedesId: string | null;
};

export type BackfillRelationDraft = {
  readonly sourcePath: string;
  readonly sourceId: string;
  readonly relation: string;
  readonly targetId: string;
  readonly targetKind: string;
};

export type BackfillExternalReferenceDraft = {
  readonly sourcePath: string;
  readonly id: string;
  readonly system: string;
  readonly identifier: string;
  readonly location: string | null;
  readonly symbol: string | null;
  readonly lastVerifiedAt: Date | null;
};

export type BackfillScopeDraft = {
  readonly sourcePath: string;
  readonly id: string;
  readonly kind: string;
  readonly parentId: string | null;
  readonly name: string;
};

export type BackfillLabelDraft = {
  readonly sourcePath: string;
  readonly id: string;
  readonly projectScopeId: string;
  readonly canonicalName: string;
  readonly aliases: readonly string[];
  readonly status: string;
  readonly redirectsToId: string | null;
};

export type BackfillLabelAssignmentDraft = {
  readonly sourcePath: string;
  readonly objectId: string;
  readonly labelIds: readonly string[];
};

export type BackfillFrictionAction = {
  readonly actionId: string;
  readonly sourcePath: string;
  readonly kind: string;
  readonly description: string;
  readonly abandoned: boolean;
};

export type BackfillBundle = {
  readonly objects: readonly BackfillObjectDraft[];
  readonly relations: readonly BackfillRelationDraft[];
  readonly frictionActions: readonly BackfillFrictionAction[];
  readonly externalReferences?: readonly BackfillExternalReferenceDraft[];
  readonly scopes?: readonly BackfillScopeDraft[];
  readonly labels?: readonly BackfillLabelDraft[];
  readonly labelAssignments?: readonly BackfillLabelAssignmentDraft[];
};

export type BackfillParseFailure = {
  readonly sourcePath: string;
  readonly message: string;
};

export type BackfillGap = {
  readonly gapId: string;
  readonly instance: string;
  readonly source: string;
  readonly attemptedHomes: readonly string[];
  readonly candidateConcept: string;
  readonly recordedAs: "not_recorded";
  readonly date: Date;
};

export type BackfillLabelCandidate = {
  readonly normalised: string;
  readonly projectScopeId: string;
  readonly sources: readonly string[];
};

export type BackfillFailure = {
  readonly code: string;
  readonly sourcePath: string;
  readonly message: string;
  readonly objectId?: string;
  readonly relationIndex?: number;
};

export type BackfillDuplicateWarningReason =
  "normalised_title" | "trigram_title" | "identical_origin_set";

export type BackfillDuplicateWarning = {
  readonly objectIds: readonly [string, string];
  readonly sourcePaths: readonly [string, string];
  readonly reason: BackfillDuplicateWarningReason;
  readonly similarity: number | null;
  readonly message: string;
};

export type BackfillFrictionReport = {
  readonly actions: readonly BackfillFrictionAction[];
  readonly abandonedCount: number;
};

export type BackfillGapSummary = {
  readonly threshold: number;
  readonly counts: Readonly<Record<string, number>>;
  readonly promotableCandidateConcepts: readonly string[];
};

export type BackfillWorkingSet = {
  readonly objects: readonly KnowledgeObject[];
  readonly relations: readonly Relation[];
  readonly scopes: readonly Scope[];
  readonly labels: readonly FeatureLabel[];
  readonly aliases: readonly FeatureLabelAlias[];
  readonly externalReferences: readonly ExternalReference[];
};

export type BackfillPlan = {
  readonly objects: readonly BackfillObjectWrite[];
  readonly relations: readonly BackfillRelationWrite[];
  readonly supersessions: readonly BackfillSupersession[];
  readonly failures: readonly BackfillFailure[];
  readonly warnings: readonly BackfillDuplicateWarning[];
  readonly gaps: readonly BackfillGap[];
  readonly labelCandidates: readonly BackfillLabelCandidate[];
  readonly friction: BackfillFrictionReport;
  readonly gapSummary: BackfillGapSummary;
};

export type BackfillObjectWrite = {
  readonly id: string;
  readonly type: KnowledgeObjectType;
  readonly scopeId: string;
  readonly featureLabelIds: readonly string[];
  readonly title: string;
  readonly body: string;
  readonly status: KnowledgeObject["status"];
  readonly attributes: Record<string, unknown>;
  readonly authoredBy: "human";
  readonly sourceRef: string;
  readonly supersedesId: string | null;
  readonly supersededById: string | null;
};

export type BackfillExternalReferenceWrite = {
  readonly id: string;
  readonly system: ExternalReferenceSystem;
  readonly identifier: string;
  readonly location: string | null;
  readonly symbol: string | null;
  readonly lastVerifiedAt: Date | null;
};

export type BackfillRelationWrite = {
  readonly sourceId: string;
  readonly relation: Relation["relation"];
  readonly targetId: string;
  readonly targetKind: Relation["targetKind"];
};

export type BackfillSupersession = {
  readonly predecessorId: string;
  readonly successorId: string;
  readonly mode: "existing" | "historical";
};

export type BackfillReport = {
  readonly dryRun: boolean;
  readonly currentVersion: number;
  readonly nextVersion: number;
  readonly importedObjectIds: readonly string[];
  readonly importedRelationCount: number;
  readonly graphVersion: number | null;
  readonly graphVersions: readonly number[];
  readonly scopeGraphVersion: number | null;
  readonly objectGraphVersion: number | null;
  readonly labelGraphVersion: number | null;
  readonly failures: readonly BackfillFailure[];
  readonly warnings: readonly BackfillDuplicateWarning[];
  readonly gaps: readonly BackfillGap[];
  readonly gapSummary: BackfillGapSummary;
  readonly labelCandidates: readonly BackfillLabelCandidate[];
  readonly friction: BackfillFrictionReport;
};
