import type { Client } from "pg";
import type { KnowledgeObject } from "../../domain/entity/types.js";
import { stalenessMarker } from "../../domain/pack/staleness.js";
import {
  getCurrentGraphVersionOrZero,
  loadPackWorkingSet,
} from "../../infrastructure/persistence/read.js";
import { listPendingCandidates } from "../write/candidates.js";
import type { CandidateRecord } from "../write/types.js";

const HYPOTHESIS_REVIEW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1_000;

export type TriageListOptions = {
  readonly now?: Date;
};

export type TriageListResult = {
  readonly graphVersion: number;
  readonly pendingCandidates: readonly CandidateRecord[];
  readonly reviewRequired: readonly KnowledgeObject[];
  readonly staleObjects: readonly KnowledgeObject[];
  readonly exploredHypotheses: readonly KnowledgeObject[];
};

function currentObject(object: KnowledgeObject): boolean {
  return object.validToVersion === null;
}

function staleObject(object: KnowledgeObject, now: Date): boolean {
  if (object.type === "observation") {
    return (
      object.status === "stale" ||
      (object.status === "observed" && object.attributes.reviewBy.getTime() < now.getTime())
    );
  }
  if (!currentObject(object)) return false;
  return stalenessMarker(object, now).state === "stale";
}

export async function listTriage(
  client: Client,
  options: TriageListOptions = {},
): Promise<TriageListResult> {
  const now = options.now ?? new Date();
  const [candidates, set, current] = await Promise.all([
    listPendingCandidates(client),
    loadPackWorkingSet(client),
    getCurrentGraphVersionOrZero(client),
  ]);
  const reviewRequired = set.objects
    .filter((object) => currentObject(object) && object.reviewRequired)
    .sort((left, right) => left.id.localeCompare(right.id));
  const staleObjects = set.objects
    .filter((object) => staleObject(object, now))
    .sort((left, right) => left.id.localeCompare(right.id));
  const exploredHypotheses = set.objects
    .filter(
      (object) =>
        object.type === "hypothesis" &&
        object.status === "explored" &&
        currentObject(object) &&
        now.getTime() - object.createdAt.getTime() > HYPOTHESIS_REVIEW_DAYS * DAY_MS,
    )
    .sort((left, right) => left.id.localeCompare(right.id));

  return {
    graphVersion: current.version,
    pendingCandidates: candidates,
    reviewRequired,
    staleObjects,
    exploredHypotheses,
  };
}
