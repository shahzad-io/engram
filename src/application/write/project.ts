import { projectKnowledgeAttributesForStorage } from "../../domain/entity/storage.js";
import type { KnowledgeObject } from "../../domain/entity/types.js";
import type { Relation } from "../../domain/relation/legality.js";
import type { KnowledgeObjectWrite, RelationWrite } from "./types.js";

export function projectKnowledgeObjectForStorage(object: KnowledgeObject): KnowledgeObjectWrite {
  return {
    id: object.id,
    type: object.type,
    scopeId: object.scopeId,
    featureLabelIds: object.featureLabelIds,
    title: object.title,
    body: object.body,
    status: object.status,
    attributes: projectKnowledgeAttributesForStorage(object),
    authoredBy: object.authoredBy,
    sourceRef: object.sourceRef,
    supersedesId: object.supersedesId,
    supersededById: object.supersededById,
  };
}

export function projectRelationForStorage(relation: Relation): RelationWrite {
  return {
    sourceId: relation.sourceId,
    relation: relation.relation,
    targetId: relation.targetId,
    targetKind: relation.targetKind,
  };
}
