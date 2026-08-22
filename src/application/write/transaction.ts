import type { Client } from "pg";
import { DomainError, ErrorCode } from "../../domain/errors.js";
import { knowledgeClassOf } from "../../domain/entity/class.js";
import { isStatusTerminal } from "../../domain/state-machine/transitions.js";
import type {
  AuthoredBy,
  KnowledgeObject,
  KnowledgeObjectType,
} from "../../domain/entity/types.js";
import type { RelationRepointWrite, RelationWrite } from "./types.js";
import type {
  CurationResult,
  CurationTransactionOptions,
  CurationWork,
  ExternalReferenceWrite,
  FeatureLabelAssignment,
  FeatureLabelAliasWrite,
  FeatureLabelWrite,
  KnowledgeObjectWrite,
  ScopeWrite,
} from "./types.js";

const INITIAL_STATUS: { readonly [K in KnowledgeObjectType]: KnowledgeObject["status"] } = {
  requirement: "active",
  discussion: "recorded",
  observation: "observed",
  hypothesis: "explored",
  decision: "active",
  open_question: "open",
  constraint: "active",
  glossary_entry: "active",
  artifact: "current",
};

type CurationMode = "live" | "backfill";

function fail(code: string, message: string): never {
  throw new DomainError(code, message);
}

function originMarker(object: KnowledgeObjectWrite): unknown {
  return object.attributes.origin;
}

function assertOriginMode(object: KnowledgeObjectWrite, mode: CurationMode): void {
  const origin = originMarker(object);
  if (origin === undefined) {
    return;
  }
  if (object.type !== "decision" || origin !== "unrecoverable") {
    fail(ErrorCode.INVALID_ORIGIN_MARKER, `${object.id} has an invalid origin marker`);
  }
  if (mode !== "backfill") {
    fail(ErrorCode.BACKFILL_ORIGIN_FORBIDDEN, `${object.id} uses a backfill-only origin marker`);
  }
}

function isHistoricalInitialStatus(object: KnowledgeObjectWrite): boolean {
  return (
    (object.type === "hypothesis" && object.status === "rejected") ||
    (object.type === "decision" && object.status === "superseded") ||
    (object.type === "open_question" && object.status === "resolved")
  );
}

function assertInitialStatus(object: KnowledgeObjectWrite, mode: CurationMode): void {
  assertOriginMode(object, mode);
  if (mode === "backfill" && isHistoricalInitialStatus(object)) {
    return;
  }
  if (object.status !== INITIAL_STATUS[object.type]) {
    fail(
      ErrorCode.ILLEGAL_TRANSITION,
      `${object.type} must be inserted in its initial status ${INITIAL_STATUS[object.type]}`,
    );
  }
}

function isRawType(type: KnowledgeObjectType): boolean {
  return knowledgeClassOf(type) === "raw";
}

function canTransition(
  type: KnowledgeObjectType,
  current: KnowledgeObject["status"],
  next: KnowledgeObject["status"],
): boolean {
  if (next === "superseded") {
    return false;
  }
  if (next === "retracted") {
    return current !== "retracted" && !isStatusTerminal(type, current);
  }
  switch (type) {
    case "requirement":
      return current === "active" && next === "withdrawn";
    case "discussion":
      return current === "recorded" && (next === "distilled" || next === "archived");
    case "observation":
      return (
        current === "observed" &&
        (next === "promoted_to_question" ||
          next === "promoted_to_hypothesis" ||
          next === "absorbed" ||
          next === "stale")
      );
    case "hypothesis":
      return (
        (current === "explored" && next === "rejected") ||
        (current === "rejected" && next === "revived")
      );
    case "decision":
      return current === "active" && next === "reverted";
    case "open_question":
      return current === "open" && (next === "resolved" || next === "obsolete");
    case "constraint":
      return current === "active" && next === "lifted";
    case "glossary_entry":
      return current === "active" && next === "deprecated";
    case "artifact":
      return false;
  }
}

function addIdentity(identities: Set<string>, identity: string): void {
  if (identity !== "") {
    identities.add(identity);
  }
}

function addRelationIdentity(identities: Set<string>, relationId: string): void {
  addIdentity(identities, `REL-${relationId}`);
}

async function allocateVersion(
  client: Client,
  options: CurationTransactionOptions,
  mode: CurationMode,
): Promise<number> {
  /*
   * Validity columns have immediate FKs to graph_versions. Insert the
   * transaction's invisible-to-other-sessions row first, then finalize its
   * object_ids after all writes succeed. A rollback removes the row while the
   * sequence gap remains harmless.
   */
  const result = await client.query<{ version: string }>(
    `INSERT INTO graph_versions (action, actor, backfill_mode, object_ids)
     VALUES ($1, $2, $3, ARRAY[]::text[])
     RETURNING version`,
    [options.action, options.actor ?? "curator", mode === "backfill"],
  );
  return Number(result.rows[0]?.version);
}

async function insertObject(
  client: Client,
  version: number,
  object: KnowledgeObjectWrite,
  authoredBy: AuthoredBy | undefined,
  mode: CurationMode,
): Promise<void> {
  assertInitialStatus(object, mode);
  const raw = isRawType(object.type);
  const approvedAt = raw ? null : new Date();
  const lastVerifiedAt = raw ? null : approvedAt;

  await client.query(
    `INSERT INTO knowledge_objects (
       id,
       type,
       scope_id,
       feature_label_ids,
       title,
       body,
       status,
       attributes,
       authored_by,
       source_ref,
       approved_at,
       last_verified_at,
       supersedes_id,
       superseded_by_id,
       valid_from_version
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10,
       $11, $12, $13, $14, $15
     )`,
    [
      object.id,
      object.type,
      object.scopeId,
      object.featureLabelIds ?? [],
      object.title,
      object.body,
      object.status,
      JSON.stringify(object.attributes) ?? "{}",
      authoredBy ?? object.authoredBy,
      object.sourceRef ?? null,
      approvedAt,
      lastVerifiedAt,
      object.supersedesId ?? null,
      object.supersededById ?? null,
      version,
    ],
  );
}

async function insertFeatureLabel(
  client: Client,
  version: number,
  label: FeatureLabelWrite,
): Promise<void> {
  await client.query(
    `INSERT INTO feature_labels (
       id, project_scope_id, canonical_name, status, redirects_to_id, valid_from_version
     ) VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      label.id,
      label.projectScopeId,
      label.canonicalName,
      label.status ?? "active",
      label.redirectsToId ?? null,
      version,
    ],
  );
  for (const alias of label.aliases ?? []) {
    await insertFeatureLabelAlias(client, version, {
      labelId: label.id,
      projectScopeId: label.projectScopeId,
      alias,
    });
  }
}

async function insertFeatureLabelAlias(
  client: Client,
  version: number,
  alias: FeatureLabelAliasWrite,
): Promise<void> {
  await client.query(
    `INSERT INTO feature_label_aliases (
       label_id, alias, project_scope_id, valid_from_version
     ) VALUES ($1, $2, $3, $4)`,
    [alias.labelId, alias.alias, alias.projectScopeId, version],
  );
}

async function insertScope(client: Client, scope: ScopeWrite): Promise<void> {
  await client.query(
    `INSERT INTO scopes (id, kind, parent_id, name)
     VALUES ($1, $2, $3, $4)`,
    [scope.id, scope.kind, scope.parentId, scope.name],
  );
}

async function insertExternalReference(
  client: Client,
  reference: ExternalReferenceWrite,
): Promise<void> {
  await client.query(
    `INSERT INTO external_references (
       id, system, identifier, location, symbol, last_verified_at
     ) VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      reference.id,
      reference.system,
      reference.identifier,
      reference.location ?? null,
      reference.symbol ?? null,
      reference.lastVerifiedAt ?? null,
    ],
  );
}

async function relabelObjectInTransaction(
  client: Client,
  version: number,
  objectId: string,
  featureLabelIds: readonly string[],
): Promise<void> {
  const object = await client.query<{ scope_id: string }>(
    `SELECT scope_id
     FROM knowledge_objects
     WHERE id = $1
       AND valid_to_version IS NULL
     FOR UPDATE`,
    [objectId],
  );
  const row = object.rows[0];
  if (row === undefined) {
    fail(ErrorCode.ILLEGAL_TRANSITION, `${objectId} is not an active knowledge object`);
  }

  const ids = [...new Set(featureLabelIds)].sort((left, right) => left.localeCompare(right));
  if (ids.length > 0) {
    const labels = await client.query<{ id: string }>(
      `SELECT f.id
       FROM feature_labels f
       INNER JOIN scopes object_scope ON object_scope.id = $1
       INNER JOIN scopes project_scope
         ON project_scope.id = f.project_scope_id
        AND project_scope.kind = 'project'
       WHERE f.id = ANY($2::text[])
         AND f.valid_from_version <= $3
         AND (f.valid_to_version IS NULL OR f.valid_to_version > $3)
         AND project_scope.path @> object_scope.path`,
      [row.scope_id, ids, version],
    );
    const resolved = new Set(labels.rows.map((label) => label.id));
    if (resolved.size !== ids.length) {
      const missing = ids.filter((id) => !resolved.has(id));
      fail(ErrorCode.UNKNOWN_LABEL, `${objectId} cannot use labels: ${missing.join(", ")}`);
    }
  }

  const updated = await client.query(
    `UPDATE knowledge_objects
     SET feature_label_ids = $1::text[],
         lock_version = lock_version + 1
     WHERE id = $2
       AND valid_to_version IS NULL`,
    [ids, objectId],
  );
  if (updated.rowCount !== 1) {
    fail(ErrorCode.ILLEGAL_TRANSITION, `${objectId} was changed concurrently`);
  }
}

async function insertRelation(
  client: Client,
  version: number,
  relation: RelationWrite,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO relations (
       source_id, relation, target_id, target_kind, valid_from_version
     ) VALUES ($1, $2, $3, $4, $5)
     RETURNING id::text`,
    [relation.sourceId, relation.relation, relation.targetId, relation.targetKind, version],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) {
    throw new Error("relation insert did not return an id");
  }
  return id;
}

async function closeRelationInTransaction(
  client: Client,
  version: number,
  sourceId: string,
  relation: RelationWrite["relation"],
  targetId: string,
  identities: Set<string>,
): Promise<void> {
  const existing = await client.query<{ id: string }>(
    `SELECT id::text
     FROM relations
     WHERE source_id = $1
       AND relation = $2
       AND target_id = $3
       AND valid_to_version IS NULL
     FOR UPDATE`,
    [sourceId, relation, targetId],
  );
  const edge = existing.rows[0];
  if (edge === undefined) {
    fail(
      ErrorCode.ILLEGAL_TRANSITION,
      `open relation not found: ${sourceId} ${relation} ${targetId}`,
    );
  }
  const updated = await client.query(
    `UPDATE relations
     SET valid_to_version = $1
     WHERE id = $2
       AND valid_to_version IS NULL`,
    [version, edge.id],
  );
  if (updated.rowCount !== 1) {
    fail(ErrorCode.ILLEGAL_TRANSITION, `relation changed concurrently: ${edge.id}`);
  }
  addRelationIdentity(identities, edge.id);
}

async function repointRelationInTransaction(
  client: Client,
  version: number,
  sourceId: string,
  relation: RelationWrite["relation"],
  oldTargetId: string,
  newTargetId: string,
  targetKind: RelationWrite["targetKind"],
  identities: Set<string>,
): Promise<string> {
  await closeRelationInTransaction(client, version, sourceId, relation, oldTargetId, identities);
  const replacement = await insertRelation(client, version, {
    sourceId,
    relation,
    targetId: newTargetId,
    targetKind,
  });
  addRelationIdentity(identities, replacement);
  return replacement;
}

async function migrateDecisionBlocks(
  client: Client,
  version: number,
  predecessorId: string,
  successorId: string,
  identities: Set<string>,
): Promise<void> {
  const oldEdges = await client.query<{
    id: string;
    source_id: string;
    target_kind: "knowledge_object" | "external_reference";
  }>(
    `SELECT id::text, source_id, target_kind
     FROM relations
     WHERE relation = 'blocks'
       AND target_id = $1
       AND valid_to_version IS NULL
     ORDER BY id`,
    [predecessorId],
  );

  for (const edge of oldEdges.rows) {
    await client.query(
      `UPDATE relations
       SET valid_to_version = $1
       WHERE id = $2`,
      [version, edge.id],
    );
    addRelationIdentity(identities, edge.id);

    const replacement = await insertRelation(client, version, {
      sourceId: edge.source_id,
      relation: "blocks",
      targetId: successorId,
      targetKind: edge.target_kind,
    });
    addRelationIdentity(identities, replacement);
  }
}

async function flagDecisionDependents(
  client: Client,
  decisionId: string,
  identities: Set<string>,
): Promise<void> {
  const dependents = await client.query<{ id: string }>(
    `UPDATE knowledge_objects c
     SET review_required = true,
         lock_version = c.lock_version + 1
     FROM relations r
     WHERE r.source_id = c.id
       AND r.target_id = $1
       AND r.relation = 'derives_from'
       AND r.valid_to_version IS NULL
       AND c.type = 'constraint'
       AND c.status = 'active'
     RETURNING c.id`,
    [decisionId],
  );
  for (const dependent of dependents.rows) {
    addIdentity(identities, dependent.id);
  }
}

async function flagRetractionDependents(
  client: Client,
  retractedId: string,
  retractedType: KnowledgeObjectType,
  identities: Set<string>,
): Promise<void> {
  const derivedDecisions = await client.query<{ id: string }>(
    `UPDATE knowledge_objects d
     SET review_required = true,
         lock_version = d.lock_version + 1
     FROM relations r
     WHERE r.source_id = d.id
       AND r.target_id = $1
       AND r.relation = 'derives_from'
       AND r.valid_to_version IS NULL
       AND d.type = 'decision'
       AND d.status = 'active'
     RETURNING d.id`,
    [retractedId],
  );
  for (const dependent of derivedDecisions.rows) {
    addIdentity(identities, dependent.id);
  }
  if (retractedType === "decision") {
    await flagDecisionDependents(client, retractedId, identities);
  }
}

async function supersede(
  client: Client,
  version: number,
  predecessorId: string,
  successorId: string,
  identities: Set<string>,
): Promise<void> {
  const predecessor = await client.query<{
    id: string;
    type: KnowledgeObjectType;
    status: KnowledgeObject["status"];
    superseded_by_id: string | null;
  }>(
    `SELECT id, type, status, superseded_by_id
     FROM knowledge_objects
     WHERE id = $1
     FOR UPDATE`,
    [predecessorId],
  );
  const old = predecessor.rows[0];
  const supersedable =
    old?.status === "active" || (old?.type === "artifact" && old.status === "current");
  if (
    old === undefined ||
    !supersedable ||
    (old.superseded_by_id !== null && old.superseded_by_id !== successorId)
  ) {
    fail(ErrorCode.SUPERSESSION_CONFLICT, `${predecessorId} cannot be superseded`);
  }

  const successor = await client.query<{
    type: KnowledgeObjectType;
    supersedes_id: string | null;
  }>(
    `SELECT type, supersedes_id
     FROM knowledge_objects
     WHERE id = $1`,
    [successorId],
  );
  const next = successor.rows[0];
  if (next === undefined || next.type !== old.type || next.supersedes_id !== predecessorId) {
    fail(ErrorCode.SUPERSESSION_CONFLICT, `${successorId} is not a successor of ${predecessorId}`);
  }

  const update = await client.query(
    `UPDATE knowledge_objects
     SET status = 'superseded',
         superseded_by_id = $1,
         valid_to_version = $2,
         lock_version = lock_version + 1
     WHERE id = $3
       AND valid_to_version IS NULL`,
    [successorId, version, predecessorId],
  );
  if (update.rowCount !== 1) {
    fail(ErrorCode.SUPERSESSION_CONFLICT, `${predecessorId} was changed concurrently`);
  }
  addIdentity(identities, predecessorId);

  const relationId = await insertRelation(client, version, {
    sourceId: successorId,
    relation: "supersedes",
    targetId: predecessorId,
    targetKind: "knowledge_object",
  });
  addRelationIdentity(identities, relationId);
  addIdentity(identities, successorId);

  if (old.type === "decision") {
    await flagDecisionDependents(client, predecessorId, identities);
    await migrateDecisionBlocks(client, version, predecessorId, successorId, identities);
  }
}

async function transition(
  client: Client,
  version: number,
  objectId: string,
  status: KnowledgeObject["status"],
  identities: Set<string>,
  transitionAt: Date,
): Promise<void> {
  const current = await client.query<{
    id: string;
    type: KnowledgeObjectType;
    status: KnowledgeObject["status"];
    attributes: Record<string, unknown>;
  }>(
    `SELECT id, type, status, attributes
     FROM knowledge_objects
     WHERE id = $1
     FOR UPDATE`,
    [objectId],
  );
  if (current.rows[0] === undefined) {
    fail(ErrorCode.ILLEGAL_TRANSITION, `${objectId} does not exist`);
  }
  const currentObject = current.rows[0];
  if (!canTransition(currentObject.type, currentObject.status, status)) {
    fail(
      ErrorCode.ILLEGAL_TRANSITION,
      `${currentObject.type} cannot transition ${currentObject.status} to ${status}`,
    );
  }
  let preconditionQuery: string | null = null;
  switch (`${currentObject.type}:${status}`) {
    case "discussion:distilled":
      preconditionQuery = `
        SELECT EXISTS (
          SELECT 1
          FROM relations r
          INNER JOIN knowledge_objects source ON source.id = r.source_id
          WHERE r.target_id = $1
            AND r.relation = 'derives_from'
            AND r.valid_to_version IS NULL
            AND source.knowledge_class <> 'raw'
        ) AS ok`;
      break;
    case "discussion:archived":
      preconditionQuery = `
        SELECT NOT EXISTS (
          SELECT 1
          FROM relations
          WHERE target_id = $1
            AND relation = 'derives_from'
            AND valid_to_version IS NULL
        ) AS ok`;
      break;
    case "observation:promoted_to_question":
      preconditionQuery = `
        SELECT EXISTS (
          SELECT 1
          FROM relations r
          INNER JOIN knowledge_objects source ON source.id = r.source_id
          WHERE r.target_id = $1
            AND r.relation = 'derives_from'
            AND r.valid_to_version IS NULL
            AND source.type = 'open_question'
        ) AS ok`;
      break;
    case "observation:promoted_to_hypothesis":
      preconditionQuery = `
        SELECT EXISTS (
          SELECT 1
          FROM relations r
          INNER JOIN knowledge_objects source ON source.id = r.source_id
          WHERE r.target_id = $1
            AND r.relation = 'derives_from'
            AND r.valid_to_version IS NULL
            AND source.type = 'hypothesis'
        ) AS ok`;
      break;
    case "observation:absorbed":
      preconditionQuery = `
        SELECT EXISTS (
          SELECT 1
          FROM relations r
          INNER JOIN knowledge_objects source ON source.id = r.source_id
          WHERE r.target_id = $1
            AND r.relation = 'explains'
            AND r.valid_to_version IS NULL
            AND source.type = 'decision'
        ) AS ok`;
      break;
    case "observation:stale":
      preconditionQuery = `
        SELECT COALESCE(
          attributes ->> 'review_by',
          attributes ->> 'reviewBy'
        )::timestamptz < $2 AS ok
        FROM knowledge_objects
        WHERE id = $1`;
      break;
    case "open_question:resolved":
      preconditionQuery = `
        SELECT EXISTS (
          SELECT 1
          FROM relations r
          INNER JOIN knowledge_objects source ON source.id = r.source_id
          WHERE r.target_id = $1
            AND r.relation = 'derives_from'
            AND r.valid_to_version IS NULL
            AND source.type = 'decision'
        ) AS ok`;
      break;
    default:
      break;
  }
  if (preconditionQuery !== null) {
    const precondition = await client.query<{ ok: boolean }>(
      preconditionQuery,
      currentObject.type === "observation" && status === "stale"
        ? [objectId, transitionAt]
        : [objectId],
    );
    if (precondition.rows[0]?.ok !== true) {
      fail(
        ErrorCode.ILLEGAL_TRANSITION,
        `${currentObject.type} cannot transition to ${status} without its precondition`,
      );
    }
  }

  const closeWindow = isStatusTerminal(currentObject.type, status);
  const result = await client.query(
    `UPDATE knowledge_objects
     SET status = $1,
         valid_to_version = CASE WHEN $2 THEN $3 ELSE valid_to_version END,
         lock_version = lock_version + 1
     WHERE id = $4
       AND valid_to_version IS NULL`,
    [status, closeWindow, version, objectId],
  );
  if (result.rowCount !== 1) {
    fail(ErrorCode.ILLEGAL_TRANSITION, `${objectId} is not open for transition`);
  }
  addIdentity(identities, objectId);

  if (currentObject.type === "decision" && status === "reverted") {
    await flagDecisionDependents(client, objectId, identities);
  }
  if (status === "retracted") {
    await flagRetractionDependents(client, objectId, currentObject.type, identities);
  }
}

async function runCurationTransaction<T>(
  client: Client,
  options: CurationTransactionOptions,
  work: (transaction: CurationWork) => Promise<T>,
  mode: CurationMode,
): Promise<CurationResult<T>> {
  await client.query("BEGIN");
  try {
    if (mode === "backfill") {
      await client.query(
        "SET CONSTRAINTS knowledge_objects_supersedes_id_fkey, knowledge_objects_superseded_by_id_fkey DEFERRED",
      );
    }
    const version = await allocateVersion(client, options, mode);
    const identities = new Set<string>();
    const transaction: CurationWork = {
      client,
      version,
      backfillMode: mode === "backfill",
      insertObject: async (object, authoredBy) => {
        await insertObject(client, version, object, authoredBy, mode);
        addIdentity(identities, object.id);
      },
      insertFeatureLabel: async (label) => {
        await insertFeatureLabel(client, version, label);
        addIdentity(identities, label.id);
      },
      insertFeatureLabelAlias: async (alias) => {
        await insertFeatureLabelAlias(client, version, alias);
        addIdentity(identities, alias.labelId);
      },
      relabelObject: async (objectId, featureLabelIds) => {
        await relabelObjectInTransaction(client, version, objectId, featureLabelIds);
        addIdentity(identities, objectId);
      },
      insertScope: async (scope) => {
        await insertScope(client, scope);
        addIdentity(identities, `SCP-${scope.id}`);
      },
      insertExternalReference: async (reference) => {
        await insertExternalReference(client, reference);
        addIdentity(identities, reference.id);
      },
      insertRelation: async (relation) => {
        const id = await insertRelation(client, version, relation);
        addRelationIdentity(identities, id);
        return id;
      },
      closeRelation: async (sourceId, relation, targetId) => {
        await closeRelationInTransaction(client, version, sourceId, relation, targetId, identities);
      },
      repointRelation: async (sourceId, relation, oldTargetId, newTargetId, targetKind) => {
        return repointRelationInTransaction(
          client,
          version,
          sourceId,
          relation,
          oldTargetId,
          newTargetId,
          targetKind,
          identities,
        );
      },
      supersede: async (predecessorId, successorId) => {
        await supersede(client, version, predecessorId, successorId, identities);
      },
      transition: async (objectId, status, transitionAt = new Date()) => {
        await transition(client, version, objectId, status, identities, transitionAt);
      },
      addGraphIdentity: (identity) => addIdentity(identities, identity),
    };

    const value = await work(transaction);
    if (identities.size === 0) {
      throw new Error("curation transaction produced no graph changes");
    }

    await client.query(
      `UPDATE graph_versions
       SET object_ids = $1
       WHERE version = $2`,
      [Array.from(identities).sort((a, b) => a.localeCompare(b)), version],
    );
    await client.query("COMMIT");
    return { version, value };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original invariant or database error.
    }
    throw error;
  }
}

export async function curationTransaction<T>(
  client: Client,
  options: CurationTransactionOptions,
  work: (transaction: CurationWork) => Promise<T>,
): Promise<CurationResult<T>> {
  return runCurationTransaction(client, options, work, "live");
}

export async function backfillCurationTransaction<T>(
  client: Client,
  options: CurationTransactionOptions,
  work: (transaction: CurationWork) => Promise<T>,
): Promise<CurationResult<T>> {
  return runCurationTransaction(client, options, work, "backfill");
}

export async function relabelFeatureLabels(
  client: Client,
  labels: readonly FeatureLabelWrite[],
  assignments: readonly FeatureLabelAssignment[],
): Promise<CurationResult<void>> {
  return curationTransaction(
    client,
    { action: "relabel_feature_labels", actor: "curator" },
    async (transaction) => {
      for (const label of labels) {
        await transaction.insertFeatureLabel(label);
      }
      for (const assignment of assignments) {
        await transaction.relabelObject(assignment.objectId, assignment.featureLabelIds);
      }
    },
  );
}

/**
 * Deliberate curator correction. The successor owns only the evidence edges
 * supplied by the caller; none are copied from the predecessor.
 */
export async function supersedeObject(
  client: Client,
  successor: KnowledgeObjectWrite,
  relations: readonly RelationWrite[] = [],
  repoints: readonly RelationRepointWrite[] = [],
): Promise<CurationResult<{ readonly objectId: string }>> {
  if (successor.supersedesId === null || successor.supersedesId === undefined) {
    fail(ErrorCode.SUPERSESSION_CONFLICT, "a successor must name its predecessor");
  }
  const predecessorId = successor.supersedesId;
  return curationTransaction(
    client,
    { action: `supersede.${successor.type}`, actor: "curator" },
    async (transaction) => {
      const predecessor = await transaction.client.query<{
        type: KnowledgeObjectType;
        status: KnowledgeObject["status"];
        superseded_by_id: string | null;
      }>(
        `SELECT type, status, superseded_by_id
         FROM knowledge_objects
         WHERE id = $1
         FOR UPDATE`,
        [predecessorId],
      );
      const row = predecessor.rows[0];
      const supersedable =
        row?.status === "active" || (row?.type === "artifact" && row.status === "current");
      if (row === undefined || !supersedable || row.superseded_by_id !== null) {
        fail(ErrorCode.SUPERSESSION_CONFLICT, `${predecessorId} cannot be superseded`);
      }
      await transaction.insertObject(successor);
      for (const relation of relations) {
        if (
          relation.relation === "supersedes" &&
          relation.sourceId === successor.id &&
          relation.targetId === predecessorId
        ) {
          continue;
        }
        await transaction.insertRelation(relation);
      }
      for (const edge of repoints) {
        await transaction.repointRelation(
          edge.sourceId,
          edge.relation,
          edge.oldTargetId,
          edge.newTargetId,
          edge.targetKind,
        );
      }
      await transaction.supersede(predecessorId, successor.id);
      return { objectId: successor.id };
    },
  );
}

export async function transitionObject(
  client: Client,
  objectId: string,
  status: KnowledgeObject["status"],
): Promise<CurationResult<void>> {
  return curationTransaction(
    client,
    { action: `transition.${status}`, actor: "curator" },
    async (transaction) => {
      await transaction.transition(objectId, status);
    },
  );
}

export async function closeRelation(
  client: Client,
  sourceId: string,
  relation: RelationWrite["relation"],
  targetId: string,
): Promise<CurationResult<void>> {
  return curationTransaction(
    client,
    { action: `close_relation.${relation}`, actor: "curator" },
    async (transaction) => {
      await transaction.closeRelation(sourceId, relation, targetId);
    },
  );
}

export async function repointRelation(
  client: Client,
  sourceId: string,
  relation: RelationWrite["relation"],
  oldTargetId: string,
  newTargetId: string,
  targetKind: RelationWrite["targetKind"],
): Promise<CurationResult<{ readonly relationId: string }>> {
  return curationTransaction(
    client,
    { action: `repoint_relation.${relation}`, actor: "curator" },
    async (transaction) => {
      const relationId = await transaction.repointRelation(
        sourceId,
        relation,
        oldTargetId,
        newTargetId,
        targetKind,
      );
      return { relationId };
    },
  );
}
