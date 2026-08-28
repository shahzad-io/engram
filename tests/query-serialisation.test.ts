import assert from "node:assert/strict";
import test from "node:test";
import type { Client } from "pg";
import { runCli } from "../dist/cli.js";
import {
  buildContextPack,
  collectMetrics,
  diffStoredContextPacks,
  getArtifact,
  listKnowledgeObjects,
  listScopeTree,
  listTriage,
  reproduceContextPack,
  requirementImpact,
  showKnowledgeObject,
} from "../dist/application/index.js";
import { createCandidate, curationTransaction } from "../dist/application/write/index.js";
import type { KnowledgeObjectWrite, RelationWrite } from "../dist/application/write/index.js";
import { ErrorCode } from "../dist/domain/errors.js";
import type { WireError } from "../dist/wire/envelope.js";
import { waitForDatabase, withClient } from "./support/db.ts";

let serial = 0;

function suffix(): string {
  serial += 1;
  return `${Date.now()}${process.pid}${serial}`;
}

type Probe = {
  readonly client: Client;
  /** The first statement of each query that began while another was running. */
  readonly overlaps: readonly string[];
};

/**
 * Wraps a client so a query issued while another is still running is recorded.
 *
 * A `pg` client is not a pool and does not multiplex. Overlapping queries are
 * serialised at best and interleave protocol state at worst, so this asserts
 * the property directly rather than through the deprecation warning `pg` emits
 * for it — that warning is scheduled to become a removal in pg@9, and a test
 * that watches for it would go quiet exactly when the behaviour became fatal.
 */
function serialisationProbe(client: Client): Probe {
  const overlaps: string[] = [];
  let inFlight = 0;
  const proxy = new Proxy(client, {
    get(target, property) {
      const value = Reflect.get(target, property) as unknown;
      if (property !== "query") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (...args: unknown[]): Promise<unknown> => {
        if (inFlight > 0) {
          const first = args[0];
          const text = typeof first === "string" ? first : JSON.stringify(first);
          overlaps.push(text.replace(/\s+/gu, " ").trim().slice(0, 70));
        }
        inFlight += 1;
        return (value as (...a: unknown[]) => Promise<unknown>).apply(target, args).finally(() => {
          inFlight -= 1;
        });
      };
    },
  });
  return { client: proxy, overlaps };
}

function discussion(id: string, scopeId: string): KnowledgeObjectWrite {
  return {
    id,
    type: "discussion",
    scopeId,
    title: id,
    body: `${id} body`,
    status: "recorded",
    attributes: { medium: "chat", occurred_at: "2026-08-20T00:00:00.000Z", content_ref: id },
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
    attributes: { source: "query serialisation test", rationale: "test" },
    authoredBy: "ai",
  };
}

function artifactObject(id: string, scopeId: string): KnowledgeObjectWrite {
  return {
    id,
    type: "artifact",
    scopeId,
    title: id,
    body: `${id} body`,
    status: "current",
    attributes: {
      kind: "experiment record",
      version: "1",
      location: `/tmp/${id}.canvas.tsx`,
      content_hash: "sha256:test",
      summary: `${id} summary`,
    },
    authoredBy: "ai",
  };
}

function relation(
  sourceId: string,
  verb: RelationWrite["relation"],
  targetId: string,
): RelationWrite {
  return { sourceId, relation: verb, targetId, targetKind: "knowledge_object" };
}

async function fixture(client: Client): Promise<{
  readonly scopeId: string;
  readonly requirementId: string;
  readonly artifactId: string;
  readonly candidateId: string;
  readonly packId: string;
  readonly otherPackId: string;
}> {
  const scopeId = `ser_${suffix()}`;
  await client.query(
    `INSERT INTO scopes (id, kind, parent_id, name) VALUES ($1, 'project', 'global', $1)`,
    [scopeId],
  );
  const originId = `DSC-${suffix()}`;
  const requirementId = `REQ-${suffix()}`;
  const artifactId = `ART-${suffix()}`;
  await curationTransaction(client, { action: "serialisation-test.seed" }, async (transaction) => {
    for (const object of [
      discussion(originId, scopeId),
      requirement(requirementId, scopeId),
      artifactObject(artifactId, scopeId),
    ]) {
      await transaction.insertObject(object);
    }
    await transaction.insertRelation(relation(artifactId, "references", originId));
  });
  const [candidateId] = await createCandidate(client, {
    payload: { objects: [requirement(`REQ-${suffix()}`, scopeId)], relations: [] },
    sourceRef: originId,
  });
  const recipe = { scopeId, intent: "debug", budget: 250_000 } as const;
  const pack = await buildContextPack(client, {
    ...recipe,
    builtAt: new Date("2026-03-01T00:00:00.000Z"),
  });
  const otherPack = await buildContextPack(client, {
    ...recipe,
    builtAt: new Date("2026-03-02T00:00:00.000Z"),
  });
  return {
    scopeId,
    requirementId,
    artifactId,
    candidateId: candidateId as string,
    packId: pack.id,
    otherPackId: otherPack.id,
  };
}

test("no read path issues concurrent queries on one client", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    const seeded = await fixture(client);
    const probe = serialisationProbe(client);

    // Every read entry point a command can reach. Each is driven through the
    // probe rather than the CLI so a failure names the function, not the flag.
    const reads: readonly (readonly [string, () => Promise<unknown>])[] = [
      ["listTriage", () => listTriage(probe.client)],
      ["showKnowledgeObject", () => showKnowledgeObject(probe.client, seeded.requirementId)],
      ["listKnowledgeObjects", () => listKnowledgeObjects(probe.client, seeded.scopeId)],
      ["listScopeTree", () => listScopeTree(probe.client)],
      ["requirementImpact", () => requirementImpact(probe.client, seeded.requirementId)],
      ["getArtifact", () => getArtifact(probe.client, seeded.artifactId)],
      ["collectMetrics", () => collectMetrics(probe.client)],
      ["reproduceContextPack", () => reproduceContextPack(probe.client, seeded.packId)],
      [
        "diffStoredContextPacks",
        () => diffStoredContextPacks(probe.client, seeded.packId, seeded.otherPackId),
      ],
    ];

    for (const [name, read] of reads) {
      const before = probe.overlaps.length;
      await read();
      assert.deepEqual(
        probe.overlaps.slice(before),
        [],
        `${name} issued a query while another was still running`,
      );
    }
  });
});

test("a malformed id returns a typed error rather than a driver message", async () => {
  await waitForDatabase();
  await withClient(async () => {
    // Every command whose id reaches a uuid column. A text-keyed id such as
    // DEC-0001 cannot produce a syntax error, so those commands are absent.
    const commands: readonly (readonly string[])[] = [
      ["triage", "accept", "not-a-uuid"],
      ["triage", "payload", "not-a-uuid"],
      ["triage", "edit", "not-a-uuid", "--payload", "-"],
      ["triage", "merge", "not-a-uuid", "--into", "DEC-0001"],
      ["triage", "reject", "not-a-uuid"],
      ["pack", "reproduce", "not-a-uuid"],
      ["pack", "diff", "not-a-uuid", "00000000-0000-4000-8000-000000000000"],
      ["pack", "diff", "00000000-0000-4000-8000-000000000000", "not-a-uuid"],
    ];

    for (const argv of commands) {
      const label = argv.join(" ");
      const result = await runCli([...argv, "--json"]);
      assert.equal(result.exitCode, 1, `${label} did not fail`);
      const payload = result.payload as { readonly error?: WireError } | null;
      const error = payload?.error;
      assert.ok(error !== undefined, `${label} produced no structured error`);
      assert.equal(error.code, ErrorCode.INVALID_ARGUMENT, `${label}: ${error.message}`);
      assert.match(error.message, /must be a uuid/u, label);
      // The driver's wording is what this replaced; it must not survive.
      assert.doesNotMatch(error.message, /invalid input syntax/iu, label);
    }
  });
});

test("a well-formed id that names nothing is not-found, not invalid", async () => {
  await waitForDatabase();
  await withClient(async () => {
    const absent = "00000000-0000-4000-8000-000000000000";
    const cases: readonly (readonly [readonly string[], string])[] = [
      [["pack", "reproduce", absent], ErrorCode.PACK_NOT_FOUND],
      [["triage", "accept", absent], ErrorCode.CANDIDATE_NOT_FOUND],
      [["triage", "reject", absent], ErrorCode.CANDIDATE_NOT_FOUND],
    ];

    for (const [argv, expected] of cases) {
      const result = await runCli([...argv, "--json"]);
      const payload = result.payload as { readonly error?: WireError } | null;
      assert.equal(result.exitCode, 1, argv.join(" "));
      assert.equal(payload?.error?.code, expected, argv.join(" "));
    }
  });
});
