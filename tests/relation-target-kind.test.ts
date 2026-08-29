import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Client as PgClient } from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { runCli, type CliResult } from "../dist/cli.js";
import { assertGraphAdditions, type WorkingSet } from "../dist/domain/invariant/check.js";
import { materializeKnowledgeObject } from "../dist/domain/entity/materialize.js";
import { loadBackfillBundle } from "../dist/infrastructure/backfill/read.js";
import { createMcpServer } from "../dist/mcp/server.js";
import {
  createProject,
  decision,
  discussion,
  objectId,
  relation,
  seed,
} from "./support/graph.ts";
import { waitForDatabase, withClient } from "./support/db.ts";

/*
 * `target_kind` is optional at every surface that accepts a written
 * relation, and three of the four filled it in. `triage edit` did not, and
 * the omission travelled all the way to a BEFORE INSERT trigger, which
 * raised `ILLEGAL_RELATION` through SQLSTATE 23514 for a relation that was
 * perfectly legal and pointed at a real object.
 *
 * Two things are asserted here. Every surface defaults the field the same
 * way, and no surface can turn an omitted one into a database error. The
 * domain layer rejects an absent kind rather than assuming one, so a path
 * that skips normalisation fails where the message can name the field.
 */

const SURFACES = ["discussion.resolve", "triage edit", "supersede", "backfill"] as const;

type ToolResponse = { isError?: boolean; content?: Array<{ text?: string }> };

/** The shape of a database error escaping to a caller, in any phrasing. */
const SQLSTATE_MARKERS: readonly RegExp[] = [
  /violates check constraint/iu,
  /new row for relation/iu,
  /invalid input value for enum/iu,
  /invalid input syntax for type/iu,
  /out of range for type/iu,
  /null value in column/iu,
];

function assertNoDatabaseError(surface: string, code: string, message: string): void {
  assert.notEqual(
    code,
    "INTERNAL_ERROR",
    `${surface} answered with an uncategorised error, which is what an escaped database error looks like: ${message}`,
  );
  for (const marker of SQLSTATE_MARKERS) {
    assert.ok(
      !marker.test(message),
      `${surface} answered with database text matching ${String(marker)}: ${message}`,
    );
  }
  assert.doesNotMatch(
    message.trim(),
    /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/u,
    `${surface} answered with a bare raised name and no sentence: ${message}`,
  );
}

function envelopeOf(result: CliResult): {
  readonly ok: boolean;
  readonly code: string;
  readonly message: string;
} {
  const payload = result.payload as {
    readonly error?: { readonly code: string; readonly message: string };
  } | null;
  return {
    ok: result.exitCode === 0,
    code: payload?.error?.code ?? "",
    message: payload?.error?.message ?? result.stderr ?? "",
  };
}

async function withEngram<T>(fn: (pg: PgClient, mcp: Client) => Promise<T>): Promise<T> {
  await waitForDatabase();
  return withClient(async (pg) => {
    const server = createMcpServer(pg);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const mcp = new Client({ name: "pke-target-kind", version: "0.0.0" });
    await mcp.connect(clientTransport);
    try {
      return await fn(pg, mcp);
    } finally {
      await mcp.close();
      await server.close();
    }
  });
}

/** A proposal whose one relation says nothing about what it points at. */
function proposalWithoutTargetKind(scopeId: string): Record<string, unknown> {
  return {
    discussion: {
      local_id: "conversation",
      type: "discussion",
      scope_id: scopeId,
      title: "target kind",
      body: "target kind",
      status: "recorded",
      attributes: {
        medium: "chat",
        occurred_at: "2026-08-29T00:00:00.000Z",
        content_ref: "ref",
      },
      authored_by: "human",
    },
    proposal: {
      objects: [
        {
          local_id: "the_decision",
          type: "decision",
          scope_id: scopeId,
          title: "target kind decision",
          body: "target kind decision",
          status: "active",
          attributes: {
            statement: "s",
            rationale: "r",
            reversibility: "cheap",
            alternatives_rejected: [],
          },
          authored_by: "ai",
        },
      ],
      // No target_kind. Three surfaces default it; one did not.
      relations: [{ source_id: "the_decision", relation: "derives_from", target_id: "conversation" }],
    },
  };
}

async function resolveProposal(
  mcp: Client,
  scopeId: string,
): Promise<{ candidateId: string; discussionId: string; response: ToolResponse }> {
  const response = (await mcp.callTool({
    name: "discussion.resolve",
    arguments: proposalWithoutTargetKind(scopeId),
  })) as ToolResponse;
  const text = response.content?.[0]?.text ?? "";
  const body = JSON.parse(text) as Record<string, unknown>;
  return {
    candidateId: String(body.candidate_id),
    discussionId: String(body.discussion_id),
    response,
  };
}

async function withTempDirectory<T>(fn: (directory: string) => Promise<T>): Promise<T> {
  return fn(await mkdtemp(path.join(os.tmpdir(), "pke-target-kind-")));
}

test("every surface that accepts a written relation defaults an omitted target_kind", async () => {
  await withEngram(async (pg, mcp) => {
    const reached: string[] = [];

    // --- discussion.resolve ------------------------------------------
    const scopeId = await createProject(pg, "tkind");
    const resolved = await resolveProposal(mcp, scopeId);
    const resolveText = resolved.response.content?.[0]?.text ?? "";
    assert.equal(resolved.response.isError, undefined, resolveText);
    const storedRelations = (
      await pg.query<{ payload: { relations: Array<{ targetKind?: string }> } }>(
        "SELECT payload FROM candidates WHERE id = $1",
        [resolved.candidateId],
      )
    ).rows[0]?.payload.relations;
    assert.deepEqual(
      storedRelations?.map((edge) => edge.targetKind),
      ["knowledge_object"],
      "discussion.resolve did not fill in the omitted target kind",
    );
    reached.push("discussion.resolve");

    // --- triage edit --payload ---------------------------------------
    const edited = {
      objects: [
        {
          localId: "the_decision",
          type: "decision",
          scopeId,
          title: "edited",
          body: "edited",
          status: "active",
          attributes: {
            statement: "s",
            rationale: "r",
            reversibility: "cheap",
            alternativesRejected: [],
          },
          authoredBy: "human",
        },
      ],
      relations: [
        { sourceId: "the_decision", relation: "derives_from", targetId: resolved.discussionId },
      ],
    };
    const editResult = await withTempDirectory(async (directory) => {
      const file = path.join(directory, "payload.json");
      await writeFile(file, `${JSON.stringify(edited, null, 2)}\n`);
      return runCli(["triage", "edit", resolved.candidateId, "--payload", file, "--json"]);
    });
    const editEnvelope = envelopeOf(editResult);
    assertNoDatabaseError("triage edit", editEnvelope.code, editEnvelope.message);
    assert.ok(editEnvelope.ok, `triage edit rejected an omitted target kind: ${editEnvelope.message}`);
    reached.push("triage edit");

    // --- supersede --file ---------------------------------------------
    const predecessor = objectId("DEC");
    const origin = objectId("DSC");
    await seed(
      pg,
      [discussion(origin, scopeId), decision(predecessor, scopeId)],
      [relation(predecessor, "derives_from", origin)],
    );
    const successor = objectId("DEC");
    const successorDocument = {
      object: {
        ...decision(successor, scopeId),
        authoredBy: "human",
        supersedesId: predecessor,
      },
      relations: [{ sourceId: successor, relation: "derives_from", targetId: origin }],
      repoint: [],
    };
    const supersedeResult = await withTempDirectory(async (directory) => {
      const file = path.join(directory, "successor.json");
      await writeFile(file, `${JSON.stringify(successorDocument, null, 2)}\n`);
      return runCli(["supersede", predecessor, "--file", file, "--json"]);
    });
    const supersedeEnvelope = envelopeOf(supersedeResult);
    assertNoDatabaseError("supersede", supersedeEnvelope.code, supersedeEnvelope.message);
    assert.ok(
      supersedeEnvelope.ok,
      `supersede rejected an omitted target kind: ${supersedeEnvelope.message}`,
    );
    reached.push("supersede");

    // --- backfill ------------------------------------------------------
    await withTempDirectory(async (directory) => {
      await mkdir(path.join(directory, "objects"));
      await writeFile(
        path.join(directory, "relations.json"),
        `${JSON.stringify({ relations: [{ source_id: "DEC-0001", relation: "derives_from", target_id: "DSC-0001" }] }, null, 2)}\n`,
      );
      const bundle = await loadBackfillBundle(directory);
      assert.deepEqual(
        bundle.bundle.relations.map((edge) => edge.targetKind),
        ["knowledge_object"],
        "backfill did not fill in the omitted target kind",
      );
    });
    reached.push("backfill");

    assert.deepEqual(reached, [...SURFACES], "a surface was not exercised");
  });
});

test("the domain layer rejects a relation that does not say what it points at", () => {
  const scopeId = "tkind_domain";
  const now = new Date("2026-08-29T00:00:00.000Z");
  const originId = "DSC-9001";
  const decisionId = "DEC-9001";
  const base: WorkingSet = {
    objects: [
      materializeKnowledgeObject({ ...discussion(originId, scopeId), featureLabelIds: [] }, 1, now),
    ],
    relations: [],
    scopes: [
      { id: "global", kind: "global", parentId: null, name: "global" },
      { id: scopeId, kind: "project", parentId: "global", name: scopeId },
    ],
    labels: [],
  };
  const proposed = materializeKnowledgeObject(
    { ...decision(decisionId, scopeId), featureLabelIds: [] },
    2,
    now,
  );

  for (const [label, targetKind] of [
    ["absent", undefined],
    ["unknown", "somewhere_else"],
  ] as const) {
    assert.throws(
      () =>
        assertGraphAdditions(base, {
          ...base,
          objects: [proposed],
          relations: [
            {
              id: "probe-0",
              sourceId: decisionId,
              relation: "derives_from",
              targetId: originId,
              targetKind: targetKind as never,
              createdAt: now,
              validFromVersion: 2,
              validToVersion: null,
            },
          ],
        }),
      (error: unknown) => {
        assert.equal(
          (error as { code?: string }).code,
          "ILLEGAL_RELATION",
          `an ${label} target kind was not reported as an illegal relation`,
        );
        const message = (error as Error).message;
        // The caller has to be able to find the edge and the field.
        for (const needle of [decisionId, "derives_from", originId, "target_kind"]) {
          assert.ok(
            message.includes(needle),
            `an ${label} target kind produced a message that does not name ${needle}: ${message}`,
          );
        }
        return true;
      },
      `an ${label} target kind was accepted by the domain layer`,
    );
  }
});

test("an unknown target_kind is refused by name rather than by the database", async () => {
  await withEngram(async (pg, mcp) => {
    const scopeId = await createProject(pg, "tkindbad");
    const resolved = await resolveProposal(mcp, scopeId);
    const edited = {
      objects: [
        {
          localId: "the_decision",
          type: "decision",
          scopeId,
          title: "edited",
          body: "edited",
          status: "active",
          attributes: {
            statement: "s",
            rationale: "r",
            reversibility: "cheap",
            alternativesRejected: [],
          },
          authoredBy: "human",
        },
      ],
      relations: [
        {
          sourceId: "the_decision",
          relation: "derives_from",
          targetId: resolved.discussionId,
          targetKind: "somewhere_else",
        },
      ],
    };
    const result = await withTempDirectory(async (directory) => {
      const file = path.join(directory, "payload.json");
      await writeFile(file, `${JSON.stringify(edited, null, 2)}\n`);
      return runCli(["triage", "edit", resolved.candidateId, "--payload", file, "--json"]);
    });
    const envelope = envelopeOf(result);
    assert.ok(!envelope.ok, "an unknown target kind was accepted");
    assertNoDatabaseError("triage edit", envelope.code, envelope.message);
    assert.equal(envelope.code, "ILLEGAL_RELATION");
    assert.match(envelope.message, /target_kind/u);
  });
});
