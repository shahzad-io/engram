import type { Client } from "pg";
import {
  type BackfillBundle,
  type BackfillFailure,
  type BackfillExternalReferenceWrite,
  type BackfillObjectDraft,
  type BackfillPlan,
  type BackfillReport,
  type BackfillWorkingSet,
  validateBackfill,
} from "../../domain/index.js";
import { canonicalJson } from "../../domain/pack/cost.js";
import {
  curationTransaction,
  type FeatureLabelAssignment,
  type FeatureLabelAliasWrite,
  type FeatureLabelWrite,
  type ScopeWrite,
} from "../write/index.js";
import { backfillCurationTransaction } from "../write/backfill.js";
import {
  getCurrentGraphVersionOrZero,
  loadPackWorkingSet,
} from "../../infrastructure/persistence/read.js";
import { loadBackfillBundle } from "../../infrastructure/backfill/read.js";
import {
  planExternalReferenceManifest,
  planLabelManifest,
  planScopeManifest,
} from "./manifests.js";

export type BackfillSource = string | BackfillBundle;

export class BackfillImportError extends Error {
  readonly report: BackfillReport;

  constructor(report: BackfillReport) {
    super(`backfill validation failed with ${report.failures.length} failure(s)`);
    this.name = "BackfillImportError";
    this.report = report;
  }
}

function parseFailures(
  failures: readonly { readonly sourcePath: string; readonly message: string }[],
): readonly BackfillFailure[] {
  return failures.map((failure) => ({
    code: "PARSE_ERROR",
    sourcePath: failure.sourcePath,
    message: failure.message,
  }));
}

async function loadSource(source: BackfillSource): Promise<{
  readonly bundle: BackfillBundle;
  readonly failures: readonly BackfillFailure[];
}> {
  if (typeof source !== "string") {
    return { bundle: source, failures: [] };
  }
  const loaded = await loadBackfillBundle(source);
  return {
    bundle: loaded.bundle,
    failures: parseFailures(loaded.failures),
  };
}

function reportFromPlan(
  plan: BackfillPlan,
  currentVersion: number,
  dryRun: boolean,
  failures: readonly BackfillFailure[],
  graphVersion: number | null = null,
  phaseVersions: PhaseVersions = emptyPhaseVersions(),
  importedObjectIds: readonly string[] = graphVersion === null
    ? []
    : plan.objects.map((object) => object.id),
): BackfillReport {
  const automaticSupersessionKeys = new Set(
    plan.supersessions.map((item) =>
      relationKey(item.successorId, "supersedes", item.predecessorId),
    ),
  );
  return {
    dryRun,
    currentVersion,
    nextVersion: currentVersion + 1,
    importedObjectIds,
    importedRelationCount:
      graphVersion === null
        ? 0
        : plan.relations.filter(
            (relation) =>
              !automaticSupersessionKeys.has(
                relationKey(relation.sourceId, relation.relation, relation.targetId),
              ),
          ).length + plan.supersessions.length,
    graphVersion,
    graphVersions: phaseVersions.graphVersions,
    scopeGraphVersion: phaseVersions.scopeGraphVersion,
    objectGraphVersion: phaseVersions.objectGraphVersion,
    labelGraphVersion: phaseVersions.labelGraphVersion,
    failures: [...failures, ...plan.failures],
    warnings: plan.warnings,
    gaps: plan.gaps,
    gapSummary: plan.gapSummary,
    labelCandidates: plan.labelCandidates,
    friction: plan.friction,
  };
}

type PhaseVersions = {
  readonly graphVersions: readonly number[];
  readonly scopeGraphVersion: number | null;
  readonly objectGraphVersion: number | null;
  readonly labelGraphVersion: number | null;
};

function emptyPhaseVersions(): PhaseVersions {
  return {
    graphVersions: [],
    scopeGraphVersion: null,
    objectGraphVersion: null,
    labelGraphVersion: null,
  };
}

type PreparedBackfill = {
  readonly plan: BackfillPlan;
  readonly currentVersion: number;
  readonly failures: readonly BackfillFailure[];
  readonly scopes: readonly ScopeWrite[];
  readonly externalReferences: readonly BackfillExternalReferenceWrite[];
  readonly labels: readonly FeatureLabelWrite[];
  readonly aliases: readonly FeatureLabelAliasWrite[];
  readonly assignments: readonly FeatureLabelAssignment[];
  readonly phaseVersions: PhaseVersions;
};

function attributeValue(
  attributes: Readonly<Record<string, unknown>>,
  snake: string,
  camel = snake,
): unknown {
  return attributes[camel] ?? attributes[snake];
}

function comparableAttributes(
  type: string,
  attributes: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const date = (snake: string, camel: string): Date => {
    const value = attributeValue(attributes, snake, camel);
    return value instanceof Date ? value : new Date(String(value));
  };
  switch (type) {
    case "requirement":
      return {
        source: String(attributes.source),
        rationale: String(attributes.rationale),
      };
    case "discussion":
      return {
        medium: attributes.medium,
        occurredAt: date("occurred_at", "occurredAt"),
        contentRef: attributeValue(attributes, "content_ref", "contentRef"),
        ...(Array.isArray(attributes.participants)
          ? { participants: attributes.participants }
          : {}),
      };
    case "observation":
      return {
        observedAt: date("observed_at", "observedAt"),
        evidenceRef: String(attributeValue(attributes, "evidence_ref", "evidenceRef")),
        reviewBy: date("review_by", "reviewBy"),
      };
    case "hypothesis":
      return {
        whatWasTried: String(attributeValue(attributes, "what_was_tried", "whatWasTried")),
        whyItFailed: String(attributeValue(attributes, "why_it_failed", "whyItFailed")),
        evidenceRef: String(attributeValue(attributes, "evidence_ref", "evidenceRef")),
        ...(attributeValue(attributes, "would_reconsider_if", "wouldReconsiderIf") !== undefined
          ? {
              wouldReconsiderIf: String(
                attributeValue(attributes, "would_reconsider_if", "wouldReconsiderIf"),
              ),
            }
          : {}),
      };
    case "decision":
      return {
        statement: String(attributes.statement),
        rationale: String(attributes.rationale),
        reversibility: attributes.reversibility,
        alternativesRejected: attributeValue(
          attributes,
          "alternatives_rejected",
          "alternativesRejected",
        ),
        ...(attributes.origin === "unrecoverable" ? { origin: "unrecoverable" } : {}),
      };
    case "open_question":
      return {
        question: String(attributes.question),
        blocking: Boolean(attributes.blocking),
        ...(attributes.owner !== undefined ? { owner: String(attributes.owner) } : {}),
      };
    case "constraint":
      return {
        rule: String(attributes.rule),
        enforcement: attributes.enforcement,
        axiomatic: Boolean(attributes.axiomatic),
      };
    case "glossary_entry":
      return {
        term: String(attributes.term),
        definition: String(attributes.definition),
        axiomatic: Boolean(attributes.axiomatic),
        ...(Array.isArray(attributes.aliases) ? { aliases: attributes.aliases } : {}),
      };
    case "artifact":
      return {
        kind: String(attributes.kind),
        version: String(attributes.version),
        location: String(attributes.location),
        contentHash: String(attributeValue(attributes, "content_hash", "contentHash")),
        summary: String(attributes.summary),
      };
    default:
      return attributes;
  }
}

function sameExistingObject(
  draft: BackfillObjectDraft,
  object: BackfillWorkingSet["objects"][number],
): boolean {
  return (
    draft.id === object.id &&
    draft.type === object.type &&
    draft.scopeId === object.scopeId &&
    draft.title === object.title &&
    draft.body === object.body &&
    draft.status === object.status &&
    canonicalJson(comparableAttributes(draft.type, draft.attributes)) ===
      canonicalJson(object.attributes) &&
    draft.supersedesId === object.supersedesId &&
    object.authoredBy === "human" &&
    object.sourceRef === `backfill:${draft.sourcePath}`
  );
}

function relationKeyFromDraft(
  sourceId: string,
  relation: string,
  targetId: string,
  targetKind: string,
): string {
  return `${sourceId}\0${relation}\0${targetId}\0${targetKind}`;
}

function filterIdempotentBundle(
  bundle: BackfillBundle,
  workingSet: BackfillWorkingSet,
): { readonly bundle: BackfillBundle; readonly failures: readonly BackfillFailure[] } {
  const failures: BackfillFailure[] = [];
  const existingObjects = new Map(workingSet.objects.map((object) => [object.id, object]));
  const objects: BackfillObjectDraft[] = [];
  for (const draft of bundle.objects) {
    const existing = existingObjects.get(draft.id);
    if (existing === undefined) {
      objects.push(draft);
    } else if (!sameExistingObject(draft, existing)) {
      failures.push({
        code: "DUPLICATE_OBJECT_CONFLICT",
        sourcePath: draft.sourcePath,
        objectId: draft.id,
        message: `${draft.id} already exists with a different definition`,
      });
    }
  }

  const currentRelations = new Map(
    workingSet.relations
      .filter((relation) => relation.validToVersion === null)
      .map((relation) => [
        relationKeyFromDraft(
          relation.sourceId,
          relation.relation,
          relation.targetId,
          relation.targetKind,
        ),
        relation,
      ]),
  );
  const closedRelations = new Set(
    workingSet.relations
      .filter((relation) => relation.validToVersion !== null)
      .map((relation) =>
        relationKeyFromDraft(
          relation.sourceId,
          relation.relation,
          relation.targetId,
          relation.targetKind,
        ),
      ),
  );
  const relations = bundle.relations.filter((relation) => {
    const key = relationKeyFromDraft(
      relation.sourceId,
      relation.relation,
      relation.targetId,
      relation.targetKind,
    );
    if (currentRelations.has(key)) return false;
    if (closedRelations.has(key)) {
      failures.push({
        code: "DUPLICATE_RELATION_CONFLICT",
        sourcePath: relation.sourcePath,
        relationIndex: bundle.relations.indexOf(relation),
        message: `${relation.sourceId} ${relation.relation} ${relation.targetId} exists historically but is not open`,
      });
    }
    return true;
  });
  return {
    bundle: {
      ...bundle,
      objects,
      relations,
    },
    failures,
  };
}

function plannedObject(
  object: BackfillPlan["objects"][number],
  version: number,
): BackfillWorkingSet["objects"][number] {
  return {
    id: object.id,
    type: object.type,
    knowledgeClass: "reviewed",
    scopeId: object.scopeId,
    featureLabelIds: object.featureLabelIds,
    title: object.title,
    body: object.body,
    status: object.status,
    attributes: object.attributes,
    authoredBy: object.authoredBy,
    sourceRef: object.sourceRef,
    createdAt: new Date(0),
    approvedAt: new Date(0),
    lastVerifiedAt: new Date(0),
    supersedesId: object.supersedesId,
    supersededById: object.supersededById,
    reviewRequired: false,
    validFromVersion: version,
    validToVersion: null,
    lockVersion: 0,
  } as BackfillWorkingSet["objects"][number];
}

async function prepare(client: Client, source: BackfillSource): Promise<PreparedBackfill> {
  const loaded = await loadSource(source);
  const current = await getCurrentGraphVersionOrZero(client);
  const workingSet = await loadPackWorkingSet(client);
  const filtered = filterIdempotentBundle(loaded.bundle, workingSet as BackfillWorkingSet);
  const scopePlan = planScopeManifest(filtered.bundle.scopes ?? [], workingSet.scopes);
  const scopeVersion = current.version + (scopePlan.writes.length > 0 ? 1 : 0);
  const externalPlan = planExternalReferenceManifest(
    filtered.bundle.externalReferences ?? [],
    workingSet.externalReferences,
  );
  const objectChangesExpected =
    filtered.bundle.objects.length > 0 ||
    filtered.bundle.relations.length > 0 ||
    externalPlan.writes.length > 0;
  const objectVersion = scopeVersion + (objectChangesExpected ? 1 : 0);
  const validationWorkingSet: BackfillWorkingSet = {
    ...workingSet,
    scopes: scopePlan.scopes,
    externalReferences: [
      ...workingSet.externalReferences,
      ...externalPlan.writes.map((reference) => ({
        type: "external_reference" as const,
        id: reference.id,
        system: reference.system,
        identifier: reference.identifier,
        location: reference.location,
        symbol: reference.symbol,
        lastVerifiedAt: reference.lastVerifiedAt,
        createdAt: new Date(0),
      })),
    ],
  };
  const plan = validateBackfill(filtered.bundle, validationWorkingSet, objectVersion);
  const objectChanges =
    plan.objects.length > 0 ||
    plan.relations.length > 0 ||
    plan.supersessions.length > 0 ||
    externalPlan.writes.length > 0;
  const actualObjectVersion = scopeVersion + (objectChanges ? 1 : 0);
  const labelVersion = actualObjectVersion + 1;
  const labelsPlan = planLabelManifest(
    filtered.bundle.labels ?? [],
    filtered.bundle.labelAssignments ?? [],
    workingSet.labels,
    workingSet.aliases,
    [
      ...workingSet.objects,
      ...plan.objects.map((object) => plannedObject(object, actualObjectVersion)),
    ],
    scopePlan.scopes,
  );
  const phaseVersions: PhaseVersions = {
    graphVersions: [
      ...(scopePlan.writes.length > 0 ? [current.version + 1] : []),
      ...(objectChanges ? [actualObjectVersion] : []),
      ...(labelsPlan.labels.length > 0 ||
      labelsPlan.aliases.length > 0 ||
      labelsPlan.assignments.length > 0
        ? [labelVersion]
        : []),
    ],
    scopeGraphVersion: scopePlan.writes.length > 0 ? current.version + 1 : null,
    objectGraphVersion: objectChanges ? actualObjectVersion : null,
    labelGraphVersion:
      labelsPlan.labels.length > 0 ||
      labelsPlan.aliases.length > 0 ||
      labelsPlan.assignments.length > 0
        ? labelVersion
        : null,
  };
  return {
    plan,
    currentVersion: current.version,
    failures: [
      ...loaded.failures,
      ...filtered.failures,
      ...scopePlan.failures,
      ...externalPlan.failures,
      ...labelsPlan.failures,
    ],
    scopes: scopePlan.writes,
    externalReferences: externalPlan.writes,
    labels: labelsPlan.labels,
    aliases: labelsPlan.aliases,
    assignments: labelsPlan.assignments,
    phaseVersions,
  };
}

export async function dryRunBackfill(
  client: Client,
  source: BackfillSource,
): Promise<BackfillReport> {
  const prepared = await prepare(client, source);
  return reportFromPlan(
    prepared.plan,
    prepared.currentVersion,
    true,
    prepared.failures,
    null,
    prepared.phaseVersions,
  );
}

function relationKey(sourceId: string, relation: string, targetId: string): string {
  return `${sourceId}\0${relation}\0${targetId}`;
}

function supersessionOrder(plan: BackfillPlan): readonly BackfillPlan["supersessions"][number][] {
  const remaining = plan.supersessions.filter((item) => item.mode === "existing");
  const ordered: BackfillPlan["supersessions"][number][] = [];
  while (remaining.length > 0) {
    const successorIds = new Set(remaining.map((item) => item.successorId));
    const index = remaining.findIndex((item) => !successorIds.has(item.predecessorId));
    const chosenIndex = index < 0 ? 0 : index;
    const chosen = remaining.splice(chosenIndex, 1)[0];
    if (chosen !== undefined) ordered.push(chosen);
  }
  return ordered;
}

export async function importBackfill(
  client: Client,
  source: BackfillSource,
): Promise<BackfillReport> {
  const prepared = await prepare(client, source);
  const validationFailures = [...prepared.failures, ...prepared.plan.failures];
  const dryReport = reportFromPlan(
    prepared.plan,
    prepared.currentVersion,
    false,
    prepared.failures,
    null,
    prepared.phaseVersions,
  );
  if (validationFailures.length > 0) {
    throw new BackfillImportError(dryReport);
  }

  let scopeVersion: number | null = null;
  let objectVersion: number | null = null;
  let labelVersion: number | null = null;

  if (prepared.scopes.length > 0) {
    const result = await curationTransaction(
      client,
      { action: "backfill.scopes", actor: "curator" },
      async (transaction) => {
        for (const scope of prepared.scopes) {
          await transaction.insertScope(scope);
        }
      },
    );
    scopeVersion = result.version;
  }

  const objectChanges =
    prepared.plan.objects.length > 0 ||
    prepared.externalReferences.length > 0 ||
    prepared.plan.relations.length > 0 ||
    prepared.plan.supersessions.length > 0;
  if (objectChanges) {
    const result = await backfillCurationTransaction(
      client,
      { action: "backfill.import", actor: "curator" },
      async (transaction) => {
        for (const reference of [...prepared.externalReferences].sort((left, right) =>
          left.id.localeCompare(right.id),
        )) {
          await transaction.insertExternalReference(reference);
        }
        for (const object of [...prepared.plan.objects].sort((left, right) =>
          left.id.localeCompare(right.id),
        )) {
          await transaction.insertObject(object, "human");
        }
        const automaticSupersessionKeys = new Set(
          prepared.plan.supersessions.map((item) =>
            relationKey(item.successorId, "supersedes", item.predecessorId),
          ),
        );
        for (const relation of prepared.plan.relations) {
          if (
            automaticSupersessionKeys.has(
              relationKey(relation.sourceId, relation.relation, relation.targetId),
            )
          ) {
            continue;
          }
          await transaction.insertRelation(relation);
        }
        for (const supersession of supersessionOrder(prepared.plan)) {
          await transaction.supersede(supersession.predecessorId, supersession.successorId);
        }
        for (const supersession of prepared.plan.supersessions) {
          if (supersession.mode !== "historical") continue;
          await transaction.insertRelation({
            sourceId: supersession.successorId,
            relation: "supersedes",
            targetId: supersession.predecessorId,
            targetKind: "knowledge_object",
          });
        }
      },
    );
    objectVersion = result.version;
  }

  const labelChanges =
    prepared.labels.length > 0 || prepared.aliases.length > 0 || prepared.assignments.length > 0;
  if (labelChanges) {
    const result = await curationTransaction(
      client,
      { action: "backfill.labels", actor: "curator" },
      async (transaction) => {
        for (const label of [...prepared.labels].sort((left, right) =>
          left.id.localeCompare(right.id),
        )) {
          await transaction.insertFeatureLabel(label);
        }
        for (const alias of [...prepared.aliases].sort((left, right) =>
          left.alias.localeCompare(right.alias),
        )) {
          await transaction.insertFeatureLabelAlias(alias);
        }
        for (const assignment of [...prepared.assignments].sort((left, right) =>
          left.objectId.localeCompare(right.objectId),
        )) {
          await transaction.relabelObject(assignment.objectId, assignment.featureLabelIds);
        }
      },
    );
    labelVersion = result.version;
  }

  const graphVersions = [scopeVersion, objectVersion, labelVersion].filter(
    (version): version is number => version !== null,
  );
  const phaseVersions: PhaseVersions = {
    graphVersions,
    scopeGraphVersion: scopeVersion,
    objectGraphVersion: objectVersion,
    labelGraphVersion: labelVersion,
  };
  const graphVersion = objectVersion ?? labelVersion ?? scopeVersion;
  return reportFromPlan(
    prepared.plan,
    prepared.currentVersion,
    false,
    [],
    graphVersion,
    phaseVersions,
    objectVersion === null ? [] : prepared.plan.objects.map((object) => object.id),
  );
}
