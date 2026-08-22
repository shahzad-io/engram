import { DomainError, ErrorCode } from "../errors.js";
import { activeAtVersion, normaliseLabel } from "./normalise.js";
import type { FeatureLabel, LabelCandidate, LabelRegistry, LabelResolution } from "./types.js";

const MAX_REDIRECT_DEPTH = 16;

/**
 * Aliases resolve at write; redirects resolve at read as of V (3.4.2).
 * Unrecognised input becomes a LabelCandidate and never enters the graph.
 */
export function resolveLabel(
  input: string,
  projectScopeId: string,
  version: number,
  registry: LabelRegistry,
): LabelResolution {
  const normalised = normaliseLabel(input);
  if (normalised === "") {
    throw new DomainError(ErrorCode.INVALID_LABEL, "label normalises to empty");
  }
  const candidate: LabelCandidate = { kind: "candidate", normalised };

  const hit =
    findCanonical(normalised, projectScopeId, version, registry.labels) ??
    findViaAlias(normalised, projectScopeId, version, registry);
  if (hit === undefined) {
    return candidate;
  }
  return { kind: "resolved", labelId: followRedirects(hit, version, registry.labels) };
}

function findCanonical(
  normalised: string,
  projectScopeId: string,
  version: number,
  labels: readonly FeatureLabel[],
): FeatureLabel | undefined {
  return pick(
    labels.filter(
      (label) =>
        label.projectScopeId === projectScopeId &&
        label.canonicalName === normalised &&
        activeAtVersion(label.validFromVersion, label.validToVersion, version),
    ),
  );
}

function findViaAlias(
  normalised: string,
  projectScopeId: string,
  version: number,
  registry: LabelRegistry,
): FeatureLabel | undefined {
  const alias = pick(
    registry.aliases.filter(
      (row) =>
        row.projectScopeId === projectScopeId &&
        row.alias === normalised &&
        activeAtVersion(row.validFromVersion, row.validToVersion, version),
    ),
  );
  if (alias === undefined) {
    return undefined;
  }
  return pick(
    registry.labels.filter(
      (label) =>
        label.id === alias.labelId &&
        label.projectScopeId === projectScopeId &&
        activeAtVersion(label.validFromVersion, label.validToVersion, version),
    ),
  );
}

function followRedirects(
  start: FeatureLabel,
  version: number,
  labels: readonly FeatureLabel[],
): string {
  const seen = new Set<string>();
  let current: FeatureLabel = start;
  let hops = 0;
  while (true) {
    if (seen.has(current.id)) {
      throw new DomainError(
        ErrorCode.LABEL_REDIRECT_CYCLE,
        `label redirect cycle at ${current.id}`,
      );
    }
    seen.add(current.id);
    if (current.redirectsToId === null) {
      return current.id;
    }
    if (hops >= MAX_REDIRECT_DEPTH) {
      throw new DomainError(
        ErrorCode.LABEL_REDIRECT_CYCLE,
        `label redirect did not reach a terminal label within ${MAX_REDIRECT_DEPTH} hops from ${start.id}`,
      );
    }
    hops += 1;
    const next = pick(
      labels.filter(
        (label) =>
          label.id === current.redirectsToId &&
          activeAtVersion(label.validFromVersion, label.validToVersion, version),
      ),
    );
    if (next === undefined) {
      throw new DomainError(
        ErrorCode.UNKNOWN_LABEL,
        `label redirect from ${current.id} has no target open at version ${version}`,
      );
    }
    current = next;
  }
}

function pick<T extends { id?: string; labelId?: string; validFromVersion: number }>(
  rows: readonly T[],
): T | undefined {
  if (rows.length === 0) {
    return undefined;
  }
  const sorted = [...rows].sort((a, b) => {
    if (b.validFromVersion !== a.validFromVersion) {
      return b.validFromVersion - a.validFromVersion;
    }
    const aId = a.id ?? a.labelId ?? "";
    const bId = b.id ?? b.labelId ?? "";
    return aId < bId ? -1 : aId > bId ? 1 : 0;
  });
  return sorted[0];
}
