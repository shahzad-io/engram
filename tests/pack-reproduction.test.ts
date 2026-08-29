import assert from "node:assert/strict";
import test from "node:test";
import type { Client } from "pg";
import { buildContextPack, reproduceContextPack } from "../dist/application/index.js";
import {
  curationTransaction,
  relabelFeatureLabels,
  transitionObject,
} from "../dist/application/write/index.js";
import type {
  FeatureLabelWrite,
  KnowledgeObjectWrite,
  RelationWrite,
} from "../dist/application/write/index.js";
import { ErrorCode } from "../dist/domain/errors.js";
import { waitForDatabase, withClient } from "./support/db.ts";

let serial = 0;

function suffix(): string {
  serial += 1;
  return `${Date.now()}${process.pid}${serial}`;
}

function requirement(
  id: string,
  scopeId: string,
  featureLabelIds: readonly string[] = [],
): KnowledgeObjectWrite {
  return {
    id,
    type: "requirement",
    scopeId,
    title: id,
    body: `${id} body`,
    status: "active",
    featureLabelIds,
    attributes: { source: "pack reproduction test", rationale: "test" },
    authoredBy: "ai",
  };
}

function decision(id: string, scopeId: string): KnowledgeObjectWrite {
  return {
    id,
    type: "decision",
    scopeId,
    title: id,
    body: `${id} body`,
    status: "active",
    attributes: {
      statement: `${id} statement`,
      rationale: "pack reproduction test",
      reversibility: "cheap",
      alternatives_rejected: [],
    },
    authoredBy: "ai",
  };
}

function hypothesis(id: string, scopeId: string): KnowledgeObjectWrite {
  return {
    id,
    type: "hypothesis",
    scopeId,
    title: id,
    body: `${id} body`,
    status: "explored",
    attributes: { what_was_tried: "tried", why_it_failed: "failed", evidence_ref: id },
    authoredBy: "ai",
  };
}

function derivesFrom(sourceId: string, targetId: string): RelationWrite {
  return { sourceId, relation: "derives_from", targetId, targetKind: "knowledge_object" };
}

type Labelled = {
  readonly scopeId: string;
  readonly filterName: string;
  readonly matchingLabelId: string;
  readonly otherLabelId: string;
  readonly labelledId: string;
  /** Seeded in the same transaction, so no *later* action ever names it. */
  readonly untouchedId: string;
  readonly packId: string;
};

/** A feature-filtered pack, which is the only selection input still unversioned. */
async function seedLabelled(client: Client): Promise<Labelled> {
  const scopeId = `repro_${suffix()}`;
  const labelledId = `REQ-${suffix()}`;
  const untouchedId = `REQ-${suffix()}`;
  const matchingLabelId = `FTL-${suffix()}`;
  const otherLabelId = `FTL-${suffix()}`;
  const filterName = `filter-${suffix()}`;
  await client.query(
    `INSERT INTO scopes (id, kind, parent_id, name) VALUES ($1, 'project', 'global', $1)`,
    [scopeId],
  );
  const labels: readonly FeatureLabelWrite[] = [
    { id: matchingLabelId, projectScopeId: scopeId, canonicalName: filterName },
    { id: otherLabelId, projectScopeId: scopeId, canonicalName: `other-${suffix()}` },
  ];
  await relabelFeatureLabels(client, labels, []);
  await curationTransaction(client, { action: "reproduction-test.seed" }, async (transaction) => {
    await transaction.insertObject(requirement(labelledId, scopeId, [matchingLabelId]));
    await transaction.insertObject(requirement(untouchedId, scopeId, [matchingLabelId]));
  });
  const pack = await buildContextPack(client, {
    scopeId,
    feature: [filterName],
    intent: "implementation",
    budget: 250_000,
    builtAt: new Date("2026-03-01T00:00:00.000Z"),
  });
  return {
    scopeId,
    filterName,
    matchingLabelId,
    otherLabelId,
    labelledId,
    untouchedId,
    packId: pack.id,
  };
}

async function reproductionError(
  client: Client,
  packId: string,
): Promise<Error & { code?: string }> {
  try {
    await reproduceContextPack(client, packId);
  } catch (error) {
    return error as Error & { code?: string };
  }
  throw new Error("expected reproduction to fail");
}

test("a recorded relabel moving an older pack is reported as curation, not as a mismatch", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    const seeded = await seedLabelled(client);

    // Relabelling is a curation transaction, and an object's label set is the
    // one selection input still not version-windowed (Domain Spec A17).
    await relabelFeatureLabels(
      client,
      [],
      [{ objectId: seeded.labelledId, featureLabelIds: [seeded.otherLabelId] }],
    );

    const error = await reproductionError(client, seeded.packId);
    assert.equal(error.code, ErrorCode.PACK_MUTATED_BY_CURATION);
    assert.match(error.message, new RegExp(seeded.labelledId, "u"));
    assert.match(error.message, /relabel_feature_labels/u);
    assert.match(error.message, /necessary, not sufficient/u);
  });
});

test("a change with no curation behind it stays PACK_HASH_MISMATCH", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    const seeded = await seedLabelled(client);

    /*
     * The same column a relabel would have written, written without one.
     * `feature_label_ids` is on the append-only whitelist so the database
     * permits it; what it cannot do is leave a record, which is exactly what
     * the discriminator looks for.
     */
    await client.query(
      `UPDATE knowledge_objects SET feature_label_ids = ARRAY[$1]::text[] WHERE id = $2`,
      [seeded.otherLabelId, seeded.labelledId],
    );

    const error = await reproductionError(client, seeded.packId);
    assert.equal(error.code, ErrorCode.PACK_HASH_MISMATCH);
    assert.match(error.message, new RegExp(seeded.labelledId, "u"));
    assert.match(error.message, /does not match its own recorded history/u);
  });
});

test("one explained object does not launder an unexplained one", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    const seeded = await seedLabelled(client);

    /*
     * One object relabelled on the record, one relabelled without it. The
     * second predates the pack and no later transaction names it, so it cannot
     * borrow the first one's explanation.
     */
    await relabelFeatureLabels(
      client,
      [],
      [{ objectId: seeded.labelledId, featureLabelIds: [seeded.otherLabelId] }],
    );
    await client.query(
      `UPDATE knowledge_objects SET feature_label_ids = ARRAY[$1]::text[] WHERE id = $2`,
      [seeded.otherLabelId, seeded.untouchedId],
    );

    const error = await reproductionError(client, seeded.packId);
    assert.equal(error.code, ErrorCode.PACK_HASH_MISMATCH);
    assert.match(
      error.message,
      new RegExp(`changed by recorded curation: ${seeded.labelledId}`, "u"),
    );
    assert.match(
      error.message,
      new RegExp(`changed with no recorded curation: ${seeded.untouchedId}`, "u"),
    );
  });
});

test("a pack nothing has touched still reproduces", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    const seeded = await seedLabelled(client);
    const reproduced = await reproduceContextPack(client, seeded.packId);
    assert.equal(reproduced.id, seeded.packId);
  });
});

test("a status change after a pack no longer changes what that pack selects", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    const scopeId = `repro_${suffix()}`;
    const requirementId = `REQ-${suffix()}`;
    const decisionId = `DEC-${suffix()}`;
    const hypothesisId = `HYP-${suffix()}`;
    await client.query(
      `INSERT INTO scopes (id, kind, parent_id, name) VALUES ($1, 'project', 'global', $1)`,
      [scopeId],
    );
    await curationTransaction(client, { action: "reproduction-test.seed" }, async (transaction) => {
      await transaction.insertObject(requirement(requirementId, scopeId));
      await transaction.insertObject(decision(decisionId, scopeId));
      await transaction.insertObject(hypothesis(hypothesisId, scopeId));
      await transaction.insertRelation(derivesFrom(decisionId, requirementId));
    });
    const before = await buildContextPack(client, {
      scopeId,
      intent: "implementation",
      budget: 250_000,
      builtAt: new Date("2026-03-01T00:00:00.000Z"),
    });

    // An explored Hypothesis is in no pack section; a rejected one is. Before
    // status history this rewrote the older pack's selection retroactively.
    await transitionObject(client, hypothesisId, "rejected");

    const reproduced = await reproduceContextPack(client, before.id);
    assert.equal(reproduced.pack.recipe.contentHash, before.pack.recipe.contentHash);
    assert.ok(
      !reproduced.pack.recipe.orderedObjectIds.includes(hypothesisId),
      "the pack predates the rejection and must not acquire it",
    );

    // The change is real; it belongs to packs built after it.
    const after = await buildContextPack(client, {
      scopeId,
      intent: "implementation",
      budget: 250_000,
      builtAt: new Date("2026-03-02T00:00:00.000Z"),
    });
    assert.ok(after.pack.recipe.orderedObjectIds.includes(hypothesisId));
  });
});

test("a validity window cannot be reopened once closed", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    const scopeId = `repro_${suffix()}`;
    const observationId = `OBS-${suffix()}`;
    await client.query(
      `INSERT INTO scopes (id, kind, parent_id, name) VALUES ($1, 'project', 'global', $1)`,
      [scopeId],
    );
    await curationTransaction(client, { action: "reproduction-test.seed" }, async (transaction) => {
      await transaction.insertObject({
        id: observationId,
        type: "observation",
        scopeId,
        title: observationId,
        body: `${observationId} body`,
        status: "observed",
        attributes: {
          observed_at: "2026-01-01T00:00:00.000Z",
          evidence_ref: observationId,
          review_by: "2026-01-02T00:00:00.000Z",
        },
        authoredBy: "ai",
      });
    });
    await transitionObject(client, observationId, "stale");

    await assert.rejects(
      client.query(`UPDATE knowledge_objects SET valid_to_version = NULL WHERE id = $1`, [
        observationId,
      ]),
      /VALIDITY_WINDOW_CLOSED/u,
    );
  });
});
