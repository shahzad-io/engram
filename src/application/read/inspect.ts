import type { Client } from "pg";
import { DomainError, ErrorCode } from "../../domain/errors.js";
import type { KnowledgeObject } from "../../domain/entity/types.js";
import type { Relation } from "../../domain/relation/legality.js";
import { activeAtGraphVersion } from "../../domain/invariant/check.js";
import { readGraphSnapshot } from "../../infrastructure/persistence/read.js";

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
  const { version: current, set } = await readGraphSnapshot(client);
  // Filtered to the version this reports, so an object written after the
  // version was read is absent rather than returned under a version that
  // predates it.
  const object = set.objects.find(
    (candidate) => candidate.id === id && candidate.validFromVersion <= current.version,
  );
  if (object === undefined) {
    throw new DomainError(ErrorCode.OBJECT_NOT_FOUND, `object ${id} was not found`);
  }
  const relations = set.relations
    .filter(
      (edge) =>
        (edge.sourceId === id || edge.targetId === id) &&
        activeAtGraphVersion(edge.validFromVersion, edge.validToVersion, current.version),
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  return { graphVersion: current.version, object, relations };
}

export async function listKnowledgeObjects(
  client: Client,
  scopeId: string,
): Promise<ScopeObjectList> {
  const { version: current, set } = await readGraphSnapshot(client);
  if (!set.scopes.some((scope) => scope.id === scopeId)) {
    throw new DomainError(ErrorCode.SCOPE_NOT_FOUND, `unknown scope "${scopeId}"`);
  }
  const objects = set.objects
    .filter(
      (object) =>
        object.scopeId === scopeId &&
        activeAtGraphVersion(object.validFromVersion, object.validToVersion, current.version),
    )
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((object): ScopeObjectListItem => ({
      id: object.id,
      type: object.type,
      status: object.status,
      title: object.title,
    }));
  return { graphVersion: current.version, scopeId, objects };
}
