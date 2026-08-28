import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { importBackfill } from "../dist/application/index.js";
import { createMcpServer } from "../dist/mcp/server.js";
import { withFreshThrowawayDatabase } from "./support/db.ts";

const MIRA_DIRECTORY = "backfill/mira";

type JsonSchemaNode = {
  const?: unknown;
  enum?: unknown[];
  pattern?: string;
  description?: string;
  required?: string[];
  properties?: Record<string, JsonSchemaNode>;
  items?: { anyOf?: JsonSchemaNode[]; oneOf?: JsonSchemaNode[] };
};

async function withMiraMcpClient<T>(
  fn: (client: import("pg").Client, mcp: Client) => Promise<T>,
): Promise<T> {
  return withFreshThrowawayDatabase(async (pgClient) => {
    await importBackfill(pgClient, MIRA_DIRECTORY);
    const server = createMcpServer(pgClient);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const mcp = new Client({ name: "pke-test", version: "0.0.0" });
    await mcp.connect(clientTransport);
    try {
      return await fn(pgClient, mcp);
    } finally {
      await mcp.close();
      await server.close();
    }
  });
}

function parseToolText(result: { content: Array<{ text?: string }>; isError?: boolean }): {
  graph_version?: number;
  error?: { code: string; message: string };
  [key: string]: unknown;
} {
  const text = result.content[0]?.text;
  assert.ok(text);
  return JSON.parse(text) as {
    graph_version?: number;
    error?: { code: string; message: string };
    [key: string]: unknown;
  };
}

test("MCP SDK parse preserves context.build arguments through to the handler", async () => {
  await withMiraMcpClient(async (_pg, mcp) => {
    const result = await mcp.callTool({
      name: "context.build",
      arguments: {
        scope: "project_mira",
        intent: "implementation",
        budget: 4_000,
      },
    });
    assert.equal(result.isError, undefined);
    const body = parseToolText(result);
    assert.equal(body.graph_version, 3);
    assert.ok(typeof body.pack_id === "string");
  });
});

test("context_build underscore alias reaches the same handler", async () => {
  await withMiraMcpClient(async (_pg, mcp) => {
    const result = await mcp.callTool({
      name: "context_build",
      arguments: {
        scope: "project_mira",
        intent: "debug",
        budget: 2_000,
      },
    });
    assert.equal(result.isError, undefined);
    const body = parseToolText(result);
    assert.equal(body.graph_version, 3);
  });
});

test("graph.expand list_scopes returns the scope tree through the SDK parse layer", async () => {
  await withMiraMcpClient(async (_pg, mcp) => {
    const result = await mcp.callTool({
      name: "graph.expand",
      arguments: { list_scopes: true },
    });
    assert.equal(result.isError, undefined);
    const body = parseToolText(result);
    assert.equal(body.graph_version, 3);
    const scopes = body.scopes as Array<{ id: string; parent_id: string | null }>;
    assert.ok(scopes.some((scope) => scope.id === "project_mira"));
    assert.ok(scopes.some((scope) => scope.id === "global" && scope.parent_id === null));
  });
});

test("graph_expand alias lists scopes through the SDK parse layer", async () => {
  await withMiraMcpClient(async (_pg, mcp) => {
    const result = await mcp.callTool({
      name: "graph_expand",
      arguments: { list_scopes: true },
    });
    assert.equal(result.isError, undefined);
    const body = parseToolText(result);
    assert.ok(Array.isArray(body.scopes));
  });
});

test("artifact.get returns ART-0001 through the SDK parse layer", async () => {
  await withMiraMcpClient(async (_pg, mcp) => {
    const result = await mcp.callTool({
      name: "artifact.get",
      arguments: { id: "ART-0001" },
    });
    assert.equal(result.isError, undefined);
    const body = parseToolText(result);
    assert.equal(body.id, "ART-0001");
    assert.equal(body.version, "ADR-001");
  });
});

test("discussion.resolve rejects invalid proposals through the SDK parse layer", async () => {
  await withMiraMcpClient(async (pg, mcp) => {
    const before = await pg.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM candidates",
    );
    const result = await mcp.callTool({
      name: "discussion.resolve",
      arguments: {
        discussion: {
          type: "discussion",
          scope_id: "project_mira",
          title: "SDK invalid proposal",
          body: "body",
          status: "recorded",
          attributes: {
            medium: "chat",
            occurred_at: "2026-08-20T00:00:00.000Z",
            content_ref: "blob://sdk-invalid",
          },
        },
        proposal: {
          objects: [
            {
              local_id: "decision",
              type: "decision",
              scope_id: "project_mira",
              title: "No origin",
              body: "body",
              status: "active",
              attributes: {
                statement: "statement",
                rationale: "rationale",
                reversibility: "cheap",
                alternatives_rejected: [],
              },
            },
          ],
        },
      },
    });
    assert.equal(result.isError, true);
    const body = parseToolText(result);
    assert.equal(body.error?.code, "DECISION_ORIGIN_REQUIRED");
    const after = await pg.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM candidates",
    );
    assert.equal(after.rows[0]?.count, before.rows[0]?.count);
  });
});

test("discussion.resolve projects accepted camelCase input to persisted snake_case", async () => {
  await withMiraMcpClient(async (pg, mcp) => {
    const result = await mcp.callTool({
      name: "discussion.resolve",
      arguments: {
        discussion: {
          localId: "conversation",
          type: "discussion",
          scopeId: "project_mira",
          title: "SDK representation boundary",
          body: "body",
          status: "recorded",
          attributes: {
            medium: "chat",
            occurredAt: "2026-08-24T00:00:00.000Z",
            contentRef: {
              storage: "external",
              location: "fovea://conversation/test#message",
            },
          },
        },
        proposal: {
          objects: [
            {
              local_id: "decision",
              type: "decision",
              scopeId: "project_mira",
              title: "Canonical persistence",
              body: "body",
              status: "active",
              attributes: {
                statement: "Persist the validated representation.",
                rationale: "Validation and persistence must use one representation.",
                reversibility: "cheap",
                alternativesRejected: [],
              },
            },
          ],
          relations: [
            {
              sourceId: "decision",
              relation: "derives_from",
              targetId: "conversation",
              targetKind: "knowledge_object",
            },
          ],
        },
      },
    });

    assert.equal(result.isError, undefined);
    const body = parseToolText(result);
    assert.equal(typeof body.candidate_id, "string");
    assert.match(String(body.discussion_id), /^DSC-[0-9]{4,}$/u);

    const discussion = await pg.query<{ attributes: Record<string, unknown> }>(
      "SELECT attributes FROM knowledge_objects WHERE id = $1",
      [body.discussion_id],
    );
    const discussionAttributes = discussion.rows[0]?.attributes;
    assert.ok(discussionAttributes);
    assert.deepEqual(Object.keys(discussionAttributes).sort(), [
      "content_ref",
      "medium",
      "occurred_at",
    ]);
    assert.deepEqual(discussionAttributes.content_ref, {
      storage: "external",
      location: "fovea://conversation/test#message",
    });

    const candidate = await pg.query<{
      payload: { objects: Array<{ attributes: Record<string, unknown> }> };
    }>("SELECT payload FROM candidates WHERE id = $1::uuid", [body.candidate_id]);
    const decisionAttributes = candidate.rows[0]?.payload.objects[0]?.attributes;
    assert.ok(decisionAttributes);
    assert.deepEqual(Object.keys(decisionAttributes).sort(), [
      "alternatives_rejected",
      "rationale",
      "reversibility",
      "statement",
    ]);
    assert.equal("alternativesRejected" in decisionAttributes, false);
  });
});

test("graph-state rejections reach the client as one response listing every failure", async () => {
  await withMiraMcpClient(async (pg, mcp) => {
    const before = await pg.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM candidates",
    );
    const result = await mcp.callTool({
      name: "discussion.resolve",
      arguments: {
        discussion: {
          type: "discussion",
          scope_id: "project_mira",
          title: "title",
          body: "body",
          status: "recorded",
          attributes: {
            medium: "chat",
            occurred_at: "2026-08-20T00:00:00.000Z",
            content_ref: "blob://sdk-aggregate",
          },
        },
        proposal: {
          objects: [
            {
              local_id: "decision",
              type: "decision",
              scope_id: "project_mira",
              title: "title",
              body: "body",
              status: "active",
              attributes: {
                statement: "statement",
                rationale: "rationale",
                reversibility: "cheap",
                alternatives_rejected: [],
              },
            },
            {
              local_id: "rule",
              type: "constraint",
              scope_id: "project_mira",
              title: "title",
              body: "body",
              status: "active",
              attributes: { rule: "keep it true", enforcement: "hard", axiomatic: false },
            },
          ],
        },
      },
    });

    assert.equal(result.isError, true);
    const body = parseToolText(result);
    assert.equal(body.error?.code, "DECISION_ORIGIN_REQUIRED");
    const failures = (body.error as { failures?: Array<{ code: string; object_id?: string }> })
      .failures;
    assert.ok(failures);
    assert.deepEqual(
      failures.map((failure) => `${failure.code}:${failure.object_id ?? ""}`),
      ["DECISION_ORIGIN_REQUIRED:decision", "CONSTRAINT_PARENT_REQUIRED:rule"],
    );

    const after = await pg.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM candidates",
    );
    assert.equal(after.rows[0]?.count, before.rows[0]?.count);
  });
});

test("context.build returns SCOPE_NOT_FOUND with the valid scope list", async () => {
  await withMiraMcpClient(async (_pg, mcp) => {
    const result = await mcp.callTool({
      name: "context.build",
      arguments: {
        scope: "repository",
        intent: "implementation",
        budget: 4_000,
      },
    });
    assert.equal(result.isError, true);
    const body = parseToolText(result);
    assert.equal(body.error?.code, "SCOPE_NOT_FOUND");
    assert.match(String(body.error?.message), /repository/);
    assert.match(String(body.error?.message), /project_mira/);
  });
});

test("context.build rejects unknown intent with the valid intent list", async () => {
  await withMiraMcpClient(async (_pg, mcp) => {
    const result = await mcp.callTool({
      name: "context.build",
      arguments: {
        scope: "project_mira",
        intent: "exploration",
        budget: 4_000,
      },
    });
    assert.equal(result.isError, true);
    const text = result.content[0]?.text ?? "";
    assert.match(text, /Invalid arguments for tool context\.build/);
    assert.match(text, /implementation/);
    assert.match(text, /investigation/);
  });
});

test("advertised tool schemas expose required parameters", async () => {
  await withMiraMcpClient(async (_pg, mcp) => {
    const tools = await mcp.listTools();
    const contextBuild = tools.tools.find((tool) => tool.name === "context.build");
    assert.ok(contextBuild);
    const properties = contextBuild.inputSchema.properties as Record<string, unknown>;
    assert.ok(properties.scope);
    assert.ok(properties.intent);
    assert.ok(properties.budget);
    assert.deepEqual(contextBuild.inputSchema.required, ["scope", "intent", "budget"]);
    assert.ok(tools.tools.some((tool) => tool.name === "context_build"));
  });
});

test("the advertised discussion.resolve schema states the per-type contract", async () => {
  await withMiraMcpClient(async (_pg, mcp) => {
    const tools = await mcp.listTools();
    const resolve = tools.tools.find((tool) => tool.name === "discussion.resolve");
    assert.ok(resolve);
    const schema = resolve.inputSchema as unknown as {
      required: string[];
      properties: Record<string, JsonSchemaNode>;
    };
    assert.deepEqual(schema.required, ["discussion", "proposal"]);

    const discussion = schema.properties.discussion;
    assert.ok(discussion);
    assert.deepEqual(discussion.properties?.attributes?.required, [
      "medium",
      "occurred_at",
      "content_ref",
    ]);
    assert.deepEqual(discussion.properties?.status?.const, "recorded");
    assert.equal(discussion.required?.includes("id"), false, "Engram allocates the discussion id");
    assert.ok(discussion.properties?.local_id, "relations need a handle for the discussion");

    const items = schema.properties.proposal?.properties?.objects?.items;
    const branches = items?.oneOf ?? items?.anyOf ?? [];
    assert.equal(branches.length, 7, "discussion and observation are not proposable");
    const decision = branches.find((branch) => branch.properties?.type?.const === "decision");
    assert.ok(decision);
    assert.deepEqual(decision.properties?.status?.const, "active");
    assert.ok(decision.required?.includes("local_id"), "relations name proposed objects by handle");
    assert.equal(decision.required?.includes("id"), false, "Engram assigns ids at acceptance");
    assert.ok(decision.required?.includes("scope_id"));
    assert.deepEqual(decision.properties?.attributes?.required, [
      "statement",
      "rationale",
      "reversibility",
      "alternatives_rejected",
    ]);
    assert.deepEqual(decision.properties?.attributes?.properties?.reversibility?.enum, [
      "cheap",
      "costly",
      "one_way",
    ]);
  });
});

test("an unconstructable proposal reports every schema problem in one response", async () => {
  await withMiraMcpClient(async (_pg, mcp) => {
    const result = await mcp.callTool({
      name: "discussion.resolve",
      arguments: {
        discussion: {
          type: "discussion",
          scope_id: "project_mira",
          title: "title",
          body: "body",
          status: "open",
          attributes: { medium: "chat" },
        },
        proposal: {
          objects: [
            {
              local_id: "decision",
              type: "decision",
              scope_id: "project_mira",
              title: "title",
              body: "body",
              status: "proposed",
              attributes: { reversibility: "maybe" },
            },
          ],
        },
      },
    });
    assert.equal(result.isError, true);
    const text = result.content[0]?.text ?? "";
    for (const expected of [
      'expected "recorded" at discussion.status',
      "discussion.attributes.occurred_at",
      "discussion.attributes.content_ref",
      'expected "active" at proposal.objects[0].status',
      "proposal.objects[0].attributes.statement",
      "proposal.objects[0].attributes.rationale",
      'one of "cheap"|"costly"|"one_way" at proposal.objects[0].attributes.reversibility',
      "proposal.objects[0].attributes.alternatives_rejected",
    ]) {
      assert.ok(text.includes(expected), `missing "${expected}" in: ${text}`);
    }
  });
});
