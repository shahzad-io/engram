import assert from "node:assert/strict";
import test from "node:test";

import {
  type KnowledgeObjectWrite,
  type ProposalObjectWrite,
  validateDiscussionProposal,
} from "../dist/application/propose/index.js";
import { AggregateDomainError, DomainError } from "../dist/domain/index.js";
import type { PackWorkingSet } from "../dist/domain/pack/index.js";

const workingSet: PackWorkingSet = {
  objects: [],
  relations: [],
  scopes: [
    {
      id: "global",
      kind: "global",
      parentId: null,
      name: "Global",
      path: "global",
      depth: 0,
    },
    {
      id: "project_test",
      kind: "project",
      parentId: "global",
      name: "Test",
      path: "global.project_test",
      depth: 1,
    },
  ],
  labels: [],
  aliases: [],
  externalReferences: [],
  graphVersions: [],
};

function write(
  id: string,
  type: KnowledgeObjectWrite["type"],
  status: string,
  attributes: Record<string, unknown>,
): KnowledgeObjectWrite {
  return {
    id,
    type,
    scopeId: "project_test",
    title: id,
    body: `${id} body`,
    status,
    attributes,
    authoredBy: "ai",
  };
}

/** A proposed object is named by its handle; Engram assigns the id at acceptance. */
function proposed(
  localId: string,
  type: KnowledgeObjectWrite["type"],
  status: string,
  attributes: Record<string, unknown>,
): ProposalObjectWrite {
  const rest: Record<string, unknown> = write(localId, type, status, attributes);
  delete rest.id;
  return { ...rest, localId } as ProposalObjectWrite;
}

test("proposal validation reports every Decision attribute omitted by the source", () => {
  const discussion = write("DSC-TEST", "discussion", "recorded", {
    medium: "chat",
    occurredAt: "2026-08-24T00:00:00.000Z",
    contentRef: {
      storage: "external",
      location: "fovea://conversation/test#message",
    },
  });
  const decision = proposed("decision", "decision", "active", {
    rationale: "Because the test exercises source absence.",
  });

  let caught: unknown;
  try {
    validateDiscussionProposal(
      workingSet,
      1,
      discussion,
      {
        objects: [decision],
        relations: [
          {
            sourceId: decision.localId,
            relation: "derives_from",
            targetId: discussion.id,
            targetKind: "knowledge_object",
          },
        ],
      },
      new Date("2026-08-24T00:00:00.000Z"),
    );
  } catch (error) {
    caught = error;
  }

  assert.ok(caught instanceof DomainError);
  assert.equal(caught.code, "REQUIRED_ATTRIBUTES_MISSING");
  assert.equal(
    caught.message,
    "decision is missing required attributes: statement, reversibility, alternativesRejected " +
      "(decision requires statement, rationale, reversibility, alternativesRejected)",
  );
});

function reject(
  discussion: KnowledgeObjectWrite,
  proposal: Parameters<typeof validateDiscussionProposal>[3],
): AggregateDomainError {
  try {
    validateDiscussionProposal(
      workingSet,
      1,
      discussion,
      proposal,
      new Date("2026-08-24T00:00:00.000Z"),
    );
  } catch (error) {
    assert.ok(error instanceof AggregateDomainError, "expected an aggregate rejection");
    return error;
  }
  throw new Error("expected the proposal to be rejected");
}

const validDiscussion = write("DSC-AGG", "discussion", "recorded", {
  medium: "chat",
  occurredAt: "2026-08-24T00:00:00.000Z",
  contentRef: "blob://transcript",
});

test("graph-state rejections arrive together instead of one per round trip", () => {
  const error = reject(validDiscussion, {
    objects: [
      proposed("decision", "decision", "active", {
        statement: "statement",
        rationale: "rationale",
        reversibility: "cheap",
        alternativesRejected: [],
      }),
      proposed("rule", "constraint", "active", {
        rule: "x".repeat(281),
        enforcement: "hard",
        axiomatic: false,
      }),
    ],
    relations: [],
  });

  assert.deepEqual(
    error.failures.map((failure) => failure.code),
    ["DECISION_ORIGIN_REQUIRED", "LENGTH_CAP_EXCEEDED", "CONSTRAINT_PARENT_REQUIRED"],
  );
  assert.equal(error.code, "DECISION_ORIGIN_REQUIRED");
  assert.equal(error.message, error.failures[0]?.message);
});

test("a relation with an unknown endpoint is reported once, not twice", () => {
  const error = reject(validDiscussion, {
    objects: [
      proposed("decision", "decision", "active", {
        statement: "statement",
        rationale: "rationale",
        reversibility: "cheap",
        alternativesRejected: [],
      }),
    ],
    relations: [
      {
        sourceId: "decision",
        relation: "derives_from",
        targetId: "DSC-MISSING",
        targetKind: "knowledge_object",
      },
    ],
  });

  assert.deepEqual(
    error.failures.map((failure) => failure.code),
    ["ILLEGAL_RELATION", "DECISION_ORIGIN_REQUIRED"],
  );
  assert.match(String(error.failures[0]?.message), /DSC-MISSING is not in scope/u);
});

test("a structural rejection stops before reporting invented follow-on problems", () => {
  const error = reject(write("DSC-BAD", "requirement", "active", { source: "s", rationale: "r" }), {
    objects: [
      proposed("decision", "decision", "active", {
        statement: "s",
        rationale: "r",
        reversibility: "cheap",
        alternativesRejected: [],
      }),
    ],
  });

  assert.deepEqual(
    error.failures.map((failure) => failure.code),
    ["ILLEGAL_TRANSITION"],
  );
});
