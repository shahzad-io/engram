import assert from "node:assert/strict";
import test from "node:test";
import type { Client } from "pg";
import { buildContextPack, diffStoredContextPacks } from "../dist/application/index.js";
import { curationTransaction, supersedeObject, transitionObject } from "../dist/application/write/index.js";
import type { KnowledgeObjectWrite } from "../dist/application/write/index.js";
import { runCli } from "../dist/cli.js";
import { handleGraphExpand } from "../dist/mcp/handlers.js";
import {
  constraint,
  createProject,
  decision,
  discussion,
  objectId,
  relation,
  seed,
} from "./support/graph.ts";
import { waitForDatabase, withClient } from "./support/db.ts";

/*
 * Supersession is the mechanism the whole append-only story rests on, and
 * the parts that were tested were the single hop. What was missing is what
 * a curator actually does over months: replace something twice, then read
 * the history back.
 */

type Successor = { readonly id: string; readonly write: KnowledgeObjectWrite };

function successorFor(predecessorId: string, scopeId: string): Successor {
  const id = objectId("DEC");
  return {
    id,
    write: { ...decision(id, scopeId), supersedesId: predecessorId, authoredBy: "human" },
  };
}

/** Walks `supersedes` edges from the current object back through its history. */
async function historyFrom(client: Client, startId: string): Promise<readonly string[]> {
  const trail: string[] = [startId];
  for (;;) {
    const current = trail[trail.length - 1] as string;
    const result = await client.query<{ target_id: string }>(
      `SELECT target_id FROM relations
        WHERE source_id = $1 AND relation = 'supersedes' AND target_kind = 'knowledge_object'`,
      [current],
    );
    const next = result.rows[0]?.target_id;
    if (next === undefined) return trail;
    assert.ok(trail.length < 10, `supersedes walk from ${startId} did not terminate`);
    trail.push(next);
  }
}

async function statusOf(client: Client, id: string): Promise<{
  readonly status: string;
  readonly supersededById: string | null;
  readonly supersedesId: string | null;
}> {
  const result = await client.query<{
    status: string;
    superseded_by_id: string | null;
    supersedes_id: string | null;
  }>("SELECT status, superseded_by_id, supersedes_id FROM knowledge_objects WHERE id = $1", [id]);
  const row = result.rows[0];
  assert.ok(row, `${id} is not in the graph`);
  return {
    status: row.status,
    supersededById: row.superseded_by_id,
    supersedesId: row.supersedes_id,
  };
}

test("A superseded by B superseded by C leaves one active object and a walkable history", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    const scopeId = await createProject(client, "chain");
    const originId = objectId("DSC");
    const a = objectId("DEC");
    await seed(
      client,
      [discussion(originId, scopeId), decision(a, scopeId)],
      [relation(a, "derives_from", originId)],
    );

    const b = successorFor(a, scopeId);
    await supersedeObject(client, b.write, [relation(b.id, "derives_from", originId)]);
    const c = successorFor(b.id, scopeId);
    await supersedeObject(client, c.write, [relation(c.id, "derives_from", originId)]);

    assert.deepEqual(await statusOf(client, a), {
      status: "superseded",
      supersededById: b.id,
      supersedesId: null,
    });
    assert.deepEqual(await statusOf(client, b.id), {
      status: "superseded",
      supersededById: c.id,
      supersedesId: a,
    });
    assert.deepEqual(await statusOf(client, c.id), {
      status: "active",
      supersededById: null,
      supersedesId: b.id,
    });

    // Both hops survive as edges, not only as columns: the columns say what
    // is current, the edges are what a reader traverses.
    assert.deepEqual(await historyFrom(client, c.id), [c.id, b.id, a]);

    // Nothing was rewritten on the way. The first decision still says what
    // it said, which is the only reason an old pack can be reproduced.
    const original = await client.query<{ title: string; body: string }>(
      "SELECT title, body FROM knowledge_objects WHERE id = $1",
      [a],
    );
    assert.equal(original.rows[0]?.title, a);
    assert.equal(original.rows[0]?.body, `${a} body`);
  });
});

test("a supersedes edge that closes a loop is rejected", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    const scopeId = await createProject(client, "loop");
    const originId = objectId("DSC");
    const a = objectId("DEC");
    await seed(
      client,
      [discussion(originId, scopeId), decision(a, scopeId)],
      [relation(a, "derives_from", originId)],
    );
    const b = successorFor(a, scopeId);
    await supersedeObject(client, b.write, [relation(b.id, "derives_from", originId)]);

    /*
     * `supersedes` is one of the three acyclic verbs, but only `requires`
     * had a cycle test. Written the other way round the graph claims A both
     * precedes and replaces B, and every history walk from either end runs
     * forever.
     */
    await assert.rejects(
      seed(client, [], [relation(a, "supersedes", b.id)]),
      (error: unknown) => {
        const text = `${(error as { code?: string }).code ?? ""} ${(error as Error).message}`;
        assert.match(text, /CYCLE_DETECTED/u);
        return true;
      },
    );

    // The rejection left the pair exactly as it was.
    assert.deepEqual(await historyFrom(client, b.id), [b.id, a]);
  });
});

test("a retracted object leaves packs but stays reachable through traversal", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    const scopeId = await createProject(client, "retract");
    const originId = objectId("DSC");
    const decisionId = objectId("DEC");
    const ruleId = objectId("CON");
    await seed(
      client,
      [discussion(originId, scopeId), decision(decisionId, scopeId), constraint(ruleId, scopeId)],
      [
        relation(decisionId, "derives_from", originId),
        relation(ruleId, "derives_from", decisionId),
      ],
    );

    await transitionObject(client, decisionId, "retracted");

    const pack = await buildContextPack(client, {
      scopeId,
      intent: "implementation",
      budget: 250_000,
      builtAt: new Date("2026-03-02T00:00:00.000Z"),
    });
    assert.ok(
      !pack.pack.recipe.orderedObjectIds.includes(decisionId),
      "a retracted decision must not be selected into a pack",
    );

    /*
     * Retraction says "this should never have been recorded", not "this
     * never happened". The Constraint that derives from it is flagged, not
     * cascaded, and a curator following that flag has to be able to reach
     * the thing it points at.
     */
    const shown = await runCli(["show", decisionId, "--json"]);
    assert.equal(shown.exitCode, 0, "a retracted object is still readable");
    const shownPayload = shown.payload as {
      readonly data?: { readonly object?: { readonly status?: string } };
    } | null;
    assert.equal(shownPayload?.data?.object?.status, "retracted");

    const expanded = await handleGraphExpand(client, {
      seed_object_id: decisionId,
      relation: "derives_from",
      direction: "incoming",
    });
    assert.equal(expanded.isError, undefined);
    const body = JSON.parse(expanded.content[0]?.text ?? "") as {
      readonly results: Array<{ readonly object: { readonly id: string } }>;
    };
    assert.ok(
      body.results.some((entry) => entry.object.id === ruleId),
      "the dependent constraint is still reachable from the retracted decision",
    );

    const dependent = await client.query<{ status: string; review_required: boolean }>(
      "SELECT status, review_required FROM knowledge_objects WHERE id = $1",
      [ruleId],
    );
    assert.equal(dependent.rows[0]?.status, "active", "retraction must not cascade");
    assert.equal(dependent.rows[0]?.review_required, true);
  });
});

test("a pack diff across a supersession reports the pair, not a remove and an unrelated add", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    const scopeId = await createProject(client, "packdiff");
    const originId = objectId("DSC");
    const a = objectId("DEC");
    await seed(
      client,
      [discussion(originId, scopeId), decision(a, scopeId)],
      [relation(a, "derives_from", originId)],
    );

    const before = await buildContextPack(client, {
      scopeId,
      intent: "implementation",
      budget: 250_000,
      builtAt: new Date("2026-03-01T00:00:00.000Z"),
    });

    const b = successorFor(a, scopeId);
    await supersedeObject(client, b.write, [relation(b.id, "derives_from", originId)]);

    // An unrelated arrival in the same pack, so the diff has to tell the two
    // kinds of addition apart rather than pairing whatever it finds.
    const unrelated = objectId("DEC");
    await curationTransaction(
      client,
      { action: "test.unrelated", actor: "curator" },
      async (transaction) => {
        await transaction.insertObject(decision(unrelated, scopeId));
        await transaction.insertRelation(relation(unrelated, "derives_from", originId));
      },
    );

    const after = await buildContextPack(client, {
      scopeId,
      intent: "implementation",
      budget: 250_000,
      builtAt: new Date("2026-03-02T00:00:00.000Z"),
    });

    assert.notEqual(
      before.pack.recipe.contentHash,
      after.pack.recipe.contentHash,
      "a supersession must change the pack",
    );

    const diff = await diffStoredContextPacks(client, before.id, after.id);
    assert.deepEqual(diff.superseded, [{ predecessorId: a, successorId: b.id }]);
    assert.deepEqual([...diff.added].sort(), [b.id, unrelated].sort());
    assert.deepEqual(diff.removed, [a]);
    assert.ok(
      !diff.superseded.some((pair) => pair.successorId === unrelated),
      "an unrelated addition must not be paired with the removal",
    );
  });
});
