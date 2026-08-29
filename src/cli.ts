#!/usr/bin/env node
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import {
  acceptCandidate,
  addScope,
  aggregateCandidatePayload,
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
  selectCandidateElements,
  reproduceContextPack,
  rejectCandidate,
  requirementImpact,
  runMaintenance,
  supersedeObject,
  transitionObject,
  verifyObject,
} from "./application/index.js";
import { BACKFILL_TYPE_SPECS, isBackfillType } from "./domain/backfill/index.js";
import { DomainError, ErrorCode } from "./domain/errors.js";
import type { KnowledgeObject, KnowledgeObjectType } from "./domain/entity/types.js";
import type { RelationVerb, RelationTargetKind } from "./domain/relation/legality.js";
import type { ScopeKind } from "./domain/scope/types.js";
import type {
  CandidateObjectWrite,
  CandidatePayload,
  KnowledgeObjectWrite,
  RelationRepointWrite,
  RelationWrite,
  ScopeWrite,
} from "./application/write/index.js";
import { loadEnvFile, requireEnv } from "./infrastructure/env.js";
import { migrate } from "./infrastructure/persistence/migration-runner.js";
import { getCurrentGraphVersionOrZero } from "./infrastructure/persistence/read.js";
import { runHttpMcp, runStdioMcp } from "./mcp/index.js";
import { camelCaseKeys, errorPayload, snakeCaseKeys } from "./wire/envelope.js";

const USAGE = `Usage:
  pke migrate
  pke mcp
  pke serve --http [--host HOST] [--port PORT]
  pke triage
  pke triage accept <candidate-id> [--elements <candidate-id>...]
  pke triage payload <candidate-id> [--elements <candidate-id>...]
  pke triage edit <candidate-id> [--elements <candidate-id>...] [--payload <file|->]
  pke triage merge <candidate-id> --into <object-id> [--elements <candidate-id>]
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
  pke backfill new <type> [--id ID]

--elements is the one selection flag; --element and --only are not accepted.
Omitting it applies the command to every pending element of the group when the
id names the group root, and to that element alone when it names a child.

Add --json to any command except migrate, mcp, serve and backfill for
machine-readable output: a stable envelope with snake_case field names, the
graph version, and { error: { code, message, failures } } on failure. Without
it, output is unchanged and stays human-facing.`;

/**
 * `reason` says what was wrong with the invocation. The usage text follows it
 * so a human still gets the full surface, while a caller keys on the code and
 * reads the first line.
 */
function usage(reason?: string): never {
  throw new DomainError(
    ErrorCode.INVALID_USAGE,
    reason === undefined ? USAGE : `${reason}\n\n${USAGE}`,
  );
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
    throw new DomainError(
      ErrorCode.INVALID_ARGUMENT,
      `${id} does not use the ${spec.idPrefix}-NNNN id format`,
    );
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
      throw new DomainError(
        ErrorCode.INVALID_ARGUMENT,
        `backfill object already exists: ${target}`,
      );
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

/**
 * The report is on the output stream before the file is attempted, so a
 * failing `--report` path cannot destroy the only copy of it.
 *
 * `committed` distinguishes the two ways this can go wrong. A dry run that
 * cannot write its report simply failed. An import that committed and then
 * could not write its report must say so, or a caller reading the non-zero
 * exit will re-run an import that already succeeded.
 */
async function writeBackfillReport(
  reportPath: string | null,
  text: string,
  committed: boolean,
): Promise<boolean> {
  if (reportPath === null) return true;
  try {
    await writeFile(reportPath, `${text}\n`, "utf8");
    return true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(
      committed
        ? `backfill committed. Writing the report to ${reportPath} failed: ${reason}. ` +
            `The report above is the only copy; do not re-run the import.`
        : `writing the report to ${reportPath} failed: ${reason}`,
    );
    return false;
  }
}

/**
 * Signals a backfill failure that has already been rendered to a stream.
 *
 * `runBackfill` cannot set `process.exitCode` itself. It returns to `dispatch`,
 * which returns null for a self-printing command, so `runCli` sees a command
 * that did not throw and returns `exitCode: 0`; the entry point then assigns
 * that 0 over whatever the command had set. Two assignments were written that
 * way and both were dead, so a dry run reporting failures exited 0 and a
 * caller reading the exit code saw success.
 *
 * Throwing carries the failure into the one path that sets the exit code. The
 * report is already on the stream by then; this only supplies the reason.
 */
class BackfillReportedFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackfillReportedFailure";
  }
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
    console.log(text);
    const committed = !options.dryRun && report.failures.length === 0;
    const written = await writeBackfillReport(options.reportPath, text, committed);
    if (report.failures.length > 0) {
      throw new BackfillReportedFailure(
        `backfill reported ${report.failures.length} failure(s); see the report above`,
      );
    }
    if (!written) {
      throw new BackfillReportedFailure(
        `backfill could not write its report to ${String(options.reportPath)}`,
      );
    }
  } catch (error) {
    if (error instanceof BackfillImportError) {
      const text = JSON.stringify(error.report, null, 2);
      console.error(text);
      await writeBackfillReport(options.reportPath, text, false);
      throw new BackfillReportedFailure(error.message);
    }
    throw error;
  } finally {
    await closeQuietly(client);
  }
}

/**
 * What a command produced. `graphVersion` is the version the graph stood at
 * when the command finished, so a caller can tell whether a cached pack it
 * holds is still current.
 */
type CommandOutput = {
  readonly data: unknown;
  readonly graphVersion: number | null;
};

/**
 * Commands that manage their own stdout. They keep their existing contract and
 * refuse `--json` rather than emitting an envelope wrapped around prose.
 */
const SELF_PRINTING_COMMANDS = new Set(["migrate", "mcp", "serve", "backfill"]);

type Connected<T> = {
  readonly value: T;
  readonly graphVersion: number | null;
};

/**
 * Best effort: a command that already succeeded must not be reported as having
 * failed because reading the version afterwards did.
 */
async function currentGraphVersion(client: Client): Promise<number | null> {
  try {
    return (await getCurrentGraphVersionOrZero(client)).version;
  } catch {
    return null;
  }
}

/**
 * Closing the connection happens after the work has already committed or
 * rolled back, so a teardown failure cannot change what the graph now holds.
 * Letting it propagate would report a committed write as a failed one, which
 * is the more damaging of the two lies.
 */
async function closeQuietly(client: Client): Promise<void> {
  try {
    await client.end();
  } catch (error) {
    // The command's outcome is already decided, but a connection that will not
    // close is worth seeing: it is stderr rather than the result, not nothing.
    console.error(
      `[pke] database connection did not close cleanly: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * A command that read a version alongside its own data reports that one.
 *
 * Reading the version again here would pair the payload with a version read
 * strictly later, so a write landing in between would put two different
 * versions in one response: the envelope claiming one thing about the graph and
 * the body it wraps claiming another.
 */
function versionAlreadyRead(value: unknown): number | undefined {
  if (isRecord(value) && typeof value.graphVersion === "number") {
    return value.graphVersion;
  }
  return undefined;
}

async function withDatabase<T>(work: (client: Client) => Promise<T>): Promise<Connected<T>> {
  await loadEnvFile();
  const client = new Client({ connectionString: requireEnv("PKE_DATABASE_URL") });
  await client.connect();
  try {
    const value = await work(client);
    const own = versionAlreadyRead(value);
    return { value, graphVersion: own ?? (await currentGraphVersion(client)) };
  } finally {
    await closeQuietly(client);
  }
}

async function fromDatabase<T>(work: (client: Client) => Promise<T>): Promise<CommandOutput> {
  const { value, graphVersion } = await withDatabase(work);
  return { data: value, graphVersion };
}

function serialise(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredArgument(value: string | undefined, name: string): string {
  if (value === undefined || value === "") {
    throw new DomainError(ErrorCode.MISSING_ARGUMENT, `missing ${name}`);
  }
  return value;
}

const SCOPE_KINDS = ["global", "project", "workstream", "phase"] as const;

function isScopeKind(value: string): value is (typeof SCOPE_KINDS)[number] {
  return (SCOPE_KINDS as readonly string[]).includes(value);
}

/** Spellings that once worked and now point at the one that does. */
const SELECTION_ALIASES = new Set(["--element", "--only", "--elems", "--ids"]);

type TriageOptions = {
  readonly selectedIds: readonly string[] | undefined;
  readonly payload: string | null;
  readonly into: string | null;
};

/**
 * Flag parsing shared by every triage subcommand that takes a selection, so
 * `--elements` means the same thing and is spelled the same way everywhere.
 */
function triageArguments(
  args: readonly string[],
  allow: { readonly payload?: boolean; readonly into?: boolean } = {},
): TriageOptions {
  const selection: string[] = [];
  let payload: string | null = null;
  let into: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--payload") {
      if (allow.payload !== true) usage("--payload is only accepted by pke triage edit");
      if (payload !== null) usage("--payload was given more than once");
      payload = requiredArgument(args[index + 1], "--payload <file|->");
      index += 1;
    } else if (arg === "--into") {
      if (allow.into !== true) usage("--into is only accepted by pke triage merge");
      if (into !== null) usage("--into was given more than once");
      into = requiredArgument(args[index + 1], "--into <object-id>");
      index += 1;
    } else if (arg === "--elements") {
      if (selection.length > 0) usage("--elements was given more than once");
      while (index + 1 < args.length && !args[index + 1]?.startsWith("--")) {
        selection.push(args[index + 1] as string);
        index += 1;
      }
      if (selection.length === 0) usage("--elements requires at least one candidate id");
    } else if (arg !== undefined && SELECTION_ALIASES.has(arg)) {
      usage(`${arg} is not a flag; the selection flag is --elements <candidate-id>...`);
    } else {
      usage(`unrecognised argument: ${String(arg)}`);
    }
  }
  return { selectedIds: selection.length > 0 ? selection : undefined, payload, into };
}

function editedCandidatePayload(value: unknown): CandidatePayload {
  if (!isRecord(value) || !Array.isArray(value.objects)) {
    throw new DomainError(
      ErrorCode.INVALID_PAYLOAD,
      "edited candidate file must contain an objects array",
    );
  }
  return {
    objects: value.objects as CandidateObjectWrite[],
    relations: Array.isArray(value.relations) ? (value.relations as RelationWrite[]) : [],
  };
}

function editorArgv(): readonly string[] {
  const editor = process.env.VISUAL?.trim() || process.env.EDITOR?.trim();
  if (editor === undefined || editor === "") {
    throw new DomainError(
      ErrorCode.EDITOR_UNAVAILABLE,
      "$EDITOR or $VISUAL is required for this command. Use --payload <file|-> to supply the edited JSON without an editor.",
    );
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
    throw new DomainError(ErrorCode.EDITOR_UNAVAILABLE, "$EDITOR or $VISUAL has an unclosed quote");
  }
  if (current.length > 0) {
    parts.push(current);
  }
  if (parts.length === 0 || parts[0] === undefined) {
    throw new DomainError(
      ErrorCode.EDITOR_UNAVAILABLE,
      "$EDITOR or $VISUAL is required for this command. Use --payload <file|-> to supply the edited JSON without an editor.",
    );
  }
  return parts;
}

/**
 * Opens a document in $EDITOR and returns what came back, refusing to proceed
 * unless the file actually changed.
 *
 * A GUI editor invoked without a wait flag forks and exits 0 immediately. The
 * untouched buffer would otherwise read back as a deliberate edit, and the
 * caller would commit AI-authored content recorded as curator-reviewed. There
 * is no way to tell that case apart from a genuine no-op edit, and no
 * blocklist of editor names would catch the one nobody thought of, so an
 * unchanged file is always a refusal.
 *
 * The temp file survives every failure: on the GUI path the editor window is
 * about to open onto it, and on a parse failure it holds work the curator
 * would otherwise lose.
 */
async function editJsonFile(
  initial: unknown,
  filename: string,
  resubmitFlag: string,
): Promise<unknown> {
  const directory = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "pke-cli-"));
  const target = path.join(directory, filename);
  const before = `${JSON.stringify(initial, null, 2)}\n`;
  await writeFile(target, before, "utf8");

  const argv = editorArgv();
  const result = spawnSync(argv[0] as string, [...argv.slice(1), target], { stdio: "inherit" });
  if (result.error !== undefined || result.status !== 0) {
    await rm(directory, { recursive: true, force: true });
    if (result.error !== undefined) throw result.error;
    throw new DomainError(
      ErrorCode.EDITOR_FAILED,
      `editor exited with status ${String(result.status)}`,
    );
  }

  const after = await readFile(target, "utf8");
  if (after === before) {
    throw new DomainError(
      ErrorCode.EDIT_UNCHANGED,
      `the editor exited without changing the file, so there is no edit to apply. ` +
        `Most GUI editors return immediately unless given a wait flag such as --wait. ` +
        `The document is preserved at ${target}: edit it and resubmit with ` +
        `${resubmitFlag} ${target}. To approve the proposal as written, use pke triage accept, ` +
        `which records it as authored by the proposer rather than by you.`,
    );
  }

  try {
    const parsed = JSON.parse(after) as unknown;
    await rm(directory, { recursive: true, force: true });
    return parsed;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new DomainError(
        ErrorCode.EDIT_INVALID_JSON,
        `the edited document is not valid JSON. Your edit is preserved at ${target}: ` +
          `correct it and resubmit with ${resubmitFlag} ${target}.`,
      );
    }
    throw error;
  }
}

/** `-` reads the document from stdin, so a caller need not write a temp file. */
async function readPayloadDocument(source: string): Promise<unknown> {
  const text =
    source === "-"
      ? await new Promise<string>((resolve, reject) => {
          let buffered = "";
          process.stdin.setEncoding("utf8");
          process.stdin.on("data", (chunk) => (buffered += chunk));
          process.stdin.on("end", () => resolve(buffered));
          process.stdin.on("error", reject);
        })
      : await readFile(source, "utf8");
  try {
    // Accepted in either spelling: `pke triage payload --json` hands the
    // document out in snake_case, and it must be submittable unaltered.
    return camelCaseKeys(JSON.parse(text));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new DomainError(
        ErrorCode.EDIT_INVALID_JSON,
        `payload ${source === "-" ? "on stdin" : source} is not valid JSON`,
      );
    }
    throw error;
  }
}

async function runTriage(args: readonly string[]): Promise<CommandOutput> {
  const action = args[0];
  if (action === undefined || action === "list") {
    if (action === "list" && args.length !== 1) usage("pke triage list takes no arguments");
    return fromDatabase((client) => listTriage(client));
  }

  const candidateId = requiredArgument(args[1], "candidate id");
  if (action === "accept") {
    const { selectedIds } = triageArguments(args.slice(2));
    return fromDatabase((client) => acceptCandidate(client, candidateId, selectedIds));
  }
  if (action === "payload") {
    const { selectedIds } = triageArguments(args.slice(2));
    return fromDatabase(async (client) => {
      const group = await getCandidateGroup(client, candidateId);
      const selected = selectCandidateElements(group, candidateId, selectedIds).map(
        (candidate) => candidate.id,
      );
      return {
        candidate_id: candidateId,
        element_ids: selected,
        payload: aggregateCandidatePayload(group, selected),
      };
    });
  }
  if (action === "edit") {
    const options = triageArguments(args.slice(2), { payload: true });
    // The database is closed while the editor runs, so an abandoned edit
    // cannot hold a connection or a transaction open.
    const prepared = await withDatabase(async (client) => {
      const group = await getCandidateGroup(client, candidateId);
      const selectedIds = selectCandidateElements(group, candidateId, options.selectedIds).map(
        (candidate) => candidate.id,
      );
      return { selectedIds, payload: aggregateCandidatePayload(group, selectedIds) };
    });
    const document =
      options.payload === null
        ? await editJsonFile(prepared.value.payload, "candidate.json", "--payload")
        : await readPayloadDocument(options.payload);
    const edited = editedCandidatePayload(document);
    return fromDatabase((client) =>
      editAndAcceptCandidate(client, candidateId, edited, prepared.value.selectedIds),
    );
  }
  if (action === "merge") {
    const { selectedIds, into } = triageArguments(args.slice(2), { into: true });
    const targetId = requiredArgument(into ?? undefined, "--into <object-id>");
    return fromDatabase((client) => mergeCandidate(client, candidateId, targetId, selectedIds));
  }
  if (action === "reject") {
    if (args.length !== 2) usage("pke triage reject takes a candidate id and no flags");
    return fromDatabase(async (client) => ({
      candidate_ids: await rejectCandidate(client, candidateId),
    }));
  }
  usage(`unknown triage subcommand: ${action}`);
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
  if (!isRecord(value))
    throw new DomainError(ErrorCode.INVALID_PAYLOAD, "supersede file must contain an object");
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
  if (!isRecord(value))
    throw new DomainError(ErrorCode.INVALID_PAYLOAD, "supersede relations must be objects");
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
  if (!isRecord(value))
    throw new DomainError(ErrorCode.INVALID_PAYLOAD, "supersede repoint entries must be objects");
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
  if (!isRecord(value))
    throw new DomainError(ErrorCode.INVALID_PAYLOAD, "supersede file must contain an object");
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

async function runSupersede(args: readonly string[]): Promise<CommandOutput> {
  const options = supersedeArguments(args);
  return fromDatabase(async (client) => {
    const selected = await client.query<SupersedeRow>(
      `SELECT id, type, scope_id, feature_label_ids, title, body, attributes, source_ref
       FROM knowledge_objects
       WHERE id = $1
         AND valid_to_version IS NULL`,
      [options.id],
    );
    const predecessor = selected.rows[0];
    if (predecessor === undefined) {
      throw new DomainError(
        ErrorCode.OBJECT_NOT_FOUND,
        `object ${options.id} does not exist or is not current`,
      );
    }
    const initial = await defaultSupersedeDocument(client, predecessor);
    const document =
      options.file === null
        ? await editJsonFile(initial, "successor.json", "--file")
        : JSON.parse(await readFile(options.file, "utf8"));
    const { object, relations, repoints } = supersedeDocument(document, predecessor.id);
    const result = await supersedeObject(client, object, relations, repoints);
    return { object_id: result.value.objectId, version: result.version };
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
  if (kind === undefined || id === undefined || name === undefined) {
    usage("pke scope create takes <kind> <id> <name>");
  }
  if (!isScopeKind(kind)) {
    throw new DomainError(
      ErrorCode.INVALID_ARGUMENT,
      `invalid scope kind: ${kind}. Expected one of ${SCOPE_KINDS.join(", ")}.`,
    );
  }
  if (kind === "global") {
    if (parentId !== undefined)
      throw new DomainError(ErrorCode.INVALID_ARGUMENT, "global scope cannot have a parent");
    parentId = null;
  } else if (parentId === undefined) {
    usage(`a ${kind} scope requires --parent <scope-id>`);
  }
  return {
    id,
    kind: kind as ScopeKind,
    parentId,
    name,
  };
}

async function runScope(args: readonly string[]): Promise<CommandOutput> {
  const action = args[0];
  if (action === "list") {
    if (args.length !== 1) usage();
    return fromDatabase((client) => listScopeTree(client));
  }
  if (action === "add") {
    return fromDatabase(async (client) => {
      const result = await addScope(client, scopeArguments(args.slice(1)));
      return { scope_id: result.value.scopeId, version: result.version };
    });
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

async function runMaintenanceCommand(args: readonly string[]): Promise<CommandOutput> {
  const requestedDays = maintenanceArguments(args);
  const configuredDays =
    requestedDays === undefined && process.env.PKE_CANDIDATE_EXPIRY_DAYS !== undefined
      ? Number(process.env.PKE_CANDIDATE_EXPIRY_DAYS)
      : requestedDays;
  if (configuredDays !== undefined && (!Number.isFinite(configuredDays) || configuredDays < 0)) {
    throw new DomainError(
      ErrorCode.INVALID_ARGUMENT,
      "PKE_CANDIDATE_EXPIRY_DAYS must be a non-negative number",
    );
  }
  return fromDatabase((client) => runMaintenance(client, { candidateExpiryDays: configuredDays }));
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

async function runRelitigation(args: readonly string[]): Promise<CommandOutput> {
  const options = relitigationArguments(args);
  return fromDatabase(async (client) => {
    const event = await logRelitigationEvent(client, {
      objectId: options.objectId,
      sessionId: options.sessionId,
      packUsed: options.packUsed,
      note: options.note,
    });
    return {
      event_id: event.id,
      observed_at: event.observedAt,
      object_id: event.objectId,
      session_id: event.sessionId,
      pack_used: event.packUsed,
      note: event.note,
    };
  });
}

async function runMetrics(args: readonly string[]): Promise<CommandOutput> {
  if (args.length !== 0) usage();
  return fromDatabase((client) => collectMetrics(client));
}

async function runShow(args: readonly string[]): Promise<CommandOutput> {
  if (args.length !== 1) usage();
  return fromDatabase((client) =>
    showKnowledgeObject(client, requiredArgument(args[0], "object id")),
  );
}

function listScopeId(args: readonly string[]): string {
  if (args.length !== 2 || args[0] !== "--scope") usage();
  return requiredArgument(args[1], "scope id");
}

async function runList(args: readonly string[]): Promise<CommandOutput> {
  return fromDatabase((client) => listKnowledgeObjects(client, listScopeId(args)));
}

async function runVerify(args: readonly string[]): Promise<CommandOutput> {
  if (args.length !== 1) usage();
  return fromDatabase((client) => verifyObject(client, requiredArgument(args[0], "object id")));
}

async function runTransition(args: readonly string[]): Promise<CommandOutput> {
  if (args.length !== 2) usage();
  return fromDatabase(async (client) => {
    const result = await transitionObject(
      client,
      requiredArgument(args[0], "object id"),
      requiredArgument(args[1], "status") as KnowledgeObject["status"],
    );
    return { version: result.version };
  });
}

async function runRetract(args: readonly string[]): Promise<CommandOutput> {
  if (args.length !== 1) usage();
  return fromDatabase(async (client) => {
    const result = await transitionObject(
      client,
      requiredArgument(args[0], "object id"),
      "retracted",
    );
    return { version: result.version };
  });
}

async function runImpact(args: readonly string[]): Promise<CommandOutput> {
  if (args.length !== 1) usage();
  return fromDatabase((client) =>
    requirementImpact(client, requiredArgument(args[0], "requirement id")),
  );
}

async function runPack(args: readonly string[]): Promise<CommandOutput> {
  const action = args[0];
  if (action === "diff") {
    if (args.length !== 3) usage();
    return fromDatabase((client) =>
      diffStoredContextPacks(
        client,
        requiredArgument(args[1], "left pack id"),
        requiredArgument(args[2], "right pack id"),
      ),
    );
  }
  if (action === "reproduce") {
    if (args.length !== 2) usage();
    return fromDatabase((client) =>
      reproduceContextPack(client, requiredArgument(args[1], "pack id")),
    );
  }
  usage();
}

async function dispatch(
  command: string | undefined,
  args: readonly string[],
): Promise<CommandOutput | null> {
  if (command === "migrate") {
    if (args.length !== 0) usage();
    await migrate();
    return null;
  }
  if (command === "mcp") {
    if (args.length !== 0) usage();
    await runStdioMcp();
    return null;
  }
  if (command === "serve") {
    if (args[1] !== undefined && args[0] !== "--http") usage();
    if (args[0] !== "--http") usage();
    await runHttpMcp(serveArguments(args));
    return null;
  }
  if (command === "backfill") {
    if (args[0] === "new") {
      await runBackfillNew(args.slice(1));
    } else {
      await runBackfill(args);
    }
    return null;
  }
  if (command === "triage") return runTriage(args);
  if (command === "show") return runShow(args);
  if (command === "list") return runList(args);
  if (command === "verify") return runVerify(args);
  if (command === "supersede") return runSupersede(args);
  if (command === "transition") return runTransition(args);
  if (command === "retract") return runRetract(args);
  if (command === "impact") return runImpact(args);
  if (command === "scope") return runScope(args);
  if (command === "pack") return runPack(args);
  if (command === "metrics") return runMetrics(args);
  if (command === "relitigation") return runRelitigation(args);
  if (command === "maintenance") return runMaintenanceCommand(args);
  usage();
}

/**
 * `--json` is reserved: it is stripped wherever it appears so that it can
 * follow the subcommand, and therefore cannot be passed as a flag's value.
 */
function extractJsonFlag(argv: readonly string[]): {
  readonly json: boolean;
  readonly rest: readonly string[];
} {
  const rest = argv.filter((argument) => argument !== "--json");
  return { json: rest.length !== argv.length, rest };
}

const SUBCOMMANDED = new Set(["triage", "scope", "pack", "backfill", "relitigation"]);

function commandName(argv: readonly string[]): string {
  const [command, action] = argv;
  if (command === undefined) return "pke";
  if (!SUBCOMMANDED.has(command) || action === undefined || action.startsWith("-")) {
    return command;
  }
  return `${command}.${action}`;
}

async function graphVersionWithoutCommand(): Promise<number | null> {
  try {
    return (await withDatabase(async () => null)).graphVersion;
  } catch {
    return null;
  }
}

export type CliResult = {
  /** Non-zero for every failure, including one already rendered into `payload`. */
  readonly exitCode: number;
  /**
   * Exactly the bytes for stdout, or null when the command produced none or
   * wrote its own (migrate, mcp, serve, backfill, which refuse `--json`).
   */
  readonly stdout: string | null;
  readonly stderr: string | null;
  /**
   * The value `stdout` was serialised from, so a caller can assert on the
   * structure without reparsing what it just watched be stringified.
   */
  readonly payload: unknown;
};

/**
 * Runs one command and reports what happened. Nothing here writes to a stream
 * or sets an exit code: the entry point below turns this result into both, and
 * a test can read the same result the terminal would have shown.
 *
 * A command failure is a return value, not an exception. Anything that escapes
 * `dispatch` — including a bug in Engram — becomes a non-zero result rather
 * than an unhandled rejection, so no caller can observe a failed command as a
 * silent success.
 */
export async function runCli(argv: readonly string[] = process.argv.slice(2)): Promise<CliResult> {
  const { json, rest } = extractJsonFlag(argv);
  const command = rest[0];
  try {
    if (json && SELF_PRINTING_COMMANDS.has(command ?? "")) {
      throw new DomainError(
        ErrorCode.INVALID_USAGE,
        `--json is not available for ${String(command)}`,
      );
    }
    const output = await dispatch(command, rest.slice(1));
    if (!json) {
      // Bare output is unchanged: the data, exactly as it printed before.
      const data = output === null ? null : output.data;
      return {
        exitCode: 0,
        stdout: output === null ? null : serialise(data),
        stderr: null,
        payload: data,
      };
    }
    const envelope = {
      command: commandName(rest),
      graph_version: output?.graphVersion ?? null,
      data: snakeCaseKeys(output?.data ?? null),
    };
    return { exitCode: 0, stdout: serialise(envelope), stderr: null, payload: envelope };
  } catch (error) {
    if (!json) {
      return {
        exitCode: 1,
        stdout: null,
        stderr: error instanceof Error ? error.message : String(error),
        payload: null,
      };
    }
    const envelope = {
      command: commandName(rest),
      graph_version: await graphVersionWithoutCommand(),
      error: errorPayload(error),
    };
    return { exitCode: 1, stdout: serialise(envelope), stderr: null, payload: envelope };
  }
}

/**
 * True when this module is the program being run, rather than a module some
 * other program imported.
 *
 * `path.resolve` normalises a path; it does not resolve symlinks. Node resolves
 * the symlink when it loads the module, so `import.meta.url` is the real path
 * while `process.argv[1]` is whatever name the caller used. Compared with
 * `path.resolve` alone the two differ for every symlinked invocation, the guard
 * is false, nothing runs, and the process exits 0 — no output, no error, and a
 * caller reading the exit code is told it succeeded.
 *
 * That is the installed invocation, not an exotic one. `package.json` declares
 * `bin: { pke: "./dist/cli.js" }`, so `npm link` or a global install puts a
 * symlink on PATH, and the usage text tells the curator to run `pke migrate`.
 * Measured before this fix: `pke migrate` through such a symlink produced zero
 * bytes, exited 0, and left the database unmigrated.
 *
 * `realpathSync` on both sides is the comparison the guard always meant. It
 * throws if a path does not exist, which is possible for `argv[1]` under some
 * embeddings, so the previous comparison remains as a fallback rather than
 * letting the guard throw on startup.
 */
function isProgramEntryPoint(): boolean {
  const invokedAs = process.argv[1];
  if (invokedAs === undefined) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return realpathSync(invokedAs) === realpathSync(modulePath);
  } catch {
    return path.resolve(invokedAs) === modulePath;
  }
}

if (isProgramEntryPoint()) {
  const result = await runCli();
  if (result.stdout !== null) console.log(result.stdout);
  if (result.stderr !== null) console.error(result.stderr);
  process.exitCode = result.exitCode;
}
