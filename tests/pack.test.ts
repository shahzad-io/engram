import assert from "node:assert/strict";
import test from "node:test";
import {
  assembleContextPack,
  appearsIn,
  renderedObjectCost,
  type ContextPack,
  type PackWorkingSet,
} from "../dist/domain/index.js";

const CREATED_AT = new Date("2026-01-01T00:00:00.000Z");
const BUILT_AT = new Date("2026-02-01T00:00:00.000Z");

const globalScope = {
  id: "global",
  kind: "global",
  parentId: null,
  name: "Global",
  path: "global",
  depth: 0,
};

function knowledgeClass(type: string): string {
  if (type === "observation" || type === "discussion") return "raw";
  if (type === "constraint" || type === "glossary_entry") return "operational";
  return "reviewed";
}

function makeObject(
  type: string,
  id: string,
  status: string,
  body: string,
  attributes: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    type,
    knowledgeClass: knowledgeClass(type),
    scopeId: "global",
    featureLabelIds: [],
    title: id,
    body,
    authoredBy: "human",
    sourceRef: null,
    createdAt: CREATED_AT,
    approvedAt: CREATED_AT,
    lastVerifiedAt: null,
    supersedesId: null,
    supersededById: null,
    reviewRequired: false,
    validFromVersion: 1,
    validToVersion: null,
    lockVersion: 0,
    status,
    attributes,
    ...overrides,
  };
}

function constraint(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return makeObject(
    "constraint",
    id,
    "active",
    "constraint body",
    { rule: "must remain true", enforcement: "hard", axiomatic: false },
    overrides,
  );
}

function openQuestion(
  id: string,
  blocking: boolean,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return makeObject(
    "open_question",
    id,
    "open",
    "question body",
    { question: "What remains unknown?", blocking },
    overrides,
  );
}

function observation(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return makeObject(
    "observation",
    id,
    "observed",
    "raw observation body must not be injected",
    {
      observedAt: CREATED_AT,
      evidenceRef: "log://observation",
      reviewBy: new Date("2026-03-01T00:00:00.000Z"),
    },
    { approvedAt: null, ...overrides },
  );
}

function decision(
  id: string,
  status: string,
  body: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return makeObject(
    "decision",
    id,
    status,
    body,
    {
      statement: body,
      rationale: "rationale",
      reversibility: "cheap",
      alternativesRejected: [],
    },
    overrides,
  );
}

function glossary(
  id: string,
  term: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return makeObject(
    "glossary_entry",
    id,
    "active",
    "glossary body",
    { term, definition: `definition of ${term}`, axiomatic: false, aliases: [] },
    overrides,
  );
}

function requirement(
  id: string,
  body: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return makeObject(
    "requirement",
    id,
    "active",
    body,
    { source: "curator", rationale: "because" },
    overrides,
  );
}

function workingSet(
  objects: readonly Record<string, unknown>[],
  overrides: Record<string, unknown> = {},
): PackWorkingSet {
  return {
    objects,
    relations: [],
    scopes: [globalScope],
    labels: [
      {
        id: "FT-A",
        projectScopeId: "global",
        canonicalName: "feature-a",
        status: "active",
        redirectsToId: null,
        validFromVersion: 1,
        validToVersion: null,
      },
    ],
    aliases: [],
    externalReferences: [],
    graphVersions: [{ version: 1, createdAt: CREATED_AT }],
    ...overrides,
  } as PackWorkingSet;
}

function request(intent: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scopeId: "global",
    featureLabelIds: [],
    glossaryEntryIds: [],
    intent,
    budget: 100_000,
    graphVersion: 1,
    builtAt: BUILT_AT,
    ...overrides,
  };
}

function objectIds(pack: ContextPack): string[] {
  return pack.sections.flatMap((section) => section.objects.map((object) => object.id));
}

function sectionIds(pack: ContextPack, key: string): string[] {
  return (
    pack.sections.find((section) => section.key === key)?.objects.map((object) => object.id) ?? []
  );
}

test("appearsIn uses whole-word matching and normalized term separators", () => {
  assert.equal(appearsIn("the organ_id value is stable", ["organ_id"]), true);
  assert.equal(appearsIn("the organ_identifier value is stable", ["organ_id"]), false);
  assert.equal(appearsIn("the organ_id2 value is stable", ["organ_id"]), false);
  assert.equal(appearsIn("the release target is lts.gs", ["lts-gs"]), true);
  assert.equal(appearsIn("the release target is ltsgs", ["lts-gs"]), false);
});

test("feature filters preserve mandatory content and all observed Observations", () => {
  const objects = [
    constraint("CON-1", { featureLabelIds: ["FT-B"] }),
    openQuestion("OQU-1", true, { featureLabelIds: ["FT-B"] }),
    openQuestion("OQU-2", false, { featureLabelIds: ["FT-B"] }),
    observation("OBS-1", { featureLabelIds: ["FT-B"] }),
    observation("OBS-2"),
    decision("DEC-1", "active", "feature-specific decision", { featureLabelIds: ["FT-B"] }),
  ];
  const pack = assembleContextPack(
    workingSet(objects),
    request("debug", { featureLabelIds: ["FT-A"] }),
  );

  const ids = objectIds(pack);
  assert.ok(ids.includes("CON-1"));
  assert.ok(ids.includes("OQU-1"));
  assert.ok(ids.includes("OBS-1"));
  assert.ok(ids.includes("OBS-2"));
  assert.ok(!ids.includes("OQU-2"));
  assert.ok(!ids.includes("DEC-1"));
  assert.equal(
    pack.sections.find((section) => section.key === "unexplained_observations")?.objects[0]?.body,
    null,
  );
});

test("unrecoverable origin renders with the Decision's pack markers", () => {
  const marked = decision("DEC-ORIGIN", "active", "historical decision", {
    attributes: {
      statement: "historical decision",
      rationale: "the source origin cannot be reconstructed",
      reversibility: "costly",
      alternativesRejected: [],
      origin: "unrecoverable",
    },
  });
  const pack = assembleContextPack(workingSet([marked]), request("implementation"));
  const rendered = pack.sections
    .flatMap((section) => section.objects)
    .find((object) => object.id === "DEC-ORIGIN");
  assert.equal(rendered?.origin, "unrecoverable");
  assert.equal(rendered?.authoredBy, "human");
  assert.equal(rendered?.staleness.state, "not_applicable");
});

test("explicitly requested Glossary Entries bypass feature filtering and are mandatory before truncation", () => {
  const explicit = glossary("GLO-1", "lts-gs", { featureLabelIds: ["FT-B"] });
  const optional = requirement("REQ-1", "optional ".repeat(1_000));
  const set = workingSet([explicit, optional]);
  const baseRequest = request("implementation", {
    featureLabelIds: ["FT-A"],
    glossaryEntryIds: ["GLO-1"],
  });
  const generous = assembleContextPack(set, baseRequest);
  const mandatoryBudget = generous.diagnostics.mandatoryEstimatedTokens;
  const tight = assembleContextPack(set, { ...baseRequest, budget: mandatoryBudget });

  assert.deepEqual(sectionIds(tight, "glossary"), ["GLO-1"]);
  assert.ok(tight.recipe.droppedObjectIds.includes("REQ-1"));
  assert.equal(tight.diagnostics.mandatoryEstimatedTokens, mandatoryBudget);
  assert.equal(tight.diagnostics.mandatoryContentBudgetPercentage, 100);
  assert.deepEqual(tight.recipe.glossaryEntryIds, ["GLO-1"]);
});

test("glossary matching performs exactly two passes and reports terms lost after pass two", () => {
  const firstDecision = decision("DEC-001", "active", "ordinary implementation detail");
  const secondDecision = decision("DEC-002", "active", "contains the two-pass-term only");
  const term = glossary("GLO-001", "two-pass-term");
  const set = workingSet([firstDecision, secondDecision, term]);
  const generous = assembleContextPack(set, request("implementation"));
  const rendered = new Map(
    generous.sections.flatMap((section) => section.objects.map((object) => [object.id, object])),
  );
  const budget =
    renderedObjectCost(rendered.get("DEC-001")) + renderedObjectCost(rendered.get("DEC-002"));
  const pack = assembleContextPack(set, request("implementation", { budget }));

  assert.equal(pack.diagnostics.glossaryPasses, 2);
  assert.ok(pack.diagnostics.glossaryResidualTerms.includes("two-pass-term"));
  assert.ok(pack.recipe.droppedObjectIds.includes("DEC-002"));
  assert.ok(!objectIds(pack).includes("GLO-001"));
});

test("recent superseded selection uses graph-version distance, not build time", () => {
  const recent = decision("DEC-RECENT", "superseded", "recent reversal", {
    validToVersion: 6,
  });
  const old = decision("DEC-OLD", "superseded", "old reversal", {
    validToVersion: 5,
  });
  const set = workingSet([recent, old], {
    graphVersions: [{ version: 15, createdAt: CREATED_AT }],
  });
  const early = assembleContextPack(
    set,
    request("review", {
      graphVersion: 15,
      builtAt: new Date("2026-02-01T00:00:00.000Z"),
    }),
  );
  const late = assembleContextPack(
    set,
    request("review", {
      graphVersion: 15,
      builtAt: new Date("2027-02-01T00:00:00.000Z"),
    }),
  );

  assert.deepEqual(sectionIds(early, "superseded_decisions"), ["DEC-RECENT"]);
  assert.deepEqual(objectIds(early), objectIds(late));
});

test("retracted objects are excluded at and after retraction but remain in earlier packs", () => {
  const retracted = decision("DEC-RETRACT", "retracted", "erroneous capture", {
    validFromVersion: 1,
    validToVersion: 10,
  });
  const set = workingSet([retracted], {
    graphVersions: [
      { version: 9, createdAt: CREATED_AT },
      { version: 10, createdAt: CREATED_AT },
      { version: 20, createdAt: CREATED_AT },
    ],
  });
  const before = assembleContextPack(set, request("implementation", { graphVersion: 9 }));
  const after = assembleContextPack(set, request("implementation", { graphVersion: 10 }));

  assert.deepEqual(sectionIds(before, "active_decisions"), ["DEC-RETRACT"]);
  assert.ok(!objectIds(after).includes("DEC-RETRACT"));
});

test("mandatory content overflow fails instead of truncating it", () => {
  const blocking = openQuestion("OQU-LONG", true, {
    body: "x".repeat(2_000),
  });
  assert.throws(
    () => assembleContextPack(workingSet([blocking]), request("debug", { budget: 1 })),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "PACK_BUDGET_INSUFFICIENT",
  );
});
