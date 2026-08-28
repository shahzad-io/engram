import {
  contractFor,
  optionalAttributes,
  requiredSnakeKeys,
  skeletonAttributesFor,
} from "../entity/contract.js";
import {
  KNOWLEDGE_OBJECT_TYPES,
  type KnowledgeObject,
  type KnowledgeObjectType,
} from "../entity/types.js";

export type BackfillSkeletonValue = string | boolean | readonly unknown[];

export type BackfillTypeSpec = {
  readonly idPrefix: string;
  readonly initialStatus: KnowledgeObject["status"];
  readonly requiredAttributes: readonly string[];
  readonly optionalAttributes: readonly string[];
  readonly skeletonAttributes: Readonly<Record<string, BackfillSkeletonValue>>;
};

function specFor(type: KnowledgeObjectType): BackfillTypeSpec {
  const contract = contractFor(type);
  return {
    idPrefix: contract.idPrefix,
    initialStatus: contract.initialStatus,
    requiredAttributes: requiredSnakeKeys(type),
    optionalAttributes: optionalAttributes(type).map((entry) => entry.snake),
    skeletonAttributes: skeletonAttributesFor(type),
  };
}

/** Derived from KNOWLEDGE_TYPE_CONTRACTS; do not restate the contract here. */
export const BACKFILL_TYPE_SPECS = Object.fromEntries(
  KNOWLEDGE_OBJECT_TYPES.map((type) => [type, specFor(type)]),
) as Readonly<Record<KnowledgeObjectType, BackfillTypeSpec>>;

export function isBackfillType(value: string): value is KnowledgeObjectType {
  return Object.hasOwn(BACKFILL_TYPE_SPECS, value);
}
