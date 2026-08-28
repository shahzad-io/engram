import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import {
  buildContextPack,
  listKnowledgeObjects,
  reproduceContextPack,
} from "../dist/application/index.js";
import { curationTransaction } from "../dist/application/write/index.js";
import type { KnowledgeObjectWrite, RelationWrite } from "../dist/application/write/index.js";
import {
  getCurrentGraphVersion,
  readGraphSnapshot,
} from "../dist/infrastructure/persistence/read.js";
import {
  DATABASE_URL,
  waitForDatabase,
  withClient,
  withFreshThrowawayDatabase,
} from "./support/db.ts";

let serial = 0;

function suffix(): string {
  serial += 1;
  return `${Date.now()}${process.pid}${serial}`;
}

/**
 * A Constraint, because every active Constraint in the scope chain enters every
 * pack regardless of intent or filter. A concurrent write that pack assembly
 * might legitimately not select would make this test pass for the wrong reason.
 */
function constraint(id: string, scopeId: string): KnowledgeObjectWrite {
  return {
    id,
    type: "constraint",
    scopeId,
    title: id,
    body: `${id} body`,
    status: "active",
    attributes: { rule: `${id} rule`, enforcement: "hard", axiomatic: false },
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
      rationale: "read pair test",
      reversibility: "cheap",
      alternatives_rejected: [],
    },
    authoredBy: "ai",
  };
}

function requirement(id: string, scopeId: string): KnowledgeObjectWrite {
  return {
    id,
    type: "requirement",
    scopeId,
    title: id,
    body: `${id} body`,
    status: "active",
    attributes: { source: "read pair test", rationale: "test" },
    authoredBy: "ai",
  };
}

/**
 * Lands a committed write from another session between the first and second
 * statements of a read.
 *
 * The window this targets is the one that made a version and the state beside
 * it a claim rather than a pair: two statements, no shared snapshot, and a
 * concurrent curator. Firing after the first statement puts the write inside
 * that window whichever way round the two reads are ordered, so the same test
 * is meaningful against the ordering that was wrong and the one that is right.
 */
function interleavingClient(client: Client, write: () => Promise<void>): Client {
  let fired = false;
  return new Proxy(client, {
    get(target, property) {
      const value = Reflect.get(target, property) as unknown;
      if (property !== "query") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (...args: unknown[]): Promise<unknown> => {
        const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        if (!fired) {
          fired = true;
          await write();
        }
        return result;
      };
    },
  }) as Client;
}

async function withSecondSession<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const other = new Client({ connectionString: DATABASE_URL });
  await other.connect();
  try {
    return await work(other);
  } finally {
    await other.end();
  }
}

function derivesFrom(sourceId: string, targetId: string): RelationWrite {
  return { sourceId, relation: "derives_from", targetId, targetKind: "knowledge_object" };
}

type Seed = { readonly scopeId: string; readonly decisionId: string };

async function seedScope(client: Client): Promise<Seed> {
  const scopeId = `pair_${suffix()}`;
  const requirementId = `REQ-${suffix()}`;
  const decisionId = `DEC-${suffix()}`;
  await client.query(
    `INSERT INTO scopes (id, kind, parent_id, name) VALUES ($1, 'project', 'global', $1)`,
    [scopeId],
  );
  await curationTransaction(client, { action: "read-pair-test.seed" }, async (transaction) => {
    await transaction.insertObject(requirement(requirementId, scopeId));
    await transaction.insertObject(decision(decisionId, scopeId));
    await transaction.insertRelation(derivesFrom(decisionId, requirementId));
  });
  return { scopeId, decisionId };
}

test("a pack built while another session commits reproduces at the version it recorded", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    const { scopeId, decisionId } = await seedScope(client);

    await withSecondSession(async (other) => {
      const racing = interleavingClient(client, async () => {
        await curationTransaction(
          other,
          { action: "read-pair-test.concurrent" },
          async (transaction) => {
            const constraintId = `CON-${suffix()}`;
            await transaction.insertObject(constraint(constraintId, scopeId));
            await transaction.insertRelation(derivesFrom(constraintId, decisionId));
          },
        );
      });

      const built = await buildContextPack(racing, {
        scopeId,
        intent: "debug",
        budget: 250_000,
        builtAt: new Date("2026-03-01T00:00:00.000Z"),
      });

      /*
       * The pack recorded a version. Reproduction reselects from the graph at
       * that version and compares hashes, so it is the direct test of whether
       * the version describes the contents: a build that paired state from
       * before the concurrent commit with the version after it selects fewer
       * objects than its own recorded version holds, and fails here.
       */
      const reproduced = await reproduceContextPack(client, built.id);
      assert.equal(reproduced.pack.recipe.contentHash, built.pack.recipe.contentHash);
    });
  });
});

test("a listing returns exactly the graph at the version it reports", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    const { scopeId } = await seedScope(client);

    const raced = await withSecondSession(async (other) => {
      const racing = interleavingClient(client, async () => {
        await curationTransaction(
          other,
          { action: "read-pair-test.concurrent" },
          async (transaction) => {
            await transaction.insertObject(requirement(`REQ-${suffix()}`, scopeId));
          },
        );
      });
      return listKnowledgeObjects(racing, scopeId);
    });

    /*
     * The graph at a version is immutable, so reading it again later is the
     * honest comparison: whatever the reported version holds now is what the
     * listing should have returned.
     */
    const { set } = await readGraphSnapshot(client);
    const atReportedVersion = set.objects
      .filter(
        (object) =>
          object.scopeId === scopeId &&
          object.validFromVersion <= raced.graphVersion &&
          (object.validToVersion === null || object.validToVersion > raced.graphVersion),
      )
      .map((object) => object.id)
      .sort();

    assert.deepEqual(
      raced.objects.map((object) => object.id).sort(),
      atReportedVersion,
      "listing omitted objects that its own reported graph version contains",
    );
  });
});

test("the current graph version is the highest, not the lexicographically largest", async () => {
  await waitForDatabase();
  await withFreshThrowawayDatabase(async (client) => {
    const scopeId = `pair_${suffix()}`;
    await client.query(
      `INSERT INTO scopes (id, kind, parent_id, name) VALUES ($1, 'project', 'global', $1)`,
      [scopeId],
    );
    /*
     * Past ten. `SELECT version::text ... ORDER BY version` bound to the text
     * output column rather than the bigint input one, so the versions sorted as
     * strings and '9' came back ahead of '10'. Every graph under ten versions
     * agreed with itself, which is why nothing caught this: the fixtures were
     * always smaller than the bug.
     */
    for (let index = 0; index < 12; index += 1) {
      await curationTransaction(client, { action: "read-pair-test.count" }, async (transaction) => {
        await transaction.insertObject(requirement(`REQ-${suffix()}`, scopeId));
      });
    }
    const highest = await client.query<{ version: string }>(
      "SELECT max(version)::text AS version FROM graph_versions",
    );
    const current = await getCurrentGraphVersion(client);
    assert.equal(current.version, Number(highest.rows[0]?.version));
    assert.ok(current.version >= 12, `expected at least 12 versions, got ${current.version}`);
  });
});
