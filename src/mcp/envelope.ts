import { errorPayload, type WireError, type WireFailure } from "../wire/envelope.js";

export type McpErrorFailure = WireFailure;

export type McpErrorBody = {
  readonly error: WireError;
  readonly graph_version: number;
};

export type McpSuccessBody<T extends Record<string, unknown>> = T & {
  readonly graph_version: number;
};

export function withGraphVersion<T extends Record<string, unknown>>(
  graphVersion: number,
  body: T,
): McpSuccessBody<T> {
  return { ...body, graph_version: graphVersion };
}

export function mcpErrorBody(error: unknown, graphVersion: number): McpErrorBody {
  return { error: errorPayload(error), graph_version: graphVersion };
}

export function jsonText(value: unknown): { readonly type: "text"; readonly text: string } {
  return { type: "text", text: JSON.stringify(value, replacer, 2) };
}

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value;
}
