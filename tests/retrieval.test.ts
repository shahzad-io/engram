import assert from "node:assert/strict";
import test from "node:test";
import { retrieve, type PackWorkingSet } from "../dist/domain/index.js";

const CREATED_AT = new Date("2026-01-01T00:00:00.000Z");
const EVALUATED_AT = new Date("2026-08-01T00:00:00.000Z");

const scopes = [
  {
    id: "global",
    kind: "global",
    parentId: null,
    name: "Global",
    path: "global",
    depth: 0,
  },
  {
    id: "project",
    kind: "project",
    parentId: "global",
    name: "MIRA",
    path: "global.project",
    depth: 1,
  },
  {
    id: "phase",
    kind: "phase",
    parentId: "project",
    name: "Build",
    path: "global.project.phase",
    depth: 2,
  },
];

function knowledgeClass(type: string): string {
  if (type === "observation" || type === "discussion") return "raw";
  if (type === "constraint" || type === "glossary_entry") return "operational";
  return "reviewed";
}

function object(
  type: string,
  id: string,
  status: string,
  body: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    type,
    knowledgeClass: knowledgeClass(type),
    scopeId: "phase",
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
    attributes: {},
    ...overrides,
  };
}

function relation(
  id: string,
  sourceId: string,
  verb: string,
  targetId: string,
  targetKind: string,
): Record<string, unknown> {
  return {
    id,
    sourceId,
    relation: verb,
    targetId,
    targetKind,
    createdAt: CREATED_AT,
    validFromVersion: 1,
    validToVersion: null,
  };
}

function fixture(): PackWorkingSet {
  const seed = object("decision", "DEC-SEED", "active", "choose the implementation", {
    attributes: {
      statement: "choose the implementation",
      rationale: "rationale",
      reversibility: "cheap",
      alternativesRejected: [],
    },
  });
  const relatedRequirement = object("requirement", "REQ-REL", "active", "related requirement", {
    scopeId: "project",
    attributes: { source: "curator", rationale: "because" },
  });
  const projectConstraint = object("constraint", "CON-PROJECT", "active", "project constraint", {
    scopeId: "project",
    featureLabelIds: ["FT-A"],
    lastVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
    attributes: { rule: "must hold", enforcement: "hard", axiomatic: false },
  });
  const phaseConstraint = object("constraint", "CON-PHASE", "active", "phase constraint", {
    featureLabelIds: ["FT-A"],
    attributes: { rule: "must also hold", enforcement: "soft", axiomatic: false },
  });
  const keyword = object("requirement", "REQ-KEY", "active", "contains the needle keyword", {
    attributes: { source: "curator", rationale: "because" },
  });

  return {
    objects: [seed, relatedRequirement, projectConstraint, phaseConstraint, keyword],
    relations: [
      relation("REL-DERIVES", "DEC-SEED", "derives_from", "REQ-REL", "knowledge_object"),
      relation("REL-REF", "DEC-SEED", "references", "XRF-1", "external_reference"),
    ],
    scopes,
    labels: [
      {
        id: "FT-A",
        projectScopeId: "project",
        canonicalName: "feature-a",
        status: "active",
        redirectsToId: null,
        validFromVersion: 1,
        validToVersion: null,
      },
    ],
    aliases: [],
    externalReferences: [
      {
        type: "external_reference",
        id: "XRF-1",
        system: "git",
        identifier: "repo#symbol",
        location: "repo/file.ts",
        symbol: "symbol",
        lastVerifiedAt: null,
        createdAt: CREATED_AT,
      },
    ],
    graphVersions: [{ version: 1, createdAt: CREATED_AT }],
  } as PackWorkingSet;
}

test("retrieval tier 1 traverses exact relations and attaches provenance", () => {
  const response = retrieve(fixture(), {
    scopeId: "phase",
    types: ["requirement"],
    statuses: ["active"],
    seedObjectId: "DEC-SEED",
    relation: "derives_from",
    direction: "outgoing",
    asOfVersion: 1,
    currentVersion: 1,
    evaluatedAt: EVALUATED_AT,
  });

  assert.equal(response.tier, 1);
  assert.deepEqual(response.tierEscalations, []);
  assert.deepEqual(
    response.results.map((result) => result.object.id),
    ["REQ-REL"],
  );
  assert.equal(response.results[0]?.provenance.authoredBy, "human");
});

test("retrieval tier 2 applies scope, type, feature, ordering, and staleness filters", () => {
  const response = retrieve(fixture(), {
    scopeId: "phase",
    types: ["constraint"],
    featureLabelIds: ["FT-A"],
    statuses: ["active"],
    asOfVersion: 1,
    currentVersion: 1,
    evaluatedAt: EVALUATED_AT,
  });

  assert.equal(response.tier, 2);
  assert.deepEqual(
    response.results.map((result) => [result.object.id, result.scopeDepth]),
    [
      ["CON-PHASE", 2],
      ["CON-PROJECT", 1],
    ],
  );
  assert.equal(response.results[1]?.staleness.state, "stale");
});

test("retrieval tier 3 uses keywords when metadata produces no result", () => {
  const response = retrieve(fixture(), {
    scopeId: "phase",
    text: "needle",
    asOfVersion: 1,
    currentVersion: 1,
    evaluatedAt: EVALUATED_AT,
  });

  assert.equal(response.tier, 3);
  assert.deepEqual(response.tierEscalations, ["tier-3"]);
  assert.deepEqual(
    response.results.map((result) => result.object.id),
    ["REQ-KEY"],
  );
});

test("retrieval reports escalation when exact and metadata tiers are empty", () => {
  const response = retrieve(fixture(), {
    scopeId: "phase",
    seedObjectId: "DEC-SEED",
    relation: "blocks",
    direction: "outgoing",
    text: "missing",
    asOfVersion: 1,
    currentVersion: 1,
    evaluatedAt: EVALUATED_AT,
  });

  assert.equal(response.tier, 3);
  assert.deepEqual(response.tierEscalations, ["tier-2", "tier-3"]);
  assert.deepEqual(response.results, []);
});

test("retrieval attaches reference and derivation evidence to selected objects", () => {
  const response = retrieve(fixture(), {
    scopeId: "phase",
    types: ["decision"],
    statuses: ["active"],
    asOfVersion: 1,
    currentVersion: 1,
    evaluatedAt: EVALUATED_AT,
  });

  assert.deepEqual(response.results[0]?.evidenceReferenceIds, ["REQ-REL", "XRF-1"]);
});
