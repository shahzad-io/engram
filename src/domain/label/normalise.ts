/**
 * Lowercase-kebab with accent folding (Master Tech Spec 3.4.2).
 * Deterministic: no locale, no I/O.
 */
export function normaliseLabel(input: string): string {
  const folded = input.normalize("NFD").replace(/\p{M}/gu, "").trim().toLowerCase();
  return folded
    .replace(/[._\s]+/gu, "-")
    .replace(/[^a-z0-9-]+/gu, "")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "");
}

export function activeAtVersion(
  validFromVersion: number,
  validToVersion: number | null,
  version: number,
): boolean {
  return validFromVersion <= version && (validToVersion === null || validToVersion > version);
}
