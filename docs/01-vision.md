# Project Knowledge Engine — Vision

**Version:** 2.1
**Supersedes:** Vision v2.0; originally supersedes Vision v1.0 (Working Title draft)
**Status:** Reconciled against Domain Specification v1.2
**Derivation authority:** 01 Vision → 02 Domain Specification → 03 PRD → 04 Master Tech Spec → 05 Technology Spec. Each document implements the one above and may not redefine it.
**Vocabulary authority (domain concepts):** 02 Domain Specification. Entity names, knowledge classes, relation verbs, legal triples, lifecycles, and invariants are defined there. This document is prose; where its prose contradicts the Domain Spec on a domain concept, this document is the defect.

---

## 0. Why This Document Was Superseded

Vision v1.0 was written before the domain model settled. It has since drifted from the Domain Specification in three ways:

- Its entity list omitted **Requirement** and **Observation**, both of which are now first-class.
- It listed relation verbs (`documents`, `verifies`) that were removed as overlapping.
- It named **"known risks"** among Context Pack contents when no Risk entity existed, and named "disproven assumption" as a Hypothesis when Hypothesis requires evidence of an attempt.

Leaving two documents disagreeing about the entity vocabulary is precisely the failure this product exists to prevent, so the project follows its own rules.

Two authority axes apply throughout this set. They are not in conflict once separated.

**Derivation authority.** 01 Vision → 02 Domain Specification → 03 PRD → 04 Master Tech Spec → 05 Technology Spec. Each document implements the one above and may not redefine it. Lower documents do not reopen product intent, and technology choices do not reopen the domain.

**Vocabulary authority for domain concepts.** The Domain Specification (02) defines entity names, knowledge classes, relation verbs, legal triples, lifecycles, and invariants. This Vision is prose and drifts. Where Vision prose contradicts the Domain Spec on a domain concept, the Vision is the defect.

Consequence: a loose Vision summary does not override a reasoned Domain Spec rule. Constraints inject unconditionally within scope; Glossary Entries are term-matched (Domain Spec 4.8). That exception is budget-load-bearing. Section 6 below states it rather than collapsing both Operational members into "always applicable."

The two concepts that motivated the v1.0 drift, Risk and Assumption, have not been discarded. They are recorded as deferred candidate concepts in Domain Specification Section 18, pending evidence from real use.

---

## 1. What This Is

A vendor-neutral engineering knowledge system that preserves project understanding across long-lived software projects.

It is not a chat history, a note-taking application, a project management tool, or a code repository. Its purpose is to distil engineering discussion into durable project knowledge, so that both humans and AI assistants can understand why a system exists, how it evolved, what constrains it, and what context is required before changing it.

The system stays independent of any specific AI model, IDE, or workflow. Any client able to query it receives the same project understanding.

---

## 2. The Problem

As a project matures, knowledge fragments across chat, pull requests, design documents, requirement documents, code reviews, issue trackers, meeting notes, and individual memory.

Implementation artefacts survive. The reasoning behind them disappears.

The result is repetitive and specific:

- The same discussions happen twice.
- Previously rejected ideas are proposed again.
- Architectural decisions lose their rationale and are undone by people who did not know why they existed.
- Teams become dependent on tribal knowledge.
- AI assistants lose important project context and are re-briefed every session.
- Long conversations consume context windows without producing anything durable.

The underlying problem is **knowledge entropy**, not memory.

### 2.1 Why this is not "AI memory"

Existing AI memory systems answer *"what should this assistant remember about me?"* They extract facts from conversation, embed them, and retrieve by similarity. That is a reasonable answer to a personalisation problem and the wrong shape for this one.

- **Authority is not similarity.** Whether a decision is still binding is a question of status and supersession. Similarity search cannot answer it and should never be asked to.
- **Conversation is the wrong unit.** Six weeks later nobody needs the exchange, only the conclusion. Storing the exchange and hoping to re-derive the conclusion is strictly worse than storing the conclusion with a pointer to the exchange.
- **The knowledge outlives the assistant.** Tie the value to one model's memory format and it evaporates when the tooling changes.

The closest honest prior art is Architecture Decision Records, extended with a scope model, a typed relationship graph, traceability to requirements, and a programmatic access surface.

---

## 3. Goals

The system becomes the canonical source of project knowledge by:

- preserving engineering intent rather than conversation
- capturing decisions together with their rationale and rejected alternatives
- recording constraints that govern future development
- tracking what remains unresolved
- building a shared project vocabulary
- preserving approaches that were tried and failed
- referencing external systems rather than duplicating them
- producing deterministic project context for humans and AI assistants
- answering what changed since a given point, and what a change to a requirement puts at risk

---

## 4. Non-Goals

The system does not replace Git, issue trackers, documentation platforms, design tools, chat applications, or code search. It is not a personal memory system, and it is not a vector database with project metadata attached.

It complements those systems by preserving the reasoning that connects them.

---

## 5. Principles

**Knowledge over conversation.** Conversations are evidence with retention limits. Knowledge is durable.

**Store why, reference what.** The engine owns reasoning, intent, decisions, constraints, and relationships. External systems remain authoritative for code, tasks, pull requests, commits, designs, and documents. The engine stores references, never mirrors.

**Distillation over archival.** Capture is deliberate and structured, not passive and complete.

**Trust over volume.** AI may propose. A human decides what becomes durable. A smaller trusted graph beats a larger uncertain one.

**Certainty over similarity.** Retrieval prefers exact relationships, then structured metadata, then keyword. Semantic matching is a last resort.

**Append-only.** Approved knowledge is never edited or deleted. Correction happens by supersession, which preserves the record of having been wrong.

**Determinism.** The same request against the same graph state selects the same knowledge.

**Provenance is mandatory.** Every object records how it came to exist. Without it, the graph becomes folklore.

**The model earns its entities.** New concepts are added on evidence from real use, never on theoretical completeness. See Domain Specification Section 17.

---

## 6. The Shape of the Thing

Knowledge belongs to projects, organised in a fixed scope tree of **Global → Project → Workstream → Phase**, with **Feature** as a cross-cutting canonical label rather than a scope level.

Knowledge objects fall into three classes:

| Class | Members | Behaviour |
|---|---|---|
| **Raw** | Discussion, Observation | Evidence. No approval required. Retention limits apply. Never injected as body text |
| **Reviewed** | Requirement, Decision, Open Question, Hypothesis, Artifact | Approved assertions. Append-only. The substance of the graph |
| **Operational** | Constraint, Glossary Entry | Rules and vocabulary. Constraints inject unconditionally within scope. Glossary Entries are term-matched (Domain Spec 4.8) |

**External Reference** is not a knowledge object. It asserts nothing and has no lifecycle; it is a typed pointer into a system that owns its own truth.

**Context Pack** is not a knowledge object either. It is a derived output: a deterministic, reproducible selection of knowledge assembled for one task at one scope with one intent. It is what an engineer or an AI assistant reads before starting work, instead of reconstructing project history.

Objects relate through a small, frozen vocabulary of typed relations. The vocabulary is closed deliberately: free-text relation names drift into synonyms within months and make traversal unreliable.

---

## 7. What Good Looks Like

- Engineers spend less time rediscovering historical context.
- AI assistants require fewer repeated explanations.
- Decisions remain understandable months later.
- Architectural reasoning survives team changes.
- Rejected ideas are not reintroduced.
- A change to a requirement surfaces the decisions it puts at risk, without a manual search.
- Context is generated consistently regardless of which assistant or environment is used.

The system should be able to answer: why does this exist, why was this decided, what constrains it, what does this term mean, what was already tried, what remains unresolved, which document defines this behaviour, and what should I know before changing it.

---

## 8. Long-Term Direction

The Project Knowledge Engine becomes the persistent memory of a software project. It does not replace existing tools; it connects them through durable knowledge, so humans and AI assistants work from the same shared understanding regardless of tool, model, or workflow.

Because the primary entities are requirements, decisions, artefacts, constraints, and relationships rather than conversations, the system is naturally model-agnostic. Claude Code, Codex, Cursor, and future clients do not need a shared proprietary memory format; they need a stable API. **The memory layer is the persistent asset. The agent is replaceable.**

Beyond V1: team and multi-user support, additional consuming clients, automatic contradiction detection, semantic retrieval where relationship and keyword retrieval demonstrably fall short, and human-facing knowledge surfaces for onboarding and architecture review.

Over time, every significant project accumulates a living knowledge graph capturing not only what the software is, but why it became that way.
