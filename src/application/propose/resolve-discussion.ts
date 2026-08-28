import type { Client } from "pg";
import { allocateKnowledgeObjectId } from "../../infrastructure/persistence/id-allocation.js";
import {
  readGraphSnapshot,
} from "../../infrastructure/persistence/read.js";
import { persistDiscussionProposal } from "./persist.js";
import type { ProposalPayload, ResolveDiscussionInput, ResolveDiscussionResult } from "./types.js";
import { validateDiscussionProposal } from "./validate-proposal.js";

async function rollbackQuietly(client: Client): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the operation's original error.
  }
}

/**
 * Replaces the caller's local handle for the discussion with the allocated id,
 * before validation, so relation endpoints resolve against the id that will be
 * stored in the candidate payload and read again at acceptance.
 */
function bindDiscussionId(
  proposal: ProposalPayload,
  localId: string,
  discussionId: string,
): ProposalPayload {
  const relations = (proposal.relations ?? []).map((relation) => ({
    ...relation,
    sourceId: relation.sourceId === localId ? discussionId : relation.sourceId,
    targetId: relation.targetId === localId ? discussionId : relation.targetId,
  }));
  return { objects: proposal.objects, relations };
}

export async function resolveDiscussion(
  client: Client,
  input: ResolveDiscussionInput,
): Promise<ResolveDiscussionResult> {
  /*
   * Allocation, validation, and both inserts share one transaction. Allocating
   * in a separate statement outside it would hand back an id that another
   * session could take before this proposal reached its insert.
   */
  await client.query("BEGIN");
  try {
    const discussionId = await allocateKnowledgeObjectId(client, "discussion");
    const { localId, ...rest } = input.discussion;
    const discussion = { ...rest, id: discussionId };
    const proposal = bindDiscussionId(input.proposal, localId, discussionId);
    const { version: current, set } = await readGraphSnapshot(client, { requireVersion: true });
    const prepared = validateDiscussionProposal(set, current.version, discussion, proposal);
    const candidateIds = await persistDiscussionProposal(client, current.version, prepared);
    await client.query("COMMIT");
    return {
      graphVersion: current.version,
      validation: prepared.validation,
      candidateId: candidateIds[0] as string,
      candidateIds,
      discussionId: prepared.discussion.id,
    };
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  }
}
