import { DomainError } from "../domain/errors.js";

export type McpErrorBody = {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
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
  if (error instanceof DomainError) {
    return {
      error: { code: error.code, message: error.message },
      graph_version: graphVersion,
    };
  }
  if (error instanceof Error) {
    return {
      error: { code: "INTERNAL_ERROR", message: error.message },
      graph_version: graphVersion,
    };
  }
  return {
    error: { code: "INTERNAL_ERROR", message: String(error) },
    graph_version: graphVersion,
  };
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
