import type { Client } from "pg";
import { DomainError, ErrorCode } from "../../domain/errors.js";
import type { KnowledgeObject } from "../../domain/entity/types.js";
import type { Relation } from "../../domain/relation/legality.js";
import {
  getCurrentGraphVersionOrZero,
  loadPackWorkingSet,
} from "../../infrastructure/persistence/read.js";

export type InspectedObject = {
  readonly graphVersion: number;
  readonly object: KnowledgeObject;
  readonly relations: readonly Relation[];
};

export type ScopeObjectListItem = {
  readonly id: string;
  readonly type: KnowledgeObject["type"];
  readonly status: KnowledgeObject["status"];
  readonly title: string;
};

export type ScopeObjectList = {
  readonly graphVersion: number;
  readonly scopeId: string;
  readonly objects: readonly ScopeObjectListItem[];
};

export async function showKnowledgeObject(client: Client, id: string): Promise<InspectedObject> {
  const [set, current] = await Promise.all([
    loadPackWorkingSet(client),
    getCurrentGraphVersionOrZero(client),
  ]);
  const object = set.objects.find((candidate) => candidate.id === id);
  if (object === undefined) {
    throw new Error(`object ${id} was not found`);
  }
  const relations = set.relations
    .filter(
      (edge) =>
        (edge.sourceId === id || edge.targetId === id) && edge.validToVersion === null,
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  return { graphVersion: current.version, object, relations };
}

export async function listKnowledgeObjects(
  client: Client,
  scopeId: string,
): Promise<ScopeObjectList> {
  const [set, current] = await Promise.all([
    loadPackWorkingSet(client),
    getCurrentGraphVersionOrZero(client),
  ]);
  if (!set.scopes.some((scope) => scope.id === scopeId)) {
    throw new DomainError(ErrorCode.SCOPE_NOT_FOUND, `unknown scope "${scopeId}"`);
  }
  const objects = set.objects
    .filter((object) => object.scopeId === scopeId && object.validToVersion === null)
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(
      (object): ScopeObjectListItem => ({
        id: object.id,
        type: object.type,
        status: object.status,
        title: object.title,
      }),
    );
  return { graphVersion: current.version, scopeId, objects };
}
