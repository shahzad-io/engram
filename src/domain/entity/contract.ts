import { KNOWLEDGE_OBJECT_TYPES, type KnowledgeObject, type KnowledgeObjectType } from "./types.js";

/**
 * The single source of truth for the per-type object contract: initial status,
 * status lifecycle, and required/optional attributes with their value kinds.
 *
 * The same contract used to be written out seven times (invariant checking,
 * materialisation, storage projection, the backfill spec, two database CHECK
 * constraints, and the MCP tool description). Consumers that can be derived
 * from this table are derived; the ones that cannot — the materialiser and the
 * storage projection, which carry compile-time attribute types, and the two
 * database constraints — are pinned by tests/type-contract.test.ts.
 */

export type AttributeValueKind =
  | { readonly kind: "string"; readonly maxLength?: number }
  | { readonly kind: "date" }
  | { readonly kind: "boolean" }
  | { readonly kind: "enum"; readonly values: readonly string[] }
  | { readonly kind: "string_array" }
  | { readonly kind: "rejected_alternative_array" }
  | { readonly kind: "json" };

export type AttributeContract = {
  /** Canonical storage spelling; the key used by the database CHECK. */
  readonly snake: string;
  /** Accepted alias on write; the key emitted by the materialiser. */
  readonly camel: string;
  readonly required: boolean;
  readonly value: AttributeValueKind;
  /**
   * Backfill-only markers are never part of a type's required or optional
   * attribute sets and never appear in a generated skeleton, but they must
   * still survive input parsing so the domain layer can reject them loudly.
   */
  readonly backfillOnly?: true;
  readonly description: string;
};

export type KnowledgeTypeContract = {
  readonly idPrefix: string;
  readonly initialStatus: KnowledgeObject["status"];
  readonly statuses: readonly KnowledgeObject["status"][];
  readonly attributes: readonly AttributeContract[];
};

/**
 * Domain Spec A-BF-1. Accepted by the parser on every type so that the write
 * paths can reject it with BACKFILL_ORIGIN_FORBIDDEN or INVALID_ORIGIN_MARKER
 * rather than silently discarding it.
 */
const ORIGIN_MARKER: AttributeContract = {
  snake: "origin",
  camel: "origin",
  required: false,
  value: { kind: "json" },
  backfillOnly: true,
  description: "Backfill-only origin marker. Rejected on live write paths.",
};

function attribute(
  snake: string,
  camel: string,
  required: boolean,
  value: AttributeValueKind,
  description: string,
): AttributeContract {
  return { snake, camel, required, value, description };
}

export const KNOWLEDGE_TYPE_CONTRACTS = {
  requirement: {
    idPrefix: "REQ",
    initialStatus: "active",
    statuses: ["active", "superseded", "withdrawn", "retracted"],
    attributes: [
      attribute("source", "source", true, { kind: "string" }, "Who or what required this."),
      attribute("rationale", "rationale", true, { kind: "string" }, "Why it is required."),
      ORIGIN_MARKER,
    ],
  },
  discussion: {
    idPrefix: "DSC",
    initialStatus: "recorded",
    statuses: ["recorded", "distilled", "archived", "retracted"],
    attributes: [
      attribute(
        "medium",
        "medium",
        true,
        { kind: "enum", values: ["chat", "meeting", "async", "investigation"] },
        "Where the conversation happened.",
      ),
      attribute("occurred_at", "occurredAt", true, { kind: "date" }, "ISO 8601 timestamp."),
      attribute(
        "content_ref",
        "contentRef",
        true,
        { kind: "json" },
        "Pointer to the transcript. Never the transcript body itself.",
      ),
      attribute(
        "participants",
        "participants",
        false,
        { kind: "string_array" },
        "Optional participant names.",
      ),
      ORIGIN_MARKER,
    ],
  },
  observation: {
    idPrefix: "OBS",
    initialStatus: "observed",
    statuses: [
      "observed",
      "promoted_to_question",
      "promoted_to_hypothesis",
      "absorbed",
      "stale",
      "retracted",
    ],
    attributes: [
      attribute("observed_at", "observedAt", true, { kind: "date" }, "ISO 8601 timestamp."),
      attribute("evidence_ref", "evidenceRef", true, { kind: "string" }, "Evidence pointer."),
      attribute(
        "review_by",
        "reviewBy",
        true,
        { kind: "date" },
        "Expiry date for this observation.",
      ),
      ORIGIN_MARKER,
    ],
  },
  hypothesis: {
    idPrefix: "HYP",
    initialStatus: "explored",
    statuses: ["explored", "rejected", "revived", "retracted"],
    attributes: [
      attribute(
        "what_was_tried",
        "whatWasTried",
        true,
        { kind: "string" },
        "What was actually built, run, or tested.",
      ),
      attribute("why_it_failed", "whyItFailed", true, { kind: "string" }, "Why it did not work."),
      attribute("evidence_ref", "evidenceRef", true, { kind: "string" }, "Evidence pointer."),
      attribute(
        "would_reconsider_if",
        "wouldReconsiderIf",
        false,
        { kind: "string" },
        "What would justify trying it again.",
      ),
      ORIGIN_MARKER,
    ],
  },
  decision: {
    idPrefix: "DEC",
    initialStatus: "active",
    statuses: ["active", "superseded", "reverted", "retracted"],
    attributes: [
      attribute("statement", "statement", true, { kind: "string" }, "What was decided."),
      attribute("rationale", "rationale", true, { kind: "string" }, "Why it was decided."),
      attribute(
        "reversibility",
        "reversibility",
        true,
        { kind: "enum", values: ["cheap", "costly", "one_way"] },
        "How costly this decision is to undo.",
      ),
      attribute(
        "alternatives_rejected",
        "alternativesRejected",
        true,
        { kind: "rejected_alternative_array" },
        "Alternatives considered and rejected, as {alternative, reason}. Use [] when none.",
      ),
      ORIGIN_MARKER,
    ],
  },
  open_question: {
    idPrefix: "OQU",
    initialStatus: "open",
    statuses: ["open", "resolved", "obsolete", "retracted"],
    attributes: [
      // The 280-character cap applies only when blocking is true, so it is
      // enforced in the domain layer rather than declared here.
      attribute("question", "question", true, { kind: "string" }, "The unresolved question."),
      attribute(
        "blocking",
        "blocking",
        true,
        { kind: "boolean" },
        "Whether this question blocks work. Blocking questions enter every pack in scope.",
      ),
      attribute("owner", "owner", false, { kind: "string" }, "Who owns resolving it."),
      ORIGIN_MARKER,
    ],
  },
  constraint: {
    idPrefix: "CON",
    initialStatus: "active",
    statuses: ["active", "superseded", "lifted", "retracted"],
    attributes: [
      attribute(
        "rule",
        "rule",
        true,
        { kind: "string", maxLength: 280 },
        "The rule that always applies, at most 280 characters.",
      ),
      attribute(
        "enforcement",
        "enforcement",
        true,
        { kind: "enum", values: ["hard", "soft"] },
        "How strictly the rule is enforced.",
      ),
      attribute(
        "axiomatic",
        "axiomatic",
        true,
        { kind: "boolean" },
        "True when the rule stands alone. A non-axiomatic constraint needs a derives_from relation to a Decision.",
      ),
      ORIGIN_MARKER,
    ],
  },
  glossary_entry: {
    idPrefix: "GLO",
    initialStatus: "active",
    statuses: ["active", "superseded", "deprecated", "retracted"],
    attributes: [
      attribute("term", "term", true, { kind: "string" }, "The term being defined."),
      attribute(
        "definition",
        "definition",
        true,
        { kind: "string", maxLength: 200 },
        "The project meaning, at most 200 characters.",
      ),
      attribute(
        "axiomatic",
        "axiomatic",
        true,
        { kind: "boolean" },
        "True when the term stands alone.",
      ),
      attribute(
        "aliases",
        "aliases",
        false,
        { kind: "string_array" },
        "Other spellings of the term.",
      ),
      ORIGIN_MARKER,
    ],
  },
  artifact: {
    idPrefix: "ART",
    initialStatus: "current",
    statuses: ["current", "superseded", "retracted"],
    attributes: [
      attribute(
        "kind",
        "kind",
        true,
        { kind: "string" },
        "Artifact kind, for example architecture.",
      ),
      attribute(
        "version",
        "version",
        true,
        { kind: "string" },
        "Version label of the pointed-to document.",
      ),
      attribute("location", "location", true, { kind: "string" }, "Where the document lives."),
      attribute(
        "content_hash",
        "contentHash",
        true,
        { kind: "string" },
        "Hash of the pointed-to content.",
      ),
      attribute(
        "summary",
        "summary",
        true,
        { kind: "string", maxLength: 500 },
        "Summary authored at approval, at most 500 characters. Never regenerated.",
      ),
      ORIGIN_MARKER,
    ],
  },
} as const satisfies Readonly<Record<KnowledgeObjectType, KnowledgeTypeContract>>;

export function contractFor(type: KnowledgeObjectType): KnowledgeTypeContract {
  return KNOWLEDGE_TYPE_CONTRACTS[type];
}

/**
 * Identity format, mirroring the knowledge_objects_id_prefix CHECK. The
 * sequence is per prefix and the database accepts four digits or more; ids are
 * padded to ID_SEQUENCE_DIGITS when this engine allocates them.
 */
export const ID_SEQUENCE_DIGITS = 4;
export const ID_SEQUENCE_PATTERN = `[0-9]{${ID_SEQUENCE_DIGITS},}`;

export function idPatternSourceFor(type: KnowledgeObjectType): string {
  return `^${contractFor(type).idPrefix}-${ID_SEQUENCE_PATTERN}$`;
}

export function idPatternFor(type: KnowledgeObjectType): RegExp {
  return new RegExp(idPatternSourceFor(type), "u");
}

export function formatKnowledgeObjectId(type: KnowledgeObjectType, sequence: number): string {
  const digits = String(sequence).padStart(ID_SEQUENCE_DIGITS, "0");
  return `${contractFor(type).idPrefix}-${digits}`;
}

/** Attributes a caller may supply. Excludes backfill-only markers. */
export function writableAttributes(type: KnowledgeObjectType): readonly AttributeContract[] {
  return contractFor(type).attributes.filter((entry) => entry.backfillOnly !== true);
}

export function requiredAttributes(type: KnowledgeObjectType): readonly AttributeContract[] {
  return writableAttributes(type).filter((entry) => entry.required);
}

export function optionalAttributes(type: KnowledgeObjectType): readonly AttributeContract[] {
  return writableAttributes(type).filter((entry) => !entry.required);
}

/** Required keys in the spelling the materialiser emits and the invariants check. */
export function requiredCamelKeys(type: KnowledgeObjectType): readonly string[] {
  return requiredAttributes(type).map((entry) => entry.camel);
}

/** Required keys in the spelling the database CHECK enforces. */
export function requiredSnakeKeys(type: KnowledgeObjectType): readonly string[] {
  return requiredAttributes(type).map((entry) => entry.snake);
}

export function initialStatusOf(type: KnowledgeObjectType): KnowledgeObject["status"] {
  return contractFor(type).initialStatus;
}

export const INITIAL_STATUS_BY_TYPE = Object.fromEntries(
  KNOWLEDGE_OBJECT_TYPES.map((type) => [type, initialStatusOf(type)]),
) as Readonly<Record<KnowledgeObjectType, KnowledgeObject["status"]>>;

function skeletonValue(value: AttributeValueKind): string | boolean | readonly unknown[] {
  switch (value.kind) {
    case "boolean":
      return false;
    case "string_array":
    case "rejected_alternative_array":
      return [];
    default:
      return "";
  }
}

/** Blank required attributes for a hand-authored backfill object file. */
export function skeletonAttributesFor(
  type: KnowledgeObjectType,
): Readonly<Record<string, string | boolean | readonly unknown[]>> {
  return Object.fromEntries(
    requiredAttributes(type).map((entry) => [entry.snake, skeletonValue(entry.value)]),
  );
}
