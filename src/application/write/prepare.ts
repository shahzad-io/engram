import type { KnowledgeObject } from "../../domain/entity/types.js";
import { assertGraphAdditions } from "../../domain/invariant/check.js";
import type { PackWorkingSet } from "../../domain/pack/types.js";
import type { Relation } from "../../domain/relation/legality.js";
import { materializeProposalObject } from "../propose/materialize.js";
import { projectKnowledgeObjectForStorage, projectRelationForStorage } from "./project.js";
import type { KnowledgeObjectWrite, RelationWrite } from "./types.js";

export type SupersessionPair = {
  readonly predecessorId: string;
  readonly successorId: string;
};

export type PreparedGraphAdditions = {
  readonly objects: readonly KnowledgeObjectWrite[];
  readonly relations: readonly RelationWrite[];
};

function materializeRelations(
  relations: readonly RelationWrite[],
  version: number,
  now: Date,
): Relation[] {
  return relations.map((relation, index) => ({
    id: `validation-${index}`,
    sourceId: relation.sourceId,
    relation: relation.relation,
    targetId: relation.targetId,
    targetKind: relation.targetKind,
    createdAt: now,
    validFromVersion: version,
    validToVersion: null,
  }));
}

function withCompletedSupersessions(
  set: PackWorkingSet,
  supersessions: readonly SupersessionPair[],
  version: number,
): PackWorkingSet {
  if (supersessions.length === 0) return set;
  const successorByPredecessor = new Map(
    supersessions.map((pair) => [pair.predecessorId, pair.successorId]),
  );
  return {
    ...set,
    objects: set.objects.map((object) => {
      const successorId = successorByPredecessor.get(object.id);
      if (successorId === undefined) return object;
      return {
        ...object,
        status: "superseded",
        supersededById: successorId,
        validToVersion: version,
      } as KnowledgeObject;
    }),
  };
}

function withSupersessionRelations(
  relations: readonly RelationWrite[],
  supersessions: readonly SupersessionPair[],
): RelationWrite[] {
  const result = [...relations];
  for (const pair of supersessions) {
    const exists = result.some(
      (relation) =>
        relation.sourceId === pair.successorId &&
        relation.relation === "supersedes" &&
        relation.targetId === pair.predecessorId,
    );
    if (!exists) {
      result.push({
        sourceId: pair.successorId,
        relation: "supersedes",
        targetId: pair.predecessorId,
        targetKind: "knowledge_object",
      });
    }
  }
  return result;
}

export function prepareGraphAdditions(
  set: PackWorkingSet,
  version: number,
  objects: readonly KnowledgeObjectWrite[],
  relations: readonly RelationWrite[],
  supersessions: readonly SupersessionPair[] = [],
  now: Date = new Date(),
): PreparedGraphAdditions {
  const materializedObjects = objects.map((object) =>
    materializeProposalObject(object, version, now),
  );
  const validationRelations = withSupersessionRelations(relations, supersessions);
  const materializedRelations = materializeRelations(validationRelations, version, now);
  const validationBase = withCompletedSupersessions(set, supersessions, version);

  assertGraphAdditions(validationBase, {
    objects: materializedObjects,
    relations: materializedRelations,
    scopes: validationBase.scopes,
    labels: validationBase.labels,
  });

  const explicitRelationCount = relations.length;
  return {
    objects: materializedObjects.map(projectKnowledgeObjectForStorage),
    relations: materializedRelations.slice(0, explicitRelationCount).map(projectRelationForStorage),
  };
}
