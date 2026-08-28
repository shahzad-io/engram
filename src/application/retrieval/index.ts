import type { Client } from "pg";
import {
  retrieve,
  type RetrievalRequest,
  type RetrievalResponse,
} from "../../domain/retrieval/index.js";
import {
  readGraphSnapshot,
} from "../../infrastructure/persistence/read.js";
import { resolveFeatureLabelIds } from "../pack/index.js";

export type RetrieveKnowledgeInput = Omit<
  RetrievalRequest,
  "featureLabelIds" | "asOfVersion" | "currentVersion"
> & {
  readonly feature?: readonly string[];
  readonly asOfVersion?: number;
};

export async function retrieveKnowledge(
  client: Client,
  input: RetrieveKnowledgeInput,
): Promise<RetrievalResponse> {
  const { version: current, set } = await readGraphSnapshot(client, { requireVersion: true });
  return retrieve(set, {
    ...input,
    featureLabelIds:
      input.scopeId === undefined
        ? []
        : resolveFeatureLabelIds(
            input.feature,
            set,
            input.scopeId,
            input.asOfVersion ?? current.version,
          ),
    asOfVersion: input.asOfVersion ?? current.version,
    currentVersion: current.version,
  });
}
