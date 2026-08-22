import type { KnowledgeObject, KnowledgeObjectType } from "../entity/types.js";

export type BackfillSkeletonValue = string | boolean | readonly unknown[];

export type BackfillTypeSpec = {
  readonly idPrefix: string;
  readonly initialStatus: KnowledgeObject["status"];
  readonly requiredAttributes: readonly string[];
  readonly optionalAttributes: readonly string[];
  readonly skeletonAttributes: Readonly<Record<string, BackfillSkeletonValue>>;
};

export const BACKFILL_TYPE_SPECS = {
  requirement: {
    idPrefix: "REQ",
    initialStatus: "active",
    requiredAttributes: ["source", "rationale"],
    optionalAttributes: [],
    skeletonAttributes: {
      source: "",
      rationale: "",
    },
  },
  discussion: {
    idPrefix: "DSC",
    initialStatus: "recorded",
    requiredAttributes: ["medium", "occurred_at", "content_ref"],
    optionalAttributes: ["participants"],
    skeletonAttributes: {
      medium: "",
      occurred_at: "",
      content_ref: "",
    },
  },
  observation: {
    idPrefix: "OBS",
    initialStatus: "observed",
    requiredAttributes: ["observed_at", "evidence_ref", "review_by"],
    optionalAttributes: [],
    skeletonAttributes: {
      observed_at: "",
      evidence_ref: "",
      review_by: "",
    },
  },
  hypothesis: {
    idPrefix: "HYP",
    initialStatus: "explored",
    requiredAttributes: ["what_was_tried", "why_it_failed", "evidence_ref"],
    optionalAttributes: ["would_reconsider_if"],
    skeletonAttributes: {
      what_was_tried: "",
      why_it_failed: "",
      evidence_ref: "",
    },
  },
  decision: {
    idPrefix: "DEC",
    initialStatus: "active",
    requiredAttributes: ["statement", "rationale", "reversibility", "alternatives_rejected"],
    optionalAttributes: [],
    skeletonAttributes: {
      statement: "",
      rationale: "",
      reversibility: "",
      alternatives_rejected: [],
    },
  },
  open_question: {
    idPrefix: "OQU",
    initialStatus: "open",
    requiredAttributes: ["question", "blocking"],
    optionalAttributes: ["owner"],
    skeletonAttributes: {
      question: "",
      blocking: false,
    },
  },
  constraint: {
    idPrefix: "CON",
    initialStatus: "active",
    requiredAttributes: ["rule", "enforcement", "axiomatic"],
    optionalAttributes: [],
    skeletonAttributes: {
      rule: "",
      enforcement: "",
      axiomatic: false,
    },
  },
  glossary_entry: {
    idPrefix: "GLO",
    initialStatus: "active",
    requiredAttributes: ["term", "definition", "axiomatic"],
    optionalAttributes: ["aliases"],
    skeletonAttributes: {
      term: "",
      definition: "",
      axiomatic: false,
    },
  },
  artifact: {
    idPrefix: "ART",
    initialStatus: "current",
    requiredAttributes: ["kind", "version", "location", "content_hash", "summary"],
    optionalAttributes: [],
    skeletonAttributes: {
      kind: "",
      version: "",
      location: "",
      content_hash: "",
      summary: "",
    },
  },
} as const satisfies Readonly<Record<KnowledgeObjectType, BackfillTypeSpec>>;

export function isBackfillType(value: string): value is KnowledgeObjectType {
  return Object.hasOwn(BACKFILL_TYPE_SPECS, value);
}
