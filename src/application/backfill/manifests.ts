import type {
  BackfillFailure,
  BackfillExternalReferenceDraft,
  BackfillExternalReferenceWrite,
  BackfillLabelAssignmentDraft,
  BackfillLabelDraft,
  BackfillScopeDraft,
} from "../../domain/backfill/index.js";
import type { KnowledgeObject } from "../../domain/entity/types.js";
import type { FeatureLabel, FeatureLabelAlias } from "../../domain/label/types.js";
import { normaliseLabel } from "../../domain/label/normalise.js";
import { projectOf, resolveChain } from "../../domain/scope/resolve.js";
import { LEGAL_PARENT_KIND, type Scope, type ScopeKind } from "../../domain/scope/types.js";
import type {
  FeatureLabelAliasWrite,
  FeatureLabelAssignment,
  FeatureLabelWrite,
  ScopeWrite,
} from "../write/index.js";

export type ExternalReferenceManifestPlan = {
  readonly writes: readonly BackfillExternalReferenceWrite[];
  readonly failures: readonly BackfillFailure[];
};

export type ScopeManifestPlan = {
  readonly scopes: readonly Scope[];
  readonly writes: readonly ScopeWrite[];
  readonly failures: readonly BackfillFailure[];
};

export type LabelManifestPlan = {
  readonly labels: readonly FeatureLabelWrite[];
  readonly aliases: readonly FeatureLabelAliasWrite[];
  readonly assignments: readonly FeatureLabelAssignment[];
  readonly failures: readonly BackfillFailure[];
};

const SCOPE_KINDS = new Set<ScopeKind>(["global", "project", "workstream", "phase"]);
const LABEL_STATUSES = new Set(["active", "deprecated"]);
const EXTERNAL_REFERENCE_SYSTEMS = new Set([
  "git",
  "tracker",
  "docs",
  "design",
  "dashboard",
  "logs",
  "other",
]);

function failure(
  failures: BackfillFailure[],
  code: string,
  sourcePath: string,
  message: string,
): void {
  failures.push({ code, sourcePath, message });
}

function scopePathLabel(id: string): string {
  return id.replace(/[^A-Za-z0-9_]/gu, "_");
}

function syntheticScope(entry: BackfillScopeDraft, kind: ScopeKind, parent: Scope | null): Scope {
  const label = scopePathLabel(entry.id);
  return {
    id: entry.id,
    kind,
    parentId: entry.parentId,
    name: entry.name,
    path: parent === null ? label : `${parent.path}.${label}`,
    depth: parent === null ? 0 : parent.depth + 1,
  };
}

function sameScopeDefinition(left: Scope, right: BackfillScopeDraft, kind: ScopeKind): boolean {
  return left.kind === kind && left.parentId === right.parentId && left.name === right.name;
}

export function planScopeManifest(
  entries: readonly BackfillScopeDraft[],
  existingScopes: readonly Scope[],
): ScopeManifestPlan {
  const failures: BackfillFailure[] = [];
  const scopesById = new Map(existingScopes.map((scope) => [scope.id, scope]));
  const writes: ScopeWrite[] = [];
  const seen = new Set<string>();
  const pending = [...entries].sort((left, right) =>
    left.sourcePath.localeCompare(right.sourcePath),
  );

  for (const entry of pending) {
    if (seen.has(entry.id)) {
      failure(
        failures,
        "SCOPE_MANIFEST_DUPLICATE",
        entry.sourcePath,
        `scope ${entry.id} appears more than once`,
      );
      continue;
    }
    seen.add(entry.id);
  }

  const unresolved = pending.filter((entry) => {
    if (
      seen.has(entry.id) &&
      pending.findIndex((candidate) => candidate.id === entry.id) !== pending.indexOf(entry)
    ) {
      return false;
    }
    return true;
  });
  let remaining = unresolved;
  while (remaining.length > 0) {
    let progressed = false;
    const next: BackfillScopeDraft[] = [];
    for (const entry of remaining) {
      if (!SCOPE_KINDS.has(entry.kind as ScopeKind)) {
        failure(
          failures,
          "SCOPE_MANIFEST_INVALID",
          entry.sourcePath,
          `unknown scope kind ${entry.kind}`,
        );
        progressed = true;
        continue;
      }
      const kind = entry.kind as ScopeKind;
      const existing = scopesById.get(entry.id);
      if (existing !== undefined) {
        if (!sameScopeDefinition(existing, entry, kind)) {
          failure(
            failures,
            "SCOPE_MANIFEST_CONFLICT",
            entry.sourcePath,
            `scope ${entry.id} conflicts with its existing definition`,
          );
        }
        progressed = true;
        continue;
      }
      const parent = entry.parentId === null ? null : scopesById.get(entry.parentId);
      if (entry.parentId !== null && parent === undefined) {
        if (remaining.some((candidate) => candidate.id === entry.parentId)) {
          next.push(entry);
          continue;
        }
        failure(
          failures,
          "SCOPE_PARENT_NOT_FOUND",
          entry.sourcePath,
          `scope ${entry.id} names missing parent ${entry.parentId}`,
        );
        progressed = true;
        continue;
      }
      if (kind === "global" && entry.parentId !== null) {
        failure(
          failures,
          "SCOPE_MANIFEST_INVALID",
          entry.sourcePath,
          "global scope must not have a parent",
        );
        progressed = true;
        continue;
      }
      if (kind !== "global" && entry.parentId === null) {
        failure(
          failures,
          "SCOPE_MANIFEST_INVALID",
          entry.sourcePath,
          `${kind} scope must have a parent`,
        );
        progressed = true;
        continue;
      }
      const parentScope = parent ?? null;
      if (
        parentScope !== null &&
        LEGAL_PARENT_KIND[kind as Exclude<ScopeKind, "global">] !== parentScope.kind
      ) {
        failure(
          failures,
          "SCOPE_MANIFEST_INVALID",
          entry.sourcePath,
          `${kind} scope ${entry.id} requires a ${LEGAL_PARENT_KIND[kind as Exclude<ScopeKind, "global">]} parent`,
        );
        progressed = true;
        continue;
      }
      const scope = syntheticScope(entry, kind, parentScope);
      if (scope.depth > 3) {
        failure(
          failures,
          "SCOPE_MANIFEST_INVALID",
          entry.sourcePath,
          `scope ${entry.id} exceeds the four-level scope tree`,
        );
        progressed = true;
        continue;
      }
      scopesById.set(scope.id, scope);
      writes.push({
        id: scope.id,
        kind: scope.kind,
        parentId: scope.parentId,
        name: scope.name,
      });
      progressed = true;
    }
    if (!progressed) {
      for (const entry of next) {
        failure(
          failures,
          "SCOPE_PARENT_NOT_FOUND",
          entry.sourcePath,
          `scope ${entry.id} has an unresolved parent or scope cycle`,
        );
      }
      break;
    }
    remaining = next;
  }

  return {
    scopes: [...scopesById.values()].sort((left, right) => left.id.localeCompare(right.id)),
    writes,
    failures,
  };
}

export function planExternalReferenceManifest(
  entries: readonly BackfillExternalReferenceDraft[],
  existingReferences: readonly {
    readonly id: string;
    readonly system: string;
    readonly identifier: string;
    readonly location: string | null;
    readonly symbol: string | null;
    readonly lastVerifiedAt: Date | null;
  }[],
): ExternalReferenceManifestPlan {
  const failures: BackfillFailure[] = [];
  const writes: BackfillExternalReferenceWrite[] = [];
  const existingById = new Map(existingReferences.map((reference) => [reference.id, reference]));
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) {
      failure(
        failures,
        "EXTERNAL_REFERENCE_DUPLICATE",
        entry.sourcePath,
        `external reference ${entry.id} appears more than once`,
      );
      continue;
    }
    seen.add(entry.id);
    if (!/^XRF-[0-9]{4,}$/u.test(entry.id)) {
      failure(
        failures,
        "EXTERNAL_REFERENCE_INVALID",
        entry.sourcePath,
        `external reference id does not use the XRF-NNNN format: ${entry.id}`,
      );
    }
    if (!EXTERNAL_REFERENCE_SYSTEMS.has(entry.system)) {
      failure(
        failures,
        "EXTERNAL_REFERENCE_INVALID",
        entry.sourcePath,
        `unknown external reference system ${entry.system}`,
      );
    }
    const existing = existingById.get(entry.id);
    const expected = {
      id: entry.id,
      system: entry.system,
      identifier: entry.identifier,
      location: entry.location,
      symbol: entry.symbol,
      lastVerifiedAt: entry.lastVerifiedAt,
    };
    if (existing !== undefined) {
      if (
        existing.system !== expected.system ||
        existing.identifier !== expected.identifier ||
        existing.location !== expected.location ||
        existing.symbol !== expected.symbol ||
        existing.lastVerifiedAt?.getTime() !== expected.lastVerifiedAt?.getTime()
      ) {
        failure(
          failures,
          "EXTERNAL_REFERENCE_CONFLICT",
          entry.sourcePath,
          `external reference ${entry.id} conflicts with its existing definition`,
        );
      }
      continue;
    }
    writes.push({
      ...expected,
      system: expected.system as BackfillExternalReferenceWrite["system"],
    });
  }
  return { writes, failures };
}

function currentLabels(labels: readonly FeatureLabel[]): Map<string, FeatureLabel> {
  const result = new Map<string, FeatureLabel>();
  for (const label of labels) {
    if (label.validToVersion === null) result.set(label.id, label);
  }
  return result;
}

function currentAliases(aliases: readonly FeatureLabelAlias[]): FeatureLabelAlias[] {
  return aliases.filter((alias) => alias.validToVersion === null);
}

function aliasSetFor(
  aliases: readonly FeatureLabelAlias[],
  labelId: string,
  projectScopeId: string,
): Set<string> {
  return new Set(
    aliases
      .filter(
        (alias) =>
          alias.labelId === labelId &&
          alias.projectScopeId === projectScopeId &&
          alias.validToVersion === null,
      )
      .map((alias) => alias.alias),
  );
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const a = sortedUnique(left);
  const b = sortedUnique(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function planLabelManifest(
  entries: readonly BackfillLabelDraft[],
  assignmentEntries: readonly BackfillLabelAssignmentDraft[],
  existingLabels: readonly FeatureLabel[],
  existingAliases: readonly FeatureLabelAlias[],
  objects: readonly KnowledgeObject[],
  scopes: readonly Scope[],
): LabelManifestPlan {
  const failures: BackfillFailure[] = [];
  const labelsById = currentLabels(existingLabels);
  const aliases = currentAliases(existingAliases);
  const labels: FeatureLabelWrite[] = [];
  const aliasWrites: FeatureLabelAliasWrite[] = [];
  const assignments: FeatureLabelAssignment[] = [];
  const seenLabelIds = new Set<string>();
  const scopeById = new Map(scopes.map((scope) => [scope.id, scope]));
  const manifestAliasesByLabel = new Map<string, readonly string[]>();

  for (const entry of entries) {
    if (seenLabelIds.has(entry.id)) {
      failure(
        failures,
        "LABEL_MANIFEST_DUPLICATE",
        entry.sourcePath,
        `label ${entry.id} appears more than once`,
      );
      continue;
    }
    seenLabelIds.add(entry.id);
    if (!/^FTL-[0-9]{4,}$/u.test(entry.id)) {
      failure(
        failures,
        "LABEL_MANIFEST_INVALID",
        entry.sourcePath,
        `label id does not use the FTL-NNNN format: ${entry.id}`,
      );
    }
    if (
      !scopeById.has(entry.projectScopeId) ||
      scopeById.get(entry.projectScopeId)?.kind !== "project"
    ) {
      failure(
        failures,
        "LABEL_MANIFEST_INVALID",
        entry.sourcePath,
        `label ${entry.id} must belong to a Project scope: ${entry.projectScopeId}`,
      );
    }
    if (!LABEL_STATUSES.has(entry.status)) {
      failure(
        failures,
        "LABEL_MANIFEST_INVALID",
        entry.sourcePath,
        `unknown label status ${entry.status}`,
      );
    }
    if (normaliseLabel(entry.canonicalName) !== entry.canonicalName) {
      failure(
        failures,
        "LABEL_MANIFEST_INVALID",
        entry.sourcePath,
        `label canonical_name is not normalised: ${entry.canonicalName}`,
      );
    }
    const normalisedAliases = entry.aliases.map((alias) => normaliseLabel(alias));
    if (normalisedAliases.some((alias) => alias === "")) {
      failure(
        failures,
        "LABEL_MANIFEST_INVALID",
        entry.sourcePath,
        `label ${entry.id} contains an empty alias`,
      );
    }
    if (new Set(normalisedAliases).size !== normalisedAliases.length) {
      failure(
        failures,
        "LABEL_MANIFEST_INVALID",
        entry.sourcePath,
        `label ${entry.id} contains duplicate aliases`,
      );
    }
    manifestAliasesByLabel.set(entry.id, sortedUnique(normalisedAliases));
    const existing = labelsById.get(entry.id);
    if (existing !== undefined) {
      if (
        existing.projectScopeId !== entry.projectScopeId ||
        existing.canonicalName !== entry.canonicalName ||
        existing.status !== entry.status ||
        existing.redirectsToId !== entry.redirectsToId
      ) {
        failure(
          failures,
          "LABEL_MANIFEST_CONFLICT",
          entry.sourcePath,
          `label ${entry.id} conflicts with its existing definition`,
        );
      }
      const existingAliases = aliasSetFor(aliases, entry.id, entry.projectScopeId);
      const expectedAliases = manifestAliasesByLabel.get(entry.id) ?? [];
      if (!sameStrings([...existingAliases], expectedAliases)) {
        for (const alias of expectedAliases) {
          if (!existingAliases.has(alias)) {
            aliasWrites.push({
              labelId: entry.id,
              projectScopeId: entry.projectScopeId,
              alias,
            });
          }
        }
        for (const alias of existingAliases) {
          if (!expectedAliases.includes(alias)) {
            failure(
              failures,
              "LABEL_MANIFEST_CONFLICT",
              entry.sourcePath,
              `label ${entry.id} has an undeclared active alias ${alias}`,
            );
          }
        }
      }
    } else {
      if (
        [...labelsById.values()].some(
          (label) =>
            label.validToVersion === null &&
            label.projectScopeId === entry.projectScopeId &&
            label.canonicalName === entry.canonicalName &&
            label.id !== entry.id,
        )
      ) {
        failure(
          failures,
          "LABEL_MANIFEST_CONFLICT",
          entry.sourcePath,
          `canonical label already exists in project ${entry.projectScopeId}: ${entry.canonicalName}`,
        );
      }
      labels.push({
        id: entry.id,
        projectScopeId: entry.projectScopeId,
        canonicalName: entry.canonicalName,
        status: entry.status as "active" | "deprecated",
        redirectsToId: entry.redirectsToId,
        aliases: manifestAliasesByLabel.get(entry.id) ?? [],
      });
      labelsById.set(entry.id, {
        id: entry.id,
        projectScopeId: entry.projectScopeId,
        canonicalName: entry.canonicalName,
        status: entry.status as "active" | "deprecated",
        redirectsToId: entry.redirectsToId,
        validFromVersion: Number.MAX_SAFE_INTEGER,
        validToVersion: null,
      });
    }
  }

  const activeAliasOwners = new Map(
    aliases.map((alias) => [`${alias.projectScopeId}\0${alias.alias}`, alias.labelId]),
  );
  for (const label of labels) {
    for (const alias of label.aliases ?? []) {
      const key = `${label.projectScopeId}\0${alias}`;
      const owner = activeAliasOwners.get(key);
      if (owner !== undefined && owner !== label.id) {
        failure(
          failures,
          "LABEL_MANIFEST_CONFLICT",
          "labels.json",
          `alias ${alias} is already assigned to ${owner} in project ${label.projectScopeId}`,
        );
      }
      activeAliasOwners.set(key, label.id);
    }
  }
  for (const alias of aliasWrites) {
    const key = `${alias.projectScopeId}\0${alias.alias}`;
    const owner = activeAliasOwners.get(key);
    if (owner !== undefined && owner !== alias.labelId) {
      failure(
        failures,
        "LABEL_MANIFEST_CONFLICT",
        "labels.json",
        `alias ${alias.alias} is already assigned to ${owner} in project ${alias.projectScopeId}`,
      );
    }
    activeAliasOwners.set(key, alias.labelId);
  }

  const objectsById = new Map(objects.map((object) => [object.id, object]));
  const assignmentObjectIds = new Set<string>();
  for (const entry of assignmentEntries) {
    if (assignmentObjectIds.has(entry.objectId)) {
      failure(
        failures,
        "LABEL_ASSIGNMENT_DUPLICATE",
        entry.sourcePath,
        `object ${entry.objectId} has more than one label assignment`,
      );
      continue;
    }
    assignmentObjectIds.add(entry.objectId);
    const object = objectsById.get(entry.objectId);
    if (object === undefined) {
      failure(
        failures,
        "LABEL_ASSIGNMENT_OBJECT_NOT_FOUND",
        entry.sourcePath,
        `label assignment names missing object ${entry.objectId}`,
      );
      continue;
    }
    let objectProject: Scope | undefined;
    try {
      objectProject = projectOf(resolveChain(object.scopeId, scopeById));
    } catch {
      objectProject = undefined;
    }
    const requested = sortedUnique(entry.labelIds);
    for (const labelId of requested) {
      const label = labelsById.get(labelId);
      if (label === undefined) {
        failure(
          failures,
          "UNKNOWN_LABEL",
          entry.sourcePath,
          `label assignment names unknown label ${labelId}`,
        );
      } else if (objectProject?.id !== label.projectScopeId) {
        failure(
          failures,
          "UNKNOWN_LABEL",
          entry.sourcePath,
          `${entry.objectId} cannot use Project label ${labelId}`,
        );
      }
    }
    if (!sameStrings(object.featureLabelIds, requested)) {
      assignments.push({ objectId: entry.objectId, featureLabelIds: requested });
    }
  }

  return {
    labels,
    aliases: aliasWrites,
    assignments,
    failures,
  };
}
