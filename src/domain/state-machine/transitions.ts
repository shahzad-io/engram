import { DomainError, ErrorCode } from "../errors.js";
import type { Candidate, KnowledgeObject, Observation } from "../entity/types.js";
import { isOpen, type Relation } from "../relation/legality.js";

export type KnowledgeTransition =
  | "supersede"
  | "withdraw"
  | "distil"
  | "archive"
  | "promote_question"
  | "promote_hypothesis"
  | "absorb"
  | "expire"
  | "reject"
  | "revive"
  | "revert"
  | "flag_review"
  | "verify"
  | "resolve"
  | "obsolete"
  | "lift"
  | "deprecate"
  | "retract";

export type CandidateTransition = "accept" | "edit_accept" | "merge" | "reject" | "expire";

export type TransitionContext = {
  readonly now: Date;
  readonly objects: readonly KnowledgeObject[];
  readonly relations: readonly Relation[];
  readonly successorId?: string;
};

function illegal(detail: string): never {
  throw new DomainError(ErrorCode.ILLEGAL_TRANSITION, detail);
}

function openEdgesTo(
  relations: readonly Relation[],
  targetId: string,
  verb: Relation["relation"],
): Relation[] {
  return relations.filter(
    (edge) => isOpen(edge) && edge.relation === verb && edge.targetId === targetId,
  );
}

function objectById(objects: readonly KnowledgeObject[], id: string): KnowledgeObject | undefined {
  return objects.find((object) => object.id === id);
}

function successorOf(
  object: KnowledgeObject,
  context: TransitionContext,
): KnowledgeObject | undefined {
  const successorId = context.successorId ?? object.supersededById;
  if (successorId === null || successorId === undefined) {
    return undefined;
  }
  const successor = objectById(context.objects, successorId);
  if (successor === undefined || successor.supersedesId !== object.id) {
    return undefined;
  }
  const edge = context.relations.find(
    (rel) =>
      isOpen(rel) &&
      rel.relation === "supersedes" &&
      rel.sourceId === successor.id &&
      rel.targetId === object.id,
  );
  return edge === undefined ? undefined : successor;
}

function withStatus<T extends KnowledgeObject>(object: T, status: T["status"]): T {
  return { ...object, status };
}

export function transition(
  object: KnowledgeObject,
  name: KnowledgeTransition,
  context: TransitionContext,
): KnowledgeObject {
  if (name === "retract") {
    if (isTerminal(object)) {
      illegal(`${object.type} in ${object.status} cannot be retracted`);
    }
    return withStatus(object, "retracted");
  }
  switch (object.type) {
    case "requirement":
      if (object.status !== "active") {
        illegal(`${object.type} in ${object.status} accepts no transition`);
      }
      if (name === "supersede") {
        const successor = successorOf(object, context);
        if (successor === undefined || successor.type !== "requirement") {
          illegal("supersede requires a Requirement successor with a supersedes edge");
        }
        return withStatus(object, "superseded");
      }
      if (name === "withdraw") {
        return withStatus(object, "withdrawn");
      }
      illegal(`requirement cannot ${name}`);
    case "discussion":
      if (object.status !== "recorded") {
        illegal(`${object.type} in ${object.status} accepts no transition`);
      }
      if (name === "distil") {
        const derived = openEdgesTo(context.relations, object.id, "derives_from").some((edge) => {
          const source = objectById(context.objects, edge.sourceId);
          return source !== undefined && source.knowledgeClass === "reviewed";
        });
        if (!derived) {
          illegal("distil requires a reviewed object deriving from this discussion");
        }
        return withStatus(object, "distilled");
      }
      if (name === "archive") {
        if (openEdgesTo(context.relations, object.id, "derives_from").length > 0) {
          illegal("archive requires no derives_from edges pointing at this discussion");
        }
        return withStatus(object, "archived");
      }
      illegal(`discussion cannot ${name}`);
    case "observation":
      if (object.status !== "observed") {
        illegal(`${object.type} in ${object.status} accepts no transition`);
      }
      if (name === "promote_question") {
        const ok = openEdgesTo(context.relations, object.id, "derives_from").some((edge) => {
          const source = objectById(context.objects, edge.sourceId);
          return source?.type === "open_question";
        });
        if (!ok) {
          illegal("promote_question requires an Open Question deriving from this observation");
        }
        return withStatus(object, "promoted_to_question");
      }
      if (name === "promote_hypothesis") {
        const ok = openEdgesTo(context.relations, object.id, "derives_from").some((edge) => {
          const source = objectById(context.objects, edge.sourceId);
          return source?.type === "hypothesis";
        });
        if (!ok) {
          illegal("promote_hypothesis requires a Hypothesis deriving from this observation");
        }
        return withStatus(object, "promoted_to_hypothesis");
      }
      if (name === "absorb") {
        const ok = openEdgesTo(context.relations, object.id, "explains").some((edge) => {
          const source = objectById(context.objects, edge.sourceId);
          return source?.type === "decision";
        });
        if (!ok) {
          illegal("absorb requires a Decision that explains this observation");
        }
        return withStatus(object, "absorbed");
      }
      if (name === "expire") {
        if (!pastReviewBy(object, context.now)) {
          illegal("expire requires now > review_by");
        }
        return withStatus(object, "stale");
      }
      illegal(`observation cannot ${name}`);
    case "hypothesis":
      if (name === "reject") {
        if (object.status !== "explored") {
          illegal("reject is only legal from explored");
        }
        return withStatus(object, "rejected");
      }
      if (name === "revive") {
        if (object.status !== "rejected") {
          illegal("revive is only legal from rejected");
        }
        return withStatus(object, "revived");
      }
      illegal(`hypothesis cannot ${name}`);
    case "decision":
      if (name === "flag_review") {
        if (object.status !== "active") {
          illegal("flag_review is only legal from active");
        }
        return { ...object, reviewRequired: true };
      }
      if (name === "verify") {
        if (object.status !== "active") {
          illegal("verify is only legal from active");
        }
        return { ...object, lastVerifiedAt: context.now, reviewRequired: false };
      }
      if (object.status !== "active") {
        illegal(`${object.type} in ${object.status} accepts no transition`);
      }
      if (name === "supersede") {
        const successor = successorOf(object, context);
        if (successor === undefined || successor.type !== "decision") {
          illegal("supersede requires a Decision successor with a supersedes edge");
        }
        return withStatus(object, "superseded");
      }
      if (name === "revert") {
        return withStatus(object, "reverted");
      }
      illegal(`decision cannot ${name}`);
    case "open_question":
      if (object.status !== "open") {
        illegal(`${object.type} in ${object.status} accepts no transition`);
      }
      if (name === "resolve") {
        const ok = openEdgesTo(context.relations, object.id, "derives_from").some((edge) => {
          const source = objectById(context.objects, edge.sourceId);
          return source?.type === "decision";
        });
        if (!ok) {
          illegal("resolve requires a Decision that derives_from this question");
        }
        return withStatus(object, "resolved");
      }
      if (name === "obsolete") {
        return withStatus(object, "obsolete");
      }
      illegal(`open_question cannot ${name}`);
    case "constraint":
      if (name === "verify") {
        if (object.status !== "active") {
          illegal("verify is only legal from active");
        }
        return { ...object, lastVerifiedAt: context.now, reviewRequired: false };
      }
      if (object.status !== "active") {
        illegal(`${object.type} in ${object.status} accepts no transition`);
      }
      if (name === "supersede") {
        const successor = successorOf(object, context);
        if (successor === undefined || successor.type !== "constraint") {
          illegal("supersede requires a Constraint successor with a supersedes edge");
        }
        return withStatus(object, "superseded");
      }
      if (name === "lift") {
        return withStatus(object, "lifted");
      }
      illegal(`constraint cannot ${name}`);
    case "glossary_entry":
      if (object.status !== "active") {
        illegal(`${object.type} in ${object.status} accepts no transition`);
      }
      if (name === "supersede") {
        const successor = successorOf(object, context);
        if (successor === undefined || successor.type !== "glossary_entry") {
          illegal("supersede requires a Glossary Entry successor with a supersedes edge");
        }
        return withStatus(object, "superseded");
      }
      if (name === "deprecate") {
        return withStatus(object, "deprecated");
      }
      illegal(`glossary_entry cannot ${name}`);
    case "artifact":
      if (object.status !== "current") {
        illegal(`${object.type} in ${object.status} accepts no transition`);
      }
      if (name === "supersede") {
        const successor = successorOf(object, context);
        if (successor === undefined || successor.type !== "artifact") {
          illegal("supersede requires an Artifact successor with a supersedes edge");
        }
        return withStatus(object, "superseded");
      }
      illegal(`artifact cannot ${name}`);
  }
}

function pastReviewBy(object: Observation, now: Date): boolean {
  return now.getTime() > object.attributes.reviewBy.getTime();
}

export function transitionCandidate(
  candidate: Candidate,
  name: CandidateTransition,
  now: Date,
): Candidate {
  if (candidate.status !== "pending") {
    illegal(`candidate in ${candidate.status} accepts no transition`);
  }
  switch (name) {
    case "accept":
    case "edit_accept":
    case "merge":
      return { ...candidate, status: "accepted", resolvedAt: now };
    case "reject":
      return { ...candidate, status: "rejected", resolvedAt: now };
    case "expire":
      return { ...candidate, status: "expired", resolvedAt: now };
  }
}

export function isTerminal(object: KnowledgeObject): boolean {
  if (object.status === "retracted") {
    return true;
  }
  return isStatusTerminal(object.type, object.status);
}

export function isStatusTerminal(
  type: KnowledgeObject["type"],
  status: KnowledgeObject["status"],
): boolean {
  if (status === "retracted") {
    return true;
  }
  switch (type) {
    case "requirement":
      return status === "superseded" || status === "withdrawn";
    case "discussion":
      return status === "distilled" || status === "archived";
    case "observation":
      return status !== "observed";
    case "hypothesis":
      return status === "revived";
    case "decision":
      return status === "superseded" || status === "reverted";
    case "open_question":
      return status === "resolved" || status === "obsolete";
    case "constraint":
      return status === "superseded" || status === "lifted";
    case "glossary_entry":
      return status === "superseded" || status === "deprecated";
    case "artifact":
      return status === "superseded";
  }
}

export function canRetract(object: KnowledgeObject): boolean {
  return object.status !== "retracted" && !isStatusTerminal(object.type, object.status);
}
