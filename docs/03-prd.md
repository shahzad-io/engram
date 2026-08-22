# Project Knowledge Engine — Product Requirements Document

**Version:** 1.2
**Status:** Current
**Derived from:** 01 Vision v2.1, 02 Domain Specification v1.2
**Derivation authority:** 01 Vision → 02 Domain Specification → 03 PRD → 04 Master Tech Spec → 05 Technology Spec. Each document implements the one above and may not redefine it.
**Vocabulary authority (domain concepts):** 02 Domain Specification. Entity names, knowledge classes, relation verbs, legal triples, lifecycles, and invariants are defined there. The Vision is prose; where Vision prose contradicts the Domain Spec on a domain concept, the Vision is the defect. Where this PRD describes domain behaviour, it restates the Domain Specification and does not extend it. Every product-level decision made in this document that was not present in the source documents is listed in Section 23.

---

## 1. Executive Summary

The Project Knowledge Engine is a system that preserves engineering understanding across long-lived software projects.

It does not store conversations. It stores the durable knowledge that conversations produce: requirements, decisions and their rationale, constraints that govern future work, project vocabulary, unresolved questions, and approaches that were tried and failed. Each of these is scoped, versioned by supersession, traceable to its evidence, and never edited in place.

From that knowledge the system produces **Context Packs**: deterministic, reproducible selections of project understanding assembled for one specific task at one specific scope. A Context Pack is what an engineer or an AI assistant reads before starting work, instead of reconstructing project history from chat logs, pull requests, and memory.

The system deliberately does not own code, tasks, commits, or documents. Those systems remain authoritative for their own content. The engine stores the reasoning that connects them, and pointers into them.

V1 is single-user and is validated against one real project (MIRA) through one real project phase. The validation is not a demonstration. It is a test of whether the domain model can represent real engineering history. If it cannot, the model is wrong and gets revised.

---

## 2. Problem

### 2.1 What actually goes wrong

In a project that runs for months, implementation artefacts survive and reasoning does not. The code is still there. The pull requests are still there. What disappears is:

- why a decision was made, and what was rejected in making it
- which requirement caused a decision, and whether that requirement still holds
- which constraints apply to a given part of the system
- what project-specific terms mean
- what remains unresolved
- what was already tried and failed
- what changed since the last time someone worked in this area

The observable symptoms are specific and repetitive: the same discussion happens twice, a previously rejected approach is proposed again, an architectural choice is undone by someone who did not know why it existed, and an AI assistant is re-briefed on the same background at the start of every session.

This is **knowledge entropy**, not forgetfulness.

### 2.2 Why this is not "AI memory"

Existing AI memory systems answer the question *"what should this assistant remember about me?"* They extract facts from conversation, embed them, and retrieve by similarity. That is a reasonable solution to a personalisation problem.

It is the wrong shape for this problem, for three reasons:

1. **Authority is not similarity.** Whether a decision is still binding is a question of status and supersession, not of cosine distance. Similarity search cannot answer it and should never be asked to.
2. **Conversation is the wrong unit.** Six weeks later nobody needs the exchange. They need the conclusion. Storing the exchange and hoping to re-derive the conclusion is strictly worse than storing the conclusion with a pointer to the exchange.
3. **The knowledge outlives the assistant.** If the value of the system is tied to one model's memory format, it evaporates when the tooling changes. The persistent asset is the project's engineering knowledge; the assistant is a replaceable consumer.

The closest honest prior art is not a memory system. It is Architecture Decision Records, extended with a scope model, a relationship graph, traceability to requirements, and a programmatic access surface.

### 2.3 Why documentation has not solved it

Documentation describes the current state. It does not preserve the reasoning that produced the state, it does not record what was rejected, and it goes stale without any signal that it has done so. Documentation is a rendering; this system stores the source.

---

## 3. Target User

### 3.1 V1 primary user

One engineer or technical lead who owns architecture and product decisions across one or more long-running projects, and who works with AI assistants under a deliberate gate cycle (investigate → propose → approve → implement).

Characteristics that shape the product:

- **They are already the bottleneck for decisions.** Knowledge capture must attach to a moment they already stop at, not add a new one.
- **They are both author and approver.** There is no handoff, so there is no workflow.
- **They will abandon the system if it feels like documentation homework.** Capture cost must be paid at the moment of maximum clarity, when the decision is being made, or it will not be paid at all.
- **Their AI assistants are the highest-volume consumer of the output.** More Context Packs will be read by agents than by the person.

### 3.2 Secondary consumer (V1)

AI coding and reasoning assistants operating on the project. They consume Context Packs and may propose knowledge Candidates. They never write durable knowledge.

### 3.3 Eventual team user (not V1)

In a team setting the same system serves onboarding, review, and cross-team traceability, with authorship distributed across engineers and curation possibly delegated. This changes provenance, approval, and conflict handling materially. It is out of V1 and nothing in V1 should be shaped around it. See Section 19.

---

## 4. Product Goals (V1)

| ID | Goal | Observable when |
|---|---|---|
| G-1 | Durable decisions are captured during real work | Decisions recorded per phase is non-zero and stable across the validation phase |
| G-2 | Knowledge is trustworthy | Every knowledge object shows its author, approval time, evidence, and freshness |
| G-3 | Context is deterministic | The same Context Pack request at the same graph version selects identical content; staleness labels may differ by build time |
| G-4 | Context replaces reconstruction | Agent sessions in the validation phase begin from a Context Pack rather than ad hoc briefing |
| G-5 | Requirement change is traceable | When a requirement is superseded, the affected decisions are listed without manual search |
| G-6 | Dead ends stay dead | Previously rejected approaches are visible in relevant Context Packs |
| G-7 | The domain model survives reality | Selected real MIRA history can be represented without inventing new entities |

G-7 is a goal, not an assumption. It may fail. Failing it early is a successful outcome of validation.

---

## 5. Non-Goals (V1)

The system will not attempt to be:

| Non-goal | Why |
|---|---|
| A multi-user collaboration platform | V1 has one curator. No roles, permissions, delegation, reviewer assignment, notifications, or concurrent-edit resolution. |
| A personal memory system | Personal preference recall is a different product with a different lifecycle. The boundary test: if it would still matter to someone who joined after you left, it belongs here; otherwise it does not. |
| A replacement for Git | Git owns commits, diffs, and file history. The engine stores pointers. |
| A replacement for an issue tracker | The tracker owns tasks and their state. The engine stores pointers. |
| A replacement for documentation or design systems | Those systems own document and design content. The engine stores references, versions, and summaries. |
| A code search engine | The engine has no index of source code. |
| A generic chat archive | Conversations are evidence with retention limits, not the primary object. |
| A UI-heavy knowledge management application | V1 requires no UI beyond, optionally, a read-only view. |
| A vector database with project metadata attached | Retrieval precedence is exact relations, then metadata, then keyword, then semantic. Semantic retrieval is out of V1 entirely. |

---

## 6. Product Principles

| ID | Principle | Product consequence |
|---|---|---|
| P-1 | Knowledge over conversation | No feature exists whose primary output is a better chat transcript. |
| P-2 | Store why, reference what | Any field that duplicates data owned by Git, the tracker, or a document store is a defect. |
| P-3 | Distillation over archival | Capture is deliberate and structured, not passive and complete. |
| P-4 | Trust over volume | Nothing enters durable knowledge without explicit human acceptance. A smaller trusted graph beats a larger uncertain one. |
| P-5 | Certainty over similarity | Retrieval prefers exact relationships; semantic matching is the last resort and is not in V1. |
| P-6 | Append-only | Approved knowledge is never edited or deleted. Correction happens by supersession, which preserves the history of the correction. |
| P-7 | Determinism | Context Pack assembly is pure selection. No generation happens at read time. |
| P-8 | Provenance is mandatory | Every knowledge object records how it came to exist. Without it the graph becomes folklore. |
| P-9 | Capture at the decision point | The write path attaches to the moment a decision is made, not to a later documentation session. |

---

## 7. Core User Journeys

Each journey states who needs it, what the user does, what the system does, and what observable result proves it worked.

### Journey A — A requirement enters the system

**Need.** Traceability must start where the work starts, not one step later.

**User.** Receives a requirement from a founder, client, or support signal. Records it as a Requirement at the appropriate scope, with its source and the reason it was asked for. Links it to the PRD section that defines it, as an Artifact reference.

**System.** On acceptance, stores the Requirement in `active` with provenance. Makes it available to scope resolution and to `derives_from` traversal in both directions. Before acceptance it is a Candidate and is invisible to retrieval.

**Proof.** The Requirement is returned in a Context Pack for its scope, and any Decision later created from it shows the Requirement as its origin.

**Boundary.** The Requirement is one atomic statement. The PRD prose is not copied in.

---

### Journey B — Resolve a discussion

**Need.** Discussion is where knowledge is produced and where it is normally lost.

**User.** Explores a question with an AI assistant. When the question settles, the user asks the assistant to resolve the discussion rather than to remember it.

**System.** The assistant returns a structured Candidate: a proposed Decision with statement, rationale, alternatives rejected, reversibility, origin links, proposed scope, proposed feature labels, and optionally proposed Constraints and Glossary Entries. Each element is separately acceptable. Nothing is written to durable knowledge yet.

**User.** Accepts, edits and accepts, merges into an existing object, or rejects each element.

**Proof.** After acceptance, the Decision appears in Context Packs for its scope and its origin Discussion is marked distilled. Before acceptance, nothing is retrievable.

---

### Journey C — Record a decision

**Need.** A decision without its reasoning is an unexplained constraint on the future.

**User.** At the approve step of their existing gate cycle, records the decision with rationale, the alternatives rejected and why, and how reversible it is.

**System.** Stores it as `active`, requires at least one origin link, and injects it into Context Packs in scope.

**Proof.** Six weeks later, the question "why does this behave this way?" is answered by retrieving the Decision and traversing to its evidence, without reading any conversation.

---

### Journey D — Capture a failed approach

**Need.** Without recorded failure, agents and engineers re-propose dead ends indefinitely, and the cost is invisible until it is paid.

**User.** After trying something that did not work, records a Hypothesis: what was tried, why it failed, what evidence shows it failed, and what would make it worth reconsidering.

**System.** Stores it as `rejected` and includes it in Context Packs for implementation, debugging, architecture, and planning intents.

**Proof.** An agent given a Context Pack for that scope does not propose the failed approach, or proposes it and can be shown the recorded failure.

**Boundary.** An alternative rejected during deliberation lives inside the Decision that rejected it. A Hypothesis is something that was actually built, run, or tested. If it was not tried, it is not a Hypothesis.

---

### Journey E — A requirement changes

**Need.** This is the highest-value query in the system and the one that existing decision-record practice does not answer.

**User.** A founder changes a requirement. The user supersedes the old Requirement with a new one.

**System.** Marks the old Requirement `superseded`. Identifies every active Decision with an origin link to it, sets those Decisions to require review, and lists them for the user. The Decisions remain active; nothing is invalidated automatically.

**User.** Reviews each flagged Decision and either confirms it still holds, supersedes it, or reverts it.

**Proof.** The user receives the list of affected Decisions without performing a manual search, and any Context Pack containing a flagged Decision shows the flag.

---

### Journey F — Start an implementation

**Need.** Work should begin from project understanding, not from a re-briefing.

**User.** Requests a Context Pack for a scope, optionally a feature, with implementation intent and a token budget.

**System.** Resolves the scope chain, selects applicable knowledge, always includes constraints and blocking open questions in scope, includes active decisions, requirements, rejected hypotheses, artefact summaries and external pointers, orders deterministically, truncates to budget, and reports what was dropped.

**Proof.** The agent or engineer begins work without asking questions the system already has answers to, and the same request repeated at the same graph state returns identical content.

---

### Journey G — Investigate a problem

**Need.** Debugging is where missing context is most expensive.

**User.** Requests a Context Pack for the affected scope with debugging intent.

**System.** Returns constraints, blocking and non-blocking open questions, active decisions, recently superseded decisions, rejected hypotheses, unexplained observations, glossary terms, and external pointers.

**Proof.** The investigator sees prior attempts and current unknowns before starting, rather than discovering them by repeating them.

**Note.** The Domain Specification defines an intent named `debug`. This PRD treats "investigation" as the same intent. See Section 23, PD-1.

---

### Journey H — Knowledge becomes stale

**Need.** Nothing in an append-only model expires on its own, and silently outdated knowledge is worse than absent knowledge.

**System.** Tracks when each knowledge object was last verified, and marks objects that have passed their staleness threshold. Stale objects remain active. They are surfaced in the curation list and are marked as stale wherever they appear in a Context Pack.

**User.** Reviews stale objects and either confirms them, supersedes them, or lifts them.

**Proof.** A consumer of a Context Pack can tell the difference between a constraint confirmed last week and one nobody has looked at in six months.

---

## 8. Functional Requirements

Each requirement is observable and testable. Requirements restate Domain Specification rules; they do not extend them.

### 8.1 Knowledge model — general

| ID | Requirement |
|---|---|
| PRD-KN-001 | Every knowledge object belongs to exactly one scope node. |
| PRD-KN-002 | Every knowledge object may carry zero or more feature labels. |
| PRD-KN-003 | Every knowledge object belongs to exactly one knowledge class: Raw, Reviewed, or Operational. |
| PRD-KN-004 | An approved knowledge object cannot be edited. Attempting to change its content produces a new object that supersedes it. |
| PRD-KN-005 | An approved knowledge object cannot be deleted. |
| PRD-KN-006 | A superseding object records exactly one predecessor, and the predecessor's status becomes superseded at the same time. |
| PRD-KN-007 | Relationships between objects are restricted to a fixed, closed set of relation types. A relationship outside that set is rejected. |
| PRD-KN-008 | Relationships are restricted to permitted combinations of source type, relation type, and target type. Impermissible combinations are rejected. |
| PRD-KN-009 | Every Raw knowledge object (Discussion, Observation) records `authored_by` and `created_at`. `approved_at` is null. `last_verified_at` is not used. Observation's `review_by` is a separate mechanism, not verification. |
| PRD-KN-010 | Every Reviewed and Operational knowledge object records `authored_by`, `created_at`, `approved_at`, and `last_verified_at`. |

### 8.2 Requirements and change impact

| ID | Requirement |
|---|---|
| PRD-REQ-001 | A Requirement records a single atomic statement, its source, and the reason it was requested. |
| PRD-REQ-002 | A Requirement may reference an Artifact (such as a PRD) but does not contain that artefact's content. |
| PRD-REQ-003 | A Requirement can be superseded by a newer Requirement, or withdrawn with no replacement. |
| PRD-REQ-004 | When a Requirement is superseded or withdrawn, every active Decision that derives from it is marked as requiring review. |
| PRD-REQ-005 | Marking a Decision as requiring review does not change its status; it remains active and binding until the user acts. |
| PRD-REQ-006 | The user can list all active Decisions that derive from a given Requirement, directly or through intermediate Decisions. |
| PRD-REQ-007 | A Decision marked as requiring review displays that marker wherever it appears, including in Context Packs. |
| PRD-REQ-008 | The user can clear the review marker by confirming, superseding, or reverting the Decision. |

### 8.3 Decisions

| ID | Requirement |
|---|---|
| PRD-DEC-001 | A Decision records its statement, rationale, the alternatives considered and rejected with a reason for each, and its reversibility. |
| PRD-DEC-002 | A Decision must record at least one origin: a Requirement, Discussion, Observation, Open Question, or another Decision. A Decision with no origin is rejected. |
| PRD-DEC-003 | A Decision has exactly one status: active, superseded, or reverted. |
| PRD-DEC-004 | A reverted Decision is distinguishable from a superseded one. |
| PRD-DEC-005 | A Decision does not carry a numeric confidence value. |
| PRD-DEC-006 | Reversibility is recorded as one of: cheap, costly, one-way. |
| PRD-DEC-007 | The user can traverse from a Decision to its evidence, and from any object to the Decisions that derive from it. |
| PRD-DEC-008 | A Decision can record that it was implemented by one or more external references. |

### 8.4 Discussions and Observations (Raw Knowledge)

| ID | Requirement |
|---|---|
| PRD-DSC-001 | A Discussion records its medium, participants, when it occurred, and a reference to its content. |
| PRD-DSC-002 | A Discussion is never included as body text in a Context Pack. It appears only as a referenced source. |
| PRD-DSC-003 | A Discussion is marked distilled once at least one Reviewed Knowledge object derives from it. |
| PRD-DSC-004 | A Discussion that produced no durable knowledge can be archived. |
| PRD-DSC-005 | Archived Discussions are subject to retention reduction; distilled Discussions are retained in full as evidence. |
| PRD-OBS-001 | An Observation records what was noticed, when, a reference to supporting evidence, and a review date. |
| PRD-OBS-002 | An Observation without supporting evidence is rejected. |
| PRD-OBS-003 | An Observation without a review date is rejected. |
| PRD-OBS-004 | An Observation past its review date with no action is marked stale and appears in the curation list. Because this changes pack membership, it is recorded as a graph event and advances the graph version. |
| PRD-OBS-005 | A stale Observation is excluded from Context Packs. |
| PRD-OBS-006 | An Observation can be promoted to an Open Question or a Hypothesis, or absorbed into the rationale of a Decision that explains it. |
| PRD-OBS-007 | An absorbed Observation is no longer treated as unexplained. |
| PRD-OBS-008 | An unexplained Observation may appear in debug and planning packs as metadata and an evidence reference only; its Raw body is never injected. |

### 8.5 Open Questions

| ID | Requirement |
|---|---|
| PRD-OQ-001 | An Open Question records the question, who must answer it, and whether it blocks work. |
| PRD-OQ-002 | An Open Question can record which objects it blocks. |
| PRD-OQ-003 | A blocking Open Question in scope is included in every Context Pack for that scope, regardless of intent or feature filter. |
| PRD-OQ-004 | An Open Question is resolved only by a deliberate curator act, which requires an existing Decision that records the question as an origin. A Decision MAY derive from an Open Question that remains `open`; that origin link does not resolve the question. |
| PRD-OQ-005 | An Open Question that stopped mattering can be marked obsolete without a resolving Decision. |
| PRD-OQ-006 | A blocking Open Question is capped at 280 characters. Non-blocking Open Questions have no additional body-length cap. |

### 8.6 Constraints

| ID | Requirement |
|---|---|
| PRD-CON-001 | A Constraint records a short imperative rule and whether enforcement is hard or soft. |
| PRD-CON-002 | A Constraint either derives from a Decision or is explicitly marked axiomatic. A Constraint with neither is rejected. |
| PRD-CON-003 | A Constraint body exceeding the defined length limit is rejected. |
| PRD-CON-004 | Every active Constraint in scope is included in every Context Pack for that scope, regardless of intent or feature filter. |
| PRD-CON-005 | A Constraint can be superseded by another Constraint, or lifted when it no longer applies. Lifted and superseded are distinguishable. |
| PRD-CON-006 | Where two Constraints in the same scope chain conflict, the narrower scope takes precedence, and the user is warned that a conflict exists. |
| PRD-CON-007 | Conflict between Constraints is declared by the user, not detected automatically. |

### 8.7 Glossary

| ID | Requirement |
|---|---|
| PRD-GLO-001 | A Glossary Entry records a term, a short definition, and any aliases. |
| PRD-GLO-002 | A Glossary Entry definition exceeding the defined length limit is rejected. |
| PRD-GLO-003 | A Glossary Entry in scope is included in a Context Pack when its term or an alias appears in the pack's other selected content. |
| PRD-GLO-004 | The user can request specific Glossary Entries be included in a Context Pack regardless of term matching. |
| PRD-GLO-005 | A Glossary Entry can be superseded or deprecated. |

### 8.8 Hypotheses (negative knowledge)

| ID | Requirement |
|---|---|
| PRD-HYP-001 | A Hypothesis records what was tried, why it failed, supporting evidence, and optionally the condition under which it would be worth reconsidering. |
| PRD-HYP-002 | A Hypothesis represents something that was actually attempted. Alternatives rejected during deliberation are recorded inside the relevant Decision instead. |
| PRD-HYP-003 | A rejected Hypothesis can be revived, which is distinguishable from never having been rejected. |
| PRD-HYP-004 | Rejected Hypotheses in scope appear in Context Packs for implementation, debugging, architecture, and planning intents. |
| PRD-HYP-005 | An `explored` Hypothesis is excluded from Context Packs. If it is older than 30 days, it appears in the curation list for review without changing status or graph version. |

### 8.9 Artifacts and external references

| ID | Requirement |
|---|---|
| PRD-ART-001 | An Artifact records its kind, version, location, content hash, and a short summary written at approval time. |
| PRD-ART-002 | The engine does not store artefact content. The originating system remains authoritative. |
| PRD-ART-003 | Artifact versions are handled by supersession; earlier versions remain retrievable. |
| PRD-ART-004 | Artifact summaries are fixed at approval and are not regenerated when a Context Pack is built. |
| PRD-ART-005 | An Artifact can become stale, because the document it points at can change without anyone superseding the Artifact. Verification compares the recorded content hash and reports a mismatch. |
| PRD-XREF-001 | An External Reference records the system it points into, an identifier, a location, and when it was last verified. |
| PRD-XREF-002 | The engine does not store or mirror the content an External Reference points to. |
| PRD-XREF-003 | An External Reference that has not been verified within its threshold is displayed as unverified wherever it appears. |

### 8.10 Scope and feature filtering

| ID | Requirement |
|---|---|
| PRD-SCP-001 | The scope hierarchy is Global, Project, Workstream, Phase. Each node except Global has exactly one parent. |
| PRD-SCP-002 | There is no Feature level in the scope hierarchy. |
| PRD-SCP-003 | Scope resolution for a target scope produces the ordered chain from that scope up to Global. |
| PRD-SCP-004 | An object is applicable to a target scope if its scope is any member of the target's scope chain. |
| PRD-SCP-005 | A feature label is a cross-cutting filter. One feature may apply across multiple phases and one phase may carry multiple features. |
| PRD-SCP-008 | Feature labels are canonical and owned by a project. Knowledge references a label by identity, not by free text. |
| PRD-SCP-009 | An unrecognised label string does not enter the graph. It becomes a label candidate the user resolves by creating a label, attaching an alias, or dropping it. |
| PRD-SCP-010 | Two labels that mean the same thing can be merged. A merge changes no knowledge object. |
| PRD-SCP-011 | A label is never deleted. It can be deprecated. |
| PRD-SCP-012 | Label resolution is evaluated as of the graph version being requested, so a pack reproduced at an earlier version resolves labels as they stood then. |
| PRD-SCP-006 | Feature filtering applies to Reviewed Knowledge only. Operational Knowledge in scope is never excluded by a feature filter. Observed Raw Observations selected for debug or planning are also exempt, including unlabeled Observations, so untriaged evidence remains visible. |
| PRD-SCP-007 | Knowledge is assigned to the scope at which it is true, not the scope at which it was discovered. |

### 8.11 Curation and provenance

| ID | Requirement |
|---|---|
| PRD-CUR-001 | An AI assistant can propose knowledge as Candidates. Candidates are not durable knowledge. |
| PRD-CUR-002 | A Candidate is not returned by any retrieval operation and never appears in a Context Pack. |
| PRD-CUR-003 | A Candidate becomes durable knowledge only through explicit human acceptance. |
| PRD-CUR-004 | The user can accept, edit and accept, merge into an existing object, or reject each Candidate. |
| PRD-CUR-005 | A Candidate that is edited before acceptance is recorded as human-authored. |
| PRD-CUR-006 | Rejecting a Candidate discards it while retaining its originating Discussion. |
| PRD-CUR-007 | A structured Candidate containing multiple proposed objects can be accepted or rejected element by element. |
| PRD-CUR-008 | Corrections to approved knowledge are made by supersession, never by editing. |
| PRD-CUR-009 | The curation list surfaces: pending Candidates, objects past their staleness threshold, Decisions requiring review, Observations past their review date, and declared conflicts. |
| PRD-PRV-001 | Every knowledge object records whether it was authored by a human or proposed by an AI assistant. |
| PRD-PRV-002 | Every knowledge object records when it was approved. |
| PRD-PRV-003 | Every knowledge object records the source it came from and the evidence supporting it. |
| PRD-PRV-004 | Provenance is visible wherever a knowledge object is presented, including in Context Packs. |

### 8.12 Knowledge rot

| ID | Requirement |
|---|---|
| PRD-ROT-001 | Every knowledge object records when it was last verified. |
| PRD-ROT-002 | The user can confirm an object still holds, which updates its verification time without creating a new graph version. |
| PRD-ROT-007 | Verification does not cascade. Confirming a Decision does not confirm Constraints derived from it; each carries its own verification state. |
| PRD-ROT-008 | Verifying a Decision surfaces its derived Constraints in the curation list as "also review", so the user need not search for them. |
| PRD-ROT-003 | Staleness thresholds vary by knowledge class and, for Decisions, by reversibility. One-way Decisions never become stale. Artifact is stale-capable with its threshold TBD. Glossary Entry and Hypothesis have no automatic staleness. |
| PRD-ROT-004 | A stale object remains active. Staleness never changes status automatically. |
| PRD-ROT-005 | A stale object is marked as stale wherever it appears, including in Context Packs. Except for Observations (PRD-OBS-005), staleness affects display only and never changes which objects a pack contains. |
| PRD-ROT-006 | Stale objects appear in the curation list. |

### 8.13 Context Packs

| ID | Requirement |
|---|---|
| PRD-CTX-001 | A Context Pack is produced for a specified scope, an optional feature filter, a specified intent, and a token budget. |
| PRD-CTX-002 | A Context Pack is a derived output. It is not a knowledge object, cannot be authored, and cannot be approved. |
| PRD-CTX-003 | **Pack contents are determined by graph version; staleness labels may vary by build time.** The selection and ordering of a pack is a pure function of the request and the graph version. Staleness markers are a function of the selection and the build time. A pack records both, and reproduction at the recorded build time is byte-identical. |
| PRD-CTX-004 | No content is generated, summarised, or rewritten while a Context Pack is being produced. All content is pre-existing stored knowledge. |
| PRD-CTX-005 | Section inclusion is determined by the requested intent. |
| PRD-CTX-006 | All active Constraints in scope are included regardless of intent, feature filter, or relevance. |
| PRD-CTX-007 | All blocking Open Questions in scope are included regardless of intent or feature filter. |
| PRD-CTX-008 | Content ordering is deterministic and independent of request timing. |
| PRD-CTX-009 | A Context Pack that exceeds its token budget is truncated deterministically, and the objects that were dropped are reported. Constraints, blocking Open Questions, and explicitly requested Glossary Entries are untruncatable; if they alone exceed budget, the build errors. Diagnostics report those three mandatory sets as a percentage of the requested budget. Term-matched Glossary Entries do not count as mandatory. |
| PRD-CTX-010 | Every object in a Context Pack displays its identifier, its scope, whether it was human-authored or AI-proposed, and any staleness or review marker. |
| PRD-CTX-011 | A Context Pack can be reproduced identically at a later time from its recorded request, graph version, and build time. |
| PRD-CTX-012 | Context Pack selection uses two predicates: the object's version window applicable to the requested graph version and the explicit status predicate of its section. The Recent Superseded Decisions section is the only bounded historical predicate, selecting superseded objects whose closed windows fall within the last 10 graph versions. The day-based arm is excluded so selection remains a pure function of request and graph version. |

### 8.14 Context Pack history and difference

| ID | Requirement |
|---|---|
| PRD-DIF-001 | The user can compare two Context Packs produced for the same scope, feature, and intent at different points in time. |
| PRD-DIF-002 | The comparison reports which knowledge was added, which was removed, and which was superseded between the two. |
| PRD-DIF-003 | The comparison is available without having retained the rendered content of either pack. |
| PRD-DIF-004 | The comparison answers the question "what changed since this context was last assembled" without manual inspection. |

### 8.15 Search and discovery

| ID | Requirement |
|---|---|
| PRD-SRCH-001 | Retrieval precedence is: exact relationships, then structured metadata, then keyword, then semantic similarity. Semantic similarity is out of V1. |
| PRD-SRCH-002 | Retrieval strategy is determined by the system, not by the calling client. |
| PRD-SRCH-003 | The user or an agent can traverse relationships from any known object in both directions. |
| PRD-SRCH-004 | Knowledge can be filtered by scope, feature, class, status, and date. |
| PRD-SRCH-005 | Knowledge can be found by keyword across titles and bodies. |
| PRD-SRCH-006 | Retrieval never returns Candidates, and never returns superseded objects unless superseded objects are explicitly requested. |

---

## 9. Context Pack Product Contract

This section describes the Context Pack from the user's perspective. It prescribes no algorithm and no storage.

**Inputs.** Scope (required), feature label (optional), intent (required), token budget (required).

**Intents.** Implementation, review, debugging, architecture, onboarding, planning. Investigation is treated as debugging (Section 23, PD-1).

**Intended use.** A Context Pack is read at the start of a unit of work by an engineer or an AI assistant, in place of reconstructing project history. It is not a document to maintain, not a summary to read for pleasure, and not a substitute for the source knowledge it references.

**Content.** Depending on intent, a pack may contain: an objective for the scope, all applicable constraints, blocking open questions, matched glossary terms, active decisions, requirements, rejected approaches, non-blocking open questions, unexplained observations, artefact summaries with pointers, external references, and recently superseded decisions.

**Always included.** Applicable constraints and blocking open questions are included in every pack for a scope, without exception, regardless of intent, feature filter, or apparent relevance. This is the reason both are deliberately kept short.

**External References.** The External References section contains only XREFs
reached one hop through `references` or `implemented_by` from Knowledge Objects
retained in the pack, evaluated at the pack's graph version. References from
dropped parent objects are excluded and XREFs are ordered by parent position,
then XREF identifier. An unexplained Observation contributes metadata and its
evidence reference, never its Raw body. `explored` Hypotheses are not pack
content.

**Relevance behaviour.** Relevance is determined by scope applicability, feature label, and intent profile. It is not determined by scoring, ranking, or similarity. Two requests with the same inputs produce the same selection.

**Provenance.** Every included object shows its identifier, scope, authorship (human or AI-proposed), and any staleness or review-required marker. A consumer must be able to tell curated knowledge from accepted proposals, and confirmed knowledge from unverified knowledge.

**Budget.** The token budget is a product constraint, not a technical one. Packs are built to fit a specific consumer's context window. Constraints, blocking Open Questions, and explicitly requested Glossary Entries are untruncatable; if those mandatory objects alone exceed budget, the build errors. Otherwise, truncation is deterministic and the dropped objects are reported, so that the consumer knows the pack is partial and the user knows the budget is too small.

**History and comparison.** Packs are reproducible. Two packs for the same scope, feature, and intent at different times can be compared, and the comparison reports what was added, removed, or superseded. This is the product's answer to "what changed since the agent last knew about this."

---

## 10. Knowledge Curation

**Candidate knowledge.** Structured proposals, produced by an AI assistant from a discussion, or drafted by the user. Candidates are invisible to all retrieval. They are not knowledge.

**Two capture paths.**

*Deliberate authoring* is the primary path. It attaches to the approve step of the user's existing gate cycle. When a decision is made, it is recorded then, structured, with its reasoning intact. This path produces the highest-quality knowledge because it happens at the moment of maximum clarity. If only this path ever works, the product still succeeds.

*Assisted extraction* is secondary. An assistant may propose Candidates from a discussion at any time. These accumulate for triage. They never enter durable knowledge without acceptance. If this path is ever allowed to write directly, trust in the graph collapses and the user stops using the system.

**Triage.** Because V1 has one user who is both author and approver, triage is a list, not a workflow. Four actions: accept, edit and accept, merge into an existing object by supersession, reject. Multi-element Candidates are handled element by element.

**Promotion.** Raw Knowledge becomes Reviewed Knowledge through curation. An Observation is promoted to an Open Question or a Hypothesis, or absorbed into a Decision's rationale. A Discussion is marked distilled when knowledge derives from it.

**Approval.** Acceptance is the single approval action. It sets the approval time, sets verification time, and makes the object retrievable.

**Rejection.** A rejected Candidate is discarded. Its originating Discussion is retained, so the rejection does not destroy the evidence.

**Correction.** Approved knowledge is never edited. A correction is a new object that supersedes the old one. This means the history of being wrong is preserved, which is usually the more valuable record.

---

## 11. Scope and Feature Filtering

**The hierarchy.** Global, then Project, then Workstream, then Phase. Fixed depth, single parent, deterministic resolution in at most four steps.

**Feature is not a scope level.** In real projects one feature spans several phases and one phase contains several features. Making Feature a scope level would force a false single parent or turn resolution into a graph traversal, which would make Context Pack assembly non-deterministic.

**User-facing consequences.**

1. When recording knowledge, the user answers two independent questions: *at what level is this true* (scope) and *what is this about* (features). Conflating them is the most common modelling error and the model prevents it.
2. Requesting context for a phase automatically includes everything applicable from the workstream, project, and global levels. The user does not assemble this.
3. A feature filter narrows what is returned but never removes an applicable constraint or blocking question. Narrowing the request cannot narrow the rules.
4. A user can ask for context about a feature across a whole project by requesting at project scope with the feature filter.
5. Knowledge discovered during a phase but true at project level should be recorded at project level. Recording it at phase level makes it invisible to sibling phases. This is a curation judgement the system cannot make.

---

## 12. Change Impact

This is a named product capability, not a side effect.

**The question.** A requirement changed. Which decisions were made on the basis of it, and are they still valid?

**Why it matters.** Decision records answer "why is it like this." They do not answer "what breaks if the premise changes." The second question is the one asked during requirement churn, which is the normal condition of a live project.

**Behaviour.** When a Requirement is superseded or withdrawn, the system identifies every active Decision that derives from it, directly or transitively through other Decisions, and marks each as requiring review. The Decisions remain active. The system makes no judgement about whether they are still correct; it only guarantees that none of them is silently left resting on a premise that no longer holds.

The user then confirms, supersedes, or reverts each. The marker persists and is visible in Context Packs until resolved.

**Reverse direction.** The same traversal answers the inverse question from a Decision: what requirement is this resting on, and does that requirement still hold?

---

## 13. Trust and Provenance

The graph is only useful if it is believed. Three things must be visible on every object:

**Who wrote it.** Human-authored knowledge and accepted AI proposals carry different weight. The difference is invisible within a month if it is not recorded. A user reviewing a surprising decision needs to know whether they wrote it deliberately or clicked accept on a proposal.

**When it was approved and last verified.** Approval time shows when it entered the graph. Verification time shows whether anyone has confirmed it since. A constraint approved eight months ago and never revisited is a different object from one confirmed last week, and both look the same without this.

**What it rests on.** Evidence links and origin links. A decision with no traceable origin is folklore, which is why the model rejects it.

Provenance travels with the object into every Context Pack. An agent that cannot distinguish confirmed knowledge from unverified knowledge will treat both as authoritative.

---

## 14. Success Metrics

No numeric targets are set where the source documents provide none. Baselines are established during the validation phase.

### 14.1 Decisions recorded per phase

**Measures.** Whether durable capture is happening during real work.

**How measured.** Count of approved Decisions with an approval time within the phase, at or below the phase scope.

**V1 success.** A non-zero, non-declining count across the validation phase. A sharp decline mid-phase indicates friction in the write path and is the most important early warning signal the product has.

**Target.** TBD during baseline.

### 14.2 Context Pack coverage

**Measures.** Whether the system is actually in the loop, rather than built and bypassed.

**How measured.** Proportion of agent or engineering sessions during the validation phase that began by requesting a Context Pack, against total sessions on that project.

**Session definition.** A session is **one agent or client work session**: it starts when a user or agent begins a distinct work interaction against the project and ends when that interaction is explicitly closed or times out.

The definition is deliberately client-agnostic. It is not "one Claude Code conversation", because the product must measure the same thing across Codex, Cursor, and any future client, and each has a different conversation model. Every client call carries a session identifier; the engine does not infer session boundaries from its own traffic.

The exact timeout window is **TBD during instrumentation**, since a sensible value depends on observed interaction patterns that do not exist yet.

**V1 success.** The majority of sessions in the second half of the validation phase begin from a pack. Low coverage means either the packs are not useful or requesting one is harder than not bothering; both are product failures, not user failures.

**Target.** TBD during baseline.

### 14.3 Re-litigation count

**Measures.** The core product thesis. If this does not fall, nothing else matters.

**How measured.** Count of occurrences during the validation phase where a superseded Decision or rejected Hypothesis is proposed again by an agent or the user. Recorded manually by the curator when observed; there is no automatic detection in V1.

**V1 success.** Observed re-litigation in sessions that began from a Context Pack is lower than in sessions that did not. Because V1 is single-user and the sample is small, this is a directional signal rather than a statistical result, and the PRD should not pretend otherwise.

**Target.** TBD during baseline.

### 14.4 Supporting metrics

| Metric | How measured | V1 success |
|---|---|---|
| Stale ratio | Active objects past their staleness threshold, as a share of active objects | Stable or falling by end of validation phase |
| Candidate accept rate | Accepted Candidates as a share of proposed Candidates | If persistently low, assisted extraction is producing noise and should be narrowed or disabled. Threshold TBD during baseline. |
| Backfill representability | Share of selected MIRA knowledge expressible without new entities or new relation types | High. Failures here are the most valuable output of validation. |

---

## 15. V1 Scope

**In scope.**

- The full knowledge model as defined in the Domain Specification: all entities, the closed relation vocabulary, relation legality, and invariants.
- Scope hierarchy to Phase; Feature as a cross-cutting label.
- Deliberate authoring and assisted extraction into Candidates.
- Triage and curation.
- Discussion resolution producing structured Candidates.
- Context Pack generation for all defined intents, with budget and deterministic truncation.
- Context Pack comparison.
- Requirement change impact analysis.
- Knowledge rot marking and surfacing.
- Provenance on all objects.
- Retrieval by relationship, metadata, and keyword.
- Backfill of selected MIRA knowledge.
- One real project phase of use.

**Out of scope for V1.**

- Any user interface beyond an optional read-only view. No UI is required for validation.
- Semantic and vector retrieval.
- Multi-user support, authentication, roles, permissions, delegation, notifications.
- Automatic contradiction detection.
- Automatic re-litigation detection.
- Automatic verification of external references.
- A second consuming client. Client neutrality is a property of a clean access surface, and it is untested until a second client exists; V1 does not build for it beyond not preventing it.
- Any project other than MIRA.

---

## 16. V1 Validation Plan

The validation is a test of the domain model, not a demonstration of the software.

**Step 1 — Select a bounded set of real MIRA knowledge.** Choose a set large enough to be representative and small enough to complete by hand: existing architectural decisions, at least one superseded decision, at least one failed approach, the standing constraints, the project's vocabulary, and the currently open questions.

**Step 2 — Backfill by hand.** Express each item in the model. Record every case where the model does not fit: knowledge that has no home, knowledge that needs two scopes, relationships the vocabulary cannot express, decisions with no recoverable origin.

**Step 3 — Use the system through one real phase.** Deliberate authoring at the approve step. Discussion resolution when questions settle. No parallel note-taking system running alongside, because a fallback guarantees the fallback wins.

**Step 3a — Record curation friction.** Throughout Steps 2 and 3, record where curation was harder than it should have been: spec consultation required to learn required attributes, workflow steps that could not be completed without manual recovery, actions abandoned midway, and any occasion where curation was skipped because it was tedious rather than because nothing needed recording. Friction is assessed by curator judgement and recorded as qualitative events in the backfill friction log — not as machine-timed durations, which would measure file-write latency rather than the judgement cost that actually threatens continued curation.

**Curation friction is a validation criterion, not an observation.** The product's central risk is that the curator quietly stops (Section 17). If the backfill and phase show that triage without a UI is painful enough to threaten continued curation, the smallest UI that removes the friction is built before validation concludes. This is not a commitment to a UI. It is a commitment to measure the thing that would make one necessary, rather than discovering it after the habit has already lapsed.

**Step 4 — Generate Context Packs during actual work.** For implementation, debugging, and review. Note every occasion where a pack was missing something needed, contained something useless, or was not worth requesting.

**Step 5 — Measure.** Decisions per phase, pack coverage, observed re-litigation, plus the supporting metrics. Establish the baselines the PRD deliberately leaves open.

**Step 6 — Identify model failures.** Consolidate the misfits from Steps 2 and 4 into a list of proposed domain changes.

**Step 7 — Revise the Domain Specification.** If real knowledge cannot be represented cleanly, the model is wrong. Elegance is not evidence. A model that survives validation unchanged should be treated with suspicion rather than satisfaction, because it more likely means the backfill was too easy.

**Exit criteria.** Validation is complete when one phase has run end to end, all three primary metrics have baselines, the Backfill Domain Gap register is closed with a promote-or-discard decision on each deferred candidate concept, and curation friction has been assessed against Step 3a.

---

## 17. Risks

| Risk | Why it happens | Mitigation in the product |
|---|---|---|
| Capture becomes documentation overhead | Recording knowledge is a separate activity from doing the work | Capture attaches to the existing approve step (P-9). If the user must set aside time to curate, the design has failed. |
| Too much low-value knowledge | Assisted extraction has high recall and low precision | Candidates are invisible until accepted; accept rate is monitored; extraction can be narrowed or disabled. |
| Stale knowledge becomes trusted | Nothing expires in an append-only model | Verification time, staleness thresholds, stale markers in packs, stale objects in the curation list. |
| Agents ignore Context Packs | Requesting one is harder than proceeding without | Pack coverage is a primary metric. Persistently low coverage is a product defect. |
| The user stops curating | Effort is paid now, benefit arrives months later | Deliberate authoring at the decision point is the cheapest possible moment; decisions-per-phase is monitored as an early warning. |
| Duplicate knowledge develops | The same conclusion recorded twice at different scopes or from different discussions | Merge is a first-class triage action; the closed relation vocabulary and scope assignment rules reduce accidental divergence. Not fully solved in V1. |
| External references go stale | File paths and identifiers move | References carry verification time and are displayed as unverified past threshold; module or symbol identity is preferred over paths. Not fully solved in V1. |
| Context Packs grow too large | Knowledge accumulates faster than it is superseded | Hard token budget, deterministic truncation, dropped-object reporting, and length caps on always-injected content. |
| The domain model becomes too complicated | Every real case suggests a new entity or relation | The relation vocabulary is closed. New entities require an explicit domain gap. Backfill is the test of whether the current model is already too big or too small. |
| The product becomes a second parallel product | Vision expanded from a tool to a platform across the design conversation | V1 scope is deliberately narrow: one project, one user, no UI, no semantic retrieval, no second client. |

---

## 18. Open Questions

Only genuinely unresolved product questions. Questions already answered by the Domain Specification are excluded.

| ID | Question | Why it matters | Needed by |
|---|---|---|---|
| ~~OQ-P1~~ | ~~Free-form or controlled feature labels?~~ **Answered:** controlled, Project-scoped canonical registry with aliases, a candidate workflow at the proposal boundary, and merge by versioned redirect. | closed |
| OQ-P2 | Which specific slice of MIRA knowledge forms the backfill set, and how large? | Too small and it does not test the model; too large and it does not get done. **Now the last item blocking the backfill.** | Before backfill |
| OQ-P3 | Are the staleness thresholds in the Domain Specification correct? | They are placeholders with no empirical basis. | After baseline |
| ~~OQ-P4~~ | ~~How is a session counted?~~ **Answered:** one agent or client work session, client-agnostic, bounded by explicit close or timeout. Timeout window TBD during instrumentation. | closed |
| ~~OQ-P5~~ | ~~Is a read-only view needed during validation?~~ **Answered as a criterion rather than a decision:** no UI before validation, but curation friction is measured (Step 3a) and the minimum necessary UI is built if the measurement demands it. | closed |
| ~~OQ-P6~~ | ~~Does verifying a Decision confirm its derived Constraints?~~ **Answered:** no cascade. Each Constraint carries its own verification state; derived Constraints are surfaced as "also review". | closed |
| ~~OQ-P7~~ | ~~Should risks be first-class knowledge?~~ **Answered:** deferred as a candidate concept pending evidence (Domain Spec 18.1). | closed |
| OQ-P8 | Do Risk and Assumption meet the promotion threshold after backfill? | Determines whether the model grows from ten entities to twelve. | After backfill |
| OQ-P9 | What staleness threshold suits Artifact? | Artifact is now stale-capable with no threshold set. | After baseline |

---

## 19. Future Direction

Not V1 requirements. Recorded so that V1 does not accidentally foreclose them.

**Team and multi-user.** Distributed authorship, delegated curation, reviewer assignment, notification, and conflict resolution. This changes provenance and approval materially, and is the largest single expansion available.

**Additional clients.** The knowledge is client-agnostic by construction. A second consuming client is what actually proves this; until one exists the claim is untested.

**Automatic contradiction detection.** Currently declared by the user. Detection would reduce the cost of maintaining a large graph.

**Automatic re-litigation detection.** The primary success metric is measured manually in V1. Automatic detection would make it a live signal rather than an observation.

**Semantic retrieval.** Deferred until relationship, metadata, and keyword retrieval demonstrably fail.

**Additional projects.** The model is general by design; MIRA is the first validation environment, not the target.

**Human-facing knowledge surfaces.** Onboarding views, backlink browsing, and architecture overviews are natural once the graph has content worth reading.

---

## 20. Quality Check

Every capability in this document answers five questions. The table records where.

| Capability | Who | Problem | User does | System does | Proof |
|---|---|---|---|---|---|
| Requirement capture | §3.1 | §2.1 | Journey A | §8.2 | §7A |
| Discussion resolution | §3.1, §3.2 | §2.1 | Journey B | §8.11 | §7B |
| Decision recording | §3.1 | §2.1 | Journey C | §8.3 | §7C |
| Negative knowledge | §3.2 | §2.1 | Journey D | §8.8 | §7D |
| Change impact | §3.1 | §12 | Journey E | §8.2 | §7E |
| Context Packs | §3.2 | §2.1 | Journey F, G | §8.13, §9 | §7F |
| Rot management | §3.1 | §17 | Journey H | §8.12 | §7H |
| Constraints | §3.2 | §2.1 | §10 | §8.6 | §9 |
| Glossary | §3.2 | §2.1 | §10 | §8.7 | §9 |
| Open questions | §3.1 | §2.1 | §10 | §8.5 | §9 |
| Provenance | §3.1 | §13 | §10 | §8.11 | §13 |
| Pack comparison | §3.1, §3.2 | §2.1 | §9 | §8.14 | §9 |

---

## 21. Domain Decisions Consumed

Domain Specification rules that materially shaped this PRD:

1. **Three knowledge classes** (Raw, Reviewed, Operational) determine review rules and injection behaviour. This produced the distinction between always-injected content and retrieved content throughout Sections 8 and 9.
2. **Context Pack is not a knowledge object.** It asserts nothing, cannot be authored or approved. This is why Section 9 is a contract and not an entity definition.
3. **Scope stops at Phase; Feature is a label.** Drives Section 11 entirely, and the determinism guarantee in Section 9.
4. **Operational Knowledge is exempt from feature filtering.** Produced PRD-SCP-006 and PRD-CTX-006.
5. **Glossary is term-matched, not unconditionally injected.** The single documented exception to Operational Knowledge injection; produced PRD-GLO-003.
6. **Blocking Open Questions are injected like Constraints** despite being Reviewed Knowledge; produced PRD-OQ-003 and PRD-CTX-007.
7. **Append-only with supersession**, never edit, never delete. Produced PRD-KN-004 through PRD-KN-006 and the correction model in Section 10.
8. **Decisions carry reversibility, not confidence.** Produced PRD-DEC-005 and PRD-DEC-006.
9. **A Decision must have at least one origin.** Produced PRD-DEC-002 and the "folklore" argument in Section 13.
10. **Requirement supersession flags derived Decisions for review without changing their status.** Produced Section 12 and PRD-REQ-004 and PRD-REQ-005.
11. **Observation requires evidence and a review date, and has a death condition.** Produced PRD-OBS-002 through PRD-OBS-007.
12. **Hypothesis means actually tried; rejected alternatives live inside Decisions.** Produced PRD-HYP-002 and the boundary note in Journey D.
13. **Closed relation vocabulary with legality rules.** Produced PRD-KN-007 and PRD-KN-008.
14. **No generation at Context Pack build time**, which is why Artifact summaries are stored at approval. Produced PRD-CTX-004 and PRD-ART-004.
15. **Store the recipe, not the rendering.** Produced PRD-CTX-011 and PRD-DIF-003.
16. **Candidates are invisible to retrieval.** Produced PRD-CUR-002 and PRD-SRCH-006.
17. **Retrieval policy is server-side, not delegated to the client.** Produced PRD-SRCH-002.
18. **Retrieval precedence** (relations, metadata, keyword, semantic). Produced PRD-SRCH-001 and the V1 exclusion of semantic retrieval.
19. **Staleness never changes status automatically.** Produced PRD-ROT-004 and PRD-ROT-005.
20. **Single-user V1**: two provenance values, no approver field, triage as a list. Produced Section 10 and the Non-Goals.
21. **The engine stores pointers, never mirrors.** Produced PRD-ART-002 and PRD-XREF-002 and Principle P-2.
22. **Character caps on Operational Knowledge.** Constraint bodies are capped because they are injected unconditionally; Glossary definitions are capped because matched entries still occupy pack budget. Produced PRD-CON-003 and PRD-GLO-002.

---

## 22. Domain Gaps and Conflicts

No blocking contradiction was found between the Vision and the Domain Specification. The following are gaps or ambiguities. None was silently resolved.

**DG-1 — "Known risks" has no entity. Resolved as deferred.** Risk is recorded as a deferred candidate concept (Domain Spec 18.1), not introduced as an entity. The Vision has been updated so it no longer claims pack contents that do not exist. Promotion requires evidence under Domain Spec 17.1. Original analysis follows.

*Original:* The Vision lists "known risks" among Context Pack contents. No Risk entity exists in the Domain Specification, and the intent profiles contain no risk section. A risk is arguably an Open Question with `blocking = false`, or an unexplained Observation, but neither is a clean fit: a risk is a *predicted* problem, whereas an Observation is an *observed* one and an Open Question is an *unanswered* one. This PRD does not introduce a Risk entity. Recorded as OQ-P7.

**DG-2 — Vision entity list predates the model. Resolved.** Vision v2.0 supersedes v1.0 and is reconciled against the Domain Specification. Original analysis follows.

*Original:* The Vision's domain model omits Requirement and Observation and lists relation verbs (`documents`, `verifies`) that the Domain Specification removed as overlapping. This is document drift from the design conversation, not a contradiction. The Vision should be superseded to match, following the system's own rules.

**DG-3 — "Investigation" is not a defined intent. Resolved** by PD-1 (alias for `debug`). Original analysis follows.

*Original:* The product brief lists investigation among intents. The Domain Specification defines `debug`. Treated as the same intent. See PD-1.

**DG-4 — Disproven assumptions have no home. Resolved as deferred.** Assumption is recorded as a deferred candidate concept (Domain Spec 18.2), not introduced as an entity. The query that would justify it (*"assumption A was disproven; which active Decisions rest on it?"*) is the same shape as requirement change impact, so the case is strong if real instances exist. Promotion requires evidence under Domain Spec 17.1. Original analysis follows.

*Original:* The Vision includes "disproven assumption" as a Hypothesis, but the Domain Specification requires that a Hypothesis was actually tried. An assumption can be disproven by evidence without anyone building anything. Such an item currently has no clean home: it is not a Hypothesis under the strict reading, and it is not an Observation once explained. Not resolved here.

**DG-5 — Scope assignment has no tie-breaker.** The rule is "assign at the level where the object is true," but the Domain Specification gives no guidance for knowledge that is true at one scope and consequential at a sibling. Currently a pure curation judgement. Likely to surface during backfill.

**DG-6 — Graph state granularity is undefined.** The Domain Specification's own OQ-4 leaves open whether graph state advances per approved write or per batch. This affects Context Pack reproducibility granularity and pack comparison behaviour, both of which are user-facing (PRD-CTX-011, PRD-DIF-001). It must be answered before the Master Technical Specification.

**DG-7 — No defined consumer behaviour for stale content.** The system marks staleness, but nothing specifies what a consumer should do with a stale object. In V1 this is left to the consumer, which is acceptable for one user and one client and will not be acceptable later.

**DG-8 — Discussion content storage boundary.** The Domain Specification stores a reference to discussion content "where large" without defining the threshold or the storage boundary. Its own OQ-2 defers this to backfill. Noted because it affects what a Discussion reference can be relied on to return.

---

## 23. Proposed Product Decisions

Product-level decisions this PRD had to make that were not explicit in the source documents. Each is reversible and none extends the domain model.

**PD-1 — Investigation maps to the debugging intent.** No new intent is introduced. Rationale: the Domain Specification's `debug` profile already returns what investigation needs (prior attempts, unexplained observations, superseded decisions, open questions). Alternative considered: adding an `investigation` intent, rejected because the profiles would be identical and duplicate intents invite divergence. Reversible.

**PD-2 — No numeric targets are set for the three primary metrics.** All are marked TBD during baseline, per the brief. The Domain Specification's suggested candidate-accept threshold is carried as a supporting metric with its threshold also marked TBD, because that figure was flagged as invented when it was written.

**PD-3 — Re-litigation is measured manually in V1.** Automatic detection is out of scope. Consequence: the primary metric is a curator observation, not an instrument reading, and the PRD states this openly rather than implying rigour that does not exist.

**PD-4 — Pack coverage is compared between halves of the validation phase**, rather than against a pre-existing baseline, because no baseline exists before the system does.

**PD-5 — No UI is required before validation**, with curation friction promoted to a validation criterion (Step 3a) rather than left as an open question. Rationale: building a UI before the model is validated risks encoding a wrong model into screens. But the risk that triage is impractical without one is real and is now measured during validation, with a commitment to build the minimum necessary UI if the measurement demands it.

**PD-6 — Merge is a first-class triage action.** The Domain Specification lists it among triage actions but does not define it as duplicate management. This PRD assigns it that role (Section 17, duplicate knowledge risk). It introduces no new mechanism: merge is supersession.

**PD-7 — Backfill representability is a tracked metric.** Not present in the source documents. Rationale: G-7 states the model may be wrong, and a goal that can fail needs a measure. Directly supports Validation Step 6.

**PD-8 — The Vision document should be superseded after this PRD is accepted**, to remove DG-2 drift. Recorded as a product decision because leaving two documents disagreeing about the entity list is exactly the failure this product exists to prevent, and the project should follow its own rules.

**PD-9 — Pack selection uses version and status predicates.** Replacing the
overloaded word “active” with a validity-window predicate alone is
insufficient. Each section has an explicit status predicate, with a single
bounded historical predicate for recently superseded Decisions. This keeps
negative knowledge and recent reversals visible without making terminal
statuses generally pack-visible.

**PD-10 — Raw Observation bodies remain reference-only.** Debug and planning
packs expose unexplained Observation metadata and evidence references, not Raw
body text. Those Observations ignore feature filters because untriaged evidence
is the intended diagnostic content.

**PD-11 — `requires` has no Context Pack effect in V1.** It remains available
to graph traversal (`graph.expand`) but is not walked by pack assembly.

**PD-12 — External References follow retained parents.** XREFs are selected
one hop through `references` and `implemented_by` from retained Knowledge
Objects, evaluated at the pack version and ordered by parent position then id.

**PD-13 — Blocking Open Questions are capped at 280 characters.** Non-blocking
questions remain uncapped. Explored Hypotheses are excluded from packs and
surface for curation after 30 days. Explicitly requested Glossary Entries are
mandatory for both budget and diagnostics; term-matched entries are optional.
