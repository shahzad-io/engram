import type { Client } from "pg";
import { DomainError, ErrorCode } from "../../domain/errors.js";
import type { Artifact } from "../../domain/entity/types.js";
import { readGraphSnapshot } from "../../infrastructure/persistence/read.js";

export type ArtifactView = {
  readonly id: string;
  readonly summary: string;
  readonly version: string;
  readonly location: string;
  readonly graphVersion: number;
};

export async function getArtifact(client: Client, artifactId: string): Promise<ArtifactView> {
  const { version: current, set } = await readGraphSnapshot(client, { requireVersion: true });
  const object = set.objects.find(
    (candidate) => candidate.id === artifactId && candidate.validFromVersion <= current.version,
  );
  if (object === undefined || object.type !== "artifact") {
    throw new DomainError(ErrorCode.SCOPE_NOT_FOUND, `artifact ${artifactId} was not found`);
  }
  const artifact = object as Artifact;
  return {
    id: artifact.id,
    summary: artifact.attributes.summary,
    version: artifact.attributes.version,
    location: artifact.attributes.location,
    graphVersion: current.version,
  };
}
