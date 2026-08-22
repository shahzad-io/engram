import type { KnowledgeObject } from "../entity/types.js";
import type { Relation } from "../relation/legality.js";
import type { BackfillDuplicateWarning, BackfillDuplicateWarningReason } from "./types.js";

/**
 * MTS 14.5 leaves the trigram threshold configurable. This deliberately
 * reports hints instead of blocking import; the low threshold keeps the
 * check useful for hand-authored titles whose wording varies.
 */
export const BACKFILL_DUPLICATE_TRIGRAM_THRESHOLD = 0.18;

function normaliseTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function trigrams(value: string): ReadonlySet<string> {
  const result = new Set<string>();
  for (const word of value.split(" ").filter(Boolean)) {
    const padded = `  ${word} `;
    for (let index = 0; index <= padded.length - 3; index += 1) {
      result.add(padded.slice(index, index + 3));
    }
  }
  return result;
}

function trigramSimilarity(left: string, right: string): number {
  const leftTrigrams = trigrams(normaliseTitle(left));
  const rightTrigrams = trigrams(normaliseTitle(right));
  let intersection = 0;
  for (const trigram of leftTrigrams) {
    if (rightTrigrams.has(trigram)) intersection += 1;
  }
  const union = leftTrigrams.size + rightTrigrams.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function originSet(objectId: string, relations: readonly Relation[]): readonly string[] {
  return relations
    .filter(
      (relation) =>
        relation.sourceId === objectId &&
        relation.relation === "derives_from" &&
        relation.targetKind === "knowledge_object",
    )
    .map((relation) => relation.targetId)
    .sort((left, right) => left.localeCompare(right));
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function warningReason(
  left: KnowledgeObject,
  right: KnowledgeObject,
  relations: readonly Relation[],
): { readonly reason: BackfillDuplicateWarningReason; readonly similarity: number | null } | null {
  const leftTitle = normaliseTitle(left.title);
  const rightTitle = normaliseTitle(right.title);
  if (leftTitle !== "" && leftTitle === rightTitle) {
    return { reason: "normalised_title", similarity: 1 };
  }

  const similarity = trigramSimilarity(left.title, right.title);
  if (similarity >= BACKFILL_DUPLICATE_TRIGRAM_THRESHOLD) {
    return {
      reason: "trigram_title",
      similarity: Number(similarity.toFixed(3)),
    };
  }

  const leftOrigins = originSet(left.id, relations);
  const rightOrigins = originSet(right.id, relations);
  if (leftOrigins.length > 0 && sameValues(leftOrigins, rightOrigins)) {
    return { reason: "identical_origin_set", similarity: null };
  }
  return null;
}

export function detectBackfillDuplicates(
  objects: readonly KnowledgeObject[],
  relations: readonly Relation[],
  sourceById: ReadonlyMap<string, string>,
): readonly BackfillDuplicateWarning[] {
  const warnings: BackfillDuplicateWarning[] = [];
  const ordered = [...objects].sort(
    (left, right) => left.type.localeCompare(right.type) || left.id.localeCompare(right.id),
  );
  for (let leftIndex = 0; leftIndex < ordered.length; leftIndex += 1) {
    const left = ordered[leftIndex];
    if (left === undefined) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < ordered.length; rightIndex += 1) {
      const right = ordered[rightIndex];
      if (right === undefined || left.type !== right.type || left.scopeId !== right.scopeId) {
        continue;
      }
      const result = warningReason(left, right, relations);
      if (result === null) continue;
      const objectIds = [left.id, right.id] as const;
      const sourcePaths = [
        sourceById.get(left.id) ?? "backfill",
        sourceById.get(right.id) ?? "backfill",
      ] as const;
      warnings.push({
        objectIds,
        sourcePaths,
        reason: result.reason,
        similarity: result.similarity,
        message: `structural near-duplicate: ${left.id} and ${right.id} (${result.reason})`,
      });
    }
  }
  return warnings;
}
