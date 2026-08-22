export const KNOWLEDGE_OBJECT_TYPES = [
  "requirement",
  "discussion",
  "observation",
  "hypothesis",
  "decision",
  "open_question",
  "constraint",
  "glossary_entry",
  "artifact",
] as const;

export type KnowledgeObjectType = (typeof KNOWLEDGE_OBJECT_TYPES)[number];

export type KnowledgeClass = "raw" | "reviewed" | "operational";

export type AuthoredBy = "human" | "ai";

export type DiscussionMedium = "chat" | "meeting" | "async" | "investigation";

export type Reversibility = "cheap" | "costly" | "one_way";

export type Enforcement = "hard" | "soft";

export type DecisionOrigin = "unrecoverable";

export type ExternalReferenceSystem =
  "git" | "tracker" | "docs" | "design" | "dashboard" | "logs" | "other";

type EnvelopeBase = {
  readonly id: string;
  readonly scopeId: string;
  readonly featureLabelIds: readonly string[];
  readonly title: string;
  readonly body: string;
  readonly authoredBy: AuthoredBy;
  readonly sourceRef: string | null;
  readonly createdAt: Date;
  readonly approvedAt: Date | null;
  readonly lastVerifiedAt: Date | null;
  readonly supersedesId: string | null;
  readonly supersededById: string | null;
  readonly reviewRequired: boolean;
  readonly validFromVersion: number;
  readonly validToVersion: number | null;
  readonly lockVersion: number;
};

export type RejectedAlternative = {
  readonly alternative: string;
  readonly reason: string;
};

export type Requirement = EnvelopeBase & {
  readonly type: "requirement";
  readonly knowledgeClass: "reviewed";
  readonly status: "active" | "superseded" | "withdrawn" | "retracted";
  readonly attributes: {
    readonly source: string;
    readonly rationale: string;
  };
};

export type Discussion = EnvelopeBase & {
  readonly type: "discussion";
  readonly knowledgeClass: "raw";
  readonly status: "recorded" | "distilled" | "archived" | "retracted";
  readonly attributes: {
    readonly medium: DiscussionMedium;
    readonly occurredAt: Date;
    readonly contentRef: unknown;
    readonly participants?: readonly string[];
  };
};

export type Observation = EnvelopeBase & {
  readonly type: "observation";
  readonly knowledgeClass: "raw";
  readonly status:
    | "observed"
    | "promoted_to_question"
    | "promoted_to_hypothesis"
    | "absorbed"
    | "stale"
    | "retracted";
  readonly attributes: {
    readonly observedAt: Date;
    readonly evidenceRef: string;
    readonly reviewBy: Date;
  };
};

export type Hypothesis = EnvelopeBase & {
  readonly type: "hypothesis";
  readonly knowledgeClass: "reviewed";
  readonly status: "explored" | "rejected" | "revived" | "retracted";
  readonly attributes: {
    readonly whatWasTried: string;
    readonly whyItFailed: string;
    readonly evidenceRef: string;
    readonly wouldReconsiderIf?: string;
  };
};

export type Decision = EnvelopeBase & {
  readonly type: "decision";
  readonly knowledgeClass: "reviewed";
  readonly status: "active" | "superseded" | "reverted" | "retracted";
  readonly attributes: {
    readonly statement: string;
    readonly rationale: string;
    readonly reversibility: Reversibility;
    readonly alternativesRejected: readonly RejectedAlternative[];
    readonly origin?: DecisionOrigin;
  };
};

export type OpenQuestion = EnvelopeBase & {
  readonly type: "open_question";
  readonly knowledgeClass: "reviewed";
  readonly status: "open" | "resolved" | "obsolete" | "retracted";
  readonly attributes: {
    readonly question: string;
    readonly blocking: boolean;
    readonly owner?: string;
  };
};

export type Constraint = EnvelopeBase & {
  readonly type: "constraint";
  readonly knowledgeClass: "operational";
  readonly status: "active" | "superseded" | "lifted" | "retracted";
  readonly attributes: {
    readonly rule: string;
    readonly enforcement: Enforcement;
    readonly axiomatic: boolean;
  };
};

export type GlossaryEntry = EnvelopeBase & {
  readonly type: "glossary_entry";
  readonly knowledgeClass: "operational";
  readonly status: "active" | "superseded" | "deprecated" | "retracted";
  readonly attributes: {
    readonly term: string;
    readonly definition: string;
    readonly axiomatic: boolean;
    readonly aliases?: readonly string[];
  };
};

export type Artifact = EnvelopeBase & {
  readonly type: "artifact";
  readonly knowledgeClass: "reviewed";
  readonly status: "current" | "superseded" | "retracted";
  readonly attributes: {
    readonly kind: string;
    readonly version: string;
    readonly location: string;
    readonly contentHash: string;
    readonly summary: string;
  };
};

export type KnowledgeObject =
  | Requirement
  | Discussion
  | Observation
  | Hypothesis
  | Decision
  | OpenQuestion
  | Constraint
  | GlossaryEntry
  | Artifact;

export type ExternalReference = {
  readonly type: "external_reference";
  readonly id: string;
  readonly system: ExternalReferenceSystem;
  readonly identifier: string;
  readonly location: string | null;
  readonly symbol: string | null;
  readonly lastVerifiedAt: Date | null;
  readonly createdAt: Date;
};

export type CandidateStatus = "pending" | "accepted" | "rejected" | "expired";

export type Candidate = {
  readonly id: string;
  readonly proposedType: KnowledgeObjectType;
  readonly payload: unknown;
  readonly parentId: string | null;
  readonly sourceRef: string | null;
  readonly proposedBy: AuthoredBy;
  readonly status: CandidateStatus;
  readonly resolution: unknown | null;
  readonly createdAt: Date;
  readonly resolvedAt: Date | null;
};

/** Ten entity types: nine knowledge objects plus External Reference (MTS 2.1 / 2.3). */
export type GraphEntity = KnowledgeObject | ExternalReference;

export const ID_PREFIX: { readonly [K in KnowledgeObjectType | "external_reference"]: string } = {
  requirement: "REQ",
  discussion: "DSC",
  observation: "OBS",
  hypothesis: "HYP",
  decision: "DEC",
  open_question: "OQU",
  constraint: "CON",
  glossary_entry: "GLO",
  artifact: "ART",
  external_reference: "XRF",
};
