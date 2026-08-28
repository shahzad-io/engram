import type { Client } from "pg";
import type { KnowledgeObject } from "../../domain/entity/types.js";
import { activeAtGraphVersion } from "../../domain/invariant/check.js";
import { stalenessMarker } from "../../domain/pack/staleness.js";
import { readGraphSnapshot } from "../../infrastructure/persistence/read.js";
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

/**
 * Active as of the version this listing reports, rather than "not yet closed".
 * The two agree for everything committed before the version was read, and
 * differ only for rows written after it — which is the pair this must not
 * report as though the version described them.
 */
function currentObject(object: KnowledgeObject, version: number): boolean {
  return activeAtGraphVersion(object.validFromVersion, object.validToVersion, version);
}

function staleObject(object: KnowledgeObject, now: Date, version: number): boolean {
  if (object.validFromVersion > version) return false;
  if (object.type === "observation") {
    return (
      object.status === "stale" ||
      (object.status === "observed" && object.attributes.reviewBy.getTime() < now.getTime())
    );
  }
  if (!currentObject(object, version)) return false;
  return stalenessMarker(object, now).state === "stale";
}

export async function listTriage(
  client: Client,
  options: TriageListOptions = {},
): Promise<TriageListResult> {
  const now = options.now ?? new Date();
  const { version: current, set } = await readGraphSnapshot(client);
  const candidates = await listPendingCandidates(client);
  const reviewRequired = set.objects
    .filter((object) => currentObject(object, current.version) && object.reviewRequired)
    .sort((left, right) => left.id.localeCompare(right.id));
  const staleObjects = set.objects
    .filter((object) => staleObject(object, now, current.version))
    .sort((left, right) => left.id.localeCompare(right.id));
  const exploredHypotheses = set.objects
    .filter(
      (object) =>
        object.type === "hypothesis" &&
        object.status === "explored" &&
        currentObject(object, current.version) &&
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
