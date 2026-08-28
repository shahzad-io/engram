import { DomainError, ErrorCode } from "../domain/errors.js";
import { CONTEXT_PACK_INTENTS } from "../domain/pack/types.js";

export const VALID_INTENT_INPUTS = [...CONTEXT_PACK_INTENTS, "investigation"] as const;

export type IntentInput = (typeof VALID_INTENT_INPUTS)[number];

export function formatScopeList(scopeIds: readonly string[]): string {
  return [...scopeIds].sort((left, right) => left.localeCompare(right)).join(", ");
}

export function scopeNotFound(supplied: string, scopeIds: readonly string[]): never {
  throw new DomainError(
    ErrorCode.SCOPE_NOT_FOUND,
    `unknown scope "${supplied}"; valid scope ids: ${formatScopeList(scopeIds)}`,
  );
}

export function intentUnknown(supplied: string): never {
  throw new DomainError(
    ErrorCode.INTENT_UNKNOWN,
    `unknown intent "${supplied}"; valid intents: ${VALID_INTENT_INPUTS.join(", ")}`,
  );
}

export function missingArgument(field: string): never {
  throw new DomainError(ErrorCode.MISSING_ARGUMENT, `missing required argument: ${field}`);
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") {
    missingArgument(field);
  }
  return value;
}

export function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    missingArgument(field);
  }
  return value;
}
