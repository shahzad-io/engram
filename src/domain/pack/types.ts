import type {
  AuthoredBy,
  DecisionOrigin,
  ExternalReference,
  KnowledgeObject,
  KnowledgeObjectType,
} from "../entity/types.js";
import type { FeatureLabel, FeatureLabelAlias } from "../label/types.js";
import type { Relation } from "../relation/legality.js";
import type { Scope } from "../scope/types.js";

export const CONTEXT_PACK_INTENTS = [
  "implementation",
  "review",
  "debug",
  "architecture",
  "onboarding",
  "planning",
] as const;

export type ContextPackIntent = (typeof CONTEXT_PACK_INTENTS)[number];

export type PackSectionKey =
  | "objective"
  | "constraints"
  | "blocking_open_questions"
  | "glossary"
  | "active_decisions"
  | "requirements"
  | "rejected_hypotheses"
  | "non_blocking_open_questions"
  | "unexplained_observations"
  | "artifact_summaries"
  | "external_references"
  | "superseded_decisions";

export type GraphVersionSnapshot = {
  readonly version: number;
  readonly createdAt: Date;
};

export type PackWorkingSet = {
  readonly objects: readonly KnowledgeObject[];
  readonly relations: readonly Relation[];
  readonly scopes: readonly Scope[];
  readonly labels: readonly FeatureLabel[];
  readonly aliases: readonly FeatureLabelAlias[];
  readonly externalReferences: readonly ExternalReference[];
  readonly graphVersions: readonly GraphVersionSnapshot[];
};

export type ContextPackRequest = {
  readonly scopeId: string;
  readonly featureLabelIds?: readonly string[];
  readonly glossaryEntryIds?: readonly string[];
  readonly intent: ContextPackIntent;
  readonly budget: number;
  readonly graphVersion: number;
  readonly builtAt: Date;
  readonly tierEscalations?: readonly string[];
};

export type StalenessMarker = {
  readonly state: "fresh" | "stale" | "not_applicable";
  readonly kind: "computed" | "materialised" | "none";
  readonly thresholdDays: number | null;
};

export type RenderedObject = {
  readonly id: string;
  readonly type: KnowledgeObjectType | "external_reference";
  readonly section: PackSectionKey;
  readonly scopeId: string | null;
  readonly scopePath: string | null;
  readonly authoredBy: AuthoredBy | null;
  readonly origin: DecisionOrigin | null;
  readonly approvedAt: Date | null;
  readonly status: string | null;
  readonly title: string;
  readonly body: string | null;
  readonly attributes: Readonly<Record<string, unknown>> | null;
  readonly staleness: StalenessMarker;
  readonly reviewRequired: boolean;
  readonly evidenceReferenceIds: readonly string[];
};

export type ContextPackSection = {
  readonly name: string;
  readonly key: PackSectionKey;
  readonly objects: readonly RenderedObject[];
};

export type ContextPackRecipe = {
  readonly scopeId: string;
  readonly featureLabelIds: readonly string[];
  readonly glossaryEntryIds: readonly string[];
  readonly intent: ContextPackIntent;
  readonly budget: number;
  readonly graphVersion: number;
  readonly builtAt: Date;
  readonly orderedObjectIds: readonly string[];
  readonly droppedObjectIds: readonly string[];
  readonly contentHash: string;
};

export type ContextPackDiagnostics = {
  readonly droppedCount: number;
  readonly suppressedByPrecedence: readonly string[];
  readonly tierEscalations: readonly string[];
  readonly estimatedTokens: number;
  readonly budgetUtilisation: number;
  readonly mandatoryEstimatedTokens: number;
  readonly mandatoryContentBudgetPercentage: number;
  readonly glossaryPasses: number;
  readonly glossaryResidualTerms: readonly string[];
};

export type ContextPack = {
  readonly recipe: ContextPackRecipe;
  readonly objective: {
    readonly scopeId: string;
    readonly scopePath: string;
    readonly scopeName: string;
  };
  readonly sections: readonly ContextPackSection[];
  readonly diagnostics: ContextPackDiagnostics;
};

export type SupersessionPair = {
  readonly predecessorId: string;
  readonly successorId: string;
};

export type ContextPackDiff = {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly superseded: readonly SupersessionPair[];
  readonly unchanged: readonly string[];
  readonly markerChanges: readonly string[];
};
