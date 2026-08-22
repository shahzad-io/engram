import assert from "node:assert/strict";
import test from "node:test";
import { assembleContextPack } from "../dist/domain/index.js";
import { importBackfill, BackfillImportError } from "../dist/application/index.js";
import { loadPackWorkingSet } from "../dist/infrastructure/persistence/read.js";
import { withFreshThrowawayDatabase } from "./support/db.ts";

const MIRA_DIRECTORY = "backfill/mira";
const BUILT_AT = new Date("2026-08-20T00:00:00.000Z");

test("A20 rebuilds MIRA from files with an identical pack hash", async () => {
  const hashes: string[] = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await withFreshThrowawayDatabase(async (client) => {
      const report = await importBackfill(client, MIRA_DIRECTORY);
      assert.deepEqual(report.graphVersions, [1, 2, 3]);
      assert.equal(report.scopeGraphVersion, 1);
      assert.equal(report.objectGraphVersion, 2);
      assert.equal(report.labelGraphVersion, 3);

      const objects = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM knowledge_objects",
      );
      const relations = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM relations",
      );
      const references = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM external_references",
      );
      assert.equal(Number(objects.rows[0]?.count), 23);
      assert.equal(Number(relations.rows[0]?.count), 6);
      assert.equal(Number(references.rows[0]?.count), 1);

      const version = await client.query<{ object_ids: string[] }>(
        "SELECT object_ids FROM graph_versions WHERE version = 2",
      );
      assert.ok(version.rows[0]?.object_ids.every((id) => !/^\\d+$/u.test(id)));
      assert.ok(version.rows[0]?.object_ids.some((id) => id.startsWith("REL-")));

      const workingSet = await loadPackWorkingSet(client);
      const pack = assembleContextPack(workingSet, {
        scopeId: "project_mira",
        intent: "implementation",
        budget: 4_000,
        graphVersion: 3,
        builtAt: BUILT_AT,
      });
      hashes.push(pack.recipe.contentHash);
    });
  }
  assert.equal(hashes.length, 2);
  assert.equal(hashes[0], hashes[1]);
});

test("A20 re-importing unchanged files creates no graph version", async () => {
  await withFreshThrowawayDatabase(async (client) => {
    const first = await importBackfill(client, MIRA_DIRECTORY);
    assert.deepEqual(first.graphVersions, [1, 2, 3]);
    const before = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM graph_versions",
    );

    const second = await importBackfill(client, MIRA_DIRECTORY);
    assert.deepEqual(second.graphVersions, []);
    assert.equal(second.graphVersion, null);
    const after = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM graph_versions",
    );
    assert.equal(after.rows[0]?.count, before.rows[0]?.count);
  });
});

test("A20 conflicting scope definitions fail instead of diverging", async () => {
  await withFreshThrowawayDatabase(async (client) => {
    await importBackfill(client, MIRA_DIRECTORY);
    const before = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM graph_versions",
    );
    await assert.rejects(
      importBackfill(client, {
        objects: [],
        relations: [],
        frictionActions: [],
        scopes: [
          {
            sourcePath: "scopes.json#scopes[1]",
            id: "project_mira",
            kind: "project",
            parentId: "global",
            name: "MIRA (conflict)",
          },
        ],
      }),
      (error: unknown) => {
        assert.ok(error instanceof BackfillImportError);
        assert.ok(
          error.report.failures.some((failure) => failure.code === "SCOPE_MANIFEST_CONFLICT"),
        );
        return true;
      },
    );
    const after = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM graph_versions",
    );
    assert.equal(after.rows[0]?.count, before.rows[0]?.count);
  });
});
