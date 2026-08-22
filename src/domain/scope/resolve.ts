import { DomainError, ErrorCode } from "../errors.js";
import type { Scope } from "./types.js";

/**
 * Normative scope-chain walk (Master Tech Spec 3.2).
 * Narrowest first, Global last. Terminates in at most four steps.
 */
export function resolveChain(targetScopeId: string, byId: ReadonlyMap<string, Scope>): Scope[] {
  const start = byId.get(targetScopeId);
  if (start === undefined) {
    throw new DomainError(ErrorCode.SCOPE_NOT_FOUND, `scope not found: ${targetScopeId}`);
  }

  const chain: Scope[] = [];
  let row: Scope | undefined = start;
  while (row !== undefined) {
    chain.push(row);
    row = row.parentId === null ? undefined : byId.get(row.parentId);
  }

  const last = chain[chain.length - 1];
  if (chain.length !== start.depth + 1 || last?.kind !== "global") {
    throw new DomainError(
      ErrorCode.SCOPE_CHAIN_INVALID,
      `scope chain for ${targetScopeId} does not terminate at Global with depth ${start.depth}`,
    );
  }
  return chain;
}

/**
 * ltree optimisation: ancestors of target.path, including self, depth DESC.
 * Must return the same list as resolveChain for every well-formed tree (3.2).
 */
export function resolveChainByPath(target: Scope, scopes: readonly Scope[]): Scope[] {
  return scopes
    .filter((scope) => isLtreeAncestor(scope.path, target.path))
    .sort((a, b) => b.depth - a.depth || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function isInScopeFor(objectScopeId: string, chain: readonly Scope[]): boolean {
  return chain.some((scope) => scope.id === objectScopeId);
}

export function projectOf(chain: readonly Scope[]): Scope | undefined {
  return chain.find((scope) => scope.kind === "project");
}

function isLtreeAncestor(ancestor: string, descendant: string): boolean {
  return descendant === ancestor || descendant.startsWith(`${ancestor}.`);
}
