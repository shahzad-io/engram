import { DomainError, ErrorCode } from "../../domain/errors.js";
import { assertGraphAdditions } from "../../domain/invariant/check.js";
import type { PackWorkingSet } from "../../domain/pack/types.js";
import type { Relation } from "../../domain/relation/legality.js";
import type { KnowledgeObjectType } from "../../domain/entity/types.js";
import { materializeProposalObject } from "./materialize.js";
import type {
  KnowledgeObjectWrite,
  ProposalPayload,
  ProposalValidationResult,
} from "./types.js";

const INITIAL_STATUS: Record<KnowledgeObjectType, string> = {
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

function fail(code: string, message: string): never {
  throw new DomainError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertInitialStatus(object: KnowledgeObjectWrite): void {
  const expected = INITIAL_STATUS[object.type];
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

function assertDiscussion(discussion: KnowledgeObjectWrite): void {
  if (discussion.type !== "discussion") {
    fail(ErrorCode.ILLEGAL_TRANSITION, "discussion.resolve requires a discussion object");
  }
  assertInitialStatus(discussion);
}

function assertProposalShape(proposal: ProposalPayload): void {
  if (!Array.isArray(proposal.objects) || proposal.objects.length === 0) {
    fail(ErrorCode.PROVENANCE_REQUIRED, "proposal requires at least one object");
  }
  for (const object of proposal.objects) {
    if (!isRecord(object)) {
      fail(ErrorCode.PROVENANCE_REQUIRED, "proposal object is malformed");
    }
    const write = object as KnowledgeObjectWrite;
    if (write.type === "discussion" || write.type === "observation") {
      fail(
        ErrorCode.ILLEGAL_TRANSITION,
        `${write.id} cannot be proposed as ${write.type} through discussion.resolve`,
      );
    }
    assertInitialStatus(write);
  }
  for (const relation of proposal.relations ?? []) {
    if (
      !isRecord(relation) ||
      typeof relation.sourceId !== "string" ||
      typeof relation.targetId !== "string" ||
      typeof relation.relation !== "string"
    ) {
      fail(ErrorCode.ILLEGAL_RELATION, "proposal relation is malformed");
    }
  }
}

function assertUniqueIds(
  set: PackWorkingSet,
  discussion: KnowledgeObjectWrite,
  proposal: ProposalPayload,
): void {
  const existing = new Set(set.objects.map((object) => object.id));
  const proposed = new Set<string>();
  for (const id of [discussion.id, ...proposal.objects.map((object) => object.id)]) {
    if (existing.has(id)) {
      fail(ErrorCode.IMMUTABLE_AFTER_APPROVAL, `${id} already exists in the graph`);
    }
    if (proposed.has(id)) {
      fail(ErrorCode.PROVENANCE_REQUIRED, `${id} appears more than once in the submission`);
    }
    proposed.add(id);
  }
}

function assertRelationEndpoints(
  discussion: KnowledgeObjectWrite,
  proposal: ProposalPayload,
  set: PackWorkingSet,
): void {
  const known = new Set([
    ...set.objects.map((object) => object.id),
    discussion.id,
    ...proposal.objects.map((object) => object.id),
  ]);
  for (const relation of proposal.relations ?? []) {
    if (!known.has(relation.sourceId)) {
      fail(ErrorCode.ILLEGAL_RELATION, `source ${relation.sourceId} is not in scope for this proposal`);
    }
    if (relation.targetKind === "knowledge_object" && !known.has(relation.targetId)) {
      fail(ErrorCode.ILLEGAL_RELATION, `target ${relation.targetId} is not in scope for this proposal`);
    }
  }
}

export function validateDiscussionProposal(
  set: PackWorkingSet,
  graphVersion: number,
  discussion: KnowledgeObjectWrite,
  proposal: ProposalPayload,
  now: Date = new Date(),
): ProposalValidationResult {
  assertDiscussion(discussion);
  assertProposalShape(proposal);
  assertUniqueIds(set, discussion, proposal);
  assertRelationEndpoints(discussion, proposal, set);

  const hypotheticalVersion = graphVersion + 1;
  const materializedDiscussion = materializeProposalObject(discussion, graphVersion, now);
  const materializedObjects = proposal.objects.map((object) =>
    materializeProposalObject(object, hypotheticalVersion, now),
  );
  const materializedRelations: Relation[] = (proposal.relations ?? []).map((relation, index) => ({
    id: `proposal-${index}`,
    sourceId: relation.sourceId,
    relation: relation.relation,
    targetId: relation.targetId,
    targetKind: relation.targetKind,
    createdAt: now,
    validFromVersion: hypotheticalVersion,
    validToVersion: null,
  }));

  assertGraphAdditions(set, {
    objects: [materializedDiscussion, ...materializedObjects],
    relations: materializedRelations,
    scopes: set.scopes,
    labels: set.labels,
  });

  return {
    valid: true,
    objectIds: proposal.objects.map((object) => object.id),
    relationCount: proposal.relations?.length ?? 0,
  };
}
