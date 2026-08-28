import type { KnowledgeObject } from "./types.js";

export function projectKnowledgeAttributesForStorage(
  object: KnowledgeObject,
): Record<string, unknown> {
  switch (object.type) {
    case "requirement":
      return {
        source: object.attributes.source,
        rationale: object.attributes.rationale,
      };
    case "discussion":
      return {
        medium: object.attributes.medium,
        occurred_at: object.attributes.occurredAt.toISOString(),
        content_ref: object.attributes.contentRef,
        ...(object.attributes.participants === undefined
          ? {}
          : { participants: object.attributes.participants }),
      };
    case "observation":
      return {
        observed_at: object.attributes.observedAt.toISOString(),
        evidence_ref: object.attributes.evidenceRef,
        review_by: object.attributes.reviewBy.toISOString(),
      };
    case "hypothesis":
      return {
        what_was_tried: object.attributes.whatWasTried,
        why_it_failed: object.attributes.whyItFailed,
        evidence_ref: object.attributes.evidenceRef,
        ...(object.attributes.wouldReconsiderIf === undefined
          ? {}
          : { would_reconsider_if: object.attributes.wouldReconsiderIf }),
      };
    case "decision":
      return {
        statement: object.attributes.statement,
        rationale: object.attributes.rationale,
        reversibility: object.attributes.reversibility,
        alternatives_rejected: object.attributes.alternativesRejected,
        ...(object.attributes.origin === undefined ? {} : { origin: object.attributes.origin }),
      };
    case "open_question":
      return {
        question: object.attributes.question,
        blocking: object.attributes.blocking,
        ...(object.attributes.owner === undefined ? {} : { owner: object.attributes.owner }),
      };
    case "constraint":
      return {
        rule: object.attributes.rule,
        enforcement: object.attributes.enforcement,
        axiomatic: object.attributes.axiomatic,
      };
    case "glossary_entry":
      return {
        term: object.attributes.term,
        definition: object.attributes.definition,
        axiomatic: object.attributes.axiomatic,
        ...(object.attributes.aliases === undefined ? {} : { aliases: object.attributes.aliases }),
      };
    case "artifact":
      return {
        kind: object.attributes.kind,
        version: object.attributes.version,
        location: object.attributes.location,
        content_hash: object.attributes.contentHash,
        summary: object.attributes.summary,
      };
  }
}
