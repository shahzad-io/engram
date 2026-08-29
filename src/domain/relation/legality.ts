import { KNOWLEDGE_OBJECT_TYPES } from "../entity/types.js";

export const RELATION_VERBS = [
  "derives_from",
  "supersedes",
  "references",
  "blocks",
  "requires",
  "invalidates",
  "explains",
  "implemented_by",
] as const;

export type RelationVerb = (typeof RELATION_VERBS)[number];

export const RELATION_TARGET_KINDS = ["knowledge_object", "external_reference"] as const;

export type RelationTargetKind = (typeof RELATION_TARGET_KINDS)[number];

export function isRelationTargetKind(value: unknown): value is RelationTargetKind {
  return (RELATION_TARGET_KINDS as readonly unknown[]).includes(value);
}

/** Sources in the MTS 7.3 cartesian product: the nine Knowledge Object types. */
export const SOURCE_TYPES = KNOWLEDGE_OBJECT_TYPES;
export type SourceType = (typeof SOURCE_TYPES)[number];

/** Targets: the nine Knowledge Object types plus External Reference. */
export const TARGET_TYPES = [...KNOWLEDGE_OBJECT_TYPES, "external_reference"] as const;
export type TargetType = (typeof TARGET_TYPES)[number];

export type LegalTriple = {
  readonly sourceType: SourceType;
  readonly relation: RelationVerb;
  readonly targetType: TargetType;
};

export type Relation = {
  readonly id: string;
  readonly sourceId: string;
  readonly relation: RelationVerb;
  readonly targetId: string;
  readonly targetKind: RelationTargetKind;
  readonly createdAt: Date;
  readonly validFromVersion: number;
  readonly validToVersion: number | null;
};

const REFERENCE_TARGETS = [
  "artifact",
  "external_reference",
  "discussion",
] as const satisfies readonly TargetType[];

const SPEC_TRIPLES: readonly LegalTriple[] = [
  { sourceType: "decision", relation: "derives_from", targetType: "requirement" },
  { sourceType: "decision", relation: "derives_from", targetType: "discussion" },
  { sourceType: "decision", relation: "derives_from", targetType: "observation" },
  { sourceType: "decision", relation: "derives_from", targetType: "open_question" },
  { sourceType: "decision", relation: "derives_from", targetType: "decision" },
  { sourceType: "requirement", relation: "derives_from", targetType: "requirement" },
  { sourceType: "requirement", relation: "derives_from", targetType: "discussion" },
  { sourceType: "requirement", relation: "derives_from", targetType: "artifact" },
  { sourceType: "constraint", relation: "derives_from", targetType: "decision" },
  { sourceType: "glossary_entry", relation: "derives_from", targetType: "decision" },
  { sourceType: "glossary_entry", relation: "derives_from", targetType: "artifact" },
  { sourceType: "hypothesis", relation: "derives_from", targetType: "discussion" },
  { sourceType: "hypothesis", relation: "derives_from", targetType: "observation" },
  { sourceType: "hypothesis", relation: "derives_from", targetType: "open_question" },
  { sourceType: "open_question", relation: "derives_from", targetType: "discussion" },
  { sourceType: "open_question", relation: "derives_from", targetType: "observation" },
  { sourceType: "open_question", relation: "derives_from", targetType: "requirement" },
  { sourceType: "decision", relation: "supersedes", targetType: "decision" },
  { sourceType: "requirement", relation: "supersedes", targetType: "requirement" },
  { sourceType: "constraint", relation: "supersedes", targetType: "constraint" },
  { sourceType: "glossary_entry", relation: "supersedes", targetType: "glossary_entry" },
  { sourceType: "artifact", relation: "supersedes", targetType: "artifact" },
  { sourceType: "open_question", relation: "blocks", targetType: "decision" },
  { sourceType: "open_question", relation: "blocks", targetType: "requirement" },
  { sourceType: "hypothesis", relation: "blocks", targetType: "decision" },
  { sourceType: "decision", relation: "requires", targetType: "decision" },
  { sourceType: "decision", relation: "requires", targetType: "constraint" },
  { sourceType: "requirement", relation: "requires", targetType: "requirement" },
  { sourceType: "hypothesis", relation: "invalidates", targetType: "decision" },
  { sourceType: "hypothesis", relation: "invalidates", targetType: "hypothesis" },
  { sourceType: "decision", relation: "invalidates", targetType: "constraint" },
  { sourceType: "decision", relation: "invalidates", targetType: "hypothesis" },
  { sourceType: "observation", relation: "invalidates", targetType: "decision" },
  { sourceType: "observation", relation: "invalidates", targetType: "constraint" },
  { sourceType: "constraint", relation: "invalidates", targetType: "constraint" },
  { sourceType: "decision", relation: "explains", targetType: "observation" },
  { sourceType: "hypothesis", relation: "explains", targetType: "observation" },
  { sourceType: "decision", relation: "implemented_by", targetType: "external_reference" },
  { sourceType: "requirement", relation: "implemented_by", targetType: "external_reference" },
];

/** Frozen MTS 7.3 table with "any knowledge object × references" expanded. */
export const LEGAL_TRIPLES: readonly LegalTriple[] = [
  ...SPEC_TRIPLES,
  ...KNOWLEDGE_OBJECT_TYPES.flatMap((sourceType) =>
    REFERENCE_TARGETS.map((targetType): LegalTriple => ({
      sourceType,
      relation: "references",
      targetType,
    })),
  ),
];

const LEGAL_KEYS = new Set(
  LEGAL_TRIPLES.map((triple) => keyOf(triple.sourceType, triple.relation, triple.targetType)),
);

export const ACYCLIC_RELATIONS: readonly RelationVerb[] = [
  "derives_from",
  "supersedes",
  "requires",
];

export const CYCLE_DEPTH_BOUND = 64;

function keyOf(sourceType: SourceType, relation: RelationVerb, targetType: TargetType): string {
  return `${sourceType}\0${relation}\0${targetType}`;
}

export function isLegal(
  sourceType: SourceType,
  relation: RelationVerb,
  targetType: TargetType,
): boolean {
  return LEGAL_KEYS.has(keyOf(sourceType, relation, targetType));
}

export function targetKindOf(targetType: TargetType): RelationTargetKind {
  if (targetType === "external_reference") {
    return "external_reference";
  }
  return "knowledge_object";
}

export function isOpen(relation: Relation): boolean {
  return relation.validToVersion === null;
}

export function wouldCreateCycle(
  existing: readonly Relation[],
  sourceId: string,
  targetId: string,
  relation: RelationVerb,
): boolean {
  if (!ACYCLIC_RELATIONS.includes(relation)) {
    return false;
  }
  if (sourceId === targetId) {
    return true;
  }
  const adjacency = new Map<string, string[]>();
  for (const edge of existing) {
    if (edge.relation !== relation || !isOpen(edge)) {
      continue;
    }
    const next = adjacency.get(edge.sourceId) ?? [];
    next.push(edge.targetId);
    adjacency.set(edge.sourceId, next);
  }
  const path = new Set<string>();
  const walk = (id: string, depth: number): boolean => {
    if (id === sourceId || depth >= CYCLE_DEPTH_BOUND) {
      return true;
    }
    if (path.has(id)) {
      return true;
    }
    path.add(id);
    for (const next of adjacency.get(id) ?? []) {
      if (walk(next, depth + 1)) {
        return true;
      }
    }
    path.delete(id);
    return false;
  };
  return walk(targetId, 0);
}
