import type { KnowledgeObject } from "../entity/types.js";
import type { ContextPackIntent, PackSectionKey } from "./types.js";

export type PackSectionDefinition = {
  readonly key: PackSectionKey;
  readonly name: string;
  readonly index: number;
};

export const PACK_SECTIONS: readonly PackSectionDefinition[] = [
  { key: "objective", name: "Objective", index: 1 },
  { key: "constraints", name: "Constraints", index: 2 },
  { key: "blocking_open_questions", name: "Blocking Open Questions", index: 3 },
  { key: "glossary", name: "Glossary", index: 4 },
  { key: "active_decisions", name: "Active Decisions", index: 5 },
  { key: "requirements", name: "Requirements", index: 6 },
  { key: "rejected_hypotheses", name: "Rejected Hypotheses", index: 7 },
  {
    key: "non_blocking_open_questions",
    name: "Non-blocking Open Questions",
    index: 8,
  },
  {
    key: "unexplained_observations",
    name: "Unexplained Observations",
    index: 9,
  },
  { key: "artifact_summaries", name: "Artifact Summaries", index: 10 },
  { key: "external_references", name: "External References", index: 11 },
  { key: "superseded_decisions", name: "Superseded Decisions (recent)", index: 12 },
] as const;

const ALL_KNOWLEDGE_SECTIONS: readonly PackSectionKey[] = [
  "objective",
  "constraints",
  "blocking_open_questions",
  "glossary",
  "active_decisions",
  "requirements",
  "rejected_hypotheses",
  "non_blocking_open_questions",
  "unexplained_observations",
  "artifact_summaries",
  "external_references",
  "superseded_decisions",
];

export const INTENT_PROFILES: Readonly<Record<ContextPackIntent, readonly PackSectionKey[]>> = {
  implementation: [
    "objective",
    "constraints",
    "blocking_open_questions",
    "glossary",
    "active_decisions",
    "requirements",
    "rejected_hypotheses",
    "artifact_summaries",
    "external_references",
  ],
  review: [
    "objective",
    "constraints",
    "blocking_open_questions",
    "glossary",
    "active_decisions",
    "requirements",
    "artifact_summaries",
    "external_references",
    "superseded_decisions",
  ],
  debug: [
    "objective",
    "constraints",
    "blocking_open_questions",
    "glossary",
    "active_decisions",
    "rejected_hypotheses",
    "non_blocking_open_questions",
    "unexplained_observations",
    "external_references",
    "superseded_decisions",
  ],
  architecture: [
    "objective",
    "constraints",
    "blocking_open_questions",
    "glossary",
    "active_decisions",
    "requirements",
    "rejected_hypotheses",
    "non_blocking_open_questions",
    "artifact_summaries",
    "superseded_decisions",
  ],
  onboarding: [
    "objective",
    "constraints",
    "blocking_open_questions",
    "glossary",
    "active_decisions",
    "requirements",
    "non_blocking_open_questions",
    "artifact_summaries",
  ],
  planning: [
    "objective",
    "constraints",
    "blocking_open_questions",
    "glossary",
    "active_decisions",
    "requirements",
    "rejected_hypotheses",
    "non_blocking_open_questions",
    "unexplained_observations",
    "superseded_decisions",
  ],
};

const SECTION_BY_KEY = new Map(PACK_SECTIONS.map((section) => [section.key, section]));

export function sectionDefinition(key: PackSectionKey): PackSectionDefinition {
  const definition = SECTION_BY_KEY.get(key);
  if (definition === undefined) {
    throw new Error(`unknown pack section: ${key}`);
  }
  return definition;
}

export function profileSections(intent: ContextPackIntent): readonly PackSectionKey[] {
  return INTENT_PROFILES[intent];
}

/** Pre-retraction in-force status used when rebuilding packs at earlier graph versions. */
function inForceStatusBeforeRetraction(type: KnowledgeObject["type"]): KnowledgeObject["status"] {
  switch (type) {
    case "requirement":
    case "decision":
    case "constraint":
    case "glossary_entry":
      return "active";
    case "open_question":
      return "open";
    case "hypothesis":
      return "rejected";
    case "observation":
      return "observed";
    case "artifact":
      return "current";
    case "discussion":
      return "recorded";
  }
}

export function effectivePackStatus(
  object: KnowledgeObject,
  graphVersion: number,
): KnowledgeObject["status"] {
  if (object.status !== "retracted") {
    return object.status;
  }
  if (object.validToVersion === null || graphVersion >= object.validToVersion) {
    return "retracted";
  }
  return inForceStatusBeforeRetraction(object.type);
}

export function sectionForObject(
  object: KnowledgeObject,
  recentSuperseded: boolean,
  graphVersion: number,
): PackSectionKey | null {
  const status = effectivePackStatus(object, graphVersion);
  if (status === "retracted") {
    return null;
  }
  switch (object.type) {
    case "constraint":
      return status === "active" ? "constraints" : null;
    case "open_question":
      if (status !== "open") return null;
      return object.attributes.blocking ? "blocking_open_questions" : "non_blocking_open_questions";
    case "glossary_entry":
      return status === "active" ? "glossary" : null;
    case "decision":
      if (status === "active") return "active_decisions";
      return status === "superseded" && recentSuperseded ? "superseded_decisions" : null;
    case "requirement":
      return status === "active" ? "requirements" : null;
    case "hypothesis":
      return status === "rejected" ? "rejected_hypotheses" : null;
    case "observation":
      return status === "observed" ? "unexplained_observations" : null;
    case "artifact":
      return status === "current" ? "artifact_summaries" : null;
    case "discussion":
      return null;
  }
}

export function isKnownSection(key: string): key is PackSectionKey {
  return ALL_KNOWLEDGE_SECTIONS.includes(key as PackSectionKey);
}
