import assert from "node:assert/strict";
import test from "node:test";
import type { Client } from "pg";
import { pgMessage, waitForDatabase, withClient } from "./support/db.ts";

async function nextVersion(client: Client, action: string): Promise<number> {
  const result = await client.query<{ version: string }>(
    "INSERT INTO graph_versions (action, actor) VALUES ($1, 'curator') RETURNING version",
    [action],
  );
  const version = result.rows[0]?.version;
  if (version === undefined) {
    throw new Error("graph_versions insert returned no version");
  }
  return Number(version);
}

async function seedProject(client: Client): Promise<void> {
  await client.query(
    "INSERT INTO scopes (id, kind, parent_id, name) VALUES ('mira', 'project', 'global', 'MIRA')",
  );
  await client.query(
    "INSERT INTO scopes (id, kind, parent_id, name) VALUES ('hiring', 'workstream', 'mira', 'Hiring')",
  );
  await client.query(
    "INSERT INTO scopes (id, kind, parent_id, name) VALUES ('phase29', 'phase', 'hiring', 'Phase 29')",
  );
}

async function rolledBack(fn: (client: Client) => Promise<void>): Promise<void> {
  await withClient(async (client) => {
    await client.query("BEGIN");
    try {
      await fn(client);
    } finally {
      await client.query("ROLLBACK");
    }
  });
}

test("a label merge touches zero rows outside feature_labels and feature_label_aliases", async () => {
  await waitForDatabase();
  await rolledBack(async (client) => {
    await seedProject(client);
    const vCreate = await nextVersion(client, "create_labels");
    await client.query(
      `INSERT INTO feature_labels (
         id, project_scope_id, canonical_name, status, redirects_to_id, valid_from_version
       ) VALUES
         ('FTL-0009', 'mira', 'magic-link', 'active', NULL, $1),
         ('FTL-0012', 'mira', 'magic-links', 'active', NULL, $1)`,
      [vCreate],
    );

    const scopesBefore = (
      await client.query(
        "SELECT id, kind, parent_id, name, path::text, depth FROM scopes ORDER BY id",
      )
    ).rows;
    const aliasesBefore = (await client.query("SELECT * FROM feature_label_aliases ORDER BY alias"))
      .rows;
    const versionCountBefore =
      (await client.query("SELECT COUNT(*)::int AS n FROM graph_versions")).rows[0]?.n ?? 0;

    const vMerge = await nextVersion(client, "merge_label");
    await client.query(
      `UPDATE feature_labels SET valid_to_version = $1
       WHERE id = 'FTL-0012' AND valid_to_version IS NULL`,
      [vMerge],
    );
    await client.query(
      `INSERT INTO feature_labels (
         id, project_scope_id, canonical_name, status, redirects_to_id, valid_from_version
       ) VALUES ('FTL-0012', 'mira', 'magic-links', 'active', 'FTL-0009', $1)`,
      [vMerge],
    );

    const scopesAfter = (
      await client.query(
        "SELECT id, kind, parent_id, name, path::text, depth FROM scopes ORDER BY id",
      )
    ).rows;
    const aliasesAfter = (await client.query("SELECT * FROM feature_label_aliases ORDER BY alias"))
      .rows;
    assert.deepEqual(scopesAfter, scopesBefore);
    assert.deepEqual(aliasesAfter, aliasesBefore);
    const versionCountAfter =
      (await client.query("SELECT COUNT(*)::int AS n FROM graph_versions")).rows[0]?.n ?? 0;
    assert.equal(versionCountAfter, versionCountBefore + 1);

    const windows = (
      await client.query<{ redirects_to_id: string | null }>(
        `SELECT redirects_to_id FROM feature_labels
         WHERE id = 'FTL-0012' ORDER BY valid_from_version`,
      )
    ).rows;
    assert.equal(windows.length, 2);
    assert.equal(windows[1]?.redirects_to_id, "FTL-0009");
  });
});

test("a redirect to a non-existent or non-open label throws UNKNOWN_LABEL", async () => {
  await waitForDatabase();
  await rolledBack(async (client) => {
    await seedProject(client);
    const v = await nextVersion(client, "unknown_label");
    await assert.rejects(
      () =>
        client.query(
          `INSERT INTO feature_labels (
             id, project_scope_id, canonical_name, status, redirects_to_id, valid_from_version
           ) VALUES ('FTL-0400', 'mira', 'ghost', 'active', 'FTL-9999', $1)`,
          [v],
        ),
      (err: unknown) => pgMessage(err).includes("UNKNOWN_LABEL"),
    );
  });

  await rolledBack(async (client) => {
    await seedProject(client);
    const vOpen = await nextVersion(client, "open_target");
    await client.query(
      `INSERT INTO feature_labels (
         id, project_scope_id, canonical_name, status, redirects_to_id, valid_from_version
       ) VALUES ('FTL-0100', 'mira', 'closed-target', 'active', NULL, $1)`,
      [vOpen],
    );
    const vClose = await nextVersion(client, "close_target");
    await client.query(
      `UPDATE feature_labels SET valid_to_version = $1
       WHERE id = 'FTL-0100' AND valid_to_version IS NULL`,
      [vClose],
    );
    const vLater = await nextVersion(client, "unknown_label_closed");
    await assert.rejects(
      () =>
        client.query(
          `INSERT INTO feature_labels (
             id, project_scope_id, canonical_name, status, redirects_to_id, valid_from_version
           ) VALUES ('FTL-0101', 'mira', 'points-at-closed', 'active', 'FTL-0100', $1)`,
          [vLater],
        ),
      (err: unknown) => pgMessage(err).includes("UNKNOWN_LABEL"),
    );
  });
});

test("a curation transaction that fails any check creates no graph_versions row", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    const before =
      (await client.query("SELECT COUNT(*)::int AS n FROM graph_versions")).rows[0]?.n ?? 0;
    await client.query("BEGIN");
    try {
      await client.query(
        "INSERT INTO graph_versions (action, actor) VALUES ('should_roll_back', 'curator')",
      );
      await client.query(
        "INSERT INTO scopes (id, kind, name) VALUES ('global-two', 'global', 'Nope')",
      );
      await client.query("COMMIT");
      assert.fail("expected second global to fail");
    } catch (err) {
      await client.query("ROLLBACK");
      assert.ok(pgMessage(err).length > 0);
    }
    const after =
      (await client.query("SELECT COUNT(*)::int AS n FROM graph_versions")).rows[0]?.n ?? 0;
    assert.equal(after, before);
  });
});

test("scope reparenting is rejected", async () => {
  await waitForDatabase();
  await rolledBack(async (client) => {
    await seedProject(client);
    await assert.rejects(
      () => client.query("UPDATE scopes SET parent_id = 'global' WHERE id = 'hiring'"),
      (err: unknown) => pgMessage(err).includes("reparenting is rejected"),
    );
  });
});

test("a second global scope is rejected", async () => {
  await waitForDatabase();
  await rolledBack(async (client) => {
    await assert.rejects(
      () =>
        client.query("INSERT INTO scopes (id, kind, name) VALUES ('global-two', 'global', 'Nope')"),
      (err: unknown) =>
        pgMessage(err).includes("scopes_one_global") || pgMessage(err).includes("duplicate key"),
    );
  });
});

test("depth 4 is rejected", async () => {
  await waitForDatabase();
  await rolledBack(async (client) => {
    await seedProject(client);
    const maxBefore = (await client.query("SELECT MAX(depth)::int AS d FROM scopes")).rows[0]?.d;
    assert.equal(maxBefore, 3);
    await assert.rejects(
      () =>
        client.query(
          "INSERT INTO scopes (id, kind, parent_id, name) VALUES ('too-deep', 'phase', 'phase29', 'Too deep')",
        ),
      (err: unknown) => pgMessage(err).length > 0,
    );
  });
});
