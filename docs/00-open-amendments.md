# Open Amendments

**Status:** Register only. Not a specification. Outside the derivation chain.
**Derivation authority:** 01 Vision → 02 Domain Specification → 03 PRD → 04 Master Tech Spec → 05 Technology Spec. This file implements nothing and redefines nothing.
**Vocabulary authority (domain concepts):** 02 Domain Specification.

These items are pack-assembly behaviour, or wording that pack assembly depends on. They are invisible to the backfill. The backfill may change the model underneath them. Fixing them now risks correcting the same paragraphs twice. Do not resolve them in a passing edit.

Each entry: what is wrong, which documents, why deferred, what would resolve it.

---

## A1 — `active` overloaded; INV-11 and PRD-CTX-012 false as written

**Status: Closed.** The replacement is a precise two-predicate rule: the
object's applicable version window and the section's explicit status
predicate. The only historical predicate is the bounded Recent Superseded
Decisions section.

**What is wrong.** INV-11 and PRD-CTX-012 say a Context Pack may contain only objects that were `active` at its graph version. Intent profiles then inject rejected Hypotheses, recently superseded Decisions, unexplained Observations (`observed`), Open Questions (`open`), and Artifacts (`current`). None of those statuses is `active`. Domain Spec 11.4 step 2 also says “collect all active Knowledge Objects,” then 11.5 includes the non-active ones. A literal implementation drops negative knowledge, recent reversals, and unexplained observations.

**Documents.** Domain Spec INV-11, Domain Spec 11.4–11.5. PRD-CTX-012. Master Tech Spec 17.3–17.4 (implements the profiles, inherits the word).

**Why deferred.** Pack-assembly rule. Backfill does not exercise it. A wrong fix here is redone when pack behaviour is settled.

**Resolution applied.** INV-11, PRD-CTX-012, Domain Spec 11.4, and MTS
17.3 now require both predicates. Recent superseded Decisions are selected
only when `status = superseded` and their closed validity windows fall within
the last 10 graph versions. The day-based arm is excluded so selection remains
a pure function of request and graph version. No other terminal status is
implicitly pack-visible.

---

## A2 — Raw injection self-contradiction (Observations in packs)

**Status: Closed.** Unexplained Observations remain pack-visible in debug and
planning, but only as metadata and evidence references; Raw Observation bodies
are never injected.

**What is wrong.** Vision §6 and Domain Spec §2: Raw (Discussion and Observation) is never injected as body text, only referenced. Domain Spec 11.5, PRD Journey G / §9, and Master Tech Spec 17.4 give Unexplained Observations their own pack section. Master Tech Spec §4 repeats “never as body” for Raw, then §17.4 injects them.

**Documents.** Vision §6. Domain Spec §2, 4.3, 11.5. PRD Journey G, §9. Master Tech Spec §4, 17.4.

**Why deferred.** Pack-assembly membership. Vocabulary authority says Domain Spec 11.5 currently contradicts Domain Spec §2; which sentence is the defect is a pack-contract question, not a backfill question.

**Resolution applied.** The Domain Spec class table, PRD, and MTS now state
that Observation bodies are never pack content.

---

## A3 — `requires` claims pack effect with no walk defined
**Status: Closed.** `requires` has no Context Pack effect in V1. It remains
available to graph traversal through `graph.expand`.


**What is wrong.** Master Tech Spec 7.2 says `requires` “Affects pack: Yes (dependency inclusion).” Neither Domain Spec 11.4 nor Master Tech Spec 17.3 walks `requires` during assembly.

**Documents.** Master Tech Spec 7.2 vs 17.3. Domain Spec 11.4 (no walk). Relation vocabulary in Domain Spec §6–7 (defines the verb, not pack inclusion).

**Why deferred.** Pack-assembly expansion. Walking `requires` without a bound would threaten determinism; ignoring the 7.2 cell silently drops a claimed behaviour.

**Resolution applied.** The MTS 7.2 table now marks `requires` as having no
pack effect.

---

## A4 — External Reference pack membership unstated
**Status: Closed.** External References are selected only one hop from
retained Knowledge Objects through `references` or `implemented_by`, evaluated
at the requested graph version.


**What is wrong.** External References have no scope and are not Knowledge Objects. Intent profiles still have an External References section. Domain Spec 11.4 only collects in-scope Knowledge Objects. The coherent reading is “pointers off selected objects,” and that reading is not written down.

**Documents.** Domain Spec 4.10, 11.4–11.5. Master Tech Spec 2.3 (separate table, no scope), 17.3–17.4. PRD §9 content list.

**Why deferred.** Pack-assembly membership. Backfill will create references; it will not settle how they enter a pack.

**Resolution applied.** References from dropped parents are excluded. XREFs
are ordered by parent position, then XREF id.

---

## A5 — No length cap on blocking Open Questions
**Status: Closed.** Blocking Open Questions are capped at 280 characters;
non-blocking questions remain uncapped.


**What is wrong.** Constraints reject above 280 characters because they are always injected. Blocking Open Questions are also always injected (Domain Spec 4.6, PRD-OQ-003, PRD-CTX-007) and have no cap. A long blocking question can trip `PACK_BUDGET_INSUFFICIENT` by itself, which collides with the always-inject guarantee.

**Documents.** Domain Spec 4.6 vs 4.7 / INV-9. PRD §9 (“kept short”), PRD-OQ-003, PRD-CTX-006/007. Master Tech Spec 17.3 step 7 (TC-6).

**Why deferred.** Pack-assembly budget. Cap vs error vs truncation of blocking questions is a contract choice the backfill will not make.

**Resolution applied.** The Domain Spec, PRD, MTS, and database CHECK now
enforce the blocking-only cap. Mandatory content remains untruncatable.

---

## A6 — `blocks` / `implemented_by` edge closure: transaction? version? historical visibility?

**What is wrong.** Master Tech Spec 7.2 marks `blocks` removable on resolution and `implemented_by` re-pointable. The graph is otherwise append-only and edges are version-windowed. It is not said whether closing or re-pointing those edges is a curation transaction, whether it increments graph version, or how a pack at v47 sees a block removed at v52.

**Documents.** Master Tech Spec 7.2, 8.1–8.2, 7.1 (`valid_from_version` / `valid_to_version`). Domain Spec 7A, INV-7. Open Question `resolve` (Domain Spec 4.6, Master Tech Spec 5.5).

**Why deferred.** Versioning of pack-visible edges. Wrong here breaks historical reproduction; backfill will not catch it.

**Reachability note.** A4 now makes `implemented_by` pack-visible in the
External References section. A6 therefore must be resolved before that section
can be considered fully correct; its curation-transaction and historical edge
window rule is recorded in the specs but remains open in this register.

**What would resolve it.** A rule that closing `blocks` and re-pointing `implemented_by` is a curation transaction that closes the old edge’s validity window at V and opens the new one, so historical packs traverse the graph as it was.

---

## A7 — Hypothesis `explored` has no pack home
**Status: Closed.** `explored` Hypotheses are excluded from Context Packs and
are added to the curation list after 30 days.


**What is wrong.** Intent profiles inject rejected Hypotheses only. `explored` (tried, not yet concluded) does not appear. Debug packs are where in-flight experiments would be useful.

**Documents.** Domain Spec 4.4, 11.5. PRD-HYP-004. Master Tech Spec 5.6, 17.4.

**Why deferred.** Pack-assembly intent profile. Whether `explored` is a brief staging state that should not survive triage, or a missing profile row, is not a backfill question.

**Resolution applied.** The state remains `explored`; the 30-day curation
reminder is not a staleness transition and does not advance graph version.

---

## A8 — MTS 6.1 INV-12 omits `requires`; 7.5 includes it

**What is wrong.** Domain Spec INV-12: `derives_from`, `supersedes`, and `requires` are acyclic. Master Tech Spec 6.1 states only the first two. Master Tech Spec 7.5 implements all three. The 6.1 table is wrong.

**Documents.** Domain Spec INV-12. Master Tech Spec 6.1 vs 7.5.

**Why deferred.** The enforcement in 7.5 already matches the Domain Spec. The 6.1 cell is a table defect next to pack-adjacent traversal rules. Left registered so it is not “fixed” as a drive-by while INV-11 (A1) still uses the same invariant section.

**What would resolve it.** Put `requires` in the Master Tech Spec 6.1 INV-12 statement so it matches Domain Spec INV-12 and Master Tech Spec 7.5.

---

## A9 — “Merge” wording invites in-place edit

**What is wrong.** Triage “Merge” is supersession (PRD PD-6): a new object, new id, predecessor superseded. Colloquial “fold into an existing object” sounds like an in-place edit, which INV-7 forbids.

**Documents.** Domain Spec 12.3. PRD §10, PD-6. Master Tech Spec 14.4.

**Why deferred.** Wording. Harmless until a curator or a tool implements merge as UPDATE. Not pack-assembly, but it is the same class of “do not quietly rewrite the model during validation.”

**What would resolve it.** Replace “folded into” / “merged into an existing object” with “creates a superseding object; the predecessor is retained.”

---

## A10 — Feature filter and Raw: unspecified whether Observations are feature-filtered in packs
**Status: Closed.** Observed Raw Observations in debug and planning ignore
feature filters, including when unlabelled.


**What is wrong.** Domain Spec 11.4 applies the feature filter to Reviewed Knowledge only. Operational is exempt. Observations are Raw and are selected for debug/plan. Whether an Observation without the requested feature label is included is unspecified. Including all in-scope Observations may flood a feature-scoped debug pack; excluding them is an unstated rule.

**Documents.** Domain Spec 3.3, 11.4–11.5. PRD-SCP-006 (Reviewed only). Master Tech Spec §4 (Raw: “n/a, not selected directly”), 17.3–17.4 (Observations are selected).

**Why deferred.** Pack-assembly filter. Backfill will label objects; it will not settle debug-pack membership under a feature filter.

**Resolution applied.** The divergence from Reviewed Knowledge filtering and
its rationale are explicit in the Domain Spec, PRD, and MTS.

---

## A11 — INV-3 blocks historical Decisions with unrecoverable origins

**Status: Closed by A-BF-1. Evidence threshold was met before resolution.**

**What is wrong.** INV-3 requires every Decision to have a legal
`derives_from` origin. That is correctly calibrated for live capture, where
`discussion.resolve` supplies an origin with the proposal. Historical
backfill is different: the original Discussion, Observation, Requirement,
Open Question, or Decision often cannot be reconstructed from the surviving
record. The same invariant therefore systematically blocks historical import.

**Evidence.** The first real MIRA backfill attempt presented 11 real
historical Decisions. All 11 failed with `DECISION_ORIGIN_REQUIRED`; the run
imported zero objects. No fabricated Discussion was added to make the import
pass. The 11 failures are recorded as `Unrecoverable origin` gaps alongside
`GAP-0001`, giving 12 instances against the Section 17.1 threshold of 3.

**Why it was deferred.** This was a backfill provenance-mode decision, not
permission to weaken live-capture trust. Changing INV-3 would make missing
evidence indistinguishable from valid origin, while silently dropping
historical records would erase the evidence that the model cannot represent
them.

**Resolution applied.** A-BF-1 adds an importer-only `backfill_mode`
transaction. It records `origin = "unrecoverable"` visibly in Context Packs,
while live capture rejects the marker and still enforces INV-3 for Decisions
without either form of origin.

---

## A12 — Instance granularity makes the promotion threshold non-objective

**What is wrong.** Domain Spec 17.1 requires at least three distinct real instances before a candidate concept can be promoted, but it does not define what counts as one instance. On the same MIRA corpus, Assumption counted as two instances when grouped by load-bearing premise and as eight when each corrected or disproven belief was counted separately. The three-instance threshold therefore changes with decomposition rather than evidence.

**Documents.** Domain Spec 17.1–17.2, 18.2, 19. MIRA backfill corpus (`mira_decisions.md`, `mira_ledger_2026-08-17.md`).

**Why deferred.** This is a model-validation defect exposed by backfill. Promotion should not be evaluated until the counting unit is defined consistently.

**What would resolve it.** Define an objective instance boundary for Section 17.1 and apply it consistently when recording and counting Domain Gap entries.

---

## A13 — Always-inject does not scale with Constraint count

**Status: Closed for implementation; monitored during validation.** Every pack diagnostic counts
Constraints, blocking Open Questions, and explicitly requested Glossary
Entries. Term-matched Glossary Entries do not count. The >30% reopen trigger
remains active during validation.

**What was measured.** Reclassification of the MIRA backfill produced 32 real atomic Constraints totalling approximately 1,976 characters, or 494 tokens under the project estimator. That is roughly 12% of a 4,000-token budget, not the approximately 25% the original estimate assumed. The original estimate took 45 raw classifications at face value; 13 were working principles, retrospective lessons, runbook steps, test tasks, or implementation notes rather than Constraints.

**Assessment.** Of the 32 surviving Constraints, 25 are project-fixed and seven multiply with brands; all seven multiplying rules are magic-link host routes. Two candidate rules quantify over brands once rather than creating one rule per brand: K-C11 requires every active brand's SES event destination before tracking is operational, and K-C15 gates no-quiz detection by brand/product capability. Project-fixed Constraints should asymptote as the project matures. Host routing grows linearly, but brands are a bounded, deliberately curated set. The MIRA measurement does not support the claim that mandatory Constraint content becomes unmanageable under normal growth.

**Documents.** PRD-CON-004, PRD-CTX-006, PRD-CTX-009, PRD §9. Domain Spec 4.7, 11.4. Master Tech Spec 17.2–17.5, 20.1.

**Reopen trigger.** Every Context Pack reports mandatory content—Constraints plus blocking Open Questions—as a percentage of its requested budget in diagnostics. If that percentage exceeds 30% during validation, reopen A13 using the observed data rather than an estimate.

---

## A14 — Measurement corrections have no home

**What is wrong.** The MIRA backfill contains corrected measurements: PALS orphan rate changed from 2.33% to 0.41%, and the orphan count changed from 135 to 33. These are explained measurements, so they do not honestly fit Observation's “unexplained” boundary. Even if represented as Observations, the legal relation table does not permit Observation → `supersedes` → Observation, so the correction chain cannot be expressed.

**Documents.** Domain Spec 4.3, 5, 7, 17.2, 19. MIRA ledger (`mira_ledger_2026-08-17.md`).

**Why deferred.** This is a domain-model gap found by backfill. It should remain registered rather than forcing corrected measurements into Decision, Constraint, or Observation.

**What would resolve it.** Candidate fix: permit Observation → `supersedes` → Observation. This is a candidate direction, not a decision; it also requires resolving whether explained measurements are valid Observations.

---

## A15 — Duplicate detection has no backfill candidate stage

**Status: Closed by A-BF-1.** The duplicate signal is reported; no duplicate
is automatically blocked or merged.

**What is wrong.** Master Tech Spec 14.5 defines structural near-duplicate
detection at candidate time and reports it as a triage hint. Backfill has no
candidate stage. A bulk import can therefore insert the same Decision more
than once under different ids even though the graph is append-only.

**Evidence.** The hand-authored MIRA corpus contains three structural
near-duplicate pairs that were not detected during authoring:

- `DEC-0004` duplicates `DEC-0009`.
- `DEC-0005` duplicates `DEC-0011`.
- `DEC-0003` overlaps `DEC-0007`.

The entries were authored from different sources without a duplicate check.

**Why it was deferred.** This is a dry-run reporting question, not a reason
to silently discard a curator-authored object. Blocking or automatic merging
would invent a curation decision and would conflict with append-only history.

**Resolution applied.** The dry run runs the same structural near-duplicate
check over the import set and reports pairs as warnings. It does not block or
merge them. Semantic duplicate detection remains out of scope.

---

## A16 — Hypothesis lifecycle blocks historical negative knowledge

**Status: Closed by A-BF-1.** This was consolidated with A11 under the same
backfill provenance amendment.

**What is wrong.** MTS 5.6 defines the Hypothesis lifecycle as
`explored → rejected`; the initial durable state is therefore `explored`.
A7 closed with `explored` excluded from every Context Pack. A historical
Hypothesis that is presented precisely because it was tried and failed must
therefore enter the graph in a state invisible to every pack. That defeats
the purpose of the class: preserving negative knowledge about approaches
already attempted.

**Evidence.** `HYP-0001` is the C9 incident record: email identity was tried,
failed, and caused a 3.23M-record re-import. Before A-BF-1, its historical
outcome `rejected` was rejected as an initial backfill status.

**Why it was deferred.** The lifecycle assumes creation precedes outcome,
which is valid for live capture and not valid for historical records where
the outcome is the reason the record survived. Changing A7 or silently
importing the Hypothesis as `explored` would hide the very negative knowledge
the class exists to preserve.

**Resolution applied.** Backfill may create a Hypothesis directly in
`rejected`, preserving the historical state without inventing an
`explored → rejected` transition. Live capture still begins at `explored`;
`explored` remains excluded from packs.

---

## A-BF-1 — Historical backfill provenance mode

**Status: Implemented.** This amendment consolidates A11, A15, and A16.
The normative record is the A-BF-1 amendment under Domain Spec §7, recorded
under the Section 6 freeze rule.

The importer-only `backfill_mode` transaction records historical provenance,
permits the positive `origin = "unrecoverable"` Decision marker, accepts the
three specified historical terminal states with their same-import
preconditions, and reports structural near-duplicates without blocking or
merging. The live capture path remains unchanged and cannot construct this
mode.

---

## A17 — Approved feature labels were treated as immutable content

**Status: Closed by A17.** The resolution is recorded as Domain Specification
v1.4, Amendment A17.

**What was wrong.** The first real A-BF-1 import committed 23 objects and zero
feature labels because the import format supplied none and the Project
registry was empty. The objects were already approved, and INV-7 treated
`feature_label_ids` like an assertion field. The apparent choices were to
leave navigation absent or supersede every affected object.

**Resolution applied.** `feature_label_ids` is now in the INV-7 whitelist.
Relabelling is a curator-only curation transaction, creates one graph version,
and updates no approved assertion. It does not create a successor, a
supersession chain, or a new Knowledge Object id. The database trigger,
domain append-only check, and write-path operation enforce this distinction.
The MIRA relabelling transaction applied this at graph version `728`.

**Rationale.** INV-7 protects content because changing what an object asserts
after approval makes history a lie. A feature label asserts nothing about the
world; it is an index entry. MTS 11.2 makes the same distinction: scope says
at what level a claim is true, while features say what the object is about.
Pack diffs and change-impact must not report a supersession when only filing
changed.

**Known hole accepted for v1.** `feature_label_ids` on the object is not
version-windowed. Rebuilding an old pack resolves the registry at the old
graph version but reads the object's current label set. This is recorded as a
reproduction limitation because labels are navigation, not history.

---

## A18 — Backfill format does not surface unassigned feature labels

**Status: Open.** The first real A-BF-1 import supplied no feature labels,
because the format only permits labels that are already present in an object
file; omitting the field produces no signal.

**Evidence.** The final MIRA import committed 23 objects and zero feature
labels. The earlier friction record's 20-file count is an authoring count,
not the final row count. The requested `magic-link` and `event-lane` labels
had to be supplied as a separate curation instruction after import.

**Registered candidate fix.** Decide whether the backfill format should
accept an explicit, non-graph `unassigned_labels` or label-suggestions field
and collect those values batch-wide in dry-run output, alongside label
candidates. It must not create registry labels or mutate approved objects
automatically.

---

## A19 — Erroneous capture has no removal verb

**Status: Closed by A19.** The resolution is recorded as Domain Specification
v1.6, Amendment A19.

**Evidence.** The real graph contained twelve global objects from legacy
`backfill.import` transactions at versions 621–695. The v694 and v695 writes
occurred immediately after `scope.seed.mira` at v693 and used
`backfill_mode = false` with `backfill:objects/...` source markers. They were
not part of the reproducible MIRA files and inherited into the MIRA Context
Pack as project-global knowledge.

**Why this mattered.** Append-only is a rule about knowledge, not about a
scratch database used to develop the tool. `withdrawn`, `reverted`, and
`lifted` all assert something about knowledge that was once legitimate; these
rows were never knowledge.

**Resolution applied.** Every Knowledge Object type now accepts terminal
status `retracted` by explicit curator action only. Retraction excludes the
object from packs at and after the retraction version, retains the row and
relations for audit and traversal, does not claim the object was ever valid
knowledge, and is not retroactive: packs at earlier graph versions still
select the object by its pre-retraction in-force status.

---

## A20 — The graph is not reproducible from files

**Status: Closed by A20.** The resolution is recorded as Domain Specification
v1.5, Amendment A20.

**Evidence.** All 23 MIRA object files were imported at graph version 727;
there were no silently skipped or rejected object files. `relations.json`
contains the six relations and `external-references.json` contains
`XRF-0001`. The scope tree and all feature-label registry entries and
assignments exist only in PostgreSQL. The object files contain scope IDs, but
there is no declarative scope-tree seed, label manifest, or assignment
manifest.

MTS §22 specified a declarative format for Knowledge Objects and relations,
but did not specify how scopes or labels are created because neither is a
Knowledge Object. Those inputs therefore fall outside every reconstruction
guarantee the format currently provides.

**Consequences.** The graph cannot be rebuilt on another machine, restored
from version-controlled source, or reset after A19 contamination without a
database backup. Recovery depends on PostgreSQL backups rather than the
files that describe the intended graph.

This is larger than A19: A19 says an erroneous object has no honest removal
verb; A20 says the graph cannot be rebuilt at all.

**Resolution applied.** The backfill directory now carries declarative,
version-controlled `scopes.json` and `labels.json` manifests alongside
objects, relations, and external references. Import order is scopes, objects
and relations, then labels and assignments. The three phases are separate
curation transactions; assignments remain filing metadata under A17 and are
not object content. Unchanged manifests are no-ops, while conflicting
definitions fail.

The graph-version provenance array now uses explicit namespaces for every
identity class, including `REL-<relation-id>` for relation rows. This removes
the object/relation identity conflation without changing the append-only
knowledge rule.

The clean rebuild test compares Context Pack hashes at equivalent graph
versions across independent databases. The live graph was then reset and
rebuilt from the files, removing the twelve legacy global objects without
adding a removal verb to the knowledge model.

---

## A21 — Engram has no verb for its own errors

**Status: Open.** Registered from the Epic 1 pack-reproduction audit. Not
designed here.

**What is wrong.** Every correction verb in the model asserts something about
the knowledge. Supersession says the knowledge was revised. `reverted` says
the decision was undone. `lifted` says the constraint no longer applies. A19
added `retracted` for "this should never have been recorded". None of them
covers "this row's stored state is wrong through no decision of anyone's" —
a value produced by a defect in Engram rather than by anything a curator
concluded.

**Evidence.** `transitionObject` closed validity windows for any status in a
flat terminal set, which closed HYP-0200's window at v8 and hid every rejected
Hypothesis from every pack. Commit `f6453cc` fixed the code. It could not fix
the row. The available primitive was supersession, which would have created
HYP-0201 superseding HYP-0200 and written into permanent history the claim
that the hypothesis had been revised. Nothing about the hypothesis had been
revised; Engram's bookkeeping had been wrong.

The repair was performed as an in-place edit of `valid_to_version` at v9,
recorded as `transition.rejected.reopen_window`. That is a rule 1 violation on
its own terms, and it was chosen deliberately: writing a false statement about
the knowledge was judged worse than an append-only violation that names itself
in the audit trail. The action string exists so the violation would be
visible.

**Why this mattered.** The edit retroactively changed what the graph at v6 and
v8 contained, which is what broke stored pack `78a8714f`. So the absence of
this verb did not merely force an awkward repair; it produced exactly the
class of damage append-only exists to prevent.

**Same shape as A19.** A19 observed that the model had no verb for erroneous
capture and added one rather than bending `withdrawn` to fit. This is the
adjacent gap: the model has verbs for the world changing and none for its own
errors. Bending supersession to fit is the same mistake A19 declined to make.

**Candidate direction, not a design.** A curation action recorded as a repair
rather than a decision: visible in graph history, asserting nothing about the
knowledge, and distinguishable in packs and diffs from a supersession. What it
may legitimately rewrite, whether it is permitted at all now that windows
close once, and how a pack invalidated by one should report itself, are open.

**What would resolve it.** A decision on whether repair is a first-class
curation action or whether defect-produced state is simply permanent and
disclosed. Either answer is defensible. The current position — no verb, and a
violation when one is needed — is not.

---

## A22 — The status-history backfill writes two knowingly wrong rows

**Status: Open by choice.** The correction is available, understood, and
deliberately withheld.

**What is wrong.** `knowledge_object_status_history` is backfilled by
recording each object's *current* status against its *opening* version. For an
object that never changed status that is exact. For one that has, the prior
status was never stored and the row is a guess. Two rows in the MIRA graph are
guesses, and both are wrong:

| Row written | Status actually held at v6 | Really changed at |
| --- | --- | --- |
| `(ART-0200, 6, superseded)` | `current` | v7, `supersede.artifact` |
| `(HYP-0200, 6, rejected)` | `explored` | v8, `transition.rejected` |

**The correction exists.** Both are inferable without guessing:
`graph_versions` names ART-0200 in a `supersede.*` at v7 and HYP-0200 in a
`transition.*` at v8, and each type's opening status is fixed by the model. A
backfill consulting the audit trail would write `current` and `explored` and
be right.

**Why it is withheld.** Writing the correct rows would make stored pack
`c969d4de` reselect what it originally recorded, and it would reproduce again.
That pack is one of two surviving pieces of evidence that unversioned status
silently rewrote pack history, and it is cited as such in MTS 2.2.1, MTS §8,
Domain Spec 11.2, and the build log. Correcting the rows repairs the pack and
destroys the evidence. `78a8714f` is unaffected either way: it was broken by
the v9 window reopen, not by status.

**What would resolve it.** A deliberate decision, taken separately and not in
passing, that the finding is sufficiently recorded in prose and the graph may
now be made accurate. Until then these two rows are wrong on purpose, and
anything reading status history at v6 for those two objects is reading a
guess.
