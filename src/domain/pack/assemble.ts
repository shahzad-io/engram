import { createHash } from "node:crypto";
import { DomainError, ErrorCode } from "../errors.js";
import { knowledgeClassOf } from "../entity/class.js";
import type { ExternalReference, GlossaryEntry, KnowledgeObject } from "../entity/types.js";
import { activeAtGraphVersion } from "../invariant/check.js";
import { resolveChain, type Scope } from "../scope/index.js";
import { canonicalJson, renderedObjectCost, renderedObjectText } from "./cost.js";
import { matchGlossaryTerms } from "./glossary.js";
import {
  PACK_SECTIONS,
  profileSections,
  sectionDefinition,
  sectionForObject,
  effectivePackStatus,
} from "./profiles.js";
import { noStalenessMarker, stalenessMarker } from "./staleness.js";
import type {
  ContextPack,
  ContextPackRequest,
  ContextPackSection,
  ContextPackRecipe,
  GraphVersionSnapshot,
  PackSectionKey,
  PackWorkingSet,
  RenderedObject,
} from "./types.js";

type Candidate = {
  readonly object: KnowledgeObject;
  readonly section: PackSectionKey;
  readonly mandatory: boolean;
  readonly explicitGlossary: boolean;
  readonly parentPosition?: number;
};

type RenderedCandidate = {
  readonly candidate: Candidate;
  readonly rendered: RenderedObject;
};

type TruncationResult = {
  readonly retained: readonly RenderedCandidate[];
  readonly dropped: readonly string[];
  readonly cost: number;
};

const GLOSSARY_PASS_COUNT = 2;

const TYPE_ORDER: Readonly<Record<KnowledgeObject["type"] | "external_reference", number>> = {
  requirement: 1,
  decision: 2,
  constraint: 3,
  open_question: 4,
  hypothesis: 5,
  observation: 6,
  glossary_entry: 7,
  artifact: 8,
  discussion: 9,
  external_reference: 10,
};

function fail(code: string, message: string): never {
  throw new DomainError(code, message);
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function scopeMap(scopes: readonly Scope[]): ReadonlyMap<string, Scope> {
  return new Map(scopes.map((scope) => [scope.id, scope]));
}

function graphVersion(
  snapshots: readonly GraphVersionSnapshot[],
  version: number,
): GraphVersionSnapshot {
  const snapshot = snapshots.find((row) => row.version === version);
  if (snapshot === undefined) {
    fail(ErrorCode.PACK_GRAPH_VERSION_NOT_FOUND, `graph version not loaded: ${version}`);
  }
  return snapshot;
}

function objectInVersion(object: KnowledgeObject, version: number): boolean {
  return activeAtGraphVersion(object.validFromVersion, object.validToVersion, version);
}

function relationInVersion(
  validFromVersion: number,
  validToVersion: number | null,
  version: number,
): boolean {
  return activeAtGraphVersion(validFromVersion, validToVersion, version);
}

function recentSuperseded(object: KnowledgeObject, version: number): boolean {
  if (object.type !== "decision" || object.status !== "superseded") {
    return false;
  }
  const closedAtVersion = object.validToVersion;
  const versionFloor = version - 9;
  return closedAtVersion !== null && closedAtVersion >= versionFloor;
}

function sectionIndex(section: PackSectionKey): number {
  return sectionDefinition(section).index;
}

function scopeDepth(object: KnowledgeObject, scopes: ReadonlyMap<string, Scope>): number {
  return scopes.get(object.scopeId)?.depth ?? -1;
}

function candidateCompare(
  left: Candidate | RenderedCandidate,
  right: Candidate | RenderedCandidate,
  scopes: ReadonlyMap<string, Scope>,
): number {
  const leftCandidate = "candidate" in left ? left.candidate : left;
  const rightCandidate = "candidate" in right ? right.candidate : right;
  const sectionDifference =
    sectionIndex(leftCandidate.section) - sectionIndex(rightCandidate.section);
  if (sectionDifference !== 0) return sectionDifference;
  const depthDifference =
    scopeDepth(rightCandidate.object, scopes) - scopeDepth(leftCandidate.object, scopes);
  if (depthDifference !== 0) return depthDifference;
  const typeDifference =
    TYPE_ORDER[leftCandidate.object.type] - TYPE_ORDER[rightCandidate.object.type];
  if (typeDifference !== 0) return typeDifference;
  return leftCandidate.object.id.localeCompare(rightCandidate.object.id);
}

function packCompare(
  left: RenderedCandidate,
  right: RenderedCandidate,
  scopes: ReadonlyMap<string, Scope>,
): number {
  if (
    left.rendered.section === "external_references" &&
    right.rendered.section === "external_references"
  ) {
    return referenceCompare(left, right);
  }
  return candidateCompare(left, right, scopes);
}

function referenceCompare(left: RenderedCandidate, right: RenderedCandidate): number {
  const leftParent = left.candidate.parentPosition ?? Number.MAX_SAFE_INTEGER;
  const rightParent = right.candidate.parentPosition ?? Number.MAX_SAFE_INTEGER;
  return leftParent - rightParent || left.rendered.id.localeCompare(right.rendered.id);
}

function isFeatureMatch(object: KnowledgeObject, labels: ReadonlySet<string>): boolean {
  if (labels.size === 0) return true;
  if (
    object.type === "constraint" ||
    object.type === "observation" ||
    (object.type === "open_question" && object.attributes.blocking)
  ) {
    return true;
  }
  if (knowledgeClassOf(object.type) !== "reviewed") return true;
  return object.featureLabelIds.length === 0 || object.featureLabelIds.some((id) => labels.has(id));
}

function precedenceKey(object: KnowledgeObject): string | null {
  if (object.type === "constraint") {
    return `constraint:${object.attributes.rule.trim().toLowerCase()}`;
  }
  if (object.type === "glossary_entry") {
    return `glossary:${object.attributes.term.trim().toLowerCase()}`;
  }
  return null;
}

function applyPrecedence(
  candidates: readonly Candidate[],
  scopes: ReadonlyMap<string, Scope>,
): { readonly candidates: readonly Candidate[]; readonly suppressed: readonly string[] } {
  const sorted = [...candidates].sort((a, b) => candidateCompare(a, b, scopes));
  const retained: Candidate[] = [];
  const suppressed: string[] = [];
  const winners = new Map<string, Candidate>();
  for (const candidate of sorted) {
    const key = precedenceKey(candidate.object);
    if (key === null) {
      retained.push(candidate);
      continue;
    }
    const winner = winners.get(key);
    if (winner === undefined) {
      winners.set(key, candidate);
      retained.push(candidate);
      continue;
    }
    if (candidate.explicitGlossary && winner.explicitGlossary) {
      retained.push(candidate);
      continue;
    }
    if (candidate.explicitGlossary && !winner.explicitGlossary) {
      const winnerIndex = retained.findIndex((item) => item.object.id === winner.object.id);
      if (winnerIndex >= 0) {
        retained.splice(winnerIndex, 1);
      }
      suppressed.push(winner.object.id);
      winners.set(key, candidate);
      retained.push(candidate);
    } else {
      suppressed.push(candidate.object.id);
    }
  }
  return { candidates: retained, suppressed: uniqueSorted(suppressed) };
}

function renderBody(object: KnowledgeObject): string | null {
  switch (object.type) {
    case "observation":
    case "discussion":
      return null;
    case "constraint":
      return object.attributes.rule;
    case "glossary_entry":
      return object.attributes.definition;
    case "artifact":
      return object.attributes.summary;
    default:
      return object.body;
  }
}

function evidenceIds(
  objectId: string,
  relations: PackWorkingSet["relations"],
  version: number,
): string[] {
  return uniqueSorted(
    relations
      .filter(
        (edge) =>
          edge.sourceId === objectId &&
          relationInVersion(edge.validFromVersion, edge.validToVersion, version) &&
          (edge.relation === "references" || edge.relation === "derives_from"),
      )
      .map((edge) => edge.targetId),
  );
}

function renderKnowledgeObject(
  candidate: Candidate,
  set: PackWorkingSet,
  scopeById: ReadonlyMap<string, Scope>,
  request: ContextPackRequest,
): RenderedCandidate {
  const object = candidate.object;
  const scope = scopeById.get(object.scopeId);
  if (scope === undefined) {
    fail(ErrorCode.SCOPE_NOT_FOUND, `scope not found: ${object.scopeId}`);
  }
  return {
    candidate,
    rendered: {
      id: object.id,
      type: object.type,
      section: candidate.section,
      scopeId: object.scopeId,
      scopePath: scope.path,
      authoredBy: object.authoredBy,
      origin: object.type === "decision" ? (object.attributes.origin ?? null) : null,
      approvedAt: object.approvedAt,
      status: object.status,
      title: object.title,
      body: renderBody(object),
      attributes: object.attributes as unknown as Record<string, unknown>,
      staleness: stalenessMarker(object, request.builtAt),
      reviewRequired: object.reviewRequired,
      evidenceReferenceIds: evidenceIds(object.id, set.relations, request.graphVersion),
    },
  };
}

function renderExternalReference(
  reference: ExternalReference,
  parentPosition: number,
): RenderedCandidate {
  const body = [reference.location, reference.symbol].filter(
    (value): value is string => value !== null,
  );
  const candidate: Candidate = {
    object: {
      id: reference.id,
      type: "artifact",
      knowledgeClass: "reviewed",
      scopeId: "",
      featureLabelIds: [],
      title: reference.identifier,
      body: body.join(" · "),
      status: "current",
      attributes: {
        kind: "external_reference",
        version: "",
        location: reference.location ?? "",
        contentHash: "",
        summary: reference.identifier,
      },
      authoredBy: "human",
      sourceRef: null,
      createdAt: reference.createdAt,
      approvedAt: null,
      lastVerifiedAt: reference.lastVerifiedAt,
      supersedesId: null,
      supersededById: null,
      reviewRequired: false,
      validFromVersion: 0,
      validToVersion: null,
      lockVersion: 0,
    } as KnowledgeObject,
    section: "external_references",
    mandatory: false,
    explicitGlossary: false,
    parentPosition,
  };
  return {
    candidate,
    rendered: {
      id: reference.id,
      type: "external_reference",
      section: "external_references",
      scopeId: null,
      scopePath: null,
      authoredBy: null,
      origin: null,
      approvedAt: null,
      status: null,
      title: reference.identifier,
      body: body.join(" · "),
      attributes: {
        system: reference.system,
        identifier: reference.identifier,
        location: reference.location,
        symbol: reference.symbol,
        lastVerifiedAt: reference.lastVerifiedAt,
      },
      staleness: noStalenessMarker(),
      reviewRequired: false,
      evidenceReferenceIds: [],
    },
  };
}

function truncate(
  mandatory: readonly RenderedCandidate[],
  optional: readonly RenderedCandidate[],
  budget: number,
  scopes: ReadonlyMap<string, Scope>,
): TruncationResult {
  const mandatoryCost = mandatory.reduce(
    (total, item) => total + renderedObjectCost(item.rendered),
    0,
  );
  if (mandatoryCost > budget) {
    fail(
      ErrorCode.PACK_BUDGET_INSUFFICIENT,
      `mandatory content costs ${mandatoryCost} tokens for a ${budget}-token budget`,
    );
  }
  const orderedOptional = [...optional].sort((a, b) => candidateCompare(a, b, scopes));
  const retainedOptional: RenderedCandidate[] = [];
  let cost = mandatoryCost;
  let firstDropped = false;
  const dropped: string[] = [];
  for (const item of orderedOptional) {
    const itemCost = renderedObjectCost(item.rendered);
    if (!firstDropped && cost + itemCost <= budget) {
      retainedOptional.push(item);
      cost += itemCost;
    } else {
      firstDropped = true;
      dropped.push(item.rendered.id);
    }
  }
  const retained = [...mandatory, ...retainedOptional].sort((a, b) =>
    candidateCompare(a, b, scopes),
  );
  return { retained, dropped, cost };
}

function retainedContent(retained: readonly RenderedCandidate[]): string[] {
  return retained
    .filter((item) => item.rendered.section !== "glossary")
    .map((item) => renderedObjectText(item.rendered));
}

function uniqueCandidates(candidates: readonly RenderedCandidate[]): RenderedCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((item) => {
    if (seen.has(item.rendered.id)) return false;
    seen.add(item.rendered.id);
    return true;
  });
}

function attachExternalReferences(
  retained: readonly RenderedCandidate[],
  set: PackWorkingSet,
  request: ContextPackRequest,
): RenderedCandidate[] {
  const parentPositions = new Map(
    retained
      .filter((item) => item.rendered.type !== "external_reference")
      .map((item, index) => [item.rendered.id, index]),
  );
  const referenceById = new Map(
    set.externalReferences.map((reference) => [reference.id, reference]),
  );
  const seen = new Set<string>();
  const references: RenderedCandidate[] = [];
  const edges = set.relations
    .filter(
      (edge) =>
        (edge.relation === "references" || edge.relation === "implemented_by") &&
        edge.targetKind === "external_reference" &&
        relationInVersion(edge.validFromVersion, edge.validToVersion, request.graphVersion),
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  for (const edge of edges) {
    const parentPosition = parentPositions.get(edge.sourceId);
    const reference = referenceById.get(edge.targetId);
    if (parentPosition === undefined || reference === undefined || seen.has(reference.id)) {
      continue;
    }
    seen.add(reference.id);
    references.push(renderExternalReference(reference, parentPosition));
  }
  return references.sort(referenceCompare);
}

function hashRecipe(recipe: Omit<ContextPackRecipe, "contentHash">): string {
  return createHash("sha256").update(canonicalJson(recipe)).digest("hex");
}

function renderSections(
  retained: readonly RenderedCandidate[],
  intent: ContextPackRequest["intent"],
): readonly ContextPackSection[] {
  const enabled = new Set(profileSections(intent));
  return PACK_SECTIONS.filter((definition) => enabled.has(definition.key)).map((definition) => ({
    name: definition.name,
    key: definition.key,
    objects: retained
      .filter((item) => item.rendered.section === definition.key)
      .sort((left, right) => {
        if (definition.key === "external_references") {
          return referenceCompare(left, right);
        }
        return 0;
      })
      .map((item) => item.rendered),
  }));
}

function validateFeatureLabels(
  labelIds: readonly string[],
  set: PackWorkingSet,
  version: number,
): void {
  for (const labelId of labelIds) {
    if (
      !set.labels.some(
        (label) =>
          label.id === labelId &&
          activeAtGraphVersion(label.validFromVersion, label.validToVersion, version),
      )
    ) {
      fail(
        ErrorCode.UNKNOWN_LABEL,
        `feature label is not available at version ${version}: ${labelId}`,
      );
    }
  }
}

export function assembleContextPack(set: PackWorkingSet, request: ContextPackRequest): ContextPack {
  if (!Number.isInteger(request.budget) || request.budget <= 0) {
    fail(
      ErrorCode.PACK_BUDGET_INSUFFICIENT,
      `budget must be a positive integer: ${request.budget}`,
    );
  }
  const scopeById = scopeMap(set.scopes);
  const scope = scopeById.get(request.scopeId);
  if (scope === undefined) {
    const valid = [...set.scopes.map((entry) => entry.id)].sort((left, right) =>
      left.localeCompare(right),
    );
    fail(
      ErrorCode.SCOPE_NOT_FOUND,
      `unknown scope "${request.scopeId}"; valid scope ids: ${valid.join(", ")}`,
    );
  }
  graphVersion(set.graphVersions, request.graphVersion);
  const chain = resolveChain(request.scopeId, scopeById);
  const featureLabelIds = uniqueSorted(request.featureLabelIds ?? []);
  const glossaryEntryIds = uniqueSorted(request.glossaryEntryIds ?? []);
  validateFeatureLabels(featureLabelIds, set, request.graphVersion);
  const featureLabels = new Set(featureLabelIds);
  const profile = new Set(profileSections(request.intent));
  const objectsById = new Map(set.objects.map((object) => [object.id, object]));

  const candidates: Candidate[] = [];
  const glossaryPool: Candidate[] = [];
  for (const object of set.objects) {
    if (!chain.some((ancestor) => ancestor.id === object.scopeId)) continue;
    const live = objectInVersion(object, request.graphVersion);
    const isRecent = recentSuperseded(object, request.graphVersion);
    if (!live && !isRecent) continue;
    const section = sectionForObject(object, isRecent, request.graphVersion);
    if (section === null || !profile.has(section)) continue;
    if (object.type === "discussion") continue;
    const packStatus = effectivePackStatus(object, request.graphVersion);
    const explicitGlossary =
      object.type === "glossary_entry" && glossaryEntryIds.includes(object.id);
    if (!explicitGlossary && !isFeatureMatch(object, featureLabels)) continue;
    const mandatory =
      object.type === "constraint" ||
      (object.type === "open_question" && packStatus === "open" && object.attributes.blocking) ||
      explicitGlossary;
    const candidate: Candidate = {
      object,
      section,
      mandatory,
      explicitGlossary,
    };
    if (object.type === "glossary_entry" && !explicitGlossary) {
      glossaryPool.push(candidate);
    } else {
      candidates.push(candidate);
    }
  }

  for (const glossaryId of glossaryEntryIds) {
    const object = objectsById.get(glossaryId);
    if (
      object === undefined ||
      object.type !== "glossary_entry" ||
      !objectInVersion(object, request.graphVersion) ||
      !chain.some((ancestor) => ancestor.id === object.scopeId)
    ) {
      fail(ErrorCode.GLOSSARY_ENTRY_NOT_FOUND, `glossary entry is not available: ${glossaryId}`);
    }
  }

  const precedence = applyPrecedence([...candidates, ...glossaryPool], scopeById);
  const eligible = precedence.candidates;
  const eligibleGlossaryIds = new Set(
    eligible
      .filter((candidate) => candidate.object.type === "glossary_entry")
      .map((candidate) => candidate.object.id),
  );
  const eligibleCandidates = eligible.filter(
    (candidate) => candidate.object.type !== "glossary_entry" || candidate.explicitGlossary,
  );
  const eligibleGlossary = glossaryPool.filter((candidate) =>
    eligibleGlossaryIds.has(candidate.object.id),
  );
  const mandatory = eligibleCandidates.filter((candidate) => candidate.mandatory);
  const optionalBase = eligibleCandidates.filter((candidate) => !candidate.mandatory);

  const render = (candidate: Candidate): RenderedCandidate =>
    renderKnowledgeObject(candidate, set, scopeById, request);
  const mandatoryRendered = mandatory.map(render);
  const optionalBaseRendered = optionalBase.map(render);
  const first = truncate(mandatoryRendered, optionalBaseRendered, request.budget, scopeById);
  const dropped = [...first.dropped];

  const glossaryRendered = eligibleGlossary.map(render);
  const firstMatch = matchGlossaryTerms(
    glossaryRendered.map((item) => item.candidate.object as GlossaryEntry),
    retainedContent(first.retained),
  );
  const firstMatchedIds = new Set(firstMatch.entries.map((entry) => entry.id));
  const firstMatched = glossaryRendered.filter((item) => firstMatchedIds.has(item.rendered.id));
  const firstOptionalRetained = first.retained.filter((item) => !item.candidate.mandatory);
  const afterFirstGlossary = truncate(
    mandatoryRendered,
    uniqueCandidates([...firstOptionalRetained, ...firstMatched]),
    request.budget,
    scopeById,
  );
  dropped.push(...afterFirstGlossary.dropped);

  const secondMatch = matchGlossaryTerms(
    glossaryRendered.map((item) => item.candidate.object as GlossaryEntry),
    retainedContent(afterFirstGlossary.retained),
  );
  const secondMatchedIds = new Set(secondMatch.entries.map((entry) => entry.id));
  const secondMatched = glossaryRendered.filter((item) => secondMatchedIds.has(item.rendered.id));
  const termsLostAfterSecondPass = firstMatch.entries
    .filter((entry) => !secondMatchedIds.has(entry.id))
    .map((entry) => entry.attributes.term);
  const secondOptionalRetained = afterFirstGlossary.retained.filter(
    (item) => !item.candidate.mandatory && item.rendered.section !== "glossary",
  );
  const afterSecondGlossary = truncate(
    mandatoryRendered,
    uniqueCandidates([...secondOptionalRetained, ...secondMatched]),
    request.budget,
    scopeById,
  );
  dropped.push(...afterSecondGlossary.dropped);

  const referenceCandidates = profile.has("external_references")
    ? attachExternalReferences(afterSecondGlossary.retained, set, request)
    : [];
  const remainingForReferences = Math.max(0, request.budget - afterSecondGlossary.cost);
  const retainedReferences: RenderedCandidate[] = [];
  let referencesCost = 0;
  for (const reference of referenceCandidates) {
    const cost = renderedObjectCost(reference.rendered);
    if (referencesCost + cost <= remainingForReferences) {
      retainedReferences.push(reference);
      referencesCost += cost;
    } else {
      dropped.push(reference.rendered.id);
    }
  }
  const retained = [...afterSecondGlossary.retained, ...retainedReferences].sort((left, right) =>
    packCompare(left, right, scopeById),
  );
  const orderedObjectIds = retained.map((item) => item.rendered.id);
  const droppedObjectIds = uniqueSorted(dropped).filter((id) => !orderedObjectIds.includes(id));
  const mandatoryEstimatedTokens = mandatoryRendered.reduce(
    (total, item) => total + renderedObjectCost(item.rendered),
    0,
  );
  const estimatedTokens = retained.reduce(
    (total, item) => total + renderedObjectCost(item.rendered),
    0,
  );
  const recipeWithoutHash: Omit<ContextPackRecipe, "contentHash"> = {
    scopeId: request.scopeId,
    featureLabelIds,
    glossaryEntryIds,
    intent: request.intent,
    budget: request.budget,
    graphVersion: request.graphVersion,
    builtAt: request.builtAt,
    orderedObjectIds,
    droppedObjectIds,
  };
  const recipe: ContextPackRecipe = {
    ...recipeWithoutHash,
    contentHash: hashRecipe(recipeWithoutHash),
  };
  const scopeObject = scope;
  return {
    recipe,
    objective: {
      scopeId: scopeObject.id,
      scopePath: scopeObject.path,
      scopeName: scopeObject.name,
    },
    sections: renderSections(retained, request.intent),
    diagnostics: {
      droppedCount: droppedObjectIds.length,
      suppressedByPrecedence: precedence.suppressed,
      tierEscalations: [...(request.tierEscalations ?? [])],
      estimatedTokens,
      budgetUtilisation: (estimatedTokens / request.budget) * 100,
      mandatoryEstimatedTokens,
      mandatoryContentBudgetPercentage: (mandatoryEstimatedTokens / request.budget) * 100,
      glossaryPasses: GLOSSARY_PASS_COUNT,
      glossaryResidualTerms: uniqueSorted([
        ...termsLostAfterSecondPass,
        ...secondMatch.entries
          .filter((entry) => !orderedObjectIds.includes(entry.id))
          .map((entry) => entry.attributes.term),
      ]),
    },
  };
}
