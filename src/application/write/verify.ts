import type { Client } from "pg";
import { DomainError, ErrorCode } from "../../domain/errors.js";
import type { VerifyResult } from "./types.js";

type ObjectRow = Record<string, unknown> & {
  id: string;
  type: string;
  status: string;
};

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
      `SELECT *
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
       RETURNING *`,
      [verifiedAt, objectId],
    );
    const verified = updated.rows[0];
    if (verified === undefined) {
      throw new Error(`verification did not update ${objectId}`);
    }

    let alsoReview: readonly ObjectRow[] = [];
    if (object.type === "decision") {
      const dependents = await client.query<ObjectRow>(
        `SELECT c.*
         FROM knowledge_objects c
         INNER JOIN relations r
           ON r.source_id = c.id
          AND r.target_id = $1
          AND r.relation = 'derives_from'
          AND r.valid_to_version IS NULL
         WHERE c.type = 'constraint'
           AND c.status = 'active'
           AND c.valid_to_version IS NULL
         ORDER BY c.id`,
        [objectId],
      );
      alsoReview = dependents.rows;
    }

    await client.query("COMMIT");
    return { object: verified, alsoReview };
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  }
}
