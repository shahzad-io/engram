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

export const A17_FEATURE_LABELS_UNVERSIONED = "A17_FEATURE_LABELS_UNVERSIONED";

export type ReproductionLimitation = {
  readonly code: string;
  readonly message: string;
  readonly featureLabelIds: readonly string[];
  /** Recorded relabelling transactions later than the pinned version. */
  readonly relabelledSince: readonly string[];
};

/**
 * The limitation a *successful* reproduction still carries.
 *
 * An object's `feature_label_ids` is not version-windowed (A17), so reselecting
 * a feature-filtered pack reads today's label sets rather than the pinned
 * version's. A matching hash therefore shows that nothing has been relabelled
 * yet, not that the selection is the one that was stored — and the two are
 * indistinguishable from the hash alone. Domain Spec A17 and MTS 3.4.1 both
 * require reproduction to say so; reporting it only when a relabel happens to
 * break the hash reports it in exactly the case where it is least needed.
 *
 * Unfiltered packs are unaffected: with no filter, label sets change nothing
 * about selection, and claiming a limitation there would be noise.
 */
export function featureLabelLimitation(
  stored: ContextPackRecipe,
  actionsAfterPinnedVersion: readonly CurationAction[],
): ReproductionLimitation | null {
  if (stored.featureLabelIds.length === 0) return null;
  const relabelledSince = actionsAfterPinnedVersion
    .filter((action) => action.action.includes("relabel"))
    .map((action) => `v${action.version}/${action.action}`);
  const since =
    relabelledSince.length > 0
      ? `Relabelling has been recorded since that version (${relabelledSince.join(", ")}), ` +
        `so this pack's filter was applied to label sets that demonstrably are not the ones it was built from.`
      : `No relabelling is recorded since that version, which is the only reason the ` +
        `filter still resolves as it did.`;
  return {
    code: A17_FEATURE_LABELS_UNVERSIONED,
    featureLabelIds: [...stored.featureLabelIds],
    relabelledSince,
    message:
      `This pack was filtered on feature labels, and an object's label set is not ` +
      `version-windowed (A17). Reselection read the label sets objects hold now, not ` +
      `the ones they held at v${stored.graphVersion}. ${since} A matching hash shows ` +
      `that nothing this pack selects has been relabelled yet, not that the selection ` +
      `is the one that was stored.`,
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
