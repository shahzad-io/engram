# Project Knowledge Engine — Domain Specification v1.6

**Version:** 1.6
**Status:** Draft for review
**Supersedes:** Domain Specification v1.5
**Derived from:** 01 Vision v2.1
**Audience:** the single curating engineer, and any AI assistant proposing knowledge into the system
**Derivation authority:** 01 Vision → 02 Domain Specification → 03 PRD → 04 Master Tech Spec → 05 Technology Spec. Each document implements the one above and may not redefine it.
**Vocabulary authority (domain concepts):** this document. Entity names, knowledge classes, relation verbs, legal triples, lifecycles, and invariants are defined here. The Vision is prose; where Vision prose contradicts this document on a domain concept, the Vision is the defect.

---

## 0. How to read this document

This document defines concepts, behaviour, and rules. It does not define storage, SQL, indexes, or transport. Section 12 (MCP Contract) and the Storage Model are derived from this document and must not contradict it.

Where this document says MUST, the system rejects the write. Where it says SHOULD, the system warns the curator but proceeds. Where it says MAY, the system permits without comment.

**V1 is single-user.** One engineer curates project knowledge with AI assistance. There is no authentication, no roles, no notification, no concurrent-edit resolution. Multi-user is a Long-Term Vision item, not a V1 deferral, and nothing in V1 should be shaped to accommodate it beyond what costs nothing.

---

## 1. Ubiquitous Language

These terms have exactly one meaning in this system. Use them in code, in the MCP surface, in the UI, and in conversation.

| Term | Meaning |
|---|---|
| **Knowledge Object** | Any first-class entity that carries an assertion and can be reviewed. Not scopes, not relations, not Context Packs. |
| **Knowledge Class** | One of three tiers: Raw, Reviewed, Operational. Determines review rules and injection behaviour. |
| **Scope** | A node in the ownership tree: Global, Project, Workstream, Phase. Single-parent. |
| **Feature** | A canonical, Project-scoped cross-cutting label. Not a scope. A Knowledge Object may carry zero or more Feature labels, referenced by identity rather than by string. |
| **Label Registry** | The set of canonical Feature labels owned by a Project scope, with their aliases and redirects. Versioned. |
| **Label Candidate** | An unrecognised label string arriving at the proposal or import boundary. Resolved by the curator into a new label, an alias, or nothing. Never enters the graph directly. |
| **Redirect** | A registry-level statement that one canonical label now resolves to another. Created by a merge. Resolved as of a graph version. |
| **Scope Chain** | The ordered list of scopes from a given scope up to Global. |
| **In scope for X** | A Knowledge Object whose scope is any member of X's Scope Chain. |
| **Supersede** | Replace an object with a newer object. The old object is retained, never edited, never deleted. |
| **Provenance** | The record of who authored an object, how, from what evidence, and when it was approved. |
| **Axiomatic** | Operational Knowledge with no parent Decision. True by declaration, not by derivation. |
| **Context Pack** | A deterministic, reproducible selection of Knowledge Objects assembled for one task. A derived output, not a Knowledge Object. |
| **Candidate** | A proposed Knowledge Object that is not yet approved. Invisible to retrieval. |
| **Graph Version** | A monotonically increasing integer identifying a state of the knowledge graph. Incremented once per committed curation transaction, not once per object. See Section 7A. |

---

## 2. Knowledge Classes

Three tiers. The tier determines the review rule and whether the object is injected or retrieved.

### Raw Knowledge

Evidence. Recorded, not curated. Never injected into a Context Pack directly; only referenced.

Members: **Discussion**, **Observation**.

Raw bodies are never pack content. An unexplained Observation may appear in the
debug and planning profiles only as a rendered metadata/evidence reference;
its `body` is not injected. A Discussion is reference-only in every profile.

Raw Knowledge is the only class that may be created without review. It is also the only class subject to retention limits.

### Reviewed Knowledge

Assertions the curator has approved. This is the substance of the graph.

Members: **Requirement**, **Decision**, **Open Question**, **Hypothesis**, **Artifact**.

Reviewed Knowledge MUST carry provenance and an `approved_at` timestamp. It MUST be append-only: changes happen by supersession.

### Operational Knowledge

Rules and vocabulary that govern future work. Never retrieved by search. Injection splits by member:

- **Constraint** — injected unconditionally within scope
- **Glossary Entry** — injected when its term or an alias appears in the pack's other selected content, or on explicit request

Members: **Constraint**, **Glossary Entry**.

Operational Knowledge MUST carry provenance and an `approved_at` timestamp. It MUST be append-only: changes happen by supersession.

Operational Knowledge is either **derived** (has a `derives_from` relation to a Decision) or **axiomatic** (declared directly, no parent). Both are legal. A Constraint SHOULD be derived. A Glossary Entry is usually axiomatic.

Operational Knowledge MUST be short. A Constraint body is capped at 280 characters, a Glossary definition at 200. This is not a storage limit. The Constraint cap exists because Constraints are injected unconditionally. The Glossary cap exists because a matched entry still occupies pack budget.

**Context Pack is not a Knowledge Class.** It makes no assertion, cannot be authored, cannot be approved. See Section 11.

---

## 3. Scope Model

### 3.1 The tree

```
Global
  └── Project
        └── Workstream
              └── Phase
```

Every scope node except Global has exactly one parent. Depth is fixed at four levels. There is no Feature level.

A Knowledge Object MUST be assigned to exactly one scope node. Assignment is at the level where the object is *true*, not where it was *discovered*. A Decision made during Phase 29 that governs the whole Project is scoped to the Project.

### 3.2 Scope resolution

Given a target scope, the Scope Chain is the path from that scope to Global inclusive.

```
scope_chain(phase-29)
  = [phase-29, workstream-hiring, project-talent, global]
```

An object is *in scope for* phase-29 if its scope is any member of that chain. Resolution is a walk up a single-parent tree. It is deterministic and terminates in at most four steps.

### 3.3 Feature labels

A Feature is a canonical, Project-scoped label attached to a Knowledge Object. Zero or more per object. Features cross scope boundaries freely: one Feature may span several Phases, one Phase may carry several Features.

Features filter. They never resolve scope.

```
context.build(scope=phase-29, feature=interviews)
```

**Labels are canonical, not free text.** A Knowledge Object references a label by identity, not by string. This is the same principle already applied to the relation vocabulary (Section 6): free-form input may exist at the proposal boundary, but the durable graph contains only canonical vocabulary. Without it, `magic-link`, `magiclink`, and `magic-links` accumulate as distinct labels and any filter silently misses two thirds of what it should match.

**Registry.** Each Project scope owns a registry of labels. A label has a canonical name, zero or more aliases, and a lifecycle (`active → deprecated`). Labels are never deleted.

The registry lives at Project scope rather than Global because `auth` on one project and `auth` on another are not the same concept, and a shared registry would eventually merge them wrongly.

**Proposal boundary.** An AI proposal or a hand-authored import may carry an unrecognised label string. That string does not enter the graph. It becomes a *label candidate*, resolved by the curator in one of three ways: create it as a new canonical label, attach it as an alias of an existing label, or drop it. For AI proposals this happens during triage, which was happening anyway. For backfill it happens once as a batch during the dry run, not once per file.

**Aliases resolve at write.** An input of `magiclink` resolves to the canonical label before storage. The graph stores canonical identity only. Resolving at read would mean expanding aliases on every filter forever, for no benefit.

**Merging.** Two labels that turn out to mean the same thing are merged by a registry-level redirect, never by rewriting knowledge objects. Because objects reference label identity rather than strings, a merge touches zero knowledge objects and therefore does not violate immutability (INV-7).

The registry is versioned like everything else. A merge is one curation transaction and one graph version. Redirect resolution is evaluated **as of the requested graph version**, so a Context Pack rebuilt at an earlier version resolves labels as they stood then:

```
v47   magic-links is a distinct label
v52   redirect created: magic-links → magic-link

pack rebuilt at v47  → resolves magic-links
pack rebuilt at v52  → resolves magic-link
```

This is what keeps pack reproduction honest. Were labels mutable strings on the object, a rebuild at v47 would silently select differently and the content hash would no longer match.

means: resolve the Scope Chain for phase-29, collect all objects in scope, then retain only objects carrying the `interviews` label, plus all Operational Knowledge in scope regardless of label.

**Operational Knowledge ignores Feature filtering.** A Constraint in scope applies whether or not it is labelled. Filtering out an applicable Constraint would defeat the purpose of the class.

**Raw Observation filtering is deliberately different.** Observed Observations
selected by the debug or planning profile are included regardless of the
requested Feature filter, including when they carry no labels. This preserves
untriaged evidence in a feature-scoped debug pack; it is an explicit exception
to the Reviewed-Knowledge-only filter rule, not a general Raw-Knowledge
injection rule.

### 3.4 Precedence on conflict

If two Constraints in the same Scope Chain conflict, the one at the narrower scope wins, and the system SHOULD warn the curator that a conflict exists. The system does not detect semantic conflict automatically in V1. Conflict is declared by the curator via the `invalidates` relation (legal triple: Constraint → `invalidates` → Constraint; Amendment A-REL-1).

---

## 4. Entity Definitions

Every Knowledge Object carries this common envelope:

| Field | Notes |
|---|---|
| `id` | Stable, human-readable where useful (`ADR-004`, `REQ-112`). |
| `scope_id` | Exactly one. See 3.1. |
| `feature_label_ids[]` | Zero or more canonical label identities from the owning Project's registry. Never raw strings. See Section 3.3. |
| `title` | One line. Must be meaningful alone in a list. |
| `body` | The assertion. |
| `status` | Per-entity state machine. See Section 5. |
| `provenance` | See Section 9. |
| `created_at` | Always set. |
| `approved_at` | Required for Reviewed and Operational. Null for Raw. Candidates are not Knowledge Objects and do not carry this envelope. |
| `last_verified_at` | Required for Reviewed and Operational. Not used for Raw. Observation uses `review_by`, not verification. See Section 10. |
| `supersedes_id` | Nullable. Points to the object this one replaces. |

---

### 4.1 Requirement

**Definition.** One atomic, traceable statement of what the product must do or must be, originating outside engineering.

**Boundary.** A Requirement is a single statement. A PRD is an Artifact. Never copy PRD prose into a Requirement. The Requirement references the PRD section.

**Fields.** `source` (who asked: founder, client, regulation, support ticket), `rationale` (why they want it), plus envelope.

**Lifecycle.** `active → superseded | withdrawn`

Acceptance (Candidate accept or deliberate authoring) creates the object directly in `active`. There is no `proposed` state. If it is not in force, it is still a Candidate.

**Why supersession matters.** Requirements change more than any other Knowledge Object. Supersession plus reverse traversal of `derives_from` gives the system its highest-value query:

> Requirement REQ-112 was superseded. Which active Decisions derive from REQ-112, and are they still valid?

This is change-impact analysis. It is the capability that distinguishes this system from Architecture Decision Records, and it should be named in the Vision document as a first-class capability rather than a side effect.

**Invariant.** When a Requirement is superseded, every active Decision with a `derives_from` edge to it is flagged `review_required`. The flag does not change the Decision's status. It appears in the curator's triage list and in any Context Pack that includes the Decision.

---

### 4.2 Discussion

**Definition.** A record of exploratory thinking. Evidence, not knowledge.

**Members of this idea.** Chat transcripts, meeting notes, investigation write-ups, design debates.

**Fields.** `medium` (chat, meeting, async thread, investigation), `participants`, `occurred_at`, `body_ref` (pointer to the stored transcript, not the transcript itself where large), plus envelope.

**Lifecycle.** `recorded → distilled | archived`

A Discussion is `distilled` once at least one Reviewed Knowledge object derives from it. A Discussion may be `archived` when it produced nothing.

**Retention.** Raw Knowledge is the only class with a retention policy. Discussions in `archived` state older than 180 days MAY be pruned to title plus metadata. Distilled Discussions are retained in full, because they are the evidence for live knowledge.

**Never injected.** A Discussion appears in a Context Pack only as a reference under a Decision's evidence, never as body text.

---

### 4.3 Observation

**Definition.** Something noticed that nobody has yet explained.

**Death condition.** This is the critical part of the entity. An Observation is first-class only while it is unexplained. Without an end condition this class becomes a junk drawer: nothing in it is wrong, nothing in it is load-bearing, and it stops being read.

**Fields.** `observed_at`, `evidence_ref` (MUST be present: dashboard, log, metric, reproduction), `review_by` (MUST be present, default 30 days), plus envelope.

**Lifecycle.**

```
observed
   ├── promoted_to_question    (became an Open Question)
   ├── promoted_to_hypothesis  (someone has a theory)
   ├── absorbed                (explained; folded into a Decision's rationale)
   └── stale                   (review_by passed with no action)
```

**Invariants.**
- An Observation MUST have an `evidence_ref`. An unevidenced observation is a Discussion.
- An Observation MUST have a `review_by` date.
- An Observation in `observed` state past `review_by` is automatically set `stale` and appears in triage.
- `stale` Observations are excluded from Context Packs.

**On absorption.** When an Observation is explained, it does not remain an Observation. Its content moves into the rationale of the explaining Decision, and the Observation is marked `absorbed` with an `explains` edge from the Decision. This keeps the class small enough to stay useful.

**Pack rendering.** An `observed` Observation is eligible only for the
Unexplained Observations section of debug and planning packs. The pack carries
its identifier, scope, status, timestamps, and evidence reference, but never
its Raw body.

---

### 4.4 Hypothesis

**Definition.** An idea that was actually tried and did not work. Negative knowledge.

**Boundary against Decision alternatives.** An alternative rejected during deliberation lives inside the Decision that rejected it. A Hypothesis is something you built, ran, or tested, and it failed. Different provenance, different lifecycle. If you did not try it, it is not a Hypothesis.

**Fields.** `what_was_tried`, `why_it_failed`, `evidence_ref`, `would_reconsider_if` (nullable: the condition that would make this worth revisiting), plus envelope.

**Lifecycle.** `explored → rejected | revived`

**Value.** This is the class that stops the agent proposing dead ends forever. Its absence is invisible until it costs you a week.

**Pack visibility.** Only `rejected` Hypotheses are pack-visible. An
`explored` Hypothesis represents an experiment still in progress and is
excluded from every Context Pack. An `explored` Hypothesis older than 30 days
is surfaced in the curation list for review; this is a triage reminder, not a
staleness state transition and does not change graph version.

---

### 4.5 Decision

**Definition.** An agreed engineering outcome with its reasoning.

**Fields.** `statement`, `rationale`, `alternatives_rejected[]` (inline, with reason each), `reversibility` (`cheap` | `costly` | `one_way`), `review_required` (boolean flag, see 4.1), plus envelope.

**No confidence score.** Confidence percentages are fake precision. Nobody calibrates them and downstream consumers treat 95 and 80 as meaningfully different when they are not. A Decision is binding or it is not. Where softness matters, `reversibility` carries it, because that is the property that actually changes how an agent should treat the Decision.

**Lifecycle.**

```
active → superseded
       └→ reverted
```

Acceptance (Candidate accept or deliberate authoring) creates the object directly in `active`. There is no `proposed` state. If it is not in force, it is still a Candidate.

- `active`: binding. Injected into Context Packs in scope.
- `superseded`: replaced by a newer Decision, which MUST carry `supersedes_id`.
- `reverted`: withdrawn with no replacement. Distinct from superseded, because "we changed our mind and did nothing" is different information from "we changed our mind and did X".

**Invariants.**
- A Decision MUST NOT be edited after approval. Change happens by supersession.
- A superseding Decision MUST reference its predecessor.
- A Decision MUST have at least one `derives_from` edge (to a Requirement, Discussion, Observation, Open Question, or another Decision). A Decision with no origin is folklore. A Decision MAY `derives_from` an Open Question that remains `open`; that edge does not resolve the question.

---

### 4.6 Open Question

**Definition.** A known unknown. Something unresolved that blocks or shapes work.

**Fields.** `question`, `owner` (who must answer; may be external), `blocking` (boolean), `blocked_items[]` (via `blocks` edges), plus envelope.

When `blocking = true`, `question` is capped at 280 characters. A
non-blocking Open Question has no additional body-length cap.

**Lifecycle.** `open → resolved | obsolete`

A Decision MAY `derives_from` an Open Question that stays `open`. Deciding while a question remains open is normal engineering. Resolution is a separate, deliberate curator act. The `resolve` transition REQUIRES an existing Decision with a `derives_from` edge to the question — the question cannot be resolved with nothing. An Open Question is `obsolete` when it stopped mattering.

**Always injected when blocking.** A blocking Open Question in scope is injected into every Context Pack in that scope, like a Constraint. An agent that does not know what is unresolved will confidently build on sand.

---

### 4.7 Constraint

**Definition.** A rule that always applies within its scope. The enforceable projection of knowledge.

**Fields.** `rule` (≤280 chars, imperative), `enforcement` (`hard` | `soft`), plus envelope. Either a `derives_from` edge to a Decision, or `axiomatic = true`.

**Axiomatic Constraints.** Not every Constraint comes from a Decision. "Production runs MySQL 5.7" is a fact about the world, not something anyone decided. Declaring it axiomatic is honest and costs nothing.

**Lifecycle.** `active → superseded | lifted`

`lifted` means the Constraint no longer applies (the platform was upgraded). `superseded` means a different Constraint replaced it.

**Always injected.** Every active Constraint in scope enters every Context Pack for that scope, regardless of Feature label, regardless of relevance scoring. This is the entire point of the class. It is also why the character cap exists.

---

### 4.8 Glossary Entry

**Definition.** A project-specific term and its meaning.

**Fields.** `term`, `definition` (≤200 chars), `aliases[]`, plus envelope. Usually `axiomatic = true`.

**Why this matters more than it looks.** A large share of "the agent lost context" is really "the agent no longer knows what the project's identifiers mean". Internal service names, capability codes, allowlist identifiers, domain shorthand. Cheap to record, expensive to lose.

**Lifecycle.** `active → superseded | deprecated`

**Injection rule.** Glossary Entries in scope are injected when their `term` or any alias appears in the Context Pack's other selected content, plus any explicitly requested. This is the one Operational Knowledge exception to unconditional injection, because glossaries grow large and most terms are irrelevant to any given task.

---

### 4.9 Artifact

**Class.** Reviewed Knowledge. An Artifact is approved, carries a curator-authored summary, and is superseded rather than edited. It behaves like the rest of Reviewed Knowledge and belongs there.

External Reference, by contrast, is **not a Knowledge Object at all** and belongs to no class, alongside Relation and Context Pack. It asserts nothing and has no lifecycle. A fourth class holding both was considered and rejected: the two share a direction (they point outward) but not a behaviour, and taxonomy should follow behaviour.

**Definition.** A canonical project document that lives elsewhere.

**Members.** PRD, Master Spec, phase document, architecture doc, design file, meeting summary.

**Fields.** `kind`, `version`, `location` (path, URL, or repo ref), `content_hash`, `summary` (written at approval time, ≤500 chars), plus envelope.

**The engine stores the pointer and the summary. Never the body.** Artifacts are versioned by supersession like everything else: PRD v2 supersedes PRD v1. The original storage system remains the source of truth for content.

**Why the summary is stored.** Context Pack assembly must be deterministic (Section 11). Summarising an Artifact at build time would require an LLM call and destroy reproducibility. The summary is therefore written once, at approval, by the curator or by AI proposal, and is thereafter fixed data.

---

### 4.10 External Reference

**Definition.** A typed pointer into a system that owns its own truth.

**Members.** Commit, pull request, issue, file path, symbol, dashboard, log query.

**Fields.** `system`, `identifier`, `url`, `last_verified_at`, plus a reduced envelope (no status lifecycle, no supersession).

**This is the anti-duplication mechanism.** The engine does not store commits, tasks, files, or reviews. It stores that Decision ADR-004 was implemented by PR 421 and touches the `ReminderEngine` module. Git owns the diff. The tracker owns the task.

**Rot warning.** File paths rot faster than anything else in the system. Prefer module or symbol identity over path where possible. `last_verified_at` makes a stale pointer visibly stale rather than silently wrong.

---

## 5. State Machines (summary)

| Entity | States |
|---|---|
| Requirement | active → superseded \| withdrawn \| retracted |
| Discussion | recorded → distilled \| archived \| retracted |
| Observation | observed → promoted_to_question \| promoted_to_hypothesis \| absorbed \| stale \| retracted |
| Hypothesis | explored → rejected \| revived \| retracted |
| Decision | active → superseded \| reverted \| retracted |
| Open Question | open → resolved \| obsolete \| retracted |
| Constraint | active → superseded \| lifted \| retracted |
| Glossary Entry | active → superseded \| deprecated \| retracted |
| Artifact | current → superseded \| retracted |
| External Reference | (no lifecycle) |

Terminal states are never deleted. Everything is append-only.

Every Knowledge Object type also accepts `retracted` from any non-terminal
state by explicit curator action. See Amendment A19.

---

## 6. Relation Vocabulary

Eight verbs. Closed set. Enforced as an enumeration.

This is the cheapest constraint in the specification with the highest payoff. If relation names are free text, within six months the graph will contain `affects`, `impacts`, `relates_to`, and `touches` all meaning the same thing, and no traversal will be reliable.

| Verb | Meaning |
|---|---|
| `derives_from` | This object exists because of that one. The primary traceability edge. |
| `supersedes` | This object replaces that one. |
| `references` | This object cites that one as evidence or source. |
| `blocks` | This object prevents progress on that one. |
| `requires` | This object cannot hold unless that one holds. |
| `invalidates` | This object makes that one false. Used to declare conflict. |
| `explains` | This object accounts for that observation. |
| `implemented_by` | This object was realised by that external artefact. |

**Removed from the earlier draft:** `documents` (overlaps `references`) and `verifies` (folds into `implemented_by` plus `references`).

**This vocabulary and the legal triples in Section 7 are frozen.** Verbs are not added or removed, and triples are not added, without an explicit amendment to this document recorded with its rationale. In particular, a deferred candidate concept (Section 18) acquires no triples until it is promoted to a first-class entity. Silently widening the vocabulary is the fastest route back to the untyped graph this design exists to avoid.

---

## 7. Relation Legality

Only these triples may exist. Enforced on edge insert.

| Source | Verb | Target |
|---|---|---|
| Decision | derives_from | Requirement, Discussion, Observation, Open Question, Decision |
| Requirement | derives_from | Requirement, Discussion, Artifact |
| Constraint | derives_from | Decision |
| Glossary Entry | derives_from | Decision, Artifact |
| Hypothesis | derives_from | Discussion, Observation, Open Question |
| Open Question | derives_from | Discussion, Observation, Requirement |
| Decision | supersedes | Decision |
| Requirement | supersedes | Requirement |
| Constraint | supersedes | Constraint |
| Glossary Entry | supersedes | Glossary Entry |
| Artifact | supersedes | Artifact |
| any Knowledge Object | references | Artifact, External Reference, Discussion |
| Open Question | blocks | Decision, Requirement |
| Hypothesis | blocks | Decision |
| Decision | requires | Decision, Constraint |
| Requirement | requires | Requirement |
| Hypothesis | invalidates | Decision, Hypothesis |
| Decision | invalidates | Constraint, Hypothesis |
| Observation | invalidates | Decision, Constraint |
| Constraint | invalidates | Constraint |
| Decision | explains | Observation |
| Hypothesis | explains | Observation |
| Decision | implemented_by | External Reference |
| Requirement | implemented_by | External Reference |

Any triple not listed is rejected. Invalid graphs cannot be constructed.

### Amendment A-REL-1 (v1.2)

**Triple added:** Constraint → `invalidates` → Constraint.

**Rationale.** Section 3.4 instructs the curator to declare Constraint conflict via `invalidates`. The table as frozen omitted that triple, so the instructed declaration was illegal. No new verb. The freeze in Section 6 stands; this is the recorded amendment it requires. Silently widening the table would be the failure the freeze exists to prevent.

### Amendment A-BF-1 (v1.3) — Historical backfill provenance mode

This amendment records a backfill-only mode for historical records. It does
not add an entity, lifecycle, relation verb, or legal triple. The Section 6
freeze therefore remains in force; this amendment is recorded explicitly
because it changes the conditions under which an existing invariant is
evaluated.

**Backfill transaction.** Only the backfill importer may construct a curation
transaction marked `backfill_mode`. The marker is recorded on the graph
version. The importer boundary is structural: the capability is not exported
through live write barrels and an architectural lint rule rejects imports from
MCP, CLI, or other application modules. Backfilled objects still MUST carry
`authored_by = human` and a `backfill:` source marker.

**Unrecoverable origin.** A Decision in a `backfill_mode` transaction MAY
carry the positive attribute `origin = "unrecoverable"` instead of an open
`derives_from` edge. The marker MUST NOT be combined with an origin edge. A
Decision with neither an origin edge nor this explicit marker remains
rejected by INV-3. Live capture rejects the marker outright. Context Packs
render the marker alongside the object's provenance and staleness markers.

**Historical terminal states.** The importer MAY create a Hypothesis directly
as `rejected`, a Decision directly as `superseded`, or an Open Question
directly as `resolved` when that historical outcome is the reason the record
survived. A superseded Decision MUST have exactly one successor in the same
import. A resolved Open Question MUST have a resolving Decision in the same
import. The importer MUST NOT record an artificial `explored → rejected`
history for a Hypothesis that was only observed after rejection.

**Duplicate reporting.** Dry run applies the MTS 14.5 structural
near-duplicate check to the import set. Matching pairs are warnings only:
they never block the import and are never merged automatically.

**Rationale.** A11 showed that 11 of 11 real historical MIRA Decisions
failed `DECISION_ORIGIN_REQUIRED`; A15 showed that backfill has no
candidate-time duplicate stage; and A16 showed that a historical rejected
Hypothesis would otherwise be inserted only in the pack-invisible `explored`
state. Live capture remains strict because its lifecycle and evidence
contracts are calibrated for a proposal with a recoverable origin. The
amendment preserves that trust boundary while allowing a curator to assert
what cannot honestly be reconstructed from history.

### Amendment A17 (v1.4) — Feature labels are mutable filing metadata

This amendment records the distinction between approved content and feature
label filing. It does not add an entity, lifecycle, relation verb, or legal
triple, so the Section 6 freeze remains in force.

**Resolution.** `feature_label_ids` is added to the INV-7 append-only
whitelist. Relabelling is permitted only inside a curator curation
transaction, which creates one graph version and changes no Knowledge Object
assertion. It never creates a supersession object or a supersession chain.

**Rationale.** INV-7 protects content because changing what an object asserts
after approval makes history a lie. A feature label asserts nothing about the
world; it is an index entry. Superseding a Decision merely to add a label
would create a new id, a supersession chain, and a graph version that record
no content change. Pack diffs would show supersessions where only filing
changed, and change-impact would traverse chains representing nothing.

MTS 11.2 draws the same line: scope answers “at what level is this true” and
is therefore an immutable claim, while features answer “what is this about”
and are navigation. The version-windowed, redirectable Project label registry
exists for this navigation role.

**Known reproduction hole accepted for v1.** `feature_label_ids` on a
Knowledge Object is not itself version-windowed. A pack rebuilt at an older
graph version resolves the registry as of that version but reads the
object’s current label set. This is explicitly accepted because labels are
navigation rather than history; reproduction must report the limitation
rather than imply that old object label assignments are historical.

---

### Amendment A20 (v1.5) — File-complete graph reconstruction

This amendment records the reconstruction boundary for hand-backfill. It does
not add an entity, lifecycle, relation verb, or legal triple, so the Section 6
freeze remains in force.

The declarative backfill directory now includes `scopes.json` for the fixed
Global → Project → Workstream → Phase tree and `labels.json` for Project label
registry definitions plus a separate object-to-label assignment section.
Assignments are filing metadata under Amendment A17, so they are applied in
their own curation transaction rather than being folded into object files.

A complete import is ordered as three transactions: scopes; knowledge objects,
external references, and relations; then labels and assignments. Each phase is
idempotent. An unchanged definition is a no-op; a conflicting scope or label
definition is an error. The first complete rebuild therefore has three graph
versions, while a repeat of unchanged files has none.

Graph-version provenance identities remain in one compatibility array, but
their namespaces are explicit: knowledge-object ids retain their entity
prefixes, scopes use `SCP-`, labels use `FTL-`, external references use `XRF-`,
and relation bigserials use `REL-`. A relation can no longer be mistaken for a
knowledge-object identity when reporting what a transaction changed.

**Rationale.** A20 showed that object files and relations alone did not
reconstruct the graph: scope ownership and the label registry existed only in
PostgreSQL. That made reset, migration to another machine, and recovery from
A19 contamination depend on a database backup rather than version-controlled
source. The manifests make the intended graph file-complete while preserving
the distinction between assertions and filing.

---

### Amendment A19 (v1.6) — Erroneous capture retraction

This amendment adds one terminal lifecycle state. It does not add an entity,
relation verb, or legal triple, so the Section 6 freeze remains in force.

**Problem.** The relation vocabulary has no honest way to record that an
object should never have been captured. Every existing terminal status asserts
something about knowledge that was once legitimate: `superseded` (replaced),
`reverted` (changed mind, nothing replaces), `lifted` (constraint no longer
applies), `withdrawn` (requirement no longer holds), `obsolete` (question
stopped mattering), `deprecated` (term out of use). Applying any of them to a
mis-capture puts a false story in append-only history.

**Resolution.** Every Knowledge Object type gains a terminal status
`retracted`, reachable only by an explicit curator `retract` transition from
any non-terminal state. Retraction:

- excludes the object from all Context Pack selection at and after the
  retraction graph version;
- does not delete the row or its relations — the mis-capture remains visible
  in the record and in graph traversal;
- does not claim the object was ever valid knowledge;
- closes `valid_to_version` at the retraction version, so a pack rebuilt at an
  earlier graph version still selects the object using its pre-retraction
  in-force status (the same version-window rule as other terminal transitions).

Retraction is never automatic. It does not supersede, does not create a
successor, and does not auto-supersede, lift, or revert dependents. Active
Decisions with a `derives_from` edge to the retracted object, and active
Constraints deriving from a retracted Decision, are flagged
`review_required` in the same transaction (consistent with TD-9 and INV-10
flagging, not cascading). Requirement retraction uses the same transitive
Decision flagging as supersession and withdrawal.

**Rationale.** A19 showed twelve global rows that were never honest project
knowledge and had no removal path that would not lie about history. File
reconstruction (A20) can remove contamination on a reset, but append-only
trust requires an honest in-graph correction for objects that must remain
auditable without claiming they were ever knowledge.

---

## 7A. Graph Version and the Curation Transaction

### 7A.1 Definition

A **graph version** is created per **committed curation transaction**.

A curation transaction may create Knowledge Objects, supersede them, transition
their state, relabel their feature filing, and create relations between them.
All changes within one transaction belong to the same graph version.

Approved assertions are never modified (INV-7). The sole approved-object
exception is `feature_label_ids`, which is filing metadata and may be changed
only by the relabelling operation above. Changes to assertions are expressed
by supersession and state transition.

### 7A.2 What this means

A graph version answers *"what state was the knowledge graph in?"*, not *"what was the 47th row written?"*

Resolving a discussion into a Decision plus two derived Constraints plus a Glossary Entry is one coherent knowledge change. It produces one version:

```
v46   before the decision
v47   decision + derived operational knowledge   (one transaction)
v48   next coherent knowledge change
```

Individual objects already carry stable identity, timestamps, provenance, and relationships. The version numbers the graph, not the rows.

### 7A.3 Atomicity

Either the whole curation action becomes version 47, or none of it does. A transaction that fails any invariant, any relation legality check, or any state precondition rolls back entirely, and no version is created.

Closing or re-pointing a pack-visible `blocks` or `implemented_by` edge is a
curation transaction. It closes the old edge's validity window at version V
and opens the replacement edge at V, so a pack at an earlier version reads the
historical edge.

### 7A.4 Two exceptions

These change nothing that any Context Pack can observe, and therefore create no version:

**Verification.** Confirming that a Constraint or Decision still holds updates `last_verified_at` and clears any review flag. It changes no content and no selection. Were it to create a version, routine verification of thirty constraints would fill every pack diff with thirty non-changes and make the diff useless for its only purpose.

**Candidate operations.** Proposing, editing, rejecting, and expiring Candidates. Candidates are not knowledge and are invisible to retrieval, so their movement is not a change of graph state.

---

## 8. Invariants

Distinct from Section 7. Relation legality is checked when an edge is written. Invariants are checked when an object is approved. Two different enforcement points, two different sections.

**INV-1.** Every Knowledge Object has exactly one scope.
**INV-2.** Every Reviewed and Operational object has `provenance` and `approved_at`.
**INV-3.** A Decision has at least one `derives_from` edge.
**INV-4.** A Constraint has a `derives_from` edge to a Decision, or `axiomatic = true`.
**INV-5.** An Observation has both `evidence_ref` and `review_by`.
**INV-6.** A superseding object has exactly one `supersedes` edge, and its target's status becomes `superseded` in the same transaction.
**INV-7.** No approved object assertion is ever edited in place. Corrections
happen by supersession. `feature_label_ids` is filing metadata, not an
assertion, and may be changed only in a curation transaction.
**INV-8.** No approved object is ever deleted.
**INV-9.** Operational Knowledge bodies are within their character caps.
**INV-10.** When a Requirement is superseded or withdrawn, all active Decisions with a `derives_from` edge to it are set `review_required = true`.
**INV-11.** A Context Pack selects Knowledge Objects using two predicates:
the object's validity window is applicable to the requested graph version, and
the object's status satisfies the explicit predicate for its section. The
normal predicate is `valid_from_version <= V AND (valid_to_version IS NULL OR
valid_to_version > V)`; the only historical profile is the explicitly bounded
Recent Superseded Decisions predicate, which selects `status = superseded`
objects whose closed windows fall within the last 10 graph versions. No other
terminal status is implicitly pack-visible. `retracted` is never pack-visible
at or after its retraction version; at earlier versions the object is selected
by its pre-retraction in-force status. The day-based arm was removed so
selection remains a pure function of request and graph version.

**INV-12.** `derives_from`, `supersedes`, and `requires` chains are acyclic. A cycle would make transitive change-impact analysis (Section 4.1) non-terminating or arbitrary.

**INV-13.** Every Feature label identity on a Knowledge Object exists in the registry of that object's owning Project scope.

**INV-14.** A Feature label is never deleted. It may be deprecated, or redirected to another label by a merge.

**INV-15.** Label redirects are acyclic, and resolution follows redirects to a terminal canonical label as of the requested graph version.

---

## 9. Provenance

Every Knowledge Object records how it came to exist.

| Field | Values |
|---|---|
| `authored_by` | `human` \| `ai` |
| `approved_at` | Timestamp. Required for Reviewed and Operational. Null for Raw. |
| `source_ref` | The Discussion, Artifact, or session that produced it. |
| `evidence[]` | `references` edges. |

**V1 simplification.** Because the author and the approver are the same person, there is no `approved_by` field and no approval workflow. Provenance keeps two author values only. What matters is the distinction between "I wrote this deliberately" and "an assistant proposed this and I clicked accept", because those carry different trust and the difference disappears within a month if it is not recorded.

Without provenance the graph becomes folklore.

---

## 10. Knowledge Rot

Nothing in the model expires on its own. That is a defect, not a feature.

**`last_verified_at`** is set on approval and updated whenever the curator confirms an object still holds. Verification changes no content and no selection, and therefore creates no graph version (Section 7A.4).

**Verification does not cascade.** Confirming a Decision does not confirm the Constraints derived from it. A Constraint is independently enforceable knowledge and carries its own verification state; inheriting confirmation would let a Constraint appear freshly verified when nobody had actually looked at it, which is precisely the silent-trust failure this section exists to prevent.

To keep this from being tedious, verifying a Decision **surfaces its derived Constraints as "also review"** in the triage list. The curator confirms each one deliberately, but does not have to go looking for them.

**Staleness thresholds by class:**

| Class | Threshold |
|---|---|
| Constraint | 90 days |
| Decision (`reversibility = one_way`) | never stale |
| Decision (other) | 180 days |
| Requirement | 180 days |
| Open Question (`blocking = true`) | 30 days |
| Observation | `review_by`, default 30 days |
| Artifact | **stale-capable, threshold TBD.** Verification also compares `content_hash` |
| Glossary Entry, Hypothesis | no automatic staleness |

A stale object remains active. It is not demoted automatically. It is surfaced in triage and marked stale in any Context Pack that includes it, so that both the curator and the agent can see that nobody has confirmed it recently.

**Contradiction handling.** V1 does not detect semantic contradiction. When the curator notices one, they declare it with an `invalidates` edge, and the invalidated object is flagged for supersession in triage. Automatic contradiction detection is deferred.

---

## 11. Context Pack Contract

The Context Pack is the product. Everything else is substrate.

### 11.1 Definition

A Context Pack is a deterministic, reproducible selection of Knowledge Objects assembled for one task. It is not a Knowledge Object. It asserts nothing of its own.

### 11.2 Determinism

**Pack contents are determined by graph version. Staleness labels may vary by build time.**

Precisely:

- The **selection and ordering** of a Context Pack is a pure function of `(request, graph_version)`.
- The **rendered staleness markers** are a function of `(selection, built_at)`.
- A pack records both `graph_version` and `built_at`. Reproduction at the recorded `built_at` is byte-identical.

This two-part statement is necessary because staleness is measured against the clock, not against the graph. A single unqualified guarantee would be false the moment any object crossed a staleness threshold with no graph change behind it.

**Three exceptions, not one.** The first bullet held only for data that cannot be rewritten after approval, and INV-7 exempts three columns from that rule. All three are read by selection, so each was a way for a later curation transaction to change what an already-built pack selects:

- `status` — assigns the section and drives the active, superseded and rejected predicates. **Closed:** status is now recorded per graph version and resolved as of the pinned version.
- `valid_to_version` — decides membership at the requested version. **Closed:** closing a window at *w* leaves every version below *w* answering as before, so only reopening or moving a closed window is retroactive. That is rejected on every windowed table — `knowledge_objects`, `relations`, `feature_labels`, `feature_label_aliases` — along with any change to `valid_from_version`, which is retroactive for the same reason. When this exception was first written "closed" was true only of `knowledge_objects`; the other three tables were enforced later, and until then a plain `UPDATE` could reopen a closed window on any of them.
- `feature_label_ids` — filters Reviewed Knowledge. **Open**, and the only remaining exception: this is the accepted v1 hole recorded in A17.

Only the third was ever documented. The other two were found from stored packs failing their own reproduction check.

**Staleness must therefore never change pack membership.** Where it otherwise would, the change is materialised as a graph event instead. Observation expiry is the only such case: it is a real state transition executed in a curation transaction, so it increments the graph version and becomes part of graph history (Sections 4.3, 7A, 10). Every other kind of staleness is display-only.

Determinism also requires that pack assembly is pure selection. **No generation happens at build time.** No summarisation, no ranking by model, no rewriting. All distillation happened at write time and is stored as data (this is why Artifact carries a stored `summary`).

Truncation must also be deterministic: fixed section order, fixed within-section ordering, drop from the tail.

### 11.3 Request

```
context.build(
  scope:    phase-29,
  feature:  interviews,        // optional
  glossary: [GLO-0042],        // optional explicit entries
  intent:   implementation,    // implementation | review | debug | architecture | onboarding | planning
  budget:   4000               // tokens, hard cap
)
```

### 11.4 Assembly algorithm

1. Resolve the Scope Chain for `scope`.
2. Collect Knowledge Objects whose validity window applies at
   `graph_version`, then apply the explicit status predicate for the selected
   section, **against the status the object held at `graph_version`**. The only
   historical profile is Recent Superseded Decisions: `status = superseded`
   with a closed window in the last 10 graph versions.

   This step is now implementable as written. It was not before: status was
   stored as a single mutable value describing the present, so "the status
   predicate at `graph_version`" had no data behind it and the implementation
   could only read today's value. Status is now recorded per graph version and
   resolved as of the pinned one (11.2), so the two-predicate rule A1
   established can actually be evaluated at a historical version rather than
   approximated at the current one.
3. Resolve requested feature labels to canonical identities via the registry
   **as of `graph_version`**, following redirects. Apply the filter to
   Reviewed Knowledge only. Operational Knowledge is exempt (Section 3.3).
   Observed Observations in debug and planning are also exempt by the
   explicit Raw-evidence rule in Section 3.3.
4. Apply the intent profile (11.5) to determine section inclusion and ordering.
5. Apply narrowest-scope precedence to Constraints and Glossary Entries,
   recording suppressed ids.
6. Add explicitly requested Glossary Entries to the mandatory set.
7. Order deterministically: by section, then by scope narrowness (narrowest
   first), then by `id`.
8. Fill the budget from the head of that order. Constraints, blocking Open
   Questions, and explicitly requested Glossary Entries are untruncatable. If
   those mandatory objects alone exceed budget, return
   `PACK_BUDGET_INSUFFICIENT`; otherwise drop only the tail and report every
   dropped id.
9. Attach External References only from retained Knowledge Objects through
   one-hop `references` or `implemented_by` edges valid at the requested
   version. References from dropped parents are excluded. Order them by
   parent position, then XREF id.
10. Emit the pack with `graph_version`, ordered ID list, dropped ID list, and
    content hash. The mandatory-content diagnostic counts Constraints,
    blocking Open Questions, and explicitly requested Glossary Entries;
    term-matched Glossary Entries do not count.

### 11.5 Intent profiles

Sections in fixed order. An intent determines which are included.

| Section | impl | review | debug | arch | onboard | plan |
|---|---|---|---|---|---|---|
| Objective (scope description) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Constraints (all in scope) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Blocking Open Questions | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Glossary (term-matched) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Active Decisions | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Requirements | ✓ | ✓ | | ✓ | ✓ | ✓ |
| Rejected Hypotheses | ✓ | | ✓ | ✓ | | ✓ |
| Non-blocking Open Questions | | | ✓ | ✓ | ✓ | ✓ |
| Unexplained Observations | | | ✓ | | | ✓ |
| Artifact summaries + pointers | ✓ | ✓ | | ✓ | ✓ | ✓ |
| External References | ✓ | ✓ | ✓ | | | |
| Superseded Decisions (recent) | | ✓ | ✓ | ✓ | | |

The Unexplained Observations section renders only metadata and evidence
references; Raw Observation bodies are never injected. An `explored`
Hypothesis has no pack section and is surfaced for curation review after 30
days. Observed Observations in debug and planning ignore the requested Feature
filter, including when they have no labels, because untriaged evidence is the
content those profiles are intended to expose.

### 11.6 Storage

Store the recipe, not the rendering:

```
{ scope, feature_label_ids, glossary_entry_ids, intent, budget, graph_version,
  ordered_object_ids[], dropped_object_ids[], content_hash }
```

The rendered body is never stored. Assertion selection is reproducible from
the recipe at any time. V1 has one explicit exception: an object's
`feature_label_ids` is current filing metadata rather than a versioned object
field, so an old feature-filtered pack must report that reproduction
limitation.

### 11.7 Diffing

Two packs for the same `(scope, feature, intent)` at different graph versions can be diffed by their ordered ID lists. That diff is the system's answer to:

> What changed since the agent last knew?

This is a named V1 capability, not a future nicety.

### 11.8 Provenance in the pack

Every object rendered in a pack carries its ID, its scope, `authored_by`, and a stale marker where applicable. An agent must be able to tell a curated Decision from an accepted AI proposal, and a fresh Constraint from one nobody has confirmed in four months.

---

## 12. Write Pipeline

Retrieval is easy. Capture is the hard part, and it is where every comparable system fails. Automatic extraction produces confident noise, and noisy knowledge is worse than none, because the curator stops trusting it and then stops writing to it.

### 12.1 The pipeline

```
Discussion
    ↓  extraction (AI, cheap, high recall, low precision)
Candidates
    ↓  triage (human, deliberate)
Approved Knowledge Objects
    ↓
Context Packs
```

### 12.2 Two write paths

**Path A: deliberate authoring (primary).**

The curator's existing gate cycle is investigate → propose → approve → implement. The knowledge write hangs off **approve**. At the moment a decision is made, `discussion.resolve` is called and a Decision is authored deliberately. This produces high-quality knowledge because it is written at the moment of maximum clarity.

This is the path that must work. If only Path A ever works, the system still succeeds.

**Path B: passive extraction (secondary).**

An assistant may propose Candidates from a Discussion at any time. Candidates are written to the triage list. They are `authored_by = ai`, unapproved, and **invisible to all retrieval**. Nothing enters the graph without an explicit accept.

If Path B is allowed to write directly, the system rots within a month.

### 12.3 Triage

Because V1 is single-user, the review queue is not a workflow. It is a list with four actions:

- **Accept** — becomes an approved Knowledge Object as proposed.
- **Edit and accept** — the curator rewrites, and `authored_by` becomes `human`.
- **Merge** — folded into an existing object by supersession.
- **Reject** — discarded, with the Discussion retained.

Triage also surfaces: stale objects past threshold, Decisions flagged `review_required`, Observations past `review_by`, and declared contradictions.

### 12.4 `discussion.resolve`

The signature capability. Instead of telling an assistant "remember this", the curator says "resolve this discussion", and the assistant returns a structured Candidate:

```
Decision
  statement
  rationale
  alternatives_rejected[]
  reversibility
  derives_from[]
  proposed scope
  proposed feature labels[]      (strings; unrecognised ones become label candidates)
  proposed constraints[]      (each requiring separate accept)
  proposed glossary entries[] (each requiring separate accept)
```

The knowledge is distilled, not raw. The curator accepts, edits, or rejects each element separately.

### 12.5 What the pipeline must never do

- Never write to the graph without explicit acceptance.
- Never edit an approved object in place.
- Never mirror data owned by Git or the issue tracker.
- Never summarise at Context Pack build time.

---

## 13. Retrieval Order

Certainty over similarity.

1. **Exact relations.** Graph traversal from a known object. No scoring.
2. **Structured metadata.** Scope, feature, status, class, date.
3. **Keyword.** Full-text over titles and bodies.
4. **Semantic.** Embeddings, last resort.

Retrieval policy lives server-side, behind the API. It is not delegated to the calling agent. If each agent invents its own retrieval strategy, the system reproduces exactly the drift it exists to prevent.

At V1 data volumes, levels 1 to 3 will outperform level 4 nearly always. Do not over-invest in the semantic layer early.

---

## 14. Success Metrics

Observable, not aspirational.

| Metric | Definition | Why |
|---|---|---|
| **Re-litigation count** | Times a superseded Decision or rejected Hypothesis is re-proposed in a session. | The core product thesis. If this does not fall, nothing else matters. |
| **Pack coverage** | Share of agent sessions that begin from a Context Pack rather than ad hoc search. | Measures whether the system is actually in the loop. |
| **Decisions per phase** | Approved Decisions recorded per Phase. | Measures whether capture is happening at all. Sudden decline means the write path has friction. |
| **Stale ratio** | Active objects past their staleness threshold. | Measures rot. |
| **Candidate accept rate** | Share of AI-proposed Candidates accepted. | Below roughly 30 percent means extraction is noise and Path B should be narrowed or disabled. |

---

## 15. V1 Scope

**In:**

- All ten entities, the eight relation verbs, legality and invariants.
- Scope tree to Phase; Feature as a canonical Project-scoped label with a versioned registry.
- `context.build` and `discussion.resolve`.
- Triage list.
- Hand-backfill of one project's existing knowledge.
- Postgres. Relational plus an edge table. JSONB for flexible metadata.

**Out of V1, explicitly:**

- Any UI beyond a read-only panel.
- Vector search. Keyword plus metadata first; add pgvector when retrieval demonstrably fails.
- Multi-user, authentication, roles.
- Automatic contradiction detection.
- A second consumer. Vendor neutrality is a property of a clean MCP surface, not something to build for up front. It is untested until a second client exists.
- Graph database. Traversals here are two to six hops; recursive CTEs handle that.

**Validation gate.** Before any UI work, backfill one project by hand and run one full phase against the system. The backfill is the schema test. If existing decisions cannot be expressed cleanly in this model, the model is wrong, and that is worth discovering in a day rather than a quarter.

---

## 16. Open Questions

| ID | Question | Owner |
|---|---|---|
| ~~OQ-1~~ | ~~Which project is the backfill target?~~ **Answered:** MIRA. | closed |
| OQ-2 | Does Discussion need a chunking model for long transcripts, or is `body_ref` plus summary enough? | deferred to backfill |
| ~~OQ-3~~ | ~~Free-form or controlled Feature labels?~~ **Answered:** controlled, Project-scoped canonical registry with aliases, a candidate workflow at the proposal boundary, and merge by versioned redirect. See Section 3.3. | closed |
| ~~OQ-4~~ | ~~What triggers a `graph_version` increment?~~ **Answered:** one version per committed curation transaction. See Section 7A. | closed |
| OQ-5 | Do External References need automated verification, or is manual `last_verified_at` sufficient at V1? | deferred |
| OQ-6 | What staleness threshold suits Artifact? Verification also compares `content_hash`, so the threshold may matter less than for other types. | TBD after baseline |
| OQ-7 | Do Glossary Entry and Hypothesis need automatic staleness at all? Currently neither has a threshold. | TBD after baseline |

---

## 17. How the Model Earns New Entities

> **The domain model earns new entities through real usage, not through theoretical completeness.**

Every real case will suggest a new entity. Most suggestions are wrong, and the cost of accepting them is not additive: each entity brings a lifecycle, a death condition, a set of legal triples, intent-profile placement, staleness rules, and a permanent share of the curator's judgement about where things go. Ten entities is a model a person can hold in their head. Sixteen is a taxonomy they consult.

### 17.1 Promotion criteria

A candidate concept (Section 18) is promoted to a first-class entity only when **all four** hold:

1. **Evidence.** At least three distinct real instances, from backfill or live use, could not be expressed by any existing entity. Three is a chosen threshold, not a derived one; it is set low enough to be reachable and high enough to exclude one-offs.
2. **Not adequately served.** For each instance, forcing it into the nearest existing entity would lose information that a reader would later need. "Slightly awkward fit" is not sufficient.
3. **Death condition.** The concept has a defined end state. An entity that only ever accumulates becomes a junk drawer and stops being read (the reasoning that gave Observation its lifecycle, Section 4.3).
4. **Lifecycle and triples.** A proposed state machine and a proposed set of legal triples exist and do not overlap an existing entity's semantics.

### 17.2 What happens to an instance that does not fit

**It is not recorded.** An ambiguous case is not forced into Open Question, Decision, or Constraint to avoid adding an entity. Forcing produces knowledge that is quietly wrong, which is worse than a gap, because a gap is visible.

Nor is the item buried inside a Decision body. Hiding a distinct item in a Decision's statement or rationale loses its independent identity, lifecycle, and relations just as surely as forcing it into a near-fit entity. This failure is more tempting because it looks like taxonomic restraint; it is still information loss.

The instance goes into the Backfill Domain Gap register (Section 19) with enough detail to be re-examined. It is recorded as a gap, not as knowledge.

### 17.3 Demotion

The same standard applies in reverse. If an entity accumulates no instances through a full validation phase, it is a candidate for removal, not a feature awaiting adoption.

### 17.4 Classification tests

Three tests resolve the boundaries on which independent backfill runs disagreed.

#### 17.4.1 Atomicity

An item is atomic if it could be superseded on its own without touching any other item. If two statements always change together, they are one item. If either can change alone, they are two.

**Worked example.** The seven per-brand magic-link host rules are seven Constraints, not one, because `childcaretraining` can be remapped without touching `cpraedcourse`.

**Counterexample to merging.** “Classify per enrollment” and “deduplicate per user per day” are two items, because either could change alone.

This rule also makes the Section 17.1 promotion threshold countable. Without it, instance counts vary by a factor of four on the same corpus, as recorded in A12.

#### 17.4.2 Is it a Constraint?

A Constraint governs future changes within a scope. A working principle, retrospective lesson, runbook step, test task, or implementation technique is not a Constraint, however true it is.

**Test.** Would violating this be a defect in the system, or merely a worse way of working? Only the first is a Constraint.

Rejected backfill examples, all initially classified as Constraints:

- “Verify against DB and code; never assume” — working principle.
- “Run migrations before backfill” — runbook step.
- “Harden tests against same-second coincidence” — retrospective lesson.
- “Treat local completion and deployment as distinct” — status discipline.

This boundary matters because retrospective lessons are seductive as Constraints, accumulate faster than real rules, and are injected unconditionally. Thirteen of 45 initial classifications failed this test.

#### 17.4.3 Is it a Hypothesis?

Was it built, run, or tested, and is there evidence? If yes, it is a Hypothesis. If no, it is an alternative recorded inside the Decision that rejected it.

This is a factual test, not a judgement. Email as an identity key was built, ran, failed, and caused incident C9, so it is a Hypothesis. Per-brand hosts were considered and set aside during deliberation without being built, so they are an inline alternative.

---

## 18. Deferred Candidate Concepts

Concepts identified as possible gaps, deliberately **not** implemented, pending evidence under Section 17.1.

Neither has an entity, a lifecycle, a state machine, legal triples, or a place in any intent profile. Per Section 6, they acquire no triples until promoted.

### 18.1 Risk

**Working definition.** A potential future problem that has not necessarily occurred, which may be mitigated, accepted, materialised, or closed.

**Origin.** The Vision listed "known risks" among Context Pack contents while no Risk entity existed.

**Nearest existing homes, and what each loses.** A non-blocking Open Question captures "unresolved" but not "predicted, with a likelihood and a cost". An Observation captures "noticed" but a Risk has not been observed; that is the point of it. Decision rationale can hold "we accepted this risk", which covers the accepted case and not the open one.

**What would promote it.** Three or more MIRA items that are genuinely predictive, carry mitigation state, and lose something real when written as Open Questions.

**What would settle it the other way.** If every candidate turns out to be a non-blocking Open Question with a slightly different tone, the concept is a rendering preference and not an entity.

### 18.2 Assumption

**Working definition.** Something believed true without having been tested through implementation. It may be confirmed, disproven, superseded, or remain unresolved.

**Origin.** The Vision listed "disproven assumption" under Hypothesis, but Hypothesis requires evidence of an attempt (Section 4.4), so an assumption disproven by reading a document or checking a metric has no home.

**Nearest existing homes, and what each loses.** An axiomatic Constraint captures a belief held without derivation, but a Constraint is a rule and an Assumption is a premise, and Constraints are injected unconditionally, which most assumptions should not be. Decision rationale can state an assumption, but then it is not independently traceable, and the query that matters is exactly the traceable one.

**The query that would justify it.** *"Assumption A was disproven. Which active Decisions rest on it?"* This is the same shape as requirement change impact (Section 4.1), which is the highest-value capability in the system. If that query has real instances, the case is strong.

**What would promote it.** Three or more MIRA decisions resting on a stated, untested premise, where at least one premise later turned out to be wrong.

---

## 19. Backfill Domain Gap Register

Populated during validation. Empty at the time of writing.

The register is the primary output of the backfill, ahead of the imported knowledge itself. A backfill that produces no entries should be treated with suspicion rather than satisfaction: it more likely means the selected corpus was too easy than that the model is correct.

Each entry records:

| Field | Purpose |
|---|---|
| `gap_id` | Stable reference |
| `instance` | The real thing that did not fit, quoted concretely |
| `source` | Where it came from |
| `attempted_homes` | Which existing entities were tried, and what each lost |
| `candidate_concept` | Which deferred concept it points at, or `new` |
| `recorded_as` | `not_recorded` by default (Section 17.2), or the entity chosen with its known loss |
| `date` | |

Entries are counted per candidate concept against the Section 17.1 threshold.

### Validation entries (2026-08-20)

The first MIRA scope seed and hand-authored import produced these entries.
They are recorded, not resolved:

**DG-0001 — Phase 0.5 is a scope node spanning siblings**

- `instance`: “Phase 0.5 (launch)” spans Reminders, Delivery, and Data.
- `source`: MIRA backfill audit scope column; launch evidence and Phase 0.5
  notes.
- `attempted_homes`: `Reminders`, `Delivery`, `Data` workstreams.
- `candidate_concept`: `Scope node spanning siblings`.
- `recorded_as`: `not_recorded`.
- `date`: `2026-08-20`.

This is a stronger form of DG-5. DG-5 covers knowledge true at one scope and
consequential at a sibling; this is a scope node that genuinely spans three
siblings, which the single-parent tree cannot express. The seed places the
phase under Reminders only because most launch evidence sits there. The two
readings remain unresolved: the audit-derived workstream names may be wrong
because they were not curator-defined, or the fixed four-level,
function-first tree may not match how MIRA is actually organised.

**DG-0002 — ADR-001 has no recoverable origin**

- `instance`: The ADR-001 document records the Decision, but no source
  Discussion or other legal `derives_from` origin is available.
- `source`: `docs/mira_decisions.md#DEC-0001`.
- `attempted_homes`: `Decision`.
- `candidate_concept`: `Unrecoverable origin`.
- `recorded_as`: `not_recorded`.
- `date`: `2026-08-20`.

**DG-0003 — DEC-0002 has no recoverable origin**

- `instance`: `DEC-0002` is a real historical Decision with no legal
  `derives_from` edge in the surviving record.
- `source`: `backfill/mira/objects/DEC-0002.json`.
- `attempted_homes`: `Decision`.
- `candidate_concept`: `Unrecoverable origin`.
- `recorded_as`: `not_recorded`.
- `date`: `2026-08-20`.

**DG-0004 — DEC-0003 has no recoverable origin**

- `instance`: `DEC-0003` is a real historical Decision with no legal
  `derives_from` edge in the surviving record.
- `source`: `backfill/mira/objects/DEC-0003.json`.
- `attempted_homes`: `Decision`.
- `candidate_concept`: `Unrecoverable origin`.
- `recorded_as`: `not_recorded`.
- `date`: `2026-08-20`.

**DG-0005 — DEC-0004 has no recoverable origin**

- `instance`: `DEC-0004` is a real historical Decision with no legal
  `derives_from` edge in the surviving record.
- `source`: `backfill/mira/objects/DEC-0004.json`.
- `attempted_homes`: `Decision`.
- `candidate_concept`: `Unrecoverable origin`.
- `recorded_as`: `not_recorded`.
- `date`: `2026-08-20`.

**DG-0006 — DEC-0005 has no recoverable origin**

- `instance`: `DEC-0005` is a real historical Decision with no legal
  `derives_from` edge in the surviving record.
- `source`: `backfill/mira/objects/DEC-0005.json`.
- `attempted_homes`: `Decision`.
- `candidate_concept`: `Unrecoverable origin`.
- `recorded_as`: `not_recorded`.
- `date`: `2026-08-20`.

**DG-0007 — DEC-0006 has no recoverable origin**

- `instance`: `DEC-0006` is a real historical Decision with no legal
  `derives_from` edge in the surviving record.
- `source`: `backfill/mira/objects/DEC-0006.json`.
- `attempted_homes`: `Decision`.
- `candidate_concept`: `Unrecoverable origin`.
- `recorded_as`: `not_recorded`.
- `date`: `2026-08-20`.

**DG-0008 — DEC-0007 has no recoverable origin**

- `instance`: `DEC-0007` is a real historical Decision with no legal
  `derives_from` edge in the surviving record.
- `source`: `backfill/mira/objects/DEC-0007.json`.
- `attempted_homes`: `Decision`.
- `candidate_concept`: `Unrecoverable origin`.
- `recorded_as`: `not_recorded`.
- `date`: `2026-08-20`.

**DG-0009 — DEC-0008 has no recoverable origin**

- `instance`: `DEC-0008` is a real historical Decision with no legal
  `derives_from` edge in the surviving record.
- `source`: `backfill/mira/objects/DEC-0008.json`.
- `attempted_homes`: `Decision`.
- `candidate_concept`: `Unrecoverable origin`.
- `recorded_as`: `not_recorded`.
- `date`: `2026-08-20`.

**DG-0010 — DEC-0009 has no recoverable origin**

- `instance`: `DEC-0009` is a real historical Decision with no legal
  `derives_from` edge in the surviving record.
- `source`: `backfill/mira/objects/DEC-0009.json`.
- `attempted_homes`: `Decision`.
- `candidate_concept`: `Unrecoverable origin`.
- `recorded_as`: `not_recorded`.
- `date`: `2026-08-20`.

**DG-0011 — DEC-0010 has no recoverable origin**

- `instance`: `DEC-0010` is a real historical Decision with no legal
  `derives_from` edge in the surviving record.
- `source`: `backfill/mira/objects/DEC-0010.json`.
- `attempted_homes`: `Decision`.
- `candidate_concept`: `Unrecoverable origin`.
- `recorded_as`: `not_recorded`.
- `date`: `2026-08-20`.

**DG-0012 — DEC-0011 has no recoverable origin**

- `instance`: `DEC-0011` is a real historical Decision with no legal
  `derives_from` edge in the surviving record.
- `source`: `backfill/mira/objects/DEC-0011.json`.
- `attempted_homes`: `Decision`.
- `candidate_concept`: `Unrecoverable origin`.
- `recorded_as`: `not_recorded`.
- `date`: `2026-08-20`.

Known gap classes to watch for, carried from prior review:

| Watch item | Description |
|---|---|
| Risk | Section 18.1 |
| Assumption | Section 18.2 |
| Scope tie-breaker | Knowledge true at one scope but consequential at a sibling. Currently pure curation judgement with no mechanism |
| Unrecoverable origin | A real Decision whose origin cannot be reconstructed, which INV-3 forbids recording |
| Missing verb | A relationship that exists in reality and no frozen verb expresses |
| Two-scope knowledge | An object that is genuinely true at two scopes, which INV-1 forbids |
