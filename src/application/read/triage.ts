import type { Client } from "pg";
import type { KnowledgeObject } from "../../domain/entity/types.js";
import { activeAtGraphVersion } from "../../domain/invariant/check.js";
import { stalenessMarker } from "../../domain/pack/staleness.js";
import { readGraphSnapshot } from "../../infrastructure/persistence/read.js";
import { listCandidates } from "../write/candidates.js";
import type { CandidateRecord } from "../write/types.js";

const HYPOTHESIS_REVIEW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1_000;

/** Every status the table holds, plus `all` for no filter at all. */
export type TriageCandidateStatus = CandidateRecord["status"] | "all";

export type TriageListOptions = {
  readonly now?: Date;
  /** Which candidates to report. Defaults to `pending`, the triage queue. */
  readonly candidateStatus?: TriageCandidateStatus;
};

export type TriageListResult = {
  readonly graphVersion: number;
  /** Echoes the filter, so a caller reading a stored response knows what it asked. */
  readonly candidateStatus: TriageCandidateStatus;
  /** The candidates matching the filter. */
  readonly candidates: readonly CandidateRecord[];
  /**
   * The pending queue, whatever the filter. This is what the rest of the
   * listing is about — work waiting for a curator — so it keeps meaning
   * exactly what its name says rather than becoming whatever was asked for.
   */
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
  const candidateStatus = options.candidateStatus ?? "pending";
  const { version: current, set } = await readGraphSnapshot(client);
  const candidates = await listCandidates(
    client,
    candidateStatus === "all" ? undefined : [candidateStatus],
  );
  // One query when the filter already contains the pending rows, two when it
  // cannot. Sequential either way: this client is not a pool.
  const pendingCandidates =
    candidateStatus === "pending"
      ? candidates
      : candidateStatus === "all"
        ? candidates.filter((candidate) => candidate.status === "pending")
        : await listCandidates(client, ["pending"]);
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
    candidateStatus,
    candidates,
    pendingCandidates,
    reviewRequired,
    staleObjects,
    exploredHypotheses,
  };
}
