import {
  AggregateDomainError,
  DomainError,
  ErrorCode,
  recordFailure,
  type DomainFailure,
} from "../errors.js";
import { knowledgeClassOf } from "../entity/class.js";
import { requiredCamelKeys } from "../entity/contract.js";
import type { Constraint, Decision, KnowledgeObject, Observation } from "../entity/types.js";
import type { FeatureLabel } from "../label/types.js";
import { projectOf, resolveChain, type Scope } from "../scope/index.js";
import {
  ACYCLIC_RELATIONS,
  RELATION_TARGET_KINDS,
  isLegal,
  isOpen,
  isRelationTargetKind,
  wouldCreateCycle,
  type Relation,
  type RelationVerb,
  type SourceType,
  type TargetType,
} from "../relation/legality.js";

export const APPEND_ONLY_WHITELIST = [
  "status",
  "lastVerifiedAt",
  "reviewRequired",
  // Filing metadata, not an assertion about the world (Domain Spec A17).
  "featureLabelIds",
  "supersededById",
  "validToVersion",
  "lockVersion",
] as const;

export type WorkingSet = {
  readonly objects: readonly KnowledgeObject[];
  readonly relations: readonly Relation[];
  readonly scopes: readonly Scope[];
  readonly labels: readonly FeatureLabel[];
};

export type InvariantOptions = {
  readonly backfillMode?: boolean;
};

function fail(code: string, message: string): never {
  throw new DomainError(code, message);
}

function byId(objects: readonly KnowledgeObject[]): ReadonlyMap<string, KnowledgeObject> {
  return new Map(objects.map((object) => [object.id, object]));
}

function scopesById(scopes: readonly Scope[]): ReadonlyMap<string, Scope> {
  return new Map(scopes.map((scope) => [scope.id, scope]));
}

function openOf(relations: readonly Relation[], verb?: RelationVerb): Relation[] {
  return relations.filter((edge) => isOpen(edge) && (verb === undefined || edge.relation === verb));
}

export function activeAtGraphVersion(
  validFromVersion: number,
  validToVersion: number | null,
  version: number,
): boolean {
  return validFromVersion <= version && (validToVersion === null || validToVersion > version);
}

function requiredAttributeKeys(object: KnowledgeObject): readonly string[] {
  return requiredCamelKeys(object.type);
}

function missingAttributeKeys(attributes: object, keys: readonly string[]): string[] {
  const record = attributes as Record<string, unknown>;
  return keys.filter((key) => record[key] === undefined || record[key] === null);
}

function originValue(object: KnowledgeObject): unknown {
  return (object.attributes as Record<string, unknown>).origin;
}

function checkOriginMarker(object: KnowledgeObject, backfillMode: boolean): void {
  const origin = originValue(object);
  if (origin === undefined) {
    return;
  }
  if (object.type !== "decision" || origin !== "unrecoverable") {
    fail(ErrorCode.INVALID_ORIGIN_MARKER, `${object.id} has an invalid origin marker`);
  }
  if (!backfillMode) {
    fail(ErrorCode.BACKFILL_ORIGIN_FORBIDDEN, `${object.id} uses a backfill-only origin marker`);
  }
}

function checkEnvelope(object: KnowledgeObject): void {
  if (object.scopeId === "") {
    fail(ErrorCode.SCOPE_REQUIRED, `${object.id} has no scope`);
  }
  if (object.knowledgeClass !== knowledgeClassOf(object.type)) {
    fail(ErrorCode.KNOWLEDGE_CLASS_MISMATCH, `${object.id} knowledge_class does not match type`);
  }
  if (object.knowledgeClass === "raw") {
    if (object.approvedAt !== null || object.lastVerifiedAt !== null) {
      fail(ErrorCode.RAW_APPROVAL_FORBIDDEN, `${object.id} is raw and must not carry approval`);
    }
  } else if (
    object.approvedAt === null ||
    object.lastVerifiedAt === null ||
    object.authoredBy === undefined
  ) {
    fail(ErrorCode.PROVENANCE_REQUIRED, `${object.id} is reviewed/operational without provenance`);
  }
  // Every failure below is the caller's own object shape being wrong, so the
  // message must be actionable on its own: name exactly which keys are
  // missing and what the type requires, for every type. A caller cannot
  // self-correct from "is missing required attributes" alone (see build log:
  // the MCP input schema does not expose these per-type requirements either,
  // so this message is the only feedback channel).
  const requiredKeys = requiredAttributeKeys(object);
  const missingKeys = missingAttributeKeys(object.attributes, requiredKeys);
  if (missingKeys.length > 0) {
    fail(
      ErrorCode.REQUIRED_ATTRIBUTES_MISSING,
      `${object.id} is missing required attributes: ${missingKeys.join(", ")} ` +
        `(${object.type} requires ${requiredKeys.join(", ")})`,
    );
  }
}

/**
 * Length caps only apply to text. The presence of these attributes is checked
 * above and by the database, but neither guarantees the value is a string:
 * PostgreSQL's `?&` tests for key presence only, so a stored object whose
 * `rule` is a JSON number reaches this function and must not crash the
 * invariant pass with a TypeError instead of reporting a DomainError.
 */
function overCap(value: unknown, cap: number): boolean {
  return typeof value === "string" && value.length > cap;
}

function checkLengthCaps(object: KnowledgeObject): void {
  if (object.type === "constraint" && overCap(object.attributes.rule, 280)) {
    fail(ErrorCode.LENGTH_CAP_EXCEEDED, `${object.id} constraint rule exceeds 280`);
  }
  if (object.type === "glossary_entry" && overCap(object.attributes.definition, 200)) {
    fail(ErrorCode.LENGTH_CAP_EXCEEDED, `${object.id} glossary definition exceeds 200`);
  }
  if (object.type === "artifact" && overCap(object.attributes.summary, 500)) {
    fail(ErrorCode.LENGTH_CAP_EXCEEDED, `${object.id} artifact summary exceeds 500`);
  }
  if (
    object.type === "open_question" &&
    object.attributes.blocking &&
    overCap(object.attributes.question, 280)
  ) {
    fail(ErrorCode.LENGTH_CAP_EXCEEDED, `${object.id} blocking question exceeds 280`);
  }
}

function checkDecisionOrigin(
  object: Decision,
  relations: readonly Relation[],
  backfillMode: boolean,
): void {
  const origin = openOf(relations, "derives_from").some((edge) => edge.sourceId === object.id);
  if (object.attributes.origin === "unrecoverable") {
    if (origin) {
      fail(
        ErrorCode.ORIGIN_MARKER_WITH_EDGE,
        `${object.id} cannot have both an unrecoverable marker and a derives_from origin`,
      );
    }
    if (!backfillMode) {
      fail(ErrorCode.BACKFILL_ORIGIN_FORBIDDEN, `${object.id} uses a backfill-only origin marker`);
    }
    return;
  }
  if (!origin) {
    fail(ErrorCode.DECISION_ORIGIN_REQUIRED, `${object.id} has no derives_from origin`);
  }
}

function checkConstraintParent(
  object: Constraint,
  relations: readonly Relation[],
  objects: ReadonlyMap<string, KnowledgeObject>,
): void {
  if (object.attributes.axiomatic) {
    return;
  }
  const parent = openOf(relations, "derives_from").some((edge) => {
    if (edge.sourceId !== object.id) {
      return false;
    }
    return objects.get(edge.targetId)?.type === "decision";
  });
  if (!parent) {
    fail(
      ErrorCode.CONSTRAINT_PARENT_REQUIRED,
      `${object.id} is not axiomatic and has no Decision parent`,
    );
  }
}

function checkSupersession(
  object: KnowledgeObject,
  objects: ReadonlyMap<string, KnowledgeObject>,
  relations: readonly Relation[],
): void {
  if (object.supersedesId === null) {
    return;
  }
  const predecessor = objects.get(object.supersedesId);
  if (
    predecessor === undefined ||
    predecessor.supersededById !== object.id ||
    predecessor.status !== "superseded"
  ) {
    fail(ErrorCode.SUPERSESSION_CONFLICT, `${object.id} supersession pair is incomplete`);
  }
  const edges = openOf(relations, "supersedes").filter(
    (edge) => edge.sourceId === object.id && edge.targetId === object.supersedesId,
  );
  if (edges.length !== 1) {
    fail(
      ErrorCode.SUPERSESSION_CONFLICT,
      `${object.id} must have exactly one open supersedes edge`,
    );
  }
}

function checkLabels(object: KnowledgeObject, set: WorkingSet): void {
  if (object.featureLabelIds.length === 0) {
    return;
  }
  const scopeMap = scopesById(set.scopes);
  if (!scopeMap.has(object.scopeId)) {
    fail(ErrorCode.SCOPE_REQUIRED, `${object.id} scope ${object.scopeId} is missing`);
  }
  const project = projectOf(resolveChain(object.scopeId, scopeMap));
  if (project === undefined) {
    fail(ErrorCode.UNKNOWN_LABEL, `${object.id} is not under a Project and cannot carry labels`);
  }
  for (const labelId of object.featureLabelIds) {
    // Assignment may occur after object approval; the envelope deliberately
    // has no label-assignment version. The write path validates activity at
    // the curation version, while this invariant checks identity ownership.
    const hit = set.labels.find(
      (label) => label.id === labelId && label.projectScopeId === project.id,
    );
    if (hit === undefined) {
      fail(ErrorCode.UNKNOWN_LABEL, `${object.id} carries unknown label ${labelId}`);
    }
  }
}

function checkLegality(edge: Relation, objects: ReadonlyMap<string, KnowledgeObject>): void {
  const source = objects.get(edge.sourceId);
  if (source === undefined) {
    fail(ErrorCode.ILLEGAL_RELATION, `source ${edge.sourceId} is not a knowledge object`);
  }
  /*
   * Absence is rejected rather than read as `knowledge_object`. The trigger
   * in 005_relation_legality.sql cannot match a NULL kind to either branch
   * and raises ILLEGAL_RELATION with nothing a caller can act on, so the two
   * have to agree on what absence means, and this is the layer that can say
   * which edge and which field.
   */
  if (!isRelationTargetKind(edge.targetKind)) {
    fail(
      ErrorCode.ILLEGAL_RELATION,
      `relation ${edge.sourceId} ${edge.relation} ${edge.targetId} ` +
        `${edge.targetKind === undefined || edge.targetKind === null ? "does not say" : `says ${JSON.stringify(edge.targetKind)} for`} ` +
        `target_kind; it must be one of ${RELATION_TARGET_KINDS.join(", ")}`,
    );
  }
  let targetType: TargetType;
  if (edge.targetKind === "external_reference") {
    targetType = "external_reference";
  } else {
    const target = objects.get(edge.targetId);
    if (target === undefined) {
      fail(ErrorCode.ILLEGAL_RELATION, `target ${edge.targetId} is not a knowledge object`);
    }
    targetType = target.type;
  }
  if (!isLegal(source.type as SourceType, edge.relation, targetType)) {
    fail(
      ErrorCode.ILLEGAL_RELATION,
      `${source.type} ${edge.relation} ${targetType} is not a legal triple`,
    );
  }
}

function checkAcyclicity(relations: readonly Relation[]): void {
  for (const verb of ACYCLIC_RELATIONS) {
    const edges = openOf(relations, verb);
    for (const edge of edges) {
      const others = edges.filter((candidate) => candidate !== edge);
      if (wouldCreateCycle(others, edge.sourceId, edge.targetId, verb)) {
        fail(ErrorCode.CYCLE_DETECTED, `${verb} cycle involving ${edge.sourceId}`);
      }
    }
  }
}

export function assertInvariants(set: WorkingSet, options: InvariantOptions = {}): void {
  const objects = byId(set.objects);
  const backfillMode = options.backfillMode === true;
  for (const object of set.objects) {
    checkOriginMarker(object, backfillMode);
    checkEnvelope(object);
    checkLengthCaps(object);
    checkSupersession(object, objects, set.relations);
    checkLabels(object, set);
    if (object.type === "decision") {
      checkDecisionOrigin(object, set.relations, backfillMode);
    }
    if (object.type === "constraint") {
      checkConstraintParent(object, set.relations, objects);
    }
    if (object.type === "observation") {
      const obs: Observation = object;
      if (obs.attributes.evidenceRef === "" || obs.attributes.reviewBy === undefined) {
        fail(ErrorCode.OBSERVATION_EVIDENCE_REQUIRED, `${object.id} is missing evidence`);
      }
    }
  }
  for (const edge of set.relations) {
    checkLegality(edge, objects);
  }
  checkAcyclicity(set.relations);
}

/**
 * Validates newly added objects and relations against an already-valid graph
 * and returns every rejection rather than the first. Existing rows are not
 * re-checked, which matters for backfill-only markers on objects that are
 * already in the database.
 *
 * Rules are evaluated in the same order as assertGraphAdditions, so failures[0]
 * is the rejection that the throwing form reports.
 */
export function collectGraphAdditionFailures(
  base: WorkingSet,
  additions: WorkingSet,
): readonly DomainFailure[] {
  const mergedObjects = [...base.objects, ...additions.objects];
  const objects = byId(mergedObjects);
  const mergedRelations = [...base.relations, ...additions.relations];
  const mergedSet: WorkingSet = {
    objects: mergedObjects,
    relations: mergedRelations,
    scopes: base.scopes,
    labels: base.labels,
  };
  const failures: DomainFailure[] = [];

  for (const object of additions.objects) {
    recordFailure(failures, object.id, () => checkOriginMarker(object, false));
    const envelope = recordFailure(failures, object.id, () => checkEnvelope(object));
    if (envelope) {
      // checkEnvelope is what guarantees these attributes are present.
      recordFailure(failures, object.id, () => checkLengthCaps(object));
    }
    recordFailure(failures, object.id, () => checkSupersession(object, objects, mergedRelations));
    recordFailure(failures, object.id, () => checkLabels(object, mergedSet));
    if (object.type === "decision") {
      recordFailure(failures, object.id, () => checkDecisionOrigin(object, mergedRelations, false));
    }
    if (object.type === "constraint") {
      recordFailure(failures, object.id, () =>
        checkConstraintParent(object, mergedRelations, objects),
      );
    }
    if (object.type === "observation") {
      const obs: Observation = object;
      if (obs.attributes.evidenceRef === "" || obs.attributes.reviewBy === undefined) {
        failures.push({
          code: ErrorCode.OBSERVATION_EVIDENCE_REQUIRED,
          message: `${object.id} is missing evidence`,
          objectId: object.id,
        });
      }
    }
  }
  for (const edge of additions.relations) {
    recordFailure(failures, undefined, () => checkLegality(edge, objects));
  }
  recordFailure(failures, undefined, () => checkAcyclicity(mergedRelations));
  return failures;
}

/**
 * Throwing form. Carries every rejection, not the first: a curator shown one
 * problem at a time cannot tell whether fixing it will reveal three more.
 *
 * `AggregateDomainError` takes its `code` and `message` from `failures[0]`, so
 * callers that only key on those are unaffected.
 */
export function assertGraphAdditions(base: WorkingSet, additions: WorkingSet): void {
  const failures = collectGraphAdditionFailures(base, additions);
  if (failures.length > 0) {
    throw new AggregateDomainError(failures);
  }
}

function contentSnapshot(object: KnowledgeObject): Record<string, unknown> {
  return {
    id: object.id,
    type: object.type,
    knowledgeClass: object.knowledgeClass,
    scopeId: object.scopeId,
    title: object.title,
    body: object.body,
    attributes: object.attributes,
    authoredBy: object.authoredBy,
    sourceRef: object.sourceRef,
    createdAt: object.createdAt.getTime(),
    approvedAt: object.approvedAt?.getTime() ?? null,
    supersedesId: object.supersedesId,
    validFromVersion: object.validFromVersion,
  };
}

/**
 * INV-7. Approval is assigned at insertion. After approval, only the
 * whitelist may change. Scope change is SCOPE_IMMUTABLE rather than
 * IMMUTABLE_AFTER_APPROVAL.
 */
export function assertAppendOnlyUpdate(before: KnowledgeObject, after: KnowledgeObject): void {
  if (after.id !== before.id || after.type !== before.type) {
    fail(ErrorCode.IMMUTABLE_AFTER_APPROVAL, `${before.id} id/type cannot change`);
  }
  if ((after.approvedAt?.getTime() ?? null) !== (before.approvedAt?.getTime() ?? null)) {
    fail(ErrorCode.IMMUTABLE_AFTER_APPROVAL, `${before.id} approval is assigned at insert`);
  }
  if (before.approvedAt === null) {
    return;
  }
  if (after.scopeId !== before.scopeId) {
    fail(ErrorCode.SCOPE_IMMUTABLE, `${before.id} scope cannot change after approval`);
  }
  if (JSON.stringify(contentSnapshot(after)) !== JSON.stringify(contentSnapshot(before))) {
    fail(ErrorCode.IMMUTABLE_AFTER_APPROVAL, `${before.id} content cannot change after approval`);
  }
}
