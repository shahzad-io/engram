import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { readRelationTargetKind } from "../../wire/relation.js";
import type {
  BackfillExternalReferenceDraft,
  BackfillFrictionAction,
  BackfillLabelAssignmentDraft,
  BackfillLabelDraft,
  BackfillObjectDraft,
  BackfillParseFailure,
  BackfillRelationDraft,
  BackfillScopeDraft,
} from "../../domain/backfill/index.js";

export type BackfillLoadResult = {
  readonly bundle: {
    readonly objects: readonly BackfillObjectDraft[];
    readonly relations: readonly BackfillRelationDraft[];
    readonly frictionActions: readonly BackfillFrictionAction[];
    readonly externalReferences: readonly BackfillExternalReferenceDraft[];
    readonly scopes: readonly BackfillScopeDraft[];
    readonly labels: readonly BackfillLabelDraft[];
    readonly labelAssignments: readonly BackfillLabelAssignmentDraft[];
  };
  readonly failures: readonly BackfillParseFailure[];
};

type JsonRecord = Record<string, unknown>;

const MANIFEST_FILES = new Set([
  "relations.json",
  "friction.json",
  "gaps.json",
  "external-references.json",
  "scopes.json",
  "labels.json",
]);

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(record: JsonRecord, ...keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function stringArray(
  record: JsonRecord,
  keys: readonly string[],
): { readonly value: readonly string[]; readonly valid: boolean } {
  for (const key of keys) {
    const value = record[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      return { value: [], valid: false };
    }
    return { value: value as string[], valid: true };
  }
  return { value: [], valid: true };
}

function nullableString(
  record: JsonRecord,
  keys: readonly string[],
): { readonly value: string | null; readonly valid: boolean } {
  for (const key of keys) {
    const value = record[key];
    if (value === undefined || value === null) return { value: null, valid: true };
    if (typeof value !== "string") return { value: null, valid: false };
    return { value, valid: true };
  }
  return { value: null, valid: true };
}

function attributesValue(record: JsonRecord): {
  readonly value: Readonly<Record<string, unknown>>;
  readonly valid: boolean;
} {
  const value = record.attributes;
  if (isRecord(value)) return { value, valid: true };
  return { value: {}, valid: false };
}

function addFailure(failures: BackfillParseFailure[], sourcePath: string, message: string): void {
  failures.push({ sourcePath, message });
}

function parseObject(
  value: unknown,
  sourcePath: string,
  failures: BackfillParseFailure[],
): BackfillObjectDraft | null {
  if (!isRecord(value)) {
    addFailure(failures, sourcePath, "object document must be a JSON object");
    return null;
  }
  const id = stringValue(value, "id") ?? "";
  const type = stringValue(value, "type") ?? "";
  const scopeId = stringValue(value, "scope_id", "scopeId") ?? "";
  const explicitScopeIds = stringArray(value, ["scope_ids", "scopeIds"]);
  if (!explicitScopeIds.valid) {
    addFailure(failures, sourcePath, "scope_ids must be an array of strings");
  }
  const scopeIds =
    explicitScopeIds.value.length > 0 ? explicitScopeIds.value : scopeId === "" ? [] : [scopeId];
  const featureLabels = stringArray(value, [
    "feature_labels",
    "featureLabels",
    "feature_label_ids",
    "featureLabelIds",
  ]);
  if (!featureLabels.valid) {
    addFailure(failures, sourcePath, "feature_labels must be an array of strings");
  }
  const attributes = attributesValue(value);
  if (!attributes.valid) {
    addFailure(failures, sourcePath, "attributes must be a JSON object");
  }
  const title = stringValue(value, "title") ?? "";
  const body = stringValue(value, "body") ?? "";
  const status = stringValue(value, "status") ?? "";
  if (id === "") addFailure(failures, sourcePath, "id is required");
  if (type === "") addFailure(failures, sourcePath, "type is required");
  if (scopeIds.length === 0) addFailure(failures, sourcePath, "scope_id or scope_ids is required");
  if (title === "") addFailure(failures, sourcePath, "title is required");
  if (typeof value.body !== "string") addFailure(failures, sourcePath, "body is required");
  if (status === "") addFailure(failures, sourcePath, "status is required");
  const supersedesId = stringValue(value, "supersedes_id", "supersedesId") ?? null;
  return {
    sourcePath,
    id,
    type,
    scopeId: scopeIds[0] ?? "",
    scopeIds,
    featureLabels: featureLabels.value,
    title,
    body,
    status,
    attributes: attributes.value,
    supersedesId,
  };
}

function parseRelation(
  value: unknown,
  sourcePath: string,
  failures: BackfillParseFailure[],
): BackfillRelationDraft | null {
  if (!isRecord(value)) {
    addFailure(failures, sourcePath, "relation entry must be a JSON object");
    return null;
  }
  const sourceId = stringValue(value, "source_id", "sourceId") ?? "";
  const relation = stringValue(value, "relation", "verb") ?? "";
  const targetId = stringValue(value, "target_id", "targetId") ?? "";
  // Kept as a raw string: an unrecognised one is reported by name in
  // validate.ts, alongside the file it came from.
  const targetKind = readRelationTargetKind(value);
  if (sourceId === "") addFailure(failures, sourcePath, "relation source_id is required");
  if (relation === "") addFailure(failures, sourcePath, "relation verb is required");
  if (targetId === "") addFailure(failures, sourcePath, "relation target_id is required");
  return { sourcePath, sourceId, relation, targetId, targetKind };
}

function parseExternalReference(
  value: unknown,
  sourcePath: string,
  failures: BackfillParseFailure[],
): BackfillExternalReferenceDraft | null {
  if (!isRecord(value)) {
    addFailure(failures, sourcePath, "external reference entry must be a JSON object");
    return null;
  }
  const id = stringValue(value, "id") ?? "";
  const system = stringValue(value, "system") ?? "";
  const identifier = stringValue(value, "identifier") ?? "";
  const location = nullableString(value, ["location"]);
  const symbol = nullableString(value, ["symbol"]);
  const lastVerifiedRaw = value.last_verified_at ?? value.lastVerifiedAt;
  const lastVerifiedAt =
    lastVerifiedRaw === undefined || lastVerifiedRaw === null
      ? null
      : parseDate(lastVerifiedRaw, sourcePath, "last_verified_at", failures);
  if (id === "") addFailure(failures, sourcePath, "external reference id is required");
  if (system === "") addFailure(failures, sourcePath, "external reference system is required");
  if (identifier === "") {
    addFailure(failures, sourcePath, "external reference identifier is required");
  }
  if (!location.valid) addFailure(failures, sourcePath, "location must be a string or null");
  if (!symbol.valid) addFailure(failures, sourcePath, "symbol must be a string or null");
  return {
    sourcePath,
    id,
    system,
    identifier,
    location: location.value,
    symbol: symbol.value,
    lastVerifiedAt,
  };
}

function parseScope(
  value: unknown,
  sourcePath: string,
  failures: BackfillParseFailure[],
): BackfillScopeDraft | null {
  if (!isRecord(value)) {
    addFailure(failures, sourcePath, "scope entry must be a JSON object");
    return null;
  }
  const id = stringValue(value, "id") ?? "";
  const kind = stringValue(value, "kind") ?? "";
  const parent = nullableString(value, ["parent_id", "parentId"]);
  const name = stringValue(value, "name") ?? "";
  if (id === "") addFailure(failures, sourcePath, "scope id is required");
  if (kind === "") addFailure(failures, sourcePath, "scope kind is required");
  if (!parent.valid) addFailure(failures, sourcePath, "scope parent_id must be a string or null");
  if (name === "") addFailure(failures, sourcePath, "scope name is required");
  return { sourcePath, id, kind, parentId: parent.value, name };
}

function parseLabel(
  value: unknown,
  sourcePath: string,
  failures: BackfillParseFailure[],
): BackfillLabelDraft | null {
  if (!isRecord(value)) {
    addFailure(failures, sourcePath, "label entry must be a JSON object");
    return null;
  }
  const id = stringValue(value, "id") ?? "";
  const projectScopeId = stringValue(value, "project_scope_id", "projectScopeId") ?? "";
  const canonicalName = stringValue(value, "canonical_name", "canonicalName") ?? "";
  const aliases = stringArray(value, ["aliases"]);
  const status = stringValue(value, "status") ?? "active";
  const redirectsTo = nullableString(value, ["redirects_to_id", "redirectsToId"]);
  if (id === "") addFailure(failures, sourcePath, "label id is required");
  if (projectScopeId === "") {
    addFailure(failures, sourcePath, "label project_scope_id is required");
  }
  if (canonicalName === "") addFailure(failures, sourcePath, "label canonical_name is required");
  if (!aliases.valid) addFailure(failures, sourcePath, "label aliases must be an array of strings");
  if (!redirectsTo.valid) {
    addFailure(failures, sourcePath, "label redirects_to_id must be a string or null");
  }
  return {
    sourcePath,
    id,
    projectScopeId,
    canonicalName,
    aliases: aliases.value,
    status,
    redirectsToId: redirectsTo.value,
  };
}

function parseLabelAssignment(
  value: unknown,
  sourcePath: string,
  failures: BackfillParseFailure[],
): BackfillLabelAssignmentDraft | null {
  if (!isRecord(value)) {
    addFailure(failures, sourcePath, "label assignment must be a JSON object");
    return null;
  }
  const objectId = stringValue(value, "object_id", "objectId") ?? "";
  const labelIds = stringArray(value, ["label_ids", "labelIds"]);
  if (objectId === "") addFailure(failures, sourcePath, "label assignment object_id is required");
  if (!labelIds.valid) {
    addFailure(failures, sourcePath, "label assignment label_ids must be an array of strings");
  }
  return { sourcePath, objectId, labelIds: labelIds.value };
}

function parseDate(
  value: unknown,
  sourcePath: string,
  field: string,
  failures: BackfillParseFailure[],
): Date | null {
  if (typeof value !== "string") {
    addFailure(failures, sourcePath, `${field} must be an ISO timestamp`);
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    addFailure(failures, sourcePath, `${field} is not a valid timestamp`);
    return null;
  }
  return date;
}

function parseFriction(
  value: unknown,
  sourcePath: string,
  failures: BackfillParseFailure[],
): BackfillFrictionAction[] {
  const actionsValue = isRecord(value) ? value.actions : value;
  if (!Array.isArray(actionsValue)) {
    addFailure(failures, sourcePath, "friction.json must contain an actions array");
    return [];
  }
  const actions: BackfillFrictionAction[] = [];
  for (let index = 0; index < actionsValue.length; index += 1) {
    const actionValue = actionsValue[index];
    const actionPath = `${sourcePath}#actions[${index}]`;
    if (!isRecord(actionValue)) {
      addFailure(failures, actionPath, "friction action must be a JSON object");
      continue;
    }
    const actionId = stringValue(actionValue, "action_id", "actionId") ?? `action-${index + 1}`;
    const kind = stringValue(actionValue, "kind") ?? "unspecified";
    const description =
      stringValue(actionValue, "description", "note") ?? stringValue(actionValue, "message") ?? "";
    const abandoned = actionValue.abandoned === true;
    actions.push({
      actionId,
      sourcePath,
      kind,
      description,
      abandoned,
    });
  }
  return actions;
}

async function readJson(filePath: string): Promise<unknown> {
  const text = await readFile(filePath, "utf8");
  const firstLineEnd = text.indexOf("\n");
  const firstLine = firstLineEnd === -1 ? text : text.slice(0, firstLineEnd);
  const json =
    /^\s*\/\/\s*Initial status:\s*[a-z_]+\s*$/u.test(firstLine) && firstLineEnd !== -1
      ? text.slice(firstLineEnd + 1)
      : text;
  return JSON.parse(json) as unknown;
}

async function jsonFiles(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(directory, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

export async function loadBackfillBundle(root: string): Promise<BackfillLoadResult> {
  const absoluteRoot = path.resolve(root);
  const failures: BackfillParseFailure[] = [];
  const objects: BackfillObjectDraft[] = [];
  const relations: BackfillRelationDraft[] = [];
  const externalReferences: BackfillExternalReferenceDraft[] = [];
  const scopes: BackfillScopeDraft[] = [];
  const labels: BackfillLabelDraft[] = [];
  const labelAssignments: BackfillLabelAssignmentDraft[] = [];
  let frictionActions: BackfillFrictionAction[] = [];
  const entries = await readdir(absoluteRoot, { withFileTypes: true });
  const objectsEntry = entries.find((entry) => entry.isDirectory() && entry.name === "objects");
  const objectsDirectory =
    objectsEntry === undefined ? absoluteRoot : path.join(absoluteRoot, "objects");
  for (const filePath of await jsonFiles(objectsDirectory)) {
    if (objectsDirectory === absoluteRoot && MANIFEST_FILES.has(path.basename(filePath))) continue;
    try {
      const parsed = parseObject(await readJson(filePath), filePath, failures);
      if (parsed !== null) objects.push(parsed);
    } catch (error) {
      addFailure(failures, filePath, error instanceof Error ? error.message : String(error));
    }
  }

  const relationsPath = path.join(absoluteRoot, "relations.json");
  try {
    const parsed = await readJson(relationsPath);
    const values = Array.isArray(parsed) ? parsed : isRecord(parsed) ? parsed.relations : undefined;
    if (!Array.isArray(values)) {
      addFailure(failures, relationsPath, "relations.json must contain a relations array");
    } else {
      for (let index = 0; index < values.length; index += 1) {
        const relation = parseRelation(
          values[index],
          `${relationsPath}#relations[${index}]`,
          failures,
        );
        if (relation !== null) relations.push(relation);
      }
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      addFailure(failures, relationsPath, error instanceof Error ? error.message : String(error));
    }
  }

  const externalReferencesPath = path.join(absoluteRoot, "external-references.json");
  try {
    const parsed = await readJson(externalReferencesPath);
    const values = Array.isArray(parsed)
      ? parsed
      : isRecord(parsed)
        ? (parsed.external_references ?? parsed.externalReferences)
        : undefined;
    if (!Array.isArray(values)) {
      addFailure(
        failures,
        externalReferencesPath,
        "external-references.json must contain an external_references array",
      );
    } else {
      for (let index = 0; index < values.length; index += 1) {
        const reference = parseExternalReference(
          values[index],
          `${externalReferencesPath}#external_references[${index}]`,
          failures,
        );
        if (reference !== null) externalReferences.push(reference);
      }
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      addFailure(
        failures,
        externalReferencesPath,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  const scopesPath = path.join(absoluteRoot, "scopes.json");
  try {
    const parsed = await readJson(scopesPath);
    const values = Array.isArray(parsed) ? parsed : isRecord(parsed) ? parsed.scopes : undefined;
    if (!Array.isArray(values)) {
      addFailure(failures, scopesPath, "scopes.json must contain a scopes array");
    } else {
      for (let index = 0; index < values.length; index += 1) {
        const scope = parseScope(values[index], `${scopesPath}#scopes[${index}]`, failures);
        if (scope !== null) scopes.push(scope);
      }
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      addFailure(failures, scopesPath, error instanceof Error ? error.message : String(error));
    }
  }

  const labelsPath = path.join(absoluteRoot, "labels.json");
  try {
    const parsed = await readJson(labelsPath);
    const labelValues = isRecord(parsed) ? parsed.labels : undefined;
    const assignmentValues = isRecord(parsed) ? parsed.assignments : undefined;
    if (!Array.isArray(labelValues)) {
      addFailure(failures, labelsPath, "labels.json must contain a labels array");
    } else {
      for (let index = 0; index < labelValues.length; index += 1) {
        const label = parseLabel(labelValues[index], `${labelsPath}#labels[${index}]`, failures);
        if (label !== null) labels.push(label);
      }
    }
    if (!Array.isArray(assignmentValues)) {
      addFailure(failures, labelsPath, "labels.json must contain an assignments array");
    } else {
      for (let index = 0; index < assignmentValues.length; index += 1) {
        const assignment = parseLabelAssignment(
          assignmentValues[index],
          `${labelsPath}#assignments[${index}]`,
          failures,
        );
        if (assignment !== null) labelAssignments.push(assignment);
      }
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      addFailure(failures, labelsPath, error instanceof Error ? error.message : String(error));
    }
  }

  const frictionPath = path.join(absoluteRoot, "friction.json");
  try {
    frictionActions = parseFriction(await readJson(frictionPath), frictionPath, failures);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      addFailure(failures, frictionPath, error instanceof Error ? error.message : String(error));
    }
  }
  return {
    bundle: {
      objects,
      relations,
      frictionActions,
      externalReferences,
      scopes,
      labels,
      labelAssignments,
    },
    failures,
  };
}
