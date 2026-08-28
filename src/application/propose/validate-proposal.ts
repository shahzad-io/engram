import {
  AggregateDomainError,
  DomainError,
  ErrorCode,
  recordFailure,
  type DomainFailure,
} from "../../domain/errors.js";
import { collectGraphAdditionFailures } from "../../domain/invariant/check.js";
import type { PackWorkingSet } from "../../domain/pack/types.js";
import type { Relation } from "../../domain/relation/legality.js";
import { INITIAL_STATUS_BY_TYPE } from "../../domain/entity/contract.js";
import { projectKnowledgeObjectForStorage, projectRelationForStorage } from "../write/project.js";
import { materializeProposalObject } from "./materialize.js";
import type {
  KnowledgeObjectWrite,
  PreparedDiscussionProposal,
  ProposalObjectWrite,
  ProposalPayload,
  RelationWrite,
} from "./types.js";

/**
 * Inside this pass a proposed object is keyed by its local handle, so every
 * rule below — statuses, duplicates, relation endpoints, the graph invariants —
 * reads one identity field, and every failure names the handle the caller
 * wrote. The handle is dropped again when the payload is stored.
 */
type IdentifiedPayload = {
  readonly objects: readonly KnowledgeObjectWrite[];
  readonly relations?: readonly RelationWrite[];
};

function identify(proposal: ProposalPayload): IdentifiedPayload {
  return {
    objects: proposal.objects.map((object) => ({ ...object, id: object.localId })),
    relations: proposal.relations,
  };
}

function toLocal(object: KnowledgeObjectWrite): ProposalObjectWrite {
  const { id, ...rest } = object;
  return { ...rest, localId: id };
}

function fail(code: string, message: string): never {
  throw new DomainError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertInitialStatus(object: KnowledgeObjectWrite): void {
  const expected = INITIAL_STATUS_BY_TYPE[object.type];
  if (object.status !== expected) {
    fail(
      ErrorCode.ILLEGAL_TRANSITION,
      `${object.id} must use initial status ${expected} for ${object.type}`,
    );
  }
  if (object.attributes.origin === "unrecoverable") {
    fail(ErrorCode.BACKFILL_ORIGIN_FORBIDDEN, `${object.id} uses a backfill-only origin marker`);
  }
}

/**
 * A structural problem that makes the rest of the pass meaningless: the payload
 * cannot be materialised, so continuing would report failures about an object
 * the caller never described.
 */
function collectFatalShape(
  failures: DomainFailure[],
  discussion: KnowledgeObjectWrite,
  proposal: IdentifiedPayload,
): void {
  recordFailure(failures, discussion.id, () => {
    if (discussion.type !== "discussion") {
      fail(ErrorCode.ILLEGAL_TRANSITION, "discussion.resolve requires a discussion object");
    }
  });
  if (!Array.isArray(proposal.objects) || proposal.objects.length === 0) {
    failures.push({
      code: ErrorCode.PROVENANCE_REQUIRED,
      message: "proposal requires at least one object",
    });
    return;
  }
  for (const object of proposal.objects) {
    if (!isRecord(object)) {
      failures.push({
        code: ErrorCode.PROVENANCE_REQUIRED,
        message: "proposal object is malformed",
      });
      continue;
    }
    const write = object as KnowledgeObjectWrite;
    if (write.type === "discussion" || write.type === "observation") {
      failures.push({
        code: ErrorCode.ILLEGAL_TRANSITION,
        message: `${write.id} cannot be proposed as ${write.type} through discussion.resolve`,
        objectId: write.id,
      });
    }
  }
  for (const relation of proposal.relations ?? []) {
    if (
      !isRecord(relation) ||
      typeof relation.sourceId !== "string" ||
      typeof relation.targetId !== "string" ||
      typeof relation.relation !== "string"
    ) {
      failures.push({
        code: ErrorCode.ILLEGAL_RELATION,
        message: "proposal relation is malformed",
      });
    }
  }
}

function collectInitialStatuses(
  failures: DomainFailure[],
  discussion: KnowledgeObjectWrite,
  proposal: IdentifiedPayload,
): void {
  recordFailure(failures, discussion.id, () => assertInitialStatus(discussion));
  for (const object of proposal.objects) {
    recordFailure(failures, object.id, () => assertInitialStatus(object));
  }
}

function collectDuplicateIds(
  failures: DomainFailure[],
  set: PackWorkingSet,
  discussion: KnowledgeObjectWrite,
  proposal: IdentifiedPayload,
): void {
  /*
   * Proposed objects are checked against each other, not against the graph:
   * their handles are local, and the wire schema refuses one shaped like a
   * graph id, so a handle cannot collide with an approved object. The
   * discussion is still checked because it carries an allocated id.
   */
  if (set.objects.some((object) => object.id === discussion.id)) {
    failures.push({
      code: ErrorCode.IMMUTABLE_AFTER_APPROVAL,
      message: `${discussion.id} already exists in the graph`,
      objectId: discussion.id,
    });
  }
  const seen = new Set<string>();
  for (const object of proposal.objects) {
    if (seen.has(object.id)) {
      failures.push({
        code: ErrorCode.PROVENANCE_REQUIRED,
        message: `${object.id} appears more than once in the submission`,
        objectId: object.id,
      });
    }
    seen.add(object.id);
  }
}

/**
 * Relations whose endpoints are not in the submission are dropped rather than
 * carried into the graph checks, which would report the same relation twice
 * under a less actionable message. Any object left without a required origin
 * is still reported, because the edge it needed did not survive.
 */
function partitionRelations(
  failures: DomainFailure[],
  discussion: KnowledgeObjectWrite,
  proposal: IdentifiedPayload,
  set: PackWorkingSet,
): readonly RelationWrite[] {
  const known = new Set([
    ...set.objects.map((object) => object.id),
    discussion.id,
    ...proposal.objects.map((object) => object.id),
  ]);
  const usable: RelationWrite[] = [];
  for (const relation of proposal.relations ?? []) {
    let resolved = true;
    if (!known.has(relation.sourceId)) {
      failures.push({
        code: ErrorCode.ILLEGAL_RELATION,
        message: `source ${relation.sourceId} is not in scope for this proposal`,
      });
      resolved = false;
    }
    if (relation.targetKind === "knowledge_object" && !known.has(relation.targetId)) {
      failures.push({
        code: ErrorCode.ILLEGAL_RELATION,
        message: `target ${relation.targetId} is not in scope for this proposal`,
      });
      resolved = false;
    }
    if (resolved) {
      usable.push(relation);
    }
  }
  return usable;
}

export function validateDiscussionProposal(
  set: PackWorkingSet,
  graphVersion: number,
  discussion: KnowledgeObjectWrite,
  input: ProposalPayload,
  now: Date = new Date(),
): PreparedDiscussionProposal {
  const proposal = identify(input);
  const failures: DomainFailure[] = [];
  collectFatalShape(failures, discussion, proposal);
  if (failures.length > 0) {
    throw new AggregateDomainError(failures);
  }

  collectInitialStatuses(failures, discussion, proposal);
  collectDuplicateIds(failures, set, discussion, proposal);
  const usableRelations = partitionRelations(failures, discussion, proposal, set);

  const hypotheticalVersion = graphVersion + 1;
  const materializedDiscussion = materializeProposalObject(discussion, graphVersion, now);
  const materializedObjects = proposal.objects.map((object) =>
    materializeProposalObject(object, hypotheticalVersion, now),
  );
  const materializedRelations: Relation[] = usableRelations.map((relation, index) => ({
    id: `proposal-${index}`,
    sourceId: relation.sourceId,
    relation: relation.relation,
    targetId: relation.targetId,
    targetKind: relation.targetKind,
    createdAt: now,
    validFromVersion: hypotheticalVersion,
    validToVersion: null,
  }));

  failures.push(
    ...collectGraphAdditionFailures(set, {
      objects: [materializedDiscussion, ...materializedObjects],
      relations: materializedRelations,
      scopes: set.scopes,
      labels: set.labels,
    }),
  );
  if (failures.length > 0) {
    throw new AggregateDomainError(failures);
  }

  return {
    validation: {
      valid: true,
      localIds: proposal.objects.map((object) => object.id),
      relationCount: proposal.relations?.length ?? 0,
    },
    discussion: projectKnowledgeObjectForStorage(materializedDiscussion),
    proposal: {
      objects: materializedObjects.map(projectKnowledgeObjectForStorage).map(toLocal),
      relations: materializedRelations.map(projectRelationForStorage),
    },
  };
}
