import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { DomainError, ErrorCode } from "../../domain/errors.js";
import { assertUuid } from "../../domain/identity.js";
import {
  assembleContextPack,
  classifyReproductionDivergence,
  diffContextPackRecipes,
  REPRODUCTION_DISCRIMINATOR_LIMIT,
  resolveChain,
  projectOf,
  resolveLabel,
  type ContextPack,
  type ContextPackIntent,
  type ContextPackRequest,
  type ContextPackDiff,
  type PackWorkingSet,
  type ReproductionDivergence,
} from "../../domain/index.js";
import { activeAtVersion } from "../../domain/label/normalise.js";
import {
  readGraphSnapshot,
  loadCurationActionsAfter,
  loadContextPackRecipe,
  loadPackWorkingSet,
  storeContextPackRecipe,
} from "../../infrastructure/persistence/read.js";

export type BuildContextPackInput = {
  readonly scopeId: string;
  readonly feature?: readonly string[];
  readonly glossaryEntryIds?: readonly string[];
  readonly intent: ContextPackIntent | "investigation";
  readonly budget: number;
  readonly graphVersion?: number;
  readonly builtAt?: Date;
};

export type StoredContextPack = {
  readonly id: string;
  readonly pack: ContextPack;
};

function normaliseIntent(intent: BuildContextPackInput["intent"]): ContextPackIntent {
  if (intent === "investigation") return "debug";
  if (
    intent === "implementation" ||
    intent === "review" ||
    intent === "debug" ||
    intent === "architecture" ||
    intent === "onboarding" ||
    intent === "planning"
  ) {
    return intent;
  }
  throw new DomainError(
    ErrorCode.INTENT_UNKNOWN,
    `unknown intent "${String(intent)}"; valid intents: implementation, review, debug, architecture, onboarding, planning, investigation`,
  );
}

export function resolveFeatureLabelIds(
  input: readonly string[] | undefined,
  set: PackWorkingSet,
  scopeId: string,
  version: number,
): readonly string[] {
  if (input === undefined || input.length === 0) return [];
  const scopeById = new Map(set.scopes.map((scope) => [scope.id, scope]));
  const chain = resolveChain(scopeId, scopeById);
  const project = projectOf(chain);
  if (project === undefined) {
    throw new DomainError(ErrorCode.UNKNOWN_LABEL, `scope has no owning Project: ${scopeId}`);
  }
  const registry = { labels: set.labels, aliases: set.aliases };
  return input.map((value) => {
    const direct = set.labels.find(
      (label) =>
        label.id === value &&
        label.projectScopeId === project.id &&
        activeAtVersion(label.validFromVersion, label.validToVersion, version),
    );
    if (direct !== undefined) return direct.id;
    const resolution = resolveLabel(value, project.id, version, registry);
    if (resolution.kind !== "resolved") {
      throw new DomainError(ErrorCode.UNKNOWN_LABEL, `unknown feature label: ${value}`);
    }
    return resolution.labelId;
  });
}

function requestFromRecipe(recipe: StoredContextPack["pack"]["recipe"]): ContextPackRequest {
  return {
    scopeId: recipe.scopeId,
    featureLabelIds: recipe.featureLabelIds,
    glossaryEntryIds: recipe.glossaryEntryIds,
    intent: recipe.intent,
    budget: recipe.budget,
    graphVersion: recipe.graphVersion,
    builtAt: recipe.builtAt,
  };
}

export async function buildContextPack(
  client: Client,
  input: BuildContextPackInput,
): Promise<StoredContextPack> {
  const { version: current, set } = await readGraphSnapshot(client, { requireVersion: true });
  const graphVersion = input.graphVersion ?? current.version;
  const request: ContextPackRequest = {
    scopeId: input.scopeId,
    featureLabelIds: resolveFeatureLabelIds(input.feature, set, input.scopeId, graphVersion),
    glossaryEntryIds: input.glossaryEntryIds ?? [],
    intent: normaliseIntent(input.intent),
    budget: input.budget,
    graphVersion,
    builtAt: input.builtAt ?? new Date(),
  };
  const pack = assembleContextPack(set, request);
  const id = randomUUID();
  await storeContextPackRecipe(client, pack.recipe, id);
  return { id, pack };
}

function divergenceDetail(divergence: ReproductionDivergence): string {
  const explained = divergence.explained
    .map((item) => `${item.objectId} (${item.by.join(", ")})`)
    .join("; ");
  const parts: string[] = [];
  if (explained !== "") parts.push(`changed by recorded curation: ${explained}`);
  if (divergence.unexplained.length > 0) {
    parts.push(`changed with no recorded curation: ${divergence.unexplained.join(", ")}`);
  }
  if (parts.length === 0) parts.push("selection membership is unchanged; only the order differs");
  return parts.join("; ");
}

export async function reproduceContextPack(client: Client, id: string): Promise<StoredContextPack> {
  const recipe = await loadContextPackRecipe(client, id);
  const set = await loadPackWorkingSet(client);
  const pack = assembleContextPack(set, requestFromRecipe(recipe));
  if (pack.recipe.contentHash !== recipe.contentHash) {
    /*
     * Both outcomes still refuse to return a differing pack. They differ in
     * what they claim about the graph, which is the whole point: one says
     * ordinary curation moved rows under a pack that predates it, the other
     * says objects changed that nothing on the record accounts for.
     */
    const actions = await loadCurationActionsAfter(client, recipe.graphVersion);
    const divergence = classifyReproductionDivergence(recipe, pack.recipe, actions);
    const summary =
      `pack ${id} reproduced with ${pack.recipe.contentHash}; expected ${recipe.contentHash}. ` +
      `${divergenceDetail(divergence)}.`;
    if (divergence.benign) {
      throw new DomainError(
        ErrorCode.PACK_MUTATED_BY_CURATION,
        `${summary} Every object selected differently is named by a curation transaction ` +
          `later than the pinned version v${recipe.graphVersion}, so this pack predates ` +
          `changes to objects it covers rather than indicating an altered graph. ` +
          REPRODUCTION_DISCRIMINATOR_LIMIT,
      );
    }
    throw new DomainError(
      ErrorCode.PACK_HASH_MISMATCH,
      `${summary} No curation transaction after v${recipe.graphVersion} accounts for this, ` +
        `so the graph does not match its own recorded history.`,
    );
  }
  return { id, pack };
}

export async function diffStoredContextPacks(
  client: Client,
  leftId: string,
  rightId: string,
): Promise<ContextPackDiff> {
  // Both ids are checked before either is looked up. Validating lazily would
  // report a malformed right id only once the left one resolved, so a caller
  // holding two bad ids would fix them one round trip at a time.
  assertUuid(leftId, "pack id");
  assertUuid(rightId, "pack id");
  const left = await loadContextPackRecipe(client, leftId);
  const right = await loadContextPackRecipe(client, rightId);
  const set = await loadPackWorkingSet(client);
  return diffContextPackRecipes(left, right, set.objects);
}
