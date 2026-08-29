import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { dryRunBackfill, importBackfill } from "../dist/application/index.js";
import { curationTransaction } from "../dist/application/write/index.js";
import { loadBackfillBundle } from "../dist/infrastructure/index.js";
import type { BackfillBundle, BackfillObjectDraft } from "../dist/domain/index.js";
import { runCli } from "../dist/cli.js";
import { waitForDatabase, withClient } from "./support/db.ts";

let serial = 0;

function uniqueNumber(): string {
  serial += 1;
  return `${Date.now()}${serial}`;
}

function draft(
  type: string,
  id: string,
  status: string,
  attributes: Record<string, unknown>,
  overrides: Partial<BackfillObjectDraft> = {},
): BackfillObjectDraft {
  return {
    sourcePath: `objects/${id}.json`,
    id,
    type,
    scopeId: "global",
    scopeIds: ["global"],
    featureLabels: [],
    title: id,
    body: `${id} body`,
    status,
    attributes,
    supersedesId: null,
    ...overrides,
  };
}

function relation(
  sourceId: string,
  relationName: string,
  targetId: string,
): BackfillBundle["relations"][number] {
  return {
    sourcePath: "relations.json",
    sourceId,
    relation: relationName,
    targetId,
    targetKind: "knowledge_object",
  };
}

function emptyFriction(): BackfillBundle["frictionActions"] {
  return [];
}

async function graphVersionCount(client: {
  query: (sql: string) => Promise<{ rows: Array<{ count: string }> }>;
}): Promise<number> {
  const result = await client.query("SELECT count(*)::text AS count FROM graph_versions");
  return Number(result.rows[0]?.count);
}

async function currentGraphVersion(client: {
  query: (sql: string) => Promise<{ rows: Array<{ version: string }> }>;
}): Promise<number> {
  const result = await client.query(
    "SELECT COALESCE(max(version), 0)::text AS version FROM graph_versions",
  );
  return Number(result.rows[0]?.version);
}

test("backfill dry run reports three deliberate violations together and writes nothing", async () => {
  await waitForDatabase();
  const root = await mkdtemp(path.join(os.tmpdir(), "pke-backfill-dry-"));
  try {
    await mkdir(path.join(root, "objects"));
    const objects = [
      draft("decision", "DEC-9901", "active", {
        statement: "decision without an origin",
        rationale: "test",
        reversibility: "cheap",
        alternatives_rejected: [],
      }),
      draft("requirement", "REQ-9902", "active", {
        source: "backfill",
        rationale: "cycle",
      }),
      draft("requirement", "REQ-9903", "active", {
        source: "backfill",
        rationale: "cycle",
      }),
    ];
    for (const object of objects) {
      await writeFile(
        path.join(root, "objects", `${object.id}.json`),
        JSON.stringify({
          id: object.id,
          type: object.type,
          scope_id: object.scopeId,
          title: object.title,
          body: object.body,
          status: object.status,
          attributes: object.attributes,
        }),
      );
    }
    await writeFile(
      path.join(root, "relations.json"),
      JSON.stringify({
        relations: [
          {
            source_id: "REQ-9902",
            relation: "derives_from",
            target_id: "REQ-9903",
            target_kind: "knowledge_object",
          },
          {
            source_id: "REQ-9903",
            relation: "derives_from",
            target_id: "REQ-9902",
            target_kind: "knowledge_object",
          },
          {
            source_id: "REQ-9902",
            relation: "blocks",
            target_id: "REQ-9903",
            target_kind: "knowledge_object",
          },
        ],
      }),
    );
    await writeFile(
      path.join(root, "friction.json"),
      JSON.stringify({
        actions: [
          {
            action_id: "friction-1",
            kind: "spec_consultation",
            description: "Required attributes not discoverable without consulting Domain Spec",
            abandoned: false,
          },
          {
            action_id: "friction-2",
            kind: "classify",
            description: "Abandoned after repeated validation failures",
            abandoned: true,
          },
        ],
      }),
    );

    await withClient(async (client) => {
      const before = await graphVersionCount(client);
      const loaded = await loadBackfillBundle(root);
      assert.equal(loaded.failures.length, 0);
      assert.equal(loaded.bundle.objects.length, 3);
      assert.equal(loaded.bundle.relations.length, 3);
      const report = await dryRunBackfill(client, root);
      const codes = new Set(report.failures.map((failure) => failure.code));
      assert.ok(codes.has("DECISION_ORIGIN_REQUIRED"));
      assert.ok(codes.has("ILLEGAL_RELATION"));
      assert.ok(codes.has("CYCLE_DETECTED"));
      assert.equal(report.friction.abandonedCount, 1);
      assert.equal(report.friction.actions.length, 2);
      assert.equal(report.friction.actions[0]?.kind, "spec_consultation");
      assert.equal(await graphVersionCount(client), before);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an item with no legal home becomes a gap and is not imported", async () => {
  await waitForDatabase();
  const suffix = uniqueNumber();
  const gapId = `RSK-${suffix}`;
  const requirementId = `REQ-${suffix}`;
  const bundle: BackfillBundle = {
    objects: [
      draft("risk", gapId, "open", {}),
      draft("requirement", requirementId, "active", {
        source: "backfill",
        rationale: "valid requirement",
      }),
    ],
    relations: [],
    frictionActions: emptyFriction(),
  };

  await withClient(async (client) => {
    const beforeCount = await graphVersionCount(client);
    const beforeVersion = await currentGraphVersion(client);
    const report = await importBackfill(client, bundle);
    assert.equal(report.failures.length, 0);
    assert.equal(report.gaps.length, 1);
    assert.equal(report.gaps[0]?.candidateConcept, "risk");
    assert.equal(report.graphVersion, beforeVersion + 1);
    const rows = await client.query<{ id: string; authored_by: string; source_ref: string }>(
      "SELECT id, authored_by, source_ref FROM knowledge_objects WHERE id = ANY($1::text[])",
      [[gapId, requirementId]],
    );
    assert.deepEqual(rows.rows, [
      {
        id: requirementId,
        authored_by: "human",
        source_ref: `backfill:objects/${requirementId}.json`,
      },
    ]);
    assert.equal(await graphVersionCount(client), beforeCount + 1);
  });
});

test("a valid backfill imports all objects and relations in exactly one graph version", async () => {
  await waitForDatabase();
  const suffix = uniqueNumber();
  const discussionId = `DSC-${suffix}`;
  const decisionId = `DEC-${suffix}`;
  const bundle: BackfillBundle = {
    objects: [
      draft("discussion", discussionId, "recorded", {
        medium: "chat",
        occurred_at: "2026-08-19T10:00:00Z",
        content_ref: discussionId,
      }),
      draft("decision", decisionId, "active", {
        statement: "import the decision",
        rationale: "it has an origin",
        reversibility: "cheap",
        alternatives_rejected: [],
      }),
    ],
    relations: [relation(decisionId, "derives_from", discussionId)],
    frictionActions: emptyFriction(),
  };

  await withClient(async (client) => {
    const beforeCount = await graphVersionCount(client);
    const beforeVersion = await currentGraphVersion(client);
    const report = await importBackfill(client, bundle);
    assert.equal(report.failures.length, 0);
    assert.equal(report.gaps.length, 0);
    assert.equal(report.importedObjectIds.length, 2);
    assert.equal(report.importedRelationCount, 1);
    assert.equal(report.graphVersion, beforeVersion + 1);
    const objectRows = await client.query<{
      id: string;
      authored_by: string;
      source_ref: string;
      valid_from_version: string;
    }>(
      "SELECT id, authored_by, source_ref, valid_from_version::text FROM knowledge_objects WHERE id = ANY($1::text[]) ORDER BY id",
      [[discussionId, decisionId]],
    );
    assert.equal(objectRows.rows.length, 2);
    assert.ok(objectRows.rows.every((row) => row.authored_by === "human"));
    assert.ok(objectRows.rows.every((row) => row.source_ref.startsWith("backfill:objects/")));
    assert.ok(
      objectRows.rows.every((row) => Number(row.valid_from_version) === report.graphVersion),
    );
    const relationRows = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM relations WHERE source_id = $1 AND target_id = $2",
      [decisionId, discussionId],
    );
    assert.equal(Number(relationRows.rows[0]?.count), 1);
    assert.equal(await graphVersionCount(client), beforeCount + 1);
  });
});

test("camelCase backfill attributes are projected to storage shape before import", async () => {
  await waitForDatabase();
  const suffix = uniqueNumber();
  const discussionId = `DSC-${suffix}`;
  const decisionId = `DEC-${suffix}`;
  const bundle: BackfillBundle = {
    objects: [
      draft("discussion", discussionId, "recorded", {
        medium: "chat",
        occurredAt: "2026-08-24T00:00:00.000Z",
        contentRef: {
          storage: "external",
          location: "fovea://conversation/backfill#message",
        },
      }),
      draft("decision", decisionId, "active", {
        statement: "Project validated backfill objects before persistence.",
        rationale: "Dry run and import must consume the same representation.",
        reversibility: "cheap",
        alternativesRejected: [],
      }),
    ],
    relations: [relation(decisionId, "derives_from", discussionId)],
    frictionActions: emptyFriction(),
  };

  await withClient(async (client) => {
    const dryRun = await dryRunBackfill(client, bundle);
    assert.equal(dryRun.failures.length, 0);

    const report = await importBackfill(client, bundle);
    assert.equal(report.failures.length, 0);

    const rows = await client.query<{ id: string; attributes: Record<string, unknown> }>(
      `SELECT id, attributes
       FROM knowledge_objects
       WHERE id = ANY($1::text[])
       ORDER BY id`,
      [[discussionId, decisionId]],
    );
    const byId = new Map(rows.rows.map((row) => [row.id, row.attributes]));
    assert.deepEqual(Object.keys(byId.get(discussionId) ?? {}).sort(), [
      "content_ref",
      "medium",
      "occurred_at",
    ]);
    assert.deepEqual(Object.keys(byId.get(decisionId) ?? {}).sort(), [
      "alternatives_rejected",
      "rationale",
      "reversibility",
      "statement",
    ]);
  });
});

test("unrecoverable origin is importer-only and bypasses INV-3 only in backfill mode", async () => {
  await waitForDatabase();
  const suffix = uniqueNumber();
  const backfillId = `DEC-${suffix}`;
  const liveId = `DEC-${suffix}1`;
  const attributes = {
    statement: "historical decision",
    rationale: "the surviving record has no legal origin",
    reversibility: "costly",
    alternatives_rejected: [],
    origin: "unrecoverable",
  };

  await withClient(async (client) => {
    const report = await importBackfill(client, {
      objects: [draft("decision", backfillId, "active", attributes)],
      relations: [],
      frictionActions: emptyFriction(),
    });
    assert.equal(report.failures.length, 0);
    const row = await client.query<{
      origin: string;
      backfill_mode: boolean;
    }>(
      `SELECT o.attributes ->> 'origin' AS origin, g.backfill_mode
       FROM knowledge_objects o
       INNER JOIN graph_versions g ON g.version = o.valid_from_version
       WHERE o.id = $1`,
      [backfillId],
    );
    assert.deepEqual(row.rows[0], { origin: "unrecoverable", backfill_mode: true });

    await assert.rejects(
      curationTransaction(
        client,
        { action: "test.live-origin", actor: "curator" },
        async (transaction) => {
          await transaction.insertObject({
            id: liveId,
            type: "decision",
            scopeId: "global",
            title: liveId,
            body: "live marker",
            status: "active",
            attributes,
            authoredBy: "human",
          });
        },
      ),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "BACKFILL_ORIGIN_FORBIDDEN",
    );
  });
});

test("a Decision without an origin edge or marker is rejected in both modes", async () => {
  await waitForDatabase();
  const suffix = uniqueNumber();
  const backfillId = `DEC-${suffix}`;
  const liveId = `DEC-${suffix}1`;
  const attributes = {
    statement: "originless decision",
    rationale: "test",
    reversibility: "cheap",
    alternatives_rejected: [],
  };

  await withClient(async (client) => {
    const report = await dryRunBackfill(client, {
      objects: [draft("decision", backfillId, "active", attributes)],
      relations: [],
      frictionActions: emptyFriction(),
    });
    assert.ok(report.failures.some((failure) => failure.code === "DECISION_ORIGIN_REQUIRED"));

    await assert.rejects(
      curationTransaction(
        client,
        { action: "test.live-originless", actor: "curator" },
        async (transaction) => {
          await transaction.insertObject({
            id: liveId,
            type: "decision",
            scopeId: "global",
            title: liveId,
            body: "live originless",
            status: "active",
            attributes,
            authoredBy: "human",
          });
        },
      ),
      /DECISION_ORIGIN_REQUIRED/u,
    );
  });
});

test("backfill accepts historical terminal states only with their required context", async () => {
  await waitForDatabase();
  const suffix = uniqueNumber();
  const requirementId = `REQ-${suffix}`;
  const predecessorId = `DEC-${suffix}1`;
  const successorId = `DEC-${suffix}2`;
  const questionId = `OQU-${suffix}`;
  const resolverId = `DEC-${suffix}3`;
  const decisionAttributes = (statement: string) => ({
    statement,
    rationale: "historical evidence",
    reversibility: "costly",
    alternatives_rejected: [],
  });

  await withClient(async (client) => {
    const report = await importBackfill(client, {
      objects: [
        draft("requirement", requirementId, "active", {
          source: "historical",
          rationale: "source record",
        }),
        draft("decision", predecessorId, "superseded", decisionAttributes("old decision")),
        draft("decision", successorId, "active", decisionAttributes("replacement decision"), {
          supersedesId: predecessorId,
        }),
        draft("open_question", questionId, "resolved", {
          question: "Which identity is authoritative?",
          blocking: true,
        }),
        draft("decision", resolverId, "active", decisionAttributes("resolve the question")),
      ],
      relations: [
        relation(predecessorId, "derives_from", requirementId),
        relation(successorId, "derives_from", requirementId),
        relation(resolverId, "derives_from", questionId),
      ],
      frictionActions: emptyFriction(),
    });
    assert.equal(report.failures.length, 0);
    const rows = await client.query<{
      id: string;
      status: string;
      superseded_by_id: string | null;
    }>(
      `SELECT id, status, superseded_by_id
       FROM knowledge_objects
       WHERE id = ANY($1::text[])
       ORDER BY id`,
      [[predecessorId, successorId, questionId]],
    );
    assert.deepEqual(rows.rows, [
      { id: predecessorId, status: "superseded", superseded_by_id: successorId },
      { id: successorId, status: "active", superseded_by_id: null },
      { id: questionId, status: "resolved", superseded_by_id: null },
    ]);
  });
});

test("rejected Hypothesis imports directly in backfill mode but not live capture", async () => {
  await waitForDatabase();
  const suffix = uniqueNumber();
  const backfillId = `HYP-${suffix}`;
  const liveId = `HYP-${suffix}1`;
  const attributes = {
    what_was_tried: "email identity",
    why_it_failed: "identity collisions caused a re-import",
    evidence_ref: "XRF-0001",
  };

  await withClient(async (client) => {
    const report = await importBackfill(client, {
      objects: [draft("hypothesis", backfillId, "rejected", attributes)],
      relations: [],
      frictionActions: emptyFriction(),
    });
    assert.equal(report.failures.length, 0);
    const row = await client.query<{ status: string }>(
      "SELECT status FROM knowledge_objects WHERE id = $1",
      [backfillId],
    );
    assert.equal(row.rows[0]?.status, "rejected");

    await assert.rejects(
      curationTransaction(
        client,
        { action: "test.live-hypothesis", actor: "curator" },
        async (transaction) => {
          await transaction.insertObject({
            id: liveId,
            type: "hypothesis",
            scopeId: "global",
            title: liveId,
            body: "live hypothesis",
            status: "rejected",
            attributes,
            authoredBy: "human",
          });
        },
      ),
      /initial status explored/u,
    );
  });
});

test("dry run reports structural duplicate pairs without failures", async () => {
  await waitForDatabase();
  const suffix = uniqueNumber();
  const objects = [
    [`DEC-${suffix}3`, "Use users.id as the cross-system identity"],
    [`DEC-${suffix}7`, "Contact identity is brand-scoped upstream identity"],
    [`DEC-${suffix}4`, "Separate critical event ingestion from polling"],
    [`DEC-${suffix}9`, "Separate critical event processing from routine polling"],
    [`DEC-${suffix}5`, "Make inbound events idempotent"],
    [`DEC-${suffix}1`, "Make brand events idempotent"],
  ] as const;
  const markerAttributes = (title: string) => ({
    statement: title,
    rationale: "test",
    reversibility: "costly",
    alternatives_rejected: [],
    origin: "unrecoverable",
  });

  await withClient(async (client) => {
    const report = await dryRunBackfill(client, {
      objects: objects.map(([id, title]) =>
        draft("decision", id, "active", markerAttributes(title), { title }),
      ),
      relations: [],
      frictionActions: emptyFriction(),
    });
    assert.equal(report.failures.length, 0);
    const pairs = new Set(report.warnings.map((warning) => warning.objectIds.join(":")));
    assert.ok(pairs.has(`${objects[0][0]}:${objects[1][0]}`));
    assert.ok(pairs.has(`${objects[2][0]}:${objects[3][0]}`));
    assert.ok(
      pairs.has(
        [...[objects[4][0], objects[5][0]]]
          .sort((left, right) => left.localeCompare(right))
          .join(":"),
      ),
    );
  });
});

// The exit code was never covered. runBackfill set process.exitCode = 1 in two
// places and both were dead: dispatch returns null for a self-printing
// command, runCli returns exitCode 0 for a command that did not throw, and the
// entry point assigns that 0 last. Reproduced before the fix: a dry run
// reporting failures printed all of them and exited 0.
//
// The test drives runCli rather than a subprocess because that is where the
// defect is — runCli's own return value was wrong, so a subprocess check would
// pass through the same broken value to reach the same conclusion more slowly.
//
// Both directions are asserted. A test that only checked the failing case
// would pass against a CLI that always exited 1.
test("backfill exits non-zero when its report contains failures, and zero when it does not", async () => {
  await waitForDatabase();
  const root = await mkdtemp(path.join(os.tmpdir(), "pke-backfill-exit-"));
  try {
    await mkdir(path.join(root, "objects"));

    // A Decision with no derives_from edge. Chosen because the failure is
    // intrinsic to the bundle: it does not depend on what the shared test
    // database happens to contain, so the test cannot pass or fail for a
    // reason unrelated to the exit code.
    const failingId = `DEC-${uniqueNumber()}`;
    await writeFile(
      path.join(root, "objects", `${failingId}.json`),
      JSON.stringify({
        id: failingId,
        type: "decision",
        scope_id: "global",
        title: failingId,
        body: `${failingId} body`,
        status: "active",
        attributes: {
          statement: "decision without an origin",
          rationale: "test",
          reversibility: "cheap",
          alternatives_rejected: [],
        },
      }),
    );

    const failed = await runCli(["backfill", "--dry-run", root]);
    // Confirms the fixture actually produced failures. Without this the exit
    // code assertion could be satisfied by a bundle that failed to load at all.
    assert.ok(
      failed.payload === null || failed.payload === undefined,
      "backfill writes its own stdout and should not return a payload",
    );
    assert.equal(failed.exitCode, 1);
    assert.match(String(failed.stderr), /failure\(s\)/u);

    const cleanRoot = await mkdtemp(path.join(os.tmpdir(), "pke-backfill-exit-ok-"));
    try {
      await mkdir(path.join(cleanRoot, "objects"));
      const cleanId = `REQ-${uniqueNumber()}`;
      await writeFile(
        path.join(cleanRoot, "objects", `${cleanId}.json`),
        JSON.stringify({
          id: cleanId,
          type: "requirement",
          scope_id: "global",
          title: cleanId,
          body: `${cleanId} body`,
          status: "active",
          attributes: { source: "backfill", rationale: "exit code coverage" },
        }),
      );
      const clean = await runCli(["backfill", "--dry-run", cleanRoot]);
      assert.equal(clean.exitCode, 0);
      assert.equal(clean.stderr, null);
    } finally {
      await rm(cleanRoot, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
