import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import type { KnowledgeObjectWrite, ProposalPayload } from "./types.js";

async function beginPlainTransaction(client: Client): Promise<void> {
  await client.query("BEGIN");
}

async function rollbackQuietly(client: Client): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the operation's original error.
  }
}

async function insertDiscussionRow(
  client: Client,
  discussion: KnowledgeObjectWrite,
  version: number,
): Promise<void> {
  await client.query(
    `INSERT INTO knowledge_objects (
       id, type, scope_id, feature_label_ids, title, body, status, attributes,
       authored_by, source_ref, approved_at, last_verified_at,
       supersedes_id, superseded_by_id, valid_from_version
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10,
       NULL, NULL, NULL, NULL, $11
     )`,
    [
      discussion.id,
      discussion.type,
      discussion.scopeId,
      discussion.featureLabelIds ?? [],
      discussion.title,
      discussion.body,
      discussion.status,
      JSON.stringify(discussion.attributes),
      "ai",
      discussion.sourceRef ?? null,
      version,
    ],
  );
}

async function insertCandidateRow(
  client: Client,
  id: string,
  payload: ProposalPayload,
  parentId: string | null,
  sourceRef: string,
): Promise<void> {
  await client.query(
    `INSERT INTO candidates (
       id, proposed_type, payload, parent_id, source_ref, proposed_by
     ) VALUES ($1::uuid, $2, $3::jsonb, $4::uuid, $5, 'ai')`,
    [id, payload.objects[0]?.type, JSON.stringify(payload), parentId, sourceRef],
  );
}

export async function persistDiscussionProposal(
  client: Client,
  graphVersion: number,
  discussion: KnowledgeObjectWrite,
  proposal: ProposalPayload,
): Promise<readonly string[]> {
  const payload: ProposalPayload = {
    objects: proposal.objects.map((object) => ({ ...object, authoredBy: "ai" })),
    relations: proposal.relations ?? [],
  };
  const rootId = randomUUID();
  const ids = [rootId];
  const childPayloads: ProposalPayload[] = [];

  if (payload.objects.length > 1) {
    for (const object of payload.objects.slice(1)) {
      childPayloads.push({ objects: [object], relations: [] });
      ids.push(randomUUID());
    }
  }

  await beginPlainTransaction(client);
  try {
    await insertDiscussionRow(client, { ...discussion, authoredBy: "ai" }, graphVersion);
    await insertCandidateRow(
      client,
      rootId,
      {
        objects: [payload.objects[0] as KnowledgeObjectWrite],
        relations: payload.relations,
      },
      null,
      discussion.id,
    );
    for (let index = 0; index < childPayloads.length; index += 1) {
      await insertCandidateRow(
        client,
        ids[index + 1] as string,
        childPayloads[index] as ProposalPayload,
        rootId,
        discussion.id,
      );
    }
    await client.query("COMMIT");
    return ids;
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  }
}
