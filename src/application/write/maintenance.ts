import type { Client } from "pg";
import { getCurrentGraphVersionOrZero } from "../../infrastructure/persistence/read.js";
import { DomainError, ErrorCode } from "../../domain/errors.js";
import { curationTransaction } from "./transaction.js";

const DEFAULT_CANDIDATE_EXPIRY_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1_000;

export type MaintenanceOptions = {
  readonly now?: Date;
  readonly candidateExpiryDays?: number;
};

export type MaintenanceResult = {
  readonly observationIds: readonly string[];
  readonly observationVersion: number | null;
  readonly candidateIds: readonly string[];
  readonly graphVersion: number;
};

async function dueObservationIds(client: Client, now: Date): Promise<readonly string[]> {
  const result = await client.query<{ id: string }>(
    `SELECT id
     FROM knowledge_objects
     WHERE type = 'observation'
       AND status = 'observed'
       AND COALESCE(attributes ->> 'review_by', attributes ->> 'reviewBy')::timestamptz < $1
       AND valid_to_version IS NULL
     ORDER BY id`,
    [now],
  );
  return result.rows.map((row) => row.id);
}

async function expireCandidates(
  client: Client,
  cutoff: Date,
  resolvedAt: Date,
): Promise<readonly string[]> {
  const result = await client.query<{ id: string }>(
    `UPDATE candidates
     SET status = 'expired',
         resolution = $1::jsonb,
         resolved_at = $2
     WHERE status = 'pending'
       AND created_at < $3
     RETURNING id`,
    [JSON.stringify({ action: "expire", actor: "system" }), resolvedAt, cutoff],
  );
  return result.rows.map((row) => row.id).sort((left, right) => left.localeCompare(right));
}

async function expireCandidatesAlone(
  client: Client,
  cutoff: Date,
  resolvedAt: Date,
): Promise<readonly string[]> {
  await client.query("BEGIN");
  try {
    const ids = await expireCandidates(client, cutoff, resolvedAt);
    await client.query("COMMIT");
    return ids;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original expiry error.
    }
    throw error;
  }
}

/**
 * Observation expiry and Candidate expiry commit together.
 *
 * Observation expiry changes pack membership, so a run that staled Observations
 * and then failed while expiring Candidates would have reported failure over a
 * graph it had already altered — and a caller reading the non-zero exit as
 * "nothing happened" would be wrong about which objects its packs now contain.
 *
 * Candidate expiry rides inside the curation transaction without contributing
 * graph identities, so it stays out of the version's object list: Candidate
 * operations create no version of their own. When nothing is due for
 * Observation expiry there is no curation transaction to join and no second
 * write to be inconsistent with, so the Candidate sweep commits by itself.
 */
export async function runMaintenance(
  client: Client,
  options: MaintenanceOptions = {},
): Promise<MaintenanceResult> {
  const now = options.now ?? new Date();
  const candidateExpiryDays = options.candidateExpiryDays ?? DEFAULT_CANDIDATE_EXPIRY_DAYS;
  if (!Number.isFinite(candidateExpiryDays) || candidateExpiryDays < 0) {
    throw new DomainError(
      ErrorCode.INVALID_ARGUMENT,
      "candidate expiry days must be a non-negative number",
    );
  }
  const cutoff = new Date(now.getTime() - candidateExpiryDays * DAY_MS);

  // Read before writing: nothing else in this command advances the version, so
  // this stays exact without a post-commit read that could fail after success.
  const startingVersion = (await getCurrentGraphVersionOrZero(client)).version;
  const observationIds = await dueObservationIds(client, now);

  if (observationIds.length === 0) {
    return {
      observationIds,
      observationVersion: null,
      candidateIds: await expireCandidatesAlone(client, cutoff, now),
      graphVersion: startingVersion,
    };
  }

  const result = await curationTransaction(
    client,
    { action: "maintenance.observation_expiry", actor: "system" },
    async (transaction) => {
      for (const observationId of observationIds) {
        await transaction.transition(observationId, "stale", now);
      }
      return expireCandidates(transaction.client, cutoff, now);
    },
  );
  return {
    observationIds,
    observationVersion: result.version,
    candidateIds: result.value,
    graphVersion: result.version,
  };
}
