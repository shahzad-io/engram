import type { Client } from "pg";
import { DomainError, ErrorCode } from "../../domain/errors.js";
import type { KnowledgeObject } from "../../domain/entity/types.js";
import { getCurrentGraphVersion } from "../../infrastructure/persistence/read.js";

export type RequirementImpactObject = {
  readonly id: string;
  readonly type: KnowledgeObject["type"];
  readonly status: KnowledgeObject["status"];
  readonly depth: number;
  readonly reviewRequired: boolean;
};

export type RequirementImpactResult = {
  readonly requirementId: string;
  readonly graphVersion: number;
  readonly affectedObjects: readonly RequirementImpactObject[];
  readonly affectedDecisions: readonly RequirementImpactObject[];
};

export async function requirementImpact(
  client: Client,
  requirementId: string,
): Promise<RequirementImpactResult> {
  const current = await getCurrentGraphVersion(client);
  const result = await client.query<{
    id: string;
    type: KnowledgeObject["type"];
    status: KnowledgeObject["status"];
    depth: number;
    review_required: boolean;
  }>(
    `WITH RECURSIVE affected(id, depth) AS (
         SELECT r.source_id, 1
         FROM relations r
         WHERE r.target_id = $1
           AND r.relation = 'derives_from'
           AND r.valid_to_version IS NULL

         UNION

         SELECT r.source_id, affected.depth + 1
         FROM relations r
         INNER JOIN affected ON affected.id = r.target_id
         WHERE r.relation = 'derives_from'
           AND r.valid_to_version IS NULL
           AND affected.depth < 64
       )
       SELECT o.id, o.type, o.status, MIN(affected.depth)::integer AS depth,
              o.review_required
       FROM affected
       INNER JOIN knowledge_objects o ON o.id = affected.id
       WHERE o.valid_from_version <= $2
         AND (o.valid_to_version IS NULL OR o.valid_to_version > $2)
       GROUP BY o.id, o.type, o.status, o.review_required
       ORDER BY MIN(affected.depth), o.type, o.id`,
    [requirementId, current.version],
  );
  const requirement = await client.query<{ type: KnowledgeObject["type"] }>(
    "SELECT type FROM knowledge_objects WHERE id = $1",
    [requirementId],
  );
  if (requirement.rows[0]?.type !== "requirement") {
    throw new DomainError(
      ErrorCode.ILLEGAL_TRANSITION,
      `impact requires a Requirement: ${requirementId}`,
    );
  }

  const affectedObjects = result.rows.map((row) => ({
    id: row.id,
    type: row.type,
    status: row.status,
    depth: row.depth,
    reviewRequired: row.review_required,
  }));
  return {
    requirementId,
    graphVersion: current.version,
    affectedObjects,
    affectedDecisions: affectedObjects.filter((object) => object.type === "decision"),
  };
}
