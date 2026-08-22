import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { DomainError, ErrorCode } from "../../domain/errors.js";
import type {
  CandidatePayload,
  CandidateRecord,
  CandidateTriageResult,
  CreateCandidateInput,
  JsonObject,
  KnowledgeObjectWrite,
} from "./types.js";
import { curationTransaction } from "./transaction.js";

type CandidateDbRow = {
  id: string;
  proposed_type: CandidateRecord["proposedType"];
  payload: unknown;
  parent_id: string | null;
  source_ref: string | null;
  proposed_by: CandidateRecord["proposedBy"];
  status: CandidateRecord["status"];
  resolution: JsonObject | null;
  created_at: Date;
  resolved_at: Date | null;
};

type CandidateEdit = CandidatePayload;

function fail(message: string): never {
  throw new DomainError(ErrorCode.ILLEGAL_TRANSITION, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePayload(value: unknown, candidateId: string): CandidatePayload {
  if (!isRecord(value) || !Array.isArray(value.objects) || value.objects.length === 0) {
    fail(`candidate ${candidateId} has an invalid payload`);
  }
  const objects = value.objects as KnowledgeObjectWrite[];
  if (
    objects.some(
      (object) =>
        !isRecord(object) ||
        typeof object.id !== "string" ||
        typeof object.type !== "string" ||
        typeof object.scopeId !== "string" ||
        typeof object.title !== "string" ||
        typeof object.body !== "string" ||
        !isRecord(object.attributes) ||
        typeof object.authoredBy !== "string",
    )
  ) {
    fail(`candidate ${candidateId} has an invalid object payload`);
  }
  const relations = value.relations;
  if (relations !== undefined && !Array.isArray(relations)) {
    fail(`candidate ${candidateId} has an invalid relation payload`);
  }
  return {
    objects,
    relations: (relations ?? []) as CandidatePayload["relations"],
  };
}

function payloadFromInput(input: CreateCandidateInput): CandidatePayload {
  if (input.payload !== undefined && input.elements !== undefined) {
    fail("candidate input must use payload or elements, not both");
  }
  if (input.payload !== undefined) {
    return parsePayload(input.payload, input.id ?? "new");
  }
  const elements = input.elements ?? [];
  if (elements.length === 0) {
    fail("candidate input requires at least one element");
  }
  const relations = elements.flatMap((element) => element.relations ?? []);
  return {
    objects: elements.map((element) => element.object),
    relations,
  };
}

function rowToCandidate(row: CandidateDbRow): CandidateRecord {
  return {
    id: row.id,
    proposedType: row.proposed_type,
    payload: parsePayload(row.payload, row.id),
    parentId: row.parent_id,
    sourceRef: row.source_ref,
    proposedBy: row.proposed_by,
    status: row.status,
    resolution: row.resolution,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

async function beginPlainTransaction(client: Client): Promise<void> {
  await client.query("BEGIN");
}

async function rollbackQuietly(client: Client): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the operation's original error.
  }
}

async function insertCandidateRow(
  client: Client,
  id: string,
  payload: CandidatePayload,
  parentId: string | null,
  sourceRef: string | null,
  proposedBy: "human" | "ai",
): Promise<void> {
  await client.query(
    `INSERT INTO candidates (
       id, proposed_type, payload, parent_id, source_ref, proposed_by
     ) VALUES ($1::uuid, $2, $3::jsonb, $4::uuid, $5, $6)`,
    [id, payload.objects[0]?.type, JSON.stringify(payload), parentId, sourceRef, proposedBy],
  );
}

export async function createCandidate(
  client: Client,
  input: CreateCandidateInput,
): Promise<readonly string[]> {
  const proposedBy = input.proposedBy ?? "ai";
  const rawPayload = payloadFromInput(input);
  const payload: CandidatePayload = {
    ...rawPayload,
    objects: rawPayload.objects.map((object) => ({ ...object, authoredBy: proposedBy })),
  };
  const sourceRef = input.sourceRef ?? null;
  const ids = [input.id ?? randomUUID()];
  const childPayloads: CandidatePayload[] = [];

  if (payload.objects.length > 1) {
    for (const object of payload.objects.slice(1)) {
      childPayloads.push({ objects: [object], relations: [] });
      ids.push(randomUUID());
    }
  }

  await beginPlainTransaction(client);
  try {
    await insertCandidateRow(
      client,
      ids[0] as string,
      {
        objects: [payload.objects[0] as KnowledgeObjectWrite],
        relations: payload.relations,
      },
      null,
      sourceRef,
      proposedBy,
    );
    for (let index = 0; index < childPayloads.length; index += 1) {
      await insertCandidateRow(
        client,
        ids[index + 1] as string,
        childPayloads[index] as CandidatePayload,
        ids[0] as string,
        sourceRef,
        proposedBy,
      );
    }
    await client.query("COMMIT");
    return ids;
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  }
}

async function loadCandidateGroup(
  client: Client,
  candidateId: string,
): Promise<readonly CandidateRecord[]> {
  const selected = await client.query<CandidateDbRow>(
    `SELECT id, proposed_type, payload, parent_id, source_ref, proposed_by,
            status, resolution, created_at, resolved_at
     FROM candidates
     WHERE id = $1::uuid`,
    [candidateId],
  );
  const candidate = selected.rows[0];
  if (candidate === undefined) {
    fail(`candidate ${candidateId} does not exist`);
  }
  const rootId = candidate.parent_id ?? candidate.id;
  const group = await client.query<CandidateDbRow>(
    `SELECT id, proposed_type, payload, parent_id, source_ref, proposed_by,
            status, resolution, created_at, resolved_at
     FROM candidates
     WHERE id = $1::uuid OR parent_id = $1::uuid
     ORDER BY CASE WHEN id = $1::uuid THEN 0 ELSE 1 END, created_at, id`,
    [rootId],
  );
  return group.rows.map(rowToCandidate);
}

export async function getCandidateGroup(
  client: Client,
  candidateId: string,
): Promise<readonly CandidateRecord[]> {
  return loadCandidateGroup(client, candidateId);
}

export async function listPendingCandidates(client: Client): Promise<readonly CandidateRecord[]> {
  const result = await client.query<CandidateDbRow>(
    `SELECT id, proposed_type, payload, parent_id, source_ref, proposed_by,
            status, resolution, created_at, resolved_at
     FROM candidates
     WHERE status = 'pending'
     ORDER BY created_at, id`,
  );
  return result.rows.map(rowToCandidate);
}

function assertPending(candidate: CandidateRecord): void {
  if (candidate.status !== "pending") {
    fail(`candidate ${candidate.id} is no longer pending`);
  }
}

function selectCandidates(
  group: readonly CandidateRecord[],
  requestedId: string,
  acceptedElementIds: readonly string[] | undefined,
): readonly CandidateRecord[] {
  const root = group.find((candidate) => candidate.parentId === null);
  const requested =
    acceptedElementIds ??
    (root?.id === requestedId
      ? group.filter((candidate) => candidate.status === "pending").map((candidate) => candidate.id)
      : [requestedId]);
  const uniqueIds = [...new Set(requested)];
  if (uniqueIds.length === 0) {
    fail("candidate acceptance requires at least one selected element");
  }
  const byId = new Map(group.map((candidate) => [candidate.id, candidate]));
  const selected = uniqueIds.map((id) => {
    const candidate = byId.get(id);
    if (candidate === undefined) {
      fail(`candidate ${id} is not an element of this candidate group`);
    }
    assertPending(candidate);
    return candidate;
  });
  return selected;
}

function aggregatePayload(
  group: readonly CandidateRecord[],
  selected: readonly CandidateRecord[],
): CandidatePayload {
  const selectedObjectIds = new Set(
    selected.flatMap((candidate) => candidate.payload.objects.map((object) => object.id)),
  );
  const groupObjectStatus = new Map(
    group.flatMap((candidate) =>
      candidate.payload.objects.map((object) => [object.id, candidate.status] as const),
    ),
  );
  const objects = selected.flatMap((candidate) => candidate.payload.objects);
  const relationKeys = new Set<string>();
  const relations = group
    .flatMap((candidate) => candidate.payload.relations ?? [])
    .filter((relation) => {
      if (!selectedObjectIds.has(relation.sourceId)) {
        return false;
      }
      const targetStatus = groupObjectStatus.get(relation.targetId);
      if (
        relation.targetKind === "knowledge_object" &&
        targetStatus !== undefined &&
        !selectedObjectIds.has(relation.targetId) &&
        targetStatus !== "accepted"
      ) {
        return false;
      }
      const key = `${relation.sourceId}\0${relation.relation}\0${relation.targetId}`;
      if (relationKeys.has(key)) return false;
      relationKeys.add(key);
      return true;
    });
  return { objects, relations };
}

function contentChanged(before: KnowledgeObjectWrite, after: KnowledgeObjectWrite): boolean {
  return (
    before.title !== after.title ||
    before.body !== after.body ||
    JSON.stringify(before.attributes) !== JSON.stringify(after.attributes)
  );
}

function applyEditAuthorship(
  original: CandidatePayload,
  edited: CandidatePayload,
): CandidatePayload {
  const originalById = new Map(original.objects.map((object) => [object.id, object]));
  return {
    objects: edited.objects.map((object) => {
      const previous = originalById.get(object.id);
      if (previous === undefined) {
        return { ...object, authoredBy: "human" };
      }
      return {
        ...object,
        authoredBy: contentChanged(previous, object) ? "human" : previous.authoredBy,
      };
    }),
    relations: edited.relations ?? [],
  };
}

function assertEditedPayload(original: CandidatePayload, edited: CandidatePayload): void {
  if (edited.objects.length !== original.objects.length) {
    fail("candidate edits must keep the selected element count");
  }
  const originalById = new Map(original.objects.map((object) => [object.id, object]));
  for (const object of edited.objects) {
    const previous = originalById.get(object.id);
    if (previous === undefined || previous.type !== object.type) {
      fail("candidate edits must keep each selected element id and type");
    }
  }
}

async function markResolved(
  client: Client,
  ids: readonly string[],
  status: "accepted" | "rejected" | "expired",
  resolution: JsonObject,
  resolvedAt: Date,
): Promise<void> {
  const result = await client.query(
    `UPDATE candidates
     SET status = $1,
         resolution = $2::jsonb,
         resolved_at = $3
     WHERE id = ANY($4::uuid[])
       AND status = 'pending'`,
    [status, JSON.stringify(resolution), resolvedAt, ids],
  );
  if (result.rowCount !== ids.length) {
    fail("candidate group changed before triage completed");
  }
}

async function acceptGroup(
  client: Client,
  candidateId: string,
  action: "accept" | "edit_and_accept" | "merge",
  editedPayload?: CandidatePayload,
  mergeTargetId?: string,
  acceptedElementIds?: readonly string[],
): Promise<CandidateTriageResult> {
  const group = await loadCandidateGroup(client, candidateId);
  const selected = selectCandidates(group, candidateId, acceptedElementIds);
  const original = aggregatePayload(group, selected);
  let payload = editedPayload ?? original;
  if (action === "edit_and_accept") {
    assertEditedPayload(original, payload);
    payload = applyEditAuthorship(original, payload);
  }
  if (payload.objects.length === 0) {
    fail("candidate acceptance requires an object");
  }

  const targetId = mergeTargetId;
  if (action === "merge" && (targetId === undefined || payload.objects.length !== 1)) {
    fail("merge requires exactly one candidate object and a target");
  }
  const sourceRef = selected.find((candidate) => candidate.sourceRef !== null)?.sourceRef ?? null;
  const objectsWithoutSource =
    action === "merge"
      ? [{ ...(payload.objects[0] as KnowledgeObjectWrite), supersedesId: targetId }]
      : payload.objects;
  const objects = objectsWithoutSource.map((object) =>
    object.sourceRef === undefined ? { ...object, sourceRef } : object,
  );
  const autoSupersedes = new Set(
    objects
      .filter((object) => object.supersedesId !== null && object.supersedesId !== undefined)
      .map((object) => `${object.id}\0${object.supersedesId}`),
  );
  const relations = (payload.relations ?? []).filter(
    (relation) =>
      !(
        relation.relation === "supersedes" &&
        autoSupersedes.has(`${relation.sourceId}\0${relation.targetId}`)
      ),
  );

  const result = await curationTransaction(
    client,
    { action: `candidate.${action}`, actor: "curator" },
    async (transaction) => {
      const candidateAuthoredBy = selected[0]?.proposedBy ?? "ai";
      for (const object of objects) {
        if (object.supersedesId === null || object.supersedesId === undefined) {
          continue;
        }
        const predecessor = await transaction.client.query<{
          type: string;
          status: string;
          superseded_by_id: string | null;
        }>(
          `SELECT type, status, superseded_by_id
           FROM knowledge_objects
           WHERE id = $1
           FOR UPDATE`,
          [object.supersedesId],
        );
        const row = predecessor.rows[0];
        const supersedable =
          row?.status === "active" || (row?.type === "artifact" && row.status === "current");
        if (row === undefined || !supersedable || row.superseded_by_id !== null) {
          throw new DomainError(
            ErrorCode.SUPERSESSION_CONFLICT,
            `${object.supersedesId} cannot be superseded`,
          );
        }
      }
      for (const object of objects) {
        const authoredBy = action === "edit_and_accept" ? object.authoredBy : candidateAuthoredBy;
        await transaction.insertObject(object, authoredBy);
      }
      for (const relation of relations) {
        await transaction.insertRelation(relation);
      }
      for (const object of objects) {
        if (object.supersedesId !== null && object.supersedesId !== undefined) {
          await transaction.supersede(object.supersedesId, object.id);
        }
      }
      await markResolved(
        transaction.client,
        selected.map((candidate) => candidate.id),
        "accepted",
        {
          action,
          graphVersion: transaction.version,
          objectIds: objects.map((object) => object.id),
        },
        new Date(),
      );
      return {
        candidateIds: selected.map((candidate) => candidate.id),
        objectIds: objects.map((object) => object.id),
      };
    },
  );
  return {
    action,
    candidateIds: result.value.candidateIds,
    objectIds: result.value.objectIds,
    version: result.version,
  };
}

export async function acceptCandidate(
  client: Client,
  candidateId: string,
  acceptedElementIds?: readonly string[],
): Promise<CandidateTriageResult> {
  return acceptGroup(client, candidateId, "accept", undefined, undefined, acceptedElementIds);
}

export async function editAndAcceptCandidate(
  client: Client,
  candidateId: string,
  editedPayload: CandidateEdit,
  acceptedElementIds?: readonly string[],
): Promise<CandidateTriageResult> {
  return acceptGroup(
    client,
    candidateId,
    "edit_and_accept",
    editedPayload,
    undefined,
    acceptedElementIds,
  );
}

export async function editCandidate(
  client: Client,
  candidateId: string,
  editedPayload: CandidateEdit,
): Promise<void> {
  const candidate = await getCandidate(client, candidateId);
  assertPending(candidate);
  if (
    editedPayload.objects.length !== 1 ||
    editedPayload.objects[0]?.type !== candidate.proposedType
  ) {
    fail("candidate edits must keep the candidate's proposed type");
  }
  const payload = applyEditAuthorship(candidate.payload, editedPayload);
  const originalObject = candidate.payload.objects[0];
  const editedObject = payload.objects[0];
  const contentWasEdited =
    originalObject === undefined ||
    editedObject === undefined ||
    contentChanged(originalObject, editedObject);
  await beginPlainTransaction(client);
  try {
    const result = await client.query(
      `UPDATE candidates
       SET payload = $1::jsonb,
           proposed_by = CASE WHEN $2 THEN 'human'::authored_by ELSE proposed_by END
       WHERE id = $3::uuid
         AND status = 'pending'`,
      [JSON.stringify(payload), contentWasEdited, candidateId],
    );
    if (result.rowCount !== 1) {
      fail("candidate group changed before edit completed");
    }
    await client.query("COMMIT");
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  }
}

export async function mergeCandidate(
  client: Client,
  candidateId: string,
  targetId: string,
): Promise<CandidateTriageResult> {
  return acceptGroup(client, candidateId, "merge", undefined, targetId);
}

export async function rejectCandidate(
  client: Client,
  candidateId: string,
): Promise<readonly string[]> {
  const group = await loadCandidateGroup(client, candidateId);
  const candidate = group.find((item) => item.id === candidateId);
  if (candidate === undefined) {
    fail(`candidate ${candidateId} does not exist`);
  }
  assertPending(candidate);
  const ids = [candidate.id];
  await beginPlainTransaction(client);
  try {
    await markResolved(client, ids, "rejected", { action: "reject" }, new Date());
    await client.query("COMMIT");
    return ids;
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  }
}

export async function expireCandidate(
  client: Client,
  candidateId: string,
): Promise<readonly string[]> {
  const group = await loadCandidateGroup(client, candidateId);
  const candidate = group.find((item) => item.id === candidateId);
  if (candidate === undefined) {
    fail(`candidate ${candidateId} does not exist`);
  }
  assertPending(candidate);
  const ids = [candidate.id];
  await beginPlainTransaction(client);
  try {
    await markResolved(client, ids, "expired", { action: "expire" }, new Date());
    await client.query("COMMIT");
    return ids;
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  }
}

export async function getCandidate(client: Client, candidateId: string): Promise<CandidateRecord> {
  const group = await loadCandidateGroup(client, candidateId);
  const candidate = group.find((item) => item.id === candidateId);
  if (candidate === undefined) {
    fail(`candidate ${candidateId} does not exist`);
  }
  return candidate;
}
