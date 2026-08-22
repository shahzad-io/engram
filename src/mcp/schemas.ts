import * as z from "zod/v4";
import { KNOWLEDGE_OBJECT_TYPES } from "../domain/entity/types.js";
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
    .describe("Maximum estimated tokens for the response body. Use at least 2000 for substantive work."),
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

const jsonObject = z.record(z.string(), z.unknown());

const knowledgeObjectWriteSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(KNOWLEDGE_OBJECT_TYPES),
    scope_id: z.string().min(1).optional(),
    scopeId: z.string().min(1).optional(),
    feature_labels: z.union([z.string(), z.array(z.string())]).optional(),
    featureLabelIds: z.union([z.string(), z.array(z.string())]).optional(),
    title: z.string(),
    body: z.string(),
    status: z.string().min(1),
    attributes: jsonObject,
    authored_by: z.enum(["human", "ai"]).optional(),
    authoredBy: z.enum(["human", "ai"]).optional(),
    source_ref: z.string().nullable().optional(),
    sourceRef: z.string().nullable().optional(),
    supersedes_id: z.string().nullable().optional(),
    supersedesId: z.string().nullable().optional(),
    superseded_by_id: z.string().nullable().optional(),
    supersededById: z.string().nullable().optional(),
  })
  .describe("Proposed knowledge object envelope plus type-specific attributes.");

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
  discussion: knowledgeObjectWriteSchema.describe(
    "Raw discussion record for the conversation being resolved. Must be type discussion with status recorded.",
  ),
  proposal: z
    .object({
      objects: z.array(knowledgeObjectWriteSchema).min(1),
      relations: z.array(relationWriteSchema).optional(),
    })
    .describe(
      "Agent-authored structured proposal: proposed decisions, constraints, glossary entries, and their relations.",
    ),
};

export const artifactGetInputSchema = {
  session_id: sessionIdInput,
  id: z
    .string()
    .min(1)
    .describe("Artifact knowledge object id (for example ART-0001)."),
};

export const TOOL_DESCRIPTIONS = {
  "context.build":
    "Retrieve why this project is built the way it is: past decisions and their reasoning, constraints that still apply, approaches already tried and rejected, and unresolved questions. Use this before answering any 'why' question about the project, before proposing architecture, or when you need the project's recorded engineering context rather than guessing. Requires scope (use graph.expand with list_scopes=true to discover ids), intent, and a token budget.",
  "graph.expand":
    "Explore the knowledge graph: list available scopes, find objects by keyword, or walk relations from a known object id. Use list_scopes=true first when you need a valid scope id for context.build. Use keyword or metadata search when you know what you are looking for but not which object id to start from.",
  "discussion.resolve":
    "File a structured proposal distilled from a conversation for human triage. The server validates your proposal and stores it as a pending candidate; it does not generate or approve knowledge. Use after you have already written the decision, constraints, and relations yourself.",
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
