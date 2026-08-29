import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { DomainError, ErrorCode } from "../../domain/errors.js";
import { assertUuid } from "../../domain/identity.js";
import { loadPackWorkingSet } from "../../infrastructure/persistence/read.js";
import { prepareGraphAdditions } from "./prepare.js";
import { allocateKnowledgeObjectIds } from "../../infrastructure/persistence/id-allocation.js";
import { snakeCaseKeys } from "../../wire/envelope.js";
import { assignedIdsFrom, payloadIdentity } from "./payload-identity.js";
import type {
  AssignedId,
  CandidateObjectWrite,
  CandidatePayload,
  CandidateRecord,
  CandidateTriageResult,
  CreateCandidateInput,
  JsonObject,
  KnowledgeObjectWrite,
  RelationWrite,
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

/** `code` is required: a caller that cannot tell "not found" from "not pending" cannot act on either. */
function fail(message: string, code: string): never {
  throw new DomainError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePayload(value: unknown, candidateId: string): CandidatePayload {
  if (!isRecord(value) || !Array.isArray(value.objects) || value.objects.length === 0) {
    fail(`candidate ${candidateId} has an invalid payload`, ErrorCode.INVALID_PAYLOAD);
  }
  const objects = value.objects as CandidateObjectWrite[];
  if (
    objects.some(
      (object) =>
        !isRecord(object) ||
        (typeof object.localId !== "string" && typeof object.id !== "string") ||
        typeof object.type !== "string" ||
        typeof object.scopeId !== "string" ||
        typeof object.title !== "string" ||
        typeof object.body !== "string" ||
        !isRecord(object.attributes) ||
        typeof object.authoredBy !== "string",
    )
  ) {
    fail(`candidate ${candidateId} has an invalid object payload`, ErrorCode.INVALID_PAYLOAD);
  }
  const relations = value.relations;
  if (relations !== undefined && !Array.isArray(relations)) {
    fail(`candidate ${candidateId} has an invalid relation payload`, ErrorCode.INVALID_PAYLOAD);
  }
  return {
    objects,
    relations: (relations ?? []) as CandidatePayload["relations"],
  };
}

function payloadFromInput(input: CreateCandidateInput): CandidatePayload {
  if (input.payload !== undefined && input.elements !== undefined) {
    fail("candidate input must use payload or elements, not both", ErrorCode.INVALID_PAYLOAD);
  }
  if (input.payload !== undefined) {
    return parsePayload(input.payload, input.id ?? "new");
  }
  const elements = input.elements ?? [];
  if (elements.length === 0) {
    fail("candidate input requires at least one element", ErrorCode.INVALID_PAYLOAD);
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
  // Every candidate operation reaches the driver through here, so one check
  // covers accept, edit, merge, reject, expire and payload.
  assertUuid(candidateId, "candidate id");
  const selected = await client.query<CandidateDbRow>(
    `SELECT id, proposed_type, payload, parent_id, source_ref, proposed_by,
            status, resolution, created_at, resolved_at
     FROM candidates
     WHERE id = $1::uuid`,
    [candidateId],
  );
  const candidate = selected.rows[0];
  if (candidate === undefined) {
    fail(`candidate ${candidateId} does not exist`, ErrorCode.CANDIDATE_NOT_FOUND);
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

/**
 * Lists candidate rows, filtered by status or unfiltered when `statuses` is
 * omitted.
 *
 * Resolved rows are not history that can be discarded: the table refuses
 * deletion, so a rejected candidate stays there forever, and until this
 * existed nothing could read one back. A caller that only ever saw the pending
 * rows could not show a curator what they had already turned down.
 */
export async function listCandidates(
  client: Client,
  statuses?: readonly CandidateRecord["status"][],
): Promise<readonly CandidateRecord[]> {
  const columns = `id, proposed_type, payload, parent_id, source_ref, proposed_by,
            status, resolution, created_at, resolved_at`;
  const result =
    statuses === undefined
      ? await client.query<CandidateDbRow>(
          `SELECT ${columns} FROM candidates ORDER BY created_at, id`,
        )
      : await client.query<CandidateDbRow>(
          `SELECT ${columns}
           FROM candidates
           WHERE status = ANY($1::candidate_status[])
           ORDER BY created_at, id`,
          [statuses],
        );
  return result.rows.map(rowToCandidate);
}

export async function listPendingCandidates(client: Client): Promise<readonly CandidateRecord[]> {
  return listCandidates(client, ["pending"]);
}

/**
 * The message names the status it found and where to see such rows, because
 * the failure a curator actually hits is asking about a candidate they already
 * resolved and being told only that it is not pending.
 */
function assertPending(candidate: CandidateRecord): void {
  if (candidate.status !== "pending") {
    fail(
      `candidate ${candidate.id} is ${candidate.status}, not pending. Only a pending candidate ` +
        `can be accepted, edited, merged or rejected; pke triage --status ${candidate.status} ` +
        `lists the resolved ones.`,
      ErrorCode.CANDIDATE_NOT_PENDING,
    );
  }
}

/**
 * Resolves which elements of a candidate group an operation applies to. Every
 * curator operation that takes a selection routes through here, so `accept`,
 * `edit`, `merge` and `payload` cannot drift into disagreeing about what
 * omitting `--elements` means.
 *
 * With no selection, naming the group root applies to every pending member and
 * naming a child applies to that child alone.
 */
export function selectCandidateElements(
  group: readonly CandidateRecord[],
  requestedId: string,
  selectedElementIds: readonly string[] | undefined,
): readonly CandidateRecord[] {
  const root = group.find((candidate) => candidate.parentId === null);
  const requested =
    selectedElementIds ??
    (root?.id === requestedId
      ? group.filter((candidate) => candidate.status === "pending").map((candidate) => candidate.id)
      : [requestedId]);
  const uniqueIds = [...new Set(requested)];
  if (uniqueIds.length === 0) {
    fail(
      "candidate group has no pending elements. With no --elements, pke triage accept|edit <id> " +
        "applies to every pending member of the group; pass --elements <candidate-id>... to " +
        "choose a subset. A group whose elements are all resolved is read with " +
        "pke triage --status <accepted|rejected|expired|all>, not here.",
      ErrorCode.CANDIDATE_SELECTION_INVALID,
    );
  }
  const byId = new Map(group.map((candidate) => [candidate.id, candidate]));
  const selected = uniqueIds.map((id) => {
    const candidate = byId.get(id);
    if (candidate === undefined) {
      fail(
        `candidate ${id} is not an element of this candidate group`,
        ErrorCode.CANDIDATE_NOT_IN_GROUP,
      );
    }
    assertPending(candidate);
    return candidate;
  });
  return selected;
}

/**
 * Collects the objects of the selected elements and the relations of the whole
 * group that those objects can still carry. Relations are matched by payload
 * identity, so a relation naming an element accepted earlier survives: the
 * local handle is rewritten to the id that acceptance assigned.
 */
export function aggregateCandidatePayload(
  group: readonly CandidateRecord[],
  selectedIds: readonly string[],
): CandidatePayload {
  const selection = new Set(selectedIds);
  const selected = group.filter((candidate) => selection.has(candidate.id));
  const selectedIdentities = new Set(
    selected.flatMap((candidate) => candidate.payload.objects.map(payloadIdentity)),
  );
  const groupObjectStatus = new Map(
    group.flatMap((candidate) =>
      candidate.payload.objects.map(
        (object) => [payloadIdentity(object), candidate.status] as const,
      ),
    ),
  );
  const objects = selected.flatMap((candidate) => candidate.payload.objects);
  const relationKeys = new Set<string>();
  const relations = group
    .flatMap((candidate) => candidate.payload.relations ?? [])
    .filter((relation) => {
      if (!selectedIdentities.has(relation.sourceId)) {
        return false;
      }
      const targetStatus = groupObjectStatus.get(relation.targetId);
      if (
        relation.targetKind === "knowledge_object" &&
        targetStatus !== undefined &&
        !selectedIdentities.has(relation.targetId) &&
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

/**
 * Compared on content, not spelling. Attributes are accepted in either casing,
 * so a payload handed out as snake_case and submitted back unaltered must not
 * read as a curator edit: that would record AI-authored text as human-authored,
 * and authorship is immutable once approved.
 */
function sameAttributes(before: JsonObject, after: JsonObject): boolean {
  return JSON.stringify(snakeCaseKeys(before)) === JSON.stringify(snakeCaseKeys(after));
}

function contentChanged(before: CandidateObjectWrite, after: CandidateObjectWrite): boolean {
  return (
    before.title !== after.title ||
    before.body !== after.body ||
    !sameAttributes(before.attributes, after.attributes)
  );
}

function applyEditAuthorship(
  original: CandidatePayload,
  edited: CandidatePayload,
): CandidatePayload {
  const originalById = new Map(original.objects.map((object) => [payloadIdentity(object), object]));
  return {
    objects: edited.objects.map((object) => {
      const previous = originalById.get(payloadIdentity(object));
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

/**
 * A curator may edit an element's content, not its identity. A local id names
 * nothing durable and is what this payload's relations resolve against, so
 * renaming one would silently detach the edges pointing at it.
 */
function assertEditedPayload(original: CandidatePayload, edited: CandidatePayload): void {
  if (edited.objects.length !== original.objects.length) {
    fail("candidate edits must keep the selected element count", ErrorCode.CANDIDATE_EDIT_INVALID);
  }
  const originalById = new Map(original.objects.map((object) => [payloadIdentity(object), object]));
  for (const object of edited.objects) {
    const previous = originalById.get(payloadIdentity(object));
    if (previous === undefined || previous.type !== object.type) {
      fail(
        "candidate edits must keep each selected element id and type",
        ErrorCode.CANDIDATE_EDIT_INVALID,
      );
    }
    if (object.id !== previous.id || object.localId !== previous.localId) {
      fail(
        "candidate edits must not change an element's local_id or id",
        ErrorCode.CANDIDATE_EDIT_INVALID,
      );
    }
  }
}

type AssignedIdentities = {
  readonly objects: readonly KnowledgeObjectWrite[];
  readonly relations: readonly RelationWrite[];
  readonly assigned: readonly AssignedId[];
};

/**
 * Turns payload identities into graph ids. Objects that already carry one keep
 * it; the rest are allocated per type inside the curation transaction. Every
 * endpoint that names a local handle — relations, and supersession targets — is
 * rewritten through the same map, which also carries what earlier acceptances
 * in this group assigned. Anything not in the map is already a graph id and
 * passes through, which local ids cannot be mistaken for: the wire schema
 * refuses a local id shaped like one.
 */
async function assignGraphIds(
  client: Client,
  objects: readonly CandidateObjectWrite[],
  relations: readonly RelationWrite[],
  inherited: readonly AssignedId[],
): Promise<AssignedIdentities> {
  const pending = objects.filter((object) => object.id === undefined);
  const byType = new Map<KnowledgeObjectWrite["type"], CandidateObjectWrite[]>();
  for (const object of pending) {
    const bucket = byType.get(object.type);
    if (bucket === undefined) byType.set(object.type, [object]);
    else bucket.push(object);
  }
  const assigned = new Map(inherited.map((entry) => [entry.localId, entry.id]));
  const fresh: AssignedId[] = [];
  for (const [type, bucket] of byType) {
    const ids = await allocateKnowledgeObjectIds(client, type, bucket.length);
    bucket.forEach((object, index) => {
      const localId = payloadIdentity(object);
      const id = ids[index] as string;
      assigned.set(localId, id);
      fresh.push({ localId, id });
    });
  }
  const resolve = (identity: string): string => assigned.get(identity) ?? identity;
  return {
    objects: objects.map((object) => {
      const rest: Record<string, unknown> = { ...object };
      delete rest.localId;
      return {
        ...rest,
        id: resolve(payloadIdentity(object)),
        ...(object.supersedesId === null || object.supersedesId === undefined
          ? {}
          : { supersedesId: resolve(object.supersedesId) }),
      } as KnowledgeObjectWrite;
    }),
    relations: relations.map((relation) => ({
      ...relation,
      sourceId: resolve(relation.sourceId),
      targetId:
        relation.targetKind === "knowledge_object" ? resolve(relation.targetId) : relation.targetId,
    })),
    assigned: fresh,
  };
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
    fail("candidate group changed before triage completed", ErrorCode.CANDIDATE_CONFLICT);
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
  const selected = selectCandidateElements(group, candidateId, acceptedElementIds);
  const original = aggregateCandidatePayload(
    group,
    selected.map((candidate) => candidate.id),
  );
  let payload = editedPayload ?? original;
  if (action === "edit_and_accept") {
    assertEditedPayload(original, payload);
    payload = applyEditAuthorship(original, payload);
  }
  if (payload.objects.length === 0) {
    fail("candidate acceptance requires an object", ErrorCode.CANDIDATE_SELECTION_INVALID);
  }

  const targetId = mergeTargetId;
  if (action === "merge" && targetId === undefined) {
    fail("merge requires a target object", ErrorCode.CANDIDATE_SELECTION_INVALID);
  }
  if (action === "merge" && payload.objects.length !== 1) {
    fail(
      `merge applies to a single element, but this selection has ${String(payload.objects.length)}. ` +
        `Pass --elements <candidate-id> to name the one to merge into ${String(targetId)}.`,
      ErrorCode.CANDIDATE_SELECTION_INVALID,
    );
  }
  const sourceRef = selected.find((candidate) => candidate.sourceRef !== null)?.sourceRef ?? null;
  const objectsWithoutSource =
    action === "merge"
      ? [{ ...(payload.objects[0] as CandidateObjectWrite), supersedesId: targetId }]
      : payload.objects;
  const proposedObjects = objectsWithoutSource.map((object) =>
    object.sourceRef === undefined ? { ...object, sourceRef } : object,
  );
  const inherited = group.flatMap((candidate) => assignedIdsFrom(candidate.resolution));

  const result = await curationTransaction(
    client,
    { action: `candidate.${action}`, actor: "curator" },
    async (transaction) => {
      const candidateAuthoredBy = selected[0]?.proposedBy ?? "ai";
      const identified = await assignGraphIds(
        transaction.client,
        proposedObjects,
        payload.relations ?? [],
        inherited,
      );
      const objects = identified.objects;
      const autoSupersedes = new Set(
        objects
          .filter((object) => object.supersedesId !== null && object.supersedesId !== undefined)
          .map((object) => `${object.id}\0${object.supersedesId}`),
      );
      const relations = identified.relations.filter(
        (relation) =>
          !(
            relation.relation === "supersedes" &&
            autoSupersedes.has(`${relation.sourceId}\0${relation.targetId}`)
          ),
      );
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
      const supersessions = objects
        .filter((object) => object.supersedesId !== null && object.supersedesId !== undefined)
        .map((object) => ({
          predecessorId: object.supersedesId as string,
          successorId: object.id,
        }));
      const set = await loadPackWorkingSet(transaction.client);
      const prepared = prepareGraphAdditions(
        set,
        transaction.version,
        objects,
        relations,
        supersessions,
      );
      for (const object of prepared.objects) {
        const authoredBy = action === "edit_and_accept" ? object.authoredBy : candidateAuthoredBy;
        await transaction.insertObject(object, authoredBy);
      }
      for (const relation of prepared.relations) {
        await transaction.insertRelation(relation);
      }
      for (const pair of supersessions) {
        await transaction.supersede(pair.predecessorId, pair.successorId);
      }
      await markResolved(
        transaction.client,
        selected.map((candidate) => candidate.id),
        "accepted",
        {
          action,
          graphVersion: transaction.version,
          objectIds: objects.map((object) => object.id),
          assignedIds: identified.assigned,
        },
        new Date(),
      );
      return {
        candidateIds: selected.map((candidate) => candidate.id),
        objectIds: objects.map((object) => object.id),
        assignedIds: identified.assigned,
      };
    },
  );
  return {
    action,
    candidateIds: result.value.candidateIds,
    objectIds: result.value.objectIds,
    assignedIds: result.value.assignedIds,
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
    fail(
      "candidate edits must keep the candidate's proposed type",
      ErrorCode.CANDIDATE_EDIT_INVALID,
    );
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
      fail("candidate group changed before edit completed", ErrorCode.CANDIDATE_CONFLICT);
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
  selectedElementIds?: readonly string[],
): Promise<CandidateTriageResult> {
  return acceptGroup(client, candidateId, "merge", undefined, targetId, selectedElementIds);
}

export async function rejectCandidate(
  client: Client,
  candidateId: string,
): Promise<readonly string[]> {
  const group = await loadCandidateGroup(client, candidateId);
  const candidate = group.find((item) => item.id === candidateId);
  if (candidate === undefined) {
    fail(`candidate ${candidateId} does not exist`, ErrorCode.CANDIDATE_NOT_FOUND);
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
    fail(`candidate ${candidateId} does not exist`, ErrorCode.CANDIDATE_NOT_FOUND);
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
    fail(`candidate ${candidateId} does not exist`, ErrorCode.CANDIDATE_NOT_FOUND);
  }
  return candidate;
}
