import { knowledgeClassOf } from "../entity/class.js";
import {
  KNOWLEDGE_OBJECT_TYPES,
  type KnowledgeObject,
  type KnowledgeObjectType,
} from "../entity/types.js";
import { activeAtVersion, normaliseLabel, resolveLabel } from "../label/index.js";
import type { LabelRegistry } from "../label/types.js";
import {
  ACYCLIC_RELATIONS,
  isLegal,
  RELATION_VERBS,
  wouldCreateCycle,
  type Relation,
  type TargetType,
  type RelationVerb,
} from "../relation/index.js";
import { projectOf, resolveChain, type Scope } from "../scope/index.js";
import { detectBackfillDuplicates } from "./duplicates.js";
import { BACKFILL_TYPE_SPECS } from "./spec.js";
import type {
  BackfillBundle,
  BackfillFailure,
  BackfillGap,
  BackfillGapSummary,
  BackfillLabelCandidate,
  BackfillObjectDraft,
  BackfillObjectWrite,
  BackfillPlan,
  BackfillRelationDraft,
  BackfillRelationWrite,
  BackfillSupersession,
  BackfillWorkingSet,
} from "./types.js";

const GAP_PROMOTION_THRESHOLD = 3;

const KNOWN_TYPES = new Set<string>(KNOWLEDGE_OBJECT_TYPES);

function isKnowledgeObjectType(value: string): value is KnowledgeObjectType {
  return KNOWN_TYPES.has(value);
}

function valueFor(attributes: Readonly<Record<string, unknown>>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (attributes[key] !== undefined && attributes[key] !== null) {
      return attributes[key];
    }
  }
  return undefined;
}

function camelCase(attribute: string): string {
  return attribute.replace(/_([a-z])/gu, (_match, letter: string) => letter.toUpperCase());
}

function stringValue(
  attributes: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): string | undefined {
  const value = valueFor(attributes, keys);
  return typeof value === "string" ? value : undefined;
}

function booleanValue(
  attributes: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean | undefined {
  const value = valueFor(attributes, keys);
  return typeof value === "boolean" ? value : undefined;
}

function failure(
  failures: BackfillFailure[],
  code: string,
  sourcePath: string,
  message: string,
  objectId?: string,
  relationIndex?: number,
): void {
  failures.push({
    code,
    sourcePath,
    message,
    ...(objectId === undefined ? {} : { objectId }),
    ...(relationIndex === undefined ? {} : { relationIndex }),
  });
}

function addGap(
  gaps: BackfillGap[],
  draft: BackfillObjectDraft,
  candidateConcept: string,
  instance: string,
  now: Date,
  attemptedHomes: readonly string[] = [],
): void {
  gaps.push({
    gapId: `GAP-${String(gaps.length + 1).padStart(4, "0")}`,
    instance,
    source: draft.sourcePath,
    attemptedHomes,
    candidateConcept,
    recordedAs: "not_recorded",
    date: now,
  });
}

function addRelationGap(
  gaps: BackfillGap[],
  draft: BackfillRelationDraft,
  candidateConcept: string,
  now: Date,
): void {
  gaps.push({
    gapId: `GAP-${String(gaps.length + 1).padStart(4, "0")}`,
    instance: `${draft.sourceId} ${draft.relation || "(missing verb)"} ${draft.targetId}`,
    source: draft.sourcePath,
    attemptedHomes: [],
    candidateConcept,
    recordedAs: "not_recorded",
    date: now,
  });
}

function gapSummary(gaps: readonly BackfillGap[]): BackfillGapSummary {
  const counts: Record<string, number> = {};
  for (const gap of gaps) {
    counts[gap.candidateConcept] = (counts[gap.candidateConcept] ?? 0) + 1;
  }
  return {
    threshold: GAP_PROMOTION_THRESHOLD,
    counts,
    promotableCandidateConcepts: Object.entries(counts)
      .filter(([, count]) => count >= GAP_PROMOTION_THRESHOLD)
      .map(([concept]) => concept)
      .sort((left, right) => left.localeCompare(right)),
  };
}

function frictionReport(bundle: BackfillBundle) {
  const actions = bundle.frictionActions;
  return {
    actions,
    abandonedCount: actions.filter((action) => action.abandoned).length,
  };
}

function labelCandidateKey(projectScopeId: string, normalised: string): string {
  return `${projectScopeId}\0${normalised}`;
}

function addLabelCandidate(
  candidates: Map<
    string,
    { readonly projectScopeId: string; readonly normalised: string; sources: Set<string> }
  >,
  projectScopeId: string,
  input: string,
  sourcePath: string,
): void {
  const normalised = normaliseLabel(input);
  const key = labelCandidateKey(projectScopeId, normalised);
  const existing = candidates.get(key);
  if (existing === undefined) {
    candidates.set(key, { projectScopeId, normalised, sources: new Set([sourcePath]) });
  } else {
    existing.sources.add(sourcePath);
  }
}

function isBackfillHistoricalStatus(type: KnowledgeObjectType, status: string): boolean {
  return (
    (type === "hypothesis" && status === "rejected") ||
    (type === "decision" && status === "superseded") ||
    (type === "open_question" && status === "resolved")
  );
}

function resolveFeatureLabels(
  draft: BackfillObjectDraft,
  scopes: ReadonlyMap<string, Scope>,
  registry: LabelRegistry,
  version: number,
  candidates: Map<
    string,
    { readonly projectScopeId: string; readonly normalised: string; sources: Set<string> }
  >,
  failures: BackfillFailure[],
): readonly string[] {
  if (draft.featureLabels.length === 0) {
    return [];
  }
  let chain: Scope[];
  try {
    chain = resolveChain(draft.scopeId, scopes);
  } catch (error) {
    failure(
      failures,
      "SCOPE_CHAIN_INVALID",
      draft.sourcePath,
      error instanceof Error ? error.message : String(error),
      draft.id,
    );
    return [];
  }
  const project = projectOf(chain);
  if (project === undefined) {
    failure(
      failures,
      "UNKNOWN_LABEL",
      draft.sourcePath,
      `${draft.id} is not under a Project and cannot carry labels`,
      draft.id,
    );
    return [];
  }
  const resolved: string[] = [];
  for (const input of draft.featureLabels) {
    try {
      const direct = registry.labels.find(
        (label) =>
          label.id === input &&
          label.projectScopeId === project.id &&
          activeAtVersion(label.validFromVersion, label.validToVersion, version),
      );
      const resolution =
        direct === undefined
          ? resolveLabel(input, project.id, version, registry)
          : { kind: "resolved" as const, labelId: direct.id };
      if (resolution.kind === "candidate") {
        addLabelCandidate(candidates, project.id, input, draft.sourcePath);
      } else {
        resolved.push(resolution.labelId);
      }
    } catch (error) {
      failure(
        failures,
        "INVALID_LABEL",
        draft.sourcePath,
        error instanceof Error ? error.message : String(error),
        draft.id,
      );
    }
  }
  return [...new Set(resolved)];
}

function checkObjectShape(
  draft: BackfillObjectDraft,
  type: KnowledgeObjectType,
  scopes: ReadonlyMap<string, Scope>,
  failures: BackfillFailure[],
): void {
  const spec = BACKFILL_TYPE_SPECS[type];
  const expectedPrefix = spec.idPrefix;
  if (!new RegExp(`^${expectedPrefix}-[0-9]{4,}$`, "u").test(draft.id)) {
    failure(
      failures,
      "INVALID_OBJECT_ID",
      draft.sourcePath,
      `${draft.id} does not use the ${expectedPrefix}-NNNN id format`,
      draft.id,
    );
  }
  if (!scopes.has(draft.scopeId)) {
    failure(
      failures,
      "SCOPE_NOT_FOUND",
      draft.sourcePath,
      `${draft.id} references missing scope ${draft.scopeId}`,
      draft.id,
    );
  }
  if (draft.status !== spec.initialStatus && !isBackfillHistoricalStatus(type, draft.status)) {
    failure(
      failures,
      "ILLEGAL_INITIAL_STATUS",
      draft.sourcePath,
      `${draft.id} must be imported in initial status ${spec.initialStatus}`,
      draft.id,
    );
  }
  const origin = draft.attributes.origin;
  if (origin !== undefined && (type !== "decision" || origin !== "unrecoverable")) {
    failure(
      failures,
      "INVALID_ORIGIN_MARKER",
      draft.sourcePath,
      `${draft.id} has an invalid origin marker`,
      draft.id,
    );
  }
  for (const attribute of spec.requiredAttributes) {
    const keys = [attribute, camelCase(attribute)];
    if (valueFor(draft.attributes, keys) === undefined) {
      failure(
        failures,
        "MISSING_ATTRIBUTE",
        draft.sourcePath,
        `${draft.id} is missing ${keys.join(" or ")}`,
        draft.id,
      );
    }
  }
  if (type === "open_question" && booleanValue(draft.attributes, ["blocking"]) === true) {
    const question = stringValue(draft.attributes, ["question"]);
    if (question !== undefined && question.length > 280) {
      failure(
        failures,
        "LENGTH_CAP_EXCEEDED",
        draft.sourcePath,
        `${draft.id} blocking question exceeds 280 characters`,
        draft.id,
      );
    }
  }
  const rule = stringValue(draft.attributes, ["rule"]);
  if (type === "constraint" && rule !== undefined && rule.length > 280) {
    failure(
      failures,
      "LENGTH_CAP_EXCEEDED",
      draft.sourcePath,
      `${draft.id} constraint rule exceeds 280 characters`,
      draft.id,
    );
  }
  const definition = stringValue(draft.attributes, ["definition"]);
  if (type === "glossary_entry" && definition !== undefined && definition.length > 200) {
    failure(
      failures,
      "LENGTH_CAP_EXCEEDED",
      draft.sourcePath,
      `${draft.id} glossary definition exceeds 200 characters`,
      draft.id,
    );
  }
  const summary = stringValue(draft.attributes, ["summary"]);
  if (type === "artifact" && summary !== undefined && summary.length > 500) {
    failure(
      failures,
      "LENGTH_CAP_EXCEEDED",
      `${draft.sourcePath}`,
      `${draft.id} artifact summary exceeds 500 characters`,
      draft.id,
    );
  }
}

function syntheticObject(
  draft: BackfillObjectDraft,
  type: KnowledgeObjectType,
  featureLabelIds: readonly string[],
  version: number,
): KnowledgeObject {
  const raw = knowledgeClassOf(type) === "raw";
  return {
    id: draft.id,
    type,
    knowledgeClass: knowledgeClassOf(type),
    scopeId: draft.scopeId,
    featureLabelIds,
    title: draft.title,
    body: draft.body,
    status: draft.status as KnowledgeObject["status"],
    attributes: draft.attributes as KnowledgeObject["attributes"],
    authoredBy: "human",
    sourceRef: `backfill:${draft.sourcePath}`,
    createdAt: new Date(0),
    approvedAt: raw ? null : new Date(0),
    lastVerifiedAt: raw ? null : new Date(0),
    supersedesId: draft.supersedesId,
    supersededById: null,
    reviewRequired: false,
    validFromVersion: version,
    validToVersion: null,
    lockVersion: 0,
  } as KnowledgeObject;
}

function relationForValidation(
  relation: BackfillRelationWrite,
  index: number,
  version: number,
  now: Date,
): Relation {
  return {
    id: `backfill-relation-${index}`,
    sourceId: relation.sourceId,
    relation: relation.relation,
    targetId: relation.targetId,
    targetKind: relation.targetKind,
    createdAt: now,
    validFromVersion: version,
    validToVersion: null,
  };
}

function validateRelations(
  drafts: readonly BackfillRelationDraft[],
  workingSet: BackfillWorkingSet,
  importedObjects: ReadonlyMap<string, KnowledgeObject>,
  version: number,
  now: Date,
  failures: BackfillFailure[],
  gaps: BackfillGap[],
): {
  readonly writes: readonly BackfillRelationWrite[];
  readonly relations: readonly Relation[];
} {
  const objects = new Map(workingSet.objects.map((object) => [object.id, object]));
  for (const [id, object] of importedObjects) {
    objects.set(id, object);
  }
  const externalIds = new Set(workingSet.externalReferences.map((reference) => reference.id));
  const writes: BackfillRelationWrite[] = [];
  const relations: Relation[] = [];
  const relationSources: string[] = [];
  for (let index = 0; index < drafts.length; index += 1) {
    const draft = drafts[index];
    if (draft === undefined) continue;
    if (!RELATION_VERBS.includes(draft.relation as RelationVerb)) {
      addRelationGap(gaps, draft, "missing_verb", now);
    }
    const source = objects.get(draft.sourceId);
    if (source === undefined) {
      failure(
        failures,
        "ILLEGAL_RELATION",
        draft.sourcePath,
        `relation source does not exist: ${draft.sourceId}`,
        undefined,
        index,
      );
      continue;
    }
    if (draft.targetKind !== "knowledge_object" && draft.targetKind !== "external_reference") {
      failure(
        failures,
        "ILLEGAL_RELATION",
        draft.sourcePath,
        `unknown relation target kind: ${draft.targetKind}`,
        undefined,
        index,
      );
      continue;
    }
    let targetType: string | undefined;
    if (draft.targetKind === "external_reference") {
      if (!externalIds.has(draft.targetId)) {
        failure(
          failures,
          "ILLEGAL_RELATION",
          draft.sourcePath,
          `external reference does not exist: ${draft.targetId}`,
          undefined,
          index,
        );
        continue;
      }
      targetType = "external_reference";
    } else {
      const target = objects.get(draft.targetId);
      if (target === undefined) {
        failure(
          failures,
          "ILLEGAL_RELATION",
          draft.sourcePath,
          `relation target does not exist: ${draft.targetId}`,
          undefined,
          index,
        );
        continue;
      }
      targetType = target.type;
    }
    if (!isLegal(source.type, draft.relation as RelationVerb, targetType as TargetType)) {
      failure(
        failures,
        "ILLEGAL_RELATION",
        draft.sourcePath,
        `${source.type} ${draft.relation} ${targetType} is not a legal triple`,
        undefined,
        index,
      );
      continue;
    }
    const write: BackfillRelationWrite = {
      sourceId: draft.sourceId,
      relation: draft.relation as RelationVerb,
      targetId: draft.targetId,
      targetKind: draft.targetKind,
    };
    writes.push(write);
    relations.push(relationForValidation(write, index, version, now));
    relationSources.push(draft.sourcePath);
  }
  const combinedRelations = [...workingSet.relations, ...relations];
  for (let index = 0; index < relations.length; index += 1) {
    const relation = relations[index];
    if (relation === undefined || !ACYCLIC_RELATIONS.includes(relation.relation)) continue;
    if (
      wouldCreateCycle(
        combinedRelations.filter((candidate) => candidate.id !== relation.id),
        relation.sourceId,
        relation.targetId,
        relation.relation,
      )
    ) {
      failure(
        failures,
        "CYCLE_DETECTED",
        relationSources[index] ?? "relations.json",
        `${relation.relation} cycle involving ${relation.sourceId}`,
        undefined,
        index,
      );
    }
  }
  return { writes, relations };
}

function validateOriginsAndParents(
  objects: readonly KnowledgeObject[],
  importedIds: ReadonlySet<string>,
  relations: readonly Relation[],
  failures: BackfillFailure[],
  sourceById: ReadonlyMap<string, string>,
  draftsById: ReadonlyMap<string, BackfillObjectDraft>,
  gaps: BackfillGap[],
  now: Date,
): void {
  const objectById = new Map(objects.map((object) => [object.id, object]));
  for (const object of objects) {
    if (!importedIds.has(object.id)) continue;
    const sourcePath = sourceById.get(object.id) ?? "backfill";
    if (object.type === "decision") {
      const hasOrigin = relations.some(
        (edge) => edge.sourceId === object.id && edge.relation === "derives_from",
      );
      const hasUnrecoverableOrigin = object.attributes.origin === "unrecoverable";
      if (hasUnrecoverableOrigin && hasOrigin) {
        failure(
          failures,
          "ORIGIN_MARKER_WITH_EDGE",
          sourcePath,
          `${object.id} cannot have both an unrecoverable marker and a derives_from origin`,
          object.id,
        );
      } else if (!hasOrigin && !hasUnrecoverableOrigin) {
        failure(
          failures,
          "DECISION_ORIGIN_REQUIRED",
          sourcePath,
          `${object.id} has no derives_from origin`,
          object.id,
        );
        const draft = draftsById.get(object.id);
        if (draft !== undefined) {
          addGap(
            gaps,
            draft,
            "Unrecoverable origin",
            `${object.id}: no recoverable derives_from origin`,
            now,
            ["decision"],
          );
        }
      }
    }
    if (object.type === "constraint" && !object.attributes.axiomatic) {
      const hasParent = relations.some(
        (edge) =>
          edge.sourceId === object.id &&
          edge.relation === "derives_from" &&
          objectById.get(edge.targetId)?.type === "decision",
      );
      if (!hasParent) {
        failure(
          failures,
          "CONSTRAINT_PARENT_REQUIRED",
          sourcePath,
          `${object.id} is not axiomatic and has no Decision parent`,
          object.id,
        );
      }
    }
  }
}

function validateHistoricalTerminalStates(
  objects: readonly KnowledgeObject[],
  importedIds: ReadonlySet<string>,
  relations: readonly Relation[],
  failures: BackfillFailure[],
  sourceById: ReadonlyMap<string, string>,
): void {
  for (const object of objects) {
    if (
      !importedIds.has(object.id) ||
      object.type !== "open_question" ||
      object.status !== "resolved"
    ) {
      continue;
    }
    const hasResolver = relations.some((edge) => {
      if (
        edge.relation !== "derives_from" ||
        edge.targetId !== object.id ||
        !importedIds.has(edge.sourceId)
      ) {
        return false;
      }
      return objects.some(
        (candidate) => candidate.id === edge.sourceId && candidate.type === "decision",
      );
    });
    if (!hasResolver) {
      failure(
        failures,
        "HISTORICAL_STATE_PRECONDITION",
        sourceById.get(object.id) ?? "backfill",
        `${object.id} must have a resolving Decision in the same backfill import`,
        object.id,
      );
    }
  }
}

function validateSupersessions(
  drafts: readonly BackfillObjectDraft[],
  objects: ReadonlyMap<string, KnowledgeObject>,
  importedIds: ReadonlySet<string>,
  failures: BackfillFailure[],
): readonly BackfillSupersession[] {
  const supersessions: BackfillSupersession[] = [];
  const predecessors = new Set<string>();
  for (const draft of drafts) {
    if (!importedIds.has(draft.id) || draft.supersedesId === null) continue;
    if (draft.supersedesId === draft.id) {
      failure(
        failures,
        "SUPERSESSION_CONFLICT",
        draft.sourcePath,
        `${draft.id} cannot supersede itself`,
        draft.id,
      );
      continue;
    }
    const predecessor = objects.get(draft.supersedesId);
    const sourcePath = draft.sourcePath;
    const successor = objects.get(draft.id);
    if (predecessor === undefined || successor === undefined) {
      failure(
        failures,
        "SUPERSESSION_CONFLICT",
        sourcePath,
        `${draft.id} names a missing supersession predecessor`,
        draft.id,
      );
      continue;
    }
    const predecessorOpen =
      predecessor.status === "active" ||
      (predecessor.type === "artifact" && predecessor.status === "current");
    const historical =
      importedIds.has(predecessor.id) &&
      predecessor.type === "decision" &&
      predecessor.status === "superseded" &&
      successor.type === "decision";
    if (!historical && (!predecessorOpen || predecessor.type !== successor.type)) {
      failure(
        failures,
        "SUPERSESSION_CONFLICT",
        sourcePath,
        `${draft.id} cannot supersede ${draft.supersedesId}`,
        draft.id,
      );
      continue;
    }
    if (predecessors.has(draft.supersedesId)) {
      failure(
        failures,
        "SUPERSESSION_CONFLICT",
        sourcePath,
        `more than one imported object supersedes ${draft.supersedesId}`,
        draft.id,
      );
      continue;
    }
    predecessors.add(draft.supersedesId);
    supersessions.push({
      predecessorId: draft.supersedesId,
      successorId: draft.id,
      mode: historical ? "historical" : "existing",
    });
  }
  for (const draft of drafts) {
    if (!importedIds.has(draft.id) || draft.type !== "decision" || draft.status !== "superseded") {
      continue;
    }
    const successors = drafts.filter(
      (candidate) =>
        importedIds.has(candidate.id) &&
        candidate.type === "decision" &&
        candidate.supersedesId === draft.id,
    );
    if (successors.length !== 1) {
      failure(
        failures,
        "SUPERSESSION_CONFLICT",
        draft.sourcePath,
        `${draft.id} must have exactly one successor in the same backfill import`,
        draft.id,
      );
    }
  }
  return supersessions;
}

function validateGlossaryUniqueness(
  writes: readonly BackfillObjectWrite[],
  workingSet: BackfillWorkingSet,
  failures: BackfillFailure[],
  sourceById: ReadonlyMap<string, string>,
): void {
  const terms = new Map<string, string>();
  for (const object of workingSet.objects) {
    if (
      object.type === "glossary_entry" &&
      object.status === "active" &&
      object.validToVersion === null
    ) {
      const term = object.attributes.term.toLowerCase();
      terms.set(`${object.scopeId}\0${term}`, object.id);
    }
  }
  for (const object of writes) {
    if (object.type !== "glossary_entry" || object.status !== "active") continue;
    const term = stringValue(object.attributes, ["term"]);
    if (term === undefined) continue;
    const key = `${object.scopeId}\0${term.toLowerCase()}`;
    const predecessor = terms.get(key);
    if (predecessor !== undefined) {
      failure(
        failures,
        "DUPLICATE_GLOSSARY_TERM",
        sourceById.get(object.id) ?? "backfill",
        `${object.id} duplicates active glossary term ${term} from ${predecessor}`,
        object.id,
      );
    } else {
      terms.set(key, object.id);
    }
  }
}

export function validateBackfill(
  bundle: BackfillBundle,
  workingSet: BackfillWorkingSet,
  currentVersion: number,
  now = new Date(),
): BackfillPlan {
  const failures: BackfillFailure[] = [];
  const gaps: BackfillGap[] = [];
  const labelCandidates = new Map<
    string,
    { readonly projectScopeId: string; readonly normalised: string; sources: Set<string> }
  >();
  const scopes = new Map(workingSet.scopes.map((scope) => [scope.id, scope]));
  const registry: LabelRegistry = {
    labels: workingSet.labels,
    aliases: workingSet.aliases,
  };
  const nextVersion = currentVersion + 1;
  const existingIds = new Set(workingSet.objects.map((object) => object.id));
  const seenIds = new Set<string>();
  const importedObjects = new Map<string, KnowledgeObject>();
  const writes: BackfillObjectWrite[] = [];
  const sourceById = new Map<string, string>();

  for (const draft of bundle.objects) {
    if (draft.type === "" || !isKnowledgeObjectType(draft.type)) {
      addGap(
        gaps,
        draft,
        draft.type === "" ? "new" : draft.type,
        `${draft.id}: ${draft.title || draft.body}`,
        now,
      );
      continue;
    }
    if (draft.scopeIds.length !== 1) {
      addGap(
        gaps,
        draft,
        "two_scope_knowledge",
        `${draft.id}: knowledge was assigned to ${draft.scopeIds.length} scopes`,
        now,
      );
      continue;
    }
    if (existingIds.has(draft.id)) {
      failure(
        failures,
        "DUPLICATE_OBJECT",
        draft.sourcePath,
        `${draft.id} already exists in the graph`,
        draft.id,
      );
      continue;
    }
    if (seenIds.has(draft.id)) {
      failure(
        failures,
        "DUPLICATE_OBJECT",
        draft.sourcePath,
        `${draft.id} is duplicated in the import`,
        draft.id,
      );
      continue;
    }
    seenIds.add(draft.id);
    checkObjectShape(draft, draft.type, scopes, failures);
    const featureLabelIds = resolveFeatureLabels(
      draft,
      scopes,
      registry,
      nextVersion,
      labelCandidates,
      failures,
    );
    const object = syntheticObject(draft, draft.type, featureLabelIds, nextVersion);
    importedObjects.set(object.id, object);
    sourceById.set(object.id, draft.sourcePath);
    writes.push({
      id: draft.id,
      type: draft.type,
      scopeId: draft.scopeId,
      featureLabelIds,
      title: draft.title,
      body: draft.body,
      status: draft.status as KnowledgeObject["status"],
      attributes: { ...draft.attributes },
      authoredBy: "human",
      sourceRef: `backfill:${draft.sourcePath}`,
      supersedesId: draft.supersedesId,
      supersededById: null,
    });
  }

  const relationValidation = validateRelations(
    bundle.relations,
    workingSet,
    importedObjects,
    nextVersion,
    now,
    failures,
    gaps,
  );
  const allObjects = [...workingSet.objects, ...importedObjects.values()];
  const allRelations = [...workingSet.relations, ...relationValidation.relations];
  validateOriginsAndParents(
    allObjects,
    new Set(importedObjects.keys()),
    allRelations,
    failures,
    sourceById,
    new Map(bundle.objects.map((draft) => [draft.id, draft])),
    gaps,
    now,
  );
  validateHistoricalTerminalStates(
    allObjects,
    new Set(importedObjects.keys()),
    allRelations,
    failures,
    sourceById,
  );
  const supersessions = validateSupersessions(
    bundle.objects,
    new Map(allObjects.map((object) => [object.id, object])),
    new Set(importedObjects.keys()),
    failures,
  );
  const historicalSuccessors = new Map(
    supersessions
      .filter((item) => item.mode === "historical")
      .map((item) => [item.predecessorId, item.successorId]),
  );
  const preparedWrites = writes.map((object) => ({
    ...object,
    supersededById: historicalSuccessors.get(object.id) ?? null,
  }));
  const automaticRelations = supersessions.map((supersession, index) =>
    relationForValidation(
      {
        sourceId: supersession.successorId,
        relation: "supersedes",
        targetId: supersession.predecessorId,
        targetKind: "knowledge_object",
      },
      bundle.relations.length + index,
      nextVersion,
      now,
    ),
  );
  const relationsForCycleCheck = [
    ...workingSet.relations,
    ...relationValidation.relations,
    ...automaticRelations,
  ];
  for (const relation of automaticRelations) {
    if (
      wouldCreateCycle(
        relationsForCycleCheck.filter((candidate) => candidate.id !== relation.id),
        relation.sourceId,
        relation.targetId,
        relation.relation,
      )
    ) {
      failure(
        failures,
        "CYCLE_DETECTED",
        sourceById.get(relation.sourceId) ?? "backfill",
        `supersedes cycle involving ${relation.sourceId}`,
      );
    }
  }
  validateGlossaryUniqueness(preparedWrites, workingSet, failures, sourceById);
  const warnings = detectBackfillDuplicates(
    [...importedObjects.values()],
    relationValidation.relations,
    sourceById,
  );
  for (const candidate of labelCandidates.values()) {
    failure(
      failures,
      "LABEL_CANDIDATE",
      [...candidate.sources].join(","),
      `unrecognised label ${candidate.normalised} for project ${candidate.projectScopeId}`,
    );
  }
  const candidates: BackfillLabelCandidate[] = [...labelCandidates.values()]
    .map((candidate) => ({
      normalised: candidate.normalised,
      projectScopeId: candidate.projectScopeId,
      sources: [...candidate.sources].sort((left, right) => left.localeCompare(right)),
    }))
    .sort(
      (left, right) =>
        left.projectScopeId.localeCompare(right.projectScopeId) ||
        left.normalised.localeCompare(right.normalised),
    );

  return {
    objects: preparedWrites,
    relations: relationValidation.writes,
    supersessions,
    failures,
    warnings,
    gaps,
    labelCandidates: candidates,
    friction: frictionReport(bundle),
    gapSummary: gapSummary(gaps),
  };
}
