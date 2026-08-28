import type { Client } from "pg";
import { formatKnowledgeObjectId, idPatternSourceFor } from "../../domain/entity/contract.js";
import type { KnowledgeObjectType } from "../../domain/entity/types.js";

/**
 * Allocates the next `count` ids for a type's prefix. They are handed out in
 * one call rather than one at a time because nothing is inserted until the
 * transaction commits, so a second MAX read would return the same number.
 *
 * Must be called inside an open transaction. The advisory lock is transaction
 * scoped and taken per prefix, so two concurrent allocations of the same type
 * serialise here and release at commit or rollback; without it both readers
 * would see the same MAX and the loser would fail on the primary key after
 * having done all of its other work.
 *
 * Numbering is MAX + 1 rather than a sequence because backfilled ids are sparse
 * and were assigned outside this engine; a sequence would have to be reseeded
 * after every import.
 */
export async function allocateKnowledgeObjectIds(
  client: Client,
  type: KnowledgeObjectType,
  count: number,
): Promise<readonly string[]> {
  if (count <= 0) return [];
  const pattern = idPatternSourceFor(type);
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [
    `knowledge_object_id:${type}`,
  ]);
  /*
   * The sequence is read only from ids of a plausible width. The CHECK accepts
   * four digits or more with no upper bound, and a twenty-digit id — which
   * nothing in this numbering scheme produces — would overflow the cast and
   * fail an unrelated acceptance.
   */
  const result = await client.query<{ next: string }>(
    `SELECT COALESCE(MAX(substring(id from '^[A-Z]+-([0-9]{4,9})$')::bigint), 0) + 1 AS next
       FROM knowledge_objects
      WHERE id ~ $1`,
    [pattern],
  );
  const first = Number(result.rows[0]?.next ?? "1");
  return Array.from({ length: count }, (_unused, offset) =>
    formatKnowledgeObjectId(type, first + offset),
  );
}

export async function allocateKnowledgeObjectId(
  client: Client,
  type: KnowledgeObjectType,
): Promise<string> {
  const [id] = await allocateKnowledgeObjectIds(client, type, 1);
  return id as string;
}
