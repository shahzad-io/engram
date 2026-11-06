import assert from "node:assert/strict";
import test from "node:test";
import * as z from "zod/v4";
import { discussionResolveInputSchema } from "../dist/mcp/schemas.js";

/**
 * The input schema is the only contract a caller can read before making a
 * call. These tests pin what it accepts, what it rejects, and that a rejection
 * names the offending field rather than costing a round trip per mistake.
 */

const schema = z.object(discussionResolveInputSchema);

type Json = Record<string, unknown>;

function discussion(overrides: Json = {}): Json {
  return {
    local_id: "discussion",
    type: "discussion",
    scope_id: "project_beacon",
    title: "title",
    body: "body",
    status: "recorded",
    attributes: {
      medium: "chat",
      occurred_at: "2026-08-20T00:00:00.000Z",
      content_ref: "blob://transcript",
    },
    ...overrides,
  };
}

function decision(overrides: Json = {}): Json {
  return {
    local_id: "decision",
    type: "decision",
    scope_id: "project_beacon",
    title: "title",
    body: "body",
    status: "active",
    attributes: {
      statement: "statement",
      rationale: "rationale",
      reversibility: "cheap",
      alternatives_rejected: [],
    },
    ...overrides,
  };
}

function payload(discussionOverrides: Json = {}, decisionOverrides: Json = {}): Json {
  return {
    discussion: discussion(discussionOverrides),
    proposal: {
      objects: [decision(decisionOverrides)],
      relations: [
        {
          source_id: "decision",
          relation: "derives_from",
          target_id: "discussion",
          target_kind: "knowledge_object",
        },
      ],
    },
  };
}

function paths(input: Json): string[] {
  const result = schema.safeParse(input);
  assert.equal(result.success, false, "expected the payload to be rejected");
  return (result.error?.issues ?? []).map((issue) => issue.path.join("."));
}

test("a complete snake_case proposal is accepted", () => {
  assert.equal(schema.safeParse(payload()).success, true);
});

test("a complete camelCase proposal is accepted", () => {
  const input = payload(
    {
      scopeId: "project_beacon",
      scope_id: undefined,
      attributes: {
        medium: "chat",
        occurredAt: "2026-08-20T00:00:00.000Z",
        contentRef: { storage: "external", location: "fovea://conversation/1" },
      },
    },
    {
      scopeId: "project_beacon",
      scope_id: undefined,
      attributes: {
        statement: "statement",
        rationale: "rationale",
        reversibility: "cheap",
        alternativesRejected: [{ alternative: "other", reason: "slower" }],
      },
    },
  );
  const result = schema.safeParse(input);
  assert.equal(result.success, true, JSON.stringify(result.error?.issues));
});

test("a caller-supplied discussion id is rejected rather than silently ignored", () => {
  assert.deepEqual(paths(payload({ id: "DSC-0001" })), ["discussion.id"]);
});

test("a proposal object cannot express a graph id at all", () => {
  for (const id of ["DEC-ENGRAM-20260823-001", "DEC-001", "decision-1", "DEC-0001"]) {
    assert.deepEqual(paths(payload({}, { id })), ["proposal.objects.0.id"], id);
  }
});

test("a local id shaped like a graph id is refused so it cannot shadow one", () => {
  assert.deepEqual(paths(payload({}, { local_id: "DEC-0001" })), ["proposal.objects.0.local_id"]);
  assert.deepEqual(paths(payload({ local_id: "DSC-0200" })), ["discussion.local_id"]);
});

test("a proposal object without a local id is rejected: relations would have nothing to name", () => {
  assert.deepEqual(paths(payload({}, { local_id: undefined })), ["proposal.objects.0.local_id"]);
});

test("a missing required decision attribute names that attribute", () => {
  const issues = paths(
    payload(
      {},
      { attributes: { rationale: "r", reversibility: "cheap", alternatives_rejected: [] } },
    ),
  );
  assert.deepEqual(issues, ["proposal.objects.0.attributes.statement"]);
});

test("a missing aliased attribute is reported on its canonical snake_case spelling", () => {
  const issues = paths(
    payload({}, { attributes: { statement: "s", rationale: "r", reversibility: "cheap" } }),
  );
  assert.deepEqual(issues, ["proposal.objects.0.attributes.alternatives_rejected"]);
});

test("a wrong status is rejected at the schema boundary", () => {
  assert.deepEqual(paths(payload({}, { status: "proposed" })), ["proposal.objects.0.status"]);
  assert.deepEqual(paths(payload({ status: "open" })), ["discussion.status"]);
});

test("a value outside a closed enum is rejected at the schema boundary", () => {
  const issues = paths(
    payload(
      {},
      {
        attributes: {
          statement: "s",
          rationale: "r",
          reversibility: "maybe",
          alternatives_rejected: [],
        },
      },
    ),
  );
  assert.deepEqual(issues, ["proposal.objects.0.attributes.reversibility"]);
});

test("a missing scope is reported even though both spellings are optional keys", () => {
  assert.deepEqual(paths(payload({}, { scope_id: undefined })), ["proposal.objects.0.scope_id"]);
});

test("raw evidence cannot be proposed as a candidate", () => {
  const input = {
    discussion: discussion(),
    proposal: { objects: [discussion({ local_id: "evidence" })] },
  };
  assert.deepEqual(paths(input), ["proposal.objects.0.type"]);
});

test("every problem in a payload is reported in one response", () => {
  const issues = paths(
    payload(
      { status: "open" },
      {
        status: "proposed",
        scope_id: undefined,
        attributes: { reversibility: "maybe" },
      },
    ),
  );
  assert.deepEqual(issues.sort(), [
    "discussion.status",
    "proposal.objects.0.attributes.alternatives_rejected",
    "proposal.objects.0.attributes.rationale",
    "proposal.objects.0.attributes.reversibility",
    "proposal.objects.0.attributes.statement",
    "proposal.objects.0.scope_id",
    "proposal.objects.0.status",
  ]);
});

test("an over-long constraint rule is rejected at the schema boundary", () => {
  const input = {
    discussion: discussion(),
    proposal: {
      objects: [
        {
          local_id: "rule",
          type: "constraint",
          scope_id: "project_beacon",
          title: "title",
          body: "body",
          status: "active",
          attributes: { rule: "x".repeat(281), enforcement: "hard", axiomatic: true },
        },
      ],
    },
  };
  assert.deepEqual(paths(input), ["proposal.objects.0.attributes.rule"]);
});

test("a backfill origin marker still reaches the domain layer", () => {
  const result = schema.safeParse(
    payload(
      {},
      {
        attributes: {
          statement: "s",
          rationale: "r",
          reversibility: "cheap",
          alternatives_rejected: [],
          origin: "unrecoverable",
        },
      },
    ),
  );
  assert.equal(result.success, true);
  const objects = (result.data?.proposal as { objects: Array<{ attributes: Json }> }).objects;
  assert.equal(objects[0]?.attributes.origin, "unrecoverable");
});
