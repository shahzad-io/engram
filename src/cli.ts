#!/usr/bin/env node
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import {
  acceptCandidate,
  addScope,
  BackfillImportError,
  collectMetrics,
  diffStoredContextPacks,
  dryRunBackfill,
  editAndAcceptCandidate,
  getCandidateGroup,
  importBackfill,
  listKnowledgeObjects,
  listScopeTree,
  listTriage,
  showKnowledgeObject,
  logRelitigationEvent,
  mergeCandidate,
  reproduceContextPack,
  rejectCandidate,
  requirementImpact,
  runMaintenance,
  supersedeObject,
  transitionObject,
  verifyObject,
} from "./application/index.js";
import { BACKFILL_TYPE_SPECS, isBackfillType } from "./domain/backfill/index.js";
import type { KnowledgeObject, KnowledgeObjectType } from "./domain/entity/types.js";
import type { RelationVerb, RelationTargetKind } from "./domain/relation/legality.js";
import type { ScopeKind } from "./domain/scope/types.js";
import type {
  CandidatePayload,
  KnowledgeObjectWrite,
  RelationRepointWrite,
  RelationWrite,
  ScopeWrite,
} from "./application/write/index.js";
import { loadEnvFile, requireEnv } from "./infrastructure/env.js";
import { migrate } from "./infrastructure/persistence/migration-runner.js";
import { runHttpMcp, runStdioMcp } from "./mcp/index.js";

const USAGE = `Usage:
  pke migrate
  pke mcp
  pke serve --http [--host HOST] [--port PORT]
  pke triage
  pke triage accept <candidate-id> [--elements <candidate-id>...]
  pke triage edit <candidate-id> [--elements <candidate-id>...]
  pke triage merge <candidate-id> --into <object-id>
  pke triage reject <candidate-id>
  pke show <id>
  pke list --scope <id>
  pke verify <id>
  pke supersede <id> [--file PATH]
  pke transition <id> <status>
  pke retract <id>
  pke impact <requirement-id>
  pke scope add <kind> <id> --parent <parent-id> --name <name>
  pke scope list
  pke pack diff <a> <b>
  pke pack reproduce <id>
  pke metrics
  pke relitigation log --object <id> [--session <id>] [--pack-used] [--note NOTE]
  pke maintenance [--candidate-days DAYS]
  pke backfill [--dry-run] [--report PATH] DIRECTORY
  pke backfill new <type> [--id ID]`;

function usage(): never {
  throw new Error(USAGE);
}

function serveArguments(args: readonly string[]): { readonly host: string; readonly port: number } {
  let host = "127.0.0.1";
  let port = 8787;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--host") {
      const value = args[index + 1];
      if (value === undefined) usage();
      host = value;
      index += 1;
    } else if (arg === "--port") {
      const value = args[index + 1];
      if (value === undefined) usage();
      port = Number(value);
      if (!Number.isFinite(port)) usage();
      index += 1;
    } else if (arg === "--http") {
      continue;
    } else if (arg?.startsWith("-")) {
      usage();
    } else {
      usage();
    }
  }
  return { host, port };
}

const BACKFILL_DIRECTORY = path.resolve("backfill/mira/objects");

function newBackfillArguments(args: readonly string[]): {
  readonly type: keyof typeof BACKFILL_TYPE_SPECS;
  readonly id: string | null;
} {
  const type = args[0];
  if (type === undefined || !isBackfillType(type)) usage();
  let id: string | null = null;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--id") {
      const value = args[index + 1];
      if (value === undefined) usage();
      id = value;
      index += 1;
    } else {
      usage();
    }
  }
  return { type, id };
}

async function nextBackfillId(directory: string, prefix: string): Promise<string> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return `${prefix}-0001`;
    }
    throw error;
  }
  const pattern = new RegExp(`^${prefix}-(\\d{4,})\\.json$`, "u");
  let highest = 0;
  for (const name of names) {
    const sequence = pattern.exec(name)?.[1];
    if (sequence !== undefined) highest = Math.max(highest, Number(sequence));
  }
  return `${prefix}-${String(highest + 1).padStart(4, "0")}`;
}

async function runBackfillNew(args: readonly string[]): Promise<void> {
  const options = newBackfillArguments(args);
  const spec = BACKFILL_TYPE_SPECS[options.type];
  const id = options.id ?? (await nextBackfillId(BACKFILL_DIRECTORY, spec.idPrefix));
  if (!new RegExp(`^${spec.idPrefix}-[0-9]{4,}$`, "u").test(id)) {
    throw new Error(`${id} does not use the ${spec.idPrefix}-NNNN id format`);
  }
  await mkdir(BACKFILL_DIRECTORY, { recursive: true });
  const target = path.join(BACKFILL_DIRECTORY, `${id}.json`);
  const document = {
    id,
    type: options.type,
    scope_id: "",
    feature_labels: [],
    title: "",
    body: "",
    status: spec.initialStatus,
    attributes: spec.skeletonAttributes,
  };
  const content = `// Initial status: ${spec.initialStatus}\n${JSON.stringify(document, null, 2)}\n`;
  try {
    await writeFile(target, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error(`backfill object already exists: ${target}`);
    }
    throw error;
  }
  console.log(target);
}

function backfillArguments(args: readonly string[]): {
  readonly dryRun: boolean;
  readonly directory: string;
  readonly reportPath: string | null;
} {
  let dryRun = false;
  let reportPath: string | null = null;
  let directory: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--report") {
      const value = args[index + 1];
      if (value === undefined) usage();
      reportPath = value;
      index += 1;
    } else if (arg?.startsWith("-")) {
      usage();
    } else if (directory === null) {
      directory = arg ?? null;
    } else {
      usage();
    }
  }
  if (directory === null) usage();
  return { dryRun, directory, reportPath };
}

async function runBackfill(args: readonly string[]): Promise<void> {
  const options = backfillArguments(args);
  await loadEnvFile();
  const client = new Client({ connectionString: requireEnv("PKE_DATABASE_URL") });
  await client.connect();
  try {
    const report = options.dryRun
      ? await dryRunBackfill(client, options.directory)
      : await importBackfill(client, options.directory);
    const text = JSON.stringify(report, null, 2);
    if (options.reportPath !== null) {
      await writeFile(options.reportPath, `${text}\n`, "utf8");
    }
    console.log(text);
    if (report.failures.length > 0) process.exitCode = 1;
  } catch (error) {
    if (error instanceof BackfillImportError) {
      const text = JSON.stringify(error.report, null, 2);
      console.error(text);
      if (options.reportPath !== null) {
        await writeFile(options.reportPath, `${text}\n`, "utf8");
      }
      process.exitCode = 1;
      return;
    }
    throw error;
  } finally {
    await client.end();
  }
}

async function withDatabase<T>(work: (client: Client) => Promise<T>): Promise<T> {
  await loadEnvFile();
  const client = new Client({ connectionString: requireEnv("PKE_DATABASE_URL") });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredArgument(value: string | undefined, name: string): string {
  if (value === undefined || value === "") {
    throw new Error(`missing ${name}`);
  }
  return value;
}

function selectedElementArguments(args: readonly string[]): readonly string[] | undefined {
  let selected: string[] | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--elements" || arg === "--element" || arg === "--only") {
      if (selected !== undefined) usage();
      selected = [];
      while (index + 1 < args.length && !args[index + 1]?.startsWith("--")) {
        selected.push(args[index + 1] as string);
        index += 1;
      }
      if (selected.length === 0) usage();
    } else {
      usage();
    }
  }
  return selected;
}

function pendingSelection(
  candidateId: string,
  group: Awaited<ReturnType<typeof getCandidateGroup>>,
  selectedIds: readonly string[] | undefined,
): readonly string[] {
  const root = group.find((candidate) => candidate.parentId === null);
  const ids =
    selectedIds ??
    (root?.id === candidateId
      ? group.filter((candidate) => candidate.status === "pending").map((candidate) => candidate.id)
      : [candidateId]);
  const byId = new Map(group.map((candidate) => [candidate.id, candidate]));
  const unique = [...new Set(ids)];
  if (unique.length === 0) {
    throw new Error(
      "candidate group has no pending elements. pke triage edit <id> with no --elements edits all pending members; pass --elements <child-id>... to edit a subset",
    );
  }
  for (const id of unique) {
    const candidate = byId.get(id);
    if (candidate === undefined) {
      throw new Error(`candidate ${id} is not an element of this candidate group`);
    }
    if (candidate.status !== "pending") {
      throw new Error(`candidate ${id} is no longer pending`);
    }
  }
  return unique;
}

function editPayload(
  group: Awaited<ReturnType<typeof getCandidateGroup>>,
  selectedIds: readonly string[],
): CandidatePayload {
  const selected = new Set(selectedIds);
  const objectIds = new Set(
    group
      .filter((candidate) => selected.has(candidate.id))
      .flatMap((candidate) => candidate.payload.objects.map((object) => object.id)),
  );
  const statusByObjectId = new Map(
    group.flatMap((candidate) =>
      candidate.payload.objects.map((object) => [object.id, candidate.status] as const),
    ),
  );
  const relationKeys = new Set<string>();
  const relations = group
    .flatMap((candidate) => candidate.payload.relations ?? [])
    .filter((relation) => {
      if (!objectIds.has(relation.sourceId)) return false;
      const targetStatus = statusByObjectId.get(relation.targetId);
      if (
        relation.targetKind === "knowledge_object" &&
        targetStatus !== undefined &&
        !objectIds.has(relation.targetId) &&
        targetStatus !== "accepted"
      ) {
        return false;
      }
      const key = `${relation.sourceId}\0${relation.relation}\0${relation.targetId}`;
      if (relationKeys.has(key)) return false;
      relationKeys.add(key);
      return true;
    });
  return {
    objects: group
      .filter((candidate) => selected.has(candidate.id))
      .flatMap((candidate) => candidate.payload.objects),
    relations,
  };
}

function editedCandidatePayload(value: unknown): CandidatePayload {
  if (!isRecord(value) || !Array.isArray(value.objects)) {
    throw new Error("edited candidate file must contain an objects array");
  }
  return {
    objects: value.objects as KnowledgeObjectWrite[],
    relations: Array.isArray(value.relations) ? (value.relations as RelationWrite[]) : [],
  };
}

function editorArgv(): readonly string[] {
  const editor = process.env.VISUAL?.trim() || process.env.EDITOR?.trim();
  if (editor === undefined || editor === "") {
    throw new Error("$EDITOR or $VISUAL is required for this command");
  }
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (const character of editor) {
    if (quote !== null) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/u.test(character)) {
      if (current.length > 0) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }
  if (quote !== null) {
    throw new Error("$EDITOR or $VISUAL has an unclosed quote");
  }
  if (current.length > 0) {
    parts.push(current);
  }
  if (parts.length === 0 || parts[0] === undefined) {
    throw new Error("$EDITOR or $VISUAL is required for this command");
  }
  return parts;
}

async function editJsonFile(initial: unknown, filename: string): Promise<unknown> {
  const directory = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "pke-cli-"));
  const target = path.join(directory, filename);
  try {
    await writeFile(target, `${JSON.stringify(initial, null, 2)}\n`, "utf8");
    const argv = editorArgv();
    const result = spawnSync(argv[0] as string, [...argv.slice(1), target], {
      stdio: "inherit",
    });
    if (result.error !== undefined) throw result.error;
    if (result.status !== 0) {
      throw new Error(`editor exited with status ${String(result.status)}`);
    }
    try {
      return JSON.parse(await readFile(target, "utf8")) as unknown;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error("edited candidate file is not valid JSON");
      }
      throw error;
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function runTriage(args: readonly string[]): Promise<void> {
  const action = args[0];
  if (action === undefined || action === "list") {
    if (action === "list" && args.length !== 1) usage();
    await withDatabase(async (client) => {
      printJson(await listTriage(client));
    });
    return;
  }

  const candidateId = requiredArgument(args[1], "candidate id");
  if (action === "accept") {
    const selectedIds = selectedElementArguments(args.slice(2));
    await withDatabase(async (client) => {
      printJson(await acceptCandidate(client, candidateId, selectedIds));
    });
    return;
  }
  if (action === "edit") {
    const selectedIdsArgument = selectedElementArguments(args.slice(2));
    const prepared = await withDatabase(async (client) => {
      const group = await getCandidateGroup(client, candidateId);
      const selectedIds = pendingSelection(candidateId, group, selectedIdsArgument);
      return { selectedIds, payload: editPayload(group, selectedIds) };
    });
    let edited: CandidatePayload;
    try {
      edited = editedCandidatePayload(await editJsonFile(prepared.payload, "candidate.json"));
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error("edited candidate file is not valid JSON");
      }
      throw error;
    }
    await withDatabase(async (client) => {
      printJson(await editAndAcceptCandidate(client, candidateId, edited, prepared.selectedIds));
    });
    return;
  }
  if (action === "merge") {
    if (args.length !== 4 || args[2] !== "--into") usage();
    const targetId = requiredArgument(args[3], "merge target id");
    await withDatabase(async (client) => {
      printJson(await mergeCandidate(client, candidateId, targetId));
    });
    return;
  }
  if (action === "reject") {
    if (args.length !== 2) usage();
    await withDatabase(async (client) => {
      printJson({ candidate_ids: await rejectCandidate(client, candidateId) });
    });
    return;
  }
  usage();
}

type SupersedeRow = {
  readonly id: string;
  readonly type: KnowledgeObjectType;
  readonly scope_id: string;
  readonly feature_label_ids: string[];
  readonly title: string;
  readonly body: string;
  readonly attributes: Record<string, unknown>;
  readonly source_ref: string | null;
};

type OpenRelationRow = {
  readonly source_id: string;
  readonly relation: RelationVerb;
  readonly target_id: string;
  readonly target_kind: RelationTargetKind;
};

const OBJECT_PREFIX: Readonly<Record<KnowledgeObjectType, string>> = {
  requirement: "REQ",
  discussion: "DSC",
  observation: "OBS",
  hypothesis: "HYP",
  decision: "DEC",
  open_question: "OQU",
  constraint: "CON",
  glossary_entry: "GLO",
  artifact: "ART",
};

const INITIAL_STATUS: Readonly<Record<KnowledgeObjectType, string>> = {
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

function normalizeObjectWrite(value: unknown): KnowledgeObjectWrite {
  if (!isRecord(value)) throw new Error("supersede file must contain an object");
  const type = requiredArgument(
    typeof value.type === "string" ? value.type : undefined,
    "object type",
  ) as KnowledgeObjectType;
  const scopeId = value.scopeId ?? value.scope_id;
  const featureLabelIds = value.featureLabelIds ?? value.feature_label_ids;
  return {
    id: requiredArgument(typeof value.id === "string" ? value.id : undefined, "object id"),
    type,
    scopeId: requiredArgument(typeof scopeId === "string" ? scopeId : undefined, "scope id"),
    featureLabelIds:
      Array.isArray(featureLabelIds) && featureLabelIds.every((id) => typeof id === "string")
        ? featureLabelIds
        : [],
    title: requiredArgument(typeof value.title === "string" ? value.title : undefined, "title"),
    body: requiredArgument(typeof value.body === "string" ? value.body : undefined, "body"),
    status: requiredArgument(
      typeof value.status === "string" ? value.status : undefined,
      "object status",
    ) as KnowledgeObjectWrite["status"],
    attributes: isRecord(value.attributes) ? value.attributes : {},
    authoredBy: value.authoredBy === "ai" || value.authored_by === "ai" ? "ai" : "human",
    sourceRef:
      value.sourceRef === null || value.source_ref === null
        ? null
        : typeof (value.sourceRef ?? value.source_ref) === "string"
          ? String(value.sourceRef ?? value.source_ref)
          : null,
    supersedesId:
      value.supersedesId === null || value.supersedes_id === null
        ? null
        : typeof (value.supersedesId ?? value.supersedes_id) === "string"
          ? String(value.supersedesId ?? value.supersedes_id)
          : null,
  };
}

function normalizeRelationWrite(value: unknown): RelationWrite {
  if (!isRecord(value)) throw new Error("supersede relations must be objects");
  const sourceId = value.sourceId ?? value.source_id;
  const targetId = value.targetId ?? value.target_id;
  const targetKind = value.targetKind ?? value.target_kind ?? "knowledge_object";
  return {
    sourceId: requiredArgument(
      typeof sourceId === "string" ? sourceId : undefined,
      "relation source",
    ),
    relation: requiredArgument(
      typeof value.relation === "string" ? value.relation : undefined,
      "relation verb",
    ) as RelationVerb,
    targetId: requiredArgument(
      typeof targetId === "string" ? targetId : undefined,
      "relation target",
    ),
    targetKind: requiredArgument(
      typeof targetKind === "string" ? targetKind : undefined,
      "relation target kind",
    ) as RelationTargetKind,
  };
}

function normalizeRepointWrite(value: unknown, successorId: string): RelationRepointWrite {
  if (!isRecord(value)) throw new Error("supersede repoint entries must be objects");
  const sourceId = value.sourceId ?? value.source_id;
  const oldTargetId = value.oldTargetId ?? value.old_target_id;
  const newTargetId = value.newTargetId ?? value.new_target_id ?? successorId;
  const targetKind = value.targetKind ?? value.target_kind ?? "knowledge_object";
  return {
    sourceId: requiredArgument(
      typeof sourceId === "string" ? sourceId : undefined,
      "repoint source",
    ),
    relation: requiredArgument(
      typeof value.relation === "string" ? value.relation : undefined,
      "repoint verb",
    ) as RelationVerb,
    oldTargetId: requiredArgument(
      typeof oldTargetId === "string" ? oldTargetId : undefined,
      "repoint old target",
    ),
    newTargetId: requiredArgument(
      typeof newTargetId === "string" ? newTargetId : undefined,
      "repoint new target",
    ),
    targetKind: requiredArgument(
      typeof targetKind === "string" ? targetKind : undefined,
      "repoint target kind",
    ) as RelationTargetKind,
  };
}

function supersedeDocument(
  value: unknown,
  predecessorId: string,
): {
  readonly object: KnowledgeObjectWrite;
  readonly relations: readonly RelationWrite[];
  readonly repoints: readonly RelationRepointWrite[];
} {
  if (!isRecord(value)) throw new Error("supersede file must contain an object");
  const rawObject = value.object ?? value;
  const object = normalizeObjectWrite(rawObject);
  const successorId = object.id;
  return {
    object: { ...object, supersedesId: predecessorId },
    relations: Array.isArray(value.relations) ? value.relations.map(normalizeRelationWrite) : [],
    repoints: Array.isArray(value.repoint)
      ? value.repoint.map((entry) => normalizeRepointWrite(entry, successorId))
      : [],
  };
}

async function nextObjectId(client: Client, type: KnowledgeObjectType): Promise<string> {
  const prefix = OBJECT_PREFIX[type];
  const result = await client.query<{ highest: string }>(
    `SELECT COALESCE(MAX((substring(id FROM '[0-9]+$'))::bigint), 0)::text AS highest
     FROM knowledge_objects
     WHERE type = $1
       AND id ~ $2`,
    [type, `^${prefix}-[0-9]{4,}$`],
  );
  const highest = Number(result.rows[0]?.highest ?? 0);
  return `${prefix}-${String(highest + 1).padStart(4, "0")}`;
}

async function defaultSupersedeDocument(
  client: Client,
  predecessor: SupersedeRow,
): Promise<{
  readonly object: KnowledgeObjectWrite;
  readonly relations: readonly RelationWrite[];
  readonly repoint: readonly RelationRepointWrite[];
}> {
  const successorId = await nextObjectId(client, predecessor.type);
  const open = await client.query<OpenRelationRow>(
    `SELECT source_id, relation, target_id, target_kind
     FROM relations
     WHERE (source_id = $1 OR target_id = $1)
       AND valid_to_version IS NULL
     ORDER BY id`,
    [predecessor.id],
  );
  const relations: RelationWrite[] = [];
  const repoint: RelationRepointWrite[] = [];
  for (const edge of open.rows) {
    if (edge.source_id === predecessor.id) {
      relations.push({
        sourceId: successorId,
        relation: edge.relation,
        targetId: edge.target_id,
        targetKind: edge.target_kind,
      });
      continue;
    }
    if (edge.relation === "supersedes") {
      continue;
    }
    repoint.push({
      sourceId: edge.source_id,
      relation: edge.relation,
      oldTargetId: predecessor.id,
      newTargetId: successorId,
      targetKind: edge.target_kind,
    });
  }
  return {
    object: {
      id: successorId,
      type: predecessor.type,
      scopeId: predecessor.scope_id,
      featureLabelIds: predecessor.feature_label_ids,
      title: predecessor.title,
      body: predecessor.body,
      status: INITIAL_STATUS[predecessor.type] as KnowledgeObjectWrite["status"],
      attributes: predecessor.attributes,
      authoredBy: "human",
      sourceRef: predecessor.source_ref,
      supersedesId: predecessor.id,
    },
    relations,
    repoint,
  };
}

function supersedeArguments(args: readonly string[]): {
  readonly id: string;
  readonly file: string | null;
} {
  const id = requiredArgument(args[0], "object id");
  let file: string | null = null;
  for (let index = 1; index < args.length; index += 1) {
    if (args[index] !== "--file" || file !== null) usage();
    file = requiredArgument(args[index + 1], "supersede file");
    index += 1;
  }
  return { id, file };
}

async function runSupersede(args: readonly string[]): Promise<void> {
  const options = supersedeArguments(args);
  await withDatabase(async (client) => {
    const selected = await client.query<SupersedeRow>(
      `SELECT id, type, scope_id, feature_label_ids, title, body, attributes, source_ref
       FROM knowledge_objects
       WHERE id = $1
         AND valid_to_version IS NULL`,
      [options.id],
    );
    const predecessor = selected.rows[0];
    if (predecessor === undefined) {
      throw new Error(`object ${options.id} does not exist or is not current`);
    }
    const initial = await defaultSupersedeDocument(client, predecessor);
    const document =
      options.file === null
        ? await editJsonFile(initial, "successor.json")
        : JSON.parse(await readFile(options.file, "utf8"));
    const { object, relations, repoints } = supersedeDocument(document, predecessor.id);
    const result = await supersedeObject(client, object, relations, repoints);
    printJson({ object_id: result.value.objectId, version: result.version });
  });
}

function scopeArguments(args: readonly string[]): ScopeWrite {
  const positionals: string[] = [];
  let kind: string | undefined;
  let id: string | undefined;
  let parentId: string | null | undefined;
  let name: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--kind" || arg === "--id" || arg === "--parent" || arg === "--name") {
      const value = requiredArgument(args[index + 1], arg);
      if (arg === "--kind") kind = value;
      if (arg === "--id") id = value;
      if (arg === "--parent") parentId = value;
      if (arg === "--name") name = value;
      index += 1;
    } else if (arg?.startsWith("--")) {
      usage();
    } else {
      positionals.push(requiredArgument(arg, "scope argument"));
    }
  }
  if (kind === undefined && positionals[0] !== undefined) kind = positionals[0];
  if (id === undefined && positionals[1] !== undefined) id = positionals[1];
  if (name === undefined && positionals[2] !== undefined) name = positionals.slice(2).join(" ");
  if (kind === undefined || id === undefined || name === undefined) usage();
  if (!["global", "project", "workstream", "phase"].includes(kind)) {
    throw new Error(`invalid scope kind: ${kind}`);
  }
  if (kind === "global") {
    if (parentId !== undefined) throw new Error("global scope cannot have a parent");
    parentId = null;
  } else if (parentId === undefined) {
    usage();
  }
  return {
    id,
    kind: kind as ScopeKind,
    parentId,
    name,
  };
}

async function runScope(args: readonly string[]): Promise<void> {
  const action = args[0];
  if (action === "list") {
    if (args.length !== 1) usage();
    await withDatabase(async (client) => {
      printJson(await listScopeTree(client));
    });
    return;
  }
  if (action === "add") {
    await withDatabase(async (client) => {
      const result = await addScope(client, scopeArguments(args.slice(1)));
      printJson({ scope_id: result.value.scopeId, version: result.version });
    });
    return;
  }
  usage();
}

function maintenanceArguments(args: readonly string[]): number | undefined {
  let days: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--candidate-days" || days !== undefined) usage();
    const value = Number(requiredArgument(args[index + 1], "candidate expiry days"));
    if (!Number.isFinite(value) || value < 0) usage();
    days = value;
    index += 1;
  }
  return days;
}

async function runMaintenanceCommand(args: readonly string[]): Promise<void> {
  const requestedDays = maintenanceArguments(args);
  const configuredDays =
    requestedDays === undefined && process.env.PKE_CANDIDATE_EXPIRY_DAYS !== undefined
      ? Number(process.env.PKE_CANDIDATE_EXPIRY_DAYS)
      : requestedDays;
  if (configuredDays !== undefined && (!Number.isFinite(configuredDays) || configuredDays < 0)) {
    throw new Error("PKE_CANDIDATE_EXPIRY_DAYS must be a non-negative number");
  }
  await withDatabase(async (client) => {
    printJson(await runMaintenance(client, { candidateExpiryDays: configuredDays }));
  });
}

function relitigationArguments(args: readonly string[]): {
  readonly objectId: string;
  readonly sessionId: string | null;
  readonly packUsed: boolean;
  readonly note: string | null;
} {
  if (args[0] !== "log") usage();
  let objectId: string | undefined;
  let sessionId: string | null = null;
  let packUsed = false;
  let note: string | null = null;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--object" || arg === "--session" || arg === "--note") {
      const value = requiredArgument(args[index + 1], arg);
      if (arg === "--object") {
        if (objectId !== undefined) usage();
        objectId = value;
      } else if (arg === "--session") {
        if (sessionId !== null) usage();
        sessionId = value;
      } else {
        if (note !== null) usage();
        note = value;
      }
      index += 1;
    } else if (arg === "--pack-used") {
      if (packUsed) usage();
      packUsed = true;
    } else {
      usage();
    }
  }
  return {
    objectId: requiredArgument(objectId, "object id"),
    sessionId,
    packUsed,
    note,
  };
}

async function runRelitigation(args: readonly string[]): Promise<void> {
  const options = relitigationArguments(args);
  await withDatabase(async (client) => {
    const event = await logRelitigationEvent(client, {
      objectId: options.objectId,
      sessionId: options.sessionId,
      packUsed: options.packUsed,
      note: options.note,
    });
    printJson({
      event_id: event.id,
      observed_at: event.observedAt,
      object_id: event.objectId,
      session_id: event.sessionId,
      pack_used: event.packUsed,
      note: event.note,
    });
  });
}

async function runMetrics(args: readonly string[]): Promise<void> {
  if (args.length !== 0) usage();
  await withDatabase(async (client) => {
    printJson(await collectMetrics(client));
  });
}

async function runShow(args: readonly string[]): Promise<void> {
  if (args.length !== 1) usage();
  await withDatabase(async (client) => {
    printJson(await showKnowledgeObject(client, requiredArgument(args[0], "object id")));
  });
}

function listScopeId(args: readonly string[]): string {
  if (args.length !== 2 || args[0] !== "--scope") usage();
  return requiredArgument(args[1], "scope id");
}

async function runList(args: readonly string[]): Promise<void> {
  await withDatabase(async (client) => {
    printJson(await listKnowledgeObjects(client, listScopeId(args)));
  });
}

async function runVerify(args: readonly string[]): Promise<void> {
  if (args.length !== 1) usage();
  await withDatabase(async (client) => {
    const result = await verifyObject(client, requiredArgument(args[0], "object id"));
    printJson({ object: result.object, also_review: result.alsoReview });
  });
}

async function runTransition(args: readonly string[]): Promise<void> {
  if (args.length !== 2) usage();
  await withDatabase(async (client) => {
    const result = await transitionObject(
      client,
      requiredArgument(args[0], "object id"),
      requiredArgument(args[1], "status") as KnowledgeObject["status"],
    );
    printJson({ version: result.version });
  });
}

async function runRetract(args: readonly string[]): Promise<void> {
  if (args.length !== 1) usage();
  await withDatabase(async (client) => {
    const result = await transitionObject(
      client,
      requiredArgument(args[0], "object id"),
      "retracted",
    );
    printJson({ version: result.version });
  });
}

async function runImpact(args: readonly string[]): Promise<void> {
  if (args.length !== 1) usage();
  await withDatabase(async (client) => {
    printJson(await requirementImpact(client, requiredArgument(args[0], "requirement id")));
  });
}

async function runPack(args: readonly string[]): Promise<void> {
  const action = args[0];
  if (action === "diff") {
    if (args.length !== 3) usage();
    await withDatabase(async (client) => {
      printJson(
        await diffStoredContextPacks(
          client,
          requiredArgument(args[1], "left pack id"),
          requiredArgument(args[2], "right pack id"),
        ),
      );
    });
    return;
  }
  if (action === "reproduce") {
    if (args.length !== 2) usage();
    await withDatabase(async (client) => {
      printJson(await reproduceContextPack(client, requiredArgument(args[1], "pack id")));
    });
    return;
  }
  usage();
}

export async function runCli(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const command = argv[0];
  const args = argv.slice(1);
  if (command === "migrate") {
    if (args.length !== 0) usage();
    await migrate();
  } else if (command === "mcp") {
    if (args.length !== 0) usage();
    await runStdioMcp();
  } else if (command === "serve") {
    if (args[1] !== undefined && args[0] !== "--http") usage();
    if (args[0] !== "--http") usage();
    await runHttpMcp(serveArguments(args));
  } else if (command === "backfill") {
    if (args[0] === "new") {
      await runBackfillNew(args.slice(1));
    } else {
      await runBackfill(args);
    }
  } else if (command === "triage") {
    await runTriage(args);
  } else if (command === "show") {
    await runShow(args);
  } else if (command === "list") {
    await runList(args);
  } else if (command === "verify") {
    await runVerify(args);
  } else if (command === "supersede") {
    await runSupersede(args);
  } else if (command === "transition") {
    await runTransition(args);
  } else if (command === "retract") {
    await runRetract(args);
  } else if (command === "impact") {
    await runImpact(args);
  } else if (command === "scope") {
    await runScope(args);
  } else if (command === "pack") {
    await runPack(args);
  } else if (command === "metrics") {
    await runMetrics(args);
  } else if (command === "relitigation") {
    await runRelitigation(args);
  } else if (command === "maintenance") {
    await runMaintenanceCommand(args);
  } else {
    usage();
  }
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
