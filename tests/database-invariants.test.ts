import assert from "node:assert/strict";
import test from "node:test";
import type { Client } from "pg";
import { pgMessage, waitForDatabase, withClient } from "./support/db.ts";

const APPROVED_AT = "2026-08-19T00:00:00.000Z";

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
}

async function insertRequirement(
  client: Client,
  id: string,
  version: number,
  supersedesId: string | null = null,
): Promise<void> {
  await client.query(
    `INSERT INTO knowledge_objects (
       id, type, scope_id, title, body, status, attributes, authored_by,
       approved_at, last_verified_at, supersedes_id, valid_from_version
     ) VALUES ($1, 'requirement', 'global', $1, 'requirement body', 'active',
       '{"source":"test","rationale":"test"}'::jsonb, 'human', $2, $2, $3, $4)`,
    [id, APPROVED_AT, supersedesId, version],
  );
}

async function insertDecision(
  client: Client,
  id: string,
  version: number,
  scopeId = "global",
): Promise<void> {
  await client.query(
    `INSERT INTO knowledge_objects (
       id, type, scope_id, title, body, status, attributes, authored_by,
       approved_at, last_verified_at, valid_from_version
     ) VALUES ($1, 'decision', $2, $1, 'decision body', 'active',
       '{"statement":"test","rationale":"test","reversibility":"cheap","alternatives_rejected":[]}'::jsonb,
       'human', $3, $3, $4)`,
    [id, scopeId, APPROVED_AT, version],
  );
}

async function insertConstraint(
  client: Client,
  id: string,
  version: number,
  axiomatic: boolean,
): Promise<void> {
  await client.query(
    `INSERT INTO knowledge_objects (
       id, type, scope_id, title, body, status, attributes, authored_by,
       approved_at, last_verified_at, valid_from_version
     ) VALUES ($1, 'constraint', 'global', $1, 'constraint body', 'active',
       jsonb_build_object('rule', 'test rule', 'enforcement', 'hard', 'axiomatic', $2::boolean),
       'human', $3, $3, $4)`,
    [id, axiomatic, APPROVED_AT, version],
  );
}

async function insertRawDiscussion(client: Client, id: string, version: number): Promise<void> {
  await client.query(
    `INSERT INTO knowledge_objects (
       id, type, scope_id, title, body, status, attributes, authored_by, valid_from_version
     ) VALUES ($1, 'discussion', 'global', $1, 'discussion body', 'recorded',
       '{"medium":"chat","occurred_at":"2026-08-19T00:00:00.000Z","content_ref":"test"}'::jsonb,
       'ai', $2)`,
    [id, version],
  );
}

async function insertLabel(
  client: Client,
  id: string,
  version: number,
  canonicalName = "database-test",
): Promise<void> {
  await client.query(
    `INSERT INTO feature_labels (
       id, project_scope_id, canonical_name, status, valid_from_version
     ) VALUES ($1, 'mira', $2, 'active', $3)`,
    [id, canonicalName, version],
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

async function assertRejectedInSavepoint(
  client: Client,
  sql: string,
  parameters: readonly unknown[],
  expectedMessage: RegExp,
): Promise<void> {
  let error: unknown;
  await client.query("SAVEPOINT invariant_attempt");
  try {
    await client.query(sql, parameters);
  } catch (caught) {
    error = caught;
  }
  await client.query("ROLLBACK TO SAVEPOINT invariant_attempt");
  await client.query("RELEASE SAVEPOINT invariant_attempt");

  assert.ok(error !== undefined, `SQL unexpectedly succeeded: ${sql}`);
  assert.match(pgMessage(error), expectedMessage);
}

async function assertTransactionRejected(
  setup: (client: Client) => Promise<void>,
  expectedMessage: RegExp,
): Promise<void> {
  await withClient(async (client) => {
    await client.query("BEGIN");
    let error: unknown;
    try {
      await setup(client);
      await client.query("COMMIT");
    } catch (caught) {
      error = caught;
    }
    await client.query("ROLLBACK");

    assert.ok(error !== undefined, "transaction unexpectedly committed");
    assert.match(pgMessage(error), expectedMessage);
  });
}

test("the glossary uniqueness index uses the JSONB term and open window", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    const result = await client.query<{ indexdef: string; predicate: string | null }>(
      `SELECT pg_get_indexdef(i.indexrelid) AS indexdef,
              pg_get_expr(i.indpred, i.indrelid) AS predicate
       FROM pg_index i
       INNER JOIN pg_class c ON c.oid = i.indexrelid
       WHERE c.relname = 'glossary_active_term'`,
    );
    const index = result.rows[0];
    assert.ok(index !== undefined);
    assert.match(index.indexdef, /lower\(\(attributes ->> 'term'/u);
    assert.match(index.predicate ?? "", /type = 'glossary_entry'/u);
    assert.match(index.predicate ?? "", /valid_to_version IS NULL/u);
    assert.doesNotMatch(index.predicate ?? "", /status/u);
  });
});

test("INV-7 database trigger rejects frozen updates and permits its whitelist", async () => {
  await waitForDatabase();
  await rolledBack(async (client) => {
    await seedProject(client);
    const version = await nextVersion(client, "inv7_test");
    await insertRequirement(client, "REQ-7000", version);
    await insertRawDiscussion(client, "DSC-7000", version);

    await assertRejectedInSavepoint(
      client,
      "UPDATE knowledge_objects SET body = 'edited' WHERE id = 'REQ-7000'",
      [],
      /IMMUTABLE_AFTER_APPROVAL/u,
    );
    await assertRejectedInSavepoint(
      client,
      "UPDATE knowledge_objects SET scope_id = 'mira' WHERE id = 'REQ-7000'",
      [],
      /SCOPE_IMMUTABLE/u,
    );

    for (const [id, type] of [
      ["REQ-7000", "artifact"],
      ["DSC-7000", "requirement"],
    ] as const) {
      await assertRejectedInSavepoint(
        client,
        "UPDATE knowledge_objects SET id = $1 WHERE id = $2",
        [`${type === "artifact" ? "ART" : "DSC"}-7999`, id],
        /IMMUTABLE_AFTER_APPROVAL/u,
      );
      await assertRejectedInSavepoint(
        client,
        "UPDATE knowledge_objects SET type = $1 WHERE id = $2",
        [type, id],
        /IMMUTABLE_AFTER_APPROVAL/u,
      );
    }

    await assertRejectedInSavepoint(
      client,
      "UPDATE knowledge_objects SET approved_at = NULL WHERE id = 'REQ-7000'",
      [],
      /IMMUTABLE_AFTER_APPROVAL/u,
    );
    await assertRejectedInSavepoint(
      client,
      "UPDATE knowledge_objects SET approved_at = now() WHERE id = 'DSC-7000'",
      [],
      /IMMUTABLE_AFTER_APPROVAL/u,
    );

    await client.query("UPDATE knowledge_objects SET status = 'active' WHERE id = 'REQ-7000'");
    await client.query(
      "UPDATE knowledge_objects SET last_verified_at = now() WHERE id = 'REQ-7000'",
    );
    await client.query("UPDATE knowledge_objects SET review_required = true WHERE id = 'REQ-7000'");
    await client.query(
      "UPDATE knowledge_objects SET superseded_by_id = NULL WHERE id = 'REQ-7000'",
    );
    await client.query(
      "UPDATE knowledge_objects SET valid_to_version = NULL WHERE id = 'REQ-7000'",
    );
    await client.query(
      "UPDATE knowledge_objects SET lock_version = lock_version + 1 WHERE id = 'REQ-7000'",
    );
  });
});

test("INV-8 rejects raw DELETE and TRUNCATE on all guarded durable tables", async () => {
  await waitForDatabase();
  await rolledBack(async (client) => {
    await seedProject(client);
    const version = await nextVersion(client, "inv8_test");
    await insertLabel(client, "FTL-8000", version);
    await client.query(
      `INSERT INTO feature_label_aliases (
         label_id, alias, project_scope_id, valid_from_version
       ) VALUES ('FTL-8000', 'database-test-alias', 'mira', $1)`,
      [version],
    );
    await insertRequirement(client, "REQ-8000", version);
    await insertRequirement(client, "REQ-8001", version);
    await client.query(
      `INSERT INTO relations (
         source_id, relation, target_id, target_kind, valid_from_version
       ) VALUES ('REQ-8000', 'requires', 'REQ-8001', 'knowledge_object', $1)`,
      [version],
    );

    const guardedStatements = [
      "DELETE FROM knowledge_objects WHERE id = 'REQ-8000'",
      "DELETE FROM relations WHERE source_id = 'REQ-8000'",
      "DELETE FROM feature_labels WHERE id = 'FTL-8000'",
      "DELETE FROM feature_label_aliases WHERE alias = 'database-test-alias'",
      "DELETE FROM graph_versions WHERE version = $1",
      "TRUNCATE knowledge_objects CASCADE",
      "TRUNCATE relations CASCADE",
      "TRUNCATE feature_labels CASCADE",
      "TRUNCATE feature_label_aliases CASCADE",
      "TRUNCATE graph_versions CASCADE",
    ];

    for (const sql of guardedStatements) {
      await assertRejectedInSavepoint(
        client,
        sql,
        sql.includes("$1") ? [version] : [],
        /DELETION_FORBIDDEN/u,
      );
    }
  });
});

test("INV-3 rejects a Decision without a derives_from origin at commit", async () => {
  await waitForDatabase();
  await assertTransactionRejected(async (client) => {
    const version = await nextVersion(client, "inv3_test");
    await insertDecision(client, "DEC-8300", version);
  }, /DECISION_ORIGIN_REQUIRED/u);
});

test("INV-4 rejects a non-axiomatic Constraint without a Decision parent at commit", async () => {
  await waitForDatabase();
  await assertTransactionRejected(async (client) => {
    const version = await nextVersion(client, "inv4_test");
    await insertConstraint(client, "CON-8400", version, false);
  }, /CONSTRAINT_PARENT_REQUIRED/u);
});

test("INV-5 rejects an Observation missing review_by", async () => {
  await waitForDatabase();
  await rolledBack(async (client) => {
    const version = await nextVersion(client, "inv5_test");
    await assertRejectedInSavepoint(
      client,
      `INSERT INTO knowledge_objects (
         id, type, scope_id, title, body, status, attributes, authored_by, valid_from_version
       ) VALUES ('OBS-8500', 'observation', 'global', 'OBS-8500', 'observation body',
         'observed', '{"observed_at":"2026-08-19T00:00:00.000Z","evidence_ref":"XRF-0001"}'::jsonb,
         'ai', $1)`,
      [version],
      /knowledge_objects_attribute_keys/u,
    );
  });
});

test("INV-6 rejects two objects superseding the same target", async () => {
  await waitForDatabase();
  await rolledBack(async (client) => {
    const version = await nextVersion(client, "inv6_test");
    await insertRequirement(client, "REQ-8600", version);
    await insertRequirement(client, "REQ-8601", version, "REQ-8600");
    await client.query(
      "UPDATE knowledge_objects SET status = 'superseded', superseded_by_id = 'REQ-8601' WHERE id = 'REQ-8600'",
    );
    await client.query(
      `INSERT INTO relations (
         source_id, relation, target_id, target_kind, valid_from_version
       ) VALUES ('REQ-8601', 'supersedes', 'REQ-8600', 'knowledge_object', $1)`,
      [version],
    );

    await assertRejectedInSavepoint(
      client,
      `INSERT INTO knowledge_objects (
         id, type, scope_id, title, body, status, attributes, authored_by,
         approved_at, last_verified_at, supersedes_id, valid_from_version
       ) VALUES ('REQ-8602', 'requirement', 'global', 'REQ-8602', 'requirement body',
         'active', '{"source":"test","rationale":"test"}'::jsonb, 'human', $1, $1, 'REQ-8600', $2)`,
      [APPROVED_AT, version],
      /duplicate key|knowledge_objects_supersedes_id/u,
    );
  });
});

test("INV-10 flags active derived Decisions without changing their status", async () => {
  await waitForDatabase();
  await rolledBack(async (client) => {
    const version = await nextVersion(client, "inv10_test");
    await insertRequirement(client, "REQ-8700", version);
    await insertDecision(client, "DEC-8700", version);
    await insertDecision(client, "DEC-8701", version);
    await client.query(
      `INSERT INTO relations (
         source_id, relation, target_id, target_kind, valid_from_version
       ) VALUES
         ('DEC-8700', 'derives_from', 'REQ-8700', 'knowledge_object', $1),
         ('DEC-8701', 'derives_from', 'DEC-8700', 'knowledge_object', $1)`,
      [version],
    );

    await client.query("UPDATE knowledge_objects SET status = 'superseded' WHERE id = 'REQ-8700'");
    const result = await client.query<{ id: string; status: string; review_required: boolean }>(
      "SELECT id, status, review_required FROM knowledge_objects WHERE id IN ('DEC-8700', 'DEC-8701') ORDER BY id",
    );
    assert.deepEqual(result.rows, [
      { id: "DEC-8700", status: "active", review_required: true },
      { id: "DEC-8701", status: "active", review_required: true },
    ]);
  });
});

test("INV-10 stops recursive impact at the depth-64 bound", async () => {
  await waitForDatabase();
  await rolledBack(async (client) => {
    const version = await nextVersion(client, "inv10_depth64_test");
    const requirementId = "REQ-9200";
    const decisionIds = Array.from({ length: 65 }, (_, index) => `DEC-${9200 + index}`);
    const boundaryId = decisionIds[63];
    const beyondBoundaryId = decisionIds[64];
    if (boundaryId === undefined || beyondBoundaryId === undefined) {
      throw new Error("depth fixture did not create 65 Decisions");
    }

    await insertRequirement(client, requirementId, version);
    for (const id of decisionIds) {
      await insertDecision(client, id, version);
    }
    // INV-12 rejects a path beyond this depth. Disable only that trigger in
    // this rolled-back fixture so this test proves INV-10 has its own bound.
    await client.query("ALTER TABLE relations DISABLE TRIGGER relations_reject_cycle");
    try {
      await client.query(
        `INSERT INTO relations (
           source_id, relation, target_id, target_kind, valid_from_version
         ) VALUES ($1, 'derives_from', $2, 'knowledge_object', $3)`,
        [decisionIds[0], requirementId, version],
      );
      for (let index = 1; index < decisionIds.length; index += 1) {
        await client.query(
          `INSERT INTO relations (
             source_id, relation, target_id, target_kind, valid_from_version
           ) VALUES ($1, 'derives_from', $2, 'knowledge_object', $3)`,
          [decisionIds[index], decisionIds[index - 1], version],
        );
      }
    } finally {
      await client.query("ALTER TABLE relations ENABLE TRIGGER relations_reject_cycle");
    }

    await client.query("UPDATE knowledge_objects SET status = 'superseded' WHERE id = $1", [
      requirementId,
    ]);
    const result = await client.query<{ id: string; status: string; review_required: boolean }>(
      `SELECT id, status, review_required
       FROM knowledge_objects
       WHERE id = ANY($1::text[])
       ORDER BY id`,
      [[boundaryId, beyondBoundaryId]],
    );
    assert.deepEqual(result.rows, [
      { id: boundaryId, status: "active", review_required: true },
      { id: beyondBoundaryId, status: "active", review_required: false },
    ]);
  });
});

test("INV-12 rejects a depth-2 cycle and a cycle at the depth-64 bound", async () => {
  await waitForDatabase();
  await rolledBack(async (client) => {
    const version = await nextVersion(client, "inv12_depth2_test");
    await insertRequirement(client, "REQ-8800", version);
    await insertRequirement(client, "REQ-8801", version);
    await insertRequirement(client, "REQ-8802", version);
    await client.query(
      `INSERT INTO relations (
         source_id, relation, target_id, target_kind, valid_from_version
       ) VALUES
         ('REQ-8800', 'requires', 'REQ-8801', 'knowledge_object', $1),
         ('REQ-8801', 'requires', 'REQ-8802', 'knowledge_object', $1)`,
      [version],
    );
    await assertRejectedInSavepoint(
      client,
      `INSERT INTO relations (
         source_id, relation, target_id, target_kind, valid_from_version
       ) VALUES ('REQ-8802', 'requires', 'REQ-8800', 'knowledge_object', $1)`,
      [version],
      /CYCLE_DETECTED/u,
    );
  });

  await rolledBack(async (client) => {
    const version = await nextVersion(client, "inv12_depth64_test");
    const ids = Array.from({ length: 65 }, (_, index) => `REQ-${8900 + index}`);
    for (const id of ids) {
      await insertRequirement(client, id, version);
    }
    for (let index = 0; index < 64; index += 1) {
      await client.query(
        `INSERT INTO relations (
           source_id, relation, target_id, target_kind, valid_from_version
         ) VALUES ($1, 'requires', $2, 'knowledge_object', $3)`,
        [ids[index], ids[index + 1], version],
      );
    }
    await assertRejectedInSavepoint(
      client,
      `INSERT INTO relations (
         source_id, relation, target_id, target_kind, valid_from_version
       ) VALUES ($1, 'requires', $2, 'knowledge_object', $3)`,
      [ids[64], ids[0], version],
      /CYCLE_DETECTED/u,
    );
  });
});

test("INV-13 rejects a label identity outside its Project registry", async () => {
  await waitForDatabase();
  await rolledBack(async (client) => {
    await seedProject(client);
    const version = await nextVersion(client, "inv13_test");
    await assertRejectedInSavepoint(
      client,
      `INSERT INTO knowledge_objects (
         id, type, scope_id, feature_label_ids, title, body, status, attributes,
         authored_by, approved_at, last_verified_at, valid_from_version
       ) VALUES (
         'REQ-9001', 'requirement', 'mira', ARRAY['FTL-9999'], 'REQ-9001', 'requirement body',
         'active', '{"source":"test","rationale":"test"}'::jsonb, 'human', $1, $1, $2
       )`,
      [APPROVED_AT, version],
      /UNKNOWN_LABEL/u,
    );
  });
});

// Four tables carry a validity window. 021 enforced monotonicity on
// knowledge_objects only, and the gap on the other three went unnoticed
// because the one test covering the rule tested the one guarded table. This
// covers every windowed table and both columns, so the same omission cannot
// recur silently.
//
// Windows open at vOpen and close at vClose. vMid sits strictly between them
// so that both retroactive edits land on a window the (valid_to > valid_from)
// CHECK still accepts, leaving the trigger as the only thing that can reject
// them. Targeting a version outside the window would be rejected either way
// and the test would pass whether the trigger existed or not. vMid also has to
// differ from vClose: setting valid_to to the value it already holds is a
// no-op UPDATE, which raises nothing.
test("INV-14 refuses to reopen, move, or restart a closed validity window on any windowed table", async () => {
  await waitForDatabase();
  await rolledBack(async (client) => {
    await seedProject(client);
    const vOpen = await nextVersion(client, "inv14_open");
    const vMid = await nextVersion(client, "inv14_mid");
    const vClose = await nextVersion(client, "inv14_close");
    assert.ok(vOpen < vMid && vMid < vClose, "probe versions are not strictly increasing");

    await insertLabel(client, "FTL-9100", vOpen, "window-monotonicity");
    await client.query(
      `INSERT INTO feature_label_aliases (
         label_id, alias, project_scope_id, valid_from_version
       ) VALUES ('FTL-9100', 'window-monotonicity-alias', 'mira', $1)`,
      [vOpen],
    );
    await insertRequirement(client, "REQ-9100", vOpen);
    await insertRequirement(client, "REQ-9101", vOpen);
    const edge = await client.query<{ id: string }>(
      `INSERT INTO relations (
         source_id, relation, target_id, target_kind, valid_from_version
       ) VALUES ('REQ-9100', 'derives_from', 'REQ-9101', 'knowledge_object', $1)
       RETURNING id::text`,
      [vOpen],
    );
    const edgeId = edge.rows[0]?.id;
    assert.ok(edgeId !== undefined, "relation insert returned no id");

    // Closing an open window is permitted and is the operation the live write
    // path performs. If the guard rejected this it would break supersession,
    // so the test asserts the permission as well as the prohibition.
    const closures: readonly [string, readonly unknown[]][] = [
      ["UPDATE knowledge_objects SET valid_to_version = $1 WHERE id = 'REQ-9100'", [vClose]],
      ["UPDATE relations SET valid_to_version = $1 WHERE id = $2", [vClose, edgeId]],
      ["UPDATE feature_labels SET valid_to_version = $1 WHERE id = 'FTL-9100'", [vClose]],
      [
        "UPDATE feature_label_aliases SET valid_to_version = $1 WHERE label_id = 'FTL-9100'",
        [vClose],
      ],
    ];
    for (const [sql, parameters] of closures) {
      const closed = await client.query(sql, parameters);
      assert.equal(closed.rowCount, 1, `closing an open window matched no row: ${sql}`);
    }

    // On knowledge_objects the opening version is refused by the older and
    // broader knowledge_objects_append_only guard, which sorts before the
    // window trigger and so raises first. Either message is a correct refusal;
    // the test asserts the refusal, not which guard got there.
    const windowed: readonly {
      table: string;
      predicate: string;
      parameters: unknown[];
      startImmutable: RegExp;
    }[] = [
      {
        table: "knowledge_objects",
        predicate: "id = 'REQ-9100'",
        parameters: [],
        startImmutable: /VALIDITY_WINDOW_START_IMMUTABLE|IMMUTABLE_AFTER_APPROVAL/u,
      },
      {
        table: "relations",
        predicate: "id = $2",
        parameters: [edgeId],
        startImmutable: /VALIDITY_WINDOW_START_IMMUTABLE/u,
      },
      {
        table: "feature_labels",
        predicate: "id = 'FTL-9100'",
        parameters: [],
        startImmutable: /VALIDITY_WINDOW_START_IMMUTABLE/u,
      },
      {
        table: "feature_label_aliases",
        predicate: "label_id = 'FTL-9100'",
        parameters: [],
        startImmutable: /VALIDITY_WINDOW_START_IMMUTABLE/u,
      },
    ];

    for (const { table, predicate, parameters, startImmutable } of windowed) {
      await assertRejectedInSavepoint(
        client,
        `UPDATE ${table} SET valid_to_version = $1 WHERE ${predicate}`,
        [null, ...parameters],
        /VALIDITY_WINDOW_CLOSED/u,
      );
      await assertRejectedInSavepoint(
        client,
        `UPDATE ${table} SET valid_to_version = $1 WHERE ${predicate}`,
        [vMid, ...parameters],
        /VALIDITY_WINDOW_CLOSED/u,
      );
      await assertRejectedInSavepoint(
        client,
        `UPDATE ${table} SET valid_from_version = $1 WHERE ${predicate}`,
        [vMid, ...parameters],
        startImmutable,
      );
    }
  });
});
