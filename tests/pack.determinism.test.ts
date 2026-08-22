import assert from "node:assert/strict";
import test from "node:test";
import {
  assembleContextPack,
  DomainError,
  ErrorCode,
  type ContextPack,
  type PackWorkingSet,
} from "../dist/domain/index.js";
import { buildContextPack, reproduceContextPack } from "../dist/application/index.js";
import { waitForDatabase, withClient } from "./support/db.ts";

const GRAPH_VERSION = 20;
const DAY_MS = 24 * 60 * 60 * 1_000;
const EPOCH = new Date("2026-01-01T00:00:00.000Z");
const INTENTS = ["implementation", "review", "debug", "architecture", "onboarding", "planning"];

class Random {
  state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 1;
  }

  next(): number {
    this.state = (this.state * 1_664_525 + 1_013_904_223) >>> 0;
    return this.state / 2 ** 32;
  }

  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }

  bool(probability = 0.5): boolean {
    return this.next() < probability;
  }

  pick<T>(values: readonly T[]): T {
    const value = values[this.int(values.length)];
    if (value === undefined) {
      throw new Error("cannot choose from an empty collection");
    }
    return value;
  }
}

function dateAt(day: number): Date {
  return new Date(EPOCH.getTime() + day * DAY_MS);
}

function knowledgeClass(type: string): string {
  if (type === "observation" || type === "discussion") return "raw";
  if (type === "constraint" || type === "glossary_entry") return "operational";
  return "reviewed";
}

function makeObject(
  type: string,
  id: string,
  status: string,
  scopeId: string,
  body: string,
  attributes: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const raw = type === "observation" || type === "discussion";
  return {
    id,
    type,
    knowledgeClass: knowledgeClass(type),
    scopeId,
    featureLabelIds: [],
    title: id,
    body,
    authoredBy: raw ? "ai" : "human",
    sourceRef: null,
    createdAt: dateAt(1),
    approvedAt: raw ? null : dateAt(1),
    lastVerifiedAt: raw ? null : dateAt(2),
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

function addScope(
  scopes: Array<Record<string, unknown>>,
  seed: number,
  serial: number,
  kind: string,
  parent: Record<string, unknown>,
): Record<string, unknown> {
  const id = `${kind}-${seed}-${serial}`;
  const path = `${String(parent.path)}.${kind}_${seed}_${serial}`;
  const scope = {
    id,
    kind,
    parentId: parent.id,
    name: `${kind} ${serial}`,
    path,
    depth: Number(parent.depth) + 1,
  };
  scopes.push(scope);
  return scope;
}

function generateScopes(rng: Random, seed: number): Array<Record<string, unknown>> {
  const global = {
    id: "global",
    kind: "global",
    parentId: null,
    name: "Global",
    path: "global",
    depth: 0,
  };
  const scopes: Array<Record<string, unknown>> = [global];
  const projectCount = 1 + rng.int(3);
  let serial = 1;
  for (let projectIndex = 0; projectIndex < projectCount; projectIndex += 1) {
    const project = addScope(scopes, seed, serial, "project", global);
    serial += 1;
    const workstreamCount = 1 + rng.int(3);
    for (let workstreamIndex = 0; workstreamIndex < workstreamCount; workstreamIndex += 1) {
      const workstream = addScope(scopes, seed, serial, "workstream", project);
      serial += 1;
      const phaseCount = 1 + rng.int(2);
      for (let phaseIndex = 0; phaseIndex < phaseCount; phaseIndex += 1) {
        addScope(scopes, seed, serial, "phase", workstream);
        serial += 1;
      }
    }
  }
  return scopes;
}

function generatedObject(
  rng: Random,
  seed: number,
  index: number,
  scopes: readonly Record<string, unknown>[],
  labelIds: readonly string[],
): Record<string, unknown> {
  const type = rng.pick([
    "requirement",
    "discussion",
    "observation",
    "hypothesis",
    "decision",
    "open_question",
    "constraint",
    "glossary_entry",
    "artifact",
  ]);
  const scopeId = String(rng.pick(scopes).id);
  const idPrefix: Record<string, string> = {
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
  const id = `${idPrefix[type]}-${String(1000 + index).padStart(4, "0")}`;
  const labels = rng.bool(0.55) ? [rng.pick(labelIds)] : [];
  const body = `seed ${seed} object ${index}`;
  const common = { featureLabelIds: labels };

  switch (type) {
    case "requirement":
      return makeObject(
        type,
        id,
        "active",
        scopeId,
        body,
        { source: "property", rationale: "generated" },
        common,
      );
    case "discussion":
      return makeObject(
        type,
        id,
        "recorded",
        scopeId,
        `discussion body ${body}`,
        {
          medium: "chat",
          occurredAt: dateAt(index + 1),
          contentRef: `discussion-${seed}-${index}`,
        },
        common,
      );
    case "observation":
      return makeObject(
        type,
        id,
        "observed",
        scopeId,
        `observation body ${body}`,
        {
          observedAt: dateAt(index + 1),
          evidenceRef: `evidence-${seed}-${index}`,
          reviewBy: dateAt(500),
        },
        common,
      );
    case "hypothesis":
      return makeObject(
        type,
        id,
        rng.bool() ? "rejected" : "explored",
        scopeId,
        body,
        {
          whatWasTried: `trial ${index}`,
          whyItFailed: "generated result",
          evidenceRef: `evidence-${seed}-${index}`,
        },
        common,
      );
    case "decision": {
      const superseded = rng.bool(0.3);
      const validToVersion = superseded ? 2 + rng.int(GRAPH_VERSION - 1) : null;
      return makeObject(
        type,
        id,
        superseded ? "superseded" : "active",
        scopeId,
        body,
        {
          statement: body,
          rationale: "generated",
          reversibility: rng.pick(["cheap", "costly", "one_way"]),
          alternativesRejected: [],
        },
        { ...common, validToVersion },
      );
    }
    case "open_question":
      return makeObject(
        type,
        id,
        "open",
        scopeId,
        body,
        { question: `question ${index}`, blocking: rng.bool(0.35) },
        common,
      );
    case "constraint":
      return makeObject(
        type,
        id,
        "active",
        scopeId,
        body,
        { rule: `rule-${seed}-${index}`, enforcement: "soft", axiomatic: true },
        common,
      );
    case "glossary_entry": {
      const term = `term-${seed}-${index}`;
      return makeObject(
        type,
        id,
        "active",
        scopeId,
        body,
        {
          term,
          definition: `definition ${index}`,
          axiomatic: false,
          aliases: [`term_${seed}_${index}`],
        },
        common,
      );
    }
    case "artifact":
      return makeObject(
        type,
        id,
        "current",
        scopeId,
        body,
        {
          kind: "generated",
          version: "1",
          location: `artifact://${seed}/${index}`,
          contentHash: `${seed}${index}`,
          summary: `summary ${index}`,
        },
        common,
      );
  }
}

function graphVersions(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, index) => ({
    version: index + 1,
    createdAt: dateAt(index + 1),
  }));
}

function generateGraph(seed: number): {
  readonly set: PackWorkingSet;
  readonly request: Record<string, unknown>;
  readonly requestScopeId: string;
  readonly forcedConstraintId: string;
} {
  const rng = new Random(seed);
  const scopes = generateScopes(rng, seed);
  const projects = scopes.filter((scope) => scope.kind === "project");
  const labels = Array.from({ length: 3 }, (_, index) => ({
    id: `FT-${seed}-${index}`,
    projectScopeId: String(projects[index % projects.length]?.id),
    canonicalName: `feature-${seed}-${index}`,
    status: "active",
    redirectsToId: null,
    validFromVersion: 1,
    validToVersion: null,
  }));
  const aliases = labels.map((label, index) => ({
    labelId: label.id,
    alias: `alias-${seed}-${index}`,
    projectScopeId: label.projectScopeId,
    validFromVersion: 1,
    validToVersion: null,
  }));
  const requestScopeId = String(rng.pick(scopes).id);
  const objects: Array<Record<string, unknown>> = [];
  const randomCount = 14 + rng.int(12);
  for (let index = 0; index < randomCount; index += 1) {
    objects.push(
      generatedObject(
        rng,
        seed,
        index,
        scopes,
        labels.map((label) => label.id),
      ),
    );
  }

  const forcedConstraintId = `CON-${seed}-9000`;
  const forcedRequirementId = `REQ-${seed}-9000`;
  const forcedQuestionId = `OQU-${seed}-9000`;
  const forcedGlossaryId = `GLO-${seed}-9000`;
  objects.push(
    makeObject(
      "constraint",
      forcedConstraintId,
      "active",
      requestScopeId,
      `forced constraint ${seed}`,
      { rule: `forced-rule-${seed}`, enforcement: "hard", axiomatic: true },
      {
        featureLabelIds: [labels[1]?.id],
        lastVerifiedAt: dateAt(1),
      },
    ),
    makeObject(
      "requirement",
      forcedRequirementId,
      "active",
      requestScopeId,
      `forced optional requirement ${seed}`,
      { source: "property", rationale: "generated" },
    ),
    makeObject(
      "open_question",
      forcedQuestionId,
      "open",
      requestScopeId,
      `forced blocking question ${seed}`,
      { question: `forced question ${seed}`, blocking: true },
    ),
    makeObject(
      "glossary_entry",
      forcedGlossaryId,
      "active",
      requestScopeId,
      `forced glossary ${seed}`,
      {
        term: `forced-term-${seed}`,
        definition: "forced definition",
        axiomatic: false,
        aliases: [],
      },
    ),
  );

  const externalReferences = Array.from({ length: 1 + rng.int(3) }, (_, index) => ({
    type: "external_reference",
    id: `XRF-${seed}-${index}`,
    system: "git",
    identifier: `repo-${seed}#${index}`,
    location: `repo-${seed}/file-${index}.ts`,
    symbol: `symbol${index}`,
    lastVerifiedAt: null,
    createdAt: dateAt(index + 1),
  }));
  const relations: Array<Record<string, unknown>> = [];
  const relationCount = 8 + rng.int(12);
  for (let index = 0; index < relationCount; index += 1) {
    const source = rng.pick(objects);
    const useReference = rng.bool(0.4);
    const target = useReference
      ? rng.pick(externalReferences)
      : rng.pick(objects.filter((candidate) => candidate.id !== source.id));
    relations.push({
      id: `REL-${seed}-${index}`,
      sourceId: String(source.id),
      relation: useReference ? "references" : "derives_from",
      targetId: String(target.id),
      targetKind: useReference ? "external_reference" : "knowledge_object",
      createdAt: dateAt(index + 1),
      validFromVersion: 1 + rng.int(GRAPH_VERSION),
      validToVersion: null,
    });
  }

  const set = {
    objects,
    relations,
    scopes,
    labels,
    aliases,
    externalReferences,
    graphVersions: graphVersions(GRAPH_VERSION),
  } as PackWorkingSet;
  const request = {
    scopeId: requestScopeId,
    featureLabelIds: [labels[0]?.id],
    glossaryEntryIds: [forcedGlossaryId],
    intent: rng.pick(INTENTS),
    budget: 250_000,
    graphVersion: GRAPH_VERSION,
    builtAt: dateAt(32),
  };
  return { set, request, requestScopeId, forcedConstraintId };
}

function evolveWithFutureTransactions(
  graph: { readonly set: PackWorkingSet; readonly request: Record<string, unknown> },
  count: number,
  seed: number,
): PackWorkingSet {
  const objects = [...graph.set.objects] as Array<Record<string, unknown>>;
  const relations = [...graph.set.relations] as Array<Record<string, unknown>>;
  const snapshots = [...graph.set.graphVersions] as Array<Record<string, unknown>>;
  for (let index = 1; index <= count; index += 1) {
    const version = GRAPH_VERSION + index;
    const id = `REQ-${seed}-F${String(index).padStart(3, "0")}`;
    objects.push(
      makeObject(
        "requirement",
        id,
        "active",
        String(graph.request.scopeId),
        `future transaction ${index}`,
        { source: "future", rationale: "not visible at historical version" },
        { validFromVersion: version },
      ),
    );
    relations.push({
      id: `REL-${seed}-F${String(index).padStart(3, "0")}`,
      sourceId: id,
      relation: "references",
      targetId: `XRF-${seed}-0`,
      targetKind: "external_reference",
      createdAt: dateAt(version),
      validFromVersion: version,
      validToVersion: null,
    });
    snapshots.push({ version, createdAt: dateAt(version) });
  }
  return { ...graph.set, objects, relations, graphVersions: snapshots };
}

function scopeChainIds(scopeId: string, scopes: readonly Record<string, unknown>[]): Set<string> {
  const byId = new Map(scopes.map((scope) => [String(scope.id), scope]));
  const ids = new Set<string>();
  let current = byId.get(scopeId);
  while (current !== undefined) {
    ids.add(String(current.id));
    const parentId = current.parentId;
    current = parentId === null ? undefined : byId.get(String(parentId));
  }
  return ids;
}

function renderedById(pack: ContextPack): Map<string, Record<string, unknown>> {
  return new Map(
    pack.sections
      .flatMap((section) => section.objects)
      .map((object) => [object.id, object] as const),
  );
}

function omitKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}

function withoutClock(pack: ContextPack): Record<string, unknown> {
  return {
    recipe: omitKeys(pack.recipe, ["builtAt", "contentHash"]),
    objective: pack.objective,
    sections: pack.sections.map((section) => ({
      ...section,
      objects: section.objects.map((object) => omitKeys(object, ["staleness"])),
    })),
    diagnostics: pack.diagnostics,
  };
}

test("random graphs produce the same content hash for repeated builds", () => {
  for (let seed = 1; seed <= 40; seed += 1) {
    const graph = generateGraph(seed);
    const first = assembleContextPack(graph.set, graph.request);
    const reordered = {
      ...graph.set,
      objects: [...graph.set.objects].reverse(),
      relations: [...graph.set.relations].reverse(),
      scopes: [...graph.set.scopes].reverse(),
      labels: [...graph.set.labels].reverse(),
      aliases: [...graph.set.aliases].reverse(),
      externalReferences: [...graph.set.externalReferences].reverse(),
    };
    const second = assembleContextPack(reordered, graph.request);
    assert.equal(first.recipe.contentHash, second.recipe.contentHash, `seed ${seed}`);
    assert.deepEqual(first.recipe.orderedObjectIds, second.recipe.orderedObjectIds, `seed ${seed}`);
    assert.deepEqual(first.recipe.droppedObjectIds, second.recipe.droppedObjectIds, `seed ${seed}`);
  }
});

test("historical reproduction remains identical after future transactions", () => {
  for (let seed = 1; seed <= 30; seed += 1) {
    const graph = generateGraph(seed + 100);
    const before = assembleContextPack(graph.set, graph.request);
    const evolved = evolveWithFutureTransactions(graph, 1 + (seed % 6), seed + 100);
    const after = assembleContextPack(evolved, graph.request);
    assert.equal(after.recipe.contentHash, before.recipe.contentHash, `seed ${seed}`);
    assert.deepEqual(after.recipe, before.recipe, `seed ${seed}`);
  }
});

test("clock changes affect only staleness markers, not pack selection or ordering", () => {
  for (let seed = 1; seed <= 30; seed += 1) {
    const graph = generateGraph(seed + 200);
    const early = assembleContextPack(graph.set, {
      ...graph.request,
      builtAt: new Date("2026-02-01T00:00:00.000Z"),
    });
    const late = assembleContextPack(graph.set, {
      ...graph.request,
      builtAt: new Date("2027-02-01T00:00:00.000Z"),
    });
    assert.deepEqual(early.recipe.orderedObjectIds, late.recipe.orderedObjectIds, `seed ${seed}`);
    assert.deepEqual(early.recipe.droppedObjectIds, late.recipe.droppedObjectIds, `seed ${seed}`);
    assert.deepEqual(withoutClock(early), withoutClock(late), `seed ${seed}`);

    const earlyForced = renderedById(early).get(graph.forcedConstraintId);
    const lateForced = renderedById(late).get(graph.forcedConstraintId);
    assert.notDeepEqual(earlyForced?.staleness, lateForced?.staleness, `seed ${seed}`);
  }
});

test("mandatory content survives truncation and feature filtering, while dropped ids are reported", () => {
  for (let seed = 1; seed <= 25; seed += 1) {
    const graph = generateGraph(seed + 300);
    const set = {
      ...graph.set,
      relations: [],
      externalReferences: [],
      objects: graph.set.objects.filter((object) => object.type !== "glossary_entry"),
    } as PackWorkingSet;
    const request = {
      ...graph.request,
      intent: "implementation",
      glossaryEntryIds: [],
      budget: 250_000,
    };
    const broad = assembleContextPack(set, request);
    const tight = assembleContextPack(set, {
      ...request,
      budget: broad.diagnostics.mandatoryEstimatedTokens,
    });
    const chain = scopeChainIds(String(request.scopeId), set.scopes);
    const mandatoryIds = set.objects
      .filter(
        (object) =>
          chain.has(String(object.scopeId)) &&
          ((object.type === "constraint" && object.status === "active") ||
            (object.type === "open_question" &&
              object.status === "open" &&
              Boolean(object.attributes.blocking))),
      )
      .map((object) => String(object.id));
    const tightIds = new Set(tight.recipe.orderedObjectIds);
    const broadIds = new Set(broad.recipe.orderedObjectIds);

    assert.ok(mandatoryIds.length > 0, `seed ${seed}`);
    for (const id of mandatoryIds) {
      assert.ok(tightIds.has(id), `mandatory ${id}, seed ${seed}`);
      assert.ok(!tight.recipe.droppedObjectIds.includes(id), `mandatory ${id}, seed ${seed}`);
    }
    for (const id of broadIds) {
      if (!tightIds.has(id)) {
        assert.ok(tight.recipe.droppedObjectIds.includes(id), `dropped ${id}, seed ${seed}`);
      }
    }
    for (const id of tight.recipe.droppedObjectIds) {
      assert.ok(!tightIds.has(id), `reported retained id ${id}, seed ${seed}`);
    }
    for (const object of set.objects) {
      if (object.type === "constraint" && chain.has(String(object.scopeId))) {
        assert.ok(tightIds.has(String(object.id)), `constraint ${object.id}, seed ${seed}`);
      }
    }
  }
});

test("reproduction rejects a tampered recipe with PACK_HASH_MISMATCH", async () => {
  await waitForDatabase();
  await withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const stored = await buildContextPack(client, {
        scopeId: "global",
        intent: "debug",
        budget: 250_000,
        builtAt: new Date("2026-02-01T00:00:00.000Z"),
      });
      await client.query("UPDATE context_packs SET content_hash = $1 WHERE id = $2", [
        "0".repeat(64),
        stored.id,
      ]);
      await assert.rejects(
        () => reproduceContextPack(client, stored.id),
        (error: unknown) =>
          error instanceof DomainError && error.code === ErrorCode.PACK_HASH_MISMATCH,
      );
    } finally {
      await client.query("ROLLBACK");
    }
  });
});
