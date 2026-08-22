import assert from "node:assert/strict";
import test from "node:test";
import type { Client } from "pg";
import { collectMetrics, importBackfill, logRelitigationEvent } from "../dist/application/index.js";
import { handleArtifactGet, handleContextBuild, handleGraphExpand } from "../dist/mcp/handlers.js";
import { withFreshThrowawayDatabase } from "./support/db.ts";

const MIRA_DIRECTORY = "backfill/mira";

async function withMiraGraph<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  return withFreshThrowawayDatabase(async (client) => {
    await importBackfill(client, MIRA_DIRECTORY);
    return fn(client);
  });
}

async function graphVersionCount(client: Client): Promise<number> {
  const result = await client.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM graph_versions",
  );
  return Number(result.rows[0]?.count ?? 0);
}

test("coverage uses the first recorded call and telemetry does not create a graph version", async () => {
  await withMiraGraph(async (client) => {
    const before = await graphVersionCount(client);

    await handleGraphExpand(client, {
      session_id: "session-graph-first",
      list_scopes: true,
    });
    await handleContextBuild(client, {
      session_id: "session-graph-first",
      scope: "project_mira",
      intent: "implementation",
      budget: 4_000,
    });
    await handleContextBuild(client, {
      session_id: "session-pack-first",
      scope: "project_mira",
      intent: "debug",
      budget: 4_000,
    });
    await handleArtifactGet(client, { id: "ART-0001" });

    const calls = await client.query<{
      session_id: string | null;
      tool_name: string;
      graph_version: string;
    }>(
      `SELECT session_id, tool_name, graph_version::text
       FROM mcp_tool_calls
       ORDER BY id`,
    );
    assert.deepEqual(
      calls.rows.map((row) => ({
        session_id: row.session_id,
        tool_name: row.tool_name,
        graph_version: Number(row.graph_version),
      })),
      [
        {
          session_id: "session-graph-first",
          tool_name: "graph.expand",
          graph_version: 3,
        },
        {
          session_id: "session-graph-first",
          tool_name: "context.build",
          graph_version: 3,
        },
        {
          session_id: "session-pack-first",
          tool_name: "context.build",
          graph_version: 3,
        },
        {
          session_id: null,
          tool_name: "artifact.get",
          graph_version: 3,
        },
      ],
    );

    const metrics = await collectMetrics(client);
    assert.equal(metrics.pack_coverage.numerator, 1);
    assert.equal(metrics.pack_coverage.denominator, 2);
    assert.equal(metrics.pack_coverage.sessions_started_with_pack, 1);
    assert.equal(metrics.pack_coverage.total_sessions, 2);
    assert.equal(metrics.pack_coverage.unidentified_tool_calls, 1);
    assert.equal(await graphVersionCount(client), before);
  });
});

test("an instrumentation write failure does not fail the MCP tool", async () => {
  await withMiraGraph(async (client) => {
    await client.query(`
      CREATE FUNCTION reject_mcp_tool_call() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'instrumentation unavailable';
      END;
      $$;
      CREATE TRIGGER reject_mcp_tool_call
      BEFORE INSERT ON mcp_tool_calls
      FOR EACH ROW EXECUTE FUNCTION reject_mcp_tool_call();
    `);
    try {
      const result = await handleContextBuild(client, {
        session_id: "instrumentation-fails",
        scope: "project_mira",
        intent: "implementation",
        budget: 4_000,
      });
      assert.equal(result.isError, undefined);
    } finally {
      await client.query("DROP TRIGGER reject_mcp_tool_call ON mcp_tool_calls");
      await client.query("DROP FUNCTION reject_mcp_tool_call()");
    }
  });
});

test("relitigation and supporting metrics expose denominators", async () => {
  await withMiraGraph(async (client) => {
    await logRelitigationEvent(client, {
      objectId: "DEC-0001",
      sessionId: "manual-session",
      packUsed: true,
      note: "The old decision was proposed again.",
    });
    await logRelitigationEvent(client, {
      objectId: "DEC-0001",
      packUsed: false,
    });

    const metrics = await collectMetrics(client);
    assert.equal(metrics.relitigation.total_events, 2);
    assert.equal(metrics.relitigation.denominator, 2);
    assert.equal(metrics.relitigation.pack_used.count, 1);
    assert.equal(metrics.relitigation.pack_not_used.count, 1);
    assert.equal(metrics.relitigation.pack_used.denominator, 2);
    assert.equal(metrics.relitigation.pack_not_used.denominator, 2);
    assert.equal(metrics.stale_ratio.denominator >= 0, true);
    assert.equal(metrics.candidate_accept_rate.denominator >= 0, true);
    assert.equal(metrics.tier_escalation_rate.denominator >= 0, true);
  });
});
