import assert from "node:assert/strict";
import test from "node:test";
import type { Client as PgClient } from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { runCli, type CliResult } from "../dist/cli.js";
import { createMcpServer } from "../dist/mcp/server.js";
import type { WireError } from "../dist/wire/envelope.js";
import { waitForDatabase, withClient } from "./support/db.ts";

/*
 * The whole loop, through the surfaces Fovea actually uses: proposals
 * arrive over MCP, curation happens through the CLI, packs are read back
 * over MCP.
 *
 * `id-allocation.test.ts` covers the same ground by calling the use cases
 * directly and is deliberately kept. The two fail differently: a use-case
 * test cannot see argument parsing, the `--json` envelope, exit codes, or
 * a command that reports success while having written nothing. Every
 * defect Epic 1 fixed was invisible from inside the use case.
 */

let serial = 0;

function suffix(): string {
  serial += 1;
  return `${Date.now()}${process.pid}${serial}`;
}

async function createProject(client: PgClient): Promise<string> {
  const id = `trip_${suffix()}`;
  await client.query(
    `INSERT INTO scopes (id, kind, parent_id, name)
     VALUES ($1, 'project', 'global', $1)`,
    [id],
  );
  return id;
}

async function graphVersionCount(client: PgClient): Promise<number> {
  const result = await client.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM graph_versions",
  );
  return Number(result.rows[0]?.count ?? "0");
}

/** The highest number allocated for a prefix, as `allocateKnowledgeObjectIds` reads it. */
async function highestNumberFor(client: PgClient, prefix: string): Promise<number> {
  const result = await client.query<{ highest: string }>(
    `SELECT COALESCE(MAX(substring(id from '^[A-Z]+-([0-9]{4,9})$')::bigint), 0)::text AS highest
       FROM knowledge_objects
      WHERE id ~ $1`,
    [`^${prefix}-[0-9]{4,}$`],
  );
  return Number(result.rows[0]?.highest ?? "0");
}

function numberOf(id: string): number {
  return Number(id.slice(id.indexOf("-") + 1));
}

function cliData(result: CliResult): Record<string, unknown> {
  const payload = result.payload as {
    readonly data?: Record<string, unknown>;
    readonly error?: WireError;
  } | null;
  assert.equal(result.exitCode, 0, payload?.error?.message ?? result.stderr ?? "command failed");
  assert.ok(payload?.data !== undefined, "a --json success carries a data payload");
  return payload.data;
}

type ToolResponse = { isError?: boolean; content?: Array<{ text?: string }> };

function toolJson(result: ToolResponse): Record<string, unknown> {
  const text = result.content?.[0]?.text ?? "";
  assert.equal(result.isError, undefined, text);
  return JSON.parse(text) as Record<string, unknown>;
}

const DECISION_HANDLE = "the_decision";
const RULE_HANDLE = "the_rule";

function proposal(scopeId: string, label: string): Record<string, unknown> {
  return {
    discussion: {
      local_id: "conversation",
      type: "discussion",
      scope_id: scopeId,
      title: `${label} discussion`,
      body: `${label} was decided in conversation.`,
      status: "recorded",
      attributes: {
        medium: "chat",
        occurred_at: "2026-08-29T00:00:00.000Z",
        content_ref: `fovea://conversation/${label}`,
      },
      authored_by: "human",
    },
    proposal: {
      objects: [
        {
          local_id: DECISION_HANDLE,
          type: "decision",
          scope_id: scopeId,
          title: `${label} decision`,
          body: `${label} decision body.`,
          status: "active",
          attributes: {
            statement: `${label} is settled.`,
            rationale: "The round trip needs a decision with an origin.",
            reversibility: "cheap",
            alternatives_rejected: [],
          },
          authored_by: "ai",
        },
        {
          local_id: RULE_HANDLE,
          type: "constraint",
          scope_id: scopeId,
          title: `${label} rule`,
          body: `${label} rule body.`,
          status: "active",
          attributes: {
            rule: `${label} must hold.`,
            enforcement: "hard",
            axiomatic: false,
          },
          authored_by: "ai",
        },
      ],
      relations: [
        { source_id: DECISION_HANDLE, relation: "derives_from", target_id: "conversation" },
        { source_id: RULE_HANDLE, relation: "derives_from", target_id: DECISION_HANDLE },
      ],
    },
  };
}

async function withEngram<T>(fn: (pg: PgClient, mcp: Client) => Promise<T>): Promise<T> {
  await waitForDatabase();
  return withClient(async (pg) => {
    const server = createMcpServer(pg);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const mcp = new Client({ name: "pke-round-trip", version: "0.0.0" });
    await mcp.connect(clientTransport);
    try {
      return await fn(pg, mcp);
    } finally {
      await mcp.close();
      await server.close();
    }
  });
}

test("a proposal travels from discussion.resolve through the CLI into a pack", async () => {
  await withEngram(async (pg, mcp) => {
    const scopeId = await createProject(pg);
    const beforeResolve = await graphVersionCount(pg);

    // --- propose, over MCP ---------------------------------------------
    const resolved = toolJson(
      (await mcp.callTool({
        name: "discussion.resolve",
        arguments: proposal(scopeId, "first"),
      })) as ToolResponse,
    );
    const candidateId = String(resolved.candidate_id);
    const discussionId = String(resolved.discussion_id);
    assert.match(discussionId, /^DSC-[0-9]{4,}$/u);

    assert.equal(
      await graphVersionCount(pg),
      beforeResolve,
      "discussion.resolve records Raw evidence and a Candidate; it approves nothing",
    );
    const proposed = await pg.query(
      "SELECT id FROM knowledge_objects WHERE scope_id = $1 AND type <> 'discussion'",
      [scopeId],
    );
    assert.equal(proposed.rowCount, 0, "a pending Candidate is not in the graph");

    // --- the queue, over the CLI ---------------------------------------
    const pending = cliData(await runCli(["triage", "--status", "pending", "--json"]));
    const queued = (pending.candidates as Array<{ id: string; status: string }>).filter(
      (candidate) => candidate.id === candidateId,
    );
    assert.equal(queued.length, 1, "the proposal is not in the pending queue");
    assert.equal(queued[0]?.status, "pending");

    // --- accept, over the CLI ------------------------------------------
    const highestDecision = await highestNumberFor(pg, "DEC");
    const highestRule = await highestNumberFor(pg, "CON");
    const beforeAccept = await graphVersionCount(pg);

    const accepted = cliData(await runCli(["triage", "accept", candidateId, "--json"]));
    const assignedIds = accepted.assigned_ids as Array<{ local_id: string; id: string }>;
    const byHandle = new Map(assignedIds.map((entry) => [entry.local_id, entry.id]));
    const decisionId = byHandle.get(DECISION_HANDLE);
    const ruleId = byHandle.get(RULE_HANDLE);

    assert.ok(decisionId, "acceptance did not report an id for the decision handle");
    assert.ok(ruleId, "acceptance did not report an id for the constraint handle");
    assert.match(decisionId, /^DEC-[0-9]{4,}$/u);
    assert.match(ruleId, /^CON-[0-9]{4,}$/u);

    assert.equal(
      await graphVersionCount(pg),
      beforeAccept + 1,
      "accepting a decision and its constraint is one curation transaction",
    );

    // Ids continue the per-type sequence rather than restarting per scope
    // or per candidate.
    assert.equal(numberOf(decisionId), highestDecision + 1);
    assert.equal(numberOf(ruleId), highestRule + 1);

    // --- the graph -------------------------------------------------------
    const stored = await pg.query<{ id: string; status: string; scope_id: string }>(
      "SELECT id, status, scope_id FROM knowledge_objects WHERE id = ANY($1) ORDER BY id",
      [[decisionId, ruleId]],
    );
    assert.equal(stored.rowCount, 2);
    assert.ok(stored.rows.every((row) => row.status === "active"));
    assert.ok(stored.rows.every((row) => row.scope_id === scopeId));

    // Relations survived the local-to-real rewrite: both edges point at
    // allocated ids, and no handle is left anywhere in the graph.
    const edges = await pg.query<{ source_id: string; target_id: string }>(
      `SELECT source_id, target_id FROM relations
        WHERE relation = 'derives_from' AND source_id = ANY($1)
        ORDER BY source_id`,
      [[decisionId, ruleId]],
    );
    assert.deepEqual(
      edges.rows.map((row) => [row.source_id, row.target_id]).sort(),
      [
        [decisionId, discussionId],
        [ruleId, decisionId],
      ].sort(),
    );
    const handles = await pg.query(
      `SELECT 1 FROM relations
        WHERE source_id = ANY($1) OR target_id = ANY($1)`,
      [[DECISION_HANDLE, RULE_HANDLE, "conversation"]],
    );
    assert.equal(handles.rowCount, 0, "a local handle reached the relations table");

    // What acceptance recorded is what a later sibling accept reads back.
    const resolution = await pg.query<{
      resolution: { assignedIds?: Array<{ localId: string; id: string }> } | null;
    }>("SELECT resolution FROM candidates WHERE id = $1::uuid", [candidateId]);
    assert.deepEqual(
      resolution.rows[0]?.resolution?.assignedIds?.find(
        (entry) => entry.localId === DECISION_HANDLE,
      ),
      { localId: DECISION_HANDLE, id: decisionId },
    );

    // --- read it back in a pack, over MCP ------------------------------
    const built = toolJson(
      (await mcp.callTool({
        name: "context.build",
        arguments: { scope: scopeId, intent: "implementation", budget: 20_000 },
      })) as ToolResponse,
    );
    const pack = built.pack as { sections: Array<{ objects: Array<{ id: string }> }> };
    const packed = pack.sections.flatMap((section) => section.objects.map((object) => object.id));

    assert.ok(packed.includes(decisionId), `the decision is not in the pack: ${packed.join(", ")}`);
    assert.ok(packed.includes(ruleId), `the constraint is not in the pack: ${packed.join(", ")}`);
    assert.ok(!packed.includes(discussionId), "Raw discussion body is never pack content");

    // --- and the queue reflects it -------------------------------------
    const afterwards = cliData(await runCli(["triage", "--status", "pending", "--json"]));
    assert.ok(
      !(afterwards.candidates as Array<{ id: string }>).some(
        (candidate) => candidate.id === candidateId,
      ),
      "an accepted candidate is still queued",
    );
  });
});

test("a second acceptance continues the sequence rather than restarting it", async () => {
  await withEngram(async (pg, mcp) => {
    const scopeId = await createProject(pg);
    const allocated: string[] = [];

    for (const label of ["earlier", "later"]) {
      const resolved = toolJson(
        (await mcp.callTool({
          name: "discussion.resolve",
          arguments: proposal(scopeId, label),
        })) as ToolResponse,
      );
      const accepted = cliData(
        await runCli(["triage", "accept", String(resolved.candidate_id), "--json"]),
      );
      const assignedIds = accepted.assigned_ids as Array<{ local_id: string; id: string }>;
      const decisionId = assignedIds.find((entry) => entry.local_id === DECISION_HANDLE)?.id;
      assert.ok(decisionId);
      allocated.push(decisionId);
    }

    const [earlier, later] = allocated;
    assert.ok(earlier && later);
    assert.equal(
      numberOf(later),
      numberOf(earlier) + 1,
      `a second acceptance restarted numbering: ${earlier} then ${later}`,
    );
  });
});
