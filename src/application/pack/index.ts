import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { DomainError, ErrorCode } from "../../domain/errors.js";
import {
  assembleContextPack,
  diffContextPackRecipes,
  resolveChain,
  projectOf,
  resolveLabel,
  type ContextPack,
  type ContextPackIntent,
  type ContextPackRequest,
  type ContextPackDiff,
  type PackWorkingSet,
} from "../../domain/index.js";
import { activeAtVersion } from "../../domain/label/normalise.js";
import {
  getCurrentGraphVersion,
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
  const set = await loadPackWorkingSet(client);
  const current = await getCurrentGraphVersion(client);
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

export async function reproduceContextPack(client: Client, id: string): Promise<StoredContextPack> {
  const recipe = await loadContextPackRecipe(client, id);
  const set = await loadPackWorkingSet(client);
  const pack = assembleContextPack(set, requestFromRecipe(recipe));
  if (pack.recipe.contentHash !== recipe.contentHash) {
    throw new DomainError(
      ErrorCode.PACK_HASH_MISMATCH,
      `pack ${id} reproduced with ${pack.recipe.contentHash}; expected ${recipe.contentHash}`,
    );
  }
  return { id, pack };
}

export async function diffStoredContextPacks(
  client: Client,
  leftId: string,
  rightId: string,
): Promise<ContextPackDiff> {
  const [left, right, set] = await Promise.all([
    loadContextPackRecipe(client, leftId),
    loadContextPackRecipe(client, rightId),
    loadPackWorkingSet(client),
  ]);
  return diffContextPackRecipes(left, right, set.objects);
}
