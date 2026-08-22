import type { Client } from "pg";
import { getCurrentGraphVersionOrZero } from "../../infrastructure/persistence/read.js";

export type InstrumentationSessionId = string | null;

export type ToolInvocationInput = {
  readonly sessionId?: InstrumentationSessionId;
  readonly toolName: string;
  readonly invokedAt?: Date;
  readonly graphVersion?: number;
};

export type RetrievalEventInput = {
  readonly sessionId?: InstrumentationSessionId;
  readonly toolName: string;
  readonly tier: 1 | 2 | 3 | null;
  readonly tierEscalations: readonly string[];
  readonly retrievedAt?: Date;
};

function sessionValue(sessionId: InstrumentationSessionId | undefined): string | null {
  if (sessionId === undefined || sessionId === null || sessionId.length === 0) {
    return null;
  }
  return sessionId;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reportFailure(operation: string, error: unknown): void {
  console.error(`[pke-instrumentation] ${operation} failed: ${errorMessage(error)}`);
}

/**
 * Records one MCP invocation without touching graph_versions. The graph
 * version is sampled before the tool handler runs so the row describes the
 * graph visible at invocation time.
 */
export async function recordToolInvocation(
  client: Client,
  input: ToolInvocationInput,
): Promise<void> {
  const graphVersion = input.graphVersion ?? (await getCurrentGraphVersionOrZero(client)).version;
  await client.query(
    `INSERT INTO mcp_tool_calls (
       session_id, tool_name, invoked_at, graph_version
     ) VALUES ($1, $2, $3, $4)`,
    [sessionValue(input.sessionId), input.toolName, input.invokedAt ?? new Date(), graphVersion],
  );
}

/**
 * Telemetry must never turn a usable MCP call into a failed MCP call.
 */
export async function recordToolInvocationSafely(
  client: Client,
  input: ToolInvocationInput,
): Promise<void> {
  try {
    await recordToolInvocation(client, input);
  } catch (error) {
    reportFailure("tool invocation recording", error);
  }
}

export async function recordRetrievalEvent(
  client: Client,
  input: RetrievalEventInput,
): Promise<void> {
  await client.query(
    `INSERT INTO retrieval_events (
       session_id, tool_name, retrieved_at, tier, tier_escalations
     ) VALUES ($1, $2, $3, $4, $5)`,
    [
      sessionValue(input.sessionId),
      input.toolName,
      input.retrievedAt ?? new Date(),
      input.tier,
      input.tierEscalations,
    ],
  );
}

export async function recordRetrievalEventSafely(
  client: Client,
  input: RetrievalEventInput,
): Promise<void> {
  try {
    await recordRetrievalEvent(client, input);
  } catch (error) {
    reportFailure("retrieval recording", error);
  }
}
