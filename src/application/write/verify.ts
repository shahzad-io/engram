import type { Client } from "pg";
import { DomainError, ErrorCode } from "../../domain/errors.js";
import {
  KNOWLEDGE_OBJECT_COLUMNS,
  objectFromRow,
  type ObjectRow,
} from "../../infrastructure/persistence/read.js";
import type { VerifyResult } from "./types.js";

async function rollbackQuietly(client: Client): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original verification error.
  }
}

export async function verifyObject(
  client: Client,
  objectId: string,
  verifiedAt = new Date(),
): Promise<VerifyResult> {
  await client.query("BEGIN");
  try {
    const selected = await client.query<ObjectRow>(
      `SELECT ${KNOWLEDGE_OBJECT_COLUMNS}
       FROM knowledge_objects
       WHERE id = $1
       FOR UPDATE`,
      [objectId],
    );
    const object = selected.rows[0];
    if (
      object === undefined ||
      object.status !== "active" ||
      (object.type !== "decision" && object.type !== "constraint")
    ) {
      throw new DomainError(
        ErrorCode.ILLEGAL_TRANSITION,
        `only active Decisions and Constraints can be verified: ${objectId}`,
      );
    }

    const updated = await client.query<ObjectRow>(
      `UPDATE knowledge_objects
       SET last_verified_at = $1,
           review_required = false,
           lock_version = lock_version + 1
       WHERE id = $2
       RETURNING ${KNOWLEDGE_OBJECT_COLUMNS}`,
      [verifiedAt, objectId],
    );
    const verified = updated.rows[0];
    if (verified === undefined) {
      throw new Error(`verification did not update ${objectId}`);
    }

    let alsoReview: readonly ObjectRow[] = [];
    if (object.type === "decision") {
      const dependents = await client.query<ObjectRow>(
        `SELECT ${KNOWLEDGE_OBJECT_COLUMNS}
         FROM knowledge_objects
         WHERE type = 'constraint'
           AND status = 'active'
           AND valid_to_version IS NULL
           AND id IN (
             SELECT source_id
             FROM relations
             WHERE target_id = $1
               AND relation = 'derives_from'
               AND valid_to_version IS NULL
           )
         ORDER BY id`,
        [objectId],
      );
      alsoReview = dependents.rows;
    }

    await client.query("COMMIT");
    return {
      object: objectFromRow(verified),
      alsoReview: alsoReview.map(objectFromRow),
    };
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  }
}
