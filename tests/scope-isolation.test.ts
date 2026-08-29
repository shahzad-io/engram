import assert from "node:assert/strict";
import test from "node:test";
import type { Client } from "pg";
import { buildContextPack } from "../dist/application/index.js";
import { relabelFeatureLabels } from "../dist/application/write/index.js";
import type { ContextPackRecipe } from "../dist/domain/pack/types.js";
import {
  constraint,
  createProject,
  currentGraphVersion,
  decision,
  discussion,
  objectId,
  relation,
  seed,
  uniqueDigits,
} from "./support/graph.ts";
import { waitForDatabase, withClient } from "./support/db.ts";

/*
 * Every pack fixture in this repository lives in one project, so nothing
 * asked the question the scope tree exists to answer: with two projects in
 * one database, does either one leak into the other's pack? The label
 * registry has the same shape of gap — it is keyed by project, and every
 * test used one project, so a registry that ignored its key would pass.
 */

const BUILT_AT = new Date("2026-04-01T00:00:00.000Z");

type Project = {
  readonly scopeId: string;
  readonly decisionId: string;
  readonly labelId: string;
};

const SHARED_LABEL_NAME = "magic-links";

async function project(client: Client, prefix: string): Promise<Project> {
  const scopeId = await createProject(client, prefix);
  const originId = objectId("DSC");
  const decisionId = objectId("DEC");
  const labelId = `FTL-${uniqueDigits()}`;
  await seed(
    client,
    [discussion(originId, scopeId), decision(decisionId, scopeId)],
    [relation(decisionId, "derives_from", originId)],
  );
  /*
   * Both projects register the same string. A registry keyed only by name
   * would hand back one id here and quietly merge two projects' features.
   */
  await relabelFeatureLabels(
    client,
    [
      {
        id: labelId,
        projectScopeId: scopeId,
        canonicalName: SHARED_LABEL_NAME,
        status: "active",
      },
    ],
    [{ objectId: decisionId, featureLabelIds: [labelId] }],
  );
  return { scopeId, decisionId, labelId };
}

async function packFor(
  client: Client,
  scopeId: string,
  feature?: readonly string[],
  graphVersion?: number,
): Promise<ContextPackRecipe> {
  const stored = await buildContextPack(client, {
    scopeId,
    ...(feature === undefined ? {} : { feature }),
    ...(graphVersion === undefined ? {} : { graphVersion }),
    intent: "implementation",
    budget: 250_000,
    builtAt: BUILT_AT,
  });
  return stored.pack.recipe;
}

/** Everything a pack selected, with the two fields a later version legitimately moves. */
function selection(recipe: ContextPackRecipe): Record<string, unknown> {
  return {
    ...recipe,
    graphVersion: 0,
    contentHash: "",
  };
}

test("a pack for one project contains nothing from another, and the Global rule is in both", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    const alpha = await project(client, "alpha");
    const beta = await project(client, "beta");

    /*
     * Axiomatic so it needs no parent Decision, which is what a Global rule
     * usually is: it holds because it was declared, not because something
     * above it decided it.
     */
    const globalRule = objectId("CON");
    await seed(client, [constraint(globalRule, "global", true)]);

    const alphaPack = await packFor(client, alpha.scopeId);
    const betaPack = await packFor(client, beta.scopeId);

    assert.ok(alphaPack.orderedObjectIds.includes(alpha.decisionId));
    assert.ok(
      !alphaPack.orderedObjectIds.includes(beta.decisionId),
      "project alpha's pack carries project beta's decision",
    );
    assert.ok(betaPack.orderedObjectIds.includes(beta.decisionId));
    assert.ok(
      !betaPack.orderedObjectIds.includes(alpha.decisionId),
      "project beta's pack carries project alpha's decision",
    );

    // A Constraint at Global is in the scope chain of every project, and
    // always-inject means it cannot be filtered out of either one.
    assert.ok(alphaPack.orderedObjectIds.includes(globalRule));
    assert.ok(betaPack.orderedObjectIds.includes(globalRule));
    assert.ok(!alphaPack.droppedObjectIds.includes(globalRule));
    assert.ok(!betaPack.droppedObjectIds.includes(globalRule));
  });
});

test("the same feature name in two registries is two labels, and neither filter matches the other", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    const alpha = await project(client, "alpha");
    const beta = await project(client, "beta");

    const registered = await client.query<{ project_scope_id: string; id: string }>(
      `SELECT project_scope_id, id FROM feature_labels
        WHERE canonical_name = $1 AND project_scope_id = ANY($2) AND valid_to_version IS NULL
        ORDER BY project_scope_id`,
      [SHARED_LABEL_NAME, [alpha.scopeId, beta.scopeId]],
    );
    assert.equal(
      registered.rows.length,
      2,
      `${SHARED_LABEL_NAME} is one row across two project registries`,
    );

    const alphaFiltered = await packFor(client, alpha.scopeId, [SHARED_LABEL_NAME]);
    const betaFiltered = await packFor(client, beta.scopeId, [SHARED_LABEL_NAME]);

    // The same string resolves inside each project to that project's id.
    assert.deepEqual(alphaFiltered.featureLabelIds, [alpha.labelId]);
    assert.deepEqual(betaFiltered.featureLabelIds, [beta.labelId]);

    assert.ok(alphaFiltered.orderedObjectIds.includes(alpha.decisionId));
    assert.ok(
      !alphaFiltered.orderedObjectIds.includes(beta.decisionId),
      "a feature filter in one project matched another project's objects",
    );
    assert.ok(betaFiltered.orderedObjectIds.includes(beta.decisionId));
    assert.ok(!betaFiltered.orderedObjectIds.includes(alpha.decisionId));
  });
});

test("a write in another project produces no churn in a pack that does not include it", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    const alpha = await project(client, "alpha");
    const beta = await project(client, "beta");
    const pinned = await currentGraphVersion(client);

    const before = await packFor(client, alpha.scopeId, undefined, pinned);

    // Something entirely unrelated happens in the other project.
    const strangerOrigin = objectId("DSC");
    const stranger = objectId("DEC");
    await seed(
      client,
      [discussion(strangerOrigin, beta.scopeId), decision(stranger, beta.scopeId)],
      [relation(stranger, "derives_from", strangerOrigin)],
    );
    assert.ok(
      (await currentGraphVersion(client)) > pinned,
      "the unrelated write did not advance the graph version, so this proves nothing",
    );

    // Rebuilt at the version it was pinned to: byte-identical, hash included.
    const reproduced = await packFor(client, alpha.scopeId, undefined, pinned);
    assert.equal(reproduced.contentHash, before.contentHash);

    /*
     * Rebuilt at the latest version the hash moves, because the recipe
     * records the graph version it was built against and that is what makes
     * a pack reproducible. Nothing else may move: same objects, same order,
     * same drops.
     */
    const latest = await packFor(client, alpha.scopeId);
    assert.deepEqual(selection(latest), selection(before));
    assert.ok(
      !latest.orderedObjectIds.includes(stranger),
      "the other project's new decision entered this project's pack",
    );
    assert.notEqual(
      latest.graphVersion,
      before.graphVersion,
      "the rebuild did not see the later version, so the comparison is empty",
    );
  });
});
