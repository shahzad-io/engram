import type { Client } from "pg";
import type { CurationResult, ScopeWrite } from "./types.js";
import { curationTransaction } from "./transaction.js";

export async function addScope(
  client: Client,
  scope: ScopeWrite,
): Promise<CurationResult<{ readonly scopeId: string }>> {
  return curationTransaction(
    client,
    { action: "scope.add", actor: "curator" },
    async (transaction) => {
      await transaction.insertScope(scope);
      return { scopeId: scope.id };
    },
  );
}
