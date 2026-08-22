import { knowledgeClassOf } from "../../domain/entity/class.js";
import type {
  Artifact,
  Constraint,
  Decision,
  Discussion,
  GlossaryEntry,
  Hypothesis,
  KnowledgeObject,
  KnowledgeObjectType,
  Observation,
  OpenQuestion,
  Requirement,
} from "../../domain/entity/types.js";
import type { KnowledgeObjectWrite } from "./types.js";

function recordValue(
  attributes: Record<string, unknown>,
  snake: string,
  camel: string,
): unknown {
  return attributes[camel] ?? attributes[snake];
}

function dateAttribute(attributes: Record<string, unknown>, snake: string, camel: string): Date {
  const value = recordValue(attributes, snake, camel);
  return value instanceof Date ? value : new Date(String(value));
}

function attributesFor(
  type: KnowledgeObjectType,
  raw: Record<string, unknown>,
): KnowledgeObject["attributes"] {
  switch (type) {
    case "requirement":
      return {
        source: String(raw.source),
        rationale: String(raw.rationale),
      } satisfies Requirement["attributes"];
    case "discussion":
      return {
        medium: raw.medium as Discussion["attributes"]["medium"],
        occurredAt: dateAttribute(raw, "occurred_at", "occurredAt"),
        contentRef: recordValue(raw, "content_ref", "contentRef"),
        ...(Array.isArray(raw.participants) ? { participants: raw.participants.map(String) } : {}),
      } satisfies Discussion["attributes"];
    case "observation":
      return {
        observedAt: dateAttribute(raw, "observed_at", "observedAt"),
        evidenceRef: String(recordValue(raw, "evidence_ref", "evidenceRef")),
        reviewBy: dateAttribute(raw, "review_by", "reviewBy"),
      } satisfies Observation["attributes"];
    case "hypothesis":
      return {
        whatWasTried: String(recordValue(raw, "what_was_tried", "whatWasTried")),
        whyItFailed: String(recordValue(raw, "why_it_failed", "whyItFailed")),
        evidenceRef: String(recordValue(raw, "evidence_ref", "evidenceRef")),
        ...(recordValue(raw, "would_reconsider_if", "wouldReconsiderIf") !== undefined
          ? {
              wouldReconsiderIf: String(
                recordValue(raw, "would_reconsider_if", "wouldReconsiderIf"),
              ),
            }
          : {}),
      } satisfies Hypothesis["attributes"];
    case "decision":
      return {
        statement: String(raw.statement),
        rationale: String(raw.rationale),
        reversibility: raw.reversibility as Decision["attributes"]["reversibility"],
        alternativesRejected: Array.isArray(
          recordValue(raw, "alternatives_rejected", "alternativesRejected"),
        )
          ? (recordValue(
              raw,
              "alternatives_rejected",
              "alternativesRejected",
            ) as Decision["attributes"]["alternativesRejected"])
          : [],
        ...(raw.origin === "unrecoverable" ? { origin: "unrecoverable" as const } : {}),
      } satisfies Decision["attributes"];
    case "open_question":
      return {
        question: String(raw.question),
        blocking: Boolean(raw.blocking),
        ...(raw.owner !== undefined ? { owner: String(raw.owner) } : {}),
      } satisfies OpenQuestion["attributes"];
    case "constraint":
      return {
        rule: String(raw.rule),
        enforcement: raw.enforcement as Constraint["attributes"]["enforcement"],
        axiomatic: Boolean(raw.axiomatic),
      } satisfies Constraint["attributes"];
    case "glossary_entry":
      return {
        term: String(raw.term),
        definition: String(raw.definition),
        axiomatic: Boolean(raw.axiomatic),
        ...(Array.isArray(raw.aliases) ? { aliases: raw.aliases.map(String) } : {}),
      } satisfies GlossaryEntry["attributes"];
    case "artifact":
      return {
        kind: String(raw.kind),
        version: String(raw.version),
        location: String(raw.location),
        contentHash: String(recordValue(raw, "content_hash", "contentHash")),
        summary: String(raw.summary),
      } satisfies Artifact["attributes"];
  }
}

export function materializeProposalObject(
  write: KnowledgeObjectWrite,
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
