import type { Client } from "pg";
import { curationTransaction } from "../../dist/application/write/index.js";
import type {
  KnowledgeObjectWrite,
  RelationWrite,
} from "../../dist/application/write/index.js";

/*
 * Object builders for tests that need a small graph rather than a specific
 * object. Several suites grew their own copies of these; new suites share
 * this one so a contract change lands in one place.
 */

let serial = 0;

export function uniqueDigits(): string {
  serial += 1;
  return `${Date.now()}${process.pid}${serial}`;
}

export function objectId(prefix: string): string {
  return `${prefix}-${uniqueDigits()}`;
}

export async function createProject(client: Client, prefix = "proj"): Promise<string> {
  const id = `${prefix}_${uniqueDigits()}`;
  await client.query(
    `INSERT INTO scopes (id, kind, parent_id, name)
     VALUES ($1, 'project', 'global', $1)`,
    [id],
  );
  return id;
}

export async function createChildScope(
  client: Client,
  parentId: string,
  kind: "workstream" | "phase",
): Promise<string> {
  const id = `${kind}_${uniqueDigits()}`;
  await client.query(
    `INSERT INTO scopes (id, kind, parent_id, name)
     VALUES ($1, $2, $3, $1)`,
    [id, kind, parentId],
  );
  return id;
}

export function requirement(id: string, scopeId: string): KnowledgeObjectWrite {
  return {
    id,
    type: "requirement",
    scopeId,
    title: id,
    body: `${id} body`,
    status: "active",
    attributes: { source: "test", rationale: "test" },
    authoredBy: "human",
  };
}

export function discussion(id: string, scopeId: string): KnowledgeObjectWrite {
  return {
    id,
    type: "discussion",
    scopeId,
    title: id,
    body: `${id} body`,
    status: "recorded",
    attributes: { medium: "chat", occurred_at: "2026-08-19T00:00:00.000Z", content_ref: id },
    authoredBy: "ai",
  };
}

export function decision(
  id: string,
  scopeId: string,
  featureLabelIds: readonly string[] = [],
): KnowledgeObjectWrite {
  return {
    id,
    type: "decision",
    scopeId,
    featureLabelIds,
    title: id,
    body: `${id} body`,
    status: "active",
    attributes: {
      statement: `${id} statement`,
      rationale: "test",
      reversibility: "cheap",
      alternatives_rejected: [],
    },
    authoredBy: "ai",
  };
}

export function constraint(
  id: string,
  scopeId: string,
  axiomatic = false,
): KnowledgeObjectWrite {
  return {
    id,
    type: "constraint",
    scopeId,
    title: id,
    body: `${id} body`,
    status: "active",
    attributes: { rule: `${id} rule`, enforcement: "hard", axiomatic },
    authoredBy: "ai",
  };
}

export function glossary(id: string, scopeId: string): KnowledgeObjectWrite {
  return {
    id,
    type: "glossary_entry",
    scopeId,
    title: id,
    body: `${id} body`,
    status: "active",
    attributes: { term: id.toLowerCase(), definition: "test definition", axiomatic: false },
    authoredBy: "ai",
  };
}

export function openQuestion(id: string, scopeId: string, blocking = true): KnowledgeObjectWrite {
  return {
    id,
    type: "open_question",
    scopeId,
    title: id,
    body: `${id} body`,
    status: "open",
    attributes: { question: `${id}?`, blocking },
    authoredBy: "human",
  };
}

export function relation(
  sourceId: string,
  relationName: RelationWrite["relation"],
  targetId: string,
): RelationWrite {
  return { sourceId, relation: relationName, targetId, targetKind: "knowledge_object" };
}

export async function seed(
  client: Client,
  objects: readonly KnowledgeObjectWrite[],
  relations: readonly RelationWrite[] = [],
): Promise<number> {
  const result = await curationTransaction(
    client,
    { action: "test.seed", actor: "curator" },
    async (transaction) => {
      for (const object of objects) await transaction.insertObject(object);
      for (const edge of relations) await transaction.insertRelation(edge);
      return undefined;
    },
  );
  return result.version;
}

export async function graphVersionCount(client: Client): Promise<number> {
  const result = await client.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM graph_versions",
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function currentGraphVersion(client: Client): Promise<number> {
  const result = await client.query<{ version: string }>(
    "SELECT COALESCE(MAX(version), 0)::text AS version FROM graph_versions",
  );
  return Number(result.rows[0]?.version ?? "0");
}
