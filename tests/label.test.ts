import assert from "node:assert/strict";
import test from "node:test";
import {
  DomainError,
  ErrorCode,
  normaliseLabel,
  resolveLabel,
  type FeatureLabel,
  type LabelRegistry,
} from "../dist/domain/index.js";

function isDomainError(err: unknown, code: string): boolean {
  return err instanceof DomainError && err.code === code;
}

function label(
  row: Omit<FeatureLabel, "status"> & { status?: FeatureLabel["status"] },
): FeatureLabel {
  return { status: "active", ...row };
}

const project = "beacon";

test("lts.gs, lts_gs, and LTS GS all normalise to lts-gs", () => {
  assert.equal(normaliseLabel("lts.gs"), "lts-gs");
  assert.equal(normaliseLabel("lts_gs"), "lts-gs");
  assert.equal(normaliseLabel("LTS GS"), "lts-gs");
});

test("!!! throws INVALID_LABEL", () => {
  const registry: LabelRegistry = { labels: [], aliases: [] };
  assert.throws(
    () => resolveLabel("!!!", project, 1, registry),
    (err: unknown) => isDomainError(err, ErrorCode.INVALID_LABEL),
  );
});

test("resolveLabel at a pre-merge version returns the pre-merge label; at the merge version returns the target", () => {
  const registry: LabelRegistry = {
    aliases: [],
    labels: [
      label({
        id: "FTL-0009",
        projectScopeId: project,
        canonicalName: "magic-link",
        redirectsToId: null,
        validFromVersion: 10,
        validToVersion: null,
      }),
      label({
        id: "FTL-0012",
        projectScopeId: project,
        canonicalName: "magic-links",
        redirectsToId: null,
        validFromVersion: 10,
        validToVersion: 52,
      }),
      label({
        id: "FTL-0012",
        projectScopeId: project,
        canonicalName: "magic-links",
        redirectsToId: "FTL-0009",
        validFromVersion: 52,
        validToVersion: null,
      }),
    ],
  };
  assert.deepEqual(resolveLabel("magic-links", project, 47, registry), {
    kind: "resolved",
    labelId: "FTL-0012",
  });
  assert.deepEqual(resolveLabel("magic-links", project, 52, registry), {
    kind: "resolved",
    labelId: "FTL-0009",
  });
});

test("a redirect cycle throws LABEL_REDIRECT_CYCLE", () => {
  const registry: LabelRegistry = {
    aliases: [],
    labels: [
      label({
        id: "FTL-0001",
        projectScopeId: project,
        canonicalName: "alpha",
        redirectsToId: "FTL-0002",
        validFromVersion: 1,
        validToVersion: null,
      }),
      label({
        id: "FTL-0002",
        projectScopeId: project,
        canonicalName: "beta",
        redirectsToId: "FTL-0001",
        validFromVersion: 1,
        validToVersion: null,
      }),
    ],
  };
  assert.throws(
    () => resolveLabel("alpha", project, 1, registry),
    (err: unknown) => isDomainError(err, ErrorCode.LABEL_REDIRECT_CYCLE),
  );
});

test("a redirect to a non-existent or non-open label throws UNKNOWN_LABEL", () => {
  const missing: LabelRegistry = {
    aliases: [],
    labels: [
      label({
        id: "FTL-0012",
        projectScopeId: project,
        canonicalName: "magic-links",
        redirectsToId: "FTL-0009",
        validFromVersion: 52,
        validToVersion: null,
      }),
    ],
  };
  assert.throws(
    () => resolveLabel("magic-links", project, 52, missing),
    (err: unknown) => isDomainError(err, ErrorCode.UNKNOWN_LABEL),
  );

  const closed: LabelRegistry = {
    aliases: [],
    labels: [
      label({
        id: "FTL-0009",
        projectScopeId: project,
        canonicalName: "magic-link",
        redirectsToId: null,
        validFromVersion: 10,
        validToVersion: 20,
      }),
      label({
        id: "FTL-0012",
        projectScopeId: project,
        canonicalName: "magic-links",
        redirectsToId: "FTL-0009",
        validFromVersion: 52,
        validToVersion: null,
      }),
    ],
  };
  assert.throws(
    () => resolveLabel("magic-links", project, 52, closed),
    (err: unknown) => isDomainError(err, ErrorCode.UNKNOWN_LABEL),
  );
});
