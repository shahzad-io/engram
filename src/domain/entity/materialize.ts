import { knowledgeClassOf } from "./class.js";
import type {
  AuthoredBy,
  Constraint,
  Decision,
  Discussion,
  KnowledgeObject,
  KnowledgeObjectType,
} from "./types.js";

export type KnowledgeObjectMaterializationInput = {
  readonly id: string;
  readonly type: KnowledgeObjectType;
  readonly scopeId: string;
  readonly featureLabelIds?: readonly string[];
  readonly title: string;
  readonly body: string;
  readonly status: string;
  readonly attributes: Record<string, unknown>;
  readonly authoredBy: AuthoredBy;
  readonly sourceRef?: string | null;
  readonly supersedesId?: string | null;
  readonly supersededById?: string | null;
};

function recordValue(attributes: Record<string, unknown>, snake: string, camel: string): unknown {
  return attributes[camel] ?? attributes[snake];
}

function present(value: unknown): unknown | undefined {
  return value === undefined || value === null ? undefined : value;
}

function stringAttribute(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function booleanAttribute(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function dateAttribute(
  attributes: Record<string, unknown>,
  snake: string,
  camel: string,
): Date | undefined {
  const value = recordValue(attributes, snake, camel);
  if (value === undefined || value === null) return undefined;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function attribute<T>(key: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : { [key]: value };
}

function attributesFor(
  type: KnowledgeObjectType,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  switch (type) {
    case "requirement":
      return {
        ...attribute("source", stringAttribute(raw.source)),
        ...attribute("rationale", stringAttribute(raw.rationale)),
      };
    case "discussion":
      return {
        ...attribute(
          "medium",
          present(raw.medium) as Discussion["attributes"]["medium"] | undefined,
        ),
        ...attribute("occurredAt", dateAttribute(raw, "occurred_at", "occurredAt")),
        ...attribute("contentRef", present(recordValue(raw, "content_ref", "contentRef"))),
        ...(Array.isArray(raw.participants) &&
        raw.participants.every((participant) => typeof participant === "string")
          ? { participants: raw.participants }
          : {}),
      };
    case "observation":
      return {
        ...attribute("observedAt", dateAttribute(raw, "observed_at", "observedAt")),
        ...attribute(
          "evidenceRef",
          stringAttribute(recordValue(raw, "evidence_ref", "evidenceRef")),
        ),
        ...attribute("reviewBy", dateAttribute(raw, "review_by", "reviewBy")),
      };
    case "hypothesis":
      return {
        ...attribute(
          "whatWasTried",
          stringAttribute(recordValue(raw, "what_was_tried", "whatWasTried")),
        ),
        ...attribute(
          "whyItFailed",
          stringAttribute(recordValue(raw, "why_it_failed", "whyItFailed")),
        ),
        ...attribute(
          "evidenceRef",
          stringAttribute(recordValue(raw, "evidence_ref", "evidenceRef")),
        ),
        ...attribute(
          "wouldReconsiderIf",
          stringAttribute(recordValue(raw, "would_reconsider_if", "wouldReconsiderIf")),
        ),
      };
    case "decision":
      return {
        ...attribute("statement", stringAttribute(raw.statement)),
        ...attribute("rationale", stringAttribute(raw.rationale)),
        ...attribute(
          "reversibility",
          present(raw.reversibility) as Decision["attributes"]["reversibility"] | undefined,
        ),
        ...attribute(
          "alternativesRejected",
          Array.isArray(recordValue(raw, "alternatives_rejected", "alternativesRejected"))
            ? (recordValue(
                raw,
                "alternatives_rejected",
                "alternativesRejected",
              ) as Decision["attributes"]["alternativesRejected"])
            : undefined,
        ),
        ...(raw.origin === "unrecoverable" ? { origin: "unrecoverable" as const } : {}),
      };
    case "open_question":
      return {
        ...attribute("question", stringAttribute(raw.question)),
        ...attribute("blocking", booleanAttribute(raw.blocking)),
        ...attribute("owner", stringAttribute(raw.owner)),
      };
    case "constraint":
      return {
        ...attribute("rule", stringAttribute(raw.rule)),
        ...attribute(
          "enforcement",
          present(raw.enforcement) as Constraint["attributes"]["enforcement"] | undefined,
        ),
        ...attribute("axiomatic", booleanAttribute(raw.axiomatic)),
      };
    case "glossary_entry":
      return {
        ...attribute("term", stringAttribute(raw.term)),
        ...attribute("definition", stringAttribute(raw.definition)),
        ...attribute("axiomatic", booleanAttribute(raw.axiomatic)),
        ...(Array.isArray(raw.aliases) && raw.aliases.every((alias) => typeof alias === "string")
          ? { aliases: raw.aliases }
          : {}),
      };
    case "artifact":
      return {
        ...attribute("kind", stringAttribute(raw.kind)),
        ...attribute("version", stringAttribute(raw.version)),
        ...attribute("location", stringAttribute(raw.location)),
        ...attribute(
          "contentHash",
          stringAttribute(recordValue(raw, "content_hash", "contentHash")),
        ),
        ...attribute("summary", stringAttribute(raw.summary)),
      };
  }
}

export function materializeKnowledgeObject(
  write: KnowledgeObjectMaterializationInput,
  version: number,
  now: Date,
): KnowledgeObject {
  const knowledgeClass = knowledgeClassOf(write.type);
  const raw = knowledgeClass === "raw";
  return {
    id: write.id,
    type: write.type,
    knowledgeClass,
    scopeId: write.scopeId,
    featureLabelIds: write.featureLabelIds ?? [],
    title: write.title,
    body: write.body,
    status: write.status as KnowledgeObject["status"],
    attributes: attributesFor(write.type, write.attributes),
    authoredBy: write.authoredBy,
    sourceRef: write.sourceRef ?? null,
    createdAt: now,
    approvedAt: raw ? null : now,
    lastVerifiedAt: raw ? null : now,
    supersedesId: write.supersedesId ?? null,
    supersededById: write.supersededById ?? null,
    reviewRequired: false,
    validFromVersion: version,
    validToVersion: null,
    lockVersion: 0,
  } as KnowledgeObject;
}
