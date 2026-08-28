/**
 * Handles Engram issued, as opposed to the readable ids it assigns knowledge
 * objects. Candidates and stored Context Packs are keyed by uuid because
 * neither is knowledge: a Candidate may never become an object, and a pack is
 * a record of one build.
 */
import { DomainError, ErrorCode } from "./errors.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/**
 * Rejects a malformed handle before it reaches the driver.
 *
 * Without this the id travels into a `uuid` column and Postgres rejects it,
 * which surfaces as `INTERNAL_ERROR: invalid input syntax for type uuid`. That
 * tells a caller its request was an Engram bug when the caller in fact passed
 * something unusable, and it is the one failure a UI can resolve on its own.
 */
export function assertUuid(value: string, name: string): void {
  if (!isUuid(value)) {
    throw new DomainError(
      ErrorCode.INVALID_ARGUMENT,
      `${name} must be a uuid, received ${JSON.stringify(value)}`,
    );
  }
}
