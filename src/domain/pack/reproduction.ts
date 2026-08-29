/**
 * Tells a benign reproduction failure from a suspicious one.
 *
 * Reproduction reselects from the graph at the version a pack pinned and
 * compares hashes. A mismatch was specified to mean the graph had been altered
 * behind the engine's back, but ordinary curation produces one too: `status`,
 * `valid_to_version` and `feature_label_ids` are mutable and unversioned, so
 * superseding or transitioning an object changes what every earlier pack in its
 * scope chain selects.
 *
 * Every curation transaction records the ids it touched. An object that now
 * selects differently and is named by a transaction later than the pinned
 * version has an innocent explanation on the record; one that is not named has
 * none. That is the whole discriminator, and it needs no data the graph does
 * not already keep.
 */
import type { ContextPackRecipe } from "./types.js";

export type CurationAction = {
  readonly version: number;
  readonly action: string;
  readonly objectIds: readonly string[];
};

export type ObjectExplanation = {
  readonly objectId: string;
  /** Recorded transactions naming this object, as `v7/supersede.artifact`. */
  readonly by: readonly string[];
};

export type ReproductionDivergence = {
  readonly differing: readonly string[];
  readonly explained: readonly ObjectExplanation[];
  readonly unexplained: readonly string[];
  /**
   * True only when every differing object is accounted for by a recorded
   * transaction. A membership-identical reordering is never benign: there is
   * nothing to attribute it to, so it cannot be explained away.
   */
  readonly benign: boolean;
};

function membership(recipe: ContextPackRecipe): ReadonlySet<string> {
  return new Set([...recipe.orderedObjectIds, ...recipe.droppedObjectIds]);
}

export function classifyReproductionDivergence(
  stored: ContextPackRecipe,
  reselected: ContextPackRecipe,
  actionsAfterPinnedVersion: readonly CurationAction[],
): ReproductionDivergence {
  const before = membership(stored);
  const after = membership(reselected);
  const differing = [
    ...[...after].filter((id) => !before.has(id)),
    ...[...before].filter((id) => !after.has(id)),
  ].sort();

  const explained: ObjectExplanation[] = [];
  const unexplained: string[] = [];
  for (const objectId of differing) {
    const by = actionsAfterPinnedVersion
      .filter((action) => action.objectIds.includes(objectId))
      .map((action) => `v${action.version}/${action.action}`);
    if (by.length > 0) {
      explained.push({ objectId, by });
    } else {
      unexplained.push(objectId);
    }
  }

  return {
    differing,
    explained,
    unexplained,
    benign: differing.length > 0 && unexplained.length === 0,
  };
}

/**
 * The caveat travels with the error rather than living in a document, because
 * the person who needs it is reading a failure message.
 */
export const REPRODUCTION_DISCRIMINATOR_LIMIT =
  "This check is necessary, not sufficient: a mutation to an object that a " +
  "recorded transaction also touched is indistinguishable from that " +
  "transaction's own effect, and is masked.";
