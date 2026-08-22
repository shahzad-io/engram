import type { Client } from "pg";
import {
  getCurrentGraphVersion,
  loadPackWorkingSet,
} from "../../infrastructure/persistence/read.js";
import { persistDiscussionProposal } from "./persist.js";
import type { ResolveDiscussionInput, ResolveDiscussionResult } from "./types.js";
import { validateDiscussionProposal } from "./validate-proposal.js";

export async function resolveDiscussion(
  client: Client,
  input: ResolveDiscussionInput,
): Promise<ResolveDiscussionResult> {
  const [set, current] = await Promise.all([
    loadPackWorkingSet(client),
    getCurrentGraphVersion(client),
  ]);
  const validation = validateDiscussionProposal(
    set,
    current.version,
    input.discussion,
    input.proposal,
  );
  const candidateIds = await persistDiscussionProposal(
    client,
    current.version,
    input.discussion,
    input.proposal,
  );
  return {
    graphVersion: current.version,
    validation,
    candidateId: candidateIds[0] as string,
    candidateIds,
    discussionId: input.discussion.id,
  };
}
