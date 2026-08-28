/**
 * Serialization shared by the two client surfaces. MCP and the curator CLI
 * describe the same failure with the same object, so a caller that learns one
 * error shape has learned both, and a second format cannot drift into
 * existence alongside the first.
 */
import { AggregateDomainError, DomainError } from "../domain/errors.js";

export type WireFailure = {
  readonly code: string;
  readonly message: string;
  readonly object_id?: string;
};

export type WireError = {
  readonly code: string;
  readonly message: string;
  /**
   * Every rejection from the pass. Always present and never empty: a caller
   * rendering problems should not have to branch on whether the validation
   * that failed happened to be one that accumulates.
   */
  readonly failures: readonly WireFailure[];
};

function failure(code: string, message: string, objectId?: string): WireFailure {
  return { code, message, ...(objectId === undefined ? {} : { object_id: objectId }) };
}

/**
 * `code` and `message` mirror the first failure, so callers that key only on
 * those behave as they did when validation threw on the first problem.
 */
export function errorPayload(error: unknown): WireError {
  if (error instanceof AggregateDomainError) {
    return {
      code: error.code,
      message: error.message,
      failures: error.failures.map((entry) => failure(entry.code, entry.message, entry.objectId)),
    };
  }
  if (error instanceof DomainError) {
    return {
      code: error.code,
      message: error.message,
      failures: [failure(error.code, error.message)],
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: "INTERNAL_ERROR",
    message,
    failures: [failure("INTERNAL_ERROR", message)],
  };
}

const ACRONYM_BOUNDARY = /([A-Z]+)([A-Z][a-z])/gu;
const WORD_BOUNDARY = /([a-z0-9])([A-Z])/gu;
const SNAKE_SEGMENT = /_+([a-z0-9])/gu;

/** Keys that would reach the prototype rather than the object. */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Idempotent: a key that is already snake_case is returned unchanged. */
export function snakeKey(key: string): string {
  return key.replace(ACRONYM_BOUNDARY, "$1_$2").replace(WORD_BOUNDARY, "$1_$2").toLowerCase();
}

/** Idempotent: a key that is already camelCase is returned unchanged. */
export function camelKey(key: string): string {
  return key.replace(SNAKE_SEGMENT, (_match, character: string) => character.toUpperCase());
}

function rekey(value: unknown, convert: (key: string) => string): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((entry) => rekey(entry, convert));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const normalised: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (UNSAFE_KEYS.has(key)) continue;
    normalised[convert(key)] = rekey(entry, convert);
  }
  return normalised;
}

/**
 * Deep key normalisation for machine-readable output. Applies to attribute
 * bodies as well as envelopes, because a caller parsing `alternatives_rejected`
 * should not have to know which layer materialised the object it came from.
 */
export function snakeCaseKeys(value: unknown): unknown {
  return rekey(value, snakeKey);
}

/**
 * The inverse, for documents arriving from a caller. Machine-readable output is
 * snake_case, so a payload read back from `--json` must be accepted in the same
 * spelling it was handed out in.
 */
export function camelCaseKeys(value: unknown): unknown {
  return rekey(value, camelKey);
}
