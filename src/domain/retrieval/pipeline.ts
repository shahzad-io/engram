import { DomainError, ErrorCode } from "../errors.js";
import { knowledgeClassOf } from "../entity/class.js";
import type { KnowledgeObject } from "../entity/types.js";
import { activeAtGraphVersion } from "../invariant/check.js";
import { CYCLE_DEPTH_BOUND, type Relation } from "../relation/index.js";
import { resolveChain, type Scope } from "../scope/index.js";
import { stalenessMarker } from "../pack/staleness.js";
import type {
  RetrievalRequest,
  RetrievalResponse,
  RetrievalResult,
  RetrievalWorkingSet,
} from "./types.js";

const TYPE_ORDER: Readonly<Record<KnowledgeObject["type"], number>> = {
  requirement: 1,
  decision: 2,
  constraint: 3,
  open_question: 4,
  hypothesis: 5,
  observation: 6,
  glossary_entry: 7,
  artifact: 8,
  discussion: 9,
};

function fail(code: string, message: string): never {
  throw new DomainError(code, message);
}

function activeAt(
  validFromVersion: number,
  validToVersion: number | null,
  version: number,
): boolean {
  return activeAtGraphVersion(validFromVersion, validToVersion, version);
}

function scopeMap(scopes: readonly Scope[]): ReadonlyMap<string, Scope> {
  return new Map(scopes.map((scope) => [scope.id, scope]));
}

function scopeChain(
  scopeId: string | undefined,
  scopes: ReadonlyMap<string, Scope>,
): ReadonlySet<string> {
  if (scopeId === undefined) return new Set(scopes.keys());
  return new Set(resolveChain(scopeId, scopes).map((scope) => scope.id));
}

function featureMatch(object: KnowledgeObject, labels: ReadonlySet<string>): boolean {
  if (labels.size === 0) return true;
  if (object.type === "observation") return true;
  if (knowledgeClassOf(object.type) !== "reviewed") return true;
  return object.featureLabelIds.length === 0 || object.featureLabelIds.some((id) => labels.has(id));
}

function matchesFilters(
  object: KnowledgeObject,
  request: RetrievalRequest,
  inScope: ReadonlySet<string>,
): boolean {
  if (!inScope.has(object.scopeId)) return false;
  if (!activeAt(object.validFromVersion, object.validToVersion, request.asOfVersion)) {
    return false;
  }
  if (request.types !== undefined && !request.types.includes(object.type)) return false;
  if (request.classes !== undefined && !request.classes.includes(knowledgeClassOf(object.type))) {
    return false;
  }
  if (request.statuses === undefined) {
    if (object.status !== "active") return false;
  } else if (!request.statuses.includes(object.status)) {
    return false;
  }
  return featureMatch(object, new Set(request.featureLabelIds ?? []));
}

function relationTarget(
  edge: Relation,
  currentId: string,
  direction: RetrievalRequest["direction"],
): string | null {
  if (direction === "incoming") {
    return edge.targetId === currentId ? edge.sourceId : null;
  }
  if (direction === "outgoing") {
    return edge.sourceId === currentId ? edge.targetId : null;
  }
  if (edge.sourceId === currentId) return edge.targetId;
  if (edge.targetId === currentId) return edge.sourceId;
  return null;
}

function exactTraversal(
  set: RetrievalWorkingSet,
  request: RetrievalRequest,
  inScope: ReadonlySet<string>,
): KnowledgeObject[] {
  if (request.seedObjectId === undefined) return [];
  const objectsById = new Map(set.objects.map((object) => [object.id, object]));
  const queue: { readonly id: string; readonly depth: number }[] = [
    { id: request.seedObjectId, depth: 0 },
  ];
  const visited = new Set<string>([request.seedObjectId]);
  const results: KnowledgeObject[] = [];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || current.depth >= CYCLE_DEPTH_BOUND) continue;
    for (const edge of set.relations) {
      if (
        (request.relation !== undefined && edge.relation !== request.relation) ||
        !activeAt(edge.validFromVersion, edge.validToVersion, request.asOfVersion)
      ) {
        continue;
      }
      const nextId = relationTarget(edge, current.id, request.direction ?? "outgoing");
      if (nextId === null || visited.has(nextId)) continue;
      visited.add(nextId);
      queue.push({ id: nextId, depth: current.depth + 1 });
      const next = objectsById.get(nextId);
      if (next !== undefined && matchesFilters(next, request, inScope)) {
        results.push(next);
      }
    }
  }
  return results;
}

function metadataResults(
  set: RetrievalWorkingSet,
  request: RetrievalRequest,
  inScope: ReadonlySet<string>,
): KnowledgeObject[] {
  return set.objects.filter((object) => matchesFilters(object, request, inScope));
}

function searchText(object: KnowledgeObject): string {
  return `${object.title} ${object.body} ${JSON.stringify(object.attributes)}`.toLowerCase();
}

function keywordResults(
  set: RetrievalWorkingSet,
  request: RetrievalRequest,
  inScope: ReadonlySet<string>,
): KnowledgeObject[] {
  const text = request.text?.trim().toLowerCase();
  if (text === undefined || text === "") return [];
  const terms = text.split(/\s+/u).filter((term) => term !== "");
  return set.objects.filter((object) => {
    if (!matchesFilters(object, request, inScope)) return false;
    const haystack = searchText(object);
    return terms.every((term) => haystack.includes(term));
  });
}

function supersessionMember(
  object: KnowledgeObject,
  objectsById: ReadonlyMap<string, KnowledgeObject>,
  version: number,
): KnowledgeObject {
  let current = object;
  const seen = new Set<string>();
  while (current.supersededById !== null && !seen.has(current.id)) {
    seen.add(current.id);
    const successor = objectsById.get(current.supersededById);
    if (
      successor === undefined ||
      !activeAt(successor.validFromVersion, successor.validToVersion, version)
    ) {
      break;
    }
    current = successor;
  }
  return current;
}

function evidenceIds(
  objectId: string,
  relations: readonly Relation[],
  version: number,
): readonly string[] {
  return [
    ...new Set(
      relations
        .filter(
          (edge) =>
            edge.sourceId === objectId &&
            activeAt(edge.validFromVersion, edge.validToVersion, version) &&
            (edge.relation === "references" || edge.relation === "derives_from"),
        )
        .map((edge) => edge.targetId),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

function orderResults(results: readonly RetrievalResult[]): readonly RetrievalResult[] {
  return [...results].sort(
    (left, right) =>
      right.scopeDepth - left.scopeDepth ||
      TYPE_ORDER[left.object.type] - TYPE_ORDER[right.object.type] ||
      left.object.id.localeCompare(right.object.id),
  );
}

function makeResults(
  objects: readonly KnowledgeObject[],
  tier: 1 | 2 | 3,
  set: RetrievalWorkingSet,
  request: RetrievalRequest,
  scopes: ReadonlyMap<string, Scope>,
): readonly RetrievalResult[] {
  const objectsById = new Map(set.objects.map((object) => [object.id, object]));
  const follow = request.followSupersession ?? request.asOfVersion === request.currentVersion;
  const seen = new Set<string>();
  const results: RetrievalResult[] = [];
  const evaluatedAt = request.evaluatedAt ?? new Date();
  for (const object of objects) {
    const selected = follow ? supersessionMember(object, objectsById, request.asOfVersion) : object;
    if (
      seen.has(selected.id) ||
      !matchesFilters(selected, request, scopeChain(request.scopeId, scopes))
    ) {
      continue;
    }
    seen.add(selected.id);
    results.push({
      object: selected,
      tier,
      scopeDepth: scopes.get(selected.scopeId)?.depth ?? -1,
      staleness: stalenessMarker(selected, evaluatedAt),
      provenance: {
        authoredBy: selected.authoredBy,
        approvedAt: selected.approvedAt,
        lastVerifiedAt: selected.lastVerifiedAt,
        reviewRequired: selected.reviewRequired,
      },
      evidenceReferenceIds: evidenceIds(selected.id, set.relations, request.asOfVersion),
    });
  }
  return orderResults(results);
}

export function retrieve(set: RetrievalWorkingSet, request: RetrievalRequest): RetrievalResponse {
  const scopes = scopeMap(set.scopes);
  const inScope = scopeChain(request.scopeId, scopes);
  if (request.scopeId !== undefined && !scopes.has(request.scopeId)) {
    fail(ErrorCode.SCOPE_NOT_FOUND, `scope not found: ${request.scopeId}`);
  }

  const tierEscalations: string[] = [];
  const exact = exactTraversal(set, request, inScope);
  if (exact.length > 0) {
    return {
      results: makeResults(exact, 1, set, request, scopes),
      tier: 1,
      tierEscalations,
    };
  }
  if (request.seedObjectId !== undefined) {
    tierEscalations.push("tier-2");
  }

  const queryText = request.text?.trim() ?? "";
  const hasText = queryText !== "";
  const hasExplicitMetadata =
    request.featureLabelIds !== undefined ||
    request.types !== undefined ||
    request.classes !== undefined ||
    request.statuses !== undefined;
  const metadata = !hasText || hasExplicitMetadata ? metadataResults(set, request, inScope) : [];
  if (metadata.length > 0) {
    return {
      results: makeResults(metadata, 2, set, request, scopes),
      tier: 2,
      tierEscalations,
    };
  }
  if (hasText) {
    tierEscalations.push("tier-3");
    const keyword = keywordResults(set, request, inScope);
    if (keyword.length > 0) {
      return {
        results: makeResults(keyword, 3, set, request, scopes),
        tier: 3,
        tierEscalations,
      };
    }
  }
  return {
    results: [],
    tier: hasText ? 3 : metadata.length > 0 ? 2 : null,
    tierEscalations,
  };
}
