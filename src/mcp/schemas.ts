import * as z from "zod/v4";
import {
  contractFor,
  requiredAttributes,
  type AttributeValueKind,
} from "../domain/entity/contract.js";
import { KNOWLEDGE_OBJECT_TYPES, type KnowledgeObjectType } from "../domain/entity/types.js";
import { RELATION_VERBS } from "../domain/relation/legality.js";
import { VALID_INTENT_INPUTS } from "./validation.js";

const featureInput = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .describe("Optional feature label name or id. Omit to include all features in scope.");

const sessionIdInput = z
  .string()
  .min(1)
  .optional()
  .describe(
    "Optional client-supplied work-session identifier. The engine records a missing identifier as an unknown session.",
  );

export const contextBuildInputSchema = {
  session_id: sessionIdInput,
  scope: z
    .string()
    .min(1)
    .describe(
      "Scope id for the knowledge to retrieve. Call graph.expand with list_scopes=true first if you do not know valid ids.",
    ),
  feature: featureInput,
  intent: z
    .enum(VALID_INTENT_INPUTS)
    .describe(
      "What you are trying to do: implementation, review, debug, architecture, onboarding, planning, or investigation (alias for debug).",
    ),
  budget: z
    .number()
    .int()
    .positive()
    .describe(
      "Maximum estimated tokens for the response body. Use at least 2000 for substantive work.",
    ),
};

export const graphExpandInputSchema = {
  session_id: sessionIdInput,
  list_scopes: z
    .boolean()
    .optional()
    .describe(
      "When true, return the scope tree (ids, kinds, names, parents) instead of retrieving objects. Use this before context.build if you do not know scope ids.",
    ),
  scope: z
    .string()
    .min(1)
    .optional()
    .describe("Limit results to objects under this scope id and its ancestors."),
  feature: featureInput,
  text: z
    .string()
    .min(1)
    .optional()
    .describe("Keyword search over titles and bodies when no seed_object_id is supplied."),
  seed_object_id: z
    .string()
    .min(1)
    .optional()
    .describe("Knowledge object id to traverse from (for example DEC-0001)."),
  relation: z
    .enum(RELATION_VERBS)
    .optional()
    .describe("Relation verb to follow from the seed object."),
  direction: z
    .enum(["outgoing", "incoming", "both"])
    .optional()
    .describe("Traversal direction from the seed object. Defaults to both."),
  types: z
    .array(z.enum(KNOWLEDGE_OBJECT_TYPES))
    .optional()
    .describe("Restrict results to these knowledge object types."),
  classes: z
    .array(z.enum(["raw", "reviewed", "operational"]))
    .optional()
    .describe("Restrict results to these knowledge classes."),
  statuses: z.array(z.string().min(1)).optional().describe("Restrict results to these statuses."),
  follow_supersession: z
    .boolean()
    .optional()
    .describe("When true, follow supersession chains during traversal."),
};

/**
 * Every branch below is generated from KNOWLEDGE_TYPE_CONTRACTS so the wire
 * schema cannot drift from what the domain layer enforces. Attribute keys are
 * accepted in either snake_case or camelCase; where the two spellings differ,
 * both keys are declared optional and a presence check requires one of them,
 * because declaring only one as required would reject payloads this server has
 * always accepted.
 */

function attributeValueSchema(value: AttributeValueKind): z.ZodType {
  switch (value.kind) {
    case "string":
      return value.maxLength === undefined ? z.string() : z.string().max(value.maxLength);
    case "date":
      return z
        .string()
        .min(1)
        .refine(
          (candidate) => !Number.isNaN(new Date(candidate).getTime()),
          "must be an ISO 8601 timestamp",
        );
    case "boolean":
      return z.boolean();
    case "enum":
      return z.enum([...value.values] as [string, ...string[]]);
    case "string_array":
      return z.array(z.string());
    case "rejected_alternative_array":
      return z.array(z.looseObject({ alternative: z.string(), reason: z.string() }));
    case "json":
      return z.unknown();
  }
}

type KeyAlias = { readonly snake: string; readonly camel: string };

/**
 * Copies an accepted camelCase alias onto its canonical snake_case key before
 * validation, so the canonical key can be declared required. Declaring both
 * spellings optional and requiring one of them in a refinement would be
 * equivalent for a valid payload, but Zod skips refinements once any sibling
 * field has failed, which is precisely the one-error-per-round-trip behaviour
 * this schema exists to remove. camelCase wins when both are present, matching
 * the materialiser.
 */
function normaliseAliases(aliases: readonly KeyAlias[]): (value: unknown) => unknown {
  return (value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return value;
    }
    const record = value as Record<string, unknown>;
    let next = record;
    for (const { snake, camel } of aliases) {
      if (record[camel] === undefined) continue;
      if (next === record) next = { ...record };
      next[snake] = record[camel];
    }
    return next;
  };
}

function attributesSchemaFor(type: KnowledgeObjectType) {
  const shape: Record<string, z.ZodType> = {};
  const aliases: KeyAlias[] = [];
  for (const entry of contractFor(type).attributes) {
    if (entry.backfillOnly === true) {
      shape[entry.snake] = z.unknown().optional();
      continue;
    }
    const schema = attributeValueSchema(entry.value).describe(entry.description);
    shape[entry.snake] = entry.required ? schema : schema.optional();
    if (entry.snake !== entry.camel) {
      shape[entry.camel] = schema.optional().describe(`Alias for ${entry.snake}.`);
      aliases.push({ snake: entry.snake, camel: entry.camel });
    }
  }
  const required = requiredAttributes(type)
    .map((entry) => entry.snake)
    .join(", ");
  const object = z
    .object(shape)
    .describe(
      `Attributes for ${type}. Required: ${required}. Keys accept snake_case or camelCase.`,
    );
  return aliases.length === 0 ? object : z.preprocess(normaliseAliases(aliases), object);
}

const ENVELOPE_ALIASES: readonly KeyAlias[] = [
  { snake: "scope_id", camel: "scopeId" },
  { snake: "local_id", camel: "localId" },
];

/**
 * No object in this payload carries a graph id. Engram allocates the
 * discussion's immediately and a proposed object's only if a curator accepts
 * it, so the caller names each one with a handle that has meaning inside this
 * payload alone. A handle shaped like a graph id is refused: relation endpoints
 * are resolved against handles first, and one that looked like GLO-0007 would
 * silently shadow the object of that name.
 */
const GRAPH_ID_SHAPE = /^[A-Z]{3}-[0-9]{4,}$/u;

function localIdSchema(type: KnowledgeObjectType, required: boolean): z.ZodType {
  const base = z
    .string()
    .min(1)
    .refine(
      (value) => !GRAPH_ID_SHAPE.test(value),
      "must not look like a graph id; Engram assigns those",
    );
  return required ? base : base.optional();
}

function identityShape(
  type: KnowledgeObjectType,
  localIdRequired: boolean,
): Record<string, z.ZodType> {
  const defaulted = localIdRequired ? "" : ` Defaults to "${type}".`;
  return {
    id: z
      .never({
        error: `Engram assigns the ${type} id. Reference this object from relations with local_id instead.`,
      })
      .optional()
      .describe(
        `Not accepted. Engram allocates the ${type} id; use local_id to reference this object from relations.`,
      ),
    local_id: localIdSchema(type, localIdRequired).describe(
      `Handle for this ${type} inside this payload only, used as a relation source_id or target_id.${defaulted} It is not a graph id and never becomes one.`,
    ),
    localId: localIdSchema(type, false).describe("Alias for local_id."),
  };
}

function knowledgeObjectBranch(type: KnowledgeObjectType, localIdRequired: boolean) {
  const contract = contractFor(type);
  return z.object({
    ...identityShape(type, localIdRequired),
    type: z.literal(type),
    scope_id: z
      .string()
      .min(1)
      .describe("Scope this object is true in, not where it was discovered."),
    scopeId: z.string().min(1).optional().describe("Alias for scope_id."),
    feature_labels: z.union([z.string(), z.array(z.string())]).optional(),
    featureLabelIds: z.union([z.string(), z.array(z.string())]).optional(),
    title: z.string(),
    body: z.string(),
    status: z
      .literal(contract.initialStatus)
      .describe(`New ${type} objects are filed in status ${contract.initialStatus}.`),
    attributes: attributesSchemaFor(type),
    authored_by: z.enum(["human", "ai"]).optional(),
    authoredBy: z.enum(["human", "ai"]).optional(),
    source_ref: z.string().nullable().optional(),
    sourceRef: z.string().nullable().optional(),
    supersedes_id: z.string().nullable().optional(),
    supersedesId: z.string().nullable().optional(),
    superseded_by_id: z.string().nullable().optional(),
    supersededById: z.string().nullable().optional(),
  });
}

/** Discussion and Observation are Raw evidence and cannot be proposed as candidates. */
const PROPOSABLE_TYPES = KNOWLEDGE_OBJECT_TYPES.filter(
  (type) => type !== "discussion" && type !== "observation",
);

// Envelope alias normalisation wraps the branches rather than sitting inside
// them, so the discriminated union still reads `type` off a plain object.
// `.nonoptional()` keeps the field in the advertised `required` list: a
// preprocess wrapper accepts unknown input, which the JSON Schema conversion
// would otherwise read as an optional argument.
const discussionWriteSchema = z
  .preprocess(normaliseAliases(ENVELOPE_ALIASES), knowledgeObjectBranch("discussion", false))
  .nonoptional()
  .describe("Raw discussion record for the conversation being resolved.");

type KnowledgeObjectBranch = ReturnType<typeof knowledgeObjectBranch>;

const proposalBranches = PROPOSABLE_TYPES.map((type) => knowledgeObjectBranch(type, true)) as [
  KnowledgeObjectBranch,
  ...KnowledgeObjectBranch[],
];

const proposalObjectSchema = z
  .preprocess(normaliseAliases(ENVELOPE_ALIASES), z.discriminatedUnion("type", proposalBranches))
  .describe(
    "Proposed knowledge object envelope plus type-specific attributes. Discussion and observation objects cannot be proposed here.",
  );

const relationWriteSchema = z.object({
  source_id: z.string().min(1).optional(),
  sourceId: z.string().min(1).optional(),
  relation: z.enum(RELATION_VERBS),
  target_id: z.string().min(1).optional(),
  targetId: z.string().min(1).optional(),
  target_kind: z.enum(["knowledge_object", "external_reference"]).optional(),
  targetKind: z.enum(["knowledge_object", "external_reference"]).optional(),
});

export const discussionResolveInputSchema = {
  session_id: sessionIdInput,
  discussion: discussionWriteSchema,
  proposal: z
    .object({
      objects: z.array(proposalObjectSchema).min(1),
      relations: z.array(relationWriteSchema).optional(),
    })
    .describe(
      "Agent-authored structured proposal: proposed decisions, constraints, glossary entries, and their relations.",
    ),
};

export const artifactGetInputSchema = {
  session_id: sessionIdInput,
  id: z.string().min(1).describe("Artifact knowledge object id (for example ART-0001)."),
};

export const TOOL_DESCRIPTIONS = {
  "context.build":
    "Retrieve why this project is built the way it is: past decisions and their reasoning, constraints that still apply, approaches already tried and rejected, and unresolved questions. Use this before answering any 'why' question about the project, before proposing architecture, or when you need the project's recorded engineering context rather than guessing. Requires scope (use graph.expand with list_scopes=true to discover ids), intent, and a token budget.",
  "graph.expand":
    "Explore the knowledge graph: list available scopes, find objects by keyword, or walk relations from a known object id. Use list_scopes=true first when you need a valid scope id for context.build. Use keyword or metadata search when you know what you are looking for but not which object id to start from.",
  "discussion.resolve": [
    "File a structured proposal distilled from a conversation for human triage. The server validates your proposal and stores it as a pending candidate; it does not generate or approve knowledge. Use after you have already written the decision, constraints, and relations yourself.",
    "",
    'Do not supply ids. Engram owns identity: it allocates the discussion id immediately and returns it as discussion_id, and allocates a proposed object\'s id only if a curator accepts it. Give every object a local_id — a handle used only inside this payload, defaulting to "discussion" for the discussion — and write relations against those handles.',
    "",
    "Every object needs scope_id (required, despite being optional in the schema), title, body, status, and attributes. Attribute keys accept snake_case or camelCase. Each object must use its type's initial status and carry all of that type's required attributes:",
    '- discussion (the conversation being resolved; status "recorded"): medium (chat | meeting | async | investigation), occurred_at (ISO 8601), content_ref',
    '- decision (status "active"): statement, rationale, reversibility (cheap | costly | one_way), alternatives_rejected (array of {alternative, reason}; [] when none)',
    '- constraint (status "active"): rule (max 280 chars), enforcement (hard | soft), axiomatic (boolean)',
    '- glossary_entry (status "active"): term, definition (max 200 chars), axiomatic (boolean)',
    '- hypothesis (status "explored"): what_was_tried, why_it_failed, evidence_ref. Only for approaches actually built, run, or tested; an alternative rejected in deliberation belongs in the decision\'s alternatives_rejected.',
    '- open_question (status "open"): question, blocking (boolean)',
    "",
    "relations is optional in the schema but required in practice. Every decision must have a derives_from relation, normally to this discussion, or it is rejected with DECISION_ORIGIN_REQUIRED. Every constraint with axiomatic false must have a derives_from relation to a decision in the same submission. Discussion and observation objects cannot be proposed in proposal.objects; the resolved discussion goes in the discussion argument.",
  ].join("\n"),
  "artifact.get":
    "Fetch the stored summary, version label, and document location for an approved artifact pointer (for example an ADR or design doc reference). Use when you need where to read the authoritative external document, not the full document body.",
} as const;

export type ContextBuildInput = z.infer<z.ZodObject<typeof contextBuildInputSchema, z.core.$strip>>;
export type GraphExpandInput = z.infer<z.ZodObject<typeof graphExpandInputSchema, z.core.$strip>>;
export type DiscussionResolveInput = z.infer<
  z.ZodObject<typeof discussionResolveInputSchema, z.core.$strip>
>;
export type ArtifactGetInput = z.infer<z.ZodObject<typeof artifactGetInputSchema, z.core.$strip>>;

export function dottedToUnderscore(name: string): string {
  return name.replaceAll(".", "_");
}
