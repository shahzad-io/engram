import type { Client } from "pg";
import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShapeOutput, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { buildContextPack } from "../application/pack/index.js";
import { getArtifact, listScopeTree } from "../application/read/index.js";
import { resolveDiscussion } from "../application/propose/resolve-discussion.js";
import type {
  KnowledgeObjectWrite,
  ProposalPayload,
  RelationWrite,
} from "../application/propose/types.js";
import { retrieveKnowledge } from "../application/retrieval/index.js";
import type { ContextPackIntent } from "../domain/pack/types.js";
import type {
  KnowledgeClass,
  KnowledgeObject,
  KnowledgeObjectType,
} from "../domain/entity/types.js";
import type { RetrievalDirection } from "../domain/retrieval/types.js";
import type { RelationVerb } from "../domain/relation/legality.js";
import {
  recordRetrievalEventSafely,
  recordToolInvocationSafely,
} from "../application/instrumentation/index.js";
import { getCurrentGraphVersion } from "../infrastructure/persistence/read.js";
import { jsonText, mcpErrorBody, withGraphVersion } from "./envelope.js";
import type {
  ArtifactGetInput,
  ContextBuildInput,
  DiscussionResolveInput,
  GraphExpandInput,
} from "./schemas.js";
import { requireString } from "./validation.js";

export type ToolCallResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sessionIdOf(value: unknown): string | null {
  if (!isRecord(value)) return null;
  return typeof value.session_id === "string" ? value.session_id : null;
}

async function recordInvocation(
  client: Client,
  toolName: string,
  args: unknown,
): Promise<void> {
  await recordToolInvocationSafely(client, {
    sessionId: sessionIdOf(args),
    toolName,
  });
}

function readOptionalStringArray(value: unknown): readonly string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value;
  }
  throw new Error("expected a string or string array");
}

function normalizeKnowledgeObjectWrite(value: Record<string, unknown>): KnowledgeObjectWrite {
  const type = requireString(value.type, "type") as KnowledgeObjectWrite["type"];
  const scopeId = value.scopeId ?? value.scope_id;
  return {
    id: requireString(value.id, "id"),
    type,
    scopeId: requireString(scopeId, "scopeId"),
    featureLabelIds: readOptionalStringArray(value.featureLabelIds ?? value.feature_labels),
    title: requireString(value.title, "title"),
    body: requireString(value.body, "body"),
    status: requireString(value.status, "status"),
    attributes: isRecord(value.attributes) ? value.attributes : {},
    authoredBy: (value.authoredBy ?? value.authored_by ?? "ai") as KnowledgeObjectWrite["authoredBy"],
    sourceRef:
      value.sourceRef === null
        ? null
        : typeof (value.sourceRef ?? value.source_ref) === "string"
          ? String(value.sourceRef ?? value.source_ref)
          : null,
    supersedesId:
      value.supersedesId === null
        ? null
        : typeof (value.supersedesId ?? value.supersedes_id) === "string"
          ? String(value.supersedesId ?? value.supersedes_id)
          : null,
    supersededById:
      value.supersededById === null
        ? null
        : typeof (value.supersededById ?? value.superseded_by_id) === "string"
          ? String(value.supersededById ?? value.superseded_by_id)
          : null,
  };
}

function normalizeRelationWrite(value: Record<string, unknown>): RelationWrite {
  const sourceId = value.sourceId ?? value.source_id;
  const targetId = value.targetId ?? value.target_id;
  const targetKind = value.targetKind ?? value.target_kind ?? "knowledge_object";
  return {
    sourceId: requireString(sourceId, "sourceId"),
    relation: requireString(value.relation, "relation") as RelationVerb,
    targetId: requireString(targetId, "targetId"),
    targetKind: requireString(targetKind, "targetKind") as RelationWrite["targetKind"],
  };
}

function normalizeProposal(value: DiscussionResolveInput["proposal"]): ProposalPayload {
  return {
    objects: value.objects.map((object) => normalizeKnowledgeObjectWrite(object)),
    relations: (value.relations ?? []).map((relation) => normalizeRelationWrite(relation)),
  };
}

function serializeKnowledgeObject(object: KnowledgeObject): Record<string, unknown> {
  return {
    id: object.id,
    type: object.type,
    scopeId: object.scopeId,
    title: object.title,
    body: object.body,
    status: object.status,
    attributes: object.attributes,
  };
}

async function currentGraphVersion(client: Client): Promise<number> {
  return (await getCurrentGraphVersion(client)).version;
}

async function success<T extends Record<string, unknown>>(
  client: Client,
  body: T,
): Promise<ToolCallResult> {
  const graphVersion = await currentGraphVersion(client);
  return { content: [jsonText(withGraphVersion(graphVersion, body))] };
}

async function failure(client: Client, error: unknown): Promise<ToolCallResult> {
  const graphVersion = await currentGraphVersion(client);
  return {
    content: [jsonText(mcpErrorBody(error, graphVersion))],
    isError: true,
  };
}

export function wrapToolHandler<TArgs>(
  client: Client,
  handler: (client: Client, args: TArgs) => Promise<ToolCallResult>,
): (args: TArgs) => Promise<ToolCallResult> {
  return (args: TArgs) => handler(client, args);
}

export async function handleContextBuild(
  client: Client,
  args: ContextBuildInput,
): Promise<ToolCallResult> {
  await recordInvocation(client, "context.build", args);
  try {
    const stored = await buildContextPack(client, {
      scopeId: args.scope,
      feature: readOptionalStringArray(args.feature),
      intent: args.intent as ContextPackIntent | "investigation",
      budget: args.budget,
    });
    return success(client, {
      pack_id: stored.id,
      pack: stored.pack,
    });
  } catch (error) {
    return failure(client, error);
  }
}

export async function handleGraphExpand(
  client: Client,
  args: GraphExpandInput,
): Promise<ToolCallResult> {
  await recordInvocation(client, "graph.expand", args);
  try {
    if (args.list_scopes === true) {
      const tree = await listScopeTree(client);
      return success(client, { scopes: tree.scopes });
    }
    const response = await retrieveKnowledge(client, {
      scopeId: args.scope,
      feature: readOptionalStringArray(args.feature),
      types: args.types as readonly KnowledgeObjectType[] | undefined,
      classes: args.classes as readonly KnowledgeClass[] | undefined,
      statuses: args.statuses as readonly KnowledgeObject["status"][] | undefined,
      text: args.text,
      seedObjectId: args.seed_object_id,
      relation: args.relation as RelationVerb | undefined,
      direction: args.direction as RetrievalDirection | undefined,
      followSupersession: args.follow_supersession === true ? true : undefined,
    });
    await recordRetrievalEventSafely(client, {
      sessionId: sessionIdOf(args),
      toolName: "graph.expand",
      tier: response.tier,
      tierEscalations: response.tierEscalations,
    });
    return success(client, {
      tier: response.tier,
      tier_escalations: response.tierEscalations,
      results: response.results.map((result) => ({
        tier: result.tier,
        scope_depth: result.scopeDepth,
        staleness: result.staleness,
        provenance: {
          authored_by: result.provenance.authoredBy,
          approved_at: result.provenance.approvedAt,
          last_verified_at: result.provenance.lastVerifiedAt,
          review_required: result.provenance.reviewRequired,
        },
        evidence_reference_ids: result.evidenceReferenceIds,
        object: serializeKnowledgeObject(result.object),
      })),
    });
  } catch (error) {
    return failure(client, error);
  }
}

export async function handleDiscussionResolve(
  client: Client,
  args: DiscussionResolveInput,
): Promise<ToolCallResult> {
  await recordInvocation(client, "discussion.resolve", args);
  try {
    const discussion = normalizeKnowledgeObjectWrite(args.discussion);
    const proposal = normalizeProposal(args.proposal);
    const result = await resolveDiscussion(client, { discussion, proposal });
    return {
      content: [
        jsonText({
          graph_version: result.graphVersion,
          validation: result.validation,
          candidate_id: result.candidateId,
          candidate_ids: result.candidateIds,
          discussion_id: result.discussionId,
        }),
      ],
    };
  } catch (error) {
    return failure(client, error);
  }
}

export async function handleArtifactGet(
  client: Client,
  args: ArtifactGetInput,
): Promise<ToolCallResult> {
  await recordInvocation(client, "artifact.get", args);
  try {
    const artifact = await getArtifact(client, args.id);
    return {
      content: [
        jsonText({
          graph_version: artifact.graphVersion,
          id: artifact.id,
          summary: artifact.summary,
          version: artifact.version,
          location: artifact.location,
        }),
      ],
    };
  } catch (error) {
    return failure(client, error);
  }
}

export function registerToolPair<TSchema extends ZodRawShapeCompat>(
  server: McpServer,
  client: Client,
  registration: {
    readonly name: string;
    readonly alias: string;
    readonly description: string;
    readonly inputSchema: TSchema;
    readonly handler: (client: Client, args: ShapeOutput<TSchema>) => Promise<ToolCallResult>;
  },
): void {
  const wrapped = wrapToolHandler(client, registration.handler);
  for (const name of [registration.name, registration.alias]) {
    server.registerTool(
      name,
      {
        description: registration.description,
        inputSchema: registration.inputSchema,
      },
      wrapped as unknown as ToolCallback<TSchema>,
    );
  }
}
