import assert from "node:assert/strict";
import test from "node:test";
import type { Client } from "pg";
import { buildContextPack, reproduceContextPack } from "../dist/application/index.js";
import { curationTransaction, relabelFeatureLabels } from "../dist/application/write/index.js";
import type { FeatureLabelWrite, KnowledgeObjectWrite } from "../dist/application/write/index.js";
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
