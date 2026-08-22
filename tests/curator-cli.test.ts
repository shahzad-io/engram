import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Client } from "pg";
import { runCli } from "../dist/cli.js";
import {
  createCandidate,
  curationTransaction,
  type CandidatePayload,
  type KnowledgeObjectWrite,
  type RelationWrite,
} from "../dist/application/write/index.js";
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

    await runCli([
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

    await runCli(["triage", "reject", candidateId as string]);

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

    await runCli(["maintenance", "--candidate-days", "90"]);

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

    await assert.rejects(
      () =>
        withEditor(`"${process.execPath}" -e process.exit(1)`, () =>
          runCli(["triage", "edit", candidateId as string]),
        ),
      /editor exited with status 1/,
    );

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

    await runCli(["triage", "accept", candidateId as string]);
    const afterAccept = await graphVersionCount(client);

    await assert.rejects(
      () =>
        withEditor(`"${process.execPath}" -e process.exit(0)`, () =>
          runCli(["triage", "edit", candidateId as string]),
        ),
      /candidate group has no pending elements/,
    );

    assert.equal(await graphVersionCount(client), afterAccept);
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
        runCli(["triage", "edit", candidateIds[0] as string]),
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
      await runCli(["supersede", artifactId, "--file", file]);
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
      await withEditor(`"${process.execPath}" "${helper}"`, () =>
        runCli(["supersede", artifactId]),
      );
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

    await runCli(["transition", hypothesisId, "rejected"]);

    assert.equal(await graphVersionCount(client), before + 1);
    const row = await client.query<{ status: string; valid_to_version: string | null }>(
      "SELECT status, valid_to_version::text FROM knowledge_objects WHERE id = $1",
      [hypothesisId],
    );
    assert.equal(row.rows[0]?.status, "rejected");
    assert.equal(row.rows[0]?.valid_to_version, null);
  });
});
