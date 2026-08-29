import assert from "node:assert/strict";
import test from "node:test";
import type { Client } from "pg";
import { waitForDatabase, withClient } from "./support/db.ts";
import { createProject, objectId, relation, requirement, seed } from "./support/graph.ts";

/*
 * Every other suite asserts that one write path refuses one bad input.
 * This one asks a different question: after everything the suite just did,
 * is the graph still internally consistent? A write path can be individually
 * correct and still leave the graph wrong in combination — a repoint that
 * misses an edge, a supersession that closes the wrong window.
 *
 * The file name is load-bearing. Tests run in file order, so this has to
 * sort last for the scan to cover what the other suites wrote.
 */

const ACYCLIC_VERBS = ["derives_from", "supersedes", "requires"] as const;

async function rows<T extends Record<string, unknown>>(
  client: Client,
  sql: string,
  values: readonly unknown[] = [],
): Promise<readonly T[]> {
  const result = await client.query<T>(sql, [...values]);
  return result.rows;
}

async function count(client: Client, sql: string, values: readonly unknown[] = []): Promise<number> {
  const result = await rows<{ count: string }>(client, sql, values);
  return Number(result[0]?.count ?? "0");
}

test("the graph the suite just built has no dangling relation endpoints", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    /*
     * `relations.source_id` carries a foreign key, so only targets can
     * dangle: the column is polymorphic across knowledge objects and
     * external references and cannot be constrained in one direction.
     */
    const missingObjects = await rows<{ id: string; target_id: string }>(
      client,
      `SELECT r.id::text AS id, r.target_id
         FROM relations r
        WHERE r.target_kind = 'knowledge_object'
          AND NOT EXISTS (SELECT 1 FROM knowledge_objects o WHERE o.id = r.target_id)`,
    );
    assert.deepEqual(missingObjects, [], "relations point at knowledge objects that do not exist");

    const missingReferences = await rows<{ id: string; target_id: string }>(
      client,
      `SELECT r.id::text AS id, r.target_id
         FROM relations r
        WHERE r.target_kind = 'external_reference'
          AND NOT EXISTS (SELECT 1 FROM external_references x WHERE x.id = r.target_id)`,
    );
    assert.deepEqual(missingReferences, [], "relations point at external references that do not exist");

    // A scan over nothing passes for the wrong reason.
    const scanned = await count(client, "SELECT count(*)::text AS count FROM relations");
    assert.ok(scanned > 50, `the relation scan saw only ${scanned} relations`);
  });
});

test("no approved object is missing the provenance its type requires", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    // INV-3 and INV-4, asked of the whole graph rather than of one insert.
    const orphans = await rows<{
      id: string;
      type: string;
      scope_id: string;
      written_by: string;
    }>(
      client,
      `SELECT o.id, o.type::text AS type, o.scope_id,
              (SELECT v.action FROM graph_versions v WHERE v.version = o.valid_from_version) AS written_by
         FROM knowledge_objects o
        WHERE o.type = 'decision'
          AND coalesce(o.attributes ->> 'origin', '') <> 'unrecoverable'
          AND NOT EXISTS (
                SELECT 1 FROM relations r
                 WHERE r.source_id = o.id AND r.relation = 'derives_from'
              )
        UNION ALL
       SELECT o.id, o.type::text AS type, o.scope_id,
              (SELECT v.action FROM graph_versions v WHERE v.version = o.valid_from_version) AS written_by
         FROM knowledge_objects o
        WHERE o.type = 'constraint'
          AND coalesce((o.attributes ->> 'axiomatic')::boolean, false) = false
          AND NOT EXISTS (
                SELECT 1 FROM relations r
                 WHERE r.source_id = o.id AND r.relation = 'derives_from'
              )
        ORDER BY id`,
    );
    assert.deepEqual(orphans, [], "objects exist with no origin");

    /*
     * The one sanctioned exception. A Decision imported from history whose
     * origin cannot be recovered carries `origin: unrecoverable` instead of a
     * `derives_from` edge, and that marker is importer-only. If one appeared
     * outside a backfill it would be a live write path claiming an exemption
     * that only the importer has.
     */
    const exempt = await rows<{ id: string; written_by: string }>(
      client,
      `SELECT o.id,
              (SELECT v.action FROM graph_versions v WHERE v.version = o.valid_from_version) AS written_by
         FROM knowledge_objects o
        WHERE o.attributes ->> 'origin' = 'unrecoverable'
        ORDER BY o.id`,
    );
    for (const object of exempt) {
      assert.match(
        object.written_by,
        /^backfill\./u,
        `${object.id} claims an unrecoverable origin but was written by ${object.written_by}`,
      );
    }

    assert.ok(
      (await count(
        client,
        "SELECT count(*)::text AS count FROM knowledge_objects WHERE type IN ('decision','constraint')",
      )) > 20,
      "the provenance scan found almost nothing to scan",
    );
  });
});

/*
 * `derives_from` and `supersedes` are written by half the suite. `requires`
 * was written by nothing: the only test that produced one inserted it inside
 * a transaction it rolled back, so a scan for cycles in it would have run
 * over an empty set and passed for the wrong reason. This writes a real
 * chain through the write path, then tries to close it.
 */
test("a requires chain is accepted and closing it into a loop is rejected", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    const scopeId = await createProject(client, "requires");
    const [a, b, c] = [objectId("REQ"), objectId("REQ"), objectId("REQ")];
    await seed(
      client,
      [requirement(a, scopeId), requirement(b, scopeId), requirement(c, scopeId)],
      [relation(a, "requires", b), relation(b, "requires", c)],
    );

    await assert.rejects(seed(client, [], [relation(c, "requires", a)]), (error: unknown) => {
      const text = `${(error as { code?: string }).code ?? ""} ${(error as Error).message}`;
      assert.match(text, /CYCLE_DETECTED/u);
      return true;
    });

    const surviving = await count(
      client,
      `SELECT count(*)::text AS count FROM relations
        WHERE relation = 'requires' AND source_id = ANY($1)`,
      [[a, b, c]],
    );
    assert.equal(surviving, 2, "the rejected edge must not have been written");
  });
});

test("none of the three acyclic verbs contains a cycle anywhere in the graph", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    for (const verb of ACYCLIC_VERBS) {
      const cycles = await rows<{ start_id: string }>(
        client,
        `WITH RECURSIVE edges AS (
           SELECT source_id, target_id
             FROM relations
            WHERE relation = $1::relation_verb
              AND target_kind = 'knowledge_object'
              AND valid_to_version IS NULL
         ), walk (start_id, node_id, depth) AS (
           SELECT source_id, target_id, 1 FROM edges
           UNION ALL
           SELECT w.start_id, e.target_id, w.depth + 1
             FROM walk w
             JOIN edges e ON e.source_id = w.node_id
            WHERE w.depth < 64
              AND w.node_id <> w.start_id
         )
         SELECT DISTINCT start_id FROM walk WHERE node_id = start_id ORDER BY start_id`,
        [verb],
      );
      assert.deepEqual(cycles, [], `${verb} contains a cycle`);

      assert.ok(
        (await count(
          client,
          `SELECT count(*)::text AS count FROM relations
            WHERE relation = $1::relation_verb AND valid_to_version IS NULL`,
          [verb],
        )) > 0,
        `no ${verb} edge exists, so its cycle scan proved nothing`,
      );
    }
  });
});

test("every feature label on an object resolves in its own project registry", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    /*
     * A label is owned by a Project registry, and an object may only carry
     * labels from the project above it in the scope tree. INV-13 checks this
     * one insert at a time; a redirect or a scope correction could still
     * leave an object holding a label that no longer belongs to it.
     */
    const unresolved = await rows<{ object_id: string; label_id: string }>(
      client,
      `WITH RECURSIVE ancestry (scope_id, ancestor_id) AS (
         SELECT id, id FROM scopes
         UNION ALL
         SELECT a.scope_id, s.parent_id
           FROM ancestry a
           JOIN scopes s ON s.id = a.ancestor_id
          WHERE s.parent_id IS NOT NULL
       ), carried AS (
         SELECT o.id AS object_id, o.scope_id, unnest(o.feature_label_ids) AS label_id
           FROM knowledge_objects o
          WHERE array_length(o.feature_label_ids, 1) > 0
       )
       SELECT c.object_id, c.label_id
         FROM carried c
        WHERE NOT EXISTS (
              SELECT 1
                FROM feature_labels l
                JOIN ancestry a
                  ON a.scope_id = c.scope_id AND a.ancestor_id = l.project_scope_id
               WHERE l.id = c.label_id
            )
        ORDER BY c.object_id, c.label_id`,
    );
    assert.deepEqual(unresolved, [], "objects carry labels from outside their project registry");

    assert.ok(
      (await count(
        client,
        `SELECT count(*)::text AS count FROM knowledge_objects
          WHERE array_length(feature_label_ids, 1) > 0`,
      )) > 0,
      "no object carries a label, so the registry scan proved nothing",
    );
  });
});
