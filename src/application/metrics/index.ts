import type { Client } from "pg";
import { stalenessMarker } from "../../domain/pack/staleness.js";
import { loadPackWorkingSet } from "../../infrastructure/persistence/read.js";

type PhaseDecisionRow = {
  readonly phase_id: string;
  readonly phase_name: string;
  readonly approved_decisions: string;
};

type PackCoverageRow = {
  readonly total_sessions: string;
  readonly sessions_started_with_pack: string;
  readonly unidentified_tool_calls: string;
};

type RelitigationRow = {
  readonly total_events: string;
  readonly pack_used_events: string;
  readonly pack_not_used_events: string;
};

type CandidateRateRow = {
  readonly proposed_candidates: string;
  readonly accepted_candidates: string;
};

type TierEscalationRow = {
  readonly retrieval_calls: string;
  readonly escalated_retrievals: string;
  readonly tier_2_retrievals: string;
  readonly tier_3_retrievals: string;
};

export type MetricRate = {
  readonly numerator: number;
  readonly denominator: number;
  readonly rate: number | null;
  readonly percentage: number | null;
};

export type DecisionsPerPhaseMetric = {
  readonly denominator: number;
  readonly total_approved_decisions: number;
  readonly phases: readonly {
    readonly phase_id: string;
    readonly phase_name: string;
    readonly approved_decisions: number;
  }[];
};

export type RelitigationMetric = {
  readonly total_events: number;
  readonly denominator: number;
  readonly pack_used: MetricRate & { readonly count: number };
  readonly pack_not_used: MetricRate & { readonly count: number };
};

export type MetricsReport = {
  readonly decisions_per_phase: DecisionsPerPhaseMetric;
  readonly pack_coverage: MetricRate & {
    readonly sessions_started_with_pack: number;
    readonly total_sessions: number;
    readonly unidentified_tool_calls: number;
  };
  readonly relitigation: RelitigationMetric;
  readonly stale_ratio: MetricRate & {
    readonly stale_active_objects: number;
    readonly active_objects: number;
  };
  readonly candidate_accept_rate: MetricRate & {
    readonly accepted_candidates: number;
    readonly proposed_candidates: number;
  };
  readonly tier_escalation_rate: MetricRate & {
    readonly retrieval_calls: number;
    readonly escalated_retrievals: number;
    readonly tier_2_retrievals: number;
    readonly tier_3_retrievals: number;
  };
};

export type MetricsOptions = {
  readonly now?: Date;
};

export type LogRelitigationInput = {
  readonly objectId: string;
  readonly sessionId?: string | null;
  readonly packUsed?: boolean;
  readonly note?: string | null;
  readonly observedAt?: Date;
};

export type RelitigationEvent = {
  readonly id: number;
  readonly observedAt: Date;
  readonly objectId: string;
  readonly sessionId: string | null;
  readonly packUsed: boolean;
  readonly note: string | null;
};

function numberValue(value: string | number): number {
  return typeof value === "number" ? value : Number(value);
}

function metricRate(numerator: number, denominator: number): MetricRate {
  const rate = denominator === 0 ? null : numerator / denominator;
  return {
    numerator,
    denominator,
    rate,
    percentage: rate === null ? null : rate * 100,
  };
}

async function decisionsPerPhase(client: Client): Promise<DecisionsPerPhaseMetric> {
  const result = await client.query<PhaseDecisionRow>(
    `SELECT s.id AS phase_id,
            s.name AS phase_name,
            count(ko.id)::text AS approved_decisions
     FROM scopes s
     LEFT JOIN knowledge_objects ko
       ON ko.scope_id = s.id
      AND ko.type = 'decision'
      AND ko.approved_at IS NOT NULL
      AND (ko.source_ref IS NULL OR ko.source_ref NOT LIKE 'backfill:%')
     WHERE s.kind = 'phase'
     GROUP BY s.id, s.name
     ORDER BY s.id`,
  );
  return {
    denominator: result.rows.length,
    total_approved_decisions: result.rows.reduce(
      (total, row) => total + numberValue(row.approved_decisions),
      0,
    ),
    phases: result.rows.map((row) => ({
      phase_id: row.phase_id,
      phase_name: row.phase_name,
      approved_decisions: numberValue(row.approved_decisions),
    })),
  };
}

async function packCoverage(client: Client): Promise<MetricsReport["pack_coverage"]> {
  const result = await client.query<PackCoverageRow>(
    `WITH first_calls AS (
       SELECT DISTINCT ON (session_id)
              session_id, tool_name
       FROM mcp_tool_calls
       WHERE session_id IS NOT NULL
       ORDER BY session_id, id
     )
     SELECT
       (SELECT count(*)::text
        FROM first_calls) AS total_sessions,
       (SELECT count(*)::text
        FROM first_calls
        WHERE tool_name = 'context.build') AS sessions_started_with_pack,
       (SELECT count(*)::text
        FROM mcp_tool_calls
        WHERE session_id IS NULL) AS unidentified_tool_calls`,
  );
  const row = result.rows[0] ?? {
    total_sessions: "0",
    sessions_started_with_pack: "0",
    unidentified_tool_calls: "0",
  };
  const totalSessions = numberValue(row.total_sessions);
  const sessionsStartedWithPack = numberValue(row.sessions_started_with_pack);
  return {
    ...metricRate(sessionsStartedWithPack, totalSessions),
    sessions_started_with_pack: sessionsStartedWithPack,
    total_sessions: totalSessions,
    unidentified_tool_calls: numberValue(row.unidentified_tool_calls),
  };
}

async function relitigation(client: Client): Promise<RelitigationMetric> {
  const result = await client.query<RelitigationRow>(
    `SELECT count(*)::text AS total_events,
            count(*) FILTER (WHERE pack_used)::text AS pack_used_events,
            count(*) FILTER (WHERE NOT pack_used)::text AS pack_not_used_events
     FROM relitigation_events`,
  );
  const row = result.rows[0] ?? {
    total_events: "0",
    pack_used_events: "0",
    pack_not_used_events: "0",
  };
  const total = numberValue(row.total_events);
  const packUsed = numberValue(row.pack_used_events);
  const packNotUsed = numberValue(row.pack_not_used_events);
  return {
    total_events: total,
    denominator: total,
    pack_used: { ...metricRate(packUsed, total), count: packUsed },
    pack_not_used: { ...metricRate(packNotUsed, total), count: packNotUsed },
  };
}

async function candidateAcceptRate(
  client: Client,
): Promise<MetricsReport["candidate_accept_rate"]> {
  const result = await client.query<CandidateRateRow>(
    `SELECT count(*)::text AS proposed_candidates,
            count(*) FILTER (WHERE status = 'accepted')::text AS accepted_candidates
     FROM candidates`,
  );
  const row = result.rows[0] ?? {
    proposed_candidates: "0",
    accepted_candidates: "0",
  };
  const proposed = numberValue(row.proposed_candidates);
  return {
    ...metricRate(numberValue(row.accepted_candidates), proposed),
    accepted_candidates: numberValue(row.accepted_candidates),
    proposed_candidates: proposed,
  };
}

async function tierEscalationRate(client: Client): Promise<MetricsReport["tier_escalation_rate"]> {
  const result = await client.query<TierEscalationRow>(
    `SELECT count(*)::text AS retrieval_calls,
            count(*) FILTER (WHERE cardinality(tier_escalations) > 0)::text
              AS escalated_retrievals,
            count(*) FILTER (WHERE 'tier-2' = ANY(tier_escalations))::text
              AS tier_2_retrievals,
            count(*) FILTER (WHERE 'tier-3' = ANY(tier_escalations))::text
              AS tier_3_retrievals
     FROM retrieval_events`,
  );
  const row = result.rows[0] ?? {
    retrieval_calls: "0",
    escalated_retrievals: "0",
    tier_2_retrievals: "0",
    tier_3_retrievals: "0",
  };
  const retrievalCalls = numberValue(row.retrieval_calls);
  return {
    ...metricRate(numberValue(row.escalated_retrievals), retrievalCalls),
    retrieval_calls: retrievalCalls,
    escalated_retrievals: numberValue(row.escalated_retrievals),
    tier_2_retrievals: numberValue(row.tier_2_retrievals),
    tier_3_retrievals: numberValue(row.tier_3_retrievals),
  };
}

async function staleRatio(client: Client, now: Date): Promise<MetricsReport["stale_ratio"]> {
  const set = await loadPackWorkingSet(client);
  const activeObjects = set.objects.filter((object) => object.validToVersion === null);
  const staleObjects = activeObjects.filter(
    (object) => stalenessMarker(object, now).state === "stale",
  );
  return {
    ...metricRate(staleObjects.length, activeObjects.length),
    stale_active_objects: staleObjects.length,
    active_objects: activeObjects.length,
  };
}

export async function collectMetrics(
  client: Client,
  options: MetricsOptions = {},
): Promise<MetricsReport> {
  const now = options.now ?? new Date();
  return {
    decisions_per_phase: await decisionsPerPhase(client),
    pack_coverage: await packCoverage(client),
    relitigation: await relitigation(client),
    stale_ratio: await staleRatio(client, now),
    candidate_accept_rate: await candidateAcceptRate(client),
    tier_escalation_rate: await tierEscalationRate(client),
  };
}

export async function logRelitigationEvent(
  client: Client,
  input: LogRelitigationInput,
): Promise<RelitigationEvent> {
  const object = await client.query<{ id: string }>(
    "SELECT id FROM knowledge_objects WHERE id = $1",
    [input.objectId],
  );
  if (object.rows[0] === undefined) {
    throw new Error(`knowledge object not found: ${input.objectId}`);
  }

  const result = await client.query<{
    id: string;
    observed_at: Date;
    object_id: string;
    session_id: string | null;
    pack_used: boolean;
    note: string | null;
  }>(
    `INSERT INTO relitigation_events (
       observed_at, object_id, session_id, pack_used, note
     ) VALUES ($1, $2, $3, $4, $5)
     RETURNING id::text, observed_at, object_id, session_id, pack_used, note`,
    [
      input.observedAt ?? new Date(),
      input.objectId,
      input.sessionId ?? null,
      input.packUsed ?? false,
      input.note ?? null,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("relitigation event insert did not return a row");
  }
  return {
    id: numberValue(row.id),
    observedAt: row.observed_at,
    objectId: row.object_id,
    sessionId: row.session_id,
    packUsed: row.pack_used,
    note: row.note,
  };
}
