import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { acceptCandidate, importBackfill } from "../dist/application/index.js";
import { resolveDiscussion } from "../dist/application/propose/resolve-discussion.js";
import { waitForDatabase, withFreshThrowawayDatabase } from "./support/db.ts";

const BEACON_DIRECTORY = "backfill/beacon";

function proposal(marker: string) {
  return {
    discussion: {
      localId: "conversation",
      type: "discussion" as const,
      scopeId: "project_beacon",
      title: `Concurrent ${marker}`,
      body: "body",
      status: "recorded",
      attributes: {
        medium: "chat",
        occurredAt: "2026-08-24T00:00:00.000Z",
        contentRef: `blob://${marker}`,
      },
      authoredBy: "ai" as const,
    },
    proposal: {
      objects: [
        {
          localId: "decision",
          type: "decision" as const,
          scopeId: "project_beacon",
          title: `Decision ${marker}`,
          body: "body",
          status: "active",
          attributes: {
            statement: "statement",
            rationale: "rationale",
            reversibility: "cheap",
            alternativesRejected: [],
          },
          authoredBy: "ai" as const,
        },
      ],
      relations: [
        {
          sourceId: "decision",
          relation: "derives_from" as const,
          targetId: "conversation",
          targetKind: "knowledge_object" as const,
        },
      ],
    },
  };
}

/**
 * Two sessions resolving at the same moment is the case that made caller-supplied
 * ids unsatisfiable: neither caller could have known which number was free. The
 * allocator serialises on an advisory lock held for the transaction, so the
 * second proposal waits rather than racing the first to the same primary key.
 */
test("two concurrent proposals cannot collide on a discussion id", async () => {
  await waitForDatabase();
  await withFreshThrowawayDatabase(async (client, connectionString) => {
    await importBackfill(client, BEACON_DIRECTORY);
    const other = new Client({ connectionString });
    await other.connect();
    try {
      const [first, second] = await Promise.all([
        resolveDiscussion(client, proposal("01")),
        resolveDiscussion(other, proposal("02")),
      ]);
      assert.notEqual(first.discussionId, second.discussionId);
      for (const id of [first.discussionId, second.discussionId]) {
        assert.match(id, /^DSC-[0-9]{4,}$/u);
      }
      const stored = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM knowledge_objects WHERE id = ANY($1::text[])",
        [[first.discussionId, second.discussionId]],
      );
      assert.equal(stored.rows[0]?.count, "2");
    } finally {
      await other.end();
    }
  });
});

test("an allocated id continues the existing sequence rather than restarting it", async () => {
  await waitForDatabase();
  await withFreshThrowawayDatabase(async (client) => {
    await importBackfill(client, BEACON_DIRECTORY);
    const highest = await client.query<{ id: string }>(
      "SELECT id FROM knowledge_objects WHERE type = 'discussion' ORDER BY id DESC LIMIT 1",
    );
    const previous = Number((highest.rows[0]?.id ?? "DSC-0000").slice(4));
    const result = await resolveDiscussion(client, proposal("03"));
    assert.equal(result.discussionId, `DSC-${String(previous + 1).padStart(4, "0")}`);
  });
});

test("a proposal survives the whole loop: handles at rest, ids in the graph", async () => {
  await waitForDatabase();
  await withFreshThrowawayDatabase(async (client) => {
    await importBackfill(client, BEACON_DIRECTORY);
    const resolved = await resolveDiscussion(client, proposal("06"));
    assert.deepEqual(resolved.validation.localIds, ["decision"]);

    const stored = await client.query<{
      payload: { objects: Array<{ id?: string; localId?: string }> };
    }>("SELECT payload FROM candidates WHERE id = $1::uuid", [resolved.candidateId]);
    const proposedObject = stored.rows[0]?.payload.objects[0];
    assert.equal(proposedObject?.localId, "decision");
    assert.equal(proposedObject?.id, undefined, "a pending Candidate holds no graph id");

    const accepted = await acceptCandidate(client, resolved.candidateId);
    const decisionId = accepted.objectIds[0] as string;
    assert.match(decisionId, /^DEC-[0-9]{4,}$/u);

    const edge = await client.query<{ target_id: string }>(
      "SELECT target_id FROM relations WHERE source_id = $1 AND relation = 'derives_from'",
      [decisionId],
    );
    assert.deepEqual(
      edge.rows.map((row) => row.target_id),
      [resolved.discussionId],
      "the decision's origin is the discussion Engram allocated at proposal time",
    );
  });
});

test("a failed proposal does not leave its discussion behind", async () => {
  await waitForDatabase();
  await withFreshThrowawayDatabase(async (client) => {
    await importBackfill(client, BEACON_DIRECTORY);
    const before = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM knowledge_objects WHERE type = 'discussion'",
    );
    const orphan = proposal("04");
    await assert.rejects(
      resolveDiscussion(client, { ...orphan, proposal: { ...orphan.proposal, relations: [] } }),
    );
    const after = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM knowledge_objects WHERE type = 'discussion'",
    );
    assert.equal(after.rows[0]?.count, before.rows[0]?.count);
    const next = await resolveDiscussion(client, proposal("05"));
    assert.match(next.discussionId, /^DSC-[0-9]{4,}$/u);
  });
});
