import assert from "node:assert/strict";
import test from "node:test";

import {
  assertInvariants,
  collectGraphAdditionFailures,
  DomainError,
  type KnowledgeObject,
  type WorkingSet,
} from "../dist/domain/index.js";

/**
 * Pure-domain checks — no database needed. `assertInvariants` throws
 * synchronously, so each test asserts on the thrown `DomainError`'s
 * `code` and `message` directly rather than inspecting a tool result.
 */

function emptySet(objects: readonly KnowledgeObject[]): WorkingSet {
  return { objects, relations: [], scopes: [], labels: [] };
}

function baseEnvelope() {
  return {
    scopeId: "project_test",
    featureLabelIds: [] as readonly string[],
    title: "Title",
    body: "Body",
    sourceRef: null,
    createdAt: new Date("2026-08-20T00:00:00.000Z"),
    supersedesId: null,
    supersededById: null,
    reviewRequired: false,
    validFromVersion: 1,
    validToVersion: null,
    lockVersion: 1,
  };
}

function discussion(overrides: Partial<KnowledgeObject> = {}): KnowledgeObject {
  return {
    ...baseEnvelope(),
    id: "DSC-1",
    type: "discussion",
    knowledgeClass: "raw",
    status: "recorded",
    authoredBy: "human",
    approvedAt: null,
    lastVerifiedAt: null,
    attributes: {
      medium: "chat",
      occurredAt: new Date("2026-08-20T00:00:00.000Z"),
      contentRef: { storage: "external", location: "fovea://conversation/t1#m1" },
    },
    ...overrides,
  } as KnowledgeObject;
}

function decision(overrides: Partial<KnowledgeObject> = {}): KnowledgeObject {
  return {
    ...baseEnvelope(),
    id: "DEC-1",
    type: "decision",
    knowledgeClass: "reviewed",
    status: "active",
    authoredBy: "ai",
    approvedAt: new Date("2026-08-20T00:00:00.000Z"),
    lastVerifiedAt: new Date("2026-08-20T00:00:00.000Z"),
    attributes: {
      statement: "statement",
      rationale: "rationale",
      reversibility: "cheap",
      alternativesRejected: [],
    },
    ...overrides,
  } as KnowledgeObject;
}

function observation(overrides: Partial<KnowledgeObject> = {}): KnowledgeObject {
  return {
    ...baseEnvelope(),
    id: "OBS-1",
    type: "observation",
    knowledgeClass: "raw",
    status: "observed",
    authoredBy: "human",
    approvedAt: null,
    lastVerifiedAt: null,
    attributes: {
      observedAt: new Date("2026-08-20T00:00:00.000Z"),
      evidenceRef: "XRF-0001",
      reviewBy: new Date("2026-09-19T00:00:00.000Z"),
    },
    ...overrides,
  } as KnowledgeObject;
}

function thrown(fn: () => void): { code: string; message: string } {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError) {
      return { code: error.code, message: error.message };
    }
    throw error;
  }
  throw new Error("expected assertInvariants to throw");
}

test("a valid discussion with content_ref present passes", () => {
  assert.doesNotThrow(() => assertInvariants(emptySet([discussion()])));
});

test("a discussion missing content_ref names the missing key and the type's full requirement", () => {
  const withoutContentRef = discussion({
    attributes: {
      medium: "chat",
      occurredAt: new Date("2026-08-20T00:00:00.000Z"),
      contentRef: undefined,
    },
  } as never);

  const failure = thrown(() => assertInvariants(emptySet([withoutContentRef])));

  assert.equal(failure.code, "REQUIRED_ATTRIBUTES_MISSING");
  assert.equal(
    failure.message,
    "DSC-1 is missing required attributes: contentRef (discussion requires medium, occurredAt, contentRef)",
  );
});

test("a discussion missing every attribute names every missing key", () => {
  const empty = discussion({ attributes: {} } as never);

  const failure = thrown(() => assertInvariants(emptySet([empty])));

  assert.equal(failure.code, "REQUIRED_ATTRIBUTES_MISSING");
  assert.match(failure.message, /missing required attributes: medium, occurredAt, contentRef/);
});

test("a reviewed object without approval provenance keeps the PROVENANCE_REQUIRED code", () => {
  const unapproved = decision({ approvedAt: null } as never);

  const failure = thrown(() => assertInvariants(emptySet([unapproved])));

  assert.equal(failure.code, "PROVENANCE_REQUIRED");
  assert.equal(failure.message, "DEC-1 is reviewed/operational without provenance");
});

test("a knowledge_class/type mismatch gets its own code, distinct from missing provenance", () => {
  const mismatched = discussion({ knowledgeClass: "reviewed" } as never);

  const failure = thrown(() => assertInvariants(emptySet([mismatched])));

  assert.equal(failure.code, "KNOWLEDGE_CLASS_MISMATCH");
  assert.equal(failure.message, "DSC-1 knowledge_class does not match type");
});

test("a raw object carrying approval gets its own code, distinct from missing attributes", () => {
  const wronglyApproved = discussion({
    approvedAt: new Date("2026-08-20T00:00:00.000Z"),
  } as never);

  const failure = thrown(() => assertInvariants(emptySet([wronglyApproved])));

  assert.equal(failure.code, "RAW_APPROVAL_FORBIDDEN");
  assert.equal(failure.message, "DSC-1 is raw and must not carry approval");
});

test("an observation missing evidenceRef and reviewBy now gets the generic, field-naming message", () => {
  const missingEvidence = observation({
    attributes: { observedAt: new Date("2026-08-20T00:00:00.000Z") },
  } as never);

  const failure = thrown(() => assertInvariants(emptySet([missingEvidence])));

  assert.equal(failure.code, "REQUIRED_ATTRIBUTES_MISSING");
  assert.equal(
    failure.message,
    "OBS-1 is missing required attributes: evidenceRef, reviewBy " +
      "(observation requires observedAt, evidenceRef, reviewBy)",
  );
});

test("a length-capped attribute that is not text is rejected, not crashed on", () => {
  // The database CHECK tests for key presence only, so a stored constraint
  // whose `rule` is a JSON number satisfies it and reaches the length cap.
  const numericRule = {
    ...baseEnvelope(),
    id: "CON-1",
    type: "constraint",
    knowledgeClass: "operational",
    status: "active",
    authoredBy: "human",
    approvedAt: new Date("2026-08-20T00:00:00.000Z"),
    lastVerifiedAt: new Date("2026-08-20T00:00:00.000Z"),
    attributes: { rule: 42, enforcement: "hard", axiomatic: true },
  } as unknown as KnowledgeObject;

  const failures = collectGraphAdditionFailures(emptySet([]), emptySet([numericRule]));

  assert.deepEqual(
    failures.map((failure) => failure.code),
    [],
    "a non-string rule under the cap is not a length failure",
  );
});

test("collectGraphAdditionFailures reports every rejection, and the first is what throwing reports", () => {
  const orphanDecision = decision({ id: "DEC-2" } as never);
  const orphanConstraint = {
    ...baseEnvelope(),
    id: "CON-2",
    type: "constraint",
    knowledgeClass: "operational",
    status: "active",
    authoredBy: "ai",
    approvedAt: new Date("2026-08-20T00:00:00.000Z"),
    lastVerifiedAt: new Date("2026-08-20T00:00:00.000Z"),
    attributes: { rule: "x".repeat(281), enforcement: "hard", axiomatic: false },
  } as unknown as KnowledgeObject;

  const failures = collectGraphAdditionFailures(
    emptySet([]),
    emptySet([orphanDecision, orphanConstraint]),
  );

  assert.deepEqual(
    failures.map((failure) => failure.code),
    ["DECISION_ORIGIN_REQUIRED", "LENGTH_CAP_EXCEEDED", "CONSTRAINT_PARENT_REQUIRED"],
  );
  assert.deepEqual(
    failures.map((failure) => failure.objectId),
    ["DEC-2", "CON-2", "CON-2"],
  );
});

test("an observation with an empty-string evidenceRef still fails OBSERVATION_EVIDENCE_REQUIRED", () => {
  // Empty string satisfies the generic presence check (not undefined/null) but is
  // still semantically invalid; this later, stricter check is untouched by the
  // reporting fix above and must keep firing.
  const emptyEvidence = observation({
    attributes: {
      observedAt: new Date("2026-08-20T00:00:00.000Z"),
      evidenceRef: "",
      reviewBy: new Date("2026-09-19T00:00:00.000Z"),
    },
  } as never);

  const failure = thrown(() => assertInvariants(emptySet([emptyEvidence])));

  assert.equal(failure.code, "OBSERVATION_EVIDENCE_REQUIRED");
});
