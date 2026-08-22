import type { Client } from "pg";
import { knowledgeClassOf } from "../../domain/entity/class.js";
import type {
  Artifact,
  Decision,
  Discussion,
  ExternalReference,
  GlossaryEntry,
  Hypothesis,
  KnowledgeObject,
  Observation,
  OpenQuestion,
  Requirement,
  Constraint,
} from "../../domain/entity/types.js";
import type { FeatureLabel } from "../../domain/label/types.js";
import type { Relation } from "../../domain/relation/legality.js";
import type { Scope } from "../../domain/scope/types.js";
import type {
  ContextPackIntent,
  ContextPackRecipe,
  GraphVersionSnapshot,
  PackWorkingSet,
} from "../../domain/pack/index.js";

type TimestampValue = Date | string | null;

type ObjectRow = {
  id: string;
  type: KnowledgeObject["type"];
  scope_id: string;
  feature_label_ids: string[];
  title: string;
  body: string;
  status: KnowledgeObject["status"];
  attributes: Record<string, unknown>;
  authored_by: "human" | "ai";
  source_ref: string | null;
  created_at: TimestampValue;
  approved_at: TimestampValue;
  last_verified_at: TimestampValue;
  supersedes_id: string | null;
  superseded_by_id: string | null;
  review_required: boolean;
  valid_from_version: number | string;
  valid_to_version: number | string | null;
  lock_version: number;
};

type RelationRow = {
  id: number | string;
  source_id: string;
  relation: Relation["relation"];
  target_id: string;
  target_kind: Relation["targetKind"];
  created_at: TimestampValue;
  valid_from_version: number | string;
  valid_to_version: number | string | null;
};

type LabelRow = {
  id: string;
  project_scope_id: string;
  canonical_name: string;
  status: FeatureLabel["status"];
  redirects_to_id: string | null;
  valid_from_version: number | string;
  valid_to_version: number | string | null;
};

type AliasRow = {
  label_id: string;
  alias: string;
  project_scope_id: string;
  valid_from_version: number | string;
  valid_to_version: number | string | null;
};

type ExternalReferenceRow = {
  id: string;
  system: ExternalReference["system"];
  identifier: string;
  location: string | null;
  symbol: string | null;
  last_verified_at: TimestampValue;
  created_at: TimestampValue;
};

function dateValue(value: TimestampValue): Date | null {
  return value === null ? null : value instanceof Date ? value : new Date(value);
}

function versionValue(value: number | string | null): number | null {
  return value === null ? null : Number(value);
}

function recordValue(attributes: Record<string, unknown>, snake: string, camel: string): unknown {
  return attributes[camel] ?? attributes[snake];
}

function dateAttribute(attributes: Record<string, unknown>, snake: string, camel: string): Date {
  const value = recordValue(attributes, snake, camel);
  return value instanceof Date ? value : new Date(String(value));
}

function attributesFor(
  type: KnowledgeObject["type"],
  raw: Record<string, unknown>,
): KnowledgeObject["attributes"] {
  switch (type) {
    case "requirement":
      return {
        source: String(raw.source),
        rationale: String(raw.rationale),
      } satisfies Requirement["attributes"];
    case "discussion":
      return {
        medium: raw.medium as Discussion["attributes"]["medium"],
        occurredAt: dateAttribute(raw, "occurred_at", "occurredAt"),
        contentRef: recordValue(raw, "content_ref", "contentRef"),
        ...(Array.isArray(raw.participants) ? { participants: raw.participants.map(String) } : {}),
      } satisfies Discussion["attributes"];
    case "observation":
      return {
        observedAt: dateAttribute(raw, "observed_at", "observedAt"),
        evidenceRef: String(recordValue(raw, "evidence_ref", "evidenceRef")),
        reviewBy: dateAttribute(raw, "review_by", "reviewBy"),
      } satisfies Observation["attributes"];
    case "hypothesis":
      return {
        whatWasTried: String(recordValue(raw, "what_was_tried", "whatWasTried")),
        whyItFailed: String(recordValue(raw, "why_it_failed", "whyItFailed")),
        evidenceRef: String(recordValue(raw, "evidence_ref", "evidenceRef")),
        ...(recordValue(raw, "would_reconsider_if", "wouldReconsiderIf") !== undefined
          ? {
              wouldReconsiderIf: String(
                recordValue(raw, "would_reconsider_if", "wouldReconsiderIf"),
              ),
            }
          : {}),
      } satisfies Hypothesis["attributes"];
    case "decision":
      return {
        statement: String(raw.statement),
        rationale: String(raw.rationale),
        reversibility: raw.reversibility as Decision["attributes"]["reversibility"],
        alternativesRejected: Array.isArray(
          recordValue(raw, "alternatives_rejected", "alternativesRejected"),
        )
          ? (recordValue(
              raw,
              "alternatives_rejected",
              "alternativesRejected",
            ) as Decision["attributes"]["alternativesRejected"])
          : [],
        ...(raw.origin === "unrecoverable" ? { origin: "unrecoverable" as const } : {}),
      } satisfies Decision["attributes"];
    case "open_question":
      return {
        question: String(raw.question),
        blocking: Boolean(raw.blocking),
        ...(raw.owner !== undefined ? { owner: String(raw.owner) } : {}),
      } satisfies OpenQuestion["attributes"];
    case "constraint":
      return {
        rule: String(raw.rule),
        enforcement: raw.enforcement as Constraint["attributes"]["enforcement"],
        axiomatic: Boolean(raw.axiomatic),
      } satisfies Constraint["attributes"];
    case "glossary_entry":
      return {
        term: String(raw.term),
        definition: String(raw.definition),
        axiomatic: Boolean(raw.axiomatic),
        ...(Array.isArray(raw.aliases) ? { aliases: raw.aliases.map(String) } : {}),
      } satisfies GlossaryEntry["attributes"];
    case "artifact":
      return {
        kind: String(raw.kind),
        version: String(raw.version),
        location: String(raw.location),
        contentHash: String(recordValue(raw, "content_hash", "contentHash")),
        summary: String(raw.summary),
      } satisfies Artifact["attributes"];
  }
}

function objectFromRow(row: ObjectRow): KnowledgeObject {
  return {
    id: row.id,
    type: row.type,
    knowledgeClass: knowledgeClassOf(row.type),
    scopeId: row.scope_id,
    featureLabelIds: row.feature_label_ids ?? [],
    title: row.title,
    body: row.body,
    status: row.status,
    attributes: attributesFor(row.type, row.attributes),
    authoredBy: row.authored_by,
    sourceRef: row.source_ref,
    createdAt: dateValue(row.created_at) ?? new Date(0),
    approvedAt: dateValue(row.approved_at),
    lastVerifiedAt: dateValue(row.last_verified_at),
    supersedesId: row.supersedes_id,
    supersededById: row.superseded_by_id,
    reviewRequired: row.review_required,
    validFromVersion: Number(row.valid_from_version),
    validToVersion: versionValue(row.valid_to_version),
    lockVersion: row.lock_version,
  } as KnowledgeObject;
}

export async function getCurrentGraphVersion(client: Client): Promise<GraphVersionSnapshot> {
  const result = await client.query<{ version: string; created_at: Date }>(
    `SELECT version::text, created_at
     FROM graph_versions
     ORDER BY version DESC
     LIMIT 1`,
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("graph has no committed version");
  }
  return { version: Number(row.version), createdAt: row.created_at };
}

export async function getCurrentGraphVersionOrZero(client: Client): Promise<GraphVersionSnapshot> {
  const result = await client.query<{ version: string; created_at: Date }>(
    `SELECT version::text, created_at
     FROM graph_versions
     ORDER BY version DESC
     LIMIT 1`,
  );
  const row = result.rows[0];
  if (row === undefined) {
    return { version: 0, createdAt: new Date(0) };
  }
  return { version: Number(row.version), createdAt: row.created_at };
}

export async function loadPackWorkingSet(client: Client): Promise<PackWorkingSet> {
  const objects = await client.query<ObjectRow>(
    `SELECT id, type, scope_id, feature_label_ids, title, body, status, attributes,
            authored_by, source_ref, created_at, approved_at, last_verified_at,
            supersedes_id, superseded_by_id, review_required,
            valid_from_version, valid_to_version, lock_version
     FROM knowledge_objects
     ORDER BY id`,
  );
  const relations = await client.query<RelationRow>(
    `SELECT id::text, source_id, relation, target_id, target_kind, created_at,
            valid_from_version, valid_to_version
     FROM relations
     ORDER BY id`,
  );
  const scopes = await client.query<{
    id: string;
    kind: Scope["kind"];
    parent_id: string | null;
    name: string;
    path: string;
    depth: number;
  }>(
    `SELECT id, kind, parent_id, name, path::text, depth
     FROM scopes
     ORDER BY depth DESC, id`,
  );
  const labels = await client.query<LabelRow>(
    `SELECT id, project_scope_id, canonical_name, status, redirects_to_id,
            valid_from_version, valid_to_version
     FROM feature_labels
     ORDER BY id, valid_from_version`,
  );
  const aliases = await client.query<AliasRow>(
    `SELECT label_id, alias, project_scope_id, valid_from_version, valid_to_version
     FROM feature_label_aliases
     ORDER BY project_scope_id, alias, valid_from_version`,
  );
  const externalReferences = await client.query<ExternalReferenceRow>(
    `SELECT id, system, identifier, location, symbol, last_verified_at, created_at
     FROM external_references
     ORDER BY id`,
  );
  const graphVersions = await client.query<{ version: string; created_at: Date }>(
    `SELECT version::text, created_at
     FROM graph_versions
     ORDER BY version`,
  );

  return {
    objects: objects.rows.map(objectFromRow),
    relations: relations.rows.map((row) => ({
      id: String(row.id),
      sourceId: row.source_id,
      relation: row.relation,
      targetId: row.target_id,
      targetKind: row.target_kind,
      createdAt: dateValue(row.created_at) ?? new Date(0),
      validFromVersion: Number(row.valid_from_version),
      validToVersion: versionValue(row.valid_to_version),
    })),
    scopes: scopes.rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      parentId: row.parent_id,
      name: row.name,
      path: row.path,
      depth: row.depth,
    })),
    labels: labels.rows.map((row) => ({
      id: row.id,
      projectScopeId: row.project_scope_id,
      canonicalName: row.canonical_name,
      status: row.status,
      redirectsToId: row.redirects_to_id,
      validFromVersion: Number(row.valid_from_version),
      validToVersion: versionValue(row.valid_to_version),
    })),
    aliases: aliases.rows.map((row) => ({
      labelId: row.label_id,
      alias: row.alias,
      projectScopeId: row.project_scope_id,
      validFromVersion: Number(row.valid_from_version),
      validToVersion: versionValue(row.valid_to_version),
    })),
    externalReferences: externalReferences.rows.map((row) => ({
      type: "external_reference" as const,
      id: row.id,
      system: row.system,
      identifier: row.identifier,
      location: row.location,
      symbol: row.symbol,
      lastVerifiedAt: dateValue(row.last_verified_at),
      createdAt: dateValue(row.created_at) ?? new Date(0),
    })),
    graphVersions: graphVersions.rows.map((row) => ({
      version: Number(row.version),
      createdAt: row.created_at,
    })),
  };
}

export async function storeContextPackRecipe(
  client: Client,
  recipe: ContextPackRecipe,
  id: string,
): Promise<void> {
  await client.query(
    `INSERT INTO context_packs (
       id, scope_id, feature_label_ids, glossary_entry_ids, intent, budget,
       graph_version, built_at, ordered_object_ids, dropped_object_ids, content_hash
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      id,
      recipe.scopeId,
      recipe.featureLabelIds,
      recipe.glossaryEntryIds,
      recipe.intent,
      recipe.budget,
      recipe.graphVersion,
      recipe.builtAt,
      recipe.orderedObjectIds,
      recipe.droppedObjectIds,
      recipe.contentHash,
    ],
  );
}

export async function loadContextPackRecipe(
  client: Client,
  id: string,
): Promise<ContextPackRecipe> {
  const result = await client.query<{
    scope_id: string;
    feature_label_ids: string[];
    glossary_entry_ids: string[];
    intent: ContextPackIntent;
    budget: number;
    graph_version: number | string;
    built_at: Date;
    ordered_object_ids: string[];
    dropped_object_ids: string[];
    content_hash: string;
  }>(
    `SELECT scope_id, feature_label_ids, glossary_entry_ids, intent, budget,
            graph_version, built_at, ordered_object_ids, dropped_object_ids,
            content_hash
     FROM context_packs
     WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`context pack recipe not found: ${id}`);
  }
  return {
    scopeId: row.scope_id,
    featureLabelIds: row.feature_label_ids,
    glossaryEntryIds: row.glossary_entry_ids,
    intent: row.intent,
    budget: row.budget,
    graphVersion: Number(row.graph_version),
    builtAt: row.built_at,
    orderedObjectIds: row.ordered_object_ids,
    droppedObjectIds: row.dropped_object_ids,
    contentHash: row.content_hash,
  };
}
