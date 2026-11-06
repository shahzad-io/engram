# Project Knowledge Engine — constraints for implementers

This file exists so a session that has not read `docs/` cannot accidentally break a property the product sells.

Two authority axes, not one:

- **Derivation:** 01 Vision → 02 Domain Spec → 03 PRD → 04 Master Tech Spec → 05 Technology Spec. Each document implements the one above and may not redefine it.
- **Vocabulary (domain concepts):** 02 Domain Spec. Entity names, knowledge classes, relation verbs, legal triples, lifecycles, and invariants are defined there. The Vision is prose; where Vision prose contradicts the Domain Spec on a domain concept, the Vision is the defect.

Open pack-assembly defects are registered in `docs/00-open-amendments.md`. Do not "fix" A1–A10 in passing.

The engine preserves durable engineering knowledge (requirements, decisions and rationale, constraints, glossary, open questions, failed approaches) and produces deterministic Context Packs. It is not a chat archive, note app, issue tracker, Git, documentation store, personal AI memory, or a vector database with project metadata attached.

V1 is single-user, one curator, one validation project. Do not shape V1 for multi-user, roles, auth, notifications, or concurrent-edit resolution beyond what costs nothing.

---

## Graph trust

1. **Approved knowledge is append-only.** Never UPDATE the content of an approved object. Never DELETE an approved object. Correction is a new object that supersedes the old one, in the same transaction. The record of having been wrong is the product. An in-place edit makes historical Context Packs unreproducible and turns the graph into folklore.

2. **Nothing durable is written without explicit human acceptance.** AI clients may create Raw evidence (Discussion, Observation) and may propose Candidates. They must not create, approve, supersede, verify, or otherwise write Reviewed or Operational knowledge, and they must not write relations between approved objects. Auto-accepting “high-confidence” extraction is the failure mode that ends curator trust within a month.

3. **Candidates are not knowledge.** They are invisible to every retrieval path and never appear in a Context Pack. Store them so that omitting a filter cannot accidentally return them. A Candidate edited before accept is human-authored; accepted unchanged stays AI-authored. That distinction is immutable after approval and must travel into every pack.

4. **A Decision with no origin is rejected.** At approval it MUST have at least one `derives_from` edge (Requirement, Discussion, Observation, Open Question, or Decision). Do not relax this for backfill convenience. Unsourced decisions are folklore, which is the thing the system exists to prevent.

5. **Do not force misfits into the nearest entity.** If a real item has no honest home, record it in the Backfill Domain Gap register and leave it out of the graph. Quietly-wrong knowledge is worse than a visible gap. Do not add entities (including Risk and Assumption) because they feel missing; they promote only under the Domain Spec evidence rule.

## What the engine owns

6. **Store why, reference what.** The engine owns reasoning, intent, decisions, constraints, relations, and summaries written at approval. Git, the tracker, docs, and design tools remain authoritative for their content. Do not store commit messages, diffs, task titles, task status, or document bodies “just for display”. A stale cached title looks authoritative and is worse than no title. An External Reference is a typed pointer, not a Knowledge Object.

7. **The engine never calls a model.** No model-vendor SDK in the dependency manifest, no API key, no generation at read time. `discussion.resolve` receives a structured proposal the calling agent already produced; the server validates and persists a Candidate. Pack assembly is pure selection over stored data: no summarisation, no rewriting, no ranking by model. Artifact summaries are authored at approval and never regenerated.

8. **MCP is not the write path.** Agent-facing handlers must not import approval, supersession, verification, or other durable-write use cases. V1 has no authentication; that import boundary is the security model. A prompt-injected agent may create noise Candidates and Raw objects. It must not be able to corrupt the graph.

## Context Packs and retrieval

9. **Pack assembly is a pure function of `(request, graph_version)`.** No I/O, no network, no model, no fetching of external references during build. The same request against the same graph version selects and orders the same objects. Staleness markers may vary with `built_at`; selection must not. Store the recipe (ids, version, hash), never the rendered body. A hash mismatch on reproduce is a loud failure, not a plausible-but-different pack.

10. **Always-inject cannot be filtered, ranked, or silently dropped.** Every active Constraint in the scope chain enters every pack, regardless of intent, feature label, or relevance. Every blocking Open Question in scope does the same. Feature filters apply to Reviewed Knowledge only, and must not remove those two sets. If mandatory content exceeds the token budget, error (`PACK_BUDGET_INSUFFICIENT`); do not drop Constraints to make the pack fit. A silently partial pack lies about what the project knows.

11. **Truncation is deterministic and reported.** Fixed section order, then narrower scope first, then `id`. Drop from the tail. Always report dropped ids. Token cost is a vendor-independent estimator (characters ÷ 4 plus fixed overhead), not a model tokenizer. Tying cost to a vendor library version makes determinism depend on that vendor.

12. **Retrieval precedence is server-side and fixed:** exact relations, then structured metadata, then keyword. Semantic / vector / embeddings are out of V1 and are a last resort even later. Clients must not pass a retrieval-strategy parameter. Binding is a question of status and supersession, not cosine distance. Do not “just add RAG”.

13. **Raw Discussion body is never pack content.** Discussions appear only as evidence references under objects that derive from them. Do not inject transcript excerpts “for context”. That recreates the chat archive this product is not.

## Scope, labels, relations

14. **Scope is a fixed four-level tree: Global → Project → Workstream → Phase.** Single parent. Feature is a cross-cutting label, never a fifth scope level. Assign an object where it is *true*, not where it was discovered. Scope is immutable after approval; a misfile is corrected by supersession. Mutable scope silently changes what every historical pack meant.

15. **Feature labels are canonical identities owned by a Project registry, not free-text tags.** Unrecognised strings become label candidates; they never enter the graph. Aliases resolve at write. Redirects (merges) resolve at read as of the requested graph version. A merge is a registry redirect and touches zero knowledge objects. Rewriting labels on objects violates append-only and breaks pack hashes at old versions.

16. **The relation vocabulary is a closed enum of eight verbs.** Illegal triples are rejected. Do not add `relates_to`, `affects`, `documents`, `verifies`, or any convenience synonym. Free-text relations make traversal unreliable within months. `derives_from`, `supersedes`, and `requires` are acyclic.

## Distinctions that look skippable

17. **A Hypothesis is something actually tried, with evidence.** An alternative rejected during deliberation lives inside the Decision that rejected it. If it was not built, run, or tested, it is not a Hypothesis. Collapsing the two makes negative knowledge lie, and agents will be told not to attempt things that were never attempted.

18. **Requirement change flags derived Decisions for review. It does not change their status.** They remain active and binding until a human confirms, supersedes, or reverts them. Auto-invalidating (or auto-superseding) derived Decisions is the system pretending to know whether they still hold.

19. **Verification is not a new version and does not cascade.** Confirming a Decision does not confirm Constraints derived from it. Each object carries its own `last_verified_at`. Cascading confirmation makes a Constraint look freshly verified when nobody looked at it. Versioning verification floods pack diffs with non-changes and destroys the diffs’ only purpose.

20. **Staleness is display-only, except Observations.** A stale Constraint or Decision stays active, stays in packs, and is marked stale. Do not exclude it from packs because it looks old — that both hides a still-binding rule and makes selection depend on the clock. Observation expiry *does* change pack membership, so it must be a real state transition in a curation transaction that advances graph version. Do not compute Observation exclusion from wall-clock at read time.

21. **Superseded and reverted are different. Lifted and superseded Constraints are different.** “We changed our mind and did nothing” is not “we replaced it with X”. Do not fold terminal states together to simplify the schema.

22. **Graph version increments once per committed curation transaction**, not per row. Verification and Candidate operations create no version. Accepting a Decision plus derived Constraints plus a Glossary Entry is one version. Versioning per object makes pack diffs unreadable.

## Implementation traps

23. **Trust invariants are enforced in the database, not only in application code.** Append-only, no-delete, relation legality, acyclicity, operational length caps. Application-only enforcement lasts until the first bug, and the first bug here is a silent trust failure. Hand-written SQL migrations. No schema-owning ORM (Prisma is excluded by name). Query builders that treat SQL as source of truth are acceptable.

24. **Do not put a model SDK, a queue, Redis, a pack cache, or a graph database into V1.** Pack caches keyed on anything less than the full recipe hash are correctness bugs. Change-impact runs inside the curation transaction; an async job tells the curator after they have moved on.

25. **The MCP surface must not import durable-write use cases; the domain layer must not import I/O, SDKs, or database types.** Both are lint rules, not discipline. Pack assembly in particular is a pure function over a loaded working set.

26. **Do not containerise the engine in V1.** Database in Docker is fine; the Node process stays on the host. `stdio` clients, backfill paths, and `pke triage` all get worse inside a container, and curator friction is how this product dies.
