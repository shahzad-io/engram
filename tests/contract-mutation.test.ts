import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  contractFor,
  requiredSnakeKeys,
  writableAttributes,
  type AttributeContract,
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
import { objectFromRow, type ObjectRow } from "../dist/infrastructure/persistence/read.js";
import { waitForDatabase, withClient } from "./support/db.ts";

/*
 * `type-contract.test.ts` pins each encoding of the per-type contract
 * against the contract table. This asks the question that pinning cannot
 * answer on its own: if someone renames an attribute in the table and
 * changes nothing else, does anything actually notice?
 *
 * It renames each attribute in the live contract object, runs the same
 * assertions the pinning tests make, counts how many break, and puts the
 * table back. A control run over the unmutated contract has to be silent,
 * or the count would be measuring a broken harness.
 */

const NOW = new Date("2026-08-20T00:00:00.000Z");
const EMPTY_SET: WorkingSet = { objects: [], relations: [], scopes: [], labels: [] };

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

function attributesKeyedBy(
  type: KnowledgeObjectType,
  spelling: "snake" | "camel",
): Record<string, unknown> {
  return Object.fromEntries(
    writableAttributes(type).map((entry) => [entry[spelling], sampleValue(entry.value)]),
  );
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

function storedRow(type: KnowledgeObjectType): ObjectRow {
  return {
    id: `${contractFor(type).idPrefix}-7001`,
    type,
    scope_id: "global",
    feature_label_ids: [],
    title: "title",
    body: "body",
    status: contractFor(type).initialStatus,
    attributes: attributesKeyedBy(type, "snake"),
    authored_by: "human",
    source_ref: null,
    created_at: NOW,
    approved_at: NOW,
    last_verified_at: null,
    supersedes_id: null,
    superseded_by_id: null,
    review_required: false,
    valid_from_version: 1,
    valid_to_version: null,
    lock_version: 1,
  };
}

function camelKeys(type: KnowledgeObjectType): string[] {
  return writableAttributes(type)
    .map((entry) => entry.camel)
    .sort();
}

function snakeKeys(type: KnowledgeObjectType): string[] {
  return writableAttributes(type)
    .map((entry) => entry.snake)
    .sort();
}

/** The example documents at the repository root, which nothing pinned before. */
type ExampleFile = { readonly name: string; readonly byType: Record<string, unknown> };

async function loadExampleFiles(): Promise<readonly ExampleFile[]> {
  const root = process.cwd();
  const flat = JSON.parse(await readFile(path.join(root, "full_attributes.json"), "utf8")) as Record<
    string,
    unknown
  >;
  const nested = JSON.parse(
    await readFile(path.join(root, "example_attribute.json"), "utf8"),
  ) as { readonly examples: Record<string, unknown> };
  return [
    { name: "full_attributes.json", byType: flat },
    { name: "example_attribute.json", byType: nested.examples },
  ];
}

function exampleAttributeKeys(file: ExampleFile, type: KnowledgeObjectType): string[] | null {
  const example = file.byType[type];
  if (typeof example !== "object" || example === null) return null;
  const attributes = (example as { attributes?: unknown }).attributes;
  if (typeof attributes !== "object" || attributes === null) return null;
  return Object.keys(attributes as Record<string, unknown>);
}

type Coupling = {
  readonly name: string;
  readonly check: (type: KnowledgeObjectType) => void;
};

function couplings(
  attributeKeyCheck: string,
  files: readonly ExampleFile[],
): readonly Coupling[] {
  return [
    {
      name: "the materialiser emits the contract's camelCase keys",
      check: (type) => {
        assert.deepEqual(
          Object.keys(materialize(type, attributesKeyedBy(type, "snake")).attributes).sort(),
          camelKeys(type),
        );
      },
    },
    {
      name: "the materialiser accepts the contract's camelCase spelling",
      check: (type) => {
        assert.deepEqual(
          Object.keys(materialize(type, attributesKeyedBy(type, "camel")).attributes).sort(),
          camelKeys(type),
        );
      },
    },
    {
      name: "the storage projection emits the contract's snake_case keys",
      check: (type) => {
        assert.deepEqual(
          Object.keys(
            projectKnowledgeAttributesForStorage(
              materialize(type, attributesKeyedBy(type, "snake")),
            ),
          ).sort(),
          snakeKeys(type),
        );
      },
    },
    {
      name: "the read mapper hydrates the contract's camelCase keys",
      check: (type) => {
        assert.deepEqual(Object.keys(objectFromRow(storedRow(type)).attributes).sort(), camelKeys(type));
      },
    },
    {
      name: "an object built from the contract satisfies the required-attribute invariant",
      check: (type) => {
        const object = materialize(type, attributesKeyedBy(type, "snake"));
        try {
          assertGraphAdditions(EMPTY_SET, { ...EMPTY_SET, objects: [object] });
        } catch (error) {
          // Provenance and scope failures are this harness's doing, not the
          // rename's; only a missing required attribute counts.
          if ((error as { code?: string }).code === "REQUIRED_ATTRIBUTES_MISSING") throw error;
        }
      },
    },
    {
      name: "the database attribute-key CHECK lists the contract's required keys",
      check: (type) => {
        const branch = new RegExp(
          `WHEN '${type}'::knowledge_object_type THEN \\(attributes \\?& ARRAY\\[([^\\]]*)\\]\\)`,
          "u",
        ).exec(attributeKeyCheck);
        assert.ok(branch, `no branch for ${type}`);
        const listed = [...(branch[1] as string).matchAll(/'([^']*)'::/gu)].map(
          (match) => match[1] as string,
        );
        assert.deepEqual(listed, [...requiredSnakeKeys(type)]);
      },
    },
    ...files.map((file) => ({
      name: `${file.name} uses the contract's keys`,
      check: (type: KnowledgeObjectType) => {
        const keys = exampleAttributeKeys(file, type);
        assert.ok(keys, `${file.name} has no example for ${type}`);
        const writable = new Set(snakeKeys(type));
        for (const key of keys) {
          assert.ok(writable.has(key), `${file.name} ${type}.${key} is not in the contract`);
        }
        for (const required of requiredSnakeKeys(type)) {
          assert.ok(keys.includes(required), `${file.name} ${type} omits ${required}`);
        }
      },
    })),
  ];
}

function brokenBy(
  all: readonly Coupling[],
  type: KnowledgeObjectType,
  entry: AttributeContract,
): readonly string[] {
  const original = { snake: entry.snake, camel: entry.camel };
  const mutable = entry as { snake: string; camel: string };
  mutable.snake = `${original.snake}_renamed`;
  mutable.camel = `${original.camel}Renamed`;
  try {
    return all
      .filter((coupling) => {
        try {
          coupling.check(type);
          return false;
        } catch {
          return true;
        }
      })
      .map((coupling) => coupling.name);
  } finally {
    mutable.snake = original.snake;
    mutable.camel = original.camel;
  }
}

/*
 * These are the counts the repository currently reaches, not a floor
 * someone picked. Pinning the real number means an encoding that quietly
 * stops tracking the contract shows up here as a smaller count, which a
 * loose "at least five" would have absorbed.
 *
 * Required attributes break every encoding. Optional ones break six: the
 * database CHECK lists required keys only, and the required-attribute
 * invariant has nothing to say about a key that was never required.
 */
const REQUIRED_MINIMUM = 8;
const OPTIONAL_MINIMUM = 6;

test("renaming a contract attribute breaks the encodings that copy it", async () => {
  await waitForDatabase();
  const definition = await withClient(async (client) => {
    const result = await client.query<{ definition: string }>(
      "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = $1",
      ["knowledge_objects_attribute_keys"],
    );
    const found = result.rows[0]?.definition;
    assert.ok(found, "knowledge_objects_attribute_keys is not present in the live schema");
    return found;
  });
  const all = couplings(definition, await loadExampleFiles());

  // Control. If any of these fails the counts below mean nothing.
  for (const type of KNOWLEDGE_OBJECT_TYPES) {
    for (const coupling of all) {
      assert.doesNotThrow(
        () => {
          coupling.check(type);
        },
        `${coupling.name} already fails for ${type} before any rename`,
      );
    }
  }

  for (const type of KNOWLEDGE_OBJECT_TYPES) {
    for (const entry of writableAttributes(type)) {
      const broken = brokenBy(all, type, entry);
      const minimum = entry.required ? REQUIRED_MINIMUM : OPTIONAL_MINIMUM;
      assert.ok(
        broken.length >= minimum,
        `renaming ${type}.${entry.snake} broke only ${broken.length} of ${all.length} encodings (${broken.join("; ")})`,
      );
    }
  }
});
