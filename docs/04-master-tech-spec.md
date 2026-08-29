# Project Knowledge Engine — Master Technical Specification

**Version:** 1.3
**Status:** All blocking items resolved. TC-1, TC-2, TC-7 closed by curator decision. See Section 0.3 and Section 26.
**Derived from:** 01 Vision v2.1, 02 Domain Specification v1.2, 03 PRD v1.2
**Derivation authority:** 01 Vision → 02 Domain Specification → 03 PRD → 04 Master Tech Spec → 05 Technology Spec. Each document implements the one above and may not redefine it. This document designs implementation. It does not redefine product or domain. Where it appears to, that is a defect and the source document wins.
**Vocabulary authority (domain concepts):** 02 Domain Specification. Entity names, knowledge classes, relation verbs, legal triples, lifecycles, and invariants are defined there. The Vision is prose; where Vision prose contradicts the Domain Spec on a domain concept, the Vision is the defect.

---

## 0. Reading Guide and Conflict Report

### 0.1 What this document is

An implementation design detailed enough that an engineering team can decompose it into implementation specifications without making further architectural decisions. It defines boundaries, contracts, persistence, algorithms, state transitions, failure behaviour, and test requirements.

It is not a task breakdown and contains no tickets.

### 0.2 Source brief truncation

The brief supplied for this document terminates mid-Section 17, inside the `context.build` signature. Sections 18 onward were not received.

This specification covers all seventeen received areas in full, and adds the areas a Master Technical Specification cannot omit: MCP access layer, persistence model, failure behaviour, testing, backfill tooling, instrumentation, and operational concerns (Sections 18 to 25). Those seven sections are inferred, not briefed. If the truncated portion of the brief specified different requirements for them, they must be reconciled.

### 0.3 Conflicts found

Full detail in Section 26. Summary:

| ID | Severity | Summary |
|---|---|---|
| ~~**TC-1**~~ | **Resolved** | Determinism versus time-derived staleness. **Accepted:** pack contents are determined by graph version; staleness labels may vary by build time. Observation expiry is a graph event and advances the version; all other staleness is display-only. Now normative in Domain Spec 11.2. Applied in 10.2 and 17. |
| ~~**TC-2**~~ | **Resolved** | Graph version granularity. **Confirmed:** one version per committed curation transaction, with two exceptions (verification, Candidate operations). Now normative in Domain Spec 7A. See 8.1 |
| **TC-3** | Non-blocking | `derives_from` permits Decision → Decision, which allows cycles. No source document forbids them. Transitive change-impact (PRD-REQ-006) is undefined over a cyclic graph. Resolved by adding an acyclicity constraint. |
| **TC-4** | Non-blocking | Domain Spec 3.4 requires a conflict warning between Constraints in the same chain, but Domain Spec 10 and PRD-CON-007 state conflicts are curator-declared, not detected. The warning therefore has no trigger. Resolved by narrowing to structural detection only. |
| **TC-5** | Non-blocking | Glossary term matching (PRD-GLO-003) matches against "the pack's other selected content", but truncation changes what is selected. Order of operations undefined. Resolved by a fixed two-pass algorithm. |
| **TC-6** | Non-blocking | Unbounded always-injected content can exceed budget on its own. No source document defines behaviour. Resolved as an error condition. |
| ~~**TC-7**~~ | **Resolved** | OQ-P1 feature labels. **Confirmed:** controlled, Project-scoped canonical registry with aliases, a candidate workflow at the proposal boundary, and merge by versioned redirect. No longer a configuration flag. See 3.4 |

---

## 1. System Boundaries

### 1.1 Layers

```
┌─────────────────────────────────────────────────────────┐
│  AI clients / curator CLI                    EXTERNAL   │
│  Consume packs, propose candidates, run triage          │
└────────────┬─────────────────────────┬──────────────────┘
             │ MCP (agent-facing)      │ CLI (curator-facing)
┌────────────▼─────────────────────────▼──────────────────┐
│  ACCESS LAYER                                            │
│  Transport, authn (none in V1), request validation,      │
│  serialisation. No domain logic. No retrieval policy.    │
├──────────────────────────────────────────────────────────┤
│  APPLICATION LAYER                                       │
│  Use cases: BuildContextPack, ProposeCandidate,          │
│  AcceptCandidate, SupersedeObject, VerifyObject,         │
│  ResolveDiscussion, DiffPacks, Traverse                  │
├──────────────────────────────────────────────────────────┤
│  DOMAIN LAYER                                            │
│  Entities, state machines, invariants, relation          │
│  legality, scope resolution, pack assembly.              │
│  Pure. No I/O. No framework types.                       │
├──────────────────────────────────────────────────────────┤
│  PERSISTENCE LAYER                                       │
│  Repositories, graph store, versioning, search index     │
└──────────────────────────────────────────────────────────┘
                          │
        ┌─────────────────┴──────────────────┐
        │  EXTERNAL SYSTEMS (authoritative)  │
        │  Git · tracker · docs · design ·   │
        │  dashboards · logs                 │
        │  Referenced only. Never mirrored.  │
        └────────────────────────────────────┘
```

### 1.2 Ownership

**The engine owns** (authoritative, no other system holds this): knowledge objects and their content, relations, scope tree, feature labels, provenance, lifecycle state, verification state, graph version history, and pack recipes.

**The engine references** (another system is authoritative): source code, commits, pull requests, tasks, documents, designs, dashboards, logs, and raw discussion transcripts where externally hosted.

**The engine derives** (reproducible, never authoritative): context packs, staleness markers, scope chains, retrieval results, change-impact sets, pack diffs, metrics.

### 1.3 Boundary rules

| Rule | Statement |
|---|---|
| B-1 | No table in the engine may store a field whose authoritative value lives in an external system, other than an identifier, a location, a content hash, and a verification timestamp. |
| B-2 | The access layer contains no retrieval policy. A client cannot choose a retrieval strategy (PRD-SRCH-002). |
| B-3 | The domain layer has no dependency on framework, transport, or storage types. It is unit-testable with no database. |
| B-4 | AI clients have no write path to durable knowledge. They may write Candidates only. |
| B-5 | Pack assembly is a domain-layer pure function over a loaded working set. It performs no I/O and calls no model. |
| B-6 | The engine never fetches an external reference during pack assembly. Resolution and verification are separate, out-of-band operations. |

### 1.4 What the MCP layer is not

MCP is one access interface. The domain does not know it exists. A CLI, a read-only view, or a second protocol must be addable without touching the domain layer. This is the concrete meaning of client neutrality in V1, which is otherwise untested (PRD Section 15).

---

## 2. Domain-to-Technical Mapping

### 2.1 Representation strategy

**Decision TD-1 (provisional, Section 27).** All ten knowledge entities are stored in one `knowledge_objects` table carrying the shared envelope, with entity-specific fields in a JSONB `attributes` column. Relations live in a single `relations` edge table. Scopes live in a separate `scopes` table (a scope is not a knowledge object).

Rationale: the envelope invariants (INV-1, INV-2, INV-6 to INV-9) are identical across all types and are enforced once. The edge table stays non-polymorphic. Traversal, scope filtering, keyword search, and staleness evaluation are single-table operations. Table-per-entity was rejected because it duplicates the envelope ten times and forces either ten join paths or a polymorphic edge table.

Cost accepted: entity-specific fields are not enforced by column-level database constraints. They are validated in the domain layer against a per-type schema, and a CHECK constraint enforces required JSONB keys per type as a backstop.

### 2.2 Common envelope

Every knowledge object:

| Field | Type | Notes |
|---|---|---|
| `id` | text, PK | Human-readable, type-prefixed, monotonic per type: `DEC-0041`, `REQ-0112`. Format `{TYPE}-{seq:04d}`. Stable forever. Ordering by `id` is lexicographic and deterministic. |
| `type` | enum | One of the ten entity types. Immutable. |
| `knowledge_class` | enum | raw, reviewed, operational. Derived from `type`, stored for index efficiency, enforced by CHECK. |
| `scope_id` | FK → scopes | Exactly one (INV-1). Immutable after approval. |
| `feature_label_ids` | text[] | Zero or more canonical label identities from the owning Project's registry. Never raw strings. Mutable as filing metadata in a curator curation transaction; never an assertion. See 3.4 |
| `title` | text | Required. Meaningful standalone. |
| `body` | text | Required. |
| `status` | enum | Per-type state machine (Section 5). |
| `attributes` | jsonb | Type-specific fields (2.3). |
| `authored_by` | enum | human, ai. |
| `source_ref` | text, nullable | Originating discussion or session identifier. |
| `created_at` | timestamptz | |
| `approved_at` | timestamptz, nullable | Required for Reviewed and Operational. Null for Raw. Candidates are a separate table and never appear here. |
| `last_verified_at` | timestamptz, nullable | Required for Reviewed and Operational (set at approval, updated by verification). Not used for Raw. Observation uses `review_by`. |
| `supersedes_id` | text, nullable, FK self | At most one (INV-6). Unique. |
| `superseded_by_id` | text, nullable, FK self | Denormalised inverse. Unique. Maintained in the same transaction. |
| `review_required` | boolean | Default false. See Section 8.6. |
| `valid_from_version` | bigint | Graph version at which this row became active. |
| `valid_to_version` | bigint, nullable | Graph version at which it left active state. Null while active. |
| `lock_version` | integer | Optimistic concurrency. |

`valid_from_version` and `valid_to_version` are what make pack reproduction at a historical graph version possible (PRD-CTX-011). Without them, reproduction only works against the present.

**One row per identity, with an exception.** `knowledge_objects` and `relations` keep a single row per id. This is retained because identity here is a readable id a curator cites, a superseding object is a *different* object with its own id rather than a new version of the old one, and every relation and evidence reference targets that id — a second row sharing it would make "which row does `derives_from` point at" a question the schema cannot answer. Status is version-windowed separately in `knowledge_object_status_history` (2.2.1).

This paragraph previously justified the design differently: that the only post-approval status changes are to terminal states, and terminal states are excluded from packs, so leaving `active` and closing the version window are the same event. That was false, and was false when written — a Decision may be verified, flagged for review, or reverted, and amendment A1 established that several terminal statuses are pack-visible, which is what makes rejected Hypotheses and recently superseded Decisions selectable at all. Status and window are therefore two independent axes, and treating them as one event is what allowed a status change to rewrite what an already-built pack selected. The conclusion survives the premise; the premise does not.

`feature_labels` and `feature_label_aliases` do **not** follow this pattern: deprecation and redirect change resolution behaviour without removing the label from resolution, so one row cannot represent both pre- and post-merge state. See 3.4.1.

#### 2.2.1 Status history

```sql
knowledge_object_status_history (
  object_id text NOT NULL REFERENCES knowledge_objects (id),
  graph_version bigint NOT NULL REFERENCES graph_versions (version),
  status knowledge_object_status NOT NULL,
  PRIMARY KEY (object_id, graph_version)
)
```

Selection reads an object's status at the requested graph version from this table, not from `knowledge_objects.status`, which is mutable and describes only the present. A row is written by an `AFTER INSERT OR UPDATE OF status` trigger rather than by each caller, because the invariant is that no status change goes unrecorded and three code paths change status today (INV-7's whitelist, rule 23).

`valid_to_version` needs no equivalent and gets none. Closing a window at *w* is not a retroactive change: `active_at(from, to, v)` for any `v < w` answers exactly as it did before the close, so history built at those versions is unaffected. Only reopening or moving a closed window is retroactive, and that is rejected by a `BEFORE UPDATE` trigger (`VALIDITY_WINDOW_CLOSED`) on each of the four windowed tables: `knowledge_objects`, `relations`, `feature_labels`, `feature_label_aliases`. The same trigger rejects any change to `valid_from_version` (`VALIDITY_WINDOW_START_IMMUTABLE`), which is retroactive for the same reason and was previously unguarded on the three tables other than `knowledge_objects`. Windows close once. `feature_label_ids` remains unwindowed and is the one accepted reproduction hole (A17, 10.2).

### 2.3 Per-entity mapping

Common to all: identity, ownership (the engine), deletion (never, INV-8), and
assertion mutation (never after approval, INV-7; change is supersession).
`feature_label_ids` is the filing-metadata exception and may be changed only
in a curator curation transaction. Only the differences are listed.

---

**Project / Workstream / Phase** — not knowledge objects. See Section 3.

---

**Requirement** (`REQ-`), reviewed class

- Required attributes: `source` (text), `rationale` (text)
- Optional: none
- States: `active → superseded | withdrawn`
- Relations out: `derives_from` (Requirement, Discussion, Artifact), `supersedes` (Requirement), `requires` (Requirement), `references`, `implemented_by`
- Validation: `source` non-empty. Body is a single statement; length soft-capped at 500 chars with a warning, not a rejection, since atomicity cannot be enforced mechanically.
- Versioning: supersession only. Transition to `superseded` or `withdrawn` triggers change-impact propagation (Section 8.6).

---

**Discussion** (`DSC-`), raw class

- Required attributes: `medium` (enum: chat, meeting, async, investigation), `occurred_at` (timestamptz), `content_ref` (object; see Section 13)
- Optional: `participants` (text[])
- States: `recorded → distilled | archived`
- Relations in: `derives_from`, `references` from any object
- Relations out: none
- Approval: not required. Raw class is the only class creatable without curation (Section 4).
- Retention: archived discussions past 180 days are subject to body reduction (Section 13.4). Distilled discussions are retained in full.
- Never rendered as body text in a pack (PRD-DSC-002). Enforced in the pack assembler, not by convention.

---

**Observation** (`OBS-`), raw class

- Required attributes: `observed_at` (timestamptz), `evidence_ref` (XREF id, required by INV-5), `review_by` (date, required by INV-5)
- States: `observed → promoted_to_question | promoted_to_hypothesis | absorbed | stale`
- Relations in: `explains` (from Decision or Hypothesis), `derives_from` (from Open Question, Hypothesis, Decision)
- Validation: creation without `evidence_ref` or `review_by` is rejected (PRD-OBS-002, PRD-OBS-003). Default `review_by` is `observed_at + 30 days`, applied by the application layer, not the domain.
- Staleness: materialised as a state transition, not a computed marker. This is the exception; see Section 10.2 and TC-1.
- Pack rendering: an observed Observation contributes metadata and its evidence reference only. Its Raw `body` is never injected. Observations in debug and planning ignore the requested feature filter, including when unlabelled.

---

**Hypothesis** (`HYP-`), reviewed class

- Required attributes: `what_was_tried`, `why_it_failed`, `evidence_ref` (XREF id)
- Optional: `would_reconsider_if`
- States: `explored → rejected | revived`
- Relations out: `derives_from` (Discussion, Observation, Open Question), `blocks` (Decision), `invalidates` (Decision, Hypothesis), `explains` (Observation), `references`
- Validation: `evidence_ref` required. This is the mechanical distinction from a rejected alternative, which has no evidence because it was never tried (Section 11).
- Pack visibility: only `rejected` is selected. `explored` is excluded from every pack and is added to the curation list after 30 days without changing status or graph version.

---

**Decision** (`DEC-`), reviewed class

- Required attributes: `statement`, `rationale`, `reversibility` (enum: cheap, costly, one_way), `alternatives_rejected` (array of `{alternative, reason}`, may be empty)
- Optional: `origin = "unrecoverable"` for a historical Decision imported in
  the A-BF-1 backfill mode. No confidence field exists (PRD-DEC-005); a
  rejected write attempt containing one is an error, not a silent drop.
- States: `active → superseded | reverted`
- Relations out: `derives_from` (≥1, INV-3), `supersedes` (Decision), `requires` (Decision, Constraint), `invalidates` (Constraint, Hypothesis), `explains` (Observation), `implemented_by` (External Reference), `references`
- Validation: at least one `derives_from` edge must exist in the live
  acceptance transaction. A-BF-1 permits the explicit backfill-only
  `origin = "unrecoverable"` assertion instead; neither path permits a
  Decision with no origin assertion.
- Staleness threshold depends on `reversibility` (Section 10).

---

**Open Question** (`OQU-`), reviewed class

- Required attributes: `question`, `blocking` (boolean)
- Optional: `owner` (text; free text, may name an external party)
- States: `open → resolved | obsolete`
- Relations out: `derives_from` (Discussion, Observation, Requirement), `blocks` (Decision, Requirement), `references`
- Resolution: transition to `resolved` requires an existing Decision with a `derives_from` edge to this object. Enforced as a transition precondition.
- Injection: `blocking = true` forces inclusion in every pack in scope (PRD-OQ-003).
- Length: a blocking question is capped at 280 characters. Non-blocking questions have no additional body-length cap.

---

**Constraint** (`CON-`), operational class

- Required attributes: `rule` (≤280 chars, INV-9), `enforcement` (enum: hard, soft), `axiomatic` (boolean)
- States: `active → superseded | lifted`
- Relations out: `derives_from` (Decision) required unless `axiomatic = true` (INV-4), `supersedes` (Constraint), `invalidates` (Constraint), `references`
- Validation: length cap enforced as a database CHECK and a domain rule. Exceeding it is a rejection, not a truncation.
- Injection: unconditional within scope, exempt from feature filter and intent profile (PRD-CON-004, PRD-SCP-006).

---

**Glossary Entry** (`GLO-`), operational class

- Required attributes: `term`, `definition` (≤200 chars, INV-9), `axiomatic` (boolean)
- Optional: `aliases` (text[])
- States: `active → superseded | deprecated`
- Uniqueness: `(scope_id, lower(term))` unique among active entries. A conflicting term at a different scope is legal; the narrower scope wins at resolution (Section 3.5).
- Injection: term-matched, not unconditional (Section 17.6).

---

**Artifact** (`ART-`), reviewed class for review purposes, but excluded from feature filtering behaviour of reviewed knowledge only where explicitly stated

- Required attributes: `kind`, `version`, `location`, `content_hash`, `summary` (≤500 chars)
- States: `current → superseded`
- Validation: `summary` is required at approval and is immutable thereafter. It is never regenerated (PRD-ART-004). This is what preserves build-time determinism (PRD-CTX-004).
- Content is never stored (PRD-ART-002).

---

**External Reference** (`XRF-`), not a knowledge object in the review sense

- Stored in a separate table `external_references`. Reduced envelope: no status, no supersession, no approval, no features, no scope.
- Fields: `id`, `system` (enum: git, tracker, docs, design, dashboard, logs, other), `identifier`, `location`, `symbol` (nullable), `last_verified_at`, `created_at`
- Rationale for separation: it carries no assertion and has no lifecycle, so giving it the full envelope would make every envelope invariant conditional. Keeping it out preserves "every row in `knowledge_objects` obeys every envelope invariant" as an unconditional statement.
- Referenced by `relations` as a target only.

---

**Candidate** — not a knowledge object. Stored in a separate table `candidates`. See Section 14.3.

Rationale for separation: PRD-CUR-002 requires that Candidates never appear in any retrieval result. A separate table makes that a structural guarantee rather than a filter that must be remembered in every query. A forgotten `WHERE approved_at IS NOT NULL` would be a silent trust failure, which is the one failure mode this product cannot survive.

---

**Relation** — edge table. See Section 7.

---

## 3. Scope Model

### 3.1 Structure

```
scopes(
  id            text PK,
  kind          enum(global, project, workstream, phase),
  parent_id     text NULL FK → scopes,
  name          text,
  path          ltree,        -- materialised, e.g. global.talent.hiring.phase29
  depth         smallint      -- 0..3
)
```

Constraints:

- Exactly one row with `kind = global`, `parent_id IS NULL`, `depth = 0`. Enforced by a partial unique index.
- Every other row has a non-null parent (single parent, PRD-SCP-001).
- `depth = parent.depth + 1`, `depth ≤ 3`. Enforced by trigger.
- Legal parent kinds: project→global, workstream→project, phase→workstream. Enforced by CHECK against parent kind.
- `path` is maintained by trigger. Scopes are not reparented in V1; reparenting is rejected.

No Feature kind exists (PRD-SCP-002). This is structurally impossible to add by accident because `kind` is a closed enum with a legal-parent CHECK.

### 3.2 Scope resolution algorithm

Deterministic, terminating in at most four steps.

```
resolve_chain(target_scope_id) -> ordered list, narrowest first

  1. row := scopes[target_scope_id]; if absent -> SCOPE_NOT_FOUND
  2. chain := []
  3. while row is not null:
       append row to chain
       row := scopes[row.parent_id]
  4. assert len(chain) == row_depth + 1 and chain.last.kind == global
  5. return chain
```

Implementation uses the materialised `path` for a single-query fetch (`WHERE path @> target.path`), ordered by `depth DESC`. The loop above is the normative definition; the `ltree` query is an optimisation that must produce the identical list. A test asserts equivalence on every scope in the tree.

**Applicability.** An object is applicable to a target scope if `object.scope_id ∈ resolve_chain(target)` (PRD-SCP-004).

**Scope narrowness** is `scopes.depth`. Higher depth is narrower. Used for ordering and precedence.

### 3.3 Scope creation and validation

Creation requires kind and parent. The parent-kind CHECK plus the depth trigger make an illegal tree unrepresentable. Scope creation is a curator operation, not available to AI clients.

Scope assignment on a knowledge object is immutable after approval, because changing it would silently change what every historical pack meant. A misfiled object is corrected by supersession with the correct scope, which preserves the record of the misfiling.

### 3.4 Feature labels: canonical registry (TC-7 resolved)

Labels are canonical entities owned by a Project scope. Knowledge objects reference them **by identity, not by string** (Domain Spec 3.3). The configuration flag from the previous draft is withdrawn: there is one mode.

#### 3.4.1 Tables

```sql
feature_labels (
  id                  text NOT NULL,             -- 'FTL-0007'
  project_scope_id    text NOT NULL REFERENCES scopes(id),
  canonical_name      text NOT NULL,             -- lowercase-kebab, normalised
  status              enum(active, deprecated) NOT NULL,
  redirects_to_id     text NULL,                 -- no FK; trigger, see below
  valid_from_version  bigint NOT NULL REFERENCES graph_versions(version),
  valid_to_version    bigint NULL REFERENCES graph_versions(version),
  PRIMARY KEY (id, valid_from_version),
  UNIQUE (id) WHERE valid_to_version IS NULL,    -- one open window per identity
  UNIQUE (project_scope_id, canonical_name) WHERE valid_to_version IS NULL
)

feature_label_aliases (
  label_id            text NOT NULL,             -- FTL identity; not a single-column FK
  alias               text NOT NULL,             -- normalised
  project_scope_id    text NOT NULL,
  valid_from_version  bigint NOT NULL REFERENCES graph_versions(version),
  valid_to_version    bigint NULL REFERENCES graph_versions(version),
  PRIMARY KEY (project_scope_id, alias, valid_from_version),
  UNIQUE (project_scope_id, alias) WHERE valid_to_version IS NULL
)
```

`redirects_to_id` cannot reference `feature_labels(id)`: a partial unique index is not a valid FK target, and the composite primary key is the wrong target (it would pin a merge to one window of the destination). A trigger on insert or update asserts that if `redirects_to_id` is not null, a row with that id exists in the same project scope and is open at the inserting version. Failure is `UNKNOWN_LABEL`.

**Version-window asymmetry with 2.2.** `knowledge_objects` and `relations` keep **one row per id**, for the identity reasons in 2.2: a second row sharing a readable id would make every relation targeting that id ambiguous. Status is not folded into the window — the two are independent axes and status carries its own history (2.2.1). What the window alone records is membership: a closed `valid_to_version` says the object left the graph at that version and nothing about what status it held before.

`feature_labels` and `feature_label_aliases` keep **multiple version-windowed rows per identity**. `status = deprecated` and a non-null `redirects_to_id` both change behaviour **without** removing the label from resolution: a deprecated label still resolves and still filters; a redirected label still resolves, to something else. One row therefore cannot represent both pre- and post-merge behaviour. A merge closes the old window and inserts a new row with the same identity (3.4.4). Packs rebuilt at the earlier version see the pre-redirect row. This is why 003+ must not copy the label primary key onto `knowledge_objects`.

Registry scope is Project, not Global, because `auth` on one project and `auth` on another are different concepts and a shared registry would eventually merge them wrongly. Every Phase has exactly one Project ancestor, so the owning registry for any object is unambiguous: walk the scope chain to the Project node.

#### 3.4.2 Resolution

```
resolve_label(input_string, project_scope_id, V) -> label_id | LabelCandidate

  1. n := normalise(input_string)         # lowercase, kebab, unaccent, trim
     if n is empty -> INVALID_LABEL       # a candidate must be creatable
  2. hit := feature_labels where canonical_name = n and project matches, active at V
     if miss: hit := via feature_label_aliases where alias = n, active at V
  3. if no hit -> return LabelCandidate(n)
  4. follow redirects_to_id until a terminal label (redirects_to_id is null),
     max 16 hops (INV-15). Hitting the bound, or a cycle, is LABEL_REDIRECT_CYCLE,
     not a result. Each hop is evaluated against the registry as it stood at V.
  5. return terminal label_id
```

Normalisation is lowercase-kebab with accent folding. Dots, underscores, and whitespace all become hyphens; runs collapse; leading and trailing hyphens are trimmed. (`lts.gs` → `lts-gs`.) An input that normalises to empty (`!!!`) is `INVALID_LABEL`, not a candidate. Case and separator drift is the cheapest half of the drift problem and costs nothing to eliminate. The rule is fixed before any label is stored: changing it later makes every stored identity suspect.

**Aliases resolve at write.** Input `magiclink` is resolved to a canonical identity before storage. The graph stores identity only. Resolving at read would mean expanding aliases on every filter forever, for no benefit.

**Redirects resolve at read, as of the requested graph version.** This is the asymmetry that makes history work. See 3.4.4.

#### 3.4.3 Label candidates

An unrecognised string never enters the graph. It becomes a label candidate with three resolutions:

| Resolution | Effect |
|---|---|
| Create | New `feature_labels` row, canonical |
| Alias | New `feature_label_aliases` row against an existing label |
| Drop | The object carries no label for that string |

**Where resolution happens.** For AI proposals it costs nothing extra: the Candidate is already in triage, so unknown labels resolve during work already being done. For backfill, which is direct authoring with no triage step, the dry run (Section 22) collects every unknown label across every file and reports them as a single batch. Labels are resolved once, not once per file.

This is what prevents the failure mode where the curator is told "unknown label, configure it first" in the middle of curation, which during a backfill would be intolerable.

**Relabelling.** A curator may assign canonical label identities to an
approved object in a dedicated curation transaction. The operation changes
only `feature_label_ids`, records the affected identities in one graph
version, and never supersedes the object.

#### 3.4.4 Merging

Two labels that turn out to mean the same thing are merged by closing the subsumed label's open window and inserting a new row with the **same id** and `redirects_to_id` set. This is not an in-place update. **Zero knowledge objects are touched.** Registry rows are not knowledge objects, and a merge does not require relabelling the affected objects.

This is the whole reason objects store identities rather than strings. A
separate relabelling transaction may change `feature_label_ids` without
superseding the object because labels are navigation, not assertions. That
filing metadata is not version-windowed on the object, however, so historical
reproduction must report the accepted v1 limitation.

A merge is one curation transaction and one graph version (8.1), consistent with TC-2.

```
v47   FTL-0012 'magic-links' active, distinct
      row: (FTL-0012, valid_from=47, valid_to=NULL, redirects_to_id=NULL)

v52   close that window and insert a new row with the same identity
      [one transaction, one version]
      UPDATE ... SET valid_to_version = 52
        WHERE id = FTL-0012 AND valid_to_version IS NULL
      INSERT (FTL-0012, valid_from=52, valid_to=NULL, redirects_to_id=FTL-0009)

pack rebuilt at v47 → resolves 'magic-links' → FTL-0012      (hash matches)
pack rebuilt at v52 → resolves 'magic-links' → FTL-0009      (hash matches)
```

Both rebuilds are correct, and both reproduce. The v47 pack is not retroactively rewritten to use the merged label, because at v47 the merge had not happened and the pack must reflect the graph as it was. An in-place `redirects_to_id := …` would make the v47 rebuild follow the v52 redirect and fail the hash.

#### 3.4.5 Lifecycle

`active → deprecated`. Never deleted (INV-14). A deprecated label is still resolvable and still filters correctly; it is simply not offered when creating new labels.

A redirected label remains `active` in the sense that it resolves; `deprecated` and `redirects_to_id` are independent. A label may be deprecated without being redirected, which is the "we stopped using this concept" case as distinct from "this was the wrong name for that concept".

### 3.5 Feature filtering and precedence

Filtering applies to reviewed knowledge only. Operational knowledge in scope is never excluded by a feature filter (PRD-SCP-006). Observed Raw Observations selected by debug and planning are also exempt, including unlabelled Observations, so untriaged evidence remains visible. This is implemented in the pack assembler and in the retrieval service.

**Constraint precedence (Domain Spec 3.4).** Where two active Constraints in the same resolved chain conflict, the narrower scope wins. "Conflict" here is only what the system can detect structurally, not semantically. See Section 15 and TC-4.

**Glossary precedence.** Where the same term is active at two scopes in a chain, the narrower definition is selected and the wider is suppressed from the pack. Deterministic because depth is total-ordered within a chain.

---

## 4. Knowledge Classes: Technical Differences

| Property | Raw | Reviewed | Operational |
|---|---|---|---|
| Members | Discussion, Observation | Requirement, Decision, Open Question, Hypothesis, Artifact | Constraint, Glossary Entry |
| Requires approval | No | Yes | Yes |
| Written by AI directly | Yes (as evidence) | No (Candidate only) | No (Candidate only) |
| Retention limit | Yes (Section 13.4) | No | No |
| Feature filter applies | Observations in debug/planning: No; Discussions: n/a | Yes | No |
| Injection into packs | Never as body; referenced only | By intent profile | Constraint: unconditional. Glossary: term-matched |
| Mutation | Discussion metadata mutable pre-distillation; Observation immutable after creation | Immutable after approval | Immutable after approval |
| Versioning | No supersession | Supersession | Supersession |
| Staleness model | Observation: materialised state. Discussion: none | Computed marker | Computed marker |
| Length caps | None | None | Yes (INV-9) |

`knowledge_class` is stored as a generated column derived from `type`, and a partial index on `(scope_id, knowledge_class) WHERE status = 'active'` supports the always-inject query path, which is the hottest read in the system.

---

## 5. State Machines

Notation: `state --[transition]--> state`. Every transition lists initiator, preconditions, side effects. Any transition not listed is rejected with `ILLEGAL_TRANSITION`. Terminal states accept no outbound transitions except where shown.

Lifecycle transitions after insertion are executed only by the application layer inside a curation transaction (Section 8.2), which increments graph version and sets `valid_to_version` / `valid_from_version`. Candidate acceptance is not a lifecycle transition.

### 5.1 Requirement

Acceptance of a Candidate **inserts** a Requirement in its initial durable state, `active`, with `approved_at` and `last_verified_at` set, inside one curation transaction. There is no approval transition and no `proposed` state on the object. The scope, required attributes, provenance, label registry, and initial-status checks are insert-time invariant checks. Deliberate authoring uses the same insert contract.

```
active --[supersede]--> superseded (terminal)
     --[withdraw]---> withdrawn  (terminal)
     --[retract]----> retracted   (terminal)
```

| Transition | Initiator | Preconditions | Side effects |
|---|---|---|---|
| supersede | curator | successor exists, is a Requirement, has `supersedes` edge to this | successor active; **change-impact propagation** (8.6) |
| withdraw | curator | none | **change-impact propagation** (8.6) |
| retract | curator | state is non-terminal | closes version window; excluded from packs at and after retraction version; no successor; flags active dependents `review_required` |

### 5.2 Discussion

```
recorded --[distil]---> distilled (terminal)
         --[archive]--> archived  (terminal)
         --[retract]--> retracted  (terminal)
```

| Transition | Initiator | Preconditions | Side effects |
|---|---|---|---|
| distil | system | ≥1 reviewed-class object has `derives_from` to this | automatic, evaluated on edge creation |
| archive | curator | no `derives_from` edges point to this | becomes eligible for retention reduction after 180 days |

`distil` is the only system-initiated transition in the model. It is a consequence of an edge write, not an independent action.

### 5.3 Observation

```
observed --[promote_question]---> promoted_to_question   (terminal)
         --[promote_hypothesis]-> promoted_to_hypothesis (terminal)
         --[absorb]-------------> absorbed               (terminal)
         --[expire]-------------> stale                  (terminal)
         --[retract]------------> retracted              (terminal)
```

| Transition | Initiator | Preconditions | Side effects |
|---|---|---|---|
| promote_question | curator | new Open Question exists with `derives_from` to this | |
| promote_hypothesis | curator | new Hypothesis exists with `derives_from` to this | |
| absorb | curator | a Decision exists with `explains` edge to this | Observation excluded from packs thereafter |
| expire | system | `now() > review_by` and state is `observed` | Observation excluded from packs (PRD-OBS-005) |

`expire` is the one time-driven transition in the system. It runs as a scheduled evaluation (Section 10.2) and executes inside a curation transaction so that it increments graph version. This is what keeps pack selection graph-determined rather than clock-determined. See TC-1.

### 5.4 Decision

Acceptance of a Candidate **inserts** a Decision in its initial durable state, `active`, with `approved_at` and `last_verified_at` set, inside one curation transaction. There is no approval transition and no `proposed` state on the object. The required attributes, provenance, scope, label registry, and `derives_from` origin checks are insert-time invariant checks. Creating a Decision that `derives_from` an Open Question does **not** resolve that question.

```
active --[supersede]--> superseded (terminal)
     --[revert]-----> reverted    (terminal)
     --[retract]----> retracted   (terminal)
active --[flag_review]--> active     (marker only, not a state change)
active --[verify]-------> active     (marker only, not a state change)
```

| Transition | Initiator | Preconditions | Side effects |
|---|---|---|---|
| supersede | curator | successor is a Decision with `supersedes` edge to this | derived Constraints are **not** cascaded; see 8.4 |
| revert | curator | no successor | derived active Constraints flagged `review_required` |
| flag_review | system | triggered by 8.6 | sets `review_required = true` |
| verify | curator | state is active | `last_verified_at = now()`; clears `review_required`; **no new version** (10.4) |

`reverted` and `superseded` are distinct terminal states (PRD-DEC-004) and are indexed separately, because "we changed our mind and did nothing" is different retrieval-relevant information from "we changed our mind and did X".

### 5.5 Open Question

```
open --[resolve]---> resolved (terminal)
     --[obsolete]--> obsolete (terminal)
     --[retract]---> retracted  (terminal)
```

`resolve` precondition: a Decision exists with `derives_from` to this question. A Decision MAY `derives_from` an Open Question that stays `open`; that edge does not resolve it. Resolution is a separate, deliberate curator act. `obsolete` has no precondition (PRD-OQ-005).

### 5.6 Hypothesis

```
explored --[reject]--> rejected --[revive]--> revived (terminal)
         --[retract]-------------------------> retracted (terminal)
rejected --[revive]--> revived (terminal)
rejected --[retract]--> retracted (terminal)
```

`rejected` is not terminal; it is the normal resting state and the state in which the object is injected into packs. `revive` records that the approach was reconsidered, and is distinguishable from never having been rejected (PRD-HYP-003). A revived Hypothesis is excluded from the "previously failed" pack section, since re-including it would tell an agent not to do the thing it is now doing.

The A-BF-1 importer may create a historical Hypothesis directly as
`rejected`; live capture still begins at `explored`.

### 5.7 Constraint

```
active --[supersede]--> superseded (terminal)
       --[lift]-------> lifted     (terminal)
       --[retract]----> retracted  (terminal)
       --[verify]-----> active     (marker only)
```

`lift` means the constraint no longer applies (the platform was upgraded). `supersede` means a different constraint replaced it. Both remove it from injection; they are distinguished for retrieval and audit.

### 5.8 Glossary Entry

```
active --[supersede]--> superseded (terminal)
       --[deprecate]--> deprecated (terminal)
       --[retract]----> retracted  (terminal)
```

A deprecated entry is retained and is still matched during term matching, but is rendered with its deprecation marker, so an agent reading an old document that uses the term still gets the definition and the signal that it is out of use.

### 5.9 Artifact

```
current --[supersede]--> superseded (terminal)
        --[retract]----> retracted  (terminal)
```

### 5.9a Retraction (all Knowledge Object types)

`retract` is available to every Knowledge Object type from any non-terminal
state. Initiator: curator only. Preconditions: none beyond non-terminal state.
Side effects: status becomes `retracted`; `valid_to_version` closes at the
retraction version; object excluded from Context Packs at and after that
version; no successor; no automatic supersession, lift, or revert of
dependents. Active Decisions with an open `derives_from` edge from the
retracted object, and active Constraints deriving from a retracted Decision,
are flagged `review_required` in the same transaction. Requirement
retraction applies the same transitive Decision flagging as supersession and
withdrawal (Section 8.6). At earlier graph versions the object is still
selected by its pre-retraction in-force status (Domain Spec Amendment A19).

### 5.10 Candidate

```
pending --[accept]---------> (promoted; candidate row closed)
        --[edit_accept]----> (promoted as human-authored; candidate row closed)
        --[merge]----------> (supersedes an existing object; candidate row closed)
        --[reject]---------> rejected (terminal)
        --[expire]---------> expired  (terminal)
```

`expire` is a housekeeping transition for candidates untouched past a configurable window (default 90 days). It exists so the triage list does not become an ignored backlog, which is the failure mode that ends curation. Expired candidates are retained for accept-rate measurement (PRD Section 14.4).

`accept` and `edit_accept` create the Knowledge Object directly in `active` (or the type's initial durable state) with `approved_at` and `last_verified_at` set, inside one curation transaction. There is no `proposed` state on the object.

---

## 6. Invariants

Object invariants and relation legality are separate mechanisms with separate enforcement points, per Domain Spec Sections 7 and 8. They are never merged.

- **Object invariants** are evaluated at object insertion and lifecycle transition, inside the curation transaction.
- **Relation legality** is evaluated at edge insert.

### 6.1 Object invariant enforcement

| ID | Invariant | Enforcement | Failure code |
|---|---|---|---|
| INV-1 | Exactly one scope | NOT NULL FK; immutable after approval (trigger) | `SCOPE_REQUIRED` / `SCOPE_IMMUTABLE` |
| INV-2 | Reviewed and operational objects have provenance and `approved_at` | Domain check at insert + CHECK constraint `(knowledge_class = 'raw' OR approved_at IS NOT NULL)` | `PROVENANCE_REQUIRED` |
| INV-3 | Decision has ≥1 `derives_from` | Domain check at transaction commit (edges written with the object) | `DECISION_ORIGIN_REQUIRED` |
| INV-4 | Constraint derives from a Decision or is axiomatic | Domain check at insert | `CONSTRAINT_PARENT_REQUIRED` |
| INV-5 | Observation has `evidence_ref` and `review_by` | CHECK on required JSONB keys + domain check | `OBSERVATION_EVIDENCE_REQUIRED` |
| INV-6 | Superseding object has exactly one predecessor; predecessor becomes superseded in the same transaction | Unique index on `supersedes_id`; unique on `superseded_by_id`; same-transaction update | `SUPERSESSION_CONFLICT` |
| INV-7 | No in-place assertion edit after approval | Trigger rejecting UPDATE on content columns where `approved_at IS NOT NULL`. Whitelist: `status`, `last_verified_at`, `review_required`, `feature_label_ids`, `superseded_by_id`, `valid_to_version`, `lock_version` | `IMMUTABLE_AFTER_APPROVAL` |
| INV-8 | No deletion | Trigger rejecting DELETE on `knowledge_objects`. No application code path issues one | `DELETION_FORBIDDEN` |
| INV-9 | Operational length caps, plus the 280-character cap for blocking Open Questions | CHECK constraints on the JSONB fields | `LENGTH_CAP_EXCEEDED` |
| INV-10 | Requirement supersession flags derived Decisions | Application-layer propagation inside the same transaction (8.6) | n/a (side effect) |
| INV-11 | Pack selection uses both the applicable version predicate and the section's explicit status predicate; only Recent Superseded Decisions use the bounded historical closed-window predicate | Enforced by the pack selection function; normal selection is `valid_from_version <= V AND (valid_to_version IS NULL OR valid_to_version > V)` | n/a (structural) |
| **INV-12** | `derives_from` and `supersedes` form a DAG | Cycle check on edge insert (7.5). **Added; see TC-3** | `CYCLE_DETECTED` |
| **INV-13** | Every label identity on an object exists in the owning Project's registry | FK to `feature_labels` validated per array element at insert | `UNKNOWN_LABEL` |
| **INV-14** | Labels are never deleted | Delete trigger on `feature_labels` (3.4.5) | `DELETION_FORBIDDEN` |
| **INV-15** | Label redirects are acyclic | Recursive check on `redirects_to_id` set, depth 16 | `LABEL_REDIRECT_CYCLE` |

INV-7 deserves emphasis: it is enforced by database trigger, not only in the
application. The application will eventually contain a bug that attempts an
invalid update. The trigger is what makes the append-only assertion guarantee
real rather than aspirational; its explicit `feature_label_ids` exception is
filing metadata, not content.

---

## 7. Typed Relation System

### 7.1 Storage

```
relations(
  id             bigserial PK,
  source_id      text NOT NULL,
  relation       relation_enum NOT NULL,
  target_id      text NOT NULL,
  target_kind    enum(knowledge_object, external_reference) NOT NULL,
  created_at     timestamptz,
  valid_from_version bigint NOT NULL,
  valid_to_version   bigint NULL,
  UNIQUE (source_id, relation, target_id)
)
```

Edges are versioned like objects so that historical pack reproduction traverses the graph as it was.

### 7.2 Vocabulary

Closed enum. Free-form relation names are structurally impossible.

| Relation | Direction | Cardinality | Mutable | Traversed | Affects pack |
|---|---|---|---|---|---|
| `derives_from` | source → origin | many per source | No (append; removed only by superseding the source) | Both directions | Yes (change impact, evidence) |
| `supersedes` | new → old | exactly 1 per source, 1 per target | No | Both | Yes (selection excludes superseded) |
| `references` | citer → cited | many | No | Forward mainly | Yes (evidence rendering) |
| `blocks` | blocker → blocked | many | Yes (removable on resolution) | Both | Yes (blocking OQ injection) |
| `requires` | dependent → dependency | many | No | Both | No; traversable through `graph.expand` only |
| `invalidates` | invalidator → invalidated | many | No | Both | Yes (contradiction surfacing) |
| `explains` | explainer → observation | many | No | Both | Yes (absorption) |
| `implemented_by` | knowledge → external ref | many | Yes (re-pointable in a curation transaction) | Forward | Yes (external ref section) |

Removed by the Domain Specification and not reintroduced: `documents`, `verifies`.

### 7.3 Legality matrix

Enforced by a lookup table `relation_legality(source_type, relation, target_type, target_kind)` seeded at migration and referenced by a trigger on `relations` insert. A triple absent from the table is rejected with `ILLEGAL_RELATION`.

| Source | Relation | Target |
|---|---|---|
| Decision | derives_from | Requirement, Discussion, Observation, OpenQuestion, Decision |
| Requirement | derives_from | Requirement, Discussion, Artifact |
| Constraint | derives_from | Decision |
| GlossaryEntry | derives_from | Decision, Artifact |
| Hypothesis | derives_from | Discussion, Observation, OpenQuestion |
| OpenQuestion | derives_from | Discussion, Observation, Requirement |
| Decision | supersedes | Decision |
| Requirement | supersedes | Requirement |
| Constraint | supersedes | Constraint |
| GlossaryEntry | supersedes | GlossaryEntry |
| Artifact | supersedes | Artifact |
| *any knowledge object* | references | Artifact, ExternalReference, Discussion |
| OpenQuestion | blocks | Decision, Requirement |
| Hypothesis | blocks | Decision |
| Decision | requires | Decision, Constraint |
| Requirement | requires | Requirement |
| Hypothesis | invalidates | Decision, Hypothesis |
| Decision | invalidates | Constraint, Hypothesis |
| Observation | invalidates | Decision, Constraint |
| Constraint | invalidates | Constraint |
| Decision | explains | Observation |
| Hypothesis | explains | Observation |
| Decision | implemented_by | ExternalReference |
| Requirement | implemented_by | ExternalReference |

The Constraint → `invalidates` → Constraint row is Domain Spec Amendment A-REL-1 (v1.2). No new verb.

Closing or re-pointing a pack-visible `blocks` or `implemented_by` edge is a
curation transaction. It closes the old edge's validity window at V and opens
the replacement edge at V. Historical retrieval and pack assembly evaluate the
edge windows at their requested graph version.

The exhaustive test enumerates the real Cartesian product: 9 Knowledge Object source types × 8 relations × 10 target kinds (the same 9 Knowledge Object types plus External Reference) = 720 combinations. It asserts that exactly the rows above are accepted, because a silently-permitted illegal triple corrupts traversal in ways that surface months later.

### 7.4 Cardinality enforcement

- `supersedes`: unique on `source_id` and unique on `target_id` (partial, where `valid_to_version IS NULL`).
- All others: unique on `(source_id, relation, target_id)` prevents duplicates; no upper bound.

### 7.5 Acyclicity (TC-3)

`derives_from` permits Decision → Decision, and `requires` permits Decision → Decision and Requirement → Requirement. Cycles would make transitive change-impact (PRD-REQ-006) non-terminating or arbitrary.

Enforcement: on insert of a `derives_from`, `supersedes`, or `requires` edge, a recursive CTE checks whether `target_id` can already reach `source_id` via edges of the same relation. If so, reject with `CYCLE_DETECTED`. Depth-bounded at 64 as a runaway guard.

No source document forbids cycles. This constraint is added here and recorded in Section 26 and Section 27 as a proposed domain amendment, not applied silently.

---

## 8. Supersession, Versioning, and Change Impact

### 8.1 Graph version (TC-2 confirmed)

**TD-2 confirmed.** A graph version is created per **committed curation transaction**. Normative definition in Domain Spec 7A.

A curation transaction may create knowledge objects, supersede them, transition
their state, relabel feature filing, create relations between them, and change
the label registry. All changes within one transaction belong to the same graph
version.

Approved assertions are never modified (INV-7). `feature_label_ids` is the
filing-metadata exception and is changed only by relabelling; assertion changes
remain supersession and state transitions.

```
graph_versions(
  version     bigserial PK,
  created_at  timestamptz,
  action      text,          -- 'accept_candidate', 'supersede', 'merge_label',
                             -- 'expire_observations', 'backfill', ...
  actor       enum(curator, system),
  backfill_mode boolean NOT NULL DEFAULT false,
  object_ids  text[]         -- identities whose validity window changed
)
```

Rationale: accepting a multi-element Candidate (a Decision plus two derived Constraints plus a Glossary Entry) is one coherent knowledge change. Versioning per object would make a pack diff report four separate events for one decision, which is noise at exactly the moment the diff is meant to be informative (PRD-DIF-002).

A graph version answers *"what state was the graph in?"*, not *"what was the 47th row written?"* Individual objects already carry stable identity, timestamps, provenance, and relationships.

`object_ids` lists **identities whose validity window changed** in that transaction: knowledge objects, relations, and registry rows (feature labels and aliases). It is one column and mixed namespaces. Knowledge objects and labels already carry type-tagged ids (`DEC-`, `FTL-`); relation row ids are recorded as decimal strings of the `bigserial`. Separate columns per namespace were rejected: the column exists for pack-diff ("what changed at v52"), and a label merge is a real graph change that a diff must show. Empty arrays are reserved for a clock tick that changed no windows, not for registry-only transactions. There is no FK; the prefixes (or their absence) are the namespace.

**Atomicity.** Either the whole curation action becomes version 47, or none of it does. Failure of any invariant, legality check, or state precondition rolls back the transaction and creates no version.

**Two exceptions, which create no version** (Domain Spec 7A.4):

- **Verification.** `verify` updates `last_verified_at` and clears `review_required`. It changes no content and no selection. Were it to bump, routine verification of thirty constraints would fill every pack diff with thirty non-changes and destroy the diff's only purpose.
- **Candidate operations.** Propose, edit, reject, expire. Candidates are not knowledge and are invisible to retrieval.

**Consequence accepted:** two unrelated changes deliberately made in one transaction cannot be distinguished by version. With a single curator and deliberate curation, this is the correct trade.

Every write path obtains the next version at transaction start and stamps `valid_from_version` / `valid_to_version` on affected rows, edges, and registry entries. A gap in the sequence after an aborted transaction is acceptable and non-semantic.

**Backfill** (Section 22) is an ordered set of up to three transactions:
scope reconstruction, knowledge/external-reference/relation import, and label
registry plus assignment filing. Each phase has one version when it changes
state; unchanged phases are skipped.

### 8.2 Curation transaction

The single write primitive. All state changes go through it.

```
begin
  V := next_graph_version()
  validate object invariants for all touched objects
  validate relation legality + acyclicity for all new edges
  apply state transitions
  close validity windows: valid_to_version := V for departing rows
  open validity windows:  valid_from_version := V for arriving rows
  run derived propagation (8.6, 5.2 distil)
  write graph_versions row
commit
```

Failure at any step rolls back the entire transaction. PRD-CUR-007 remains an element-level triage decision: the curator may accept or reject each child independently. When the curator chooses an accepted subset, every chosen element is promoted together in one curation transaction and one graph version; unchosen elements remain Candidates, and no chosen element is committed before the action succeeds.

### 8.3 Supersession mechanics

A correction never mutates. It creates a new object with:

- new `id`
- `supersedes_id` pointing at the predecessor
- a `supersedes` edge
- copied `scope_id` and `features` unless explicitly changed
- fresh `approved_at` and `last_verified_at`
- **inherited provenance chain** (Section 9.3)

and sets the predecessor's `status = superseded`, `superseded_by_id`, `valid_to_version = V`.

Edges pointing at the predecessor are **not** rewritten. This is deliberate: history must continue to say what it said. Traversal that wants current state follows `superseded_by_id` forward, and the retrieval layer exposes this as a `follow_supersession` flag, defaulting true for current-state queries and false for historical ones.

### 8.4 What happens when each thing changes

**A Decision changes.** New Decision supersedes the old. Derived Constraints are **not** automatically superseded or lifted, because the new Decision may or may not preserve them. Instead each active Constraint deriving from the superseded Decision is flagged `review_required` and appears in triage. Automatic cascade was rejected: it would either silently lift a constraint that still applies, or silently retain one that no longer does, and both are worse than an explicit prompt.

**A Requirement changes.** Supersession plus change-impact propagation (8.6).

**A Constraint changes.** New Constraint supersedes the old. If the underlying Decision did not change, the new Constraint inherits the same `derives_from` edge. Injection switches over at version V, so packs built before V continue to select the old constraint, which is correct.

That sentence read "continue to reproduce" and was wrong for as long as status was unwindowed. Supersession sets the predecessor's `status` to `superseded`, and until 2.2.1 that column had no history, so rebuilding a pack from before V read the *present* status of an object that was `active` at the pinned version and selected it into a different section, or dropped it. Two of the first eight packs built against the MIRA graph failed to reproduce for exactly this reason. With status history the claim holds as written; without it, "packs built before V continue to reproduce" described an intent rather than a behaviour.

**A Glossary definition changes.** Supersession. The term's uniqueness index is on active rows only, so the old and new coexist across the version boundary without conflict.

**A Decision supersedes another Decision.** As above, plus: any `blocks` edges from Open Questions to the old Decision are re-pointed to the new one, since a question blocking a decision blocks its replacement. This is the only automatic edge migration in the design, and it is listed here so it is not a surprise.

**An active Decision becomes invalid.** Two distinct cases. If a replacement exists, supersede. If not, revert. Reverting flags derived Constraints for review and does not delete them.

### 8.5 Withdrawal versus supersession versus invalidation

| Operation | Successor | Semantics | Effect on derived objects |
|---|---|---|---|
| Supersede | Required | Replaced by something | Flag derived for review |
| Withdraw (Requirement) | None | No longer required at all | Propagate change impact |
| Revert (Decision) | None | Undone, nothing in its place | Flag derived Constraints |
| Lift (Constraint) | None | No longer applies | None |
| Invalidate (edge) | n/a | A declares B false | Flags B for review; does not change B's status |

### 8.6 Requirement change impact (PRD Section 12)

The system's highest-value query. Implemented as a transitive traversal executed synchronously inside the curation transaction that supersedes or withdraws the Requirement.

```
propagate_impact(requirement_id, V):

  # Reverse traversal over derives_from, following Decision→Decision chains
  affected := recursive CTE:
      seed:  SELECT source_id FROM relations
             WHERE relation = 'derives_from'
               AND target_id = requirement_id
               AND valid_to_version IS NULL
      step:  SELECT r.source_id FROM relations r
             JOIN affected a ON r.target_id = a.id
             WHERE r.relation = 'derives_from'
               AND r.valid_to_version IS NULL
      depth limit 64

  affected_decisions := affected ∩ {type = Decision, status = active}

  for each d in affected_decisions:
      d.review_required := true      # marker, NOT a status change (PRD-REQ-005)

  emit impact_report(requirement_id, affected_decisions, V)
```

Notes:

- Termination is guaranteed by INV-12 (acyclicity) plus the depth bound.
- Only Decisions are flagged. Other reviewed objects deriving from the Requirement are reported but not flagged, because the PRD specifies Decisions (PRD-REQ-004).
- Status is unchanged. Flagged Decisions remain active and binding (PRD-REQ-005).
- The flag is cleared by `verify`, `supersede`, or `revert` (PRD-REQ-008).
- The flag renders in every pack containing the Decision (PRD-REQ-007, PRD-CTX-010).
- `impact_report` is persisted so the curator can work through it across sessions rather than losing it when the transaction ends.

Reverse direction (PRD Section 12, "Reverse direction"): from a Decision, forward traversal over `derives_from` to Requirements, then check their status. Same CTE, opposite direction.

---

## 9. Provenance

### 9.1 Model

Two author values, no approver (PRD Section 13, Domain Spec Section 9):

| Field | Meaning |
|---|---|
| `authored_by` | `human` or `ai` |
| `approved_at` | When it entered durable knowledge |
| `source_ref` | Originating Discussion id or session identifier |
| evidence | `references` edges |

There is no `approved_by`. Adding one "for later" would be paying the multi-user complexity cost in V1, which the brief forbids. Adding it later is a nullable column and a backfill, which is cheap.

### 9.2 AI proposals stay distinguishable

- A Candidate accepted unchanged promotes with `authored_by = ai`.
- A Candidate edited before acceptance promotes with `authored_by = human` (PRD-CUR-005).
- "Edited" means any change to `title`, `body`, or any `attributes` value. Changing only `scope_id` or `features` does not flip authorship, since those are filing decisions rather than content authorship.
- `authored_by` is immutable after approval and travels into every pack (PRD-CTX-010).

### 9.3 Provenance across supersession

A superseding object records its own authorship, not its predecessor's. But the chain must remain walkable, so:

- `supersedes_id` gives the full lineage by repeated traversal.
- A derived read model `provenance_chain(object_id)` returns the ordered list of `(id, authored_by, approved_at)` from origin to current.
- The predecessor's `source_ref` and evidence edges are **not** copied forward automatically. Copying would misattribute evidence: the new object may rest on different evidence, and silently inheriting it would be a provenance lie. The curator carries forward what still applies.

This is a deliberate cost: superseding an object requires re-stating its evidence. The alternative is a graph where evidence links are inherited by objects that were never actually justified by that evidence, and at that point provenance stops meaning anything.

---

## 10. Knowledge Rot

### 10.1 Thresholds

From the Domain Specification, unchanged. Configuration values, not code constants, so OQ-P3 can be answered after baseline without a release.

| Class / type | Threshold |
|---|---|
| Constraint | 90 days |
| Decision, `reversibility = one_way` | never stale |
| Decision, other | 180 days |
| Requirement | 180 days |
| Open Question, `blocking = true` | 30 days |
| Observation | its own `review_by`, default 30 days |
| Artifact | **stale-capable, threshold TBD (OQ-P9).** Verification additionally recomputes and compares `content_hash` |
| Glossary Entry, Hypothesis | no automatic staleness |

Artifact is stale-capable because the external document can change without anyone superseding the Artifact. Its verification is stronger than elsewhere: it recomputes the content hash and reports a mismatch as positive evidence of drift, rather than merely noting that time has passed. No time threshold is invented.

Glossary Entry and Hypothesis have no automatic staleness. A definition does not rot on a schedule, and a failed approach stays failed.

An `explored` Hypothesis is not stale and is not pack-visible. A curation
query adds it to the review list when it is more than 30 days old, using its
creation time as the reminder threshold. This reminder does not transition the
Hypothesis or advance graph version.

### 10.2 Two staleness mechanisms (TC-1)

This is the crux of the determinism problem and the design splits it deliberately.

**Materialised staleness — Observations only.** Stale Observations are *excluded* from packs (PRD-OBS-005), so staleness affects selection. Selection must be graph-determined. Therefore Observation expiry is a real state transition (`observed → stale`, Section 5.3) executed by a scheduled job inside a curation transaction, which increments graph version. Once materialised, it is graph state, and pack selection remains reproducible.

Schedule: daily. A late run delays the transition but never makes a pack irreproducible, because the pack records the version it was built against.

**Computed staleness — everything else.** For all other types, staleness is a *marker* that affects rendering only (PRD-ROT-004, PRD-ROT-005, PRD-CTX-010). It is computed at read time as `now() - last_verified_at > threshold` and is never stored, never a state, and never affects which objects are selected or how they are ordered.

**The resulting determinism statement**, which is the precise form of PRD-CTX-003:

> The *selection and ordering* of a Context Pack is a pure function of (request, graph_version), subject to the accepted v1 feature-label filing hole recorded in Domain Spec A17.
> The *rendered staleness markers* are a function of (selection, evaluation_time).
> A pack recipe therefore records both `graph_version` and `built_at`, and reproduction at the recorded `built_at` is byte-identical.

**The three holes, not one.** That statement named a single exception for most of the project's life. There were three, and they are the three columns INV-7 exempts from append-only — which is not a coincidence, because a column that may be rewritten after approval and is read by selection is exactly a hole in this guarantee:

| Column | Read by selection as | State |
| --- | --- | --- |
| `status` | section assignment, active/superseded/rejected predicates, recent-superseded window | **Closed.** Version-windowed in `knowledge_object_status_history` (2.2.1). |
| `valid_to_version` | membership at the requested version | **Closed.** Closing is not retroactive; reopening is, and is now rejected (2.2.1). |
| `feature_label_ids` | feature filtering of Reviewed Knowledge | **Open.** The accepted v1 hole (A17, TD-20). Relabelling still rewrites what an already-built feature-filtered pack selects. |

Only the third was ever written down. The first two were live defects presented as a guarantee, and they were found from stored packs failing their own reproduction check, not from this document.

Section 26.1 proposes the minimum clarification to the PRD to make this explicit rather than implied.

### 10.3 Surfacing

Stale objects remain fully retrievable and are still injected into packs (PRD-ROT-004), except stale Observations. They appear in the curation list (PRD-ROT-006) via a view over active objects past threshold, ordered by how far past.

### 10.4 Verification

`verify(object_id)` sets `last_verified_at = now()` and clears `review_required`.

**Verification does not create a new version and does not create a new object.** It changes no content and no selection. If it incremented graph version, routine verification of dozens of constraints would flood the pack diff with changes that changed nothing, which would make the diff useless for its actual purpose.

`last_verified_at` is therefore on the INV-7 whitelist.

**OQ-P6 (answered): no cascade.** Verifying a Decision does not verify Constraints derived from it. A Constraint is independently enforceable knowledge and carries its own verification state. Inheriting confirmation would let a Constraint appear freshly verified when nobody had looked at it, which is the silent-trust failure this section exists to prevent.

The `cascade` parameter is removed rather than defaulted, so it cannot be enabled by accident.

To avoid making this tedious, `verify` on a Decision returns the set of active Constraints deriving from it, and the application layer adds them to the curation list as **"also review"**. The curator confirms each deliberately but does not have to go looking for them.

---

## 11. Negative Knowledge

### 11.1 The mechanical distinction

A rejected alternative lives in `Decision.attributes.alternatives_rejected` as `{alternative, reason}`. It has no id, no lifecycle, no evidence, and is not independently retrievable. It was never tried.

A Hypothesis is a first-class object requiring `evidence_ref`. The required evidence is the enforcement mechanism for PRD-HYP-002: if nothing was tried, there is nothing to point at.

### 11.2 Retrieval and injection

Rejected Hypotheses in scope are injected for implementation, debugging, architecture, and planning intents (PRD-HYP-004). Revived Hypotheses are excluded from that section (5.6).

The pack renders each as: what was tried, why it failed, the evidence pointer, and `would_reconsider_if` where present. That last field is what stops the section from being purely prohibitive; without it an agent sees a wall of "no" with no path forward.

### 11.3 Discovery

The question "have we tried this?" is served by:

1. traversal from a related Decision or Observation (`invalidates`, `explains`, `derives_from`),
2. metadata filter on `type = Hypothesis, status = rejected` within a scope chain and feature label,
3. keyword over `what_was_tried`.

Semantic matching would be the natural fourth and is out of V1. This is the retrieval path most weakened by that exclusion, and it is worth watching during validation, since "have we tried this" is exactly the query where phrasing differs from the record.

---

## 12. Evidence and External References

### 12.1 Identity

An External Reference is identified by `(system, identifier)`, unique. `location` is a resolvable URL or path and may change without changing identity. `symbol` holds a module or symbol name where the reference is into code.

**Preference for symbol over path.** Where a reference points into code, `symbol` (for example `ReminderEngine::resolveCoupon`) is recorded in preference to a file path, because paths rot fastest. Both may be recorded; `symbol` is authoritative for resolution.

### 12.2 No mirroring

The engine stores `system`, `identifier`, `location`, `symbol`, `last_verified_at`. It does not store commit messages, diff content, task titles, task status, document content, or design content (boundary rule B-1).

The temptation to cache a task title "just for display" is the beginning of the mirror, and a stale title in the knowledge base is worse than no title because it looks authoritative.

### 12.3 Verification and failure

Verification is manual in V1 (Domain Spec OQ-5). `verify_reference(id)` sets `last_verified_at`. Any reference past its threshold (default 180 days, configurable) renders as unverified wherever it appears (PRD-XREF-003).

**Resolution failure** is a client-side concern. The engine never dereferences (boundary rule B-6). If a client fails to resolve a reference, it may report the failure via `reference.report_unresolvable(id, reason)`, which records the report in the curation list. It does not change the reference, because a transient outage is indistinguishable from a permanent move without human judgement.

---

## 13. Discussion Storage

### 13.1 Entry

Discussions enter three ways: curator records one directly, an AI client records one as evidence when proposing a Candidate, or one is imported during backfill. No path automatically creates durable knowledge from a discussion (PRD Section 10, principle P-3).

### 13.2 What is stored

Metadata in the object: `medium`, `occurred_at`, `participants`, plus title and a curator-or-AI-written summary in `body`.

Content is stored as a `content_ref`:

```json
{ "storage": "inline" | "blob" | "external",
  "location": "...", "content_hash": "...", "bytes": 12345 }
```

- `inline`: body under 32 KB, stored in the object.
- `blob`: stored in an internal content-addressed store keyed by hash.
- `external`: the transcript lives elsewhere and only a pointer is kept.

**TD-3 (provisional).** The 32 KB threshold answers Domain Spec OQ-2, which the source documents deferred to backfill. It is configuration, not code.

### 13.3 Relationship to derived knowledge

Reviewed objects point at Discussions via `derives_from` (origin) or `references` (evidence). The first such edge triggers `distil` (5.2). A distilled Discussion is retained in full permanently, because it is the evidence for live knowledge and reducing it would break the provenance chain (PRD-DSC-005).

### 13.4 Retention

Only archived Discussions are reduced, and only after 180 days: body and blob content are dropped, metadata, title, summary, and hash are retained. The row is never deleted (INV-8). Reduction is recorded on the object so a reader can tell the difference between a discussion that was short and one that was reduced.

### 13.5 Never injected

The pack assembler has no code path that emits Discussion `body` (PRD-DSC-002). Discussions appear only as evidence references under the objects that derive from them. A test asserts that no rendered pack for any intent contains Discussion body text.

---

## 14. Write and Curation Pipeline

### 14.1 Flow

```
Discussion (raw, no approval)
      │
      ├─ Path A: deliberate authoring ────────────────┐
      │   curator authors object directly              │
      │                                                │
      └─ Path B: assisted extraction                   │
          AI proposes Candidate                        │
                │                                      │
          candidates table (invisible to retrieval)    │
                │                                      │
          curator triage: accept / edit+accept /       │
                          merge / reject               │
                │                                      │
                └──────────────────────────────────────┤
                                                       ▼
                                        curation transaction (8.2)
                                                       │
                                        durable knowledge + version++
```

### 14.2 Who may do what

| Actor | May | May not |
|---|---|---|
| AI client (via MCP) | Create Discussions and Observations (raw class); propose Candidates; read packs; traverse | Create, approve, transition, or supersede any reviewed or operational object; write relations between approved objects; run triage |
| Curator (via CLI) | Everything | n/a in V1 |
| System (scheduler) | Expire Observations; expire Candidates; mark Discussions distilled | Anything requiring judgement |

Enforced at the application layer by a capability check on the calling interface, not by user identity, since V1 has no identity. The MCP surface simply does not expose the write use cases.

### 14.3 Candidate storage

```
candidates(
  id            uuid PK,
  proposed_type text,             -- target entity type
  payload       jsonb,            -- proposed envelope + attributes + edges
  parent_id     uuid NULL,        -- multi-element candidates
  source_ref    text,             -- originating discussion
  proposed_by   enum(ai, human),
  status        enum(pending, accepted, rejected, expired),
  resolution    jsonb NULL,       -- what it became, if accepted
  created_at, resolved_at
)
```

A separate table, not a status on `knowledge_objects`. This makes PRD-CUR-002 structural: no retrieval query can accidentally include a Candidate because Candidates are not in the table retrieval reads from.

Multi-element Candidates (a Decision plus proposed Constraints and Glossary Entries from `discussion.resolve`) are a parent row with children. The curator may select any pending subset of those elements for acceptance or reject individual elements. The selected accepted subset is promoted in one curation transaction and one graph version; unselected elements remain pending Candidates.

### 14.4 Triage actions

| Action | Effect |
|---|---|
| accept | Promote as-is, `authored_by = ai`, one curation transaction |
| edit and accept | Promote with curator edits, `authored_by = human` (9.2) |
| merge | Create a new object superseding a nominated existing object, carrying the candidate's content |
| reject | Candidate to `rejected`; originating Discussion retained (PRD-CUR-006) |

Merge is the duplicate-management mechanism (PRD PD-6). It introduces no new machinery: merge is supersession.

### 14.5 Duplicate detection

V1 detects **structural** near-duplicates only, at candidate time and during
backfill dry run, and reports them as a triage hint. It never blocks and
never merges automatically.

Signals: same type, same scope, and either (a) a normalised-title exact match, or (b) trigram similarity on title above a configurable threshold, or (c) an identical `derives_from` origin set.

No semantic duplicate detection. Claiming it without embeddings would be false, and embeddings are out of V1.

### 14.6 Contradiction detection at write time

See Section 15. Nothing in the write pipeline blocks approval on suspected contradiction.

### 14.7 Version changes

Exactly one version increment per curation transaction (8.1). Candidate creation, rejection, and expiry do **not** increment version, because Candidates are not knowledge and changing them changes nothing any pack can see.

---

## 15. Contradiction Handling

### 15.1 What the system detects structurally

Only these. All are cheap, exact, and honest.

| Detection | Trigger | Response |
|---|---|---|
| Supersession of an object with active dependents | `supersede` / `withdraw` / `revert` | Flag dependents `review_required`; report. Does not block |
| Constraint whose parent Decision was superseded or reverted | Same transaction | Flag Constraint `review_required` |
| Declared invalidation | `invalidates` edge created | Flag target `review_required`; render both in packs with the invalidation visible |
| Duplicate glossary term active in the same scope | Insert | **Blocks.** Unique index |
| Two active Constraints in the same scope chain with identical normalised rule text | Approval | Warn; does not block |
| Illegal relation triple | Edge insert | **Blocks** |
| Cycle in `derives_from` / `supersedes` / `requires` | Edge insert | **Blocks** |
| Open Question resolved with no resolving Decision | Transition | **Blocks** |

### 15.2 What requires curator declaration

Everything semantic. Two active Constraints that conflict in meaning but not in text. A Decision that contradicts a Constraint. A Requirement whose new version quietly changes the premise of a Decision that does not reference it. None of these is detectable without understanding the content, and V1 has no mechanism for that.

The curator declares them with an `invalidates` edge, which flags the target for review (Domain Spec Section 10, PRD-CON-007).

### 15.3 TC-4: the Constraint conflict warning

Domain Spec 3.4 says the system "SHOULD warn the curator that a conflict exists" when two Constraints in a chain conflict, while Domain Spec 10 and PRD-CON-007 say conflicts are curator-declared. As written the warning has no trigger.

**Minimum clarification applied:** the warning fires on the two structural cases in the table above (identical normalised rule text, and declared invalidation). It does not fire on semantic conflict, which the system cannot see. Narrowest reading that keeps all three statements true. Recorded in Section 26.4.

### 15.4 Precedence at read time

Where both Constraints survive and apply, the narrower scope wins (Domain Spec 3.4) and the suppressed one is reported in the pack's diagnostics rather than silently dropped, so a reader can see that a wider rule was overridden.

---

## 16. Retrieval Architecture

### 16.1 Precedence, server-side

Four tiers, evaluated in order, per PRD-SRCH-001. Tier 4 is not implemented in V1.

| Tier | Mechanism | Implementation |
|---|---|---|
| 1 | Exact relationship traversal | Recursive CTE over `relations`, direction-parameterised, depth-bounded 64 |
| 2 | Structured metadata | Indexed predicates on scope chain, feature array, type, class, status, dates |
| 3 | Keyword | Postgres full-text: generated `tsvector` column over title and body, GIN indexed |
| 4 | Semantic | **Not in V1.** Interface reserved; no implementation, no pgvector dependency |

Tier escalation is automatic: a query resolves at the lowest tier that returns results, and escalates only on empty. Escalation is logged so validation can measure how often tier 3 is reached, which is the evidence that would justify tier 4 later.

Retrieval strategy is never selected by the client (PRD-SRCH-002, boundary rule B-2). A client passes intent and filters; the server chooses the tier.

### 16.2 Pipeline

```
inputs: scope_id, feature_label_ids[], types[], classes[], statuses[],
        text?, seed_object_id?, relation?, direction?, budget?,
        as_of_version? (default: current)

1. Version window     : select rows valid at as_of_version
2. Scope filter       : scope_id ∈ resolve_chain(target)
3. Type/class filter
4. Status filter      : default active where that is the type's live state;
                        explicit status predicates are required for other states
                        (including superseded retrieval)
5. Candidate exclusion: structural, candidates are a different table
6. Tier execution     : 1 → 2 → 3 as above
7. Deduplication      : by object id; supersession chains collapsed to the
                        current member unless follow_supersession = false
8. Ordering           : deterministic (16.3)
9. Staleness marking  : computed, render-only (10.2)
10. Provenance attach : authored_by, approved_at, last_verified_at, review_required
11. Evidence attach   : references and derives_from edges, one hop, ids only;
                        edge windows are evaluated at as_of_version
```

The version-window predicate and the status predicate are both required.
Pack-specific selection adds the explicit Raw Observation and bounded Recent
Superseded Decision predicates described in Section 17; no other terminal
status is implicitly returned.

### 16.3 Deterministic ordering

Every result set, everywhere in the system, orders by:

```
(section_index ASC, scope_depth DESC, type_order ASC, id ASC)
```

`scope_depth DESC` puts the narrowest scope first, because the most specific knowledge is the most relevant to the request. `id ASC` is lexicographic on the type-prefixed sequential id and is a total order, which guarantees no ties and therefore no non-determinism. There is no relevance score anywhere in V1.

### 16.4 Operational knowledge in retrieval

Retrieval requests that specify a scope always return applicable Constraints regardless of the feature filter (PRD-SCP-006), consistent with pack behaviour. Glossary entries are term-matched only inside pack assembly; a direct glossary query returns all entries in scope.

---

## 17. Context Pack Contract

### 17.1 Interface

```
context.build(
  scope:    scope_id            required
  feature:  string | string[]   optional
  glossary: glossary_entry_id[] optional
  intent:   enum                required
  budget:   integer (tokens)    required
) -> ContextPack
```

Intents: `implementation`, `review`, `debug`, `architecture`, `onboarding`, `planning`. `investigation` is accepted as an alias for `debug` (PRD PD-1), resolved at the access layer so the domain sees only the six.

### 17.2 Output

```
ContextPack {
  recipe: {
    scope_id, feature_label_ids[], glossary_entry_ids[], intent, budget,
    graph_version, built_at,
    ordered_object_ids[], dropped_object_ids[],
    content_hash
  }
  sections: [ { name, objects: [RenderedObject] } ]
  diagnostics: {
    dropped_count, suppressed_by_precedence[],
    tier_escalations[], budget_utilisation,
    mandatory_content_budget_percentage
  }
}
```

`mandatory_content_budget_percentage` is the estimated token cost of
mandatory content (all in-scope Constraints, blocking Open Questions, and
explicitly requested Glossary Entries) divided by the requested budget,
expressed as a percentage. Term-matched Glossary Entries do not count. It is
diagnostic reporting only and does not alter selection, truncation, or
`PACK_BUDGET_INSUFFICIENT` behaviour.

`RenderedObject` carries id, type, scope path, `authored_by`, `approved_at`,
staleness marker, `review_required` marker, body content per section rules, and
evidence reference ids. Observation bodies are omitted; their metadata and
evidence references are retained.

### 17.3 Assembly algorithm

Pure function. No I/O, no model calls, no summarisation (PRD-CTX-004, boundary rule B-5). The working set is loaded first, then assembled.

```
build(scope, features, glossary_ids, intent, budget, V = current_version):

  0. labels := resolve_label(f, project_of(scope), V) for each requested feature
        following redirects as of V (3.4.2). Unknown -> ERROR UNKNOWN_LABEL
  1. chain := resolve_chain(scope)
  2. live_pool := objects where scope_id ∈ chain
                   and valid_from_version <= V
                   and (valid_to_version is null or valid_to_version > V)
                   and status satisfies the section predicate
  3. recent_superseded := Decisions with status = superseded whose closed
                           windows are within the last 10 graph versions
  4. mandatory := { Constraints in live_pool where status = active }
                ∪ { Open Questions in live_pool where status = open and blocking }
                ∪ { explicitly requested Glossary Entries }
     # exempt from feature filter and from truncation
  5. optional := live_pool minus mandatory, filtered:
        - reviewed class: retain if labels empty or overlap(obj.feature_label_ids, labels)
        - Operational: retain without feature filtering
        - observed Observations: retain without feature filtering in debug/plan;
          render metadata/evidence only
        - Hypotheses: retain only status = rejected
        - Discussions: never selected directly
        - explored Hypotheses: never selected
  6. sectioned := assign optional and recent_superseded to sections by intent_profile
  7. precedence := apply constraint and glossary narrowest-wins (3.5),
                   recording suppressed ids
  8. glossary := two-pass term match (17.6) against the retained non-glossary content
  9. mandatory_cost := cost(mandatory)
        if mandatory_cost > budget -> ERROR PACK_BUDGET_INSUFFICIENT
 10. order := sort by (section_index, scope_depth DESC, type_order, id)
 11. truncate: retain mandatory first, then order, dropping from the tail
     until cost ≤ budget; record dropped ids
 12. references := one-hop XREFs through references/implemented_by from
     retained Knowledge Objects at V, ordered by parent position then XRF id
 13. hash := sha256(canonical_json(recipe without content_hash))
 14. return pack
```

The version-window predicate and the section status predicate are both
required. The bounded Recent Superseded Decisions predicate is the only
historical section predicate; no other terminal status becomes pack-visible by
omission of a filter. Step 9 is the answer to TC-6: mandatory overflow is an
error, not a silent violation of the always-inject rule. The error names the
mandatory cost so the caller can raise the budget.

### 17.4 Intent profiles

Section order is fixed globally; profiles select which sections appear. From Domain Spec 11.5, unchanged.

| Section (in order) | impl | review | debug | arch | onboard | plan |
|---|---|---|---|---|---|---|
| 1 Objective | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 2 Constraints | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 3 Blocking Open Questions | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 4 Glossary (matched) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 5 Active Decisions | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 6 Requirements | ✓ | ✓ | | ✓ | ✓ | ✓ |
| 7 Rejected Hypotheses | ✓ | | ✓ | ✓ | | ✓ |
| 8 Non-blocking Open Questions | | | ✓ | ✓ | ✓ | ✓ |
| 9 Unexplained Observations | | | ✓ | | | ✓ |
| 10 Artifact summaries | ✓ | ✓ | | ✓ | ✓ | ✓ |
| 11 External References | ✓ | ✓ | ✓ | | | |
| 12 Superseded Decisions (recent) | | ✓ | ✓ | ✓ | | |

Section 12 "recent" is defined as superseded within the last 10 graph
versions. The day-based arm is excluded so selection remains a pure function
of request and graph version.

`explored` Hypotheses have no section. They are surfaced in curation review
after 30 days, but never injected while an experiment is in progress.
Unexplained Observations ignore feature filters in debug and planning, and
their section renders metadata/evidence references rather than Raw bodies.
External References are selected only one hop from retained parents through
`references` or `implemented_by`; references from dropped parents are omitted.

### 17.5 Truncation

Deterministic and tail-first within the global order. Mandatory sections (2
and 3), plus explicitly requested Glossary Entries, are never dropped.
Dropped ids are always reported (PRD-CTX-009), because a silently partial pack
is a pack that lies about what the project knows.

Token cost is computed by a fixed tokeniser-independent estimator (characters ÷ 4, rounded up, plus a fixed per-object overhead). Using a real tokeniser would tie determinism to a model vendor's library version, which is exactly the coupling the product is trying to avoid.

### 17.6 Glossary term matching (TC-5)

Matching against "the pack's other selected content" is circular once truncation can remove content. Fixed two-pass:

```
pass 1: match active glossary terms and aliases against non-glossary content
        retained after the first truncation
        matching is case-insensitive, whole-word, on normalised text
pass 2: add matched entries; if this exceeds budget, drop optional-section
        objects from the tail until it fits, then re-run pass 1 once
        if pass 2 changes the matched set, keep the pass-2 set and stop
```

Bounded at two passes so the algorithm terminates and remains deterministic. The residual case (a term that appears only in content dropped by pass 2) is accepted and reported in diagnostics.

Explicitly requested glossary entries (PRD-GLO-004) are added to the
mandatory set, are exempt from both passes, and count in the mandatory-content
diagnostic. Term-matched entries are optional and do not count in that
diagnostic.

### 17.7 Storage: recipe only

Packs store the recipe, never the rendering (Domain Spec 11.6, PRD-DIF-003).

```
context_packs(
  id uuid PK, scope_id, feature_label_ids[], glossary_entry_ids[], intent, budget,
  graph_version, built_at,
  ordered_object_ids text[], dropped_object_ids text[],
  content_hash text
)
```

Reproduction re-runs assembly at `graph_version`, using version-windowed selection, and asserts the resulting `content_hash` matches. It never returns a plausible-but-different pack.

**What a mismatch means.** It was specified to mean a correctness bug. It does not, and cannot, mean only that: selection reads columns INV-7 exempts from append-only, so ordinary curation can move an older pack without any bug being involved (10.2). Reproduction therefore classifies rather than merely asserting. It takes the symmetric difference between the stored selection and the reselected one, and checks each differing id against `graph_versions.action` and `object_ids` for versions above the pinned one:

- Every differing object named by a later curation transaction → `PACK_MUTATED_BY_CURATION`. The graph moved under a pack that predates it, on the record.
- Any differing object named by nothing → `PACK_HASH_MISMATCH`. The graph does not match its own recorded history, which is the tampering signal this check was for.

The discriminator is **necessary, not sufficient**, and says so in the message: a mutation to an object that a recorded transaction also touched is indistinguishable from that transaction's own effect and is masked. Both outcomes still fail loudly. What changed is that they no longer make the same claim about the graph.

### 17.8 Diff

```
diff(pack_a, pack_b) requires same (scope, feature_label_ids, glossary_entry_ids, intent)
  added      := b.ordered - a.ordered
  removed    := a.ordered - b.ordered
  superseded := pairs (x ∈ removed, y ∈ added) where y.supersedes_id = x
                (reported as supersession, not as remove+add)
  unchanged  := intersection
  also: objects whose review_required or staleness marker changed
```

Computed from the two id lists plus the object table. No rendered content is needed (PRD-DIF-003). Supersession pairing is what makes the diff readable: without it, every correction shows as an unrelated deletion and addition.

---

## 18. MCP and CLI Access Layer

*Inferred section; see 0.2.*

### 18.1 Split

**MCP (agent-facing, read plus propose).** Deliberately small. Agents choose badly from large tool surfaces.

| Tool | Purpose |
|---|---|
| `context.build` | The primary entry point |
| `graph.expand` | Traverse from a known object; direction, relation, depth |
| `discussion.resolve` | Submit a discussion **and an agent-authored structured proposal**; validate and persist as a Candidate |
| `artifact.get` | Fetch an artifact's summary, version, and location |

Everything else is a parameter of these four. Retrieval by keyword or metadata is a mode of `graph.expand` with no seed object, not a separate tool.

**CLI (curator-facing, full authority).** Triage, approve, supersede, verify, scope management, backfill import, metrics, pack diff. Not exposed over MCP, because the write path must not be reachable by a client that can be prompted.

### 18.2 Transport (TD-16)

Both transports are attached to one server object, which the MCP SDK supports directly.

| Transport | Use | Lifecycle |
|---|---|---|
| `stdio` | Default. Client spawns the server as a child process | One process per client session |
| Streamable HTTP | Optional shared server on `127.0.0.1` | One long-running process, many clients |

`stdio` is the default because it is the distribution pattern every major client supports with a single configuration line and no installation step, which is the concrete meaning of client neutrality for V1.

The earlier objection to `stdio` (Section 05 v1.0) was that per-session processes leave no single place to measure tier escalation and pack coverage. That objection does not hold: all instrumentation writes to PostgreSQL (Section 23), so measurement is shared across processes regardless of transport. The objection is withdrawn.

Both transports expose the identical tool set and identical authority. Transport selection is an operational choice and carries no semantic difference.

### 18.3 The engine never calls a model (TD-17)

This is a boundary rule, promoted here because it constrains the entire access layer.

The engine has no dependency on any model vendor's SDK, no API key, and no outbound network requirement.

- Pack assembly is pure selection (PRD-CTX-004, boundary rule B-5).
- Artifact summaries are authored at approval time and stored (PRD-ART-004).
- **Candidate extraction happens in the calling agent, not the server.** `discussion.resolve` receives a structured proposal that the agent has already produced using its own model, validates it against the schema, invariants, and relation legality, and persists it to triage. The server performs no generation.

Consequence: the engine is model-agnostic by construction rather than by policy, and remains so even if a client switches vendors. A model SDK appearing in the dependency manifest is a design violation, not an optimisation.

### 18.4 Contract rules

- Every response includes `graph_version`.
- No tool returns Candidates.
- No tool accepts a retrieval-strategy parameter (B-2).
- `discussion.resolve` returns validation results and the persisted Candidate id. The persisted copy is what the curator triages; the agent's own copy has no authority.
- A proposal that fails validation is rejected with typed errors and is **not** persisted, because a malformed Candidate in the triage list is noise the curator has to clear.
- Errors are typed (Section 20) and never returned as prose.

---

## 19. Persistence Model

*Inferred section; see 0.2.*

**TD-5 (confirmed).** PostgreSQL 17, as specified in Domain Spec Section 15. No graph database (traversals are 2 to 6 hops; recursive CTEs are sufficient). No vector extension created in V1.

**TD-18 — persistence tooling constraint.** The schema uses triggers, `ltree`, partial indexes, generated `tsvector` columns, per-type CHECK constraints on JSONB, and recursive CTEs. Every invariant that protects trust is enforced in the database (19.3), not only in the application.

Therefore: **migrations are hand-written SQL under version control, and no schema-owning ORM is used.** A query builder that treats SQL as the source of truth is acceptable. An ORM that generates or reconciles schema from application models is not, because it will silently drop or fight every construct listed above. This constraint is language-independent and survives any change to TD-6.

**TD-19 — vector column reserved, not populated.** The initial migration creates `knowledge_objects.embedding vector(N) NULL` with the `vector` extension **not** created, or omits the column while pinning a `pgvector`-capable image. Either way, enabling tier 4 later is one migration plus an out-of-process embedding sidecar, never a redesign. The engine itself never generates embeddings (18.3); a sidecar reads rows where `embedding IS NULL`, computes, and writes back, and may be written in any language.

### 19.1 Tables

`scopes`, `knowledge_objects`, `relations`, `relation_legality`, `external_references`, `candidates`, `graph_versions`, `context_packs`, `impact_reports`, `feature_labels`, `feature_label_aliases`, `discussion_blobs`.

### 19.2 Indexes

| Index | Purpose |
|---|---|
| `scopes USING gist (path)` | Scope chain resolution |
| `knowledge_objects (scope_id, knowledge_class) WHERE valid_to_version IS NULL` | Always-inject path, hottest read |
| `knowledge_objects (type, status) WHERE valid_to_version IS NULL` | Section selection |
| `knowledge_objects USING gin (feature_label_ids)` | Feature filter |
| `feature_labels (project_scope_id, canonical_name) WHERE valid_to_version IS NULL` | Label resolution |
| `feature_label_aliases (project_scope_id, alias) WHERE valid_to_version IS NULL` | Alias resolution |
| `knowledge_objects USING gin (search_vector)` | Tier 3 keyword |
| `knowledge_objects USING gin (attributes jsonb_path_ops)` | Attribute predicates |
| `knowledge_objects (valid_from_version, valid_to_version)` | Historical reproduction |
| `knowledge_objects (last_verified_at) WHERE valid_to_version IS NULL` | Staleness view |
| `relations (source_id, relation) WHERE valid_to_version IS NULL` | Forward traversal |
| `relations (target_id, relation) WHERE valid_to_version IS NULL` | Reverse traversal, change impact |
| `relations (target_id) WHERE relation = 'supersedes'` | Supersession chain |
| `knowledge_objects USING gin (title gin_trgm_ops)` | Duplicate detection (14.5) |

### 19.3 Constraints and triggers

Single-parent and depth on `scopes`; append-only trigger for INV-7; delete-forbidden trigger for INV-8; legality trigger on `relations`; acyclicity trigger for INV-12; length CHECKs for INV-9; required-JSONB-key CHECKs per type; partial unique indexes for INV-6 and glossary term uniqueness.

The pattern is deliberate: **every invariant that protects trust is enforced in the database, not only in the application.** Application-only enforcement is enforcement until the first bug.

---

## 20. Failure Behaviour

*Inferred section; see 0.2.*

### 20.1 Error taxonomy

| Class | Codes | Behaviour |
|---|---|---|
| Validation | `SCOPE_REQUIRED`, `SCOPE_CHAIN_INVALID`, `DECISION_ORIGIN_REQUIRED`, `CONSTRAINT_PARENT_REQUIRED`, `OBSERVATION_EVIDENCE_REQUIRED`, `LENGTH_CAP_EXCEEDED`, `INVALID_LABEL` | Reject, no partial write |
| Legality | `ILLEGAL_RELATION`, `CYCLE_DETECTED`, `ILLEGAL_TRANSITION`, `LABEL_REDIRECT_CYCLE` | Reject |
| Immutability | `IMMUTABLE_AFTER_APPROVAL`, `DELETION_FORBIDDEN`, `SCOPE_IMMUTABLE` | Reject |
| Concurrency | `SUPERSESSION_CONFLICT`, `STALE_LOCK_VERSION` | Reject, caller retries |
| Pack | `PACK_BUDGET_INSUFFICIENT`, `SCOPE_NOT_FOUND`, `INTENT_UNKNOWN`, `UNKNOWN_LABEL` | Reject with mandatory-cost detail |
| Reproduction | `PACK_HASH_MISMATCH` | **Fail loudly.** Never return a differing pack |
| Reference | `REFERENCE_UNRESOLVABLE` (client-reported) | Record, do not mutate |

### 20.2 Degradation rules

- Pack assembly never degrades silently. A pack that cannot include mandatory content errors rather than shipping without it.
- Truncation is not degradation: it is expected, bounded, and always reported.
- A failed scheduled Observation expiry delays a state transition and never corrupts reproduction, because packs are version-anchored.
- Loss of the search index degrades tier 3 only; tiers 1 and 2 continue.
- There is no fallback path that writes durable knowledge without curation. If triage is unavailable, capture stops. That is correct: silent auto-approval would destroy the property the system exists to provide.

---

## 21. Testing Requirements

*Inferred section; see 0.2.*

| Suite | Requirement |
|---|---|
| Relation legality | Exhaustive: all 720 (9 Knowledge Object sources × 8 relations × 10 targets) combinations asserted accepted or rejected |
| Invariants | One test per invariant asserting rejection at the correct enforcement point, plus one asserting the database trigger fires when the application check is bypassed |
| State machines | Every legal transition; every illegal transition rejected; terminal states accept nothing |
| Scope resolution | Normative loop and `ltree` query produce identical chains for every scope in a generated tree |
| Determinism (property) | For random graphs and requests: two builds at the same version produce identical `content_hash` |
| Reproduction (property) | Build at version V, apply N further writes, rebuild at V, assert hash match |
| Truncation | Mandatory content never dropped; dropped ids always reported; ordering stable under budget change |
| Glossary matching | Two-pass terminates; deterministic; residual case reported |
| Change impact | Transitive over Decision chains; terminates on depth bound; only Decisions flagged; status unchanged |
| Candidate isolation | No retrieval path returns a Candidate. Asserted against every read use case, not just the obvious ones |
| Discussion non-injection | No pack for any intent contains Discussion body text |
| Append-only | Direct SQL UPDATE and DELETE attempts against approved rows are rejected by trigger |
| Label registry | Alias resolves at write; redirect resolves at read as of version; merge touches zero knowledge objects; redirect cycles rejected; pack rebuilt at a pre-merge version still hash-matches |
| Backfill corpus | The MIRA backfill set is a fixture. Items that cannot be represented are asserted to appear in the gap register rather than being silently forced into a near-fit entity |
| Determinism under clock change | A pack rebuilt at the same graph version with a different wall clock selects identical objects; only staleness markers may differ |

The last row is the most important test in the suite, because it is the only one that can tell you the model is wrong rather than the code.

---

## 22. Backfill Tooling

*Inferred section; see 0.2.*

Required for PRD validation Step 2, and it is a product component rather than a script, because its output is the primary evidence about model correctness.

- **Import format:** declarative `scopes.json`, one file per Knowledge Object,
  `relations.json`, `external-references.json`, and `labels.json`. The label
  manifest has separate registry and object-assignment sections; all are
  human-authored and version-controlled.
- **Dry run:** validates invariants, legality, and acyclicity without writing, and reports every failure at once rather than stopping at the first.
- **Gap register:** the tool records every case where the curator could not express something: no home type, needing two scopes, missing relation verb, unrecoverable origin. Entries follow the schema in Domain Spec 19 and are counted per deferred candidate concept against the promotion threshold in Domain Spec 17.1.
- **No forcing.** An item that does not fit is **not imported into a near-fit entity**. It is recorded as a gap and left out of the graph (Domain Spec 17.2). Forcing produces knowledge that is quietly wrong, which is worse than a visible gap.
- **Curation friction:** the backfill friction log records qualitative friction
  events (kind, description, abandoned flag) for assessment against PRD
  validation Step 3a. No timing field is emitted; curation friction is
  curator judgement, not machine duration.
- **Label candidates:** the dry run collects every unrecognised label string across every file and reports them as one batch for the curator to create, alias, or drop (3.4.3). Labels are resolved once for the whole import, not once per file.
- **Provenance:** all backfilled objects carry `authored_by = human` and a `backfill` source marker, so validation metrics can separate historical import from live capture.
- **Versioning:** a complete import applies scopes, objects/external
  references/relations, then labels/assignments as three curation
  transactions. A first build therefore creates three graph versions; an
  unchanged re-import creates none. Label assignments remain a separate
  filing transaction under A17.
- **Backfill provenance mode (A-BF-1):** only the importer may construct a
  transaction marked `backfill_mode`. A Decision may assert
  `origin = "unrecoverable"` instead of a `derives_from` edge; the marker is
  visible in every containing pack and is rejected by live capture.
- **Historical states (A-BF-1):** the importer may create a rejected
  Hypothesis, superseded Decision, or resolved Open Question directly when
  the required successor or resolver is in the same import. It does not
  synthesize an earlier lifecycle state.
- **Duplicate warnings (A-BF-1):** dry run applies the structural
  near-duplicate check to the import set and reports pairs without blocking
  or merging.
- **Reconstruction identities (A20):** graph-version provenance uses explicit
  namespaces: `SCP-` for scopes, `FTL-` for labels, `XRF-` for external
  references, and `REL-` for relation bigserials. Relation identities are no
  longer bare decimal strings in `object_ids`.

---

## 23. Instrumentation

*Inferred section; see 0.2.* Every PRD Section 14 metric needs a source.

| Metric | Source | Notes |
|---|---|---|
| Decisions per phase | Query over `approved_at` and scope | Automatic. Excludes backfill by source marker |
| Pack coverage | `context_packs` rows per session vs total sessions | Session = one agent or client work session, client-supplied `session_id` on every MCP call, closed explicitly or by timeout. Engine does not infer boundaries. Timeout window TBD during instrumentation |
| Re-litigation count | Manual curator log, one table `relitigation_events(observed_at, object_id, session_id, pack_used bool)` | Manual by PRD PD-3 |
| Stale ratio | View over active objects past threshold | Automatic |
| Candidate accept rate | `candidates.status` aggregation | Automatic |
| Backfill representability | Misfit log (Section 22) | Semi-automatic |
| Tier escalation rate | Retrieval logs (16.1) | Automatic. Evidence for or against tier 4 later |

---

## 24. Security and Operations

*Inferred section; see 0.2.*

V1 is single-user and has no authentication (PRD Section 5). Consequences that must be stated rather than assumed:

- The engine binds to localhost or a private network only. It is not internet-reachable.
- The MCP surface exposes no write path to durable knowledge (14.2), so a prompt-injected agent cannot corrupt the graph. It can create noise Candidates and raw Discussions. Candidate expiry (5.10) bounds the noise.
- Backups: the graph is append-only, so incremental backup is sufficient and point-in-time recovery aligns naturally with graph version.
- The `content_hash` on artifacts and discussion blobs detects external drift; it is not a security control.

### 24.1 Performance targets

Not derived from source documents; set here as design budgets for a single-user system with a graph in the low tens of thousands of objects.

| Operation | Target |
|---|---|
| `context.build` | < 500 ms p95 |
| Scope resolution | < 5 ms |
| Change-impact propagation | < 1 s for 500 affected decisions |
| Pack reproduction at historical version | < 2 s |
| Keyword retrieval | < 200 ms p95 |

---

## 25. What This Specification Does Not Decide

Left to implementation specifications: module and package layout, HTTP or stdio transport details for MCP, CLI command naming, migration ordering, test framework choice, logging format, and deployment topology.

**TD-6 (superseded): language and runtime.** The previous recommendation of PHP 8.2 with Laravel is withdrawn. Its stated rationale was operational familiarity with the curator's other projects, which is not a property of this system: the engine must be independent of any consuming project's stack.

**TD-6a (confirmed): TypeScript on Node, with the MCP TypeScript SDK.** One language across the domain layer, MCP access layer, and curator CLI. The SDK is the reference implementation and supports both transports (18.2) on one server object.

Note that the MCP SDK is **not** a model vendor SDK. Per 18.3, no model vendor SDK appears in the dependency manifest.

The domain layer remains framework-free (boundary rule B-3): plain TypeScript modules with no database, transport, or SDK types in their signatures. The pack assembler in particular must be a pure function to satisfy the determinism guarantee, and purity is easiest to hold when the type system cannot reach I/O.

Python was a close alternative and would have produced an equally correct system. The deciding factor is that the engine never calls a model (18.3), which removes Python's main structural advantage in this problem space. Full comparison in document 05.

---

## 26. Conflicts, Gaps, and Required Clarifications

### 26.1 TC-1 — Determinism versus time-derived staleness (**resolved**)

**Conflict.** PRD-CTX-003 requires identical output for the same request at the same graph state. PRD-OBS-005 excludes stale Observations from packs, and PRD-ROT-005 marks stale objects in packs. Staleness derives from wall-clock time. Therefore pack content varies with time at a constant graph state, and the two requirements cannot both hold as written.

**Affected documents.** Domain Spec 4.3, 10, 11.2. PRD PRD-CTX-003, PRD-OBS-004, PRD-OBS-005, PRD-ROT-005, PRD-CTX-010.

**Minimum clarification proposed.** Amend PRD-CTX-003 to read: *selection and ordering* are a pure function of (request, graph version); *staleness markers* are a function of (selection, evaluation time); a pack records both graph version and build time, and reproduction at the recorded build time is byte-identical. Amend Domain Spec 4.3 to state explicitly that Observation expiry is a materialised state transition executed in a curation transaction and therefore increments graph version.

**Accepted by the curator.** Now normative in Domain Spec 11.2 and PRD-CTX-003, and applied throughout this specification (10.2, 17.2, 17.7). The guarantee reads:

> Pack contents are determined by graph version. Staleness labels may vary by build time. A pack records both `graph_version` and `built_at`.

**Correction.** "Determined by graph version" was true of the design and false of the implementation, in a way this resolution did not notice. Three columns are exempt from INV-7's append-only rule and all three are read by selection: `status`, `valid_to_version`, and `feature_label_ids`. Only the last was recorded as an exception. Changing any of them rewrote what an already-built pack selected, so pack contents were determined by graph version *and* by every subsequent curation touching an object in scope. `status` and `valid_to_version` are now closed (2.2.1); `feature_label_ids` remains the accepted hole (A17). The wall-clock conflict this section resolves was real and its resolution stands; it was simply not the only thing making packs non-reproducible.

### 26.2 TC-2 — Graph version granularity (**resolved**)

Domain Spec OQ-4 and PRD DG-6. **Answered: one version per committed curation transaction**, with verification and Candidate operations excepted.

Now normative in Domain Spec 7A rather than a technical decision, which is where it belonged: it defines what a graph version *means*, not how it is implemented. Applied in 8.1. TD-2 confirmed.

### 26.3 TC-3 — Cycles in `derives_from` (non-blocking, resolved)

No source document forbids cycles, and Decision → Decision `derives_from` is legal. Transitive change impact (PRD-REQ-006) is undefined over a cyclic graph. Added INV-12 (acyclicity on `derives_from`, `supersedes`, `requires`). **Proposed as a Domain Specification amendment**, not applied silently.

### 26.4 TC-4 — Constraint conflict warning has no trigger (non-blocking, resolved)

Domain Spec 3.4 requires a warning; Domain Spec 10 and PRD-CON-007 say conflicts are curator-declared. Narrowed to two structural triggers (15.3). Proposed clarification: Domain Spec 3.4 should say the warning fires on *structurally detectable* conflict only.

### 26.5 Gaps carried forward, not resolved here

| Gap | Status |
|---|---|
| ~~**OQ-P1**~~ feature labels | **Answered.** Controlled Project-scoped canonical registry, aliases, candidate workflow, merge by versioned redirect (3.4). Config flag withdrawn |
| ~~**OQ-P4**~~ session definition | **Answered:** one agent or client work session, client-agnostic, bounded by explicit close or timeout. Window TBD during instrumentation. `session_id` is client-supplied on every call; the engine does not infer boundaries |
| ~~**OQ-P6**~~ verification cascade | **Answered:** no cascade. Parameter removed. Derived Constraints surfaced as "also review" (10.4) |
| ~~**OQ-P7 / DG-1**~~ Risk | **Deferred as a candidate concept** (Domain Spec 18.1). No entity, no lifecycle, no triples, no intent-profile placement. Vision v2.0 no longer claims it |
| ~~**DG-4**~~ disproven assumptions | **Deferred as a candidate concept** (Domain Spec 18.2, "Assumption"). No entity, no triples. Promotion requires evidence under Domain Spec 17.1 |
| **DG-5** scope assignment tie-breaker | Curation judgement; no mechanism. Expect friction during backfill |
| **DG-7** consumer behaviour for stale content | Undefined; markers rendered, interpretation left to consumer |
| Artifact staleness threshold | Artifact is now stale-capable; threshold TBD (OQ-P9). Glossary and Hypothesis have no automatic staleness by decision, not omission |
| ~~Artifact class membership~~ | **Resolved:** Artifact is Reviewed Knowledge. External Reference is not a Knowledge Object and belongs to no class. A fourth "Referenced" class was proposed and rejected: the two share a direction but not a behaviour, and taxonomy follows behaviour |

---

## 27. Technical Decisions Made

Decisions this document made that were not in the source documents. All reversible. None extends the domain model except where flagged as a proposed amendment.

| ID | Decision | Rationale | Reversibility |
|---|---|---|---|
| **TD-1** | Single `knowledge_objects` table with JSONB attributes; separate tables for external references and candidates | Envelope invariants enforced once; non-polymorphic edges; candidate isolation is structural | Moderate. Migration required |
| **TD-2** | Graph version increments per committed curation transaction; verification and Candidate operations excepted | One coherent knowledge change is one version. Keeps pack diffs readable. **Confirmed by the curator**; now normative in Domain Spec 7A | Settled |
| **TD-3** | Discussion content threshold: 32 KB inline, else blob or external | Answers Domain Spec OQ-2, deferred to backfill | Trivial, config |
| **TD-4** | "Recent" superseded Decisions = last 10 graph versions | Removes the clock-dependent day arm so pack selection remains deterministic | Trivial, config |
| **TD-5** | PostgreSQL 17, no graph DB, no vector extension created in V1 | Domain Spec 15; shallow traversals; tier 4 excluded | Moderate |
| ~~**TD-6**~~ | ~~PHP 8.2 / Laravel~~ | **Superseded by TD-6a.** Rationale was familiarity with the curator's other projects, which is not a property this system may depend on | n/a |
| **TD-6a** | TypeScript on Node; MCP TypeScript SDK; framework-free domain layer | One language across domain, MCP, and CLI; reference SDK; widest client compatibility. Decided by 18.3: the engine never calls a model, which removes Python's structural advantage | Easy at start, hard later |
| **TD-7** | Token cost estimated as chars ÷ 4 plus fixed overhead, not a vendor tokeniser | A vendor library version would make determinism depend on an external dependency | Trivial |
| **TD-8** | Evidence edges are not inherited across supersession | Inherited evidence would misattribute justification | Easy, but changes provenance semantics |
| **TD-9** | Derived Constraints are flagged, never cascaded, when their parent Decision changes | Both automatic outcomes are wrong in some cases; a prompt is right in all | Easy |
| **TD-10** | `blocks` edges migrate from a superseded Decision to its successor | A question blocking a decision blocks its replacement. Only automatic edge migration in the design | Easy |
| **TD-11** | Scope is immutable after approval; misfiling is corrected by supersession | Mutable scope would silently change what historical packs meant | Moderate |
| **TD-12** | Candidate expiry after 90 days | An ignored backlog is the failure mode that ends curation | Trivial, config |
| **TD-13** | Verification does not increment graph version | Routine verification would flood pack diffs with non-changes | Easy |
| **TD-14** | INV-12 acyclicity added | Required for terminating change impact. **Proposed domain amendment (TC-3)** | n/a |
| **TD-15** | Performance targets in 24.1 | No source document sets them | Trivial |
| **TD-16** | Both `stdio` and streamable HTTP transports on one server object; `stdio` is the default | `stdio` is the single-line, zero-install distribution pattern every major client supports. The earlier objection (no shared measurement point) is withdrawn: instrumentation writes to PostgreSQL, not process memory | Trivial |
| **TD-17** | The engine never calls a model. No model vendor SDK in the dependency manifest. Candidate extraction happens in the calling agent | Makes vendor neutrality structural rather than a policy statement. Keeps pack assembly pure. Decided the language choice | Hard. Reversing it changes the trust and determinism model |
| **TD-18** | Hand-written SQL migrations; no schema-owning ORM. Query builders acceptable | The schema depends on triggers, `ltree`, partial indexes, generated columns, and CHECK constraints on JSONB, all of which schema-generating ORMs drop or fight. Language-independent | Hard once the schema exists |
| **TD-19** | Vector column reserved, extension not created, embeddings generated out of process | Enabling tier 4 becomes one migration plus a sidecar. Keeps TD-17 intact and keeps the embedding language independent of the engine language | Trivial |
| **TD-20** | Objects store `feature_label_ids`, never label strings; registry is Project-scoped and version-windowed; merge is a redirect, not a rewrite | String labels would make a merge an in-place edit of approved filing metadata and would lose canonical identity. Relabelling is a separate curation transaction; the object's label set is not version-windowed in v1, which is an accepted reproduction hole | Hard once objects carry labels |
| **TD-22** | Risk and Assumption deferred as candidate concepts, not implemented | The only evidence for them is a Vision list written before the model matured. Ten entities is holdable; twelve on speculation is how the model becomes a taxonomy. Backfill decides, under an explicit promotion threshold | Trivial to promote later |
| **TD-23** | No fourth "Referenced" knowledge class | Artifact and External Reference share a direction, not a lifecycle. The class existed only to give Artifact a bucket; Reviewed is its correct bucket | Trivial |
| **TD-24** | Verification never cascades; derived Constraints surfaced as "also review" | Inherited confirmation would make a Constraint look verified when nobody looked. Surfacing keeps it cheap without making it false | Easy |
| **TD-25** | Artifact is stale-capable with hash comparison on verification; no time threshold set | External documents change without anyone superseding the Artifact. Hash mismatch is positive evidence of drift, stronger than elapsed time | Trivial |
| **TD-21** | Aliases resolve at write; redirects resolve at read as of the requested graph version | Write-time alias resolution keeps the graph canonical. Read-time redirect resolution is what lets history stay honest: a pack at v47 resolves as the registry stood at v47 | Moderate |
