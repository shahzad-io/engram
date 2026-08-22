import type { RenderedObject } from "./types.js";

export const PACK_FIXED_OBJECT_OVERHEAD = 8;

type CanonicalValue =
  null | boolean | number | string | CanonicalValue[] | { readonly [key: string]: CanonicalValue };

function canonicalValue(value: unknown): CanonicalValue {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalValue(item));
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalValue(record[key])]),
    );
  }
  return String(value);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function estimatedTokenCost(text: string): number {
  return Math.ceil(text.length / 4) + PACK_FIXED_OBJECT_OVERHEAD;
}

export function renderedObjectText(object: RenderedObject): string {
  return canonicalJson({
    id: object.id,
    type: object.type,
    section: object.section,
    scopePath: object.scopePath,
    title: object.title,
    body: object.body,
    attributes: object.attributes,
    origin: object.origin,
    evidenceReferenceIds: object.evidenceReferenceIds,
  });
}

export function renderedObjectCost(object: RenderedObject): number {
  return estimatedTokenCost(renderedObjectText(object));
}
