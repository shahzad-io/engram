import type { Client } from "pg";
import { getCurrentGraphVersionOrZero } from "../../infrastructure/persistence/read.js";
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

export async function runMaintenance(
  client: Client,
  options: MaintenanceOptions = {},
): Promise<MaintenanceResult> {
  const now = options.now ?? new Date();
  const candidateExpiryDays = options.candidateExpiryDays ?? DEFAULT_CANDIDATE_EXPIRY_DAYS;
  if (!Number.isFinite(candidateExpiryDays) || candidateExpiryDays < 0) {
    throw new Error("candidate expiry days must be a non-negative number");
  }

  const observationIds = await dueObservationIds(client, now);
  let observationVersion: number | null = null;
  if (observationIds.length > 0) {
    const result = await curationTransaction(
      client,
      { action: "maintenance.observation_expiry", actor: "system" },
      async (transaction) => {
        for (const observationId of observationIds) {
          await transaction.transition(observationId, "stale", now);
        }
      },
    );
    observationVersion = result.version;
  }

  const candidateIds = await expireCandidates(
    client,
    new Date(now.getTime() - candidateExpiryDays * DAY_MS),
    now,
  );
  const current = await getCurrentGraphVersionOrZero(client);
  return {
    observationIds,
    observationVersion,
    candidateIds,
    graphVersion: current.version,
  };
}
