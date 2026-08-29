import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Client } from "pg";
import { runCli, type CliResult } from "../dist/cli.js";
import { ErrorCode } from "../dist/domain/errors.js";
import type { WireError } from "../dist/wire/envelope.js";
import {
  createCandidate,
  curationTransaction,
  type CandidatePayload,
  type KnowledgeObjectWrite,
  type RelationWrite,
} from "../dist/application/write/index.js";
import { buildContextPack } from "../dist/application/index.js";
import { waitForDatabase, withClient } from "./support/db.ts";

let serial = 0;

function suffix(): string {
  serial += 1;
  return `${Date.now()}${process.pid}${serial}`;
}

async function createProject(client: Client): Promise<string> {
  const id = `cli_${suffix()}`;
  await client.query(
    `INSERT INTO scopes (id, kind, parent_id, name)
     VALUES ($1, 'project', 'global', $1)`,
    [id],
  );
  return id;
}

function discussion(id: string, scopeId: string): KnowledgeObjectWrite {
  return {
    id,
    type: "discussion",
    scopeId,
    title: id,
    body: `${id} body`,
    status: "recorded",
    attributes: {
      medium: "chat",
      occurred_at: "2026-08-20T00:00:00.000Z",
      content_ref: id,
    },
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
      rationale: "curator CLI test",
      reversibility: "cheap",
      alternatives_rejected: [],
    },
    authoredBy: "ai",
  };
}

function constraint(id: string, scopeId: string): KnowledgeObjectWrite {
  return {
    id,
    type: "constraint",
    scopeId,
    title: id,
    body: `${id} body`,
    status: "active",
    attributes: {
      rule: `${id} rule`,
      enforcement: "hard",
      axiomatic: false,
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
    attributes: { source: "curator CLI test", rationale: "test" },
    authoredBy: "ai",
  };
}

function artifact(id: string, scopeId: string, location: string): KnowledgeObjectWrite {
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
      location,
      content_hash: "sha256:test",
      summary: `${id} summary`,
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
    attributes: {
      what_was_tried: "tried",
      why_it_failed: "failed",
      evidence_ref: id,
    },
    authoredBy: "ai",
  };
}

function observation(id: string, scopeId: string): KnowledgeObjectWrite {
  return {
    id,
    type: "observation",
    scopeId,
    title: id,
    body: `${id} body`,
    status: "observed",
    attributes: {
      observed_at: "2026-08-01T00:00:00.000Z",
      evidence_ref: id,
      review_by: new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString(),
    },
    authoredBy: "ai",
  };
}

function relation(
  sourceId: string,
  relationName: RelationWrite["relation"],
  targetId: string,
): RelationWrite {
  return {
    sourceId,
    relation: relationName,
    targetId,
    targetKind: "knowledge_object",
  };
}

async function seed(
  client: Client,
  objects: readonly KnowledgeObjectWrite[],
  relations: readonly RelationWrite[] = [],
): Promise<void> {
  await curationTransaction(client, { action: "cli-test.seed" }, async (transaction) => {
    for (const object of objects) await transaction.insertObject(object);
    for (const edge of relations) await transaction.insertRelation(edge);
  });
}

async function graphVersionCount(client: Client): Promise<number> {
  const result = await client.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM graph_versions",
  );
  return Number(result.rows[0]?.count ?? 0);
}

/** True when any key anywhere under `value` survived snake_case normalisation. */
function hasCamelCaseKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasCamelCaseKey);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(
    ([key, entry]) => /[A-Z]/u.test(key) || hasCamelCaseKey(entry),
  );
}

/** Runs a command and asserts it succeeded, surfacing stderr when it did not. */
async function ok(argv: readonly string[]): Promise<CliResult> {
  const result = await runCli(argv);
  // Under --json the reason is in the payload, not stderr, and a bare
  // `exitCode` assertion would report the failure without saying what it was.
  const payload = result.payload as { readonly error?: WireError } | null;
  const reason = result.stderr ?? payload?.error?.message ?? "command failed";
  assert.equal(result.exitCode, 0, `${argv.join(" ")}: ${reason}`);
  return result;
}

/** Asserts a command failed and wrote nothing to stdout. */
function assertFailed(result: CliResult, message: RegExp): void {
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, null);
  assert.match(result.stderr ?? "", message);
}

/** The structured error a `--json` failure carries, proven to be present. */
function structuredError(result: CliResult): WireError {
  assert.equal(result.exitCode, 1);
  const payload = result.payload as { readonly error?: WireError } | null;
  assert.ok(payload?.error !== undefined, "expected a structured error under --json");
  return payload.error;
}

async function withEditor<T>(command: string, work: () => Promise<T>): Promise<T> {
  const previousEditor = process.env.EDITOR;
  const previousVisual = process.env.VISUAL;
  process.env.EDITOR = command;
  delete process.env.VISUAL;
  try {
    return await work();
  } finally {
    if (previousEditor === undefined) {
      delete process.env.EDITOR;
    } else {
      process.env.EDITOR = previousEditor;
    }
    if (previousVisual === undefined) {
      delete process.env.VISUAL;
    } else {
      process.env.VISUAL = previousVisual;
    }
  }
}

/** Removes $EDITOR and $VISUAL entirely, so an editor path cannot be reached. */
async function withoutEditor<T>(work: () => Promise<T>): Promise<T> {
  const previousEditor = process.env.EDITOR;
  const previousVisual = process.env.VISUAL;
  delete process.env.EDITOR;
  delete process.env.VISUAL;
  try {
    return await work();
  } finally {
    if (previousEditor !== undefined) process.env.EDITOR = previousEditor;
    if (previousVisual !== undefined) process.env.VISUAL = previousVisual;
  }
}

test("triage edit accepts a payload with no editor available", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    const scopeId = await createProject(client);
    const originId = `DSC-${suffix()}`;
    await seed(client, [discussion(originId, scopeId)]);
    const requirementId = `REQ-${suffix()}`;
    const [candidateId] = await createCandidate(client, {
      payload: { objects: [requirement(requirementId, scopeId)], relations: [] },
      sourceRef: originId,
    });
    const before = await graphVersionCount(client);

    const directory = await mkdtemp(path.join(os.tmpdir(), "pke-payload-"));
    try {
      // The payload the editor would have shown, fetched and edited as data.
      const preview = (
        await withoutEditor(() => ok(["triage", "payload", candidateId as string, "--json"]))
      ).payload as { readonly data: { readonly payload: CandidatePayload } };
      const edited = {
        ...preview.data.payload,
        objects: preview.data.payload.objects.map((object) => ({
          ...object,
          title: "edited-without-an-editor",
        })),
      };
      const file = path.join(directory, "payload.json");
      await writeFile(file, `${JSON.stringify(edited, null, 2)}\n`);

      await withoutEditor(() => ok(["triage", "edit", candidateId as string, "--payload", file]));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }

    assert.equal(await graphVersionCount(client), before + 1);
    const stored = await client.query<{ title: string; authored_by: string }>(
      `SELECT title, authored_by FROM knowledge_objects WHERE id = $1`,
      [requirementId],
    );
    assert.equal(stored.rows[0]?.title, "edited-without-an-editor");
    // A real content edit, so the object is the curator's, not the model's.
    assert.equal(stored.rows[0]?.authored_by, "human");
  });
});

test("triage edit without an editor or a payload says which flag to pass", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    const scopeId = await createProject(client);
    const originId = `DSC-${suffix()}`;
    await seed(client, [discussion(originId, scopeId)]);
    const [candidateId] = await createCandidate(client, {
      payload: { objects: [requirement(`REQ-${suffix()}`, scopeId)], relations: [] },
      sourceRef: originId,
    });
    const before = await graphVersionCount(client);

    const error = structuredError(
      await withoutEditor(() => runCli(["triage", "edit", candidateId as string, "--json"])),
    );
    assert.equal(error.code, ErrorCode.EDITOR_UNAVAILABLE);
    assert.match(error.message, /--payload/);
    assert.equal(await graphVersionCount(client), before);
  });
});

test("an unchanged editor buffer aborts and commits nothing", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    const scopeId = await createProject(client);
    const originId = `DSC-${suffix()}`;
    await seed(client, [discussion(originId, scopeId)]);
    const requirementId = `REQ-${suffix()}`;
    const [candidateId] = await createCandidate(client, {
      payload: { objects: [requirement(requirementId, scopeId)], relations: [] },
      sourceRef: originId,
    });
    const before = await graphVersionCount(client);

    // A GUI editor without a wait flag: forks, exits 0, touches nothing. The
    // buffer parses cleanly, so only the byte comparison catches it.
    const result = await withEditor(`"${process.execPath}" -e process.exit(0)`, () =>
      runCli(["triage", "edit", candidateId as string, "--json"]),
    );
    const error = structuredError(result);
    assert.equal(error.code, ErrorCode.EDIT_UNCHANGED);
    assert.match(error.message, /--payload/);

    assert.equal(await graphVersionCount(client), before);
    const candidate = await client.query<{ status: string }>(
      "SELECT status FROM candidates WHERE id = $1::uuid",
      [candidateId],
    );
    assert.equal(candidate.rows[0]?.status, "pending");
    const objects = await client.query(`SELECT 1 FROM knowledge_objects WHERE id = $1`, [
      requirementId,
    ]);
    assert.equal(objects.rowCount, 0);
  });
});

test("no command commits and then reports failure", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    const scopeId = await createProject(client);
    const originId = `DSC-${suffix()}`;
    await seed(client, [discussion(originId, scopeId)]);

    // Every failure mode reachable from the write path: a bad selection, an
    // unchanged editor buffer, a rejected payload, and a missing object.
    const [candidateId] = await createCandidate(client, {
      payload: { objects: [requirement(`REQ-${suffix()}`, scopeId)], relations: [] },
      sourceRef: originId,
    });
    const directory = await mkdtemp(path.join(os.tmpdir(), "pke-atomic-"));
    const bad = path.join(directory, "bad.json");
    await writeFile(bad, `${JSON.stringify({ objects: "not-an-array" }, null, 2)}\n`);

    const failures: readonly (readonly string[])[] = [
      ["triage", "accept", candidateId as string, "--elements", "CAND-does-not-exist"],
      ["triage", "edit", candidateId as string, "--payload", bad],
      ["triage", "merge", candidateId as string, "--into", "DEC-does-not-exist"],
      ["show", "DEC-does-not-exist"],
      ["verify", "DEC-does-not-exist"],
      ["retract", "DEC-does-not-exist"],
      ["transition", "DEC-does-not-exist", "active"],
      ["supersede", "DEC-does-not-exist", "--file", bad],
    ];

    try {
      for (const argv of failures) {
        const before = await graphVersionCount(client);
        const result = await withoutEditor(() => runCli([...argv, "--json"]));
        const label = argv.join(" ");

        assert.equal(result.exitCode, 1, `${label} did not fail`);
        assert.ok(structuredError(result).code.length > 0, label);
        // The invariant: a reported failure left the graph where it was.
        assert.equal(await graphVersionCount(client), before, `${label} committed then reported`);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }

    // And the candidate never moved off pending through any of them.
    const candidate = await client.query<{ status: string }>(
      "SELECT status FROM candidates WHERE id = $1::uuid",
      [candidateId],
    );
    assert.equal(candidate.rows[0]?.status, "pending");
  });
});

test("every curator command under --json emits a parseable envelope", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    const scopeId = await createProject(client);
    const originId = `DSC-${suffix()}`;
    const decisionId = `DEC-${suffix()}`;
    const requirementId = `REQ-${suffix()}`;
    const hypothesisId = `HYP-${suffix()}`;
    await seed(
      client,
      [
        discussion(originId, scopeId),
        requirement(requirementId, scopeId),
        decision(decisionId, scopeId),
        hypothesis(hypothesisId, scopeId),
      ],
      [
        relation(decisionId, "derives_from", originId),
        relation(decisionId, "derives_from", requirementId),
        relation(hypothesisId, "derives_from", originId),
      ],
    );
    const [candidateId] = await createCandidate(client, {
      payload: { objects: [requirement(`REQ-${suffix()}`, scopeId)], relations: [] },
      sourceRef: originId,
    });

    // Two stored packs so `pack diff` and `pack reproduce` have real ids. Diff
    // requires identical recipes, so the pair differs only by graph version.
    const recipe = { scopeId, intent: "debug", budget: 250_000 } as const;
    const left = await buildContextPack(client, {
      ...recipe,
      builtAt: new Date("2026-02-01T00:00:00.000Z"),
    });

    // Padded ids: the id allocator reads the numeric part of every ART- id as a
    // bigint, so a timestamp-shaped suffix here breaks allocation for the suite.
    serial += 1;
    const artifactId = `ART-${String(3000 + serial).padStart(4, "0")}`;
    const successorId = `ART-${String(3500 + serial).padStart(4, "0")}`;
    await seed(
      client,
      [artifact(artifactId, scopeId, "/tmp/envelope-before.canvas.tsx")],
      [relation(artifactId, "references", originId)],
    );
    const right = await buildContextPack(client, {
      ...recipe,
      builtAt: new Date("2026-02-02T00:00:00.000Z"),
    });

    const supersedeDirectory = await mkdtemp(path.join(os.tmpdir(), "pke-envelope-"));
    const supersedeFile = path.join(supersedeDirectory, "successor.json");
    await writeFile(
      supersedeFile,
      `${JSON.stringify(
        {
          object: {
            ...artifact(successorId, scopeId, "/tmp/envelope-after.canvas.tsx"),
            authoredBy: "human",
            supersedesId: artifactId,
          },
          relations: [relation(successorId, "references", originId)],
          repoint: [],
        },
        null,
        2,
      )}\n`,
    );

    // One invocation of every command that accepts --json, reads included so a
    // parse failure is attributed to the command that produced it.
    const commands: readonly (readonly string[])[] = [
      ["triage", "list"],
      ["triage", "payload", candidateId as string],
      ["show", decisionId],
      ["list", "--scope", scopeId],
      ["impact", requirementId],
      ["metrics"],
      ["scope", "list"],
      ["pack", "diff", left.id, right.id],
      ["pack", "reproduce", left.id],
      ["relitigation", "log", "--object", decisionId, "--note", "envelope test"],
      ["maintenance", "--candidate-days", "90"],
      ["verify", decisionId],
      ["supersede", artifactId, "--file", supersedeFile],
      ["transition", hypothesisId, "rejected"],
      ["retract", decisionId],
    ];

    for (const argv of commands) {
      const label = argv.join(" ");
      const result = await ok([...argv, "--json"]);
      assert.equal(result.stderr, null, label);
      assert.ok(result.stdout !== null, `${label} wrote nothing`);

      const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
      assert.deepEqual(envelope, result.payload, `${label} payload and stdout disagree`);
      assert.ok("command" in envelope, `${label} has no command`);
      assert.ok("graph_version" in envelope, `${label} has no graph_version`);
      assert.ok("data" in envelope, `${label} has no data`);
      // Writes carry a version too, which is the point of putting it on every command.
      assert.equal(typeof envelope.graph_version, "number", `${label} graph_version`);
      assert.equal(hasCamelCaseKey(envelope.data), false, `${label} leaked a camelCase key`);
      assert.doesNotMatch(result.stdout, /\u001b\[/u, `${label} emitted ANSI`);
    }

    await rm(supersedeDirectory, { recursive: true, force: true });
  });
});

test("a failing command exits non-zero with every failure the accumulator produced", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    const scopeId = await createProject(client);
    // A Decision with no derives_from origin and a Constraint that inherits the
    // problem: two rejections from one pass, not one.
    const decisionId = `DEC-${suffix()}`;
    const constraintId = `CON-${suffix()}`;
    const [candidateId] = await createCandidate(client, {
      payload: {
        objects: [decision(decisionId, scopeId), constraint(constraintId, scopeId)],
        relations: [],
      },
      sourceRef: null,
    });
    const before = await graphVersionCount(client);

    const result = await runCli(["triage", "accept", candidateId as string, "--json"]);
    const error = structuredError(result);

    assert.ok(result.stdout !== null);
    assert.doesNotThrow(() => JSON.parse(result.stdout as string));
    assert.ok(error.failures.length >= 1);
    // `code`/`message` mirror the first failure, so a caller keying only on
    // those behaves as it did before validation accumulated.
    assert.equal(error.code, error.failures[0]?.code);
    assert.equal(error.message, error.failures[0]?.message);
    for (const failure of error.failures) {
      assert.equal(typeof failure.code, "string");
      assert.equal(typeof failure.message, "string");
    }

    assert.equal(await graphVersionCount(client), before);
  });
});

test("--json is refused rather than silently ignored by the commands that cannot honour it", async () => {
  await waitForDatabase();
  for (const command of ["migrate", "mcp", "serve", "backfill"]) {
    const error = structuredError(await runCli([command, "--json"]));
    assert.equal(error.code, ErrorCode.INVALID_USAGE);
    assert.match(error.message, /--json is not available/);
  }
});

test("triage CLI accepts a selected multi-element subset in one version", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    const scopeId = await createProject(client);
    const originId = `DSC-${suffix()}`;
    await seed(client, [discussion(originId, scopeId)]);
    const decisionId = `DEC-${suffix()}`;
    const constraintId = `CON-${suffix()}`;
    const payload: CandidatePayload = {
      objects: [decision(decisionId, scopeId), constraint(constraintId, scopeId)],
      relations: [
        relation(decisionId, "derives_from", originId),
        relation(constraintId, "derives_from", decisionId),
      ],
    };
    const candidateIds = await createCandidate(client, { payload, sourceRef: originId });
    const before = await graphVersionCount(client);

    await ok([
      "triage",
      "accept",
      candidateIds[0] as string,
      "--elements",
      candidateIds[0] as string,
      candidateIds[1] as string,
    ]);

    assert.equal(await graphVersionCount(client), before + 1);
    const objects = await client.query<{ id: string; valid_from_version: string }>(
      `SELECT id, valid_from_version::text
       FROM knowledge_objects
       WHERE id = ANY($1::text[])
       ORDER BY id`,
      [[decisionId, constraintId]],
    );
    assert.equal(objects.rowCount, 2);
    const version = objects.rows[0]?.valid_from_version;
    assert.ok(version);
    assert.ok(objects.rows.every((row) => row.valid_from_version === version));
  });
});

test("triage reject closes only the Candidate and retains its originating Discussion", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    const scopeId = await createProject(client);
    const originId = `DSC-${suffix()}`;
    await seed(client, [discussion(originId, scopeId)]);
    const candidateObjectId = `REQ-${suffix()}`;
    const [candidateId] = await createCandidate(client, {
      payload: { objects: [requirement(candidateObjectId, scopeId)], relations: [] },
      sourceRef: originId,
    });
    const before = await graphVersionCount(client);

    await ok(["triage", "reject", candidateId as string]);

    assert.equal(await graphVersionCount(client), before);
    const candidate = await client.query<{ status: string }>(
      "SELECT status FROM candidates WHERE id = $1::uuid",
      [candidateId],
    );
    assert.equal(candidate.rows[0]?.status, "rejected");
    const retainedDiscussion = await client.query<{ id: string }>(
      "SELECT id FROM knowledge_objects WHERE id = $1",
      [originId],
    );
    assert.deepEqual(retainedDiscussion.rows, [{ id: originId }]);
  });
});

type TriageListing = {
  readonly data: {
    readonly candidate_status: string;
    readonly candidates: readonly {
      readonly id: string;
      readonly status: string;
      readonly payload: { readonly objects: readonly { readonly title: string }[] };
    }[];
    readonly pending_candidates: readonly { readonly id: string }[];
  };
};

async function triageListing(argv: readonly string[]): Promise<TriageListing["data"]> {
  return ((await ok([...argv, "--json"])).payload as TriageListing).data;
}

function ids(rows: readonly { readonly id: string }[]): readonly string[] {
  return rows.map((row) => row.id);
}

test("a rejected candidate is unreadable by default and listed under --status", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    const scopeId = await createProject(client);
    const originId = `DSC-${suffix()}`;
    await seed(client, [discussion(originId, scopeId)]);
    const [rejectedId] = await createCandidate(client, {
      payload: { objects: [requirement(`REQ-${suffix()}`, scopeId)], relations: [] },
      sourceRef: originId,
    });
    const [pendingId] = await createCandidate(client, {
      payload: { objects: [requirement(`REQ-${suffix()}`, scopeId)], relations: [] },
      sourceRef: originId,
    });

    await ok(["triage", "reject", rejectedId as string]);

    // The default listing is what it always was: the pending queue only. The
    // rejected row still exists — the table refuses deletion — so its absence
    // here is the gap this flag closes, not evidence that it went away.
    const byDefault = await triageListing(["triage"]);
    assert.equal(byDefault.candidate_status, "pending");
    assert.ok(!ids(byDefault.candidates).includes(rejectedId as string));
    assert.ok(ids(byDefault.candidates).includes(pendingId as string));
    assert.deepEqual(ids(byDefault.pending_candidates), ids(byDefault.candidates));

    const rejected = await triageListing(["triage", "--status", "rejected"]);
    assert.equal(rejected.candidate_status, "rejected");
    const found = rejected.candidates.find((candidate) => candidate.id === rejectedId);
    assert.ok(found !== undefined, "rejected candidate is missing from --status rejected");
    assert.equal(found.status, "rejected");
    // The full proposal comes back, so a caller can show what was turned down
    // rather than a bare id.
    assert.ok(found.payload.objects.length > 0);
    assert.ok(!ids(rejected.candidates).includes(pendingId as string));
    // The queue keeps meaning the queue whatever was asked for.
    assert.ok(ids(rejected.pending_candidates).includes(pendingId as string));

    const all = await triageListing(["triage", "--status", "all"]);
    assert.deepEqual(
      [rejectedId, pendingId].filter((id) => !ids(all.candidates).includes(id as string)),
      [],
    );
  });
});

test("pke triage and pke triage list report the same listing, with or without --status", async () => {
  await waitForDatabase();
  await withClient(async () => {
    assert.deepEqual(await triageListing(["triage"]), await triageListing(["triage", "list"]));
    assert.deepEqual(
      await triageListing(["triage", "--status", "accepted"]),
      await triageListing(["triage", "list", "--status", "accepted"]),
    );
  });
});

test("an unknown --status names the ones that exist and reads nothing", async () => {
  await waitForDatabase();
  await withClient(async () => {
    const error = structuredError(await runCli(["triage", "--status", "pendign", "--json"]));
    assert.equal(error.code, ErrorCode.INVALID_USAGE);
    assert.match(
      error.message,
      /--status must be one of pending, accepted, rejected, expired, all/,
    );

    const missing = structuredError(await runCli(["triage", "--status", "--json"]));
    assert.equal(missing.code, ErrorCode.MISSING_ARGUMENT);
  });
});

test("triage payload stays pending-only and says where a resolved candidate is read", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    const scopeId = await createProject(client);
    const [candidateId] = await createCandidate(client, {
      payload: { objects: [requirement(`REQ-${suffix()}`, scopeId)], relations: [] },
    });
    await ok(["triage", "reject", candidateId as string]);

    // Naming the group: the default selection finds nothing pending, which is
    // the message a curator actually hits, so it is the one that has to say
    // where the resolved row can be read.
    const byGroup = structuredError(
      await runCli(["triage", "payload", candidateId as string, "--json"]),
    );
    assert.equal(byGroup.code, ErrorCode.CANDIDATE_SELECTION_INVALID);
    assert.match(byGroup.message, /pke triage --status/);

    // Naming the resolved element directly reports the status it found.
    const byElement = structuredError(
      await runCli([
        "triage",
        "payload",
        candidateId as string,
        "--elements",
        candidateId as string,
        "--json",
      ]),
    );
    assert.equal(byElement.code, ErrorCode.CANDIDATE_NOT_PENDING);
    assert.match(byElement.message, /is rejected, not pending/);
    assert.match(byElement.message, /pke triage --status rejected/);
  });
});

test("maintenance expires Observations in one version and Candidates without a version", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    const scopeId = await createProject(client);
    const observationId = `OBS-${suffix()}`;
    await seed(client, [observation(observationId, scopeId)]);
    const candidateId = await createCandidate(client, {
      payload: { objects: [requirement(`REQ-${suffix()}`, scopeId)], relations: [] },
    });
    await client.query(
      "UPDATE candidates SET created_at = now() - interval '91 days' WHERE id = $1::uuid",
      [candidateId[0]],
    );
    const before = await graphVersionCount(client);

    await ok(["maintenance", "--candidate-days", "90"]);

    assert.equal(await graphVersionCount(client), before + 1);
    const expiredObservation = await client.query<{ status: string }>(
      "SELECT status FROM knowledge_objects WHERE id = $1",
      [observationId],
    );
    assert.equal(expiredObservation.rows[0]?.status, "stale");
    const expiredCandidate = await client.query<{ status: string }>(
      "SELECT status FROM candidates WHERE id = $1::uuid",
      [candidateId[0]],
    );
    assert.equal(expiredCandidate.rows[0]?.status, "expired");
  });
});

test("triage edit does not write when the editor exits non-zero", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    const scopeId = await createProject(client);
    const originId = `DSC-${suffix()}`;
    await seed(client, [discussion(originId, scopeId)]);
    const [candidateId] = await createCandidate(client, {
      payload: { objects: [requirement(`REQ-${suffix()}`, scopeId)], relations: [] },
      sourceRef: originId,
    });
    const before = await graphVersionCount(client);

    const result = await withEditor(`"${process.execPath}" -e process.exit(1)`, () =>
      runCli(["triage", "edit", candidateId as string]),
    );
    assertFailed(result, /editor exited with status 1/);

    assert.equal(await graphVersionCount(client), before);
    const candidate = await client.query<{ status: string }>(
      "SELECT status FROM candidates WHERE id = $1::uuid",
      [candidateId],
    );
    assert.equal(candidate.rows[0]?.status, "pending");
  });
});

test("triage edit after accept fails without a new graph version", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    const scopeId = await createProject(client);
    const originId = `DSC-${suffix()}`;
    await seed(client, [discussion(originId, scopeId)]);
    const [candidateId] = await createCandidate(client, {
      payload: { objects: [requirement(`REQ-${suffix()}`, scopeId)], relations: [] },
      sourceRef: originId,
    });

    await ok(["triage", "accept", candidateId as string]);
    const afterAccept = await graphVersionCount(client);

    const result = await withEditor(`"${process.execPath}" -e process.exit(0)`, () =>
      runCli(["triage", "edit", candidateId as string]),
    );
    assertFailed(result, /candidate group has no pending elements/);

    assert.equal(await graphVersionCount(client), afterAccept);
  });
});

test("the selection flag has one spelling and the error names it", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    const scopeId = await createProject(client);
    const originId = `DSC-${suffix()}`;
    await seed(client, [discussion(originId, scopeId)]);
    const [candidateId] = await createCandidate(client, {
      payload: { objects: [requirement(`REQ-${suffix()}`, scopeId)], relations: [] },
      sourceRef: originId,
    });

    for (const alias of ["--element", "--only"]) {
      const error = structuredError(
        await runCli([
          "triage",
          "accept",
          candidateId as string,
          alias,
          candidateId as string,
          "--json",
        ]),
      );
      assert.equal(error.code, ErrorCode.INVALID_USAGE);
      assert.match(error.message, /the selection flag is --elements/);
    }

    // The candidate is untouched: a rejected spelling resolves nothing.
    const candidate = await client.query<{ status: string }>(
      `SELECT status FROM candidates WHERE id = $1`,
      [candidateId],
    );
    assert.equal(candidate.rows[0]?.status, "pending");
  });
});

test("accept and edit agree on what omitting --elements means", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    const scopeId = await createProject(client);
    const originId = `DSC-${suffix()}`;
    await seed(client, [discussion(originId, scopeId)]);
    const decisionId = `DEC-${suffix()}`;
    const constraintId = `CON-${suffix()}`;
    const candidateIds = await createCandidate(client, {
      payload: {
        objects: [decision(decisionId, scopeId), constraint(constraintId, scopeId)],
        relations: [
          relation(decisionId, "derives_from", originId),
          relation(constraintId, "derives_from", decisionId),
        ],
      },
      sourceRef: originId,
    });
    const rootId = candidateIds[0] as string;

    // `payload` reports the same selection accept would apply, so a caller can
    // see what the default resolves to before committing to it.
    const preview = (await ok(["triage", "payload", rootId, "--json"])).payload as {
      readonly data: { readonly element_ids: readonly string[] };
    };
    assert.deepEqual([...preview.data.element_ids].sort(), [...candidateIds].sort());

    await ok(["triage", "accept", rootId]);

    const objects = await client.query<{ id: string }>(
      `SELECT id FROM knowledge_objects WHERE id = ANY($1::text[])`,
      [[decisionId, constraintId]],
    );
    assert.equal(objects.rowCount, 2);
  });
});

test("merge on a multi-element group names --elements instead of failing blankly", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    const scopeId = await createProject(client);
    const originId = `DSC-${suffix()}`;
    const targetId = `DEC-${suffix()}`;
    await seed(
      client,
      [discussion(originId, scopeId), decision(targetId, scopeId)],
      [relation(targetId, "derives_from", originId)],
    );
    const decisionId = `DEC-${suffix()}`;
    const constraintId = `CON-${suffix()}`;
    const candidateIds = await createCandidate(client, {
      payload: {
        objects: [decision(decisionId, scopeId), constraint(constraintId, scopeId)],
        relations: [
          relation(decisionId, "derives_from", originId),
          relation(constraintId, "derives_from", decisionId),
        ],
      },
      sourceRef: originId,
    });
    const rootId = candidateIds[0] as string;
    const before = await graphVersionCount(client);

    const error = structuredError(
      await runCli(["triage", "merge", rootId, "--into", targetId, "--json"]),
    );
    assert.equal(error.code, ErrorCode.CANDIDATE_SELECTION_INVALID);
    assert.match(error.message, /Pass --elements <candidate-id>/);
    assert.equal(await graphVersionCount(client), before);

    // Naming the element is the fix the message asked for.
    await ok(["triage", "merge", rootId, "--into", targetId, "--elements", rootId]);
    const superseded = await client.query<{ status: string }>(
      `SELECT status FROM knowledge_objects WHERE id = $1`,
      [targetId],
    );
    assert.equal(superseded.rows[0]?.status, "superseded");
  });
});

test("triage edit of a group root without --elements includes every pending object", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    const scopeId = await createProject(client);
    const originId = `DSC-${suffix()}`;
    await seed(client, [discussion(originId, scopeId)]);
    const decisionId = `DEC-${suffix()}`;
    const constraintId = `CON-${suffix()}`;
    const candidateIds = await createCandidate(client, {
      payload: {
        objects: [decision(decisionId, scopeId), constraint(constraintId, scopeId)],
        relations: [
          relation(decisionId, "derives_from", originId),
          relation(constraintId, "derives_from", decisionId),
        ],
      },
      sourceRef: originId,
    });
    const directory = await mkdtemp(path.join(os.tmpdir(), "pke-edit-"));
    const helper = path.join(directory, "include-all.mjs");
    await writeFile(
      helper,
      `import { readFileSync, writeFileSync } from "node:fs";
const target = process.argv[2];
const payload = JSON.parse(readFileSync(target, "utf8"));
const ids = new Set((payload.objects ?? []).map((object) => object.id));
for (const required of ${JSON.stringify([decisionId, constraintId])}) {
  if (!ids.has(required)) process.exit(2);
}
payload.objects = payload.objects.map((object) =>
  object.id === ${JSON.stringify(decisionId)}
    ? { ...object, title: "edited-from-cli" }
    : object,
);
writeFileSync(target, \`\${JSON.stringify(payload, null, 2)}\\n\`);
`,
    );

    try {
      await withEditor(`"${process.execPath}" "${helper}"`, () =>
        ok(["triage", "edit", candidateIds[0] as string]),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }

    const objects = await client.query<{ id: string; title: string }>(
      `SELECT id, title
       FROM knowledge_objects
       WHERE id = ANY($1::text[])
       ORDER BY id`,
      [[decisionId, constraintId]],
    );
    assert.equal(objects.rowCount, 2);
    assert.equal(objects.rows.find((row) => row.id === decisionId)?.title, "edited-from-cli");
    const resolution = await client.query<{ action: string }>(
      `SELECT resolution->>'action' AS action
       FROM candidates
       WHERE id = $1::uuid`,
      [candidateIds[0]],
    );
    assert.equal(resolution.rows[0]?.action, "edit_and_accept");
  });
});

test("supersede carries outgoing relations and closes incoming edges onto the successor", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    const scopeId = await createProject(client);
    const originId = `DSC-${suffix()}`;
    serial += 1;
    const artifactId = `ART-${String(2000 + serial).padStart(4, "0")}`;
    const decisionId = `DEC-${suffix()}`;
    serial += 1;
    const successorId = `ART-${String(2000 + serial).padStart(4, "0")}`;
    const oldLocation = "/tmp/old-artifact.canvas.tsx";
    const newLocation = "/tmp/new-artifact.canvas.tsx";
    await seed(
      client,
      [
        discussion(originId, scopeId),
        artifact(artifactId, scopeId, oldLocation),
        decision(decisionId, scopeId),
      ],
      [
        relation(artifactId, "references", originId),
        relation(decisionId, "derives_from", originId),
        relation(decisionId, "references", artifactId),
      ],
    );
    const directory = await mkdtemp(path.join(os.tmpdir(), "pke-supersede-"));
    const file = path.join(directory, "successor.json");
    await writeFile(
      file,
      `${JSON.stringify(
        {
          object: {
            ...artifact(successorId, scopeId, newLocation),
            authoredBy: "human",
            supersedesId: artifactId,
          },
          relations: [relation(successorId, "references", originId)],
          repoint: [
            {
              sourceId: decisionId,
              relation: "references",
              oldTargetId: artifactId,
              newTargetId: successorId,
              targetKind: "knowledge_object",
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

    try {
      await ok(["supersede", artifactId, "--file", file]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }

    const objects = await client.query<{
      id: string;
      status: string;
      location: string | null;
      superseded_by_id: string | null;
    }>(
      `SELECT id, status, attributes->>'location' AS location, superseded_by_id
       FROM knowledge_objects
       WHERE id = ANY($1::text[])
       ORDER BY id`,
      [[artifactId, successorId]],
    );
    assert.deepEqual(
      objects.rows.find((row) => row.id === artifactId),
      {
        id: artifactId,
        status: "superseded",
        location: oldLocation,
        superseded_by_id: successorId,
      },
    );
    assert.deepEqual(
      objects.rows.find((row) => row.id === successorId),
      {
        id: successorId,
        status: "current",
        location: newLocation,
        superseded_by_id: null,
      },
    );

    const edges = await client.query<{
      source_id: string;
      relation: string;
      target_id: string;
      valid_from_version: string;
      valid_to_version: string | null;
    }>(
      `SELECT source_id, relation, target_id, valid_from_version::text, valid_to_version::text
       FROM relations
       WHERE (source_id = $1 AND relation = 'references' AND target_id = $2)
          OR (source_id = $3 AND relation = 'references' AND target_id = ANY($4::text[]))
       ORDER BY source_id, target_id, valid_from_version`,
      [successorId, originId, decisionId, [artifactId, successorId]],
    );
    const outgoing = edges.rows.filter(
      (row) => row.source_id === successorId && row.target_id === originId,
    );
    assert.equal(outgoing.length, 1);
    assert.equal(outgoing[0]?.valid_to_version, null);

    const incoming = edges.rows.filter((row) => row.source_id === decisionId);
    const closed = incoming.find((row) => row.target_id === artifactId);
    const opened = incoming.find((row) => row.target_id === successorId);
    assert.ok(closed);
    assert.ok(opened);
    assert.equal(closed?.valid_to_version, opened?.valid_from_version);
    assert.equal(opened?.valid_to_version, null);
    assert.equal(closed?.target_id, artifactId);
  });
});

test("supersede default document carries outgoing relations and incoming repoints", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    const scopeId = await createProject(client);
    const originId = `DSC-${suffix()}`;
    serial += 1;
    const artifactId = `ART-${String(2000 + serial).padStart(4, "0")}`;
    const decisionId = `DEC-${suffix()}`;
    const newLocation = "/tmp/repointed-artifact.canvas.tsx";
    await seed(
      client,
      [
        discussion(originId, scopeId),
        artifact(artifactId, scopeId, "/tmp/old.canvas.tsx"),
        decision(decisionId, scopeId),
      ],
      [
        relation(artifactId, "references", originId),
        relation(decisionId, "derives_from", originId),
        relation(decisionId, "references", artifactId),
      ],
    );
    const directory = await mkdtemp(path.join(os.tmpdir(), "pke-supersede-default-"));
    const helper = path.join(directory, "patch-location.mjs");
    await writeFile(
      helper,
      `import { readFileSync, writeFileSync } from "node:fs";
const target = process.argv[2];
const document = JSON.parse(readFileSync(target, "utf8"));
if (!Array.isArray(document.relations) || document.relations.length !== 1) process.exit(2);
if (document.relations[0]?.sourceId === ${JSON.stringify(artifactId)}) process.exit(3);
if (document.relations[0]?.targetId !== ${JSON.stringify(originId)}) process.exit(4);
if (!Array.isArray(document.repoint) || document.repoint.length !== 1) process.exit(5);
if (document.repoint[0]?.sourceId !== ${JSON.stringify(decisionId)}) process.exit(6);
if (document.repoint[0]?.oldTargetId !== ${JSON.stringify(artifactId)}) process.exit(7);
document.object.attributes.location = ${JSON.stringify(newLocation)};
writeFileSync(target, \`\${JSON.stringify(document, null, 2)}\\n\`);
`,
    );

    try {
      await withEditor(`"${process.execPath}" "${helper}"`, () => ok(["supersede", artifactId]));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }

    const successor = await client.query<{ id: string; location: string | null }>(
      `SELECT id, attributes->>'location' AS location
       FROM knowledge_objects
       WHERE supersedes_id = $1
         AND valid_to_version IS NULL`,
      [artifactId],
    );
    assert.equal(successor.rowCount, 1);
    assert.equal(successor.rows[0]?.location, newLocation);
    const successorId = successor.rows[0]?.id as string;

    const incoming = await client.query<{
      target_id: string;
      valid_to_version: string | null;
    }>(
      `SELECT target_id, valid_to_version::text
       FROM relations
       WHERE source_id = $1
         AND relation = 'references'
       ORDER BY valid_from_version, id`,
      [decisionId],
    );
    assert.equal(incoming.rows[0]?.target_id, artifactId);
    assert.notEqual(incoming.rows[0]?.valid_to_version, null);
    assert.equal(incoming.rows[1]?.target_id, successorId);
    assert.equal(incoming.rows[1]?.valid_to_version, null);
  });
});

test("transition CLI rejects an explored hypothesis", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    const scopeId = await createProject(client);
    const originId = `DSC-${suffix()}`;
    const hypothesisId = `HYP-${suffix()}`;
    await seed(
      client,
      [discussion(originId, scopeId), hypothesis(hypothesisId, scopeId)],
      [relation(hypothesisId, "derives_from", originId)],
    );
    const before = await graphVersionCount(client);

    await ok(["transition", hypothesisId, "rejected"]);

    assert.equal(await graphVersionCount(client), before + 1);
    const row = await client.query<{ status: string; valid_to_version: string | null }>(
      "SELECT status, valid_to_version::text FROM knowledge_objects WHERE id = $1",
      [hypothesisId],
    );
    assert.equal(row.rows[0]?.status, "rejected");
    assert.equal(row.rows[0]?.valid_to_version, null);
  });
});
