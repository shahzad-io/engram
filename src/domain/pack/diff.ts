import { DomainError, ErrorCode } from "../errors.js";
import type { KnowledgeObject } from "../entity/types.js";
import type {
  PackWorkingSet,
  ContextPack,
  ContextPackDiff,
  ContextPackRecipe,
  RenderedObject,
} from "./types.js";

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function renderedById(pack: ContextPack): ReadonlyMap<string, RenderedObject> {
  return new Map(
    pack.sections.flatMap((section) => section.objects).map((object) => [object.id, object]),
  );
}

export function diffContextPacks(
  left: ContextPack,
  right: ContextPack,
  workingSet?: PackWorkingSet,
): ContextPackDiff {
  if (
    left.recipe.scopeId !== right.recipe.scopeId ||
    !sameValues(left.recipe.featureLabelIds, right.recipe.featureLabelIds) ||
    !sameValues(left.recipe.glossaryEntryIds, right.recipe.glossaryEntryIds) ||
    left.recipe.intent !== right.recipe.intent
  ) {
    throw new DomainError(
      ErrorCode.PACK_DIFF_INCOMPATIBLE,
      "packs must have the same scope, features, glossary request, and intent",
    );
  }

  const leftIds = left.recipe.orderedObjectIds;
  const rightIds = right.recipe.orderedObjectIds;
  const leftSet = new Set(leftIds);
  const rightSet = new Set(rightIds);
  const added = rightIds.filter((id) => !leftSet.has(id));
  const removed = leftIds.filter((id) => !rightSet.has(id));
  const unchanged = leftIds.filter((id) => rightSet.has(id));
  const successors = new Map(
    workingSet?.objects
      .filter((object) => object.supersedesId !== null)
      .map((object) => [object.id, object.supersedesId as string]) ?? [],
  );
  const removedSet = new Set(removed);
  const superseded = added
    .map((successorId) => {
      const predecessorId = successors.get(successorId);
      return predecessorId !== undefined && removedSet.has(predecessorId)
        ? { predecessorId, successorId }
        : null;
    })
    .filter((pair): pair is { predecessorId: string; successorId: string } => pair !== null);

  const leftRendered = renderedById(left);
  const rightRendered = renderedById(right);
  const markerChanges = unchanged.filter((id) => {
    const before = leftRendered.get(id);
    const after = rightRendered.get(id);
    if (before === undefined || after === undefined) return false;
    return (
      before.reviewRequired !== after.reviewRequired ||
      before.staleness.state !== after.staleness.state ||
      before.staleness.kind !== after.staleness.kind
    );
  });

  return {
    added,
    removed,
    superseded,
    unchanged,
    markerChanges,
  };
}

export function diffContextPackRecipes(
  left: ContextPackRecipe,
  right: ContextPackRecipe,
  objects: readonly KnowledgeObject[],
): ContextPackDiff {
  if (
    left.scopeId !== right.scopeId ||
    !sameValues(left.featureLabelIds, right.featureLabelIds) ||
    !sameValues(left.glossaryEntryIds, right.glossaryEntryIds) ||
    left.intent !== right.intent
  ) {
    throw new DomainError(
      ErrorCode.PACK_DIFF_INCOMPATIBLE,
      "pack recipes must have the same scope, features, glossary request, and intent",
    );
  }
  const leftSet = new Set(left.orderedObjectIds);
  const rightSet = new Set(right.orderedObjectIds);
  const added = right.orderedObjectIds.filter((id) => !leftSet.has(id));
  const removed = left.orderedObjectIds.filter((id) => !rightSet.has(id));
  const removedSet = new Set(removed);
  const superseded = added
    .map((successorId) => {
      const successor = objects.find((object) => object.id === successorId);
      return successor?.supersedesId !== null &&
        successor?.supersedesId !== undefined &&
        removedSet.has(successor.supersedesId)
        ? {
            predecessorId: successor.supersedesId,
            successorId,
          }
        : null;
    })
    .filter((pair): pair is { predecessorId: string; successorId: string } => pair !== null);
  return {
    added,
    removed,
    superseded,
    unchanged: left.orderedObjectIds.filter((id) => rightSet.has(id)),
    markerChanges: [],
  };
}
