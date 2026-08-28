import type { Client } from "pg";
import type { ScopeKind } from "../../domain/scope/types.js";
import {
  getCurrentGraphVersionOrZero,
  loadPackWorkingSet,
} from "../../infrastructure/persistence/read.js";

export type ScopeTreeNode = {
  readonly id: string;
  readonly kind: ScopeKind;
  readonly name: string;
  readonly parentId: string | null;
  readonly depth: number;
  readonly path: string;
};

export type ScopeTreeResult = {
  readonly graphVersion: number;
  readonly scopes: readonly ScopeTreeNode[];
};

export async function listScopeTree(client: Client): Promise<ScopeTreeResult> {
  const [set, current] = await Promise.all([
    loadPackWorkingSet(client),
    getCurrentGraphVersionOrZero(client),
  ]);
  const scopes = [...set.scopes]
    .sort((left, right) => left.depth - right.depth || left.id.localeCompare(right.id))
    .map((scope): ScopeTreeNode => ({
      id: scope.id,
      kind: scope.kind,
      name: scope.name,
      parentId: scope.parentId,
      depth: scope.depth,
      path: scope.path,
    }));
  return { graphVersion: current.version, scopes };
}
