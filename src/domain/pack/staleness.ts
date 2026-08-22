import type { KnowledgeObject } from "../entity/types.js";
import type { StalenessMarker } from "./types.js";

const NOT_APPLICABLE: StalenessMarker = {
  state: "not_applicable",
  kind: "none",
  thresholdDays: null,
};

function thresholdDays(object: KnowledgeObject): number | null {
  switch (object.type) {
    case "constraint":
      return 90;
    case "decision":
      return object.attributes.reversibility === "one_way" ? null : 180;
    case "requirement":
      return 180;
    case "open_question":
      return object.attributes.blocking ? 30 : null;
    case "observation":
    case "hypothesis":
    case "glossary_entry":
    case "artifact":
    case "discussion":
      return null;
  }
}

export function stalenessMarker(object: KnowledgeObject, evaluatedAt: Date): StalenessMarker {
  const threshold = thresholdDays(object);
  if (threshold === null || object.lastVerifiedAt === null) {
    return NOT_APPLICABLE;
  }
  const age = evaluatedAt.getTime() - object.lastVerifiedAt.getTime();
  const stale = age > threshold * 24 * 60 * 60 * 1000;
  return {
    state: stale ? "stale" : "fresh",
    kind: "computed",
    thresholdDays: threshold,
  };
}

export function noStalenessMarker(): StalenessMarker {
  return NOT_APPLICABLE;
}
