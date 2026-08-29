import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../dist/mcp/server.js";
import { withFreshThrowawayDatabase } from "./support/db.ts";

/*
 * Every payload in the fixture is a real `discussion.resolve` call made by a
 * model against Engram, recovered verbatim from Fovea's `tool_calls` table.
 * Twelve were rejected, four were accepted, and one was refused by the curator
 * before it left Fovea.
 *
 * These assert properties rather than error codes. The codes the attempts
 * originally received are recorded in the fixture for provenance, but none of
 * them is reachable any more: the schema now catches all twelve at the MCP
 * boundary, which is the fix these attempts paid for. Pinning the old codes
 * would pin the defect. Pinning the response text would fail on rewording, so
 * it would fire on improvements as often as regressions.
 */

const FIXTURE = "tests/fixtures/historical-resolve-attempts.json";

type Attempt = {
  readonly ordinal: number;
  readonly recordedAt: string;
  readonly callId: string;
  readonly defect: string;
  readonly outcome: "rejected" | "accepted" | "not_run";
  readonly historicalCode: string | null;
  readonly historicalResponse: string | null;
  readonly leakedConstraintText: boolean;
  readonly mustName: readonly string[];
  readonly arguments: Record<string, unknown>;
};

/*
 * Attempts 8 and 11 were answered with raw Postgres text: the model was told
 * `new row for relation "knowledge_objects" violates check constraint
 * "knowledge_objects_attribute_keys"`, which names an internal constraint and
 * says nothing a caller can act on. `leaksPostgres` is the guard against that
 * returning, and the negative control below proves it still recognises the two
 * responses that provoked it.
 */
const POSTGRES_LEAK_PATTERNS: readonly RegExp[] = [
  /new row for relation/iu,
  /violates check constraint/iu,
  /violates foreign key constraint/iu,
  /duplicate key value/iu,
  /null value in column/iu,
  /invalid input syntax for type/iu,
  /knowledge_objects_[a-z_]+/u,
  /relation "[a-z_]+" does not exist/iu,
];

function leaksPostgres(text: string): readonly string[] {
  return POSTGRES_LEAK_PATTERNS.filter((pattern) => pattern.test(text)).map(String);
}

type Counts = {
  readonly knowledgeObjects: number;
  readonly candidates: number;
  readonly relations: number;
  readonly graphVersions: number;
};

async function countRows(client: import("pg").Client): Promise<Counts> {
  const result = await client.query<{
    knowledge_objects: string;
    candidates: string;
    relations: string;
    graph_versions: string;
  }>(
    `SELECT (SELECT count(*) FROM knowledge_objects)::text AS knowledge_objects,
            (SELECT count(*) FROM candidates)::text AS candidates,
            (SELECT count(*) FROM relations)::text AS relations,
            (SELECT count(*) FROM graph_versions)::text AS graph_versions`,
  );
  const row = result.rows[0];
  assert.ok(row);
  return {
    knowledgeObjects: Number(row.knowledge_objects),
    candidates: Number(row.candidates),
    relations: Number(row.relations),
    graphVersions: Number(row.graph_versions),
  };
}

type Reply = {
  readonly attempt: Attempt;
  readonly isError: boolean;
  readonly text: string;
  readonly before: Counts;
  readonly after: Counts;
};

/*
 * One database and one server for all seventeen replays. A rejected payload
 * writes nothing, so replaying them in recorded order cannot contaminate the
 * ones that follow, and provisioning a database per attempt would cost more
 * than the rest of the gate put together.
 */
async function replayAttempts(attempts: readonly Attempt[]): Promise<readonly Reply[]> {
  return withFreshThrowawayDatabase(async (pg) => {
    await pg.query(
      `INSERT INTO scopes (id, kind, parent_id, name)
       VALUES ('project_fovea', 'project', 'global', 'Fovea')`,
    );
    await pg.query(
      "INSERT INTO graph_versions (action, actor, object_ids) VALUES ($1, $2, ARRAY[]::text[])",
      ["historical-attempts.bootstrap", "system"],
    );

    const server = createMcpServer(pg);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const mcp = new Client({ name: "pke-historical-attempts", version: "0.0.0" });
    await mcp.connect(clientTransport);

    try {
      const replies: Reply[] = [];
      for (const attempt of attempts) {
        const before = await countRows(pg);
        const result = (await mcp.callTool({
          name: "discussion.resolve",
          arguments: attempt.arguments,
        })) as { isError?: boolean; content?: Array<{ text?: string }> };
        const after = await countRows(pg);
        replies.push({
          attempt,
          isError: result.isError === true,
          text: result.content?.[0]?.text ?? "",
          before,
          after,
        });
      }
      return replies;
    } finally {
      await mcp.close();
      await server.close();
    }
  });
}

const fixture = JSON.parse(await readFile(FIXTURE, "utf8")) as { entries: Attempt[] };
const attempts = fixture.entries;
// The curator refused attempt 15 in Fovea, so Engram never saw it. It stays in
// the fixture as part of the record but proves nothing about Engram.
const replayable = attempts.filter((attempt) => attempt.outcome !== "not_run");

test("the twelve historical discussion.resolve attempts stay rejected", async (t) => {
  assert.equal(
    attempts.filter((attempt) => attempt.outcome === "rejected").length,
    12,
    "the fixture holds every rejected attempt recovered from Fovea",
  );

  const replies = await replayAttempts(replayable);
  const rejected = replies.filter((reply) => reply.attempt.outcome === "rejected");
  const accepted = replies.filter((reply) => reply.attempt.outcome === "accepted");

  await t.test("every payload that failed then still fails now", () => {
    for (const reply of rejected) {
      assert.equal(
        reply.isError,
        true,
        `attempt ${reply.attempt.ordinal} (${reply.attempt.defect}) is accepted now`,
      );
    }
  });

  await t.test("one response names every problem, not the first", () => {
    for (const reply of rejected) {
      const unnamed = reply.attempt.mustName.filter((path) => !reply.text.includes(path));
      assert.deepEqual(
        unnamed,
        [],
        `attempt ${reply.attempt.ordinal} left ${unnamed.length} of ${reply.attempt.mustName.length} problems unnamed, so the caller cannot fix them in one round trip`,
      );
    }
  });

  await t.test("no response exposes Postgres constraint text", () => {
    for (const reply of replies) {
      assert.deepEqual(
        leaksPostgres(reply.text),
        [],
        `attempt ${reply.attempt.ordinal} answered with internal database text: ${reply.text}`,
      );
    }
  });

  await t.test("a rejected payload writes nothing", () => {
    for (const reply of rejected) {
      assert.deepEqual(
        reply.after,
        reply.before,
        `attempt ${reply.attempt.ordinal} left rows behind`,
      );
    }
  });

  await t.test("the corrected payload succeeds on its first attempt", () => {
    const first = accepted[0];
    assert.ok(first);
    assert.equal(first.attempt.ordinal, 13);
    assert.equal(first.isError, false, first.text);
    const body = JSON.parse(first.text) as { discussion_id?: string; candidate_id?: string };
    assert.match(String(body.discussion_id), /^DSC-[0-9]{4,}$/u);
    assert.equal(typeof body.candidate_id, "string");
  });

  await t.test("accepting a proposal records a discussion and no graph version", () => {
    for (const reply of accepted) {
      assert.equal(reply.isError, false, `attempt ${reply.attempt.ordinal}: ${reply.text}`);
      assert.equal(
        reply.after.knowledgeObjects - reply.before.knowledgeObjects,
        1,
        `attempt ${reply.attempt.ordinal} should persist the discussion and nothing else`,
      );
      assert.equal(
        reply.after.candidates - reply.before.candidates,
        1,
        `attempt ${reply.attempt.ordinal} should hold the proposal as one candidate`,
      );
      assert.equal(
        reply.after.graphVersions,
        reply.before.graphVersions,
        `attempt ${reply.attempt.ordinal} advanced the graph version, but nothing was approved`,
      );
    }
  });
});

/*
 * Without this the leak guard could rot into a test that passes because it
 * recognises nothing. The two responses it is checked against are the ones
 * Engram actually sent.
 */
test("the Postgres leak guard recognises the responses that provoked it", () => {
  const leaked = attempts.filter((attempt) => attempt.leakedConstraintText);
  assert.deepEqual(
    leaked.map((attempt) => attempt.ordinal),
    [8, 11],
  );
  for (const attempt of leaked) {
    assert.ok(attempt.historicalResponse);
    assert.notDeepEqual(
      leaksPostgres(attempt.historicalResponse),
      [],
      `attempt ${attempt.ordinal} leaked constraint text that the guard no longer recognises`,
    );
  }
  for (const attempt of attempts.filter((entry) => !entry.leakedConstraintText)) {
    if (attempt.historicalResponse === null) continue;
    assert.deepEqual(
      leaksPostgres(attempt.historicalResponse),
      [],
      `attempt ${attempt.ordinal} is not a leak and the guard should not claim it is`,
    );
  }
});
