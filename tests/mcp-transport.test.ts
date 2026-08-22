import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { importBackfill } from "../dist/application/index.js";
import { createMcpServer } from "../dist/mcp/server.js";
import { withFreshThrowawayDatabase } from "./support/db.ts";

const MIRA_DIRECTORY = "backfill/mira";

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
    const before = await pg.query<{ count: string }>("SELECT count(*)::text AS count FROM candidates");
    const result = await mcp.callTool({
      name: "discussion.resolve",
      arguments: {
        discussion: {
          id: "DSC-9101",
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
              id: "DEC-9101",
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
    const after = await pg.query<{ count: string }>("SELECT count(*)::text AS count FROM candidates");
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
