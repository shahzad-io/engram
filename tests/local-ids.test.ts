import assert from "node:assert/strict";
import test from "node:test";
import type { Client } from "pg";
import {
  acceptCandidate,
  createCandidate,
  editAndAcceptCandidate,
} from "../dist/application/write/index.js";
import type {
  CandidateObjectWrite,
  CandidatePayload,
  RelationWrite,
} from "../dist/application/write/index.js";
import { waitForDatabase, withClient } from "./support/db.ts";

/**
 * Candidates propose objects under local handles. These tests pin what the
 * handles buy: two proposals may choose the same one, relations written against
 * them survive into the graph, and the ids Engram assigns are its own.
 */

let counter = 0;

async function project(client: Client): Promise<string> {
  counter += 1;
  const id = `local_${Date.now()}${process.pid}${counter}`;
  await client.query(
    `INSERT INTO scopes (id, kind, parent_id, name) VALUES ($1, 'project', 'global', $1)`,
    [id],
  );
  return id;
}

function decision(localId: string, scopeId: string): CandidateObjectWrite {
  return {
    localId,
    type: "decision",
    scopeId,
    title: localId,
    body: `${localId} body`,
    status: "active",
    attributes: {
      statement: `${localId} statement`,
      rationale: "test",
      reversibility: "cheap",
      alternatives_rejected: [],
    },
    authoredBy: "ai",
  };
}

function constraint(localId: string, scopeId: string): CandidateObjectWrite {
  return {
    localId,
    type: "constraint",
    scopeId,
    title: localId,
    body: `${localId} body`,
    status: "active",
    attributes: { rule: `${localId} rule`, enforcement: "hard", axiomatic: false },
    authoredBy: "ai",
  };
}

function derivesFrom(sourceId: string, targetId: string): RelationWrite {
  return { sourceId, relation: "derives_from", targetId, targetKind: "knowledge_object" };
}

async function seedDiscussion(client: Client, scopeId: string): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO knowledge_objects (
       id, type, scope_id, feature_label_ids, title, body, status, attributes,
       authored_by, valid_from_version
     )
     SELECT 'DSC-' || lpad((COALESCE(MAX(substring(id from '^DSC-([0-9]{4,9})$')::bigint), 0) + 1)::text, 4, '0'),
            'discussion', $1, ARRAY[]::text[], 'origin', 'origin body', 'recorded',
            $2::jsonb, 'ai', 1
       FROM knowledge_objects
      WHERE id ~ '^DSC-[0-9]{4,}$'
     RETURNING id`,
    [
      scopeId,
      JSON.stringify({
        medium: "chat",
        occurred_at: "2026-08-19T00:00:00.000Z",
        content_ref: "seed",
      }),
    ],
  );
  return result.rows[0]?.id as string;
}

function payload(
  objects: readonly CandidateObjectWrite[],
  relations: readonly RelationWrite[],
): CandidatePayload {
  return { objects, relations };
}

test("two candidates choosing the same local handle both accept", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    const scope = await project(client);
    const origin = await seedDiscussion(client, scope);

    const first = await createCandidate(client, {
      payload: payload([decision("decision", scope)], [derivesFrom("decision", origin)]),
    });
    const second = await createCandidate(client, {
      payload: payload([decision("decision", scope)], [derivesFrom("decision", origin)]),
    });

    const firstResult = await acceptCandidate(client, first[0] as string);
    const secondResult = await acceptCandidate(client, second[0] as string);

    const [firstId] = firstResult.objectIds;
    const [secondId] = secondResult.objectIds;
    assert.match(String(firstId), /^DEC-[0-9]{4,}$/u);
    assert.match(String(secondId), /^DEC-[0-9]{4,}$/u);
    assert.notEqual(firstId, secondId);
    assert.deepEqual(firstResult.assignedIds, [{ localId: "decision", id: firstId as string }]);

    const rows = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM knowledge_objects WHERE id = ANY($1::text[])",
      [[firstId, secondId]],
    );
    assert.equal(rows.rows[0]?.count, "2");
  });
});

test("relations survive the rewrite from local handles to assigned ids", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    const scope = await project(client);
    const origin = await seedDiscussion(client, scope);

    const candidates = await createCandidate(client, {
      payload: payload(
        [decision("the_decision", scope), constraint("the_rule", scope)],
        [derivesFrom("the_decision", origin), derivesFrom("the_rule", "the_decision")],
      ),
    });
    const result = await acceptCandidate(client, candidates[0] as string);

    const assigned = new Map(result.assignedIds.map((entry) => [entry.localId, entry.id]));
    const decisionId = assigned.get("the_decision") as string;
    const ruleId = assigned.get("the_rule") as string;
    assert.match(decisionId, /^DEC-[0-9]{4,}$/u);
    assert.match(ruleId, /^CON-[0-9]{4,}$/u);

    const edges = await client.query<{ source_id: string; target_id: string }>(
      `SELECT source_id, target_id
       FROM relations
       WHERE source_id = ANY($1::text[])
       ORDER BY source_id`,
      [[decisionId, ruleId]],
    );
    assert.deepEqual(
      [...edges.rows].sort((left, right) => left.source_id.localeCompare(right.source_id)),
      [
        { source_id: ruleId, target_id: decisionId },
        { source_id: decisionId, target_id: origin },
      ].sort((left, right) => left.source_id.localeCompare(right.source_id)),
    );
    const dangling = await client.query(
      "SELECT id FROM relations WHERE source_id LIKE 'the\\_%' OR target_id LIKE 'the\\_%'",
    );
    assert.equal(dangling.rowCount, 0);
  });
});

test("a sibling accepted later resolves a handle the first acceptance assigned", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    const scope = await project(client);
    const origin = await seedDiscussion(client, scope);

    const candidates = await createCandidate(client, {
      elements: [
        {
          object: decision("the_decision", scope),
          relations: [derivesFrom("the_decision", origin)],
        },
        {
          object: constraint("the_rule", scope),
          relations: [derivesFrom("the_rule", "the_decision")],
        },
      ],
    });
    const first = await acceptCandidate(client, candidates[0] as string, [candidates[0] as string]);
    const decisionId = first.objectIds[0] as string;
    const second = await acceptCandidate(client, candidates[1] as string);
    const ruleId = second.objectIds[0] as string;

    const edge = await client.query<{ target_id: string }>(
      "SELECT target_id FROM relations WHERE source_id = $1",
      [ruleId],
    );
    assert.deepEqual(
      edge.rows.map((row) => row.target_id),
      [decisionId],
      "the constraint's origin must be the id the earlier acceptance assigned",
    );
  });
});

test("a curator may edit an element's content but not its handle", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    const scope = await project(client);
    const origin = await seedDiscussion(client, scope);
    const candidates = await createCandidate(client, {
      payload: payload([decision("decision", scope)], [derivesFrom("decision", origin)]),
    });
    const candidateId = candidates[0] as string;

    await assert.rejects(
      editAndAcceptCandidate(
        client,
        candidateId,
        payload([decision("renamed", scope)], [derivesFrom("renamed", origin)]),
      ),
      /must keep each selected element id and type/u,
    );

    const edited = {
      ...decision("decision", scope),
      body: "an edited body",
    };
    const result = await editAndAcceptCandidate(
      client,
      candidateId,
      payload([edited], [derivesFrom("decision", origin)]),
    );
    const row = await client.query<{ body: string; authored_by: string }>(
      "SELECT body, authored_by FROM knowledge_objects WHERE id = $1",
      [result.objectIds[0]],
    );
    assert.equal(row.rows[0]?.body, "an edited body");
    assert.equal(row.rows[0]?.authored_by, "human");
  });
});
