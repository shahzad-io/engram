import assert from "node:assert/strict";
import test from "node:test";
import {
  KNOWLEDGE_TYPE_CONTRACTS,
  contractFor,
  formatKnowledgeObjectId,
  idPatternFor,
  idPatternSourceFor,
  requiredAttributes,
  requiredCamelKeys,
  requiredSnakeKeys,
  writableAttributes,
  type AttributeValueKind,
} from "../dist/domain/entity/contract.js";
import { materializeKnowledgeObject } from "../dist/domain/entity/materialize.js";
import { projectKnowledgeAttributesForStorage } from "../dist/domain/entity/storage.js";
import {
  KNOWLEDGE_OBJECT_TYPES,
  type KnowledgeObject,
  type KnowledgeObjectType,
} from "../dist/domain/entity/types.js";
import { assertGraphAdditions, type WorkingSet } from "../dist/domain/invariant/check.js";
import { waitForDatabase, withClient } from "./support/db.ts";

/**
 * These tests pin the encodings of the per-type contract that are not derived
 * from KNOWLEDGE_TYPE_CONTRACTS: the materialiser and the storage projection,
 * which carry compile-time attribute types worth keeping, and the two database
 * CHECK constraints.
 */

const NOW = new Date("2026-08-20T00:00:00.000Z");

function sampleValue(value: AttributeValueKind): unknown {
  switch (value.kind) {
    case "string":
      return "sample";
    case "date":
      return "2026-08-20T00:00:00.000Z";
    case "boolean":
      return true;
    case "enum":
      return value.values[0];
    case "string_array":
      return ["sample"];
    case "rejected_alternative_array":
      return [{ alternative: "sample", reason: "sample" }];
    case "json":
      return "sample";
  }
}

function attributesFrom(
  type: KnowledgeObjectType,
  include: "required" | "all",
): Record<string, unknown> {
  const entries = include === "required" ? requiredAttributes(type) : writableAttributes(type);
  return Object.fromEntries(entries.map((entry) => [entry.snake, sampleValue(entry.value)]));
}

function materialize(
  type: KnowledgeObjectType,
  attributes: Record<string, unknown>,
): KnowledgeObject {
  return materializeKnowledgeObject(
    {
      id: `${contractFor(type).idPrefix}-7001`,
      type,
      scopeId: "global",
      featureLabelIds: [],
      title: "title",
      body: "body",
      status: contractFor(type).initialStatus,
      attributes,
      authoredBy: "human",
      sourceRef: null,
      supersedesId: null,
      supersededById: null,
    },
    1,
    NOW,
  );
}

const EMPTY_SET: WorkingSet = { objects: [], relations: [], scopes: [], labels: [] };

test("the materialiser emits exactly the contract's camelCase keys for every type", () => {
  for (const type of KNOWLEDGE_OBJECT_TYPES) {
    const required = materialize(type, attributesFrom(type, "required"));
    assert.deepEqual(
      Object.keys(required.attributes).sort(),
      [...requiredCamelKeys(type)].sort(),
      `${type} required attributes`,
    );

    const all = materialize(type, attributesFrom(type, "all"));
    assert.deepEqual(
      Object.keys(all.attributes).sort(),
      writableAttributes(type)
        .map((entry) => entry.camel)
        .sort(),
      `${type} required and optional attributes`,
    );
  }
});

test("the materialiser accepts the contract's camelCase spelling as well as snake_case", () => {
  for (const type of KNOWLEDGE_OBJECT_TYPES) {
    const camelInput = Object.fromEntries(
      writableAttributes(type).map((entry) => [entry.camel, sampleValue(entry.value)]),
    );
    assert.deepEqual(
      Object.keys(materialize(type, camelInput).attributes).sort(),
      writableAttributes(type)
        .map((entry) => entry.camel)
        .sort(),
      `${type} accepts camelCase input`,
    );
  }
});

test("the storage projection emits exactly the contract's snake_case keys for every type", () => {
  for (const type of KNOWLEDGE_OBJECT_TYPES) {
    const required = projectKnowledgeAttributesForStorage(
      materialize(type, attributesFrom(type, "required")),
    );
    assert.deepEqual(
      Object.keys(required).sort(),
      [...requiredSnakeKeys(type)].sort(),
      `${type} required attributes`,
    );

    const all = projectKnowledgeAttributesForStorage(
      materialize(type, attributesFrom(type, "all")),
    );
    assert.deepEqual(
      Object.keys(all).sort(),
      writableAttributes(type)
        .map((entry) => entry.snake)
        .sort(),
      `${type} required and optional attributes`,
    );
  }
});

test("dropping any single required attribute is reported by name for every type", () => {
  for (const type of KNOWLEDGE_OBJECT_TYPES) {
    for (const dropped of requiredAttributes(type)) {
      const attributes = attributesFrom(type, "required");
      delete attributes[dropped.snake];
      const object = materialize(type, attributes);
      assert.throws(
        () => assertGraphAdditions(EMPTY_SET, { ...EMPTY_SET, objects: [object] }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal((error as { code?: string }).code, "REQUIRED_ATTRIBUTES_MISSING");
          assert.match(error.message, new RegExp(`\\b${dropped.camel}\\b`, "u"));
          return true;
        },
        `${type} missing ${dropped.snake}`,
      );
    }
  }
});

test("every type's initial status is one of its declared statuses", () => {
  for (const type of KNOWLEDGE_OBJECT_TYPES) {
    const contract = contractFor(type);
    assert.ok(
      contract.statuses.includes(contract.initialStatus),
      `${type} initial status ${contract.initialStatus} is not in its lifecycle`,
    );
  }
});

test("the contract covers every knowledge object type exactly once", () => {
  assert.deepEqual(
    Object.keys(KNOWLEDGE_TYPE_CONTRACTS).sort(),
    [...KNOWLEDGE_OBJECT_TYPES].sort(),
  );
});

/**
 * The constraint definitions are read from the live schema rather than from the
 * migration files. `knowledge_objects_status_for_type` is defined in migration
 * 003 and redefined in migration 018, so a check that parsed 003 would already
 * be testing a constraint that no longer exists.
 */
async function constraintDefinition(name: string): Promise<string> {
  return withClient(async (client) => {
    const result = await client.query<{ definition: string }>(
      "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = $1",
      [name],
    );
    const definition = result.rows[0]?.definition;
    assert.ok(definition, `constraint ${name} is not present in the live schema`);
    return definition;
  });
}

function literalsIn(fragment: string): string[] {
  return [...fragment.matchAll(/'([^']*)'::/gu)].map((match) => match[1] as string);
}

function branchFor(definition: string, pattern: RegExp, type: string): string {
  const match = pattern.exec(definition);
  assert.ok(match, `no branch for ${type}`);
  return match[1] as string;
}

test("the database attribute-key CHECK agrees with the contract for every type", async () => {
  await waitForDatabase();
  const definition = await constraintDefinition("knowledge_objects_attribute_keys");
  for (const type of KNOWLEDGE_OBJECT_TYPES) {
    const fragment = branchFor(
      definition,
      new RegExp(
        `WHEN '${type}'::knowledge_object_type THEN \\(attributes \\?& ARRAY\\[([^\\]]*)\\]\\)`,
        "u",
      ),
      type,
    );
    assert.deepEqual(literalsIn(fragment), [...requiredSnakeKeys(type)], `${type} required keys`);
  }
});

test("the database status CHECK agrees with the contract for every type", async () => {
  await waitForDatabase();
  const definition = await constraintDefinition("knowledge_objects_status_for_type");
  for (const type of KNOWLEDGE_OBJECT_TYPES) {
    const fragment = branchFor(
      definition,
      new RegExp(
        `\\(type = '${type}'::knowledge_object_type\\) AND \\(status = ANY \\(ARRAY\\[([^\\]]*)\\]\\)\\)`,
        "u",
      ),
      type,
    );
    assert.deepEqual(literalsIn(fragment), [...contractFor(type).statuses], `${type} statuses`);
  }
});

test("the database id-prefix CHECK agrees with the contract for every type", async () => {
  await waitForDatabase();
  const definition = await constraintDefinition("knowledge_objects_id_prefix");
  for (const type of KNOWLEDGE_OBJECT_TYPES) {
    const fragment = branchFor(
      definition,
      new RegExp(`\\(type = '${type}'::knowledge_object_type\\) AND \\(id ~ '([^']*)'`, "u"),
      type,
    );
    assert.equal(fragment, idPatternSourceFor(type), `${type} id pattern`);
  }
});

test("allocated ids satisfy the contract's own pattern", () => {
  for (const type of KNOWLEDGE_OBJECT_TYPES) {
    assert.match(formatKnowledgeObjectId(type, 1), idPatternFor(type));
    assert.match(formatKnowledgeObjectId(type, 12345), idPatternFor(type));
    assert.doesNotMatch(`${contractFor(type).idPrefix}-001`, idPatternFor(type));
    assert.doesNotMatch(`${contractFor(type).idPrefix}-20260823-001`, idPatternFor(type));
  }
});
