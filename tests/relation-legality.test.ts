import assert from "node:assert/strict";
import test from "node:test";
import type { Client } from "pg";
import {
  KNOWLEDGE_OBJECT_TYPES,
  LEGAL_TRIPLES,
  RELATION_VERBS,
  SOURCE_TYPES,
  TARGET_TYPES,
} from "../dist/domain/index.js";
import { pgMessage, waitForDatabase, withClient } from "./support/db.ts";

type KnowledgeObjectType = (typeof KNOWLEDGE_OBJECT_TYPES)[number];
type TargetType = (typeof TARGET_TYPES)[number];

const PREFIX: Record<KnowledgeObjectType, string> = {
  requirement: "REQ",
  discussion: "DSC",
  observation: "OBS",
  hypothesis: "HYP",
  decision: "DEC",
  open_question: "OQU",
  constraint: "CON",
  glossary_entry: "GLO",
  artifact: "ART",
};

const RAW_TYPES = new Set<KnowledgeObjectType>(["discussion", "observation"]);
const APPROVED_AT = "2026-08-19T00:00:00.000Z";

function objectId(type: KnowledgeObjectType, role: "source" | "target"): string {
  return `${PREFIX[type]}-${role === "source" ? "1100" : "2100"}`;
}

function attributesFor(type: KnowledgeObjectType, id: string): Record<string, unknown> {
  switch (type) {
    case "requirement":
      return { source: "legality-test", rationale: id };
    case "discussion":
      return {
        medium: "chat",
        occurred_at: APPROVED_AT,
        content_ref: id,
      };
    case "observation":
      return {
        observed_at: APPROVED_AT,
        evidence_ref: "XRF-2100",
        review_by: "2026-09-19T00:00:00.000Z",
      };
    case "hypothesis":
      return {
        what_was_tried: id,
        why_it_failed: "legality fixture",
        evidence_ref: "XRF-2100",
      };
    case "decision":
      return {
        statement: id,
        rationale: "legality fixture",
        reversibility: "cheap",
        alternatives_rejected: [],
      };
    case "open_question":
      return { question: id, blocking: false };
    case "constraint":
      return { rule: id, enforcement: "hard", axiomatic: true };
    case "glossary_entry":
      return { term: `term-${id}`, definition: id, axiomatic: true };
    case "artifact":
      return {
        kind: "legality-fixture",
        version: "1",
        location: id,
        content_hash: "sha256:legality-fixture",
        summary: id,
      };
  }
}

function statusFor(type: KnowledgeObjectType): string {
  switch (type) {
    case "requirement":
    case "decision":
    case "constraint":
    case "glossary_entry":
      return "active";
    case "discussion":
      return "recorded";
    case "observation":
      return "observed";
    case "hypothesis":
      return "explored";
    case "open_question":
      return "open";
    case "artifact":
      return "current";
  }
}

async function nextVersion(client: Client): Promise<number> {
  const result = await client.query<{ version: string }>(
    "INSERT INTO graph_versions (action, actor) VALUES ('relation_legality_test', 'curator') RETURNING version",
  );
  const version = result.rows[0]?.version;
  if (version === undefined) {
    throw new Error("graph_versions insert returned no version");
  }
  return Number(version);
}

async function insertObject(
  client: Client,
  type: KnowledgeObjectType,
  role: "source" | "target",
  version: number,
): Promise<void> {
  const id = objectId(type, role);
  const approvedAt = RAW_TYPES.has(type) ? null : APPROVED_AT;
  await client.query(
    `INSERT INTO knowledge_objects (
       id, type, scope_id, title, body, status, attributes, authored_by,
       approved_at, last_verified_at, valid_from_version
     ) VALUES ($1, $2, 'global', $3, $4, $5, $6::jsonb, 'human', $7, $7, $8)`,
    [
      id,
      type,
      id,
      `body for ${id}`,
      statusFor(type),
      JSON.stringify(attributesFor(type, id)),
      approvedAt,
      version,
    ],
  );
}

function tripleKey(sourceType: string, relation: string, targetType: string): string {
  return `${sourceType}\0${relation}\0${targetType}`;
}

async function attemptRelation(
  client: Client,
  sourceType: KnowledgeObjectType,
  relation: (typeof RELATION_VERBS)[number],
  targetType: TargetType,
  version: number,
  expectedLegal: boolean,
): Promise<boolean> {
  const targetId =
    targetType === "external_reference" ? "XRF-2100" : objectId(targetType, "target");
  const targetKind =
    targetType === "external_reference" ? "external_reference" : "knowledge_object";
  const errorHolder: { error: unknown } = { error: undefined };

  await client.query("SAVEPOINT relation_attempt");
  try {
    await client.query(
      `INSERT INTO relations (
         source_id, relation, target_id, target_kind, valid_from_version
       ) VALUES ($1, $2, $3, $4, $5)`,
      [objectId(sourceType, "source"), relation, targetId, targetKind, version],
    );
  } catch (error) {
    errorHolder.error = error;
  }
  await client.query("ROLLBACK TO SAVEPOINT relation_attempt");
  await client.query("RELEASE SAVEPOINT relation_attempt");

  if (expectedLegal) {
    if (errorHolder.error !== undefined) {
      throw errorHolder.error;
    }
    return true;
  }

  assert.ok(
    errorHolder.error !== undefined,
    `${sourceType} ${relation} ${targetType} unexpectedly passed the database trigger`,
  );
  assert.match(
    pgMessage(errorHolder.error),
    /ILLEGAL_RELATION/u,
    `${sourceType} ${relation} ${targetType} did not fail with ILLEGAL_RELATION`,
  );
  return false;
}

test("the database trigger exhaustively enforces the 9 × 8 × 10 legality product", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const version = await nextVersion(client);
      await client.query(
        "INSERT INTO external_references (id, system, identifier) VALUES ('XRF-2100', 'other', 'legality-target')",
      );
      await client.query(
        `INSERT INTO knowledge_objects (
           id, type, scope_id, title, body, status, attributes, authored_by,
           approved_at, last_verified_at, valid_from_version
         ) VALUES (
           'REQ-9000', 'requirement', 'global', 'REQ-9000', 'legality origin',
           'active', $1::jsonb, 'human', $2, $2, $3
         )`,
        [JSON.stringify(attributesFor("requirement", "REQ-9000")), APPROVED_AT, version],
      );

      for (const type of SOURCE_TYPES) {
        await insertObject(client, type, "source", version);
      }
      for (const type of KNOWLEDGE_OBJECT_TYPES) {
        await insertObject(client, type, "target", version);
      }

      await client.query(
        `INSERT INTO relations (
           source_id, relation, target_id, target_kind, valid_from_version
         ) VALUES
           ('DEC-1100', 'derives_from', 'REQ-9000', 'knowledge_object', $1),
           ('DEC-2100', 'derives_from', 'REQ-9000', 'knowledge_object', $1)`,
        [version],
      );

      const legalityRows = await client.query<{
        source_type: string;
        relation: string;
        target_type: string;
        target_kind: string;
      }>(
        `SELECT source_type, relation, target_type, target_kind
         FROM relation_legality
         ORDER BY source_type, relation, target_type, target_kind`,
      );
      assert.equal(legalityRows.rows.length, 66);
      assert.equal(new Set(legalityRows.rows.map((row) => row.target_kind)).size, 2);

      const databaseLegal = new Set(
        legalityRows.rows.map((row) => tripleKey(row.source_type, row.relation, row.target_type)),
      );
      assert.equal(
        databaseLegal.has(tripleKey("constraint", "invalidates", "constraint")),
        true,
        "A-REL-1 must be seeded in the database",
      );
      const domainLegal = new Set(
        LEGAL_TRIPLES.map((triple) =>
          tripleKey(triple.sourceType, triple.relation, triple.targetType),
        ),
      );
      assert.deepEqual([...databaseLegal].sort(), [...domainLegal].sort());

      const accepted = new Set<string>();
      let acceptedCount = 0;
      let rejectedCount = 0;
      for (const sourceType of SOURCE_TYPES) {
        for (const relation of RELATION_VERBS) {
          for (const targetType of TARGET_TYPES) {
            const key = tripleKey(sourceType, relation, targetType);
            const wasAccepted = await attemptRelation(
              client,
              sourceType,
              relation,
              targetType,
              version,
              databaseLegal.has(key),
            );
            if (wasAccepted) {
              accepted.add(key);
              acceptedCount += 1;
            } else {
              rejectedCount += 1;
            }
          }
        }
      }

      assert.equal(SOURCE_TYPES.length * RELATION_VERBS.length * TARGET_TYPES.length, 720);
      assert.equal(acceptedCount, 66);
      assert.equal(rejectedCount, 654);
      assert.deepEqual([...accepted].sort(), [...databaseLegal].sort());
    } finally {
      await client.query("ROLLBACK");
    }
  });
});
