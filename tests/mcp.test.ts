import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { importBackfill } from "../dist/application/index.js";
import {
  handleArtifactGet,
  handleContextBuild,
  handleDiscussionResolve,
  handleGraphExpand,
} from "../dist/mcp/handlers.js";
import { withFreshThrowawayDatabase } from "./support/db.ts";

const BEACON_DIRECTORY = "backfill/beacon";

async function withMiraGraph<T>(fn: (client: import("pg").Client) => Promise<T>): Promise<T> {
  return withFreshThrowawayDatabase(async (client) => {
    await importBackfill(client, BEACON_DIRECTORY);
    return fn(client);
  });
}

function parseToolJson(result: { content: readonly { text: string }[]; isError?: boolean }): {
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

test("context.build returns a Beacon pack with graph_version", async () => {
  await withMiraGraph(async (client) => {
    const result = await handleContextBuild(client, {
      scope: "project_beacon",
      intent: "implementation",
      budget: 4_000,
    });
    assert.equal(result.isError, undefined);
    const body = parseToolJson(result);
    assert.equal(body.graph_version, 3);
    assert.ok(typeof body.pack_id === "string");
    assert.ok(body.pack !== undefined);
  });
});

test("graph.expand traverses incoming derives_from edges from a Beacon seed", async () => {
  await withMiraGraph(async (client) => {
    const result = await handleGraphExpand(client, {
      seed_object_id: "DEC-0001",
      relation: "derives_from",
      direction: "incoming",
    });
    assert.equal(result.isError, undefined);
    const body = parseToolJson(result);
    assert.equal(body.graph_version, 3);
    const results = body.results as Array<{ object: { id: string } }>;
    assert.ok(results.some((entry) => entry.object.id === "CON-0001"));
  });
});

test("graph.expand supports keyword retrieval with no seed", async () => {
  await withMiraGraph(async (client) => {
    const result = await handleGraphExpand(client, {
      text: "poll",
      scope: "project_beacon",
    });
    assert.equal(result.isError, undefined);
    const body = parseToolJson(result);
    assert.equal(body.graph_version, 3);
    const results = body.results as Array<{ object: { id: string } }>;
    assert.ok(results.some((entry) => entry.object.id === "DEC-0001"));
  });
});

test("graph.expand returns the compact object projection with provenance and evidence", async () => {
  await withMiraGraph(async (client) => {
    const result = await handleGraphExpand(client, {
      text: "poll",
      scope: "project_beacon",
    });
    assert.equal(result.isError, undefined);
    const body = parseToolJson(result);
    const results = body.results as Array<{
      object: Record<string, unknown>;
      provenance: Record<string, unknown>;
      evidence_reference_ids: unknown;
    }>;
    const entry = results.find((candidate) => candidate.object.id === "DEC-0001");
    assert.ok(entry);
    assert.deepEqual(Object.keys(entry.object).sort(), [
      "attributes",
      "body",
      "id",
      "scopeId",
      "status",
      "title",
      "type",
    ]);
    assert.deepEqual(Object.keys(entry.provenance).sort(), [
      "approved_at",
      "authored_by",
      "last_verified_at",
      "review_required",
    ]);
    assert.ok(Array.isArray(entry.evidence_reference_ids));
  });
});

test("artifact.get returns summary, version, and location for ART-0001", async () => {
  await withMiraGraph(async (client) => {
    const result = await handleArtifactGet(client, { id: "ART-0001" });
    assert.equal(result.isError, undefined);
    const body = parseToolJson(result);
    assert.equal(body.graph_version, 3);
    assert.equal(body.id, "ART-0001");
    assert.equal(body.version, "ADR-001");
    assert.equal(body.location, "docs/beacon_decisions.md#DEC-0001");
    assert.match(String(body.summary), /polls lms_ro/i);
  });
});

test("discussion.resolve rejects an invalid proposal and leaves no candidate row", async () => {
  await withMiraGraph(async (client) => {
    const beforeCandidates = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM candidates",
    );
    const beforeDiscussions = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM knowledge_objects WHERE type = 'discussion'",
    );
    const result = await handleDiscussionResolve(client, {
      discussion: {
        type: "discussion",
        scopeId: "project_beacon",
        title: "MCP invalid proposal test",
        body: "discussion body",
        status: "recorded",
        attributes: {
          medium: "chat",
          occurred_at: "2026-08-20T00:00:00.000Z",
          content_ref: "blob://mcp-invalid-proposal",
        },
      },
      proposal: {
        objects: [
          {
            local_id: "decision",
            type: "decision",
            scopeId: "project_beacon",
            title: "Decision without origin",
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
        relations: [],
      },
    });
    assert.equal(result.isError, true);
    const body = parseToolJson(result);
    assert.equal(body.graph_version, 3);
    assert.equal(body.error?.code, "DECISION_ORIGIN_REQUIRED");
    const afterCandidates = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM candidates",
    );
    const afterDiscussions = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM knowledge_objects WHERE type = 'discussion'",
    );
    assert.equal(afterCandidates.rows[0]?.count, beforeCandidates.rows[0]?.count);
    assert.equal(afterDiscussions.rows[0]?.count, beforeDiscussions.rows[0]?.count);
  });
});

test("discussion.resolve persists a valid proposal as a candidate linked to a discussion", async () => {
  await withMiraGraph(async (client) => {
    const result = await handleDiscussionResolve(client, {
      discussion: {
        local_id: "conversation",
        type: "discussion",
        scopeId: "project_beacon",
        title: "MCP valid proposal test",
        body: "discussion body",
        status: "recorded",
        attributes: {
          medium: "chat",
          occurred_at: "2026-08-20T00:00:00.000Z",
          content_ref: "blob://mcp-valid-proposal",
        },
      },
      proposal: {
        objects: [
          {
            local_id: "decision",
            type: "decision",
            scopeId: "project_beacon",
            title: "Decision with origin",
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
        relations: [
          {
            sourceId: "decision",
            relation: "derives_from",
            targetId: "conversation",
            targetKind: "knowledge_object",
          },
        ],
      },
    });
    assert.equal(result.isError, undefined);
    const body = parseToolJson(result);
    assert.equal(body.graph_version, 3);
    assert.ok(typeof body.candidate_id === "string");
    const candidate = await client.query<{ status: string; source_ref: string | null }>(
      "SELECT status, source_ref FROM candidates WHERE id = $1::uuid",
      [body.candidate_id],
    );
    assert.equal(candidate.rows[0]?.status, "pending");
    assert.match(String(body.discussion_id), /^DSC-[0-9]{4,}$/u);
    assert.equal(candidate.rows[0]?.source_ref, body.discussion_id);
    const discussion = await client.query<{ id: string }>(
      "SELECT id FROM knowledge_objects WHERE id = $1",
      [body.discussion_id],
    );
    assert.equal(discussion.rows[0]?.id, body.discussion_id);
  });
});

test("src/mcp cannot import durable-write use cases by construction", async () => {
  const mcpDirectory = path.resolve("src/mcp");
  const entries = [
    "index.ts",
    "server.ts",
    "handlers.ts",
    "envelope.ts",
    "schemas.ts",
    "validation.ts",
  ];
  for (const entry of entries) {
    const source = await readFile(path.join(mcpDirectory, entry), "utf8");
    assert.doesNotMatch(source, /application\/write/);
    assert.doesNotMatch(source, /curationTransaction/);
    assert.doesNotMatch(source, /acceptCandidate/);
    assert.doesNotMatch(source, /createCandidate/);
  }
});
