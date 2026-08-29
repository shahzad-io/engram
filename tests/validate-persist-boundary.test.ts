import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Client as PgClient } from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { runCli, type CliResult } from "../dist/cli.js";
import { createMcpServer } from "../dist/mcp/server.js";
import type { WireError } from "../dist/wire/envelope.js";
import { waitForDatabase, withClient } from "./support/db.ts";

/*
 * Validation speaks camelCase and storage speaks snake_case. Every write
 * path crosses that seam, and a test that builds a snake_case object and
 * asserts a snake_case row never touches it — which is how the two
 * spellings could disagree for a whole type without a failure.
 *
 * `mcp-transport.test.ts` crosses it for `discussion.resolve`, but stops
 * at the Candidate. `backfill.test.ts` crosses it for import. The three
 * here are the rest: acceptance, curator edit, and supersession, each
 * driven through the surface a caller actually uses.
 */

let serial = 0;

function suffix(): string {
  serial += 1;
  return `${Date.now()}${process.pid}${serial}`;
}

async function createProject(client: PgClient): Promise<string> {
  const id = `seam_${suffix()}`;
  await client.query(
    `INSERT INTO scopes (id, kind, parent_id, name)
     VALUES ($1, 'project', 'global', $1)`,
    [id],
  );
  return id;
}

function cliData(result: CliResult): Record<string, unknown> {
  const payload = result.payload as
    | { readonly data?: Record<string, unknown>; readonly error?: WireError }
    | null;
  assert.equal(
    result.exitCode,
    0,
    payload?.error === undefined ? (result.stderr ?? "command failed") : JSON.stringify(payload.error),
  );
  assert.ok(payload?.data !== undefined);
  return payload.data;
}

type ToolResponse = { isError?: boolean; content?: Array<{ text?: string }> };

function toolJson(result: ToolResponse): Record<string, unknown> {
  const text = result.content?.[0]?.text ?? "";
  assert.equal(result.isError, undefined, text);
  return JSON.parse(text) as Record<string, unknown>;
}

/** Every camelCase key anywhere in a persisted value, as a path for the failure message. */
function camelCaseKeysIn(value: unknown, trail = ""): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => camelCaseKeysIn(entry, `${trail}[${index}]`));
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => {
    const here = trail === "" ? key : `${trail}.${key}`;
    return [...(/[A-Z]/u.test(key) ? [here] : []), ...camelCaseKeysIn(entry, here)];
  });
}

async function storedAttributes(
  client: PgClient,
  id: string,
): Promise<Record<string, unknown>> {
  const result = await client.query<{ attributes: Record<string, unknown> }>(
    "SELECT attributes FROM knowledge_objects WHERE id = $1",
    [id],
  );
  const attributes = result.rows[0]?.attributes;
  assert.ok(attributes, `${id} was never persisted`);
  return attributes;
}

/** The assertion all three paths share. */
async function assertPersistedSnakeCase(
  client: PgClient,
  id: string,
  expectedKeys: readonly string[],
  expectedValues: Record<string, unknown>,
): Promise<void> {
  const attributes = await storedAttributes(client, id);
  assert.deepEqual(Object.keys(attributes).sort(), [...expectedKeys].sort(), `${id} attribute keys`);
  assert.deepEqual(
    camelCaseKeysIn(attributes),
    [],
    `${id} persisted a camelCase key: ${JSON.stringify(attributes)}`,
  );
  for (const [key, value] of Object.entries(expectedValues)) {
    assert.deepEqual(attributes[key], value, `${id}.${key}`);
  }
}

async function withEngram<T>(fn: (pg: PgClient, mcp: Client) => Promise<T>): Promise<T> {
  await waitForDatabase();
  return withClient(async (pg) => {
    const server = createMcpServer(pg);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const mcp = new Client({ name: "pke-persist-seam", version: "0.0.0" });
    await mcp.connect(clientTransport);
    try {
      return await fn(pg, mcp);
    } finally {
      await mcp.close();
      await server.close();
    }
  });
}

async function withTempDirectory<T>(fn: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pke-seam-"));
  try {
    return await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const REJECTED = [{ alternative: "Leave it alone", reason: "The seam would stay untested." }];

/** camelCase throughout, exactly as a model or a curator would write it. */
function camelCaseProposal(scopeId: string): Record<string, unknown> {
  return {
    discussion: {
      localId: "conversation",
      type: "discussion",
      scopeId,
      title: "Spelling at the persistence seam",
      body: "Validation speaks camelCase and storage speaks snake_case.",
      status: "recorded",
      attributes: {
        medium: "chat",
        occurredAt: "2026-08-29T00:00:00.000Z",
        contentRef: { storage: "external", location: "fovea://conversation/seam" },
      },
      authoredBy: "human",
    },
    proposal: {
      objects: [
        {
          localId: "the_decision",
          type: "decision",
          scopeId,
          title: "Persist the validated representation",
          body: "One representation crosses the seam.",
          status: "active",
          attributes: {
            statement: "Attributes are stored snake_case whatever spelling arrived.",
            rationale: "Two spellings for one fact drift apart silently.",
            reversibility: "cheap",
            alternativesRejected: REJECTED,
          },
          authoredBy: "ai",
        },
      ],
      relations: [
        { sourceId: "the_decision", relation: "derives_from", targetId: "conversation" },
      ],
    },
  };
}

test("camelCase accepted over MCP is persisted snake_case when the curator accepts it", async () => {
  await withEngram(async (pg, mcp) => {
    const scopeId = await createProject(pg);

    const resolved = toolJson(
      (await mcp.callTool({
        name: "discussion.resolve",
        arguments: camelCaseProposal(scopeId),
      })) as ToolResponse,
    );
    const discussionId = String(resolved.discussion_id);

    // The Raw discussion is persisted at resolve, so its row crosses the
    // seam before any curator is involved.
    await assertPersistedSnakeCase(
      pg,
      discussionId,
      ["medium", "occurred_at", "content_ref"],
      {
        medium: "chat",
        occurred_at: "2026-08-29T00:00:00.000Z",
        content_ref: { storage: "external", location: "fovea://conversation/seam" },
      },
    );

    const accepted = cliData(
      await runCli(["triage", "accept", String(resolved.candidate_id), "--json"]),
    );
    const decisionId = (accepted.assigned_ids as Array<{ local_id: string; id: string }>).find(
      (entry) => entry.local_id === "the_decision",
    )?.id;
    assert.ok(decisionId);

    await assertPersistedSnakeCase(
      pg,
      decisionId,
      ["statement", "rationale", "reversibility", "alternatives_rejected"],
      {
        reversibility: "cheap",
        alternatives_rejected: REJECTED,
      },
    );
  });
});

test("a curator payload written in camelCase is persisted snake_case", async () => {
  await withEngram(async (pg, mcp) => {
    const scopeId = await createProject(pg);
    const resolved = toolJson(
      (await mcp.callTool({
        name: "discussion.resolve",
        arguments: camelCaseProposal(scopeId),
      })) as ToolResponse,
    );
    const candidateId = String(resolved.candidate_id);

    /*
     * `triage edit` camelCases the whole submitted document before it
     * reaches the write path, so this is the one route that carries
     * camelCase attributes into acceptance rather than normalising them
     * at the wire schema.
     */
    const preview = cliData(await runCli(["triage", "payload", candidateId, "--json"])) as {
      readonly payload: {
        readonly objects: Array<Record<string, unknown>>;
        readonly relations: readonly unknown[];
      };
    };
    const edited = {
      ...preview.payload,
      objects: preview.payload.objects.map((object) => ({
        ...object,
        title: "Edited by the curator",
        attributes: {
          statement: "The curator rewrote the statement.",
          rationale: "Editing must not change how attributes are spelled at rest.",
          reversibility: "costly",
          alternativesRejected: REJECTED,
        },
      })),
    };

    const accepted = await withTempDirectory(async (directory) => {
      const file = path.join(directory, "payload.json");
      await writeFile(file, `${JSON.stringify(edited, null, 2)}\n`);
      return cliData(await runCli(["triage", "edit", candidateId, "--payload", file, "--json"]));
    });

    const decisionId = (accepted.assigned_ids as Array<{ local_id: string; id: string }>).find(
      (entry) => entry.local_id === "the_decision",
    )?.id;
    assert.ok(decisionId);

    await assertPersistedSnakeCase(
      pg,
      decisionId,
      ["statement", "rationale", "reversibility", "alternatives_rejected"],
      {
        statement: "The curator rewrote the statement.",
        reversibility: "costly",
        alternatives_rejected: REJECTED,
      },
    );

    const authored = await pg.query<{ authored_by: string }>(
      "SELECT authored_by FROM knowledge_objects WHERE id = $1",
      [decisionId],
    );
    assert.equal(
      authored.rows[0]?.authored_by,
      "human",
      "a Candidate edited before acceptance is human-authored",
    );
  });
});

test("a supersede document written in camelCase is persisted snake_case", async () => {
  await withEngram(async (pg, mcp) => {
    const scopeId = await createProject(pg);
    const resolved = toolJson(
      (await mcp.callTool({
        name: "discussion.resolve",
        arguments: camelCaseProposal(scopeId),
      })) as ToolResponse,
    );
    const discussionId = String(resolved.discussion_id);
    const accepted = cliData(
      await runCli(["triage", "accept", String(resolved.candidate_id), "--json"]),
    );
    const predecessorId = (accepted.assigned_ids as Array<{ local_id: string; id: string }>).find(
      (entry) => entry.local_id === "the_decision",
    )?.id;
    assert.ok(predecessorId);

    const highest = await pg.query<{ highest: string }>(
      `SELECT COALESCE(MAX(substring(id from '^DEC-([0-9]{4,9})$')::bigint), 0)::text AS highest
         FROM knowledge_objects WHERE id ~ '^DEC-[0-9]{4,}$'`,
    );
    const successorId = `DEC-${String(Number(highest.rows[0]?.highest ?? "0") + 1).padStart(4, "0")}`;

    // `supersede --file` reads the document as written; nothing
    // camelCases it on the way in, so this is the spelling the write
    // path receives.
    const successor = {
      object: {
        id: successorId,
        type: "decision",
        scopeId,
        title: "Superseding decision",
        body: "The replacement.",
        status: "active",
        attributes: {
          statement: "The replacement statement.",
          rationale: "Supersession must not change how attributes are spelled at rest.",
          reversibility: "one_way",
          alternativesRejected: REJECTED,
        },
        authoredBy: "human",
        supersedesId: predecessorId,
      },
      relations: [
        { sourceId: successorId, relation: "derives_from", targetId: discussionId },
      ],
      repoint: [],
    };

    await withTempDirectory(async (directory) => {
      const file = path.join(directory, "successor.json");
      await writeFile(file, `${JSON.stringify(successor, null, 2)}\n`);
      cliData(await runCli(["supersede", predecessorId, "--file", file, "--json"]));
    });

    await assertPersistedSnakeCase(
      pg,
      successorId,
      ["statement", "rationale", "reversibility", "alternatives_rejected"],
      {
        statement: "The replacement statement.",
        reversibility: "one_way",
        alternatives_rejected: REJECTED,
      },
    );

    // The predecessor's row is untouched apart from its terminal state:
    // supersession is a new object, not an edit of the old one.
    const predecessor = await pg.query<{ status: string; superseded_by_id: string | null }>(
      "SELECT status, superseded_by_id FROM knowledge_objects WHERE id = $1",
      [predecessorId],
    );
    assert.equal(predecessor.rows[0]?.status, "superseded");
    assert.equal(predecessor.rows[0]?.superseded_by_id, successorId);
  });
});
