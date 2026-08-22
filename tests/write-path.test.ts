import assert from "node:assert/strict";
import test from "node:test";
import type { Client } from "pg";
import {
  acceptCandidate,
  createCandidate,
  curationTransaction,
  editAndAcceptCandidate,
  mergeCandidate,
  relabelFeatureLabels,
  rejectCandidate,
  verifyObject,
} from "../dist/application/write/index.js";
import type {
  CandidatePayload,
  FeatureLabelAssignment,
  FeatureLabelWrite,
  KnowledgeObjectWrite,
  RelationWrite,
} from "../dist/application/write/index.js";
import { waitForDatabase, withClient } from "./support/db.ts";

let uniqueCounter = 0;

function uniqueDigits(): string {
  uniqueCounter += 1;
  return `${Date.now()}${process.pid}${uniqueCounter}`;
}

function objectId(prefix: string): string {
  return `${prefix}-${uniqueDigits()}`;
}

function scopeId(): string {
  return `write_${uniqueDigits()}`;
}

async function createProject(client: Client): Promise<string> {
  const id = scopeId();
  await client.query(
    `INSERT INTO scopes (id, kind, parent_id, name)
     VALUES ($1, 'project', 'global', $1)`,
    [id],
  );
  return id;
}

function requirement(
  id: string,
  scopeIdValue: string,
  authoredBy: "human" | "ai" = "human",
): KnowledgeObjectWrite {
  return {
    id,
    type: "requirement",
    scopeId: scopeIdValue,
    title: id,
    body: `${id} body`,
    status: "active",
    attributes: { source: "test", rationale: "test" },
    authoredBy,
  };
}

function discussion(id: string, scopeIdValue: string): KnowledgeObjectWrite {
  return {
    id,
    type: "discussion",
    scopeId: scopeIdValue,
    title: id,
    body: `${id} body`,
    status: "recorded",
    attributes: {
      medium: "chat",
      occurred_at: "2026-08-19T00:00:00.000Z",
      content_ref: id,
    },
    authoredBy: "ai",
  };
}

function decision(
  id: string,
  scopeIdValue: string,
  authoredBy: "human" | "ai" = "ai",
): KnowledgeObjectWrite {
  return {
    id,
    type: "decision",
    scopeId: scopeIdValue,
    title: id,
    body: `${id} body`,
    status: "active",
    attributes: {
      statement: `${id} statement`,
      rationale: "test",
      reversibility: "cheap",
      alternatives_rejected: [],
    },
    authoredBy,
  };
}

function constraint(id: string, scopeIdValue: string): KnowledgeObjectWrite {
  return {
    id,
    type: "constraint",
    scopeId: scopeIdValue,
    title: id,
    body: `${id} body`,
    status: "active",
    attributes: { rule: `${id} rule`, enforcement: "hard", axiomatic: false },
    authoredBy: "ai",
  };
}

function glossary(id: string, scopeIdValue: string): KnowledgeObjectWrite {
  return {
    id,
    type: "glossary_entry",
    scopeId: scopeIdValue,
    title: id,
    body: `${id} body`,
    status: "active",
    attributes: { term: id.toLowerCase(), definition: "test definition", axiomatic: false },
    authoredBy: "ai",
  };
}

function openQuestion(id: string, scopeIdValue: string): KnowledgeObjectWrite {
  return {
    id,
    type: "open_question",
    scopeId: scopeIdValue,
    title: id,
    body: `${id} body`,
    status: "open",
    attributes: { question: `${id}?`, blocking: true },
    authoredBy: "human",
  };
}

function relation(
  sourceId: string,
  relationName: RelationWrite["relation"],
  targetId: string,
): RelationWrite {
  return {
    sourceId,
    relation: relationName,
    targetId,
    targetKind: "knowledge_object",
  };
}

async function seed(
  client: Client,
  objects: readonly KnowledgeObjectWrite[],
  relations: readonly RelationWrite[] = [],
): Promise<number> {
  const result = await curationTransaction(
    client,
    { action: "test.seed", actor: "curator" },
    async (transaction) => {
      for (const object of objects) {
        await transaction.insertObject(object);
      }
      for (const edge of relations) {
        await transaction.insertRelation(edge);
      }
      return undefined;
    },
  );
  return result.version;
}

async function graphVersionCount(client: Client): Promise<number> {
  const result = await client.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM graph_versions",
  );
  return Number(result.rows[0]?.count ?? 0);
}

test("relabeling is a curation transaction and does not supersede the object", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    const project = await createProject(client);
    const requirementId = objectId("REQ");
    await seed(client, [requirement(requirementId, project)]);
    const beforeResult = await client.query<{ version: string | null }>(
      "SELECT max(version)::text AS version FROM graph_versions",
    );
    const before = Number(beforeResult.rows[0]?.version ?? 0);
    const labelId = objectId("FTL");
    const labels: readonly FeatureLabelWrite[] = [
      {
        id: labelId,
        projectScopeId: project,
        canonicalName: `test-${uniqueDigits()}`,
      },
    ];
    const assignments: readonly FeatureLabelAssignment[] = [
      { objectId: requirementId, featureLabelIds: [labelId] },
    ];

    const result = await relabelFeatureLabels(client, labels, assignments);

    assert.equal(result.version, before + 1);
    const object = await client.query<{
      feature_label_ids: string[];
      superseded_by_id: string | null;
      lock_version: number;
    }>(
      `SELECT feature_label_ids, superseded_by_id, lock_version
       FROM knowledge_objects
       WHERE id = $1`,
      [requirementId],
    );
    assert.deepEqual(object.rows[0], {
      feature_label_ids: [labelId],
      superseded_by_id: null,
      lock_version: 1,
    });
    const version = await client.query<{ object_ids: string[]; backfill_mode: boolean }>(
      "SELECT object_ids, backfill_mode FROM graph_versions WHERE version = $1",
      [result.version],
    );
    assert.deepEqual(version.rows[0], {
      object_ids: [labelId, requirementId],
      backfill_mode: false,
    });
  });
});

function candidatePayload(
  objects: readonly KnowledgeObjectWrite[],
  relations: readonly RelationWrite[] = [],
): CandidatePayload {
  return { objects, relations };
}

test("a failed curation transaction leaves no row, edge, or graph version", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    const project = await createProject(client);
    const requirementId = objectId("REQ");
    const discussionId = objectId("DSC");
    const before = await graphVersionCount(client);

    await assert.rejects(
      curationTransaction(
        client,
        { action: "test.invalid", actor: "curator" },
        async (transaction) => {
          await transaction.insertObject(requirement(requirementId, project));
          await transaction.insertObject(discussion(discussionId, project));
          await transaction.insertRelation(relation(requirementId, "blocks", discussionId));
        },
      ),
      /ILLEGAL_RELATION/u,
    );

    assert.equal(await graphVersionCount(client), before);
    const rows = await client.query(
      `SELECT id
       FROM knowledge_objects
       WHERE id IN ($1, $2)`,
      [requirementId, discussionId],
    );
    assert.equal(rows.rowCount, 0);
    const edges = await client.query(
      "SELECT id FROM relations WHERE source_id = $1 OR target_id = $1",
      [requirementId],
    );
    assert.equal(edges.rowCount, 0);
  });
});

test("accepting a multi-element Candidate creates one graph version", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    const project = await createProject(client);
    const originId = objectId("DSC");
    await seed(client, [discussion(originId, project)]);

    const decisionId = objectId("DEC");
    const constraintId = objectId("CON");
    const glossaryId = objectId("GLO");
    const payload = candidatePayload(
      [
        decision(decisionId, project),
        constraint(constraintId, project),
        glossary(glossaryId, project),
      ],
      [
        relation(decisionId, "derives_from", originId),
        relation(constraintId, "derives_from", decisionId),
      ],
    );
    const candidateIds = await createCandidate(client, { payload, proposedBy: "ai" });
    const before = await graphVersionCount(client);

    const result = await acceptCandidate(client, candidateIds[0] as string, [
      candidateIds[0] as string,
      candidateIds[1] as string,
    ]);

    assert.equal(await graphVersionCount(client), before + 1);
    assert.equal(result.version > 0, true);
    assert.deepEqual(new Set(result.objectIds), new Set([decisionId, constraintId]));
    const accepted = await client.query<{ id: string; status: string }>(
      "SELECT id, status FROM candidates WHERE id = ANY($1::uuid[]) ORDER BY id",
      [candidateIds],
    );
    assert.equal(accepted.rowCount, 3);
    assert.deepEqual(
      new Map(accepted.rows.map((row) => [row.id, row.status])),
      new Map([
        [candidateIds[0] as string, "accepted"],
        [candidateIds[1] as string, "accepted"],
        [candidateIds[2] as string, "pending"],
      ]),
    );
    const arrived = await client.query<{ id: string; valid_from_version: string }>(
      `SELECT id, valid_from_version
       FROM knowledge_objects
       WHERE id = ANY($1::text[])`,
      [[decisionId, constraintId]],
    );
    assert.equal(arrived.rowCount, 2);
    assert.deepEqual(
      new Set(arrived.rows.map((row) => Number(row.valid_from_version))),
      new Set([result.version]),
    );

    await rejectCandidate(client, candidateIds[2] as string);
    assert.equal(await graphVersionCount(client), before + 1);
    const rejected = await client.query<{ status: string }>(
      "SELECT status FROM candidates WHERE id = $1::uuid",
      [candidateIds[2]],
    );
    assert.equal(rejected.rows[0]?.status, "rejected");
  });
});

test("verify updates the object without creating a version or cascading", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    const project = await createProject(client);
    const originId = objectId("DSC");
    const decisionId = objectId("DEC");
    const constraintId = objectId("CON");
    await seed(
      client,
      [
        discussion(originId, project),
        decision(decisionId, project),
        constraint(constraintId, project),
      ],
      [
        relation(decisionId, "derives_from", originId),
        relation(constraintId, "derives_from", decisionId),
      ],
    );
    await curationTransaction(
      client,
      { action: "test.flag", actor: "curator" },
      async (transaction) => {
        await transaction.client.query(
          `UPDATE knowledge_objects
           SET review_required = true
           WHERE id IN ($1, $2)`,
          [decisionId, constraintId],
        );
        transaction.addGraphIdentity(decisionId);
        transaction.addGraphIdentity(constraintId);
      },
    );
    const before = await graphVersionCount(client);
    const oldConstraint = await client.query<{
      last_verified_at: Date;
      review_required: boolean;
    }>("SELECT last_verified_at, review_required FROM knowledge_objects WHERE id = $1", [
      constraintId,
    ]);

    const result = await verifyObject(client, decisionId, new Date("2026-08-19T12:00:00.000Z"));

    assert.equal(await graphVersionCount(client), before);
    assert.equal(result.object.review_required, false);
    assert.deepEqual(
      result.alsoReview.map((object) => object.id),
      [constraintId],
    );
    const afterConstraint = await client.query<{
      last_verified_at: Date;
      review_required: boolean;
    }>("SELECT last_verified_at, review_required FROM knowledge_objects WHERE id = $1", [
      constraintId,
    ]);
    assert.equal(afterConstraint.rows[0]?.review_required, oldConstraint.rows[0]?.review_required);
    assert.equal(
      afterConstraint.rows[0]?.last_verified_at.getTime(),
      oldConstraint.rows[0]?.last_verified_at.getTime(),
    );
  });
});

test("merge supersedes without in-place editing and migrates only blocks", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    const project = await createProject(client);
    const oldOriginId = objectId("DSC");
    const newOriginId = objectId("DSC");
    const oldDecisionId = objectId("DEC");
    const newDecisionId = objectId("DEC");
    const blockerId = objectId("OQU");
    await seed(
      client,
      [
        discussion(oldOriginId, project),
        discussion(newOriginId, project),
        decision(oldDecisionId, project, "human"),
        openQuestion(blockerId, project),
      ],
      [
        relation(oldDecisionId, "derives_from", oldOriginId),
        relation(oldDecisionId, "references", oldOriginId),
        relation(blockerId, "blocks", oldDecisionId),
      ],
    );

    const candidateIds = await createCandidate(client, {
      payload: candidatePayload(
        [decision(newDecisionId, project)],
        [relation(newDecisionId, "derives_from", newOriginId)],
      ),
      proposedBy: "ai",
    });
    const result = await mergeCandidate(client, candidateIds[0] as string, oldDecisionId);

    const predecessor = await client.query<{
      status: string;
      superseded_by_id: string;
      valid_to_version: string;
      body: string;
    }>(
      `SELECT status, superseded_by_id, valid_to_version, body
       FROM knowledge_objects
       WHERE id = $1`,
      [oldDecisionId],
    );
    assert.deepEqual(predecessor.rows[0], {
      status: "superseded",
      superseded_by_id: newDecisionId,
      valid_to_version: String(result.version),
      body: `${oldDecisionId} body`,
    });
    const successor = await client.query<{
      supersedes_id: string;
      authored_by: string;
      status: string;
    }>("SELECT supersedes_id, authored_by, status FROM knowledge_objects WHERE id = $1", [
      newDecisionId,
    ]);
    assert.deepEqual(successor.rows[0], {
      supersedes_id: oldDecisionId,
      authored_by: "ai",
      status: "active",
    });

    const blocks = await client.query<{ target_id: string; valid_to_version: string | null }>(
      `SELECT target_id, valid_to_version
       FROM relations
       WHERE source_id = $1
         AND relation = 'blocks'
       ORDER BY id`,
      [blockerId],
    );
    assert.deepEqual(blocks.rows, [
      { target_id: oldDecisionId, valid_to_version: String(result.version) },
      { target_id: newDecisionId, valid_to_version: null },
    ]);

    const oldEvidence = await client.query<{
      relation: string;
      target_id: string;
      valid_to_version: string | null;
    }>(
      `SELECT relation, target_id, valid_to_version
       FROM relations
       WHERE source_id = $1
         AND relation IN ('derives_from', 'references')`,
      [oldDecisionId],
    );
    assert.deepEqual(
      oldEvidence.rows.sort((a, b) => a.relation.localeCompare(b.relation)),
      [
        { relation: "derives_from", target_id: oldOriginId, valid_to_version: null },
        { relation: "references", target_id: oldOriginId, valid_to_version: null },
      ],
    );
    const copiedEvidence = await client.query(
      `SELECT id
       FROM relations
       WHERE source_id = $1
         AND relation = 'references'`,
      [newDecisionId],
    );
    assert.equal(copiedEvidence.rowCount, 0);
    const successorOrigins = await client.query<{ target_id: string }>(
      `SELECT target_id
       FROM relations
       WHERE source_id = $1
         AND relation = 'derives_from'`,
      [newDecisionId],
    );
    assert.deepEqual(successorOrigins.rows, [{ target_id: newOriginId }]);
  });
});

test("two objects superseding one target fail with SUPERSESSION_CONFLICT", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    const project = await createProject(client);
    const targetId = objectId("REQ");
    await seed(client, [requirement(targetId, project)]);

    const firstId = objectId("REQ");
    const secondId = objectId("REQ");
    const firstCandidate = await createCandidate(client, {
      payload: candidatePayload([requirement(firstId, project)]),
    });
    const secondCandidate = await createCandidate(client, {
      payload: candidatePayload([requirement(secondId, project)]),
    });
    await mergeCandidate(client, firstCandidate[0] as string, targetId);
    const before = await graphVersionCount(client);

    let caught: unknown;
    try {
      await mergeCandidate(client, secondCandidate[0] as string, targetId);
    } catch (error) {
      caught = error;
    }

    assert.equal((caught as { code?: string } | undefined)?.code, "SUPERSESSION_CONFLICT");
    assert.equal(await graphVersionCount(client), before);
    const rows = await client.query("SELECT id FROM knowledge_objects WHERE id = $1", [secondId]);
    assert.equal(rows.rowCount, 0);
    const candidate = await client.query<{ status: string }>(
      "SELECT status FROM candidates WHERE id = $1::uuid",
      [secondCandidate[0]],
    );
    assert.equal(candidate.rows[0]?.status, "pending");
  });
});

test("edit-and-accept changes authorship for content edits but not filing edits", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    const contentScope = await createProject(client);
    const filingScope = await createProject(client);
    const contentId = objectId("REQ");
    const contentCandidate = await createCandidate(client, {
      payload: candidatePayload([requirement(contentId, contentScope, "ai")]),
      proposedBy: "ai",
    });
    await editAndAcceptCandidate(client, contentCandidate[0] as string, {
      objects: [{ ...requirement(contentId, contentScope, "ai"), body: "curator edited body" }],
      relations: [],
    });

    const filingId = objectId("REQ");
    const original = requirement(filingId, contentScope, "ai");
    const filingCandidate = await createCandidate(client, {
      payload: candidatePayload([original]),
      proposedBy: "ai",
    });
    await editAndAcceptCandidate(client, filingCandidate[0] as string, {
      objects: [{ ...original, scopeId: filingScope }],
      relations: [],
    });

    const rows = await client.query<{ id: string; authored_by: string; scope_id: string }>(
      `SELECT id, authored_by, scope_id
       FROM knowledge_objects
       WHERE id IN ($1, $2)
       ORDER BY id`,
      [contentId, filingId],
    );
    assert.deepEqual(rows.rows, [
      { id: contentId, authored_by: "human", scope_id: contentScope },
      { id: filingId, authored_by: "ai", scope_id: filingScope },
    ]);
  });
});

test("reject keeps a Candidate out of the graph and creates no version", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    const project = await createProject(client);
    const candidateId = await createCandidate(client, {
      payload: candidatePayload([requirement(objectId("REQ"), project)]),
    });
    const before = await graphVersionCount(client);

    await rejectCandidate(client, candidateId[0] as string);

    assert.equal(await graphVersionCount(client), before);
    const candidate = await client.query<{ status: string }>(
      "SELECT status FROM candidates WHERE id = $1::uuid",
      [candidateId[0]],
    );
    assert.equal(candidate.rows[0]?.status, "rejected");
  });
});

test("retract removes a mis-captured object from packs without deleting it", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    const project = await createProject(client);
    const discussionId = objectId("DSC");
    const decisionId = objectId("DEC");
    await curationTransaction(client, { action: "retract-test.setup" }, async (tx) => {
      await tx.insertObject(discussion(discussionId, project), "human");
      await tx.insertObject(decision(decisionId, project, "human"), "human");
      await tx.insertRelation({
        sourceId: decisionId,
        relation: "derives_from",
        targetId: discussionId,
        targetKind: "knowledge_object",
      });
    });
    const retract = await curationTransaction(client, { action: "retract-mis-capture" }, async (tx) => {
      await tx.transition(decisionId, "retracted");
    });
    const row = await client.query<{ status: string; valid_to_version: number | null }>(
      "SELECT status, valid_to_version FROM knowledge_objects WHERE id = $1",
      [decisionId],
    );
    assert.equal(row.rows[0]?.status, "retracted");
    assert.equal(Number(row.rows[0]?.valid_to_version), retract.version);

    const { assembleContextPack } = await import("../dist/domain/index.js");
    const { loadPackWorkingSet } = await import("../dist/infrastructure/persistence/read.js");
    const set = await loadPackWorkingSet(client);
    const packIds = (pack: { sections: { objects: { id: string }[] }[] }) =>
      pack.sections.flatMap((section) => section.objects.map((object) => object.id));
    const before = assembleContextPack(set, {
      scopeId: project,
      featureLabelIds: [],
      glossaryEntryIds: [],
      intent: "implementation",
      budget: 10_000,
      graphVersion: retract.version - 1,
      builtAt: new Date("2026-08-19T00:00:00.000Z"),
    });
    const after = assembleContextPack(set, {
      scopeId: project,
      featureLabelIds: [],
      glossaryEntryIds: [],
      intent: "implementation",
      budget: 10_000,
      graphVersion: retract.version,
      builtAt: new Date("2026-08-19T00:00:00.000Z"),
    });
    assert.ok(packIds(before).includes(decisionId));
    assert.ok(!packIds(after).includes(decisionId));
  });
});

test("retract flags active Constraints when parent Decision is retracted", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    const project = await createProject(client);
    const discussionId = objectId("DSC");
    const decisionId = objectId("DEC");
    const constraintId = objectId("CON");
    await curationTransaction(client, { action: "retract-constraint.setup" }, async (tx) => {
      await tx.insertObject(discussion(discussionId, project), "human");
      await tx.insertObject(decision(decisionId, project, "human"), "human");
      await tx.insertObject(constraint(constraintId, project), "human");
      await tx.insertRelation({
        sourceId: decisionId,
        relation: "derives_from",
        targetId: discussionId,
        targetKind: "knowledge_object",
      });
      await tx.insertRelation({
        sourceId: constraintId,
        relation: "derives_from",
        targetId: decisionId,
        targetKind: "knowledge_object",
      });
    });
    await curationTransaction(client, { action: "retract-parent-decision" }, async (tx) => {
      await tx.transition(decisionId, "retracted");
    });
    const rows = await client.query<{ id: string; status: string; review_required: boolean }>(
      `SELECT id, status, review_required
       FROM knowledge_objects
       WHERE id = ANY($1::text[])
       ORDER BY id`,
      [[decisionId, constraintId]],
    );
    assert.deepEqual(rows.rows, [
      { id: constraintId, status: "active", review_required: true },
      { id: decisionId, status: "retracted", review_required: false },
    ]);
  });
});

test("retract flags active Decisions when derives_from origin is retracted", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    const project = await createProject(client);
    const originId = objectId("DSC");
    const dependentId = objectId("DEC");
    await curationTransaction(client, { action: "retract-origin.setup" }, async (tx) => {
      await tx.insertObject(discussion(originId, project), "human");
      await tx.insertObject(decision(dependentId, project, "human"), "human");
      await tx.insertRelation({
        sourceId: dependentId,
        relation: "derives_from",
        targetId: originId,
        targetKind: "knowledge_object",
      });
    });
    await curationTransaction(client, { action: "retract-origin" }, async (tx) => {
      await tx.transition(originId, "retracted");
    });
    const rows = await client.query<{ id: string; status: string; review_required: boolean }>(
      `SELECT id, status, review_required
       FROM knowledge_objects
       WHERE id = ANY($1::text[])
       ORDER BY id`,
      [[originId, dependentId]],
    );
    assert.deepEqual(rows.rows, [
      { id: dependentId, status: "active", review_required: true },
      { id: originId, status: "retracted", review_required: false },
    ]);
  });
});
