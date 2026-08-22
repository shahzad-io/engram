# Build log

Closed findings from implementation. Not a specification. Not the open-amendments register.

---

## Scopes and labels (through 002)

**Composite PK and the single-row / multi-row asymmetry.** MTS 3.4.1 sketched `feature_labels.id` as a single-column primary key. A merge that `UPDATE`s `redirects_to_id` in place makes a pack rebuilt at the pre-merge version follow the post-merge redirect and fail the hash. Implementation used `PRIMARY KEY (id, valid_from_version)` plus a partial unique index on open `id`: close the old window, insert a new row with the same identity. That is the first case where the specs did not survive contact with code, and it was a real defect, not a taste difference.

The reason determines 003+. `knowledge_objects` and `relations` stay **one row per id**: the only status changes after approval are to terminal states, and terminal states are excluded from packs, so leaving `active` and closing the version window are the same event. `feature_labels` and `feature_label_aliases` are **multiple version-windowed rows per identity**: `deprecated` and a non-null `redirects_to_id` change resolution without removing the label from resolution. One row cannot represent both pre- and post-merge behaviour. Now normative in MTS 2.2, 3.4.1, and 3.4.4.

**Alias primary key.** Aliases have no FTL-style id. Identity is `(project_scope_id, alias)`. Primary key is `(project_scope_id, alias, valid_from_version)`, with a partial unique index on the open pair. Same version-window pattern as labels, different identity.

**Named volume.** `compose.yaml` used a bind mount at `./.docker/pgdata`. `docker compose down -v` does not remove bind-mount directories, so `make fresh` left stale schema in place. Switched to a named volume `pgdata`. Recorded in 05 §5.1, §5.2, §5.6.

**Migration versions.** `schema_migrations` recorded the zero-padded prefix as text (`"000"`, `"001"`) while the runner sorted numerically. Two orderings over the same data. The column is now `integer` primary key; the full filename is stored separately; uniqueness and contiguity from 0 are asserted at startup.

**`graph_versions.object_ids`.** Widened from "knowledge objects" to identities whose validity window changed (knowledge objects, relations, registry rows). Prefixes are the namespace. A label merge records `FTL-…` ids so pack-diff at that version is not an empty array.

---

## Knowledge object acceptance and write path (through 011)

**Approval is insertion, not a state transition.** The implementation made the model explicit: Reviewed and Operational objects cannot legally exist with `approved_at IS NULL`, while Raw objects cannot later acquire approval. Candidates are a separate table, so acceptance inserts the object directly in its type's initial durable state with `approved_at` and `last_verified_at` set, inside the curation transaction. This is the second specification defect found by implementation: the approval-transition framing in MTS 5.1 and 5.4 was inconsistent with the actual Candidate and object model. The signal was a test that could not be written—there is no legal row on which to exercise an approval UPDATE. The test now asserts that `approved_at` cannot be changed on any existing row.

**Generated columns in a BEFORE UPDATE record.** The 007-era append-only trigger compared `to_jsonb(NEW)` and `to_jsonb(OLD)` after removing the six mutable columns. PostgreSQL leaves the generated `knowledge_class` field null in `NEW` during a BEFORE UPDATE trigger, while `OLD` contains its stored value. The mismatch falsely rejected every otherwise-whitelisted update; it was not a side-effect change caused by the whitelist write. Migration 008 excludes the generated field from that comparison, and migration 009 makes approval explicitly insert-only. Any future generated column must be excluded from this style of BEFORE-trigger comparison or compared explicitly.

**INV-10 was initially direct-edge-only.** The first implementation flagged only Decisions with a direct `derives_from` edge from the changed Requirement, while MTS 8.6 and PRD-REQ-006 require transitive propagation through Decision chains. This is the third specification-versus-code gap, and the first where the code was narrower than a correct specification rather than the specification being wrong. Migration 010 adds the recursive, depth-64 traversal.

**Multi-element Candidate version granularity is a spec change driven by implementation.** MTS 8.2 and 14.3 previously said that each accepted child was its own curation transaction. Implementing TC-2 exposed the conflict: a Decision plus its derived Constraints is one coherent knowledge change and must share one graph version. The reconciliation preserves PRD-CUR-007's element-level accept/reject choice, then promotes the curator's chosen accepted subset atomically in one curation transaction; unchosen elements remain pending. This is a specification change with a rationale, not a wording-only update.

**INV-10's depth bound has a silent false negative.** A Decision whose only path from a superseded Requirement lies beyond the recursive depth-64 bound is not flagged, and no error or incomplete-impact marker is emitted. The bound correctly prevents runaway traversal, but the result is silently incomplete. MTS 8.6 specifies the limit but not whether truncation should be reported or fail. This is recorded for a later decision, not fixed in this slice.

---

## Retrieval and Context Pack assembly

**The A1 validity-window candidate fix was insufficient.** Replacing
`active` with a version-window predicate corrected the literal mismatch for
rejected Hypotheses, observed Observations, open Open Questions, and current
Artifacts, but it did not express the status semantics of each pack section.
The existing schema also closes a predecessor's half-open validity window at
the graph version that supersedes it, while the product explicitly retains
recently superseded Decisions as historical pack content. A single
version predicate therefore either drops that product content or makes all
terminal objects visible.

The resolved contract is two predicates: the object's applicable version
window and the section's explicit status predicate. Recent Superseded
Decisions are the only historical exception, selected by `status =
superseded` plus a bounded closed-window test (the last 10 graph versions).
The day-based arm is excluded so selection remains a pure function of request
and graph version. No other terminal state is implicitly pack-visible. The
finding is recorded because the first implementation-shaped fix was narrower
than the actual pack contract, not because the append-only window model was
wrong.

**Migration 012 rewrote the INV-7 trigger instead of extending it.** To add
`search_vector` to the generated-column whitelist, 012 replaced the trigger
function wholesale. That replacement silently dropped the explicit
`approved_at` immutability check and the `knowledge_class` exclusion that
migration 009 had added. The raw-SQL bypass tests caught the regression:
attempting to assign approval to a Raw row reached the
`knowledge_objects_approved_class` CHECK instead of failing at INV-7 with
`IMMUTABLE_AFTER_APPROVAL`. Migration 012 now preserves all three generated
column/approval protections, and migration 013 repairs installations that
already recorded the original 012. The lesson is that additive changes to a
multi-invariant trigger must be additive in the migration, not a rewrite.

---

## First hand-authored backfill attempt

The first worked import attempted to make ADR-001 approval-ready by creating
`DSC-0001`, a fabricated Discussion that merely restated the Decision,
pointed `content_ref` at `docs/mira_decisions.md`, and used an invented
midnight timestamp. No such conversation exists. It was created solely to
satisfy INV-3's required `derives_from` edge.

That attempt was deleted. ADR-001 is correctly represented as an Artifact,
with `DEC-0001 references ART-0001`; the Decision has no legal origin and the
dry run reports `DECISION_ORIGIN_REQUIRED` plus a Domain Gap with
`candidate_concept = "Unrecoverable origin"` and
`recorded_as = "not_recorded"`.

This is direct evidence for A11: evidence invariants block historical import.
The importer must expose the missing origin as a gap rather than manufacture
evidence to make the dry run pass.

---

## Restoration of the shared MIRA decision log

An intermediate cleanup incorrectly treated identity differences between the
MIRA backfill log and `docs/mira_decisions.md` as evidence that the supplied
records were invalid, and removed real MIRA records from `backfill/mira`.
Those records have been restored from the curator-supplied shared log.

Duplicate resolution keeps the explicitly corrected `DEC-0006`, the fuller
`DEC-0007` record with its rejected alternative, and the corrected `CON-0002`
content. Relations are stored in `relations.json`, not inside object files.
The shared log's `moderate` reversibility values are normalized to the Domain
Spec enum value `costly`; `XRF-0001` uses the enum value `other` for its
incident source and is kept outside `objects/` because External Reference is
not a Knowledge Object.

The ID mapping against the decision ledger remains an audit question, not a
basis for deleting the supplied records. Missing `derives_from` origins remain
validation failures and must be resolved with real evidence or recorded as
gaps; no synthetic Discussions are to be created.

---

## Amendment A-BF-1 — Backfill mode was specified but not implemented

The backfill tool was specified as a distinct mode in MTS §22, but every
invariant and lifecycle gate had been written against the live capture path.
This was the **sixth specification-versus-code finding**, and the largest:
the mode existed in the product contract while the implementation had no
trust boundary for it.

The correction is deliberately narrow. The importer now creates a
`backfill_mode` curation transaction; the graph version records that marker,
and an architectural lint rule keeps the capability out of live write
barrels, MCP, and CLI paths. Backfill-only Decisions may positively assert
`origin = "unrecoverable"`; live capture rejects that marker and a Decision
with neither a marker nor a `derives_from` edge still fails INV-3. Historical
terminal states are accepted directly only where the surviving outcome is
the reason the record exists. Structural near-duplicates are reported as
dry-run warnings and are never silently merged.

This preserves the evidence and lifecycle rules for live capture while
making the historical import path honest about what cannot be recovered.

---

## Real MIRA backfill at graph version 727

The A-BF-1 backfill was run for real after the dry run passed. It committed
exactly one graph version, `727`, with six relations and 23 object rows:
11 Decisions, five Constraints, five Glossary Entries, one Hypothesis, and
one Artifact. All 23 rows are `authored_by = human` with a
`backfill:` source marker; all 11 Decisions carry
`origin = "unrecoverable"`; and `HYP-0001` is `rejected`.

The earlier friction record's “20 authored files” is a historical authoring
count. The final `backfill/mira/objects/` directory contained 23 files, so
the committed row count is 23, not 20. This discrepancy is recorded rather
than silently changing the append-only graph.

The import contained zero feature labels because no object file supplied
`feature_labels`, and the Project label registry was empty. At that point,
changing `feature_label_ids` after approval was forbidden by INV-7, so the
feature-filtered pack remained unbuilt. This was registered as A17 rather than
inventing successors or a supersession history.

---

## Amendment A17 — Feature labels are filing, not assertions

A17 resolves the finding by adding `feature_label_ids` to the INV-7 whitelist.
The application exposes relabelling only through a curator curation
transaction; the database append-only trigger and domain append-only check
agree with that boundary. The transaction creates one graph version, records
the affected label and object identities, and changes no approved assertion.
It never supersedes an object.

The rationale is the distinction in MTS §11.2: scope answers “at what level is
this true” and is an assertion about the world, while a feature answers “what
is this about” and is navigation. Superseding an object only to file it would
create ids, chains, pack diffs, and change-impact edges that claim a content
change where none occurred.

The accepted v1 reproduction hole is explicit: an object's
`feature_label_ids` is not version-windowed. Rebuilding an old pack resolves
the label registry at the requested graph version but reads the object's
current label set. This is accepted because labels are navigation rather than
history; reproduction must report the limitation.

The follow-up relabelling transaction committed graph version `728`. It
created `FTL-0001` (`magic-link`) and `FTL-0002` (`event-lane`) and assigned
them to the curator-specified MIRA objects without superseding any row:
`magic-link` to `DEC-0006` and `CON-0003`; `event-lane` to `DEC-0004`,
`DEC-0005`, `DEC-0009`, `DEC-0010`, `DEC-0011`, `CON-0004`, `CON-0005`,
`GLO-0004`, and `GLO-0005`. Pack 3 was then built at version `728` with
`intent = implementation`, `budget = 4000`, and `feature = magic-link`.

---

## A19 — Real graph contains erroneous pre-isolation captures

**Closed by Amendment A19 (Domain Spec v1.6).** Terminal status `retracted`
is now available on every Knowledge Object type by explicit curator action.
Retraction excludes the object from packs at and after the retraction version,
retains the row and relations for audit, does not claim the object was ever
valid knowledge, and is not retroactive.

The twelve legacy global rows were removed by the A20 file rebuild; the
retraction mechanism remains the honest in-graph correction when reset is not
appropriate or contamination must stay auditable.

---

## A20 — The graph is not reproducible from files

The MIRA directory contains 23 Knowledge Object files, all 23 of which were
imported at graph version `727`. The “20 objects imported” figure was an
authoring-count error, not a silent skip: no object file was rejected or
omitted. `relations.json` contains six relations and
`external-references.json` contains `XRF-0001`.

The scope-tree seed and all feature-label registry entries and assignments are
database-only. MTS §22 specified declarative Knowledge Object and relation
files, but never specified declarative scope or label creation because those
are not Knowledge Objects. The result is that the intended graph cannot be
rebuilt on another machine or reset after A19 without a PostgreSQL backup.

This is larger than A19. A19 concerns the absence of an honest removal verb
for an erroneous object; A20 concerns the absence of a complete reconstruction
source for the graph itself.

The candidate fix is to add version-controlled scopes and labels manifests,
with label assignments represented separately as a curation transaction. It
was implemented as A20.

`scopes.json` now declares the complete MIRA tree, including the migration
root. `labels.json` declares the two Project labels and their assignments.
The importer applies scopes, object/external-reference/relation content, and
labels/assignments in that order as three transactions. On a clean database
the resulting versions were:

- v1 `backfill.scopes`: seven new MIRA scope nodes (Global already exists from
  the migration).
- v2 `backfill.import`: 23 Knowledge Objects, `XRF-0001`, and six relations,
  with `backfill_mode = true`.
- v3 `backfill.labels`: two labels and their eleven assignments.

The import report contained zero failures, six duplicate warnings, and no
gaps. A direct database check found 23 objects, all `authored_by = human`
with `backfill:` source markers; all 11 Decisions carry
`origin = "unrecoverable"`, `HYP-0001` is `rejected`, and zero objects are
scoped to Global.

The rebuild test created two independent databases from migrations plus the
files and produced byte-identical Context Pack `content_hash` values at
equivalent graph version 3. Re-importing unchanged files created no version;
a conflicting scope definition failed before writing.

Finally, the live `pke` database was dropped, recreated, migrated, and
rebuilt only from the version-controlled files. This is a scratch graph reset,
not a knowledge deletion verb. The three MIRA packs were rebuilt at v3:
implementation retained 20 objects and dropped `ART-0001` and `HYP-0001`;
debug retained the same 20 and dropped `HYP-0001`; the `magic-link` filtered
implementation pack retained 18, including all five Constraints, and excluded
the event-lane-labelled Decisions. The `unrecoverable` marker rendered on
every retained Decision.

---

## MCP access layer — empty inputSchema stripped client arguments

The first MCP integration registered all four tools with `inputSchema: {}`.
The MCP SDK treats that as a Zod object schema with no properties, which
**strips every client-supplied argument** during parse. Handlers then received
`{}` and returned `"scope is required"` even when the client had sent a
scope. Cursor's `context_build` display name was a red herring; the wire
call reached the handler, but the transport boundary deleted the payload.

All 79 pre-transport tests called handler functions directly and never
exercised the SDK parse layer, so this bug survived the suite. Transport-level
tests now call `callTool` through an in-memory MCP client for each tool.

The fix is real per-parameter schemas with descriptions and enums, plus
underscore aliases for clients that normalise dotted names. Scope discovery
is exposed as `graph.expand` with `list_scopes=true`, not a fifth tool.
Temporary stderr logging of raw post-parse arguments is enabled for one
debugging cycle against Cursor.

---

## `transitionObject` hid rejected Hypotheses from every pack

`transitionObject` used a flat terminal-status set and closed
`valid_to_version` on any status in it. `rejected` was in that set, but
Domain Spec §5 and Master Tech Spec 5.6 state rejected is **not** terminal
for Hypothesis because revive is legal, and rejected is the only state in
which a Hypothesis appears in a Context Pack (Domain Spec 4.4).

Effect: rejecting a Hypothesis recorded the negative knowledge and
simultaneously hid it from every pack. This would have applied to every
Hypothesis in the system.

Found by checking pack output after a live transition, not by any test.
Fixed by using `isStatusTerminal(type, status)` so the window closes only
for type-specific terminal states.

The class of bug is a status-handling rule applied uniformly across types,
where the domain model defines it per type. Worth checking whether the
same pattern exists elsewhere.
