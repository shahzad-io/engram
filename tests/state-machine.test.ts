import assert from "node:assert/strict";
import test from "node:test";
import {
  isTerminal,
  transition,
  transitionCandidate,
  type Candidate,
  type CandidateTransition,
  type KnowledgeObject,
  type KnowledgeTransition,
  type Relation,
  type TransitionContext,
} from "../dist/domain/index.js";

const NOW = new Date("2026-08-19T12:00:00.000Z");
const BEFORE_NOW = new Date("2026-08-18T12:00:00.000Z");
const AFTER_NOW = new Date("2026-08-20T12:00:00.000Z");

type KnowledgeObjectType = KnowledgeObject["type"];
type Status = KnowledgeObject["status"];

function object(
  type: KnowledgeObjectType,
  status: string,
  id: string,
  options: { reviewBy?: Date; supersedesId?: string | null; supersededById?: string | null } = {},
): KnowledgeObject {
  const raw = type === "discussion" || type === "observation";
  const knowledgeClass = raw
    ? "raw"
    : type === "constraint" || type === "glossary_entry"
      ? "operational"
      : "reviewed";
  const attributes = (() => {
    switch (type) {
      case "requirement":
        return { source: "state-machine-test", rationale: "test" };
      case "discussion":
        return { medium: "chat", occurredAt: NOW, contentRef: "test" };
      case "observation":
        return {
          observedAt: NOW,
          evidenceRef: "XRF-0001",
          reviewBy: options.reviewBy ?? AFTER_NOW,
        };
      case "hypothesis":
        return { whatWasTried: "test", whyItFailed: "test", evidenceRef: "XRF-0001" };
      case "decision":
        return {
          statement: "test",
          rationale: "test",
          reversibility: "cheap",
          alternativesRejected: [],
        };
      case "open_question":
        return { question: "test", blocking: false };
      case "constraint":
        return { rule: "test", enforcement: "hard", axiomatic: true };
      case "glossary_entry":
        return { term: id, definition: "test", axiomatic: true };
      case "artifact":
        return {
          kind: "test",
          version: "1",
          location: "test",
          contentHash: "sha256:test",
          summary: "test",
        };
    }
  })();

  return {
    id,
    type,
    knowledgeClass,
    scopeId: "global",
    featureLabelIds: [],
    title: id,
    body: "state-machine test",
    status,
    attributes,
    authoredBy: "human",
    sourceRef: null,
    createdAt: NOW,
    approvedAt: raw ? null : NOW,
    lastVerifiedAt: raw ? null : NOW,
    supersedesId: options.supersedesId ?? null,
    supersededById: options.supersededById ?? null,
    reviewRequired: false,
    validFromVersion: 1,
    validToVersion: null,
    lockVersion: 0,
  } as KnowledgeObject;
}

function relation(
  sourceId: string,
  relationName: Relation["relation"],
  targetId: string,
): Relation {
  return {
    id: `${sourceId}-${relationName}-${targetId}`,
    sourceId,
    relation: relationName,
    targetId,
    targetKind: "knowledge_object",
    createdAt: NOW,
    validFromVersion: 1,
    validToVersion: null,
  };
}

function context(
  objects: readonly KnowledgeObject[] = [],
  relations: readonly Relation[] = [],
  now = NOW,
  successorId?: string,
): TransitionContext {
  return { now, objects, relations, successorId };
}

function supersessionContext(
  predecessor: KnowledgeObject,
  successor: KnowledgeObject,
): TransitionContext {
  return context(
    [predecessor, successor],
    [relation(successor.id, "supersedes", predecessor.id)],
    NOW,
    successor.id,
  );
}

function derivedContext(source: KnowledgeObject, target: KnowledgeObject): TransitionContext {
  return context([source, target], [relation(source.id, "derives_from", target.id)]);
}

test("every legal knowledge and Candidate transition is accepted", () => {
  const requirement = object("requirement", "active", "REQ-1000");
  const requirementSuccessor = object("requirement", "active", "REQ-1001", {
    supersedesId: requirement.id,
  });
  const discussion = object("discussion", "recorded", "DSC-1000");
  const discussionDeriver = object("requirement", "active", "REQ-1002");
  const observation = object("observation", "observed", "OBS-1000");
  const expiredObservation = object("observation", "observed", "OBS-1001", {
    reviewBy: BEFORE_NOW,
  });
  const question = object("open_question", "open", "OQU-1000");
  const hypothesis = object("hypothesis", "explored", "HYP-1000");
  const decision = object("decision", "active", "DEC-1000");
  const decisionSuccessor = object("decision", "active", "DEC-1001", {
    supersedesId: decision.id,
  });
  const constraint = object("constraint", "active", "CON-1000");
  const constraintSuccessor = object("constraint", "active", "CON-1001", {
    supersedesId: constraint.id,
  });
  const glossary = object("glossary_entry", "active", "GLO-1000");
  const glossarySuccessor = object("glossary_entry", "active", "GLO-1001", {
    supersedesId: glossary.id,
  });
  const artifact = object("artifact", "current", "ART-1000");
  const artifactSuccessor = object("artifact", "current", "ART-1001", {
    supersedesId: artifact.id,
  });

  const legalCases: readonly {
    object: KnowledgeObject;
    transition: KnowledgeTransition;
    context: TransitionContext;
    expectedStatus: Status;
  }[] = [
    {
      object: requirement,
      transition: "supersede",
      context: supersessionContext(requirement, requirementSuccessor),
      expectedStatus: "superseded",
    },
    {
      object: requirement,
      transition: "withdraw",
      context: context(),
      expectedStatus: "withdrawn",
    },
    {
      object: discussion,
      transition: "distil",
      context: derivedContext(discussionDeriver, discussion),
      expectedStatus: "distilled",
    },
    { object: discussion, transition: "archive", context: context(), expectedStatus: "archived" },
    {
      object: observation,
      transition: "promote_question",
      context: derivedContext(question, observation),
      expectedStatus: "promoted_to_question",
    },
    {
      object: observation,
      transition: "promote_hypothesis",
      context: derivedContext(hypothesis, observation),
      expectedStatus: "promoted_to_hypothesis",
    },
    {
      object: observation,
      transition: "absorb",
      context: context(
        [decision, observation],
        [relation(decision.id, "explains", observation.id)],
      ),
      expectedStatus: "absorbed",
    },
    {
      object: expiredObservation,
      transition: "expire",
      context: context([], [], NOW),
      expectedStatus: "stale",
    },
    {
      object: hypothesis,
      transition: "reject",
      context: context(),
      expectedStatus: "rejected",
    },
    {
      object: object("hypothesis", "rejected", "HYP-1001"),
      transition: "revive",
      context: context(),
      expectedStatus: "revived",
    },
    {
      object: decision,
      transition: "supersede",
      context: supersessionContext(decision, decisionSuccessor),
      expectedStatus: "superseded",
    },
    { object: decision, transition: "revert", context: context(), expectedStatus: "reverted" },
    {
      object: decision,
      transition: "flag_review",
      context: context(),
      expectedStatus: "active",
    },
    { object: decision, transition: "verify", context: context(), expectedStatus: "active" },
    {
      object: question,
      transition: "resolve",
      context: derivedContext(decision, question),
      expectedStatus: "resolved",
    },
    { object: question, transition: "obsolete", context: context(), expectedStatus: "obsolete" },
    {
      object: constraint,
      transition: "supersede",
      context: supersessionContext(constraint, constraintSuccessor),
      expectedStatus: "superseded",
    },
    { object: constraint, transition: "lift", context: context(), expectedStatus: "lifted" },
    { object: constraint, transition: "verify", context: context(), expectedStatus: "active" },
    {
      object: glossary,
      transition: "supersede",
      context: supersessionContext(glossary, glossarySuccessor),
      expectedStatus: "superseded",
    },
    {
      object: glossary,
      transition: "deprecate",
      context: context(),
      expectedStatus: "deprecated",
    },
    {
      object: artifact,
      transition: "supersede",
      context: supersessionContext(artifact, artifactSuccessor),
      expectedStatus: "superseded",
    },
    {
      object: requirement,
      transition: "retract",
      context: context(),
      expectedStatus: "retracted",
    },
  ];

  for (const legalCase of legalCases) {
    const result = transition(legalCase.object, legalCase.transition, legalCase.context);
    assert.equal(result.status, legalCase.expectedStatus, legalCase.transition);
    if (legalCase.transition === "flag_review") {
      assert.equal(result.reviewRequired, true);
    }
    if (legalCase.transition === "verify") {
      assert.equal(result.reviewRequired, false);
      assert.deepEqual(result.lastVerifiedAt, NOW);
    }
  }

  const candidateResults: readonly [CandidateTransition, Candidate["status"]][] = [
    ["accept", "accepted"],
    ["edit_accept", "accepted"],
    ["merge", "accepted"],
    ["reject", "rejected"],
    ["expire", "expired"],
  ];
  for (const [name, expectedStatus] of candidateResults) {
    const candidate: Candidate = {
      id: "CAN-1000",
      proposedType: "decision",
      payload: {},
      parentId: null,
      sourceRef: null,
      proposedBy: "ai",
      status: "pending",
      resolution: null,
      createdAt: NOW,
      resolvedAt: null,
    };
    assert.equal(transitionCandidate(candidate, name, NOW).status, expectedStatus);
  }
});

test("every unlisted knowledge transition is rejected", () => {
  const allTransitions: readonly KnowledgeTransition[] = [
    "supersede",
    "withdraw",
    "distil",
    "archive",
    "promote_question",
    "promote_hypothesis",
    "absorb",
    "expire",
    "reject",
    "revive",
    "revert",
    "flag_review",
    "verify",
    "resolve",
    "obsolete",
    "lift",
    "deprecate",
    "retract",
  ];
  const states: readonly [KnowledgeObject, readonly KnowledgeTransition[]][] = [
    [object("requirement", "active", "REQ-1100"), ["supersede", "withdraw", "retract"]],
    [object("discussion", "recorded", "DSC-1100"), ["distil", "archive", "retract"]],
    [
      object("observation", "observed", "OBS-1100"),
      ["promote_question", "promote_hypothesis", "absorb", "expire", "retract"],
    ],
    [object("hypothesis", "explored", "HYP-1100"), ["reject", "retract"]],
    [object("hypothesis", "rejected", "HYP-1101"), ["revive", "retract"]],
    [
      object("decision", "active", "DEC-1100"),
      ["supersede", "revert", "flag_review", "verify", "retract"],
    ],
    [object("open_question", "open", "OQU-1100"), ["resolve", "obsolete", "retract"]],
    [object("constraint", "active", "CON-1100"), ["supersede", "lift", "verify", "retract"]],
    [object("glossary_entry", "active", "GLO-1100"), ["supersede", "deprecate", "retract"]],
    [object("artifact", "current", "ART-1100"), ["supersede", "retract"]],
  ];

  for (const [current, legal] of states) {
    for (const name of allTransitions) {
      if (legal.includes(name)) {
        continue;
      }
      assert.throws(
        () => transition(current, name, context()),
        undefined,
        `${current.type} ${current.status} must reject ${name}`,
      );
    }
  }
});

test("legal transition names still reject when their preconditions are missing", () => {
  const discussion = object("discussion", "recorded", "DSC-1150");
  const discussionDeriver = object("requirement", "active", "REQ-1150");
  const discussionWithDeriver = context(
    [discussion, discussionDeriver],
    [relation(discussionDeriver.id, "derives_from", discussion.id)],
  );
  const observation = object("observation", "observed", "OBS-1150");
  const requirement = object("requirement", "active", "REQ-1151");
  const decision = object("decision", "active", "DEC-1150");
  const question = object("open_question", "open", "OQU-1150");
  const constraint = object("constraint", "active", "CON-1150");
  const glossary = object("glossary_entry", "active", "GLO-1150");
  const artifact = object("artifact", "current", "ART-1150");
  const invalidCases: readonly [KnowledgeObject, KnowledgeTransition, TransitionContext][] = [
    [requirement, "supersede", context()],
    [discussion, "distil", context()],
    [discussion, "archive", discussionWithDeriver],
    [observation, "promote_question", context()],
    [observation, "promote_hypothesis", context()],
    [observation, "absorb", context()],
    [observation, "expire", context()],
    [decision, "supersede", context()],
    [question, "resolve", context()],
    [constraint, "supersede", context()],
    [glossary, "supersede", context()],
    [artifact, "supersede", context()],
  ];

  for (const [current, name, currentContext] of invalidCases) {
    assert.throws(
      () => transition(current, name, currentContext),
      `${current.type} ${name} must reject a missing precondition`,
    );
  }
});

test("terminal states accept no transitions, while Hypothesis rejected accepts revive", () => {
  const allTransitions: readonly KnowledgeTransition[] = [
    "supersede",
    "withdraw",
    "distil",
    "archive",
    "promote_question",
    "promote_hypothesis",
    "absorb",
    "expire",
    "reject",
    "revive",
    "revert",
    "flag_review",
    "verify",
    "resolve",
    "obsolete",
    "lift",
    "deprecate",
    "retract",
  ];
  const terminalObjects = [
    object("requirement", "superseded", "REQ-1200"),
    object("requirement", "withdrawn", "REQ-1201"),
    object("discussion", "distilled", "DSC-1200"),
    object("discussion", "archived", "DSC-1201"),
    object("observation", "promoted_to_question", "OBS-1200"),
    object("observation", "promoted_to_hypothesis", "OBS-1201"),
    object("observation", "absorbed", "OBS-1202"),
    object("observation", "stale", "OBS-1203"),
    object("hypothesis", "revived", "HYP-1200"),
    object("decision", "superseded", "DEC-1200"),
    object("decision", "reverted", "DEC-1201"),
    object("open_question", "resolved", "OQU-1200"),
    object("open_question", "obsolete", "OQU-1201"),
    object("constraint", "superseded", "CON-1200"),
    object("constraint", "lifted", "CON-1201"),
    object("glossary_entry", "superseded", "GLO-1200"),
    object("glossary_entry", "deprecated", "GLO-1201"),
    object("artifact", "superseded", "ART-1200"),
    object("requirement", "retracted", "REQ-1202"),
  ];

  for (const current of terminalObjects) {
    assert.equal(isTerminal(current), true, `${current.type} ${current.status}`);
    for (const name of allTransitions) {
      assert.throws(() => transition(current, name, context()), `${current.type} ${name}`);
    }
  }

  const rejected = object("hypothesis", "rejected", "HYP-1201");
  assert.equal(isTerminal(rejected), false);
  assert.equal(transition(rejected, "revive", context()).status, "revived");

  const candidateStatuses: readonly Candidate["status"][] = ["accepted", "rejected", "expired"];
  for (const status of candidateStatuses) {
    const candidate: Candidate = {
      id: "CAN-1200",
      proposedType: "decision",
      payload: {},
      parentId: null,
      sourceRef: null,
      proposedBy: "ai",
      status,
      resolution: null,
      createdAt: NOW,
      resolvedAt: NOW,
    };
    for (const name of ["accept", "edit_accept", "merge", "reject", "expire"] as const) {
      assert.throws(() => transitionCandidate(candidate, name, NOW));
    }
  }
});
